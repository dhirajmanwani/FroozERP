"use strict";

/**
 * The owner writes Hinglish. Before this module every one of the questions below fell through all
 * twelve branches of `classifyBusinessIntent` and came back as a generic briefing, which is a wall
 * of every figure in the shop with no sign that the question had been missed.
 *
 * The assertions run the real classifier, not a copy of it: a hint word that stops landing in the
 * branch it was chosen for is exactly the regression this file exists to catch, and it cannot be
 * seen by testing the hints alone.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { detectSmallTalk, normalizeQuestion, detectSpokenRange } = require("./frostLanguage");
const { classifyBusinessIntent } = require("./frostCore");

const HINGLISH_QUESTIONS = [
  ["aaj kitni sale hui", "SALES_FINANCE"],
  ["kal kitna bika", "SALES_FINANCE"],
  ["aaj ka dhandha kaisa raha", "SALES_FINANCE"],
  ["kiska udhaar baaki hai", "PAYMENTS"],
  ["kitna bakaya hai customers ka", "PAYMENTS"],
  ["supplier ka kitna dena hai", "PAYMENTS"],
  ["is mahine sabse zyada nafa kisme hua", "PROFIT_RANKING"],
  ["kharcha kitna hua is mahine", "LOSS_REVIEW"],
  ["kitna maal kharab hua", "LOSS_REVIEW"],
  ["maal kam pad raha hai kya", "INVENTORY"],
  ["kaun sa phal khatam ho raha hai", "INVENTORY"],
  ["purana maal kitna pada hai", "INVENTORY_EXPIRY"],
  ["kal kitna maal mangwana hai", "PURCHASE_PLANNING"],
  ["golak me kitna cash hai", "CASH_DRAWER"],
  ["bhav badalna chahiye kya", "SALE_RATE_REVIEW"],
  ["kaun sa grahak nahi aa raha", "CUSTOMER_ACTIVITY"],
];

for (const [question, expected] of HINGLISH_QUESTIONS) {
  test(`"${question}" reaches ${expected}`, () => {
    assert.equal(classifyBusinessIntent(question), expected);
  });
}

// English the classifier never covered either. "sell" is a verb; the cascade only knew the noun.
const ENGLISH_SHORTHAND = [
  ["How much did I sell today?", "SALES_FINANCE"],
  ["who owes me money", "PAYMENTS"],
  ["which fruits are running low", "INVENTORY"],
];

for (const [question, expected] of ENGLISH_SHORTHAND) {
  test(`"${question}" reaches ${expected}`, () => {
    assert.equal(classifyBusinessIntent(question), expected);
  });
}

test("the owner's own words are never replaced, only added to", () => {
  const normalized = normalizeQuestion("Kiska UDHAAR baaki hai");
  assert.equal(normalized.original, "Kiska UDHAAR baaki hai");
  assert.match(normalized.text, /kiska udhaar baaki hai/);
  assert.ok(normalized.hints.length > 0, "the Hinglish words must earn hints");
});

test("a question with no Hinglish in it is left exactly as it was, lowercased", () => {
  assert.equal(normalizeQuestion("What needs my attention today?").text, "what needs my attention today?");
  assert.deepEqual(normalizeQuestion("What needs my attention today?").hints, []);
});

test("an English-only briefing question still falls through to the briefing", () => {
  // The fallback has to stay reachable. If every question now matches something, the generic
  // briefing becomes dead code and "what needs my attention" stops being answerable.
  assert.equal(classifyBusinessIntent("What needs my attention today?"), "BUSINESS_BRIEFING");
  assert.equal(classifyBusinessIntent("kya dhyan dena chahiye"), "BUSINESS_BRIEFING");
});

test("hints are appended as phrases so a multi-word match survives", () => {
  // "most profit" is matched as a phrase by PROFIT_RANKING. A de-duplicated word list emitted
  // "profit most" and the phrase never matched, which sent every ranking question to SALES_FINANCE.
  assert.match(normalizeQuestion("sabse zyada nafa kisme hua").text, /most profit/);
});

test("a period named in the question is recognised", () => {
  assert.equal(detectSpokenRange("aaj kitni sale hui"), "today");
  assert.equal(detectSpokenRange("kal kitna bika"), "yesterday");
  assert.equal(detectSpokenRange("is hafte ka hisab"), "last_7_days");
  assert.equal(detectSpokenRange("is mahine kitna kharcha"), "this_month");
  assert.equal(detectSpokenRange("How much did I sell today?"), "today");
});

test("a period the range list cannot serve is refused rather than approximated", () => {
  // There is no last-month key. Serving this month under a "pichle mahine" question would put a
  // wrong figure behind a right-sounding sentence, so the question names no period and the one the
  // owner picked on screen stands.
  assert.equal(detectSpokenRange("pichle mahine ki sale"), "");
  assert.equal(detectSpokenRange("last month sales"), "");
});

test("kal is read as tomorrow, not yesterday, when the question is about buying", () => {
  // "kal" is both. Reading "kal kitna maal mangwana hai" as yesterday would answer about the wrong
  // day entirely, so a question carrying a future marker names no period at all.
  assert.equal(detectSpokenRange("kal kitna maal mangwana hai"), "");
  assert.equal(detectSpokenRange("kal kya kharidna chahiye"), "");
  assert.equal(detectSpokenRange("kal kitna bika"), "yesterday");
});

test("no hint pattern is written with a trailing boundary it cannot match", () => {
  // `/\b(pichl)\b/` never matches "pichle": the boundary after the l requires a non-word character
  // and an e follows. Two patterns shipped with this bug and silently matched nothing.
  const { HINGLISH_HINTS } = require("./frostLanguage");
  for (const entry of HINGLISH_HINTS) {
    for (const alternative of String(entry.pattern.source).matchAll(/\|([a-z]+)\)\\b/g)) {
      assert.ok(
        entry.pattern.test(alternative[1]),
        `${entry.pattern} cannot match its own alternative "${alternative[1]}"`,
      );
    }
  }
});

test("a greeting is a greeting, not a request for the whole briefing", () => {
  // "hi there" and "how are you" each returned every due, every low stock line and every old lot,
  // because the classifier has no branch for chitchat and the briefing is what it falls through to.
  for (const question of ["hi", "hi there", "hello", "hey", "namaste", "good morning", "hello frost!"]) {
    assert.equal(classifyBusinessIntent(question), "SMALL_TALK", question);
    assert.equal(detectSmallTalk(question), "greeting", question);
  }
  assert.equal(detectSmallTalk("how are you"), "wellbeing");
  assert.equal(detectSmallTalk("kaise ho"), "wellbeing");
  assert.equal(detectSmallTalk("thanks bhai"), "thanks");
  assert.equal(detectSmallTalk("who are you"), "identity");
});

test("a business question that opens with a greeting is still a business question", () => {
  // The whole-question match is the entire safety of this feature. A substring match would answer
  // "hi, aaj kitni sale hui" with "Hello", which is worse than the wall of figures it replaced.
  assert.equal(detectSmallTalk("hi, aaj kitni sale hui"), "");
  assert.equal(classifyBusinessIntent("hi, aaj kitni sale hui"), "SALES_FINANCE");
  assert.equal(detectSmallTalk("hello, what needs my attention today?"), "");
  assert.equal(detectSmallTalk("good morning, kitna udhaar baaki hai"), "");
});

test("a demand question reaches the sales ranking", () => {
  // "what product is more demanding" reached none of the twelve branches and came back as a general
  // briefing -- a plausible answer about something else, with nothing to say so.
  for (const question of [
    "what product is more demanding",
    "which item is in most demand",
    "best selling product",
    "kaun sa maal sabse zyada bikta hai",
  ]) {
    assert.equal(classifyBusinessIntent(question), "PROFIT_RANKING", question);
  }
});

test("a copula on the end does not hide a greeting", () => {
  // "kya haal" was covered and "kya haal hai" was not, so the owner's second attempt at the same
  // greeting came back as the whole ledger. An allow-list of greetings can never be complete, which
  // is why the unrecognised-question fallback below exists as well as this.
  for (const question of ["kya haal", "kya haal hai", "kya haal he", "kaise hain", "sab theek hai"]) {
    assert.equal(classifyBusinessIntent(question), "SMALL_TALK", question);
  }
});

test("a question that says nothing about the shop is not answered with the shop's figures", () => {
  for (const question of ["who won the match", "tell me a joke", "asdfgh", ""]) {
    assert.equal(classifyBusinessIntent(question), "UNCLEAR", question);
  }
});

test("a question that does say something about the shop still earns the briefing", () => {
  // The risk of the check above is refusing a real question, which is worse than stretching to
  // answer a vague one, so the signal list is deliberately broad.
  for (const question of [
    "What needs my attention today?",
    "aaj kya dhyan dena hai",
    "business kaisa chal raha hai",
    "how is the shop",
    "kya problem hai",
  ]) {
    assert.notEqual(classifyBusinessIntent(question), "UNCLEAR", question);
  }
});

test("dhyan dena hai is not a payment question", () => {
  // "dena hai" means "have to give"; "dhyan dena hai" means "have to pay attention". The owner's own
  // way of asking for the briefing was answered with the payments ledger.
  assert.equal(classifyBusinessIntent("aaj kya dhyan dena hai"), "BUSINESS_BRIEFING");
  assert.equal(classifyBusinessIntent("supplier ka kitna dena hai"), "PAYMENTS");
});
