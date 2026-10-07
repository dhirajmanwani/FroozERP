import assert from "node:assert/strict";
import test from "node:test";
import { LOCAL_UNCOMPUTED_METRICS, buildLocalDashboardSnapshot } from "./dashboardSnapshot.js";

test("hybrid dashboard projects preserved SQLite inventory and POS data", () => {
  const result = buildLocalDashboardSnapshot({
    today: "2026-07-15",
    inventoryLots: [{ id: "lot-1", product_id: "p1", product_name: "Apple", remaining_qty: 10, purchase_rate: 40 }],
    sales: [{ sale_date: "2026-07-15", total_amount: 120, items: [{ product_id: "p1", product_name: "Apple", lot_id: "lot-1", quantity: 2, amount: 120 }] }],
  });
  assert.equal(result.metrics.todaySales, 120);
  assert.equal(result.metrics.stockValue, 400);
  assert.equal(result.metrics.todayProfit, 40);
  assert.equal(result.metrics.transactions, 1);
  assert.equal(result.analytics.topSellingProducts[0].product_name, "Apple");
});

test("cancelled local invoices do not inflate dashboard totals", () => {
  const result = buildLocalDashboardSnapshot({
    today: "2026-07-15",
    sales: [{ sale_date: "2026-07-15", total_amount: 999, sale_status: "CANCELLED" }],
  });
  assert.equal(result.metrics.todaySales, 0);
  assert.equal(result.metrics.transactions, 0);
});

test("figures the local layer never computes are null, not zero", () => {
  const result = buildLocalDashboardSnapshot({ today: "2026-07-15" });
  assert.ok(LOCAL_UNCOMPUTED_METRICS.length >= 10);
  for (const key of LOCAL_UNCOMPUTED_METRICS) {
    assert.equal(result.metrics[key], null, `${key} must read as unknown, not as none`);
  }
  // The computed figures and the stock caveat are still there.
  assert.equal(result.metrics.todaySales, 0);
  assert.equal(result.metrics.stockValueNote, "");
});

test("a sale from a provisional lot is left out of profit and says so", () => {
  const result = buildLocalDashboardSnapshot({
    today: "2026-07-15",
    inventoryLots: [
      { id: "priced", product_id: "p1", remaining_qty: 10, purchase_rate: 40, purchase_bill_status: "BILL_COMPLETED" },
      { id: "pending", product_id: "p2", remaining_qty: 10, purchase_rate: 0, purchase_bill_status: "BILL_PENDING" },
    ],
    sales: [{
      sale_date: "2026-07-15",
      total_amount: 220,
      items: [
        { product_id: "p1", lot_id: "priced", quantity: 2, amount: 120 },
        { product_id: "p2", lot_id: "pending", quantity: 1.5, amount: 100 },
      ],
    }],
  });
  assert.equal(result.metrics.todayProfit, 40, "only the priced line counts; not 140 at a fake 100% margin");
  assert.match(result.metrics.profitNote, /1\.500 units on 1 sale line/);
  assert.match(result.analytics.profitNote, /awaiting a supplier bill/);
  assert.equal(result.metrics.todaySales, 220, "the money taken is still all counted");
});

test("a sale from a lot this device does not hold is not booked at zero cost", () => {
  const result = buildLocalDashboardSnapshot({
    today: "2026-07-15",
    sales: [{ sale_date: "2026-07-15", total_amount: 50, items: [{ lot_id: "gone", quantity: 1, amount: 50 }] }],
  });
  assert.equal(result.metrics.todayProfit, 0);
  assert.notEqual(result.metrics.profitNote, "");
});

test("profit with nothing left out carries no note", () => {
  const result = buildLocalDashboardSnapshot({
    today: "2026-07-15",
    inventoryLots: [{ id: "4", product_id: "p1", remaining_qty: 10, purchase_rate: 40 }],
    sales: [{ sale_date: "2026-07-15", total_amount: 60, items: [{ lot_id: 4, quantity: 1, amount: 60 }] }],
  });
  assert.equal(result.metrics.todayProfit, 20, "lot ids are matched canonically");
  assert.equal(result.metrics.profitNote, "");
});

test("cancelled and inactive lots are neither valued nor reported as low stock", () => {
  const result = buildLocalDashboardSnapshot({
    today: "2026-07-15",
    inventoryLots: [
      { id: "a", product_id: "p1", remaining_qty: 100, purchase_rate: 10, batch_status: "ACTIVE" },
      { id: "b", product_id: "p2", remaining_qty: 1, purchase_rate: 999, batch_status: "CANCELLED" },
      { id: "c", product_id: "p3", remaining_qty: 2, purchase_rate: 999, batch_status: "inactive" },
    ],
  });
  assert.equal(result.metrics.stockValue, 1000);
  assert.equal(result.metrics.lowStockItems, 0);
});

test("a preset range ends today even when an old custom range is still set", () => {
  const result = buildLocalDashboardSnapshot({
    today: "2026-07-15",
    range: "7",
    customRange: { date_from: "2026-01-01", date_to: "2026-01-31" },
  });
  assert.equal(result.analytics.dateTo, "2026-07-15");
  assert.equal(result.analytics.dateFrom, "2026-07-09");
  const custom = buildLocalDashboardSnapshot({
    today: "2026-07-15",
    range: "custom",
    customRange: { date_from: "2026-01-01", date_to: "2026-01-31" },
  });
  assert.equal(custom.analytics.dateFrom, "2026-01-01");
  assert.equal(custom.analytics.dateTo, "2026-01-31");
});

test("today's profit is today's, whatever range is selected", () => {
  const result = buildLocalDashboardSnapshot({
    today: "2026-07-15",
    range: "custom",
    customRange: { date_from: "2026-01-01", date_to: "2026-01-31" },
    inventoryLots: [{ id: "lot-1", product_id: "p1", remaining_qty: 10, purchase_rate: 40 }],
    sales: [{ sale_date: "2026-07-15", total_amount: 120, items: [{ product_id: "p1", lot_id: "lot-1", quantity: 2, amount: 120 }] }],
  });
  assert.equal(result.metrics.todayProfit, 40);
  assert.equal(result.analytics.salesTrend.length, 0, "the range itself still excludes today");
});

test("low-stock threshold: lot, then product, then 5 — and a real 0 is kept", () => {
  const lots = [
    { id: "1", product_id: "p1", remaining_qty: 3, minimum_stock: 0 },
    { id: "2", product_id: "p2", remaining_qty: 3 },
    { id: "3", product_id: "p3", remaining_qty: 3, minimum_stock: null },
  ];
  const result = buildLocalDashboardSnapshot({
    today: "2026-07-15",
    inventoryLots: lots,
    products: [{ id: "p2", minimum_stock: 2 }, { id: "p3", minimum_stock: null }],
  });
  const flagged = result.analytics.lowStockItems.map((row) => row.product_id);
  assert.deepEqual(flagged, ["p3"], "p1 (min 0) and p2 (product min 2) are fine; p3 falls back to 5");
  assert.equal(result.analytics.lowStockItems[0].minimum_stock, 5);
});
