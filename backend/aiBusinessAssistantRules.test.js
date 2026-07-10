const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calculateOverdueDays,
  classifyDueStatus,
  classifyCustomerRisk,
  forecastStockRunout,
  buildReminderDedupKey,
  assertGroundedAnswer,
} = require("./aiBusinessAssistantRules");

test("calculates overdue days from due date only", () => {
  assert.equal(calculateOverdueDays("2026-07-01", "2026-07-10"), 9);
  assert.equal(calculateOverdueDays("2026-07-10", "2026-07-10"), 0);
  assert.equal(calculateOverdueDays("2026-07-12", "2026-07-10"), 0);
});

test("handles invoices with no due date without inventing overdue days", () => {
  assert.equal(calculateOverdueDays(null, "2026-07-10"), null);
  assert.equal(classifyDueStatus(null, "2026-07-10"), "NO_DUE_DATE");
});

test("classifies customer risk after partial payments leave outstanding balance", () => {
  assert.equal(classifyCustomerRisk({ overdueDays: 22, outstanding: 1000 }), "HIGH");
  assert.equal(classifyCustomerRisk({ overdueDays: 0, outstanding: 0 }), "NONE");
});

test("credit notes or returns that clear balance remove risk", () => {
  assert.equal(classifyCustomerRisk({ overdueDays: 60, outstanding: -250 }), "NONE");
});

test("stock prediction refuses insufficient sales history", () => {
  assert.deepEqual(forecastStockRunout({ availableStock: 20, dailySales: [{ quantity: 5 }] }), {
    status: "INSUFFICIENT_SALES_HISTORY",
    daysRemaining: null,
    averageDailySold: null,
  });
});

test("stock prediction uses deterministic moving average", () => {
  assert.deepEqual(forecastStockRunout({
    availableStock: 30,
    dailySales: [{ quantity: 5 }, { quantity: 10 }, { quantity: 15 }],
  }), {
    status: "FORECAST_READY",
    daysRemaining: 3,
    averageDailySold: 10,
  });
});

test("reminder dedup key is stable per linked item and due date", () => {
  const first = buildReminderDedupKey({ reminderType: "LOW_STOCK", entityType: "product", entityId: 7, dueDate: "2026-07-10" });
  const second = buildReminderDedupKey({ reminderType: "LOW_STOCK", entityType: "product", entityId: 7, dueDate: "2026-07-10" });
  assert.equal(first, second);
});

test("AI answer grounding rejects unsupported money amounts", () => {
  assert.equal(assertGroundedAnswer({ answer: "Outstanding is ₹1,250.00", facts: [{ amount: 1250 }] }), true);
  assert.equal(assertGroundedAnswer({ answer: "Outstanding is ₹9,999.00", facts: [{ amount: 1250 }] }), false);
});
