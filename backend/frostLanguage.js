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

// A trailing `s` is spelled out on every English noun below. `\bsupplier\b` does not match
// "suppliers" -- the boundary after the r wants a non-word character and an s follows -- so "pay my
// suppliers" and "which products are low" reached no branch at all and came back as "I did not
// catch that". It is the same trailing-boundary trap that `pichl` fell into, in a different dress.
//
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
  { pattern: /\b(kharch|kharcha|kharche|laagat|lagat|expenses?)\b/, hints: "expense" },

  // Waste and spoilage -- a fruit shop's daily reality.
  { pattern: /\b(kharab|kharaab|sad|sada|sadi|sadd|sadne|barbad|barbaad|fek|feka|fenka|phenk)\b/, hints: "waste" },

  // Stock on hand.
  { pattern: /\b(maal|samaan|saman|stock|inventory|products?|items?)\b/, hints: "stock inventory" },
  { pattern: /\b(khatam|khatm|khatham|kam\s*pad|kam\s*hai|kam\s*ho|nahi\s*bacha|na\s*bacha)\b/, hints: "low stock" },
  { pattern: /\b(fal|phal|phall|fruits?)\b/, hints: "fruit" },

  // Old lots. He says "purana maal", never "nearing expiry".
  { pattern: /\b(purana|puraana|purane|puraane|purani|sadne\s*wala|expiry|expire)\b/, hints: "old lot near expiry" },

  // Rates and pricing.
  { pattern: /\b(bhav|bhaav|bhaw|daam|dam|keemat|kimat|rates?)\b/, hints: "sale rate pricing" },

  // Buying for tomorrow.
  { pattern: /\b(kharid|khareed|kharidna|mangwa|mangwana|mangana|mangau|mangwau|order\s*karna|order\s*karu|lana\s*hai)\b/, hints: "what should i purchase reorder" },

  // Customers who have gone quiet.
  { pattern: /\b(grahak|gaahak|gahak|party|parties|customers?)\b/, hints: "customer" },
  { pattern: /\b(grahak|gaahak|gahak|party|customer)[^.?!]{0,30}(nahi\s*aaya|nahi\s*aya|nahi\s*aa\s*rah|band\s*ho|gayab)/, hints: "inactive customer" },

  // Suppliers.
  { pattern: /\b(suppliers?|vyapari|vyaapari|arhat|arhatiya|mandi|dukandar)\b/, hints: "supplier" },

  // English shorthand the cascade never covered either. "How much did I sell today?" is a plain
  // English question that fell through to the generic briefing because the classifier only knows
  // the noun "sales", not the verb.
  { pattern: /\b(sell|selling|sold)\b/, hints: "sales" },
  { pattern: /\b(owe|owes|owed|owing|dues?|pay|pays|paid|paying|payments?)\b/, hints: "outstanding ledger payment" },
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

/**
 * "remind me to pay my suppliers" is an instruction, not a question.
 *
 * FROST has had a reminders table, a reminders route and a Reminders section the whole time, and no
 * way to reach any of it by saying so. The owner asked in the most natural words there are and was
 * told his question was not understood -- which was true of the classifier and false of the product.
 *
 * Matched on the asking phrase rather than the subject, because the subject is a business topic and
 * would otherwise route the sentence to the ledger it mentions: "remind me to pay my suppliers"
 * classifies as PAYMENTS on every word except the first two.
 */
const REMINDER_PHRASES = /\b(remind me|reminder|remind|yaad dila|yaad dilana|yaad rakh|yaad rakhna|note kar|note karlo|likh lo|likh lena)\b/;

const isReminderRequest = (question = "") => REMINDER_PHRASES.test(String(question || "").toLowerCase());

/**
 * What the reminder should say, from the sentence that asked for it.
 *
 * The asking phrase is stripped and the rest is kept verbatim -- his words, not a paraphrase. A
 * reminder that reads "Follow up required" is a reminder about nothing; the owner has to be able to
 * tell from the list what he meant, weeks later.
 */
const reminderTitleFrom = (question = "") => {
  const text = String(question || "")
    .replace(/[!?.]+\s*$/, "")
    .trim();
  const stripped = text
    .replace(/^\s*(please|plz|zara|bhai)\s+/i, "")
    // `\b` after the group, so "remind" can no longer eat the front of "reminder": "reminder set karo
    // supplier payment kal" was saved with the title "er set karo supplier payment kal". Every
    // alternative is a whole phrase, which is why a trailing boundary is right here -- the trap noted
    // at the top of this file is a boundary after a *prefix*, and none of these is one.
    .replace(/^\s*(remind me to|remind me|reminder set karo|reminder set kar do|reminder laga do|reminder lagao|reminder for|reminder to|set a reminder to|set a reminder for|reminder|remind|mujhe yaad dilana|yaad dilana|yaad dila do|yaad rakhna|note kar lo|note karlo|likh lo|likh lena)\b\s*/i, "")
    .replace(/^\s*(that|ki|ke liye|to)\s+/i, "")
    .trim();
  return stripped || text;
};

module.exports.REMINDER_PHRASES = REMINDER_PHRASES;
module.exports.isReminderRequest = isReminderRequest;
module.exports.reminderTitleFrom = reminderTitleFrom;

/**
 * When the reminder is for, from the way he actually types it.
 *
 * `isReminderRequest` and `reminderTitleFrom` above get the reminder made and get his own words
 * into it. Neither of them reads *when*, so every reminder he asked for landed in the list with no
 * due date at all -- which is a note, not a reminder: the panel sorts on `due_at`, so a reminder
 * with none sinks below every dated one and is never surfaced on the day it mattered. He asked for
 * a due date in as many words.
 *
 * ## Why a reference date is an argument and not `new Date()`
 *
 * Every rule below is relative -- "kal" is a day after *something*. Reading the clock inside the
 * parser makes the whole thing untestable except by mocking time, and makes two calls a
 * millisecond apart across midnight disagree. The caller passes the moment it is reasoning about,
 * and a caller that passes nothing is refused loudly rather than served a date from a clock it did
 * not ask about -- the same rule `requireBranchScope` follows for the same reason.
 *
 * ## Why "kal" is tomorrow here and yesterday in `detectSpokenRange`
 *
 * "kal" is both words. `detectSpokenRange` reads a *question about the books*, which can only be
 * about days that have already happened, so there it is yesterday. A reminder is a thing to be
 * done, which can only be in the future: "kal yaad dilana" is never a request to have been
 * reminded yesterday. Same word, opposite reading, and both readings are decided by what the
 * sentence is for rather than by the word -- so neither function may borrow the other's rule.
 *
 * ## Dates are computed in UTC
 *
 * `toDateKey`/`getRange` in `aiBusinessAssistantService.js` already slice `toISOString()`, so a day
 * key in this codebase means a UTC day. A parser that used local days would hand `due_at` a
 * different calendar from the one every other date in FROST is on.
 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const toUtcDayStart = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
};

const isoDay = (date) => date.toISOString().slice(0, 10);
const addUtcDays = (date, days) => new Date(date.getTime() + days * MS_PER_DAY);

/**
 * The Nth of a month, refusing rather than rolling over.
 *
 * `new Date(Date.UTC(2026, 8, 31))` is the 1st of October, silently. "31 tarikh" asked in September
 * would then produce a reminder dated a day the owner did not name, in a month he did not name, and
 * nothing in the panel would say so. So the constructed day is checked against the day asked for,
 * and the search walks forward to the next month that actually has it.
 */
const nthOfUpcomingMonth = (reference, day) => {
  if (!Number.isInteger(day) || day < 1 || day > 31) return "";
  for (let monthsAhead = 0; monthsAhead <= 12; monthsAhead += 1) {
    const candidate = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() + monthsAhead, day));
    if (candidate.getUTCDate() !== day) continue;
    // A date already past is the wrong month, not the wrong date. "5 tarikh" said on the 20th means
    // the 5th of next month; answering with a date behind the owner is a reminder that can never fire.
    if (candidate.getTime() < reference.getTime()) continue;
    return isoDay(candidate);
  }
  return "";
};

/**
 * The weekday named, at its next occurrence.
 *
 * "somvar ko yaad dilana" said on a Monday means the Monday coming, not the one being lived
 * through -- a reminder for a day already half gone is not what he asked for -- so an exact match
 * on the reference day moves a week forward rather than resolving to today.
 */
const nextWeekday = (reference, weekday) => {
  const delta = ((weekday - reference.getUTCDay()) + 7) % 7;
  return isoDay(addUtcDays(reference, delta === 0 ? 7 : delta));
};

// Each spelling is written out in full. `\b(som)\b` does not match "somvar" -- the boundary after
// the m wants a non-word character and a v follows -- which is the trailing-boundary trap that cost
// this file two silently-dead patterns already (`pichl`, `\bsupplier\b`). `reminderDueDateRuleWords`
// below exists so a test can walk every alternative and prove each one matches its own pattern.
const WEEKDAYS = Object.freeze([
  // No bare "sun" or "sat": "sun" is an English word and "sat" is both an English word and the
  // Hindi for seven ("saat din"), so either abbreviation would turn an ordinary sentence into a
  // dated reminder. The full spellings carry no such risk.
  { weekday: 0, pattern: /\b(sunday|ravivar|raviwar|itwar|etwar|itvaar)\b/ },
  { weekday: 1, pattern: /\b(monday|mon|somvar|somwar|somvaar)\b/ },
  { weekday: 2, pattern: /\b(tuesday|tues|tue|mangalvar|mangalwar|mangal)\b/ },
  { weekday: 3, pattern: /\b(wednesday|wed|budhvar|budhwar|budhvaar|buddhvar)\b/ },
  { weekday: 4, pattern: /\b(thursday|thurs|thur|thu|guruvar|guruwar|brihaspativar)\b/ },
  { weekday: 5, pattern: /\b(friday|fri|shukravar|shukrawar|jumma)\b/ },
  { weekday: 6, pattern: /\b(saturday|shanivar|shaniwar|shanivaar)\b/ },
]);

/**
 * Ordered, and the first rule that matches wins.
 *
 * The order is the whole correctness of this list, not a tidiness choice:
 *
 *  - counted spans ("do hafte baad", "3 din baad") come before the bare words they contain, so
 *    "2 hafte" is not read as the word "hafte" alone;
 *  - `kal` comes before `aaj`, so "aaj nahi kal yaad dilana" -- not today, tomorrow -- is read as
 *    the day he ended the sentence with rather than the day he ruled out.
 */
const REMINDER_DUE_DATE_RULES = Object.freeze([
  {
    name: "counted_weeks",
    pattern: /\b(?:in\s+|after\s+)?(\d{1,2})\s*(?:hafte|hafto|haftey|hafta|saptah|weeks?)\b/,
    resolve: (match, reference) => isoDay(addUtcDays(reference, Number(match[1]) * 7)),
  },
  {
    name: "counted_days",
    // "3 din baad", "in 3 days", "3 dino me". The trailing "baad"/"me" is optional because he drops
    // it as often as he types it, and inside a reminder a bare count of days can only mean ahead:
    // nobody asks to be reminded three days ago.
    pattern: /\b(?:in\s+|after\s+)?(\d{1,3})\s*(?:din|dino|dinon|days?)\b/,
    resolve: (match, reference) => isoDay(addUtcDays(reference, Number(match[1]))),
  },
  {
    name: "next_week",
    pattern: /\b(?:next|agle|agla|aglay|agli)\s*(?:week|hafte|hafta|haftey|saptah)\b|\b(?:ek\s*)?(?:hafte|hafta|week)\s*(?:baad|bad|ke\s*baad)\b/,
    resolve: (_match, reference) => isoDay(addUtcDays(reference, 7)),
  },
  {
    name: "day_after_tomorrow",
    pattern: /\b(parso|parson|parsoon|parsu|day\s+after\s+tomorrow)\b/,
    resolve: (_match, reference) => isoDay(addUtcDays(reference, 2)),
  },
  {
    name: "weekday",
    pattern: new RegExp(WEEKDAYS.map((entry) => entry.pattern.source).join("|")),
    resolve: (_match, reference, text) => {
      const named = WEEKDAYS.find((entry) => entry.pattern.test(text));
      return named ? nextWeekday(reference, named.weekday) : "";
    },
  },
  {
    name: "day_of_month",
    // "15 tarikh", "15 ko", "on the 15th". Two digits at most and a word boundary in front, so the
    // "00" of an amount like "2000 ko" cannot be read as a date.
    pattern: /\b(\d{1,2})\s*(?:tarikh|tareekh|tarik|ko)\b|\bon\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\b|\b(\d{1,2})(?:st|nd|rd|th)\b/,
    resolve: (match, reference) => nthOfUpcomingMonth(reference, Number(match[1] || match[2] || match[3])),
  },
  {
    name: "tomorrow",
    // See the header: in a reminder "kal" is tomorrow, because a reminder is about the future.
    pattern: /\b(kal|kl|tomorrow|tommorow|tomorow|tmrw|kalko)\b/,
    resolve: (_match, reference) => isoDay(addUtcDays(reference, 1)),
  },
  {
    name: "today",
    pattern: /\b(aaj|aj|aaz|today|abhi)\b/,
    resolve: (_match, reference) => isoDay(reference),
  },
]);

/**
 * The due date a reminder names, as `YYYY-MM-DD`, or "" when it names none.
 *
 * "" is the honest answer and not a fallback to today: a reminder with no date is a reminder the
 * owner can still date himself, while one silently dated today fires once, today, and is gone.
 */
const detectReminderDueDate = (question = "", referenceDate) => {
  const reference = toUtcDayStart(referenceDate);
  if (!reference) {
    throw new Error("FROST_REMINDER_REFERENCE_DATE_REQUIRED: every due-date rule is relative, so the caller must say to what");
  }
  const text = String(question || "").toLowerCase();
  for (const rule of REMINDER_DUE_DATE_RULES) {
    const match = text.match(rule.pattern);
    if (!match) continue;
    const resolved = rule.resolve(match, reference, text);
    // A rule that matched but could not resolve -- "32 tarikh" -- falls through to the rules after
    // it rather than returning a date nobody named.
    if (resolved) return resolved;
  }
  return "";
};

/**
 * Every plain-word alternative written into the rules above, for the test that proves each pattern
 * can match its own spellings. `\b(pichl)\b` shipped twice in this file and matched nothing both
 * times; a list of words is only coverage if the regex around it can reach them.
 */
const reminderDueDateRuleWords = () => {
  const sources = [
    ...REMINDER_DUE_DATE_RULES.map((rule) => rule.pattern.source),
    ...WEEKDAYS.map((entry) => entry.pattern.source),
  ];
  const words = new Set();
  for (const source of sources) {
    for (const [word] of source.matchAll(/[a-z]{2,}/g)) {
      // Regex keywords, not vocabulary.
      if (["in", "after", "on", "the", "st", "nd", "rd", "th", "ke", "ek", "s"].includes(word)) continue;
      words.add(word);
    }
  }
  return [...words];
};

module.exports.REMINDER_DUE_DATE_RULES = REMINDER_DUE_DATE_RULES;
module.exports.WEEKDAYS = WEEKDAYS;
module.exports.detectReminderDueDate = detectReminderDueDate;
module.exports.reminderDueDateRuleWords = reminderDueDateRuleWords;
