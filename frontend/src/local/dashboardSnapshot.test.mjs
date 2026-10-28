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

test("low stock is Products' rule: stored minimum, no default, stock starts from products (UI-3)", async () => {
  const { isLowStock } = await import("./productMaster.js");
  const products = [
    { id: "p1", product_name: "Apple", minimum_stock: 0 },
    { id: "p2", product_name: "Banana", minimum_stock: 2 },
    { id: "p3", product_name: "Cherry", minimum_stock: null },
    { id: "p4", product_name: "Dates", minimum_stock: 5 },
    { id: "p5", product_name: "Fig", minimum_stock: 1 },
    { id: "p6", product_name: "Old Grape", minimum_stock: 9, active: false },
  ];
  const lots = [
    { id: "1", product_id: "p1", remaining_qty: 3, minimum_stock: 0 },
    { id: "2", product_id: "p2", remaining_qty: 3 },
    // A lot's own copy of the minimum does not override the product's (none set: not low).
    { id: "3", product_id: "p3", remaining_qty: 3, minimum_stock: 5 },
    { id: "4", product_id: "p4", remaining_qty: 2 },
    { id: "4b", product_id: "p4", remaining_qty: 2 },
    { id: "6", product_id: "p6", remaining_qty: 1 },
  ];
  const result = buildLocalDashboardSnapshot({ today: "2026-07-15", inventoryLots: lots, products });
  const flagged = result.analytics.lowStockItems.map((row) => row.product_id).sort();
  assert.deepEqual(flagged, ["p4", "p5"], "p4 holds 4 of 5; p5 has no lot at all and is 0 of 1");
  assert.equal(result.metrics.lowStockItems, 2, "the tile counts the same list");
  const fig = result.analytics.lowStockItems.find((row) => row.product_id === "p5");
  assert.equal(fig.current_stock, 0);
  assert.equal(fig.product_name, "Fig");
  // Same verdict as Products for every active product.
  const stockOf = (id) => lots.filter((lot) => lot.product_id === id).reduce((sum, lot) => sum + lot.remaining_qty, 0);
  for (const product of products.filter((row) => row.active !== false)) {
    assert.equal(flagged.includes(product.id), isLowStock({ ...product, current_stock: stockOf(product.id) }), product.id);
  }
});

test("a lot for a product not in the list uses the lot's minimum, and none means not low", () => {
  const result = buildLocalDashboardSnapshot({
    today: "2026-07-15",
    inventoryLots: [
      { id: "1", product_id: "x1", remaining_qty: 1, minimum_stock: 2 },
      { id: "2", product_id: "x2", remaining_qty: 1 },
    ],
  });
  assert.deepEqual(result.analytics.lowStockItems.map((row) => row.product_id), ["x1"]);
});
