import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { LOCAL_UNCOMPUTED_METRICS } from "./dashboardSnapshot.js";
import {
  UNKNOWN_FIGURE,
  briefingCardFigure,
  customerDueCard,
  formatKnownFigure,
  insightCardValue,
  pickDashboardMetric,
  unavailableBriefingNote,
} from "./figurePresentation.js";

test("null is unknown and stops the search; undefined asks the next source", () => {
  assert.equal(pickDashboardMetric(null, 500), null, "a stale cloud figure must not paper over the local null");
  assert.equal(pickDashboardMetric(undefined, 500), 500);
  assert.equal(pickDashboardMetric(0, 500), 0, "zero is a real answer");
  assert.equal(pickDashboardMetric(undefined, undefined), null);
  assert.equal(pickDashboardMetric("abc", "12.5"), 12.5);
});

test("an unknown figure prints as a dash, never ₹0", () => {
  assert.equal(formatKnownFigure(null), UNKNOWN_FIGURE);
  assert.equal(formatKnownFigure(undefined), UNKNOWN_FIGURE);
  assert.equal(formatKnownFigure(0, (number) => `₹${number.toFixed(2)}`), "₹0.00");
});

test("the dashboard renders every metric the local layer leaves null through the unknown path", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("const kpis = useMemo(");
  const end = app.indexOf("}, [dashboardAnalytics, dashboardCloudFill, dashboardError, supplierDashboard]);", start);
  assert.ok(start > 0 && end > start, "could not find the kpis memo");
  const body = app.slice(start, end);
  for (const key of ["todaySales", "todayProfit", "stockValue", "lowStockItems", "transactions"]) {
    assert.match(body, new RegExp(`${key}: pickDashboardMetric\\(supplierDashboard\\.${key}\\)`), `${key} has no zero fallback`);
  }
  assert.doesNotMatch(body, /salesHistory|inventory\./, "headline tiles are not recomputed from whatever is in memory");
  assert.match(body, /unknownMetricNote\(\{ fill: dashboardCloudFill, loadFailed: Boolean\(dashboardError\) \}\)/);
  for (const key of LOCAL_UNCOMPUTED_METRICS) {
    assert.match(body, new RegExp(`${key}: pickDashboardMetric\\(`), `${key} must keep null`);
    assert.doesNotMatch(body, new RegExp(`Number\\(metrics\\.${key} \\|\\| 0\\)`), `${key} must not be Number(x || 0)`);
  }
  assert.match(body, /supplierDashboard\.stockValueNote/, "the provisional-stock note is shown under Stock Value");
  assert.match(body, /supplierDashboard\.profitNote/);
});

test("a FROST card marked unavailable has no figures", () => {
  const cards = {
    sales: { totalSales: 1200, unavailable: false },
    waste: { totalWasteCost: null, unavailable: true, error: "boom" },
    customerOutstanding: { totalOutstanding: 900 },
  };
  assert.equal(briefingCardFigure(cards, "sales", "totalSales"), 1200);
  assert.equal(briefingCardFigure(cards, "waste", "totalWasteCost"), null);
  assert.equal(briefingCardFigure(cards, "lowStock", "count"), null);
  assert.deepEqual(customerDueCard(cards), { label: "Customer Outstanding", value: 900 },
    "the card carries total outstanding, so it is not labelled overdue");
  assert.equal(customerDueCard({ customerOutstanding: { totalOutstanding: 900, totalOverdue: 300 } }).label, "Customer Overdue");
  assert.match(unavailableBriefingNote(cards), /waste/);
  assert.equal(unavailableBriefingNote({ sales: {} }), "");
});

test("a FROST insight tile with no figure prints a dash and says it is unavailable", () => {
  const money = (number) => `₹${number.toFixed(2)}`;
  assert.deepEqual(insightCardValue(1200, money), { text: "₹1200.00", unavailable: false });
  assert.deepEqual(insightCardValue(0, money), { text: "₹0.00", unavailable: false }, "zero is a figure");
  assert.deepEqual(insightCardValue("3 lots", money), { text: "3 lots", unavailable: false });
  for (const missing of [null, undefined, "", "  ", Number.NaN, Infinity]) {
    assert.deepEqual(insightCardValue(missing, money), { text: UNKNOWN_FIGURE, unavailable: true }, String(missing));
  }
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /<p>\{insightCardValue\(card\.value, money\)\.text\}<\/p>/);
  assert.match(app, /insightCardValue\(card\.value, money\)\.unavailable && <small className="cell-note">Unavailable just now<\/small>/);
});
