"use strict";

/**
 * Dhiraj does not ask FROST questions in English. He asks "aaj kitni sale hui", "kiska udhaar
 * baaki hai", "maal kam pad raha hai kya" -- Hindi written in Latin letters, the way it is spoken
 * at the counter. `classifyBusinessIntent` is a cascade of English regexes, so every one of those
 * questions fell through all twelve branches and landed on the generic briefing. The owner got a
 * wall of every figure in the shop and no sign that his actual question had been missed.
 *
 * This module sits in front of the classifier. It does not translate and it does not replace
 * anything the user typed: it *appends* English hint words to a lowercased copy of the question, so
 * the existing regexes fire while the original words stay intact for logging, auditing and the
 * model that phrases the answer. Appending rather than substituting matters -- a substitution that
 * guesses wrong destroys the evidence of what was actually asked.
 *
 * The hint words are chosen for the branch they must land in, not for their dictionary meaning.
 * `udhaar` emits "outstanding ledger" because that is what PAYMENTS matches on; it deliberately
 * does not emit "receivable", which would be caught earlier by CASH_DRAWER. Changing a hint word
 * without reading the cascade in frostCore.js will silently re-route questions.
 */

// Ordered on purpose: the first entry whose pattern matches contributes its hints, and every
// entry is tested, so a question can collect several. Longer and more specific spellings come
// before the short ones they contain.
const HINGLISH_HINTS = Object.freeze([
  // Dues, ledgers, who owes whom. The single most common thing he asks about.
  { pattern: /\b(udhaar|udhar|udhari|udhaari|baki|baaki|bakaya|bakaaya|hisaab|hisab|lena\s*hai|dena\s*hai|len\s*den|lendel)\b/, hints: "outstanding ledger payment" },
  { pattern: /\b(vasooli|vasuli|recovery|bhugtan)\b/, hints: "payment outstanding" },

  // Cash actually in the box. Kept ahead of the generic money words because the drawer question
  // has its own facts.
  { pattern: /\b(golak|gullak|rokad|rokda|rokdaa|nagad|nakad|tijori|counter\s*me)\b/, hints: "cash drawer" },

  // Sales.
  { pattern: /\b(bikri|bikree|becha|bechi|bechu|bika|bike|bikta|dhandha|dhanda|sale|sales|vyapar|vyaapar)\b/, hints: "sales" },

  // Profit and loss.
  { pattern: /\b(nafa|nafaa|munafa|munaafa|faida|fayda|faayda|labh|profit)\b/, hints: "profit" },
  { pattern: /\b(sabse\s*(zyada|jyada|adhik)\s*(nafa|nafaa|munafa|munaafa|faida|fayda|profit))\b/, hints: "most profit" },
  { pattern: /\b(nuksan|nuqsan|nukshan|ghata|ghaata|loss)\b/, hints: "loss" },
  { pattern: /\b(kharch|kharcha|kharche|laagat|lagat|expense)\b/, hints: "expense" },

  // Waste and spoilage -- a fruit shop's daily reality.
  { pattern: /\b(kharab|kharaab|sad|sada|sadi|sadd|sadne|barbad|barbaad|fek|feka|fenka|phenk)\b/, hints: "waste" },

  // Stock on hand.
  { pattern: /\b(maal|samaan|saman|stock|inventory)\b/, hints: "stock inventory" },
  { pattern: /\b(khatam|khatm|khatham|kam\s*pad|kam\s*hai|kam\s*ho|nahi\s*bacha|na\s*bacha)\b/, hints: "low stock" },
  { pattern: /\b(fal|phal|phall)\b/, hints: "fruit" },

  // Old lots. He says "purana maal", never "nearing expiry".
  { pattern: /\b(purana|puraana|purane|puraane|purani|sadne\s*wala|expiry|expire)\b/, hints: "old lot near expiry" },

  // Rates and pricing.
  { pattern: /\b(bhav|bhaav|bhaw|daam|dam|keemat|kimat|rate)\b/, hints: "sale rate pricing" },

  // Buying for tomorrow.
  { pattern: /\b(kharid|khareed|kharidna|mangwa|mangwana|mangana|mangau|mangwau|order\s*karna|order\s*karu|lana\s*hai)\b/, hints: "what should i purchase reorder" },

  // Customers who have gone quiet.
  { pattern: /\b(grahak|gaahak|gahak|party|customer)\b/, hints: "customer" },
  { pattern: /\b(grahak|gaahak|gahak|party|customer)[^.?!]{0,30}(nahi\s*aaya|nahi\s*aya|nahi\s*aa\s*rah|band\s*ho|gayab)/, hints: "inactive customer" },

  // Suppliers.
  { pattern: /\b(supplier|vyapari|vyaapari|arhat|arhatiya|mandi|dukandar)\b/, hints: "supplier" },

  // English shorthand the cascade never covered either. "How much did I sell today?" is a plain
  // English question that fell through to the generic briefing because the classifier only knows
  // the noun "sales", not the verb.
  { pattern: /\b(sell|selling|sold)\b/, hints: "sales" },
  { pattern: /\b(owe|owes|owed|owing|dues)\b/, hints: "outstanding ledger payment" },
  { pattern: /\b(running\s*(low|out)|out\s*of\s*stock|short\s*of)\b/, hints: "low stock" },
]);

/**
 * Lowercases the question and appends the English hints its Hinglish words earned.
 *
 * Returns the hints separately as well, because the audit log should be able to show *why* a
 * question was routed where it was without re-running the matching.
 */
const normalizeQuestion = (question = "") => {
  const original = String(question || "");
  const lowered = original.toLowerCase();
  // Hints are appended as whole phrases, never word by word. `PROFIT_RANKING` matches the phrase
  // "most profit", and a de-duplicated word list would have emitted "profit most" and missed it.
  const hints = [];
  for (const entry of HINGLISH_HINTS) {
    if (!entry.pattern.test(lowered)) continue;
    if (!hints.includes(entry.hints)) hints.push(entry.hints);
  }
  return {
    original,
    text: hints.length ? `${lowered} ${hints.join(" ")}` : lowered,
    hints,
  };
};

// "kal" is both yesterday and tomorrow. In a question about what to buy or bring it is plainly
// tomorrow, and reading it as yesterday would answer about the wrong day, so those questions get
// no spoken period at all and the period the owner picked on screen stands.
const FUTURE_MARKERS = /\b(mangwa|mangwana|mangana|mangau|mangwau|kharid|khareed|lana\s*hai|laana|order\s*kar|chahiye|karna\s*hai|hoga|hogi)\b/;

/**
 * A period named inside the question, as one of `getRange`'s keys, or "" when the question names
 * none. "" is the honest answer for "pichle mahine": the range list has no last-month key, and
 * quietly serving this month instead would put a wrong figure under a right-sounding sentence.
 */
const detectSpokenRange = (question = "") => {
  const text = String(question || "").toLowerCase();
  if (/\b(pichl|pichhl|gaye\s*mahine|gaya\s*mahina|last\s*month|last\s*week)/.test(text)) return "";
  if (/\b(is\s*mahine|iss\s*mahine|is\s*maheene|mahine|mahina|maheena|month)\b/.test(text)) return "this_month";
  if (/\b(hafte|hafta|haftey|saptah|week|saat\s*din|7\s*din)\b/.test(text)) return "last_7_days";
  if (/\b(aaj|aj|today)\b/.test(text)) return "today";
  if (/\b(kal|kl|yesterday)\b/.test(text) && !FUTURE_MARKERS.test(text)) return "yesterday";
  return "";
};

module.exports = {
  HINGLISH_HINTS,
  normalizeQuestion,
  detectSpokenRange,
};
