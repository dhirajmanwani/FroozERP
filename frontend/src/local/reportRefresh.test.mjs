// Two of the assertions below are about the *India* calendar boundary, and `filterRowsForReportRange`
// classifies a timestamp by the host's local timezone. That made them pass on the maintainer's
// machine and fail on every UTC one, including the container the production gate runs in — a test
// whose result depends on where it is run tells you nothing about the code. Pinned so the tests
// state the timezone they are actually about.
//
// Worth noting what this does NOT fix: the product still reads the device's timezone, so a terminal
// set to the wrong zone files a 1am sale under the previous day. That is a real question about
// whether report boundaries should be fixed to India or follow the device, and it is the
// maintainer's to answer — not something to change quietly inside a test fix.
process.env.TZ = "Asia/Kolkata";

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildReportRefreshParams, filterRowsForReportRange, formatIndianReportDate, resolveReportDateRange } from "./reportRefresh.js";

test("custom report dates remain canonical and reject reversed ranges", () => {
  assert.deepEqual(resolveReportDateRange({ range: "custom", date_from: "2026-07-01", date_to: "2026-07-21" }), { range: "custom", date_from: "2026-07-01", date_to: "2026-07-21" });
  assert.throws(() => resolveReportDateRange({ range: "custom", date_from: "2026-07-22", date_to: "2026-07-21" }), /cannot be after/);
  assert.equal(formatIndianReportDate("2026-07-21"), "21/07/2026");
});

test("refresh captures latest search and active report filters on every call", () => {
  const input = { range: "custom", customRange: { date_from: "2026-07-01", date_to: "2026-07-21" }, search: "invoice 42", selectedReport: "salesHistory", salesFilters: { status: "ACTIVE", paymentMode: "UPI" } };
  const first = buildReportRefreshParams(input);
  const second = buildReportRefreshParams({ ...input, search: "invoice 43", customRange: { date_from: "2026-07-02", date_to: "2026-07-20" } });
  assert.equal(first.search, "invoice 42");
  assert.match(first.filters, /UPI/);
  assert.equal(second.search, "invoice 43");
  assert.equal(second.date_from, "2026-07-02");
});

test("local report rows use inclusive local date boundaries", () => {
  const rows = [{ id: 1, return_date: "2026-07-01T00:00:00+05:30" }, { id: 2, return_date: "2026-07-21T23:59:59+05:30" }, { id: 3, return_date: "2026-07-22" }];
  assert.deepEqual(filterRowsForReportRange(rows, { range: "custom", date_from: "2026-07-01", date_to: "2026-07-21" }).map((row) => row.id), [1, 2]);
});

test("UTC timestamps are classified by the local India calendar boundary", () => {
  const rows = [{ id: 1, created_at: "2026-07-20T20:00:00.000Z" }];
  const selected = filterRowsForReportRange(rows, { range: "custom", date_from: "2026-07-21", date_to: "2026-07-21" });
  assert.equal(selected.length, 1);
});

test("a reload that names no range keeps the range the owner last chose", async () => {
  const { reportLoadParams } = await import("./reportRefresh.js");
  const year = { range: "custom", date_from: "2025-09-24", date_to: "2026-09-24" };
  assert.deepEqual(reportLoadParams({}, year), year, "the refresh after a background sync must not fall back to today");
  assert.deepEqual(reportLoadParams(undefined, year), year);
  assert.deepEqual(reportLoadParams({ payment_mode: "UPI" }, year), { ...year, payment_mode: "UPI" });
  assert.deepEqual(reportLoadParams({ range: "month" }, year), { range: "month" }, "a range the owner picks wins");
  assert.deepEqual(reportLoadParams({}, null), {}, "nothing chosen yet: the default applies");
});

test("App remembers the chosen range and rebuilds POS after a sync", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /const requestedParams = reportLoadParams\(params, reportParamsRef\.current\);/);
  assert.match(app, /currentReportParams = \(\) => range === "custom" \? \{ range: "custom", \.\.\.customRange \}/);
  const refresh = app.slice(app.indexOf("const refreshBusinessDataAfterSync = async"), app.indexOf("const applyCanonicalIdentityFromSync"));
  assert.match(refresh, /activeViewRef\.current === "sales"[\s\S]*refreshPosInventoryFromSQLite\("post-sync"\)/);
});
