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

test("AI answer grounding catches a bare number, which is the shape FROST actually emits", () => {
  // The regression. The guard matched only /(?:₹|Rs\.?|INR)\s*\d.../ while `buildDeterministicAnswer`
  // writes "sales 48250, estimated gross profit 9110" with no symbol. The match array came back
  // empty on every real answer, `[].every()` is `true`, and the check could not fail. It was not a
  // weak guard, it was an absent one wearing a guard's name.
  const facts = [{ summary: { totalSales: 48250, estimatedGrossProfit: 9110 } }];
  assert.equal(
    assertGroundedAnswer({ answer: "sales 48250, estimated gross profit 9110", facts }),
    true,
  );
  assert.equal(
    assertGroundedAnswer({ answer: "sales 48250, estimated gross profit 22000", facts }),
    false,
    "an invented bare figure must be caught, not waved through for lacking a rupee sign",
  );
});

test("a deterministic answer is grounded by construction and is not policed", () => {
  // We build that text out of the facts ourselves, so checking it only produces false alarms over
  // our own formatting. The flag exists so the check bites exactly where a model wrote the words.
  assert.equal(
    assertGroundedAnswer({ answer: "totals 1 through 9 with no fact behind them", facts: [], generated: false }),
    true,
  );
  assert.equal(
    assertGroundedAnswer({ answer: "totals 1 through 9 with no fact behind them", facts: [] }),
    false,
    "the default must be the strict check, so a caller that forgets to say is not silently trusted",
  );
});

test("the period label we inserted ourselves is not read as an invented figure", () => {
  // "Period: 01/09/2026 to 20/09/2026." is our own text. Without allowedText every answer would
  // fail on its own date range, and a guard that always fails gets turned off.
  const facts = [{ summary: { totalSales: 500 } }];
  assert.equal(
    assertGroundedAnswer({
      answer: "Period: 01/09/2026 to 20/09/2026. sales 500",
      facts,
      allowedText: "01/09/2026 to 20/09/2026",
    }),
    true,
  );
  assert.equal(
    assertGroundedAnswer({
      answer: "Period: 01/09/2026 to 20/09/2026. sales 700",
      facts,
      allowedText: "01/09/2026 to 20/09/2026",
    }),
    false,
    "allowing our own label must not also allow a figure that is not in the facts",
  );
});
