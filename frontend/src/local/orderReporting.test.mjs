import test from "node:test";
import assert from "node:assert/strict";

import { ORDER_STATUS } from "./orderLifecycle.js";
import { orderValue } from "./ordersBoard.js";
import {
  ORDER_REPORT,
  ORDER_REPORT_ERROR,
  ORDER_REPORT_PROBLEM,
  buildOrderFulfilmentReport,
  buildOrderReportSource,
  buildOrderReports,
  buildOrdersByCustomerReport,
  buildOrdersByDateReport,
  buildOrdersByProductReport,
  describeOrderReportError,
  findProductReportRow,
  orderReportValue,
  resolveOrderReportRange,
  shopDateKey,
} from "./orderReporting.js";

// Midday in the shop, on a day the fixtures sit inside. Timestamps below are written in UTC exactly
// as SQLite stores them, so that nothing in this suite depends on the runner's own zone — the point
// of several of these tests is that the report reads the same in Kolkata and in London.
const NOW = Date.parse("2026-08-22T12:00:00+05:30");
const WHOLE_WEEK = { range: "custom", date_from: "2026-08-01", date_to: "2026-08-31" };

let sequence = 0;
const order = (overrides = {}) => {
  sequence += 1;
  return {
    id: `order-${sequence}`,
    order_no: `ORD-${sequence}`,
    source: "PHONE",
    customer_id: "cust-1",
    customer_name: "Ram",
    customer_mobile: "9812345678",
    status: ORDER_STATUS.RECEIVED,
    payment_state: "ON_DELIVERY",
    created_at: "2026-08-22T04:30:00.000Z",
    items: [{ product_id: "004", product_name: "Apple", unit: "kg", quantity: 10, agreed_rate: 80 }],
    ...overrides,
  };
};

const reportsFor = (orders, params = WHOLE_WEEK) => buildOrderReports(orders, params, NOW);

/* ------------------------------------------------------------------ the four report shapes --- */

test("the four reports the owner asks for are all built from one call", () => {
  const reports = reportsFor([
    order({ items: [{ product_id: "004", product_name: "Apple", unit: "kg", quantity: 10, agreed_rate: 80 }] }),
    order({ customer_id: "cust-2", customer_name: "Sita", items: [{ product_id: "007", product_name: "Banana", unit: "dozen", quantity: 3, agreed_rate: 60 }] }),
  ]);

  assert.equal(reports.ok, true);
  for (const key of Object.values(ORDER_REPORT)) {
    const report = reports[key];
    assert.equal(report.ok, true, `${key} must build`);
    assert.ok(Array.isArray(report.rows), `${key} must have rows`);
    assert.ok(report.summary, `${key} must have a summary`);
    // Every report is filtered by the same resolved range. A report that quietly used a different
    // one would make two panels on the same screen answer different questions.
    assert.deepEqual(report.range, reports.range);
  }
  assert.deepEqual(reports[ORDER_REPORT.BY_DATE].rows.map((row) => row.date), ["2026-08-22"]);
  assert.deepEqual(reports[ORDER_REPORT.BY_PRODUCT].rows.map((row) => row.productName), ["Apple", "Banana"]);
  assert.deepEqual(reports[ORDER_REPORT.BY_CUSTOMER].rows.map((row) => row.customerName), ["Ram", "Sita"]);
  assert.equal(reports[ORDER_REPORT.FULFILMENT].rows.length, 2);
});

test("the mandi list leads with the thing most of which was ordered", () => {
  // This report is read top-down while writing out what to buy, so the ordering is the feature.
  const reports = reportsFor([
    order({ items: [{ product_id: "004", product_name: "Apple", unit: "kg", quantity: 2, agreed_rate: 80 }] }),
    order({ items: [{ product_id: "007", product_name: "Banana", unit: "kg", quantity: 40, agreed_rate: 60 }] }),
  ]);
  assert.deepEqual(reports[ORDER_REPORT.BY_PRODUCT].rows.map((row) => row.productName), ["Banana", "Apple"]);
  assert.equal(reports[ORDER_REPORT.BY_PRODUCT].rows[0].quantity, 40);
});

/* ---------------------------------------------------------- summary and detail must agree ---- */

test("all four reports total the same rupees", () => {
  // The bug this module is shaped to prevent: totals from one collection, rows from another. Four
  // reports over four separately-filtered lists would be that bug four times over, and across
  // reports as well as inside them — by-product and by-date could differ and neither would look
  // wrong on its own.
  const orders = [
    order({ items: [{ product_id: "004", product_name: "Apple", unit: "kg", quantity: 10.5, agreed_rate: 82.5 }] }),
    order({ customer_id: "cust-2", customer_name: "Sita", status: ORDER_STATUS.DELIVERED, created_at: "2026-08-20T09:00:00.000Z", items: [
      { product_id: "004", product_name: "Apple", unit: "kg", quantity: 1.125, agreed_rate: 82.5 },
      { product_id: "007", product_name: "Banana", unit: "dozen", quantity: 3, agreed_rate: 61.75 },
    ] }),
    order({ customer_id: "", customer_name: "Walk-in", status: ORDER_STATUS.SENT, items: [{ product_id: "011", product_name: "Guava", unit: "kg", quantity: 0.333, agreed_rate: 45 }] }),
  ];
  const reports = reportsFor(orders);
  const totals = Object.values(ORDER_REPORT).map((key) => reports[key].summary.value);
  assert.equal(new Set(totals).size, 1, `the four reports disagree: ${JSON.stringify(totals)}`);

  // And each summary is the sum of its own rows, not of a second pass over the orders.
  assert.equal(
    reports[ORDER_REPORT.BY_DATE].summary.orders,
    reports[ORDER_REPORT.BY_DATE].rows.reduce((sum, row) => sum + row.orders, 0),
  );
  assert.equal(
    reports[ORDER_REPORT.BY_CUSTOMER].summary.orders,
    reports[ORDER_REPORT.FULFILMENT].summary.orders,
  );
  assert.equal(reports[ORDER_REPORT.FULFILMENT].rows.length, reports[ORDER_REPORT.BY_DATE].summary.orders);
});

test("every by-date row's status counters add up to that row's order count", () => {
  // A status nobody accounted for would otherwise leave an order counted once in `orders` and in no
  // counter at all, and nothing on the row would show that it had gone missing.
  const reports = reportsFor([
    order(),
    order({ status: ORDER_STATUS.DELIVERED }),
    order({ status: ORDER_STATUS.CANCELLED }),
    order({ status: ORDER_STATUS.RETURNED }),
    order({ status: ORDER_STATUS.SENT }),
    order({ status: "ON_A_SCOOTER" }),
  ]);
  for (const row of reports[ORDER_REPORT.BY_DATE].rows) {
    assert.equal(
      row.delivered + row.cancelled + row.returned + row.open + row.unknownStatus,
      row.orders,
      `${row.date} loses an order between its counters`,
    );
  }
});

/* ------------------------------------------------------------------ cancelled and returned --- */

test("a cancelled or returned order is never revenue, and never simply disappears either", () => {
  // Counting either as revenue inflates the day by orders that produced nothing. Dropping them
  // instead would hide "we cancelled eleven thousand rupees this week", which is its own answer.
  const reports = reportsFor([
    order({ status: ORDER_STATUS.DELIVERED }),
    order({ status: ORDER_STATUS.CANCELLED, cancellation_reason: "customer changed their mind" }),
    order({ status: ORDER_STATUS.RETURNED }),
  ]);
  const byDate = reports[ORDER_REPORT.BY_DATE].summary;
  assert.equal(byDate.orders, 3);
  assert.equal(byDate.value, 800);
  assert.equal(byDate.cancelledValue, 1600);
  assert.equal(byDate.cancelled, 1);
  assert.equal(byDate.returned, 1);
  assert.equal(reports[ORDER_REPORT.FULFILMENT].summary.value, 800);
  assert.equal(reports[ORDER_REPORT.BY_CUSTOMER].summary.value, 800);
});

test("fruit for a cancelled order is not on tomorrow's mandi list", () => {
  // The specific mistake: buying stock in the morning for an order the customer cancelled
  // yesterday. The quantity is still carried, so a product whose orders keep falling through is
  // visible rather than merely absent.
  const reports = reportsFor([
    order({ items: [{ product_id: "004", product_name: "Apple", unit: "kg", quantity: 10, agreed_rate: 80 }] }),
    order({ status: ORDER_STATUS.CANCELLED, items: [{ product_id: "004", product_name: "Apple", unit: "kg", quantity: 25, agreed_rate: 80 }] }),
  ]);
  const apple = findProductReportRow(reports[ORDER_REPORT.BY_PRODUCT].rows, "004");
  assert.equal(apple.quantity, 10);
  assert.equal(apple.cancelledQuantity, 25);
  assert.equal(apple.value, 800);
});

/* -------------------------------------------------------------------------- deleted ---------- */

test("a deleted order vanishes from every report, and quietly", () => {
  // A deletion is a decision somebody took, not a fault, so it is excluded without a problem
  // being raised — but it is still counted, so "where did that order go" has an answer.
  const reports = reportsFor([
    order({ id: "kept", items: [{ product_id: "004", product_name: "Apple", quantity: 10, agreed_rate: 80 }] }),
    order({ id: "gone", deleted_at: "2026-08-22T05:00:00.000Z", customer_id: "cust-9", customer_name: "Deleted Person", items: [{ product_id: "099", product_name: "Ghost fruit", quantity: 99, agreed_rate: 99 }] }),
  ]);
  assert.equal(reports[ORDER_REPORT.BY_DATE].summary.orders, 1);
  assert.equal(reports[ORDER_REPORT.BY_DATE].summary.value, 800);
  assert.equal(findProductReportRow(reports[ORDER_REPORT.BY_PRODUCT].rows, "099"), null);
  assert.deepEqual(reports[ORDER_REPORT.BY_CUSTOMER].rows.map((row) => row.customerName), ["Ram"]);
  assert.deepEqual(reports[ORDER_REPORT.FULFILMENT].rows.map((row) => row.id), ["kept"]);
  assert.equal(reports.excluded.deleted, 1);
  assert.equal(reports.problems.length, 0);
});

/* --------------------------------------------------------------------- opaque string ids ----- */

test('a product ordered as "004" and one ordered as 4 are two products, not one', () => {
  // Entity ids are opaque strings. `Number()` on one side of this grouping is the documented way
  // this codebase once emptied the Inventory table while every summary tile above it stayed right.
  const reports = reportsFor([
    order({ items: [{ product_id: "004", product_name: "Apple", unit: "kg", quantity: 10, agreed_rate: 80 }] }),
    order({ items: [{ product_id: 4, product_name: "Apricot", unit: "kg", quantity: 5, agreed_rate: 200 }] }),
  ]);
  const rows = reports[ORDER_REPORT.BY_PRODUCT].rows;
  assert.equal(rows.length, 2);
  assert.equal(findProductReportRow(rows, "004").quantity, 10);
  assert.equal(findProductReportRow(rows, 4).quantity, 5);
  assert.equal(findProductReportRow(rows, "4").productName, "Apricot");
  // And the totals still add up, so the split is a split and not a duplication.
  assert.equal(reports[ORDER_REPORT.BY_PRODUCT].summary.value, 1800);
  assert.equal(reports[ORDER_REPORT.BY_DATE].summary.value, 1800);
});

test("the same product ordered twice is one row, whitespace and all", () => {
  const reports = reportsFor([
    order({ items: [{ product_id: "004", product_name: "Apple", unit: "kg", quantity: 10, agreed_rate: 80 }] }),
    order({ items: [{ product_id: " 004 ", product_name: "Apple", unit: "kg", quantity: 2.5, agreed_rate: 80 }] }),
  ]);
  const rows = reports[ORDER_REPORT.BY_PRODUCT].rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantity, 12.5);
  assert.equal(rows[0].orders, 2);
});

/* --------------------------------------------------------------- errors are never zeros ------ */

test("orders that could not be read produce a named error, not an empty day", () => {
  // `listLocalCustomerOrders()` resolves to null off the desktop shell. "No orders today" and "we
  // could not read the orders" must never render as the same figure.
  for (const unreadable of [null, undefined, "orders", 42, { rows: [] }]) {
    const reports = reportsFor(unreadable);
    assert.equal(reports.ok, false, `${JSON.stringify(unreadable)} must not read as an empty day`);
    for (const key of Object.values(ORDER_REPORT)) {
      const report = reports[key];
      assert.equal(report.ok, false);
      assert.equal(report.error.code, ORDER_REPORT_ERROR.ORDERS_UNREADABLE);
      // Null and not 0: there is no total, so no total is offered, and a tile cannot render a
      // confident zero out of a report that never built.
      assert.equal(report.summary, null);
      assert.match(describeOrderReportError(report), /could not be read/i);
    }
  }
});

test("a genuinely empty range is a zero, and says so differently", () => {
  const reports = reportsFor([]);
  assert.equal(reports.ok, true);
  assert.equal(reports.error, null);
  assert.equal(reports[ORDER_REPORT.BY_DATE].summary.orders, 0);
  assert.equal(reports[ORDER_REPORT.BY_DATE].summary.value, 0);
  assert.equal(describeOrderReportError(reports[ORDER_REPORT.BY_DATE]), "");
});

test("one unreadable row does not fail the report, and does not hide either", () => {
  const reports = reportsFor([
    order({ items: [{ product_id: "004", product_name: "Apple", quantity: 10, agreed_rate: 80 }] }),
    "not an order",
    order({ id: "undated", created_at: "the day before yesterday" }),
  ]);
  assert.equal(reports.ok, true);
  const byDate = reports[ORDER_REPORT.BY_DATE];
  assert.equal(byDate.summary.orders, 1);
  // The count of what was dropped travels with the total, so a short figure always says why.
  assert.equal(byDate.summary.unreadableOrders, 2);
  assert.deepEqual(
    byDate.problems.map((problem) => problem.code).sort(),
    [ORDER_REPORT_PROBLEM.ORDER_DATE_UNREADABLE, ORDER_REPORT_PROBLEM.ORDER_UNREADABLE],
  );
  assert.match(describeOrderReportError(byDate), /could not be fully read/i);
});

test("an unrecognised status is counted and named, never silently voided", () => {
  // The database refuses such a status, so reaching here means something outside this app wrote it.
  // Treating it as cancelled would erase real money; trusting it silently would hide the corruption.
  const reports = reportsFor([order({ status: "ON_A_SCOOTER" })]);
  assert.equal(reports[ORDER_REPORT.BY_DATE].summary.orders, 1);
  assert.equal(reports[ORDER_REPORT.BY_DATE].summary.value, 800);
  assert.equal(reports[ORDER_REPORT.BY_DATE].summary.unknownStatus, 1);
  assert.equal(reports[ORDER_REPORT.FULFILMENT].rows[0].statusKnown, false);
  assert.ok(reports.problems.some((problem) => problem.code === ORDER_REPORT_PROBLEM.ORDER_STATUS_UNKNOWN));
});

test("a bad custom range refuses rather than quietly reporting today", () => {
  // Report Center defaults to today when a range is unset, so a range that silently collapsed would
  // show a confident, small, wrong number that looks like an ordinary quiet day.
  const reports = reportsFor([order()], { range: "custom", date_from: "31/08/2026", date_to: "" });
  assert.equal(reports.ok, false);
  assert.equal(reports[ORDER_REPORT.BY_DATE].error.code, ORDER_REPORT_ERROR.RANGE_UNREADABLE);
  assert.equal(reports[ORDER_REPORT.BY_DATE].summary, null);
  assert.throws(() => resolveOrderReportRange({ range: "custom", date_from: "2026-08-31", date_to: "2026-08-01" }), /cannot be after/);
});

test("a builder handed something that is not a source refuses instead of showing zeros", () => {
  for (const builder of [buildOrdersByDateReport, buildOrdersByProductReport, buildOrdersByCustomerReport, buildOrderFulfilmentReport]) {
    const report = builder(undefined);
    assert.equal(report.ok, false);
    assert.equal(report.error.code, ORDER_REPORT_ERROR.SOURCE_UNREADABLE);
    assert.equal(report.summary, null);
  }
});

/* ------------------------------------------------------------------------ zero is a value ---- */

test("an agreed rate of zero is a real zero, and a missing one is not zero at all", () => {
  // `??` and `||` do not fall through on 0. A replacement box sent free after a complaint is a
  // genuine zero-value line and must be counted; a line nobody priced is an unknown, and letting it
  // read as 0 would understate the day with nothing on screen to say so.
  const reports = reportsFor([
    order({ id: "free", items: [{ product_id: "004", product_name: "Apple", unit: "kg", quantity: 4, agreed_rate: 0 }] }),
    order({ id: "unpriced", items: [{ product_id: "007", product_name: "Banana", unit: "kg", quantity: 6, agreed_rate: null }] }),
  ]);

  const apple = findProductReportRow(reports[ORDER_REPORT.BY_PRODUCT].rows, "004");
  assert.equal(apple.quantity, 4);
  assert.equal(apple.value, 0);
  assert.equal(apple.unpricedLines, 0, "a rate of 0 is priced");

  const banana = findProductReportRow(reports[ORDER_REPORT.BY_PRODUCT].rows, "007");
  // The quantity is known even when the money is not, so the mandi list stays right.
  assert.equal(banana.quantity, 6);
  assert.equal(banana.unpricedLines, 1);
  assert.equal(reports[ORDER_REPORT.BY_DATE].summary.unpricedLines, 1);
  assert.ok(reports.problems.some((problem) => problem.code === ORDER_REPORT_PROBLEM.LINE_RATE_MISSING));

  // The free box is not a problem. Only the unpriced one is.
  assert.equal(reports.problems.filter((problem) => problem.code === ORDER_REPORT_PROBLEM.LINE_RATE_MISSING).length, 1);
  assert.equal(reports[ORDER_REPORT.BY_DATE].summary.orders, 2);
});

/* -------------------------------------------------------------------------- the money -------- */

test("money is rounded once per line and then summed, never summed and then rounded", () => {
  // Three lines of 0.1875 each. Rounded per line that is 0.19 + 0.19 + 0.19 = 0.57; summed first it
  // is 0.5625 rounding to 0.56. Reports here aggregate the same rupees three different ways at
  // once, so the rounding has to happen before any grouping or by-product and by-date would differ
  // in the last paisa — which, in a report about missing money, reads as a real discrepancy.
  const reports = reportsFor([order({ items: [
    { product_id: "004", product_name: "Apple", quantity: 0.125, agreed_rate: 1.5 },
    { product_id: "007", product_name: "Banana", quantity: 0.125, agreed_rate: 1.5 },
    { product_id: "011", product_name: "Guava", quantity: 0.125, agreed_rate: 1.5 },
  ] })]);
  assert.equal(reports[ORDER_REPORT.BY_DATE].summary.value, 0.57);
  assert.equal(reports[ORDER_REPORT.BY_PRODUCT].summary.value, 0.57);
  assert.equal(reports[ORDER_REPORT.FULFILMENT].rows[0].value, 0.57);
});

test("the reporting value of an order matches what the Orders board shows for it", () => {
  // `ordersBoard.orderValue` is the board's number and this is the report's; they are allowed to
  // differ only by the per-line rounding above. If they diverged further, the same order would be
  // worth two amounts on two screens.
  const subject = order({ items: [
    { product_id: "004", product_name: "Apple", quantity: 10.5, agreed_rate: 82.5 },
    { product_id: "007", product_name: "Banana", quantity: 3, agreed_rate: 61.75 },
  ] });
  assert.equal(orderReportValue(subject), 1051.5);
  assert.ok(Math.abs(orderReportValue(subject) - orderValue(subject)) < 0.01);
});

/* -------------------------------------------------------------------------- timezone --------- */

test("a late-evening order belongs to the shop's day, not the reader's", () => {
  // 18:29Z is 23:59 in Kolkata on the 21st; one minute later is midnight on the 22nd. A reader in
  // UTC — or a runner with TZ unset — would put both on the 21st, and the owner's Friday takings
  // would quietly include Thursday's last order.
  assert.equal(shopDateKey("2026-08-21T18:29:00.000Z"), "2026-08-21");
  assert.equal(shopDateKey("2026-08-21T18:30:00.000Z"), "2026-08-22");

  const reports = reportsFor([
    order({ id: "late-thursday", created_at: "2026-08-21T18:29:00.000Z" }),
    order({ id: "first-friday", created_at: "2026-08-21T18:30:00.000Z" }),
  ]);
  assert.deepEqual(
    reports[ORDER_REPORT.BY_DATE].rows.map((row) => [row.date, row.orders]),
    [["2026-08-21", 1], ["2026-08-22", 1]],
  );
});

test("a one-day range keeps the shop's midnight, not UTC's", () => {
  const reports = reportsFor(
    [
      order({ id: "late-thursday", created_at: "2026-08-21T18:29:00.000Z" }),
      order({ id: "first-friday", created_at: "2026-08-21T18:30:00.000Z" }),
    ],
    { range: "custom", date_from: "2026-08-22", date_to: "2026-08-22" },
  );
  assert.deepEqual(reports[ORDER_REPORT.FULFILMENT].rows.map((row) => row.id), ["first-friday"]);
  assert.equal(reports.excluded.outOfRange, 1);
});

test("'today' is the shop's today even at half past midnight in Kolkata", () => {
  // 19:00Z on the 21st is 00:30 on the 22nd in the shop. Deriving the preset from the host's
  // calendar would name the 21st and show the owner an empty day while orders were arriving.
  const justAfterMidnight = Date.parse("2026-08-21T19:00:00.000Z");
  assert.deepEqual(
    resolveOrderReportRange({ range: "today" }, justAfterMidnight),
    { range: "today", date_from: "2026-08-22", date_to: "2026-08-22" },
  );
  assert.deepEqual(
    resolveOrderReportRange({ range: "yesterday" }, justAfterMidnight),
    { range: "yesterday", date_from: "2026-08-21", date_to: "2026-08-21" },
  );
  // Saturday 22 August 2026 sits in the week beginning Monday the 17th.
  assert.deepEqual(
    resolveOrderReportRange({ range: "week" }, justAfterMidnight),
    { range: "week", date_from: "2026-08-17", date_to: "2026-08-22" },
  );
  assert.deepEqual(
    resolveOrderReportRange({ range: "month" }, justAfterMidnight),
    { range: "month", date_from: "2026-08-01", date_to: "2026-08-22" },
  );
});

/* ------------------------------------------------------------------------- customers --------- */

test("two strangers with the same name are two customers", () => {
  // `customer_id` is nullable by design — a first-time caller has no record — so grouping on it
  // alone would tip every new customer into one nameless bucket, and grouping on the name alone
  // would invent a regular out of two different people called Ram.
  const reports = reportsFor([
    order({ customer_id: null, customer_name: "Ram", customer_mobile: "9800000001" }),
    order({ customer_id: null, customer_name: "Ram", customer_mobile: "9800000002" }),
    order({ customer_id: "cust-1", customer_name: "Ram", customer_mobile: "9800000001" }),
  ]);
  const rows = reports[ORDER_REPORT.BY_CUSTOMER].rows;
  assert.equal(rows.length, 3, "an identified Ram and two unidentified ones are three customers");
  assert.equal(rows.filter((row) => row.identified).length, 1);
  assert.equal(reports[ORDER_REPORT.BY_CUSTOMER].summary.customers, 3);
  assert.equal(reports[ORDER_REPORT.BY_CUSTOMER].summary.identifiedCustomers, 1);
});

test("a repeat customer is counted once, with how often and how much", () => {
  const reports = reportsFor([
    order({ created_at: "2026-08-20T09:00:00.000Z", items: [{ product_id: "004", product_name: "Apple", quantity: 10, agreed_rate: 80 }] }),
    order({ created_at: "2026-08-22T09:00:00.000Z", items: [{ product_id: "004", product_name: "Apple", quantity: 5, agreed_rate: 80 }] }),
  ]);
  const [ram] = reports[ORDER_REPORT.BY_CUSTOMER].rows;
  assert.equal(ram.orders, 2);
  assert.equal(ram.value, 1200);
  assert.equal(ram.averageOrderValue, 600);
  assert.equal(ram.firstOrderedOn, "2026-08-20");
  assert.equal(ram.lastOrderedOn, "2026-08-22");
});

/* ------------------------------------------------------------------------ fulfilment --------- */

test("a fulfilment row carries what somebody chasing the order needs", () => {
  const reports = reportsFor([order({
    status: ORDER_STATUS.SENT,
    created_at: "2026-08-22T04:30:00.000Z",
    carrier: "Rapido",
    carrier_reference: "RAP-9182",
    tracking_url: "https://example.invalid/RAP-9182",
    sale_id: "sale-1",
    invoice_no: "INV-77",
    payment_state: "PAID",
  })]);
  const [row] = reports[ORDER_REPORT.FULFILMENT].rows;
  assert.equal(row.status, ORDER_STATUS.SENT);
  assert.equal(row.carrier, "Rapido");
  assert.equal(row.carrierReference, "RAP-9182");
  assert.equal(row.invoiceNo, "INV-77");
  assert.equal(row.billed, true);
  assert.equal(row.orderedOnLabel, "22/08/2026");
  // 10:00 IST to 12:00 IST.
  assert.equal(row.ageHours, 2);
  assert.equal(reports[ORDER_REPORT.FULFILMENT].summary.unbilled, 0);
});

test("a sent parcel with the money question unanswered is a headline, not a filter", () => {
  const reports = reportsFor([
    order({ status: ORDER_STATUS.SENT, payment_state: null, sale_id: "sale-1" }),
    order({ status: ORDER_STATUS.PACKED, payment_state: "PAID" }),
  ]);
  assert.equal(reports[ORDER_REPORT.FULFILMENT].summary.awaitingPayment, 1);
  assert.equal(reports[ORDER_REPORT.FULFILMENT].summary.open, 2);
});

test("the oldest open order is null when nothing is open, not zero hours old", () => {
  // "The oldest open order is 0 hours old" is a sentence about an order that does not exist.
  const none = reportsFor([order({ status: ORDER_STATUS.DELIVERED })]);
  assert.equal(none[ORDER_REPORT.FULFILMENT].summary.oldestOpenAgeMs, null);
  const some = reportsFor([order({ created_at: "2026-08-22T04:30:00.000Z" })]);
  assert.equal(some[ORDER_REPORT.FULFILMENT].summary.oldestOpenAgeMs, 2 * 60 * 60 * 1000);
});

test("fulfilment rows are newest first", () => {
  const reports = reportsFor([
    order({ id: "older", created_at: "2026-08-20T09:00:00.000Z" }),
    order({ id: "newer", created_at: "2026-08-22T09:00:00.000Z" }),
  ]);
  assert.deepEqual(reports[ORDER_REPORT.FULFILMENT].rows.map((row) => row.id), ["newer", "older"]);
});

/* ---------------------------------------------------------------------------- source --------- */

test("the source is the one filtered collection, and the builders take it as given", () => {
  // Building it once and handing the same object to all four is what makes a disagreement between
  // them impossible rather than merely unlikely.
  const source = buildOrderReportSource(
    { orders: [order(), order({ created_at: "2026-07-01T09:00:00.000Z" })] },
    WHOLE_WEEK,
    NOW,
  );
  assert.equal(source.ok, true);
  assert.equal(source.orders.length, 1);
  assert.equal(source.excluded.outOfRange, 1);
  assert.equal(buildOrdersByDateReport(source).summary.orders, 1);
  assert.equal(buildOrderFulfilmentReport(source).rows.length, 1);
});

test("the wrapper the desktop bridge returns is accepted as-is", () => {
  // `listLocalCustomerOrders()` resolves to `{ orders: [...] }`, and unwrapping it at the call site
  // is one more place the shape could be got wrong.
  const wrapped = reportsFor({ orders: [order()] });
  assert.equal(wrapped.ok, true);
  assert.equal(wrapped[ORDER_REPORT.BY_DATE].summary.orders, 1);
});
