/**
 * What the bell must say about orders, and what it must never say.
 *
 * The three that matter most, and why:
 *   - an unpaid parcel outranks everything (after it leaves, the money is gone),
 *   - a list that cannot be read is an error, never an empty bell saying all is well,
 *   - the same orders at the same moment produce the same rows in the same places, so the bell does
 *     not reshuffle or duplicate itself while somebody is reading it.
 *
 * Every case pins `nowMs` explicitly. Nothing here may depend on the host's clock or timezone.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ORDER_ALERT_KIND,
  RESERVATION_EXPIRY_WARNING_MS,
  UNTOUCHED_ORDER_STEPS_MS,
  buildOrderNotifications,
  orderAlertKey,
} from "./orderNotifications.js";
import { ORDER_STATUS, PAYMENT_STATE, RESERVATION_TTL_MS } from "./orderLifecycle.js";
import { NOTIFICATION_SEVERITY, addNotification, createNotification } from "./notificationCenter.js";

const NOW = Date.UTC(2026, 7, 22, 6, 0, 0);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const agoIso = (ms) => new Date(NOW - ms).toISOString();

const order = (overrides = {}) => ({
  id: "order-1",
  order_no: "FRZ-118",
  customer_name: "Ram",
  status: ORDER_STATUS.RECEIVED,
  payment_state: PAYMENT_STATE.UNPAID,
  created_at: agoIso(5 * MINUTE),
  reserved_at: agoIso(5 * MINUTE),
  items: [{ product_id: "product-apple", quantity: 10, agreed_rate: 90 }],
  ...overrides,
});

const kinds = (items) => items.map((item) => item.kind);
const ofKind = (items, kind) => items.find((item) => item.kind === kind);

test("a packed order that has not been paid for is reported, and it sits above every other alert", () => {
  const items = buildOrderNotifications([
    // A neglected order that lost its stock hours ago — also an error, and still less urgent.
    order({ id: "order-lapsed", order_no: "FRZ-100", status: ORDER_STATUS.RECEIVED, created_at: agoIso(9 * HOUR), reserved_at: agoIso(9 * HOUR) }),
    order({ id: "order-2", order_no: "FRZ-118", status: ORDER_STATUS.PACKED, payment_state: PAYMENT_STATE.UNPAID }),
  ], NOW);

  const payment = ofKind(items, ORDER_ALERT_KIND.PAYMENT_BEFORE_SENDING);
  assert.ok(payment, "a packed, unpaid order must be reported");
  assert.equal(payment.severity, NOTIFICATION_SEVERITY.ERROR);
  assert.equal(items[0].kind, ORDER_ALERT_KIND.PAYMENT_BEFORE_SENDING, "money before goods, above a lapsed hold");
  assert.match(payment.title, /FRZ-118/);
  assert.match(payment.message, /pay/i, "the message must say what to do about the money");
});

test("the payment warning is written for a shop owner, not for a programmer", () => {
  const [item] = buildOrderNotifications([order({ status: ORDER_STATUS.PACKED })], NOW);
  assert.doesNotMatch(item.message, /payment_state|UNPAID|status=|null/);
  assert.doesNotMatch(item.title, /payment_state|UNPAID/);
});

test("a packed order that has been paid for produces no payment warning at all", () => {
  for (const paid of [PAYMENT_STATE.PAID, PAYMENT_STATE.ON_DELIVERY]) {
    const items = buildOrderNotifications([order({ status: ORDER_STATUS.PACKED, payment_state: paid })], NOW);
    assert.deepEqual(kinds(items), [], `${paid} settles the money question`);
  }
});

test("an order nobody has answered yet stays quiet, then escalates the longer it sits", () => {
  const waiting = [order({ created_at: agoIso(0), reserved_at: agoIso(0) })];
  const at = (afterMs) => buildOrderNotifications(waiting, NOW + afterMs)
    .filter((item) => item.kind === ORDER_ALERT_KIND.ORDER_UNTOUCHED);

  assert.deepEqual(at(2 * MINUTE), [], "a two-minute-old order is still in front of whoever took it");

  const [early] = at(UNTOUCHED_ORDER_STEPS_MS[0].afterMs);
  const [later] = at(UNTOUCHED_ORDER_STEPS_MS[1].afterMs);
  const [worst] = at(UNTOUCHED_ORDER_STEPS_MS[2].afterMs);
  assert.equal(early.severity, NOTIFICATION_SEVERITY.INFO);
  assert.equal(later.severity, NOTIFICATION_SEVERITY.WARNING);
  assert.equal(worst.severity, NOTIFICATION_SEVERITY.ERROR);
  assert.equal(early.id, worst.id, "escalating must upgrade the same row, not open a second one");
  assert.match(later.message, /nobody has started it/i);
});

test("a reservation about to lapse warns first, and one that has lapsed is more serious", () => {
  const held = [order({ created_at: agoIso(0), reserved_at: agoIso(0) })];
  const aboutToLapse = buildOrderNotifications(held, NOW + RESERVATION_TTL_MS - (RESERVATION_EXPIRY_WARNING_MS / 2));
  const expiring = ofKind(aboutToLapse, ORDER_ALERT_KIND.RESERVATION_EXPIRING);
  assert.ok(expiring, "the warning must come before the stock goes back, not after");
  assert.equal(expiring.severity, NOTIFICATION_SEVERITY.WARNING);
  assert.match(expiring.message, /goes back on the shelf/i);

  const alreadyLapsed = buildOrderNotifications(held, NOW + RESERVATION_TTL_MS + HOUR);
  const lapsed = ofKind(alreadyLapsed, ORDER_ALERT_KIND.RESERVATION_LAPSED);
  assert.ok(lapsed, "a hold that has already gone must be reported");
  assert.equal(lapsed.severity, NOTIFICATION_SEVERITY.ERROR, "worse than the warning that preceded it");
  assert.equal(ofKind(alreadyLapsed, ORDER_ALERT_KIND.RESERVATION_EXPIRING), undefined, "it cannot both be about to lapse and have lapsed");
  assert.match(lapsed.message, /check it is still in the shop/i);
});

test("a hold that has gone replaces the reminder to pack, rather than shouting twice about one order", () => {
  const items = buildOrderNotifications([order({ created_at: agoIso(0), reserved_at: agoIso(0) })], NOW + RESERVATION_TTL_MS + HOUR);
  assert.deepEqual(kinds(items), [ORDER_ALERT_KIND.RESERVATION_LAPSED]);
});

test("a packed order never reports a lapsed hold, because the goods are already boxed", () => {
  const items = buildOrderNotifications([
    order({ status: ORDER_STATUS.PACKED, payment_state: PAYMENT_STATE.PAID, created_at: agoIso(20 * HOUR), reserved_at: agoIso(20 * HOUR) }),
  ], NOW);
  assert.deepEqual(kinds(items), []);
});

test("delivered, cancelled, returned and sent orders produce nothing, because they are not tasks", () => {
  for (const status of [ORDER_STATUS.DELIVERED, ORDER_STATUS.CANCELLED, ORDER_STATUS.RETURNED, ORDER_STATUS.SENT]) {
    const items = buildOrderNotifications([
      order({ status, payment_state: PAYMENT_STATE.UNPAID, created_at: agoIso(30 * HOUR), reserved_at: agoIso(30 * HOUR) }),
    ], NOW);
    assert.deepEqual(kinds(items), [], `${status} is finished business`);
  }
});

test("a list that could not be read produces one loud error, never an empty bell", () => {
  for (const broken of [null, undefined, {}, "orders", 7]) {
    const items = buildOrderNotifications(broken, NOW);
    assert.equal(items.length, 1, `${String(broken)} must not read as "no orders need you"`);
    assert.equal(items[0].kind, ORDER_ALERT_KIND.ORDERS_UNREADABLE);
    assert.equal(items[0].severity, NOTIFICATION_SEVERITY.ERROR);
    assert.equal(items[0].sticky, true, "clearing the bell must not hide it");
    assert.match(items[0].message, /reopen the orders screen/i, "an error has to say what to do next");
  }
});

test("an unreadable clock is reported too, rather than being guessed at", () => {
  const items = buildOrderNotifications([order()], "not a time");
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, ORDER_ALERT_KIND.ORDERS_UNREADABLE);
});

test('order ids "004" and 4 are different orders and get a row each', () => {
  const items = buildOrderNotifications([
    order({ id: "004", order_no: "FRZ-004", status: ORDER_STATUS.PACKED }),
    order({ id: 4, order_no: "FRZ-4", status: ORDER_STATUS.PACKED }),
  ], NOW);
  assert.equal(items.length, 2, "two orders, two alerts");
  assert.notEqual(items[0].id, items[1].id);
  assert.equal(new Set(items.map((item) => item.id)).size, 2);
  assert.deepEqual(
    items.map((item) => item.id).sort(),
    [orderAlertKey(ORDER_ALERT_KIND.PAYMENT_BEFORE_SENDING, "004"), orderAlertKey(ORDER_ALERT_KIND.PAYMENT_BEFORE_SENDING, "4")].sort(),
  );
});

test("running twice over the same orders gives identical rows in identical places", () => {
  const orders = [
    order({ id: "b", order_no: "FRZ-2", status: ORDER_STATUS.PACKED }),
    order({ id: "a", order_no: "FRZ-1", status: ORDER_STATUS.PACKED }),
    order({ id: "c", order_no: "FRZ-3", created_at: agoIso(2 * HOUR), reserved_at: agoIso(2 * HOUR) }),
    order({ id: "d", order_no: "FRZ-4", created_at: agoIso(9 * HOUR), reserved_at: agoIso(9 * HOUR) }),
  ];
  const first = buildOrderNotifications(orders, NOW);
  const second = buildOrderNotifications(orders, NOW);
  assert.deepEqual(second, first, "a bell that re-runs every few seconds must not move or duplicate rows");
  assert.equal(new Set(first.map((item) => item.id)).size, first.length, "no two rows share an id");
});

test("orders that tie on severity are separated by a rule, not by chance", () => {
  // Same kind, same severity, same age: only the key can decide, and it must decide the same way twice.
  const tied = ["z-order", "a-order", "m-order"].map((id) => order({ id, order_no: id, status: ORDER_STATUS.PACKED }));
  const items = buildOrderNotifications(tied, NOW);
  assert.deepEqual(items.map((item) => item.id), [...items.map((item) => item.id)].sort());
  assert.deepEqual(buildOrderNotifications([...tied].reverse(), NOW), items, "input order must not change output order");
});

test("the worst alerts come first even when they arrive last in the list", () => {
  const items = buildOrderNotifications([
    order({ id: "fresh", order_no: "FRZ-9", created_at: agoIso(20 * MINUTE), reserved_at: agoIso(20 * MINUTE) }),
    order({ id: "lapsed", order_no: "FRZ-8", created_at: agoIso(9 * HOUR), reserved_at: agoIso(9 * HOUR) }),
    order({ id: "unpaid", order_no: "FRZ-7", status: ORDER_STATUS.PACKED }),
  ], NOW);
  assert.deepEqual(kinds(items), [
    ORDER_ALERT_KIND.PAYMENT_BEFORE_SENDING,
    ORDER_ALERT_KIND.RESERVATION_LAPSED,
    ORDER_ALERT_KIND.ORDER_UNTOUCHED,
  ]);
});

test("a status in the wrong case is still understood, so an order cannot go missing over spelling", () => {
  const items = buildOrderNotifications([order({ status: "packed", payment_state: "unpaid" })], NOW);
  assert.deepEqual(kinds(items), [ORDER_ALERT_KIND.PAYMENT_BEFORE_SENDING]);
  const paid = buildOrderNotifications([order({ status: " Packed ", payment_state: "paid" })], NOW);
  assert.deepEqual(kinds(paid), []);
});

test("timestamps arrive as ISO text, as numbers or as dates, and all three are read the same way", () => {
  const arrived = NOW - (2 * HOUR);
  const shapes = [new Date(arrived).toISOString(), arrived, new Date(arrived)];
  const severities = shapes.map((created_at) => {
    const [item] = buildOrderNotifications([order({ created_at, reserved_at: created_at })], NOW);
    return item.severity;
  });
  assert.deepEqual(severities, [NOTIFICATION_SEVERITY.WARNING, NOTIFICATION_SEVERITY.WARNING, NOTIFICATION_SEVERITY.WARNING]);
});

test("an order with no time on it is reported as unmeasured rather than assumed to be fresh", () => {
  const items = buildOrderNotifications([order({ created_at: null, reserved_at: undefined, ordered_at: "" })], NOW);
  assert.deepEqual(kinds(items), [ORDER_ALERT_KIND.ORDER_UNTOUCHED]);
  assert.equal(items[0].severity, NOTIFICATION_SEVERITY.INFO);
  assert.match(items[0].message, /no arrival time/i);
});

test("an order with no lines, no customer and no number still produces a readable row", () => {
  const items = buildOrderNotifications([
    { id: "order-bare", status: ORDER_STATUS.PACKED, payment_state: PAYMENT_STATE.UNPAID },
  ], NOW);
  assert.equal(items.length, 1);
  assert.match(items[0].title, /order-bare/);
  assert.match(items[0].message, /walk-in customer/i);
});

test("an order with no id at all is still reported, and does not merge with the next one", () => {
  const items = buildOrderNotifications([
    { order_no: "", status: ORDER_STATUS.PACKED, payment_state: PAYMENT_STATE.UNPAID },
    { order_no: "", status: ORDER_STATUS.PACKED, payment_state: PAYMENT_STATE.UNPAID },
  ], NOW);
  assert.equal(items.length, 2);
  assert.equal(new Set(items.map((item) => item.id)).size, 2);
});

test("an unrecognised status raises nothing here, because this list is not where that is explained", () => {
  const items = buildOrderNotifications([order({ status: "ON_THE_MOON" })], NOW);
  assert.deepEqual(kinds(items), []);
});

test("every item goes into the notification centre unchanged, and a repeat collapses instead of stacking", () => {
  const orders = [order({ status: ORDER_STATUS.PACKED }), order({ id: "order-late", order_no: "FRZ-2", created_at: agoIso(2 * HOUR), reserved_at: agoIso(2 * HOUR) })];
  let list = [];
  for (let tick = 0; tick < 5; tick += 1) {
    for (const item of buildOrderNotifications(orders, NOW + (tick * 1000))) {
      list = addNotification(list, createNotification(item));
    }
  }
  assert.equal(list.length, 2, "five ticks must not leave ten rows in the bell");
  assert.deepEqual(list.map((entry) => entry.count).sort(), [5, 5]);
  assert.ok(list.every((entry) => entry.id === entry.dedupeKey), "the id the centre keeps is the stable one");
});

test("severity written by this module is one the notification centre recognises", () => {
  const items = buildOrderNotifications([
    order({ status: ORDER_STATUS.PACKED }),
    order({ id: "late", order_no: "FRZ-5", created_at: agoIso(9 * HOUR), reserved_at: agoIso(9 * HOUR) }),
  ], NOW);
  const allowed = Object.values(NOTIFICATION_SEVERITY);
  items.forEach((item) => assert.ok(allowed.includes(item.severity), `${item.severity} is not a severity`));
});
