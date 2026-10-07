import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DASHBOARD_FILL,
  NULL_DASHBOARD_METRICS,
  fillUncomputedMetrics,
  shouldFetchCloudDashboardMetrics,
  unknownMetricNote,
} from "./dashboardCloudFill.js";
import { LOCAL_UNCOMPUTED_METRICS, localSalesWindow } from "./dashboardSnapshot.js";
import { listLocalPosSalesBetween } from "./localDatabase.js";

const APP = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

test("before a load, and after one that failed, every figure is unknown -- not zero", () => {
  for (const key of ["todaySales", "todayProfit", "stockValue", "lowStockItems", "transactions", ...LOCAL_UNCOMPUTED_METRICS]) {
    assert.ok(Object.hasOwn(NULL_DASHBOARD_METRICS, key), key);
    assert.equal(NULL_DASHBOARD_METRICS[key], null, key);
  }
  assert.ok(Object.isFrozen(NULL_DASHBOARD_METRICS));
});

test("the server is asked only when the cloud can be reached, and never in Local Only", () => {
  assert.equal(shouldFetchCloudDashboardMetrics({}), true, "unknown reachability still tries");
  assert.equal(shouldFetchCloudDashboardMetrics({ cloudOnline: true, internetAvailable: true }), true);
  assert.equal(shouldFetchCloudDashboardMetrics({ localOnly: true, cloudOnline: true, internetAvailable: true }), false);
  assert.equal(shouldFetchCloudDashboardMetrics({ offlineMode: true, cloudOnline: true }), false);
  assert.equal(shouldFetchCloudDashboardMetrics({ cloudOnline: false }), false);
  assert.equal(shouldFetchCloudDashboardMetrics({ internetAvailable: false }), false);
});

test("the server fills only the tiles still null, and never overwrites a local figure", () => {
  const local = {
    ...NULL_DASHBOARD_METRICS,
    todaySales: 1500,
    todayProfit: 0,
    stockValue: 9000,
    todayExpenses: 0,
  };
  const server = {
    todaySales: 99999,
    todayProfit: 88888,
    stockValue: 1,
    customerOutstanding: "2500.50",
    todayExpenses: 700,
    total_supplier_outstanding: 4200,
    total_rebate_received: 0,
    todays_supplier_payments: 300,
    todayReturns: null,
    monthlyReturns: "",
    todayWaste: true,
    monthlyWaste: "abc",
    wastePercentage: 1.25,
  };
  const filled = fillUncomputedMetrics(local, server);
  assert.equal(filled.todaySales, 1500, "local sales are not replaced");
  assert.equal(filled.todayProfit, 0, "a local zero is a figure, not a gap");
  assert.equal(filled.stockValue, 9000);
  assert.equal(filled.todayExpenses, 0, "a local zero is kept even for an uncomputed key");
  assert.equal(filled.customerOutstanding, 2500.5);
  assert.equal(filled.supplierOutstanding, 4200, "read under the server's other spelling");
  assert.equal(filled.totalRebateReceived, 0, "a server zero fills the tile");
  assert.equal(filled.todaySupplierPayments, 300);
  assert.equal(filled.wastePercentage, 1.25);
  for (const key of ["todayReturns", "monthlyReturns", "todayWaste", "monthlyWaste"]) {
    assert.equal(filled[key], null, `${key}: no usable number from the server stays unknown`);
  }
  assert.notEqual(filled, local, "the input is not mutated");
  assert.equal(local.customerOutstanding, null);
  assert.deepEqual(fillUncomputedMetrics(local, null), { ...local });
});

test("an unknown tile says which unknown it is", () => {
  assert.equal(unknownMetricNote({ fill: DASHBOARD_FILL.OFFLINE }), "Not available offline");
  assert.equal(unknownMetricNote({ fill: DASHBOARD_FILL.FAILED }), "Could not load");
  assert.equal(unknownMetricNote({ fill: DASHBOARD_FILL.LOADED }), "Could not load", "online, and the server did not say");
  assert.equal(unknownMetricNote({ fill: DASHBOARD_FILL.OFFLINE, loadFailed: true }), "Could not load");
  assert.equal(unknownMetricNote({ fill: DASHBOARD_FILL.IDLE }), "");
  assert.equal(unknownMetricNote(), "");
});

test("the local sales window covers the chosen range and today, never inverted", () => {
  assert.deepEqual(localSalesWindow({ range: "7", today: "2026-10-07" }), { fromDate: "2026-10-01", toDate: "2026-10-07" });
  assert.deepEqual(localSalesWindow({ range: "30", today: "2026-10-07" }), { fromDate: "2026-09-08", toDate: "2026-10-07" });
  // A custom range in the past still reaches today, because the Today tiles read from it.
  assert.deepEqual(
    localSalesWindow({ range: "custom", customRange: { date_from: "2026-08-01", date_to: "2026-08-31" }, today: "2026-10-07" }),
    { fromDate: "2026-08-01", toDate: "2026-10-07" },
  );
  // Back to front custom input never produces a from after to.
  const odd = localSalesWindow({ range: "custom", customRange: { date_from: "2026-10-20", date_to: "2026-10-01" }, today: "2026-10-07" });
  assert.ok(odd.fromDate <= odd.toDate);
  assert.ok(odd.fromDate <= "2026-10-07" && odd.toDate >= "2026-10-07");
});

test("bad dates for the local sales range are refused in words before anything is asked", async () => {
  await assert.rejects(listLocalPosSalesBetween("", "2026-10-07"), /whole dates/);
  await assert.rejects(listLocalPosSalesBetween("07/10/2026", "2026-10-07"), /whole dates/);
  await assert.rejects(listLocalPosSalesBetween("2026-10-08", "2026-10-07"), /starts \(2026-10-08\) after it ends \(2026-10-07\)/);
  // Outside the desktop shell there is no local database: an empty list, not an error.
  assert.deepEqual(await listLocalPosSalesBetween("2026-10-01", "2026-10-07"), []);
});

test("the range read goes to pos_sale_list_local_range with fromDate and toDate", async () => {
  const calls = [];
  const previous = globalThis.window;
  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: async (command, args) => {
        calls.push({ command, args });
        return [{ id: "a" }];
      },
      transformCallback: () => 0,
    },
  };
  try {
    const rows = await listLocalPosSalesBetween("2026-10-01T10:00:00Z", "2026-10-07");
    assert.deepEqual(rows, [{ id: "a" }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "pos_sale_list_local_range");
    assert.deepEqual(calls[0].args, { fromDate: "2026-10-01", toDate: "2026-10-07" });
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});

test("the desktop dashboard reads its window, fails loudly, and fills from the cloud only when allowed", () => {
  const start = APP.indexOf("const loadDashboardAnalytics = async");
  const loader = APP.slice(start, APP.indexOf("const loadDashboardData = async", start));
  assert.ok(start > 0 && loader.length > 200);
  assert.match(loader, /listLocalPosSalesBetween\(fromDate, toDate\)/);
  assert.doesNotMatch(loader, /listLocalPosSales\(\)/, "not the newest 200");
  assert.match(loader, /setSupplierDashboard\(NULL_DASHBOARD_METRICS\)/);
  assert.match(loader, /setDashboardError\(`The dashboard could not be read from this computer/);
  const gate = loader.indexOf("shouldFetchCloudDashboardMetrics({");
  const fetchAt = loader.indexOf("/dashboard-metrics");
  assert.ok(gate > 0 && fetchAt > gate, "the cloud read sits behind the gate");
  assert.match(loader.slice(gate, fetchAt), /localOnly: isLocalOnlyConnectivitySelected\(\)/);
  assert.match(loader, /setDashboardCloudFill\(DASHBOARD_FILL\.OFFLINE\)/);
  assert.match(loader, /setDashboardCloudFill\(DASHBOARD_FILL\.FAILED\)/);
  assert.match(loader, /fillUncomputedMetrics\(localDashboard\.metrics, response\.data \|\| \{\}\)/);
  assert.match(APP, /const \[supplierDashboard, setSupplierDashboard\] = useState\(NULL_DASHBOARD_METRICS\)/);
});

test("a metric the server could not work out arrives as null and reads Could not load, not 0", () => {
  const allNull = Object.fromEntries(LOCAL_UNCOMPUTED_METRICS.map((key) => [key, null]));
  const filled = fillUncomputedMetrics(NULL_DASHBOARD_METRICS, {
    ...allNull,
    total_supplier_outstanding: null,
    total_rebate_received: null,
    todays_supplier_payments: null,
  });
  for (const key of LOCAL_UNCOMPUTED_METRICS) assert.equal(filled[key], null, `${key} stays unknown`);
  assert.equal(unknownMetricNote({ fill: DASHBOARD_FILL.LOADED }), "Could not load");
  // The browser dashboard reads the server directly; it marks the fill too, so its nulls say so.
  const loader = APP.slice(APP.indexOf("const loadDashboardData = async"), APP.indexOf("const changeDashboardRange = async"));
  assert.match(loader, /setDashboardCloudFill\(metricsResult\.status === "fulfilled" \? DASHBOARD_FILL\.LOADED : DASHBOARD_FILL\.FAILED\)/);
  const analytics = APP.slice(APP.indexOf("const loadDashboardAnalytics = async"), APP.indexOf("const loadDashboardData = async"));
  const browserPart = analytics.slice(analytics.indexOf("/dashboard-analytics"));
  assert.match(browserPart, /setDashboardCloudFill\(DASHBOARD_FILL\.LOADED\)/);
});
