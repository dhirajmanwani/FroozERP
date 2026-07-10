const test = require("node:test");
const assert = require("node:assert/strict");
const {
  containsSensitiveMemory,
  normalizeMemoryType,
  stockOutPrediction,
  salesRangePrediction,
  grossMarginPercent,
  wasteAdjustedMargin,
  isInactiveCustomer,
  supplierCostIncrease,
  dedupeAlertKey,
} = require("./frostIntelligence");

test("memory rejects sensitive secrets", () => {
  assert.equal(containsSensitiveMemory("API key is sk-test"), true);
  assert.equal(containsSensitiveMemory("Raj Traders is VIP"), false);
  assert.equal(normalizeMemoryType("customer_notes"), "customer_notes");
});

test("stock prediction returns insufficient data instead of guessing", () => {
  const result = stockOutPrediction({ availableStock: 20, dailySales: [{ quantity: 5 }] });
  assert.equal(result.status, "INSUFFICIENT_DATA");
});

test("stock-out calculation uses recent weighted average", () => {
  const result = stockOutPrediction({ availableStock: 60, dailySales: [{ quantity: 10 }, { quantity: 10 }, { quantity: 20 }] });
  assert.equal(result.status, "READY");
  assert.equal(result.daysUntilStockOut, 4);
});

test("partial sales history protects sales prediction", () => {
  assert.equal(salesRangePrediction({ dailySales: [{ amount: 100 }], minimumDataDays: 3 }).status, "INSUFFICIENT_DATA");
});

test("seasonal comparison range is conservative", () => {
  const result = salesRangePrediction({ dailySales: [{ amount: 100 }, { amount: 120 }, { amount: 140 }], minimumDataDays: 3 });
  assert.equal(result.status, "READY");
  assert.ok(result.expectedRange.high > result.expectedRange.low);
});

test("margin and waste adjusted margin calculations are grounded", () => {
  assert.equal(grossMarginPercent({ sellingRate: 100, purchaseCost: 70 }), 30);
  assert.equal(wasteAdjustedMargin({ saleAmount: 1000, costAmount: 700, wasteCost: 100 }), 20);
});

test("customer inactivity and supplier cost increase are deterministic", () => {
  assert.equal(isInactiveCustomer({ lastPurchaseDate: "2026-06-01", asOf: "2026-07-10", inactiveDays: 30 }), true);
  assert.equal(supplierCostIncrease({ previousCost: 100, currentCost: 115 }).status, "INCREASE_DETECTED");
});

test("duplicate alert keys are stable", () => {
  const a = dedupeAlertKey({ rule: "LOW_STOCK", entityType: "product", entityId: 5 });
  const b = dedupeAlertKey({ rule: "LOW_STOCK", entityType: "product", entityId: 5 });
  assert.equal(a, b);
});
