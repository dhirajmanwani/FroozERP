"use strict";

/**
 * The answer the owner was actually shown, which is what this suite exists to stop coming back:
 *
 *   Period: Today. POS Billing: sales 0, estimated gross profit 0. Accounts: outstanding 23794
 *   across 5 records. Purchases: outstanding 1580.64 across 1 records. Inventory Lots: 3 matching
 *   records. Inventory Lots: 30 matching records. Top details: kalu a17, lilaram, Kaiu Ghantaghar.
 *   Source modules: POS Billing, Accounts, Purchases, Inventory Lots, Sales History.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildDeterministicAnswer,
  dedupeByType,
  formatIndianNumber,
  money,
  orderForIntent,
  quantity,
} = require("./frostAnswer");
const { assertGroundedAnswer } = require("./aiBusinessAssistantRules");

const fact = (type, sourceModule, periodLabel, rows, summary) => ({ type, sourceModule, periodLabel, rows, summary });

const SALES_ZERO = fact("daily_sales_summary", "POS Billing", "Today", [], {
  billCount: 0, totalSales: 0, estimatedGrossProfit: 0, discountAmount: 0,
});
const SALES_REAL = fact("daily_sales_summary", "POS Billing", "Today", [], {
  billCount: 12, totalSales: 48250, estimatedGrossProfit: 6120.5, discountAmount: 0,
});
const CUSTOMERS = fact("customer_outstanding", "Accounts", "Current outstanding",
  [{ customer_name: "kalu a17" }, { customer_name: "lilaram" }, { customer_name: "Kaiu Ghantaghar" }],
  { totalOutstanding: 23794, count: 5 });
const SUPPLIERS = fact("supplier_outstanding", "Purchases", "Current outstanding",
  [{ supplier_name: "Mandi Traders" }], { totalOutstanding: 1580.64, count: 1 });
const LOW_STOCK = fact("low_stock_products", "Inventory Lots", "Current stock",
  [{ product_name: "Apple" }, { product_name: "Banana" }, { product_name: "Kiwi" }], { count: 3 });
const OLD_LOTS = fact("inventory_nearing_expiry", "Inventory Lots", "Lots older than 20 days",
  [{ product_name: "Apple" }], { count: 30 });

const BRIEFING_FACTS = [SALES_ZERO, CUSTOMERS, SUPPLIERS, LOW_STOCK, OLD_LOTS];

test("two facts that share a source module are named apart", () => {
  // Low stock and old lots are both labelled "Inventory Lots", which is how one answer said
  // "Inventory Lots: 3 matching records. Inventory Lots: 30 matching records." and named neither.
  const answer = buildDeterministicAnswer("BUSINESS_BRIEFING", BRIEFING_FACTS, { label: "Today" });
  assert.doesNotMatch(answer, /Inventory Lots/);
  assert.match(answer, /3 products are at or below minimum stock/);
  assert.match(answer, /30 lots are older than 20 days/);
});

test("the same fact arriving twice is said once", () => {
  // `getGrossProfitSummary` is literally `getDailySalesSummary`, so a finance question holds the
  // sales fact twice and the old wording printed the sales figures twice.
  const answer = buildDeterministicAnswer("SALES_FINANCE", [SALES_REAL, SALES_REAL], { label: "Today" });
  assert.equal(answer.match(/48,250/g).length, 1);
  assert.equal(dedupeByType([SALES_REAL, SALES_REAL, CUSTOMERS]).length, 2);
});

test("the fact the question was about leads the answer", () => {
  const facts = [LOW_STOCK, CUSTOMERS, SALES_REAL];
  assert.match(buildDeterministicAnswer("PAYMENTS", facts, { label: "Today" }), /^Today: Customers owe you/);
  assert.match(buildDeterministicAnswer("INVENTORY", facts, { label: "Today" }), /^Today: 3 products are/);
  assert.match(buildDeterministicAnswer("SALES_FINANCE", facts, { label: "Today" }), /^Today: .*48,250/);
  assert.equal(orderForIntent(facts, "PAYMENTS")[0].type, "customer_outstanding");
});

test("a zero on the fact that was asked about is stated, not skipped", () => {
  // "Errors must never render as zero" read the other way round: a real zero has to be visible as
  // a real zero, and not as a fact that quietly failed to appear.
  const answer = buildDeterministicAnswer("SALES_FINANCE", [SALES_ZERO], { label: "Today" });
  assert.match(answer, /no sales yet/);
});

test("a fact that could not be read says so instead of reading as zero", () => {
  const broken = fact("customer_outstanding", "Accounts", "Current outstanding", [], {
    unavailable: true, error: "connection timeout", totalOutstanding: 0, count: 0,
  });
  const answer = buildDeterministicAnswer("PAYMENTS", [broken], { label: "Today" });
  assert.match(answer, /could not be read/);
  assert.doesNotMatch(answer, /no customer dues/);
});

test("the period always leads, so a filter is never invisible", () => {
  // The lesson Report Center already taught this codebase.
  assert.match(buildDeterministicAnswer("SALES_FINANCE", [SALES_REAL], { label: "Yesterday" }), /^Yesterday: /);
  assert.match(buildDeterministicAnswer("SALES_FINANCE", [], { label: "This Month" }), /^This Month: /);
});

test("an empty fact list still answers rather than trailing off", () => {
  assert.equal(buildDeterministicAnswer("INVENTORY", [], { label: "Today" }), "Today: stock is above minimum everywhere and no lot is overdue.");
  assert.equal(buildDeterministicAnswer("BUSINESS_BRIEFING", [], {}), "Today: nothing needs attention.");
});

test("the source modules are not repeated in the words", () => {
  // The panel prints them under every answer already, and repeating them was most of what made the
  // old wording read like a machine.
  const answer = buildDeterministicAnswer("BUSINESS_BRIEFING", BRIEFING_FACTS, { label: "Today" });
  assert.doesNotMatch(answer, /Source modules/);
  assert.doesNotMatch(answer, /matching records/);
});

test("rupees are grouped the Indian way", () => {
  assert.equal(formatIndianNumber(2345678.5), "23,45,678.50");
  assert.equal(formatIndianNumber(23794), "23,794");
  assert.equal(formatIndianNumber(1580.64), "1,580.64");
  assert.equal(formatIndianNumber(0), "0");
  assert.equal(formatIndianNumber(-4500), "-4,500");
  assert.equal(formatIndianNumber("not a number"), "0");
  assert.equal(money(100), "₹100");
});

test("quantities keep three decimals without trailing noise", () => {
  assert.equal(quantity(12.5), "12.5");
  assert.equal(quantity(12.0), "12");
  assert.equal(quantity(0.125), "0.125");
});

test("every figure in the answer is one of the verified figures", () => {
  // The same check the grounding guard applies to a model-written answer. The deterministic wording
  // is grounded by construction, but "by construction" is worth asserting once: the formatter
  // inserts commas and a currency symbol, and a formatting change that invented a digit would
  // otherwise only be caught by the owner.
  const answer = buildDeterministicAnswer("BUSINESS_BRIEFING", BRIEFING_FACTS, { label: "Today" });
  assert.equal(
    assertGroundedAnswer({ answer, facts: BRIEFING_FACTS, allowedText: "Today 20", generated: true }),
    true,
    answer,
  );
});
