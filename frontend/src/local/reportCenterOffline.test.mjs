import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  OFFLINE_REPORT_NOTE,
  buildLocalOnlyReportsData,
  reportFlagsAfterServerLoad,
  resolveReportAvailability,
  shouldReloadReportsOnReconnect,
} from "./reportCenterOffline.js";

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
  assert.match(app, /\.\.\.reportFlagsAfterServerLoad\(current, \{\n\s+summaryFailed,/);
  assert.match(app, /const reportAvailability = resolveReportAvailability\(selectedReport, data/);
});

test("back online, the offline flag goes even when the first summary request fails", () => {
  const offline = buildLocalOnlyReportsData(cloudState, {});
  const failed = { ...offline, ...reportFlagsAfterServerLoad(offline, { summaryFailed: true, summaryError: "502 Bad Gateway" }) };
  assert.equal(failed.offlineUnavailable, false);
  assert.equal(failed.serverReportsError, "502 Bad Gateway");
  // The blanked server reports now say the load failed, not "offline" and not "no records".
  const availability = resolveReportAvailability("profitLoss", failed);
  assert.equal(availability.available, false);
  assert.notEqual(availability.message, OFFLINE_REPORT_NOTE);
  assert.match(availability.message, /502 Bad Gateway/);
  // Local reports are unaffected by the server's failure.
  assert.equal(resolveReportAvailability("stockInventory", failed).available, true);

  const noMessage = reportFlagsAfterServerLoad(offline, { summaryFailed: true });
  assert.equal(noMessage.serverReportsError, "no answer from the server");

  // A retry that succeeds clears the error.
  assert.deepEqual(reportFlagsAfterServerLoad(failed, { summaryFailed: false }), { offlineUnavailable: false, serverReportsError: "" });
  // A failed summary over real cloud figures keeps them and raises nothing new.
  assert.deepEqual(reportFlagsAfterServerLoad(cloudState, { summaryFailed: true, summaryError: "x" }), { offlineUnavailable: false, serverReportsError: "" });
  // Going offline again resets the server error: offline says offline.
  assert.equal(buildLocalOnlyReportsData(failed, {}).serverReportsError, "");
});

test("a reconnect reloads Report Center only while it still shows the offline blanks", () => {
  assert.equal(shouldReloadReportsOnReconnect({ offlineUnavailable: true, online: true }), true);
  assert.equal(shouldReloadReportsOnReconnect({ offlineUnavailable: true, online: false }), false);
  assert.equal(shouldReloadReportsOnReconnect({ offlineUnavailable: false, online: true }), false);
  assert.equal(shouldReloadReportsOnReconnect({ offlineUnavailable: "true", online: true }), false);
  assert.equal(shouldReloadReportsOnReconnect(), false);

  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const effect = app.slice(app.indexOf("const reportsConnectivityOnline ="), app.indexOf("const loadExpenses = async"));
  assert.match(effect, /!offlineMode/);
  assert.match(effect, /!isLocalOnlyConnectivitySelected\(\)/, "Local Only never counts as online");
  assert.match(effect, /shouldReloadReportsOnReconnect\(\{ offlineUnavailable: reportsData\.offlineUnavailable === true, online: reportsConnectivityOnline \}\)/);
  assert.match(effect, /loadReports\(\)\.catch\(/);
});

test("offline Sales History reads every bill in the period, not the newest 200", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const local = app.slice(app.indexOf("if (tauriRuntime && (offlineMode || readConnectivityMode() === CONNECTIVITY_MODES.LOCAL_ONLY))"), app.indexOf("const reportRequests = ["));
  assert.match(local, /localRows = await listLocalPosSalesBetween\(normalizedParams\.date_from, normalizedParams\.date_to\);/);
  assert.doesNotMatch(local, /listLocalPosSales\(\)/);
});
