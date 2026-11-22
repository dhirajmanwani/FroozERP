import test from "node:test";
import assert from "node:assert/strict";

import { ORDER_REPORT, buildOrderReports } from "./orderReporting.js";
import {
  DELIVERY_REPORT,
  DELIVERY_REPORT_ERROR,
  DELIVERY_REPORT_PROBLEM,
  buildDeliveryByAreaReport,
  buildDeliveryReportSource,
  buildDeliveryReports,
  deliveryMinutes,
  describeDeliveryReportError,
  flattenDeliveries,
} from "./deliveryReports.js";

// Timestamps in UTC as SQLite stores them; the shop day is Asia/Kolkata (UTC+5:30).
const NOW = Date.parse("2026-11-22T12:00:00+05:30");
const RANGE = { range: "custom", date_from: "2026-11-20", date_to: "2026-11-22" };
const ist = (day, time) => new Date(`${day}T${time}:00+05:30`).toISOString();

let sequence = 0;
const delivery = (day, overrides = {}) => {
  sequence += 1;
  const created = ist(day, "10:00");
  return {
    id: `d-${sequence}`,
    order_id: "o-1",
    attempt_no: 1,
    area_name: "Indiranagar",
    provider: "rapido",
    paid_by: "shop",
    quoted_paise: 6000,
    final_paise: null,
    status: "closed",
    created_at: created,
    updated_at: created,
    events: [
      { id: `e-${sequence}-1`, from_status: null, to_status: "pending", at: created },
      { id: `e-${sequence}-2`, from_status: "pending", to_status: "booked", at: ist(day, "10:05") },
      { id: `e-${sequence}-3`, from_status: "booked", to_status: "picked_up", at: ist(day, "10:20") },
      { id: `e-${sequence}-4`, from_status: "picked_up", to_status: "delivered", at: ist(day, "10:50") },
      { id: `e-${sequence}-5`, from_status: "delivered", to_status: "closed", at: ist(day, "11:00") },
    ],
    ...overrides,
  };
};
const order = (id, deliveries, overrides = {}) => ({
  id,
  order_no: `ORD-${id}`,
  status: "DELIVERED",
  created_at: ist("2026-11-20", "09:00"),
  branch_id: 1,
  items: [],
  deliveries: deliveries.map((entry) => ({ ...entry, order_id: id })),
  ...overrides,
});

const fixture = () => [
  order("o-1", [
    delivery("2026-11-20", { attempt_no: 1, status: "failed", status_reason: "Not home", final_paise: 3000, events: [] }),
    delivery("2026-11-20", { attempt_no: 2, final_paise: 7000 }),
  ]),
  order("o-2", [delivery("2026-11-20", { area_name: "koramangala ", provider: "uber", paid_by: "customer", quoted_paise: 9000 })]),
  order("o-3", [delivery("2026-11-22", { status: "cancelled", status_reason: "Rider never came", events: [] })]),
  order("o-4", [delivery("2026-11-22", { status: "booked", area_name: "", provider: "own_staff", events: [] })]),
  order("o-5", [delivery("2026-11-10")]), // out of range
  order("o-6", [delivery("2026-11-20")], { deleted_at: "2026-11-21T00:00:00Z" }),
];

test("same top-level and per-report shape as buildOrderReports", () => {
  const orders = buildOrderReports([], RANGE, NOW);
  const deliveries = buildDeliveryReports({ orders: fixture(), salesByDay: null }, RANGE, NOW);
  const topKeys = (value, keys) => Object.keys(value).filter((key) => !keys.includes(key)).sort();
  assert.deepEqual(topKeys(deliveries, Object.values(DELIVERY_REPORT)), topKeys(orders, Object.values(ORDER_REPORT)));
  for (const key of Object.values(DELIVERY_REPORT)) {
    assert.deepEqual(Object.keys(deliveries[key]).sort(), Object.keys(orders[ORDER_REPORT.BY_DATE]).sort(), key);
    assert.equal(deliveries[key].report, key);
    assert.equal(deliveries[key].ok, true);
  }
  assert.deepEqual(DELIVERY_REPORT, { DAILY: "deliveryDaily", COST_SHARE: "deliveryCostShare", BY_AREA: "deliveryByArea", BY_PROVIDER: "deliveryByProvider" });
});

test("flattenDeliveries tags each delivery with its order and skips deleted orders", () => {
  const flat = flattenDeliveries(fixture());
  assert.equal(flat.length, 6);
  assert.deepEqual(Object.keys(flat[0]).filter((key) => ["order_no", "order_status", "branch_id"].includes(key)).sort(), ["branch_id", "order_no", "order_status"]);
  assert.equal(flat[0].order_no, "ORD-o-1");
  assert.deepEqual(flattenDeliveries({ orders: fixture() }).length, 6);
  assert.deepEqual(flattenDeliveries(null), []);
});

test("deliveryMinutes: picked_up -> delivered from events, then stamps, else null", () => {
  assert.equal(deliveryMinutes(delivery("2026-11-20")), 30);
  assert.equal(deliveryMinutes(delivery("2026-11-20", { events: [], picked_up_at: ist("2026-11-20", "10:00"), delivered_at: ist("2026-11-20", "10:42") })), 42);
  assert.equal(deliveryMinutes(delivery("2026-11-20", { events: [] })), null);
  assert.equal(deliveryMinutes(delivery("2026-11-20", { events: [], picked_up_at: ist("2026-11-20", "11:00"), delivered_at: ist("2026-11-20", "10:00") })), null, "negative is null");
  assert.equal(deliveryMinutes(delivery("2026-11-20", { events: [{ to_status: "picked_up", at: ist("2026-11-20", "10:00") }, { to_status: "delivered", at: ist("2026-11-20", "10:12") }] })), 12);
  assert.equal(deliveryMinutes(null), null);
});

test("daily: every day of the range, empty days included; counters add up; failed and cancelled counted", () => {
  const { [DELIVERY_REPORT.DAILY]: daily } = buildDeliveryReports({ orders: fixture(), salesByDay: null }, RANGE, NOW);
  assert.deepEqual(daily.rows.map((row) => row.date), ["2026-11-20", "2026-11-21", "2026-11-22"]);
  const [d20, d21, d22] = daily.rows;
  assert.equal(d20.dateLabel, "20/11/2026");
  assert.deepEqual([d20.deliveries, d20.delivered, d20.closed, d20.failed, d20.cancelled, d20.open], [3, 2, 2, 1, 0, 0]);
  // Cost: failed with final 30 + closed final 70 (shop) + closed quoted 90 (customer).
  assert.deepEqual([d20.cost, d20.shopCost, d20.customerCost], [190, 100, 90]);
  assert.deepEqual([d20.timed, d20.averageMinutes], [2, 30]);
  // The empty day is a real zero, and its average time is null (no ride, no time).
  assert.deepEqual([d21.deliveries, d21.cost, d21.averageMinutes, d21.averageCost], [0, 0, null, null]);
  assert.deepEqual([d22.deliveries, d22.cancelled, d22.open, d22.cost], [2, 1, 1, 0]);
  for (const row of daily.rows) {
    assert.equal(row.delivered + row.failed + row.cancelled + row.open + row.unknownStatus, row.deliveries, row.date);
  }
  assert.deepEqual(
    [daily.summary.days, daily.summary.deliveries, daily.summary.delivered, daily.summary.failed, daily.summary.cancelled, daily.summary.open],
    [3, 5, 2, 1, 1, 1],
  );
  assert.deepEqual([daily.summary.cost, daily.summary.shopCost, daily.summary.customerCost, daily.summary.averageMinutes], [190, 100, 90, 30]);
  assert.equal(daily.summary.deletedOrders, 1);
});

test("a delivery belongs to the shop day it was started, not the UTC day", () => {
  // 23:30 IST on the 21st is 18:00 UTC on the 21st; 00:30 IST on the 22nd is 19:00 UTC on the 21st.
  const late = delivery("2026-11-21", { created_at: ist("2026-11-21", "23:30"), events: [] });
  const early = delivery("2026-11-22", { created_at: ist("2026-11-22", "00:30"), events: [] });
  const { [DELIVERY_REPORT.DAILY]: daily } = buildDeliveryReports({ orders: [order("x", [late, early])] }, RANGE, NOW);
  assert.deepEqual(daily.rows.map((row) => [row.date, row.deliveries]), [["2026-11-20", 0], ["2026-11-21", 1], ["2026-11-22", 1]]);
});

test("cost share: per day and per month; null sales means unavailable, never 0", () => {
  const unavailable = buildDeliveryReports({ orders: fixture(), salesByDay: null }, RANGE, NOW)[DELIVERY_REPORT.COST_SHARE];
  assert.equal(unavailable.ok, true);
  for (const row of unavailable.rows) {
    assert.equal(row.sales, null);
    assert.equal(row.salesAvailable, false);
    assert.equal(row.costPercent, null);
    assert.equal(row.shopCostPercent, null);
  }
  assert.equal(unavailable.summary.sales, null);
  assert.equal(unavailable.summary.costPercent, null);
  assert.match(unavailable.summary.salesNotice, /not available/);
  assert.equal(unavailable.summary.months[0].costPercent, null);

  const known = buildDeliveryReports({ orders: fixture(), salesByDay: { "2026-11-20": 3800, "2026-11-22": 1000 } }, RANGE, NOW)[DELIVERY_REPORT.COST_SHARE];
  const [d20, d21, d22] = known.rows;
  assert.deepEqual([d20.sales, d20.cost, d20.costPercent, d20.shopCostPercent], [3800, 190, 5, 2.63]);
  assert.deepEqual([d21.sales, d21.costPercent], [0, null], "no sales: no honest percentage");
  assert.deepEqual([d22.sales, d22.cost, d22.costPercent], [1000, 0, 0], "sales but no cost is a real 0%");
  assert.deepEqual([known.summary.sales, known.summary.cost, known.summary.costPercent, known.summary.shopCostPercent], [4800, 190, 3.96, 2.08]);
  assert.deepEqual(known.summary.months.map((month) => [month.month, month.monthLabel, month.sales, month.costPercent]), [["2026-11", "Nov 2026", 4800, 3.96]]);
  assert.equal(known.summary.salesNotice, "");
});

test("cost share: an unreadable day's sales is a problem and makes the period total unknown", () => {
  const report = buildDeliveryReports({ orders: fixture(), salesByDay: { "2026-11-20": "lots", "2026-11-22": 1000 } }, RANGE, NOW)[DELIVERY_REPORT.COST_SHARE];
  assert.deepEqual([report.rows[0].sales, report.rows[0].costPercent], [null, null]);
  assert.equal(report.summary.sales, null);
  assert.equal(report.summary.costPercent, null);
  assert.ok(report.problems.some((problem) => problem.code === DELIVERY_REPORT_PROBLEM.SALES_UNREADABLE));
  const garbage = buildDeliveryReports({ orders: fixture(), salesByDay: "nope" }, RANGE, NOW)[DELIVERY_REPORT.COST_SHARE];
  assert.equal(garbage.summary.costPercent, null);
  assert.ok(garbage.problems.some((problem) => problem.code === DELIVERY_REPORT_PROBLEM.SALES_UNREADABLE));
});

test("cost share spans months", () => {
  const orders = [order("m", [delivery("2026-10-31", { final_paise: 5000 }), delivery("2026-11-01", { final_paise: 2000 })])];
  const report = buildDeliveryReports({ orders, salesByDay: { "2026-10-31": 1000, "2026-11-01": 1000 } }, { range: "custom", date_from: "2026-10-31", date_to: "2026-11-01" }, NOW)[DELIVERY_REPORT.COST_SHARE];
  assert.deepEqual(report.summary.months.map((month) => [month.month, month.cost, month.costPercent]), [["2026-10", 50, 5], ["2026-11", 20, 2]]);
});

test("by area: grouped ignoring case and spacing, no area is its own row", () => {
  const { [DELIVERY_REPORT.BY_AREA]: byArea } = buildDeliveryReports({ orders: fixture() }, RANGE, NOW);
  const rows = Object.fromEntries(byArea.rows.map((row) => [row.areaName, row]));
  assert.deepEqual(Object.keys(rows).sort(), ["Indiranagar", "No area", "koramangala"]);
  assert.deepEqual([rows.Indiranagar.deliveries, rows.Indiranagar.delivered, rows.Indiranagar.failed, rows.Indiranagar.cancelled], [3, 1, 1, 1]);
  assert.deepEqual([rows.Indiranagar.cost, rows.Indiranagar.averageCost], [100, 50]);
  assert.deepEqual([rows["No area"].open, rows["No area"].cost, rows["No area"].averageCost], [1, 0, null]);
  assert.equal(byArea.rows[0].areaName, "Indiranagar", "busiest first");
  assert.equal(byArea.summary.deliveries, 5);
  assert.equal(byArea.summary.areas, 3);
});

test("by provider: Rapido vs Uber vs own staff, with unknown providers named", () => {
  const extra = order("o-9", [delivery("2026-11-21", { provider: "porter", events: [] })]);
  const { [DELIVERY_REPORT.BY_PROVIDER]: byProvider } = buildDeliveryReports({ orders: [...fixture(), extra] }, RANGE, NOW);
  const rows = Object.fromEntries(byProvider.rows.map((row) => [row.provider, row]));
  assert.deepEqual(Object.keys(rows).sort(), ["own_staff", "porter", "rapido", "uber"]);
  assert.equal(rows.rapido.providerLabel, "Rapido");
  assert.deepEqual([rows.rapido.deliveries, rows.rapido.delivered, rows.rapido.failed, rows.rapido.cancelled, rows.rapido.averageMinutes], [3, 1, 1, 1, 30]);
  assert.deepEqual([rows.uber.customerCost, rows.uber.shopCost], [90, 0]);
  assert.equal(rows.porter.known, false);
  assert.ok(byProvider.problems.some((problem) => problem.code === DELIVERY_REPORT_PROBLEM.DELIVERY_PROVIDER_UNKNOWN));
  assert.equal(byProvider.summary.deliveries, 6);
});

test("a delivered delivery with no charge is counted as uncosted, never as a free ride", () => {
  const orders = [order("u", [delivery("2026-11-21", { quoted_paise: null, final_paise: null })])];
  const reports = buildDeliveryReports({ orders }, RANGE, NOW);
  assert.equal(reports[DELIVERY_REPORT.DAILY].summary.uncosted, 1);
  assert.equal(reports[DELIVERY_REPORT.DAILY].rows[1].averageCost, null);
  assert.ok(reports.problems.some((problem) => problem.code === DELIVERY_REPORT_PROBLEM.DELIVERY_CHARGE_MISSING));
  assert.match(describeDeliveryReportError(reports[DELIVERY_REPORT.DAILY]), /no charge recorded/);
});

test("unreadable rows are named, not silently dropped; duplicates counted once", () => {
  const dup = delivery("2026-11-21");
  const orders = [
    "not an order",
    order("a", [dup, null]),
    order("b", [{ ...dup }]),
    order("c", [delivery("2026-11-21", { created_at: "garbage", events: [] })]),
    order("d", [delivery("2026-11-21", { status: "teleported" })]),
    { id: "e", order_no: "ORD-e", deliveries: "oops" },
  ];
  const reports = buildDeliveryReports({ orders }, RANGE, NOW);
  const codes = reports.problems.map((problem) => problem.code);
  for (const code of ["ORDER_UNREADABLE", "DELIVERY_UNREADABLE", "DELIVERY_DUPLICATE", "DELIVERY_DATE_UNREADABLE", "DELIVERY_STATUS_UNKNOWN"]) {
    assert.ok(codes.includes(code), code);
  }
  const daily = reports[DELIVERY_REPORT.DAILY];
  assert.equal(daily.summary.deliveries, 2, "the duplicate once, plus the unknown-status one");
  assert.equal(daily.rows[1].unknownStatus, 1);
  assert.equal(daily.summary.unknownStatus, 1);
  assert.ok(daily.summary.unreadableDeliveries >= 3);
});

test("errors are never zeros: unreadable orders or range give summary null on every report", () => {
  for (const input of [{ orders: null }, { orders: "x" }, {}, null]) {
    const reports = buildDeliveryReports(input, RANGE, NOW);
    assert.equal(reports.ok, false);
    assert.equal(reports.error.code, DELIVERY_REPORT_ERROR.ORDERS_UNREADABLE);
    for (const key of Object.values(DELIVERY_REPORT)) {
      assert.equal(reports[key].ok, false);
      assert.equal(reports[key].summary, null, key);
      assert.deepEqual(reports[key].rows, []);
    }
    assert.match(describeDeliveryReportError(reports[DELIVERY_REPORT.DAILY]), /could not be read/);
  }
  const badRange = buildDeliveryReports({ orders: [] }, { range: "custom", date_from: "2026-11-22", date_to: "2026-11-01" }, NOW);
  assert.equal(badRange.error.code, DELIVERY_REPORT_ERROR.RANGE_UNREADABLE);
  assert.equal(badRange[DELIVERY_REPORT.COST_SHARE].summary, null);
  assert.equal(buildDeliveryByAreaReport(null).error.code, DELIVERY_REPORT_ERROR.SOURCE_UNREADABLE);
});

test("no deliveries at all is a real, readable empty result", () => {
  const reports = buildDeliveryReports({ orders: { orders: [] }, salesByDay: null }, { range: "today" }, NOW);
  assert.equal(reports.ok, true);
  assert.deepEqual(reports.range, { range: "today", date_from: "2026-11-22", date_to: "2026-11-22" });
  const daily = reports[DELIVERY_REPORT.DAILY];
  assert.equal(daily.rows.length, 1);
  assert.deepEqual([daily.summary.deliveries, daily.summary.cost, daily.summary.averageMinutes], [0, 0, null]);
  assert.deepEqual(reports[DELIVERY_REPORT.BY_AREA].rows, []);
  assert.equal(describeDeliveryReportError(daily), "");
});

test("one source feeds all four reports, so their totals agree", () => {
  const reports = buildDeliveryReports({ orders: fixture(), salesByDay: { "2026-11-20": 3800 } }, RANGE, NOW);
  const totals = Object.values(DELIVERY_REPORT).map((key) => [reports[key].summary.cost, reports[key].summary.deliveries]);
  for (const [cost, count] of totals) {
    assert.equal(cost, 190);
    assert.equal(count, 5);
  }
  const source = buildDeliveryReportSource({ orders: fixture() }, RANGE, NOW);
  assert.equal(source.excluded.outOfRange, 1);
});
