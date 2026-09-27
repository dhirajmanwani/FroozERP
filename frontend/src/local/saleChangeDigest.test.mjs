// The laptop is IST. Set before any Date is read, so the local-day tests exercise the real zone the
// shop runs in rather than whatever the CI box happens to be.
process.env.TZ = "Asia/Kolkata";

import test from "node:test";
import assert from "node:assert/strict";

import {
  SALE_CHANGES_UNREADABLE_KEY,
  SaleChangeEventsError,
  buildSaleChangeDigest,
  formatInr,
  normalizeCloudChangeEvents,
  normalizeLocalChangeRows,
  parseUtcTimestamp,
  saleChangeDigestBellItems,
} from "./saleChangeDigest.js";
import { createNotification } from "./notificationCenter.js";

const cloudEvent = (overrides = {}) => ({
  action: "cancel",
  sale_id: "004",
  invoice_no: "INV-0004",
  old_total: "1000.50",
  new_total: null,
  reason: "Duplicate bill",
  at: "2026-09-27T06:30:00.000Z",
  by_name: "Ravi",
  approved_by_name: "Asha Owner",
  ...overrides,
});

const localInvoice = (overrides = {}) => ({
  invoice: {
    id: "invoice-dev1-0001",
    invoice_global_id: "invoice-dev1-0001",
    offline_invoice_ref: "OFF-0001",
    server_invoice_no: null,
    user_id: "7",
    status: "COMPLETED",
    net_total: 250,
    created_at: "2026-09-27T04:00:00.000Z",
    updated_at: "2026-09-27T04:00:00.000Z",
    edit_reason: null,
    cancellation_reason: null,
    cancelled_by: null,
    cancelled_at: null,
    ...overrides,
  },
  items: [],
  payments: [],
});

test("timestamps with no zone are UTC; offsets and Z are honoured", () => {
  const utc = Date.UTC(2026, 8, 26, 20, 0, 0);
  assert.equal(parseUtcTimestamp("2026-09-26 20:00:00"), utc);
  assert.equal(parseUtcTimestamp("2026-09-26T20:00:00"), utc);
  assert.equal(parseUtcTimestamp("2026-09-26T20:00"), utc);
  assert.equal(parseUtcTimestamp("2026-09-26T20:00:00Z"), utc);
  assert.equal(parseUtcTimestamp("2026-09-26T20:00:00.000Z"), utc);
  assert.equal(parseUtcTimestamp("2026-09-26 20:00:00.123456"), utc + 123);
  assert.equal(parseUtcTimestamp("2026-09-26 20:00:00+00"), utc);
  assert.equal(parseUtcTimestamp("2026-09-27 01:30:00+05:30"), utc);
  assert.equal(parseUtcTimestamp("2026-09-27T01:30:00+0530"), utc);
  assert.equal(parseUtcTimestamp("2026-09-26"), Date.UTC(2026, 8, 26));
  assert.equal(parseUtcTimestamp(utc), utc);
  assert.equal(parseUtcTimestamp(new Date(utc)), utc);
  for (const bad of ["", "   ", "yesterday", "2026-13-45 99:99", null, undefined, Number.NaN, {}, new Date("x")]) {
    assert.equal(parseUtcTimestamp(bad), null, String(bad));
  }
});

test("cloud events normalise to the event shape, ids stay strings, money is 2dp numbers", () => {
  const events = normalizeCloudChangeEvents({ events: [
    cloudEvent(),
    cloudEvent({ action: "EDIT", sale_id: 12, invoice_no: 9001, old_total: 500, new_total: "450.126", by_name: " Asha ", approved_by_name: null, reason: " Wrong item or rate " }),
  ] });
  assert.deepEqual(events[0], {
    action: "cancel",
    saleId: "004",
    invoiceNo: "INV-0004",
    oldTotal: 1000.5,
    newTotal: null,
    reason: "Duplicate bill",
    atMs: Date.UTC(2026, 8, 27, 6, 30),
    byName: "Ravi",
    approvedByName: "Asha Owner",
  });
  assert.deepEqual(events[1], {
    action: "edit",
    saleId: "12",
    invoiceNo: "9001",
    oldTotal: 500,
    newTotal: 450.13,
    reason: "Wrong item or rate",
    atMs: Date.UTC(2026, 8, 27, 6, 30),
    byName: "Asha",
    approvedByName: "",
  });
  assert.deepEqual(normalizeCloudChangeEvents({ events: [] }), []);
});

test("a bad cloud payload throws instead of reading as no changes", () => {
  for (const payload of [null, undefined, "x", [], {}, { events: null }, { events: {} }]) {
    assert.throws(() => normalizeCloudChangeEvents(payload), SaleChangeEventsError, JSON.stringify(payload));
  }
  assert.throws(() => normalizeCloudChangeEvents({ events: [null] }), SaleChangeEventsError);
  assert.throws(() => normalizeCloudChangeEvents({ events: [cloudEvent({ action: "refund" })] }), /no cancel or edit action/);
  assert.throws(() => normalizeCloudChangeEvents({ events: [cloudEvent({ at: "soon" })] }), /no readable time/);
  const error = (() => { try { normalizeCloudChangeEvents({}); } catch (caught) { return caught; } })();
  assert.equal(error.code, "SALE_CHANGE_EVENTS_UNREADABLE");
});

test("local rows: cancelled bills are cancels at cancelled_at, edited bills are edits at updated_at", () => {
  const events = normalizeLocalChangeRows([
    localInvoice(),
    localInvoice({
      id: "invoice-dev1-0002", offline_invoice_ref: "OFF-0002", status: "CANCELLED", net_total: 0,
      cancellation_reason: "Customer refused", cancelled_by: "004", cancelled_at: "2026-09-27T05:00:00.000Z",
      updated_at: "2026-09-27T05:00:00.000Z",
    }),
    localInvoice({
      id: "invoice-dev1-0003", server_invoice_no: "S-77", edit_reason: "Other: scale broke", net_total: "310.40",
      updated_at: "2026-09-27 06:15:00",
    }),
  ], { userNamesById: new Map([["004", "Ravi"], ["7", "Asha"]]) });
  assert.equal(events.length, 2, "an unchanged bill is not an event");
  assert.deepEqual(events[0], {
    action: "cancel",
    saleId: "invoice-dev1-0002",
    invoiceNo: "OFF-0002",
    oldTotal: 0,
    newTotal: null,
    reason: "Customer refused",
    atMs: Date.UTC(2026, 8, 27, 5, 0),
    byName: "Ravi",
    approvedByName: "",
  });
  assert.deepEqual(events[1], {
    action: "edit",
    saleId: "invoice-dev1-0003",
    invoiceNo: "S-77",
    oldTotal: null,
    newTotal: 310.4,
    reason: "Other: scale broke",
    atMs: Date.UTC(2026, 8, 27, 6, 15),
    byName: "Asha",
    approvedByName: "",
  });
});

test("local rows: user ids are never coerced; '004' and 4 are different people", () => {
  const events = normalizeLocalChangeRows([
    localInvoice({ status: "CANCELLED", cancelled_by: "004", cancelled_at: "2026-09-27T05:00:00Z" }),
    localInvoice({ id: "b", status: "CANCELLED", cancelled_by: 4, cancelled_at: "2026-09-27T05:00:00Z" }),
  ], { userNamesById: { "004": "Ravi" } });
  assert.equal(events[0].byName, "Ravi");
  assert.equal(events[1].byName, "4", "an id with no name shows as the id, not as Ravi");
});

test("local rows: mapped invoices (localSnapshotToInvoice output) read the same", () => {
  const [event] = normalizeLocalChangeRows([{
    id: "invoice-x", sale_id: "invoice-x", invoice_no: "OFF-9", sale_status: "CANCELLED", total_amount: 99.9,
    cancelled_at: null, updated_at: "2026-09-27T05:00:00Z", cancellation_reason: "Duplicate bill", user_id: "7",
  }]);
  assert.equal(event.action, "cancel");
  assert.equal(event.invoiceNo, "OFF-9");
  assert.equal(event.oldTotal, 99.9);
  assert.equal(event.atMs, Date.UTC(2026, 8, 27, 5, 0), "falls back to updated_at when cancelled_at is missing");
  assert.equal(event.byName, "7");
});

test("local rows: a cancelled bill that was edited counts once, as a cancel", () => {
  const events = normalizeLocalChangeRows([localInvoice({
    status: "CANCELLED", edit_reason: "Wrong item or rate", cancelled_at: "2026-09-27T05:00:00Z",
  })]);
  assert.deepEqual(events.map((event) => event.action), ["cancel"]);
});

test("local rows: unreadable input throws", () => {
  for (const bad of [null, undefined, {}, "x"]) assert.throws(() => normalizeLocalChangeRows(bad), SaleChangeEventsError);
  assert.throws(() => normalizeLocalChangeRows([null]), SaleChangeEventsError);
  assert.throws(() => normalizeLocalChangeRows([localInvoice({ status: "CANCELLED", cancelled_at: "??", updated_at: "" })]), /could not be read/);
  assert.deepEqual(normalizeLocalChangeRows([]), []);
});

test("the digest buckets by the device's local day, not the UTC day", () => {
  // 26 Sep 20:00 UTC is 27 Sep 01:30 IST: today's, although toISOString says the 26th.
  const events = normalizeCloudChangeEvents({ events: [
    cloudEvent({ at: "2026-09-26T20:00:00Z", old_total: 100 }),
    // 26 Sep 18:00 UTC is 26 Sep 23:30 IST: yesterday's.
    cloudEvent({ at: "2026-09-26T18:00:00Z", old_total: 999 }),
    // 27 Sep 19:00 UTC is 28 Sep 00:30 IST: tomorrow's.
    cloudEvent({ at: "2026-09-27T19:00:00Z", old_total: 555 }),
  ] });
  const digest = buildSaleChangeDigest({ events, dateKey: "2026-09-27" });
  assert.equal(digest.cancelledCount, 1);
  assert.equal(digest.cancelledAmount, 100);
  assert.equal(buildSaleChangeDigest({ events, dateKey: "2026-09-26" }).cancelledAmount, 999);
  assert.equal(buildSaleChangeDigest({ events, dateKey: "2026-09-28" }).cancelledAmount, 555);
});

test("the digest counts cancels, edits, the cancelled amount, people and approvals", () => {
  const events = normalizeCloudChangeEvents({ events: [
    cloudEvent({ old_total: "400.10", by_name: "Ravi", approved_by_name: "Owner" }),
    cloudEvent({ old_total: 0.1, by_name: "Ravi", approved_by_name: "" }),
    cloudEvent({ old_total: 0.2, by_name: "Ravi", approved_by_name: "Owner" }),
    cloudEvent({ action: "edit", old_total: 50, new_total: 40, by_name: "Asha", approved_by_name: "Admin" }),
    cloudEvent({ action: "edit", by_name: "", approved_by_name: "" }),
  ] });
  const digest = buildSaleChangeDigest({ events, dateKey: "2026-09-27" });
  assert.deepEqual(digest, {
    dateKey: "2026-09-27",
    totalCount: 5,
    cancelledCount: 3,
    cancelledAmount: 400.4,
    cancelledAmountUnreadable: 0,
    editedCount: 2,
    approvedCount: 3,
    approvedCancelledCount: 2,
    approvedEditedCount: 1,
    byPerson: [
      { name: "Ravi", count: 3, cancelled: 3, edited: 0 },
      { name: "Asha", count: 1, cancelled: 0, edited: 1 },
      { name: "Unknown", count: 1, cancelled: 0, edited: 1 },
    ],
  });
});

test("an unreadable cancelled total makes the amount unknown, never a smaller sum", () => {
  const events = normalizeCloudChangeEvents({ events: [
    cloudEvent({ old_total: 100 }),
    cloudEvent({ old_total: null }),
  ] });
  const digest = buildSaleChangeDigest({ events, dateKey: "2026-09-27" });
  assert.equal(digest.cancelledCount, 2);
  assert.equal(digest.cancelledAmount, null);
  assert.equal(digest.cancelledAmountUnreadable, 1);
  const { items } = saleChangeDigestBellItems(digest, { dateKey: "2026-09-27" });
  assert.equal(items[0].title, "Today: 2 bills cancelled (amount could not be read)");
  assert.doesNotMatch(items[0].title, /₹0/);
});

test("a digest with no changes on the day is all zeros", () => {
  const digest = buildSaleChangeDigest({ events: [], dateKey: "2026-09-27" });
  assert.equal(digest.totalCount, 0);
  assert.equal(digest.cancelledAmount, 0);
  assert.deepEqual(digest.byPerson, []);
});

test("the digest refuses unreadable input", () => {
  assert.throws(() => buildSaleChangeDigest({ events: null, dateKey: "2026-09-27" }), SaleChangeEventsError);
  assert.throws(() => buildSaleChangeDigest({ events: [], dateKey: "2026-02-30" }), SaleChangeEventsError);
  assert.throws(() => buildSaleChangeDigest({ events: [] }), SaleChangeEventsError);
  assert.throws(() => buildSaleChangeDigest(), SaleChangeEventsError);
});

test("INR always shows two decimals", () => {
  assert.equal(formatInr(1240), "₹1,240.00");
  assert.equal(formatInr(120000.5), "₹1,20,000.50");
  assert.equal(formatInr(0), "₹0.00");
  assert.equal(formatInr(0.005), "₹0.01");
  assert.equal(formatInr(null), "");
  assert.equal(formatInr("12"), "");
  assert.equal(formatInr(Number.NaN), "");
});

const digestOf = (events, dateKey = "2026-09-27") => buildSaleChangeDigest({ events: normalizeCloudChangeEvents({ events }), dateKey });

test("bell: no item when there were no changes", () => {
  assert.deepEqual(saleChangeDigestBellItems(digestOf([]), { dateKey: "2026-09-27" }), { status: "ok", message: "", keys: [], items: [] });
});

test("bell: one item keyed by the day, with a short title and the people", () => {
  const digest = digestOf([
    cloudEvent({ old_total: 1000, by_name: "Ravi", approved_by_name: "" }),
    cloudEvent({ old_total: 200, by_name: "Ravi", approved_by_name: "" }),
    cloudEvent({ old_total: 40, by_name: "Ravi", approved_by_name: "" }),
    cloudEvent({ action: "edit", by_name: "Asha", approved_by_name: "" }),
  ]);
  const result = saleChangeDigestBellItems(digest, { dateKey: "2026-09-27", nowMs: Date.UTC(2026, 8, 27, 7, 0) });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.keys, ["sale-changes:2026-09-27"]);
  assert.deepEqual(result.items, [{
    id: "sale-changes:2026-09-27",
    dedupeKey: "sale-changes:2026-09-27",
    severity: "info",
    title: "Today: 3 bills cancelled (₹1,240.00), 1 edited",
    message: "By Ravi (3), Asha (1)",
    source: "Sales",
    at: "2026-09-27T07:00:00.000Z",
    sticky: false,
  }]);
  // The item is ready for the notification centre.
  const notification = createNotification(result.items[0]);
  assert.equal(notification.dedupeKey, "sale-changes:2026-09-27");
});

test("bell: singulars, edits only, approvals and this-counter scope", () => {
  const one = saleChangeDigestBellItems(digestOf([cloudEvent({ old_total: 99.5, approved_by_name: "Owner" })]), { dateKey: "2026-09-27" });
  assert.equal(one.items[0].title, "Today: 1 bill cancelled (₹99.50)");
  assert.equal(one.items[0].message, "By Ravi (1) · 1 approved");
  assert.equal(one.items[0].at, undefined);

  const edits = saleChangeDigestBellItems(digestOf([
    cloudEvent({ action: "edit", approved_by_name: "" }),
    cloudEvent({ action: "edit", approved_by_name: "" }),
  ]), { dateKey: "2026-09-27", scope: "this-counter" });
  assert.equal(edits.items[0].title, "Today: 2 bills edited");
  assert.equal(edits.items[0].message, "By Ravi (2) · this counter only");

  const oneEdit = saleChangeDigestBellItems(digestOf([cloudEvent({ action: "edit", approved_by_name: "" })]), { dateKey: "2026-09-27" });
  assert.equal(oneEdit.items[0].title, "Today: 1 bill edited");
});

test("bell: a past day is named rather than called Today", () => {
  const digest = digestOf([cloudEvent({ at: "2026-09-26T06:00:00Z", old_total: 10, approved_by_name: "" })], "2026-09-26");
  const result = saleChangeDigestBellItems(digest, { dateKey: "2026-09-26", todayKey: "2026-09-27" });
  assert.equal(result.items[0].title, "26 Sep: 1 bill cancelled (₹10.00)");
  assert.equal(result.keys[0], "sale-changes:2026-09-26");
  const same = saleChangeDigestBellItems(digest, { dateKey: "2026-09-26", todayKey: "2026-09-26" });
  assert.match(same.items[0].title, /^Today:/);
});

test("bell: a failure is one sticky error row, never a count", () => {
  for (const failure of ["Network Error", new Error("Network Error"), { message: "Network Error" }]) {
    const result = saleChangeDigestBellItems(null, { dateKey: "2026-09-27", failure });
    assert.equal(result.status, "unreadable");
    assert.deepEqual(result.keys, [SALE_CHANGES_UNREADABLE_KEY]);
    assert.equal(result.items.length, 1);
    const [item] = result.items;
    assert.equal(item.dedupeKey, "sale-changes:unreadable");
    assert.equal(item.id, "sale-changes:unreadable");
    assert.equal(item.severity, "error");
    assert.equal(item.sticky, true);
    assert.equal(item.title, "Today's cancelled and edited bills could not be read");
    assert.match(item.message, /^Network Error /);
    assert.doesNotMatch(`${item.title} ${item.message}`, /\b0\b|₹/);
  }
  // A failure wins even over a digest.
  const withDigest = saleChangeDigestBellItems(digestOf([cloudEvent()]), { dateKey: "2026-09-27", failure: "boom" });
  assert.equal(withDigest.status, "unreadable");
  // A thrown SaleChangeEventsError passes straight through.
  const thrown = (() => { try { normalizeCloudChangeEvents({}); } catch (caught) { return caught; } })();
  assert.match(saleChangeDigestBellItems(null, { dateKey: "2026-09-27", failure: thrown }).items[0].message, /could not be read/);
});

test("bell: no digest and no failure is still an error, and the scope is said", () => {
  const result = saleChangeDigestBellItems(null, { dateKey: "2026-09-27", scope: "this-counter" });
  assert.equal(result.status, "unreadable");
  assert.match(result.items[0].message, /this counter only$/);
  assert.equal(saleChangeDigestBellItems({ totalCount: "3" }, { dateKey: "2026-09-27" }).status, "unreadable");
  assert.equal(saleChangeDigestBellItems(digestOf([]), { dateKey: "not-a-day" }).status, "unreadable");
});

test("end to end from this counter's bills", () => {
  const invoices = [
    localInvoice({ id: "a", status: "CANCELLED", net_total: 1000, cancelled_by: "1", cancelled_at: "2026-09-26T20:00:00Z" }),
    localInvoice({ id: "b", status: "CANCELLED", net_total: 240, cancelled_by: "1", cancelled_at: "2026-09-27T10:00:00Z" }),
    localInvoice({ id: "c", edit_reason: "Payment issue", user_id: "2", updated_at: "2026-09-27 11:00:00" }),
    localInvoice({ id: "d", status: "CANCELLED", net_total: 5000, cancelled_by: "1", cancelled_at: "2026-09-26T10:00:00Z" }),
  ];
  const events = normalizeLocalChangeRows(invoices, { userNamesById: { 1: "Ravi", 2: "Asha" } });
  const digest = buildSaleChangeDigest({ events, dateKey: "2026-09-27" });
  const { items } = saleChangeDigestBellItems(digest, { dateKey: "2026-09-27", scope: "this-counter" });
  assert.equal(items[0].title, "Today: 2 bills cancelled (₹1,240.00), 1 edited");
  assert.equal(items[0].message, "By Ravi (2), Asha (1) · this counter only");
});
