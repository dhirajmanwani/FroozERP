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
  // "dhyan dena hai" is "I have to pay attention", not "I have to pay". Without the lookbehind
  // "aaj kya dhyan dena hai" -- the owner's own way of asking for the briefing -- was answered with
  // the payments ledger.
  { pattern: /\b(udhaar|udhar|udhari|udhaari|baki|baaki|bakaya|bakaaya|hisaab|hisab|lena\s*hai|(?<!dhyan )dena\s*hai|len\s*den|lendel)\b/, hints: "outstanding ledger payment" },
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
/**
 * Every period key `detectSpokenRange` may return. `getRange` in `aiBusinessAssistantService.js`
 * must serve all of them, and `frostPeriodCoverage` in the tests asserts exactly that.
 *
 * This list exists because of the failure it now prevents. "which product was in high demand this
 * year" was answered with today's figures, under a source line reading "- Today": the question named
 * a period, the range layer did not know the word, and the answer came back about a different span
 * of time with nothing to say so. A key this module can return but `getRange` cannot serve produces
 * that silently, every time.
 */
const SPOKEN_RANGE_KEYS = Object.freeze([
  "today", "yesterday", "last_7_days", "this_month", "last_month", "this_year", "last_year",
]);

// "last", in either language, has to be attached to the unit it modifies. An earlier version matched
// the bare prefix `pichl`, which made "pichle pandrah din" -- the last fifteen days -- resolve to
// last month, and "pichle saal" resolve to last month too. Both are silent substitutions of one span
// of time for another, which is the exact failure this whole module exists to stop.
const PAST = "(?:pichl\\w*|pichhl\\w*|gaye|gaya|last|previous)";
const THIS = "(?:is|iss|this|es)";
const YEAR = "(?:saal|saalo|varsh|year)";
const MONTH = "(?:mahine|mahina|maheene|maheena|month)";

const detectSpokenRange = (question = "") => {
  const text = String(question || "").toLowerCase();
  if (new RegExp(`\\b${PAST}\\s+${YEAR}\\b`).test(text)) return "last_year";
  if (new RegExp(`\\b${PAST}\\s+${MONTH}\\b`).test(text)) return "last_month";
  if (new RegExp(`\\b(?:${THIS}\\s+)?${YEAR}\\b`).test(text) || /\b(salana|saalana)\b/.test(text)) return "this_year";
  if (new RegExp(`\\b(?:${THIS}\\s+)?${MONTH}\\b`).test(text)) return "this_month";
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

/**
 * Chitchat, and which kind it is.
 *
 * "hi there" and "how are you" used to return the full business briefing -- every due, every low
 * stock line, every old lot -- because the classifier has no branch for a greeting and the briefing
 * is what it falls through to. It is the single thing that made FROST read like a machine rather
 * than someone at the counter, and no amount of better wording on the figures fixes it, because the
 * figures should not have been fetched at all.
 *
 * Matched against the WHOLE question, never a substring: "hi, aaj kitni sale hui" is a question
 * about sales that happens to open with a greeting, and answering it with "Hello" would be a worse
 * failure than the one being fixed. Vocatives and punctuation are stripped first, because "hello
 * frost!" and "thanks bhai" are the same two things.
 */
const SMALL_TALK_KINDS = Object.freeze([
  { kind: "thanks", pattern: /^(thanks?|thank you|thanku|thankyou|thx|ty|shukriya|dhanyawad|dhanyavad|ok|okay|theek hai|thik hai|sahi hai|badhiya|nice|good|great|cool|done|got it|samajh gaya)$/ },
  { kind: "identity", pattern: /^(who are you|what are you|what can you do|what do you do|tum kaun ho|aap kaun ho|kaun ho|tum kya kar sakte ho|kya kar sakte ho|help|madad)$/ },
  { kind: "wellbeing", pattern: /^(how are you|how are you doing|how r u|how do you do|kaise ho|kaisi ho|kaise|kaisa|kaisi|kya haal|kya hal|kya haal chaal|kya chal raha|sab theek|sab thik|sab badhiya|whats up|what's up|sup)$/ },
  { kind: "greeting", pattern: /^(hi|hii+|hiya|hello|helo|hey|heyy+|yo|hi there|hello there|hey there|namaste|namaskar|ram ram|salaam|salam|good morning|good afternoon|good evening|gud morning|gm|morning)$/ },
]);

const detectSmallTalk = (question = "") => {
  const stripped = String(question || "")
    .toLowerCase()
    .replace(/[!?.,;:]+/g, " ")
    // Vocatives carry no meaning here and would otherwise defeat the whole-question match.
    .replace(/\b(frost|bhai|yaar|yar|ji|sir|boss|dost)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    // "kya haal" and "kya haal hai" are the same thing, and he writes both, plus "he" and "h".
    // Without this the list below has to carry every spelling of the copula, which is how an
    // allow-list of greetings quietly stops covering the greetings people actually type.
    .replace(/\s+(hai|hain|he|hein|h|na)$/, "")
    // "kya haal bhai k" -- the stray letter is a half-typed word or a slip of the thumb, and it
    // turned a greeting into a question FROST could not place. A one-letter token at the end of a
    // sentence carries no meaning in either language, so it is dropped rather than matched.
    .replace(/(\s+[a-z]){1,2}$/, "")
    .trim();
  if (!stripped) return "";
  for (const entry of SMALL_TALK_KINDS) {
    if (entry.pattern.test(stripped)) return entry.kind;
  }
  return "";
};

module.exports.SMALL_TALK_KINDS = SMALL_TALK_KINDS;
module.exports.detectSmallTalk = detectSmallTalk;

/**
 * Does this question say anything about the shop at all?
 *
 * The classifier's last branch is the general briefing, so anything it does not recognise comes back
 * as every due, every low stock line and every old lot. That is the same failure as an error
 * rendering as zero, in language rather than numbers: a well-formed, plausible answer about
 * something the owner did not ask, with nothing in it to say the question was missed.
 *
 * A list of greetings can never be complete -- "kya haal" was covered and "kya haal hai" was not --
 * so the briefing is now earned rather than defaulted to. Anything with no business signal in it is
 * answered with a plain "I did not catch that", which is honest and costs the owner one retype.
 * Deliberately broad: answering a stretched question is a much smaller failure than refusing a real
 * one, so every Hinglish word the hints already know counts, plus the words a briefing is asked in.
 */
const BRIEFING_SIGNALS = /\b(attention|dhyan|zaroori|jaruri|important|urgent|today|aaj|summary|brief|briefing|overview|business|shop|dukan|dukaan|report|position|pending|overdue|total|problem|dikkat|issue|status|number|figure|book|khata|khaata|accounts?|money|paisa|paise|check|karna|karu|karna hai|chal raha|chal rahi|how is|hows|how.s)\b/;

const hasBusinessSignal = (question = "") => {
  // Naming a period is saying something about the shop. "this year", typed on its own as a
  // follow-up, was answered with "I did not catch that" -- which is true of the words and useless
  // to the owner, who had just asked a question and was narrowing it.
  if (detectSpokenRange(question)) return true;
  const normalized = normalizeQuestion(question);
  return normalized.hints.length > 0 || BRIEFING_SIGNALS.test(normalized.text);
};

module.exports.BRIEFING_SIGNALS = BRIEFING_SIGNALS;
module.exports.SPOKEN_RANGE_KEYS = SPOKEN_RANGE_KEYS;
module.exports.hasBusinessSignal = hasBusinessSignal;
