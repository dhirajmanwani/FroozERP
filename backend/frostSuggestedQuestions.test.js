"use strict";

/**
 * FROST's twelve suggested questions must reach the queries written to answer them.
 *
 * ## The bug this pins
 *
 * "Which customers have become inactive?" is one of the buttons FROST itself offers. It classified
 * as `BUSINESS_BRIEFING`, not `CUSTOMER_ACTIVITY`, because the regex asked for the literal phrase
 * `inactive customer` and the shipped question says the words in the other order. The one query
 * written to answer it -- `getCustomerActivitySummary` -- was unreachable from the button that
 * asks for it.
 *
 * Nothing failed. The user pressed a question about inactive customers and got a general business
 * briefing: plausible, well-formed, and about something else. There was no error and no way to
 * tell from the answer that the question had been quietly substituted. That is the same class as
 * "errors must never render as zero", in language rather than numbers.
 *
 * ## Why the whole list, not one case
 *
 * Fixing that one regex fixes one question. The two lists -- the suggestions in
 * `aiBusinessAssistantService.js` and the classifier in `frostCore.js` -- are edited independently
 * and neither knows about the other, so they will drift again. Running every shipped suggestion
 * through the real classifier is the only assertion that keeps them honest as questions are added.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyBusinessIntent } = require("./frostCore");
const { SUGGESTED_QUESTIONS } = require("./aiBusinessAssistantService");

// The intent each shipped suggestion is asking for. This is the claim under test: if a question is
// reworded and no longer reaches the intent that answers it, this table is what notices.
const EXPECTED_INTENT = {
  "What needs my attention today?": "BUSINESS_BRIEFING",
  "Which customer payments are overdue?": "PAYMENTS",
  "What supplier bills are pending?": "PAYMENTS",
  "Which items are low in stock?": "INVENTORY",
  "Which stock lots are aging or likely to expire?": "INVENTORY_EXPIRY",
  "What was today's sales and gross profit?": "SALES_FINANCE",
  "Which items generated the most profit this month?": "PROFIT_RANKING",
  "Where did I lose money this month?": "LOSS_REVIEW",
  "Which customers have become inactive?": "CUSTOMER_ACTIVITY",
  "What should I purchase tomorrow?": "PURCHASE_PLANNING",
  "What is my current cash, bank, receivable and payable position?": "CASH_DRAWER",
  "Which sale rates may need revision?": "SALE_RATE_REVIEW",
};

test("every shipped suggestion is covered by this table", () => {
  // Without this, adding a question to the product and forgetting it here would leave it untested
  // while the suite stayed green -- the same shape of gap as the one being fixed.
  const uncovered = SUGGESTED_QUESTIONS.filter((question) => !(question in EXPECTED_INTENT));
  assert.deepEqual(uncovered, [], "these suggested questions have no expected intent recorded");

  const stale = Object.keys(EXPECTED_INTENT).filter((question) => !SUGGESTED_QUESTIONS.includes(question));
  assert.deepEqual(stale, [], "these expectations name questions FROST no longer offers");
});

test("every suggested question reaches the intent written to answer it", () => {
  for (const question of SUGGESTED_QUESTIONS) {
    assert.equal(
      classifyBusinessIntent(question),
      EXPECTED_INTENT[question],
      `"${question}" is answered by the wrong query`,
    );
  }
});

test("the inactive-customers question specifically, in both word orders", () => {
  // The measured regression, kept as its own case so a future edit to the alternation cannot pass
  // by matching one phrasing and losing the other.
  assert.equal(classifyBusinessIntent("Which customers have become inactive?"), "CUSTOMER_ACTIVITY");
  assert.equal(classifyBusinessIntent("show me inactive customers"), "CUSTOMER_ACTIVITY");
  assert.equal(classifyBusinessIntent("which customer has not purchased recently"), "CUSTOMER_ACTIVITY");
});

test("a question with no match still lands somewhere answerable", () => {
  // The fallback is a real intent with real facts behind it, not a null that renders as nothing.
  assert.equal(classifyBusinessIntent("how is the shop doing"), "BUSINESS_BRIEFING");
  assert.equal(classifyBusinessIntent(""), "BUSINESS_BRIEFING");
  assert.equal(classifyBusinessIntent(undefined), "BUSINESS_BRIEFING");
});
