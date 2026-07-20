import test from "node:test";
import assert from "node:assert/strict";
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
