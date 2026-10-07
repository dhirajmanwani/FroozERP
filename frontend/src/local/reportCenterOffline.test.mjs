import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { OFFLINE_REPORT_NOTE, buildLocalOnlyReportsData, resolveReportAvailability } from "./reportCenterOffline.js";

const cloudState = {
  salesReport: [{ total_sales: 9000 }],
  purchaseReport: [{ id: 1 }],
  paymentReport: [{ payment_amount: 50 }],
  profitLoss: { net_profit: 1234 },
  balanceSheet: { assets: 1 },
  cashBookReport: { rows: [{}], opening_cash: 100 },
  salesHistoryReport: [{ id: "old" }],
  stockReport: [],
  stockLotReport: [],
  inventoryLoadState: "idle",
  dateFrom: "2026-09-01",
  dateTo: "2026-09-01",
};

test("a local-only load keeps no cloud figure under the new period", () => {
  const next = buildLocalOnlyReportsData(cloudState, {
    salesRows: [{ id: "local-1" }],
    stockReport: [{ product_id: "p" }],
    stockLotReport: [{ id: "l" }],
    dateFrom: "2026-10-07",
    dateTo: "2026-10-07",
  });
  assert.deepEqual(next.salesReport, []);
  assert.deepEqual(next.purchaseReport, []);
  assert.deepEqual(next.paymentReport, []);
  assert.deepEqual(next.profitLoss, {});
  assert.deepEqual(next.balanceSheet, {});
  assert.deepEqual(next.cashBookReport, {});
  assert.deepEqual(next.salesHistoryReport, [{ id: "local-1" }]);
  assert.deepEqual(next.stockReport, [{ product_id: "p" }]);
  assert.equal(next.offlineUnavailable, true);
  assert.equal(next.dateFrom, "2026-10-07");
});

test("a failed local sales read is an error on Sales History, not an empty day", () => {
  const next = buildLocalOnlyReportsData(cloudState, { salesError: "database is locked" });
  assert.deepEqual(next.salesHistoryReport, []);
  const availability = resolveReportAvailability("salesHistory", next);
  assert.equal(availability.available, false);
  assert.equal(availability.tone, "error");
  assert.match(availability.message, /database is locked/);
});

test("offline, server-computed reports say so; local ones and order reports do not", () => {
  const offline = buildLocalOnlyReportsData(cloudState, {});
  for (const id of ["profitLoss", "cashBook", "paymentReport", "salesByDate", "balanceSheet"]) {
    const availability = resolveReportAvailability(id, offline);
    assert.equal(availability.available, false, id);
    assert.equal(availability.message, OFFLINE_REPORT_NOTE);
  }
  for (const id of ["salesHistory", "stockInventory", "lotWiseStock"]) {
    assert.equal(resolveReportAvailability(id, offline).available, true, id);
  }
  assert.equal(resolveReportAvailability("ordersByDate", offline, { selfContained: ["ordersByDate"] }).available, true);
  assert.equal(resolveReportAvailability("profitLoss", { offlineUnavailable: false }).available, true);
});

test("App uses the builder offline and clears the flag when the server answers", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /\.\.\.buildLocalOnlyReportsData\(current, \{/);
  assert.doesNotMatch(app, /listLocalPosSales\(\)\.catch\(\(\) => \[\]\)/);
  assert.match(app, /offlineUnavailable: false/);
  assert.match(app, /const reportAvailability = resolveReportAvailability\(selectedReport, data/);
});
