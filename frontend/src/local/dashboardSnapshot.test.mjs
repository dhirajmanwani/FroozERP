import assert from "node:assert/strict";
import test from "node:test";
import { buildLocalDashboardSnapshot } from "./dashboardSnapshot.js";

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
