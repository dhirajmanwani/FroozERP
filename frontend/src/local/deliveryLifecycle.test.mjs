import test from "node:test";
import assert from "node:assert/strict";

import { ORDER_STATUS } from "./orderLifecycle.js";
import {
  DEFAULT_OVERDUE_MINUTES,
  DELIVERY_STATUS,
  DELIVERY_STATUS_LABEL,
  KNOWN_DELIVERY_STATUSES,
  OPEN_DELIVERY_STATUSES,
  PAID_BY,
  REASON_REQUIRED_STATUSES,
  TERMINAL_DELIVERY_STATUSES,
  canMoveDelivery,
  canStartDelivery,
  closingFinalPaise,
  deliveriesOf,
  deliveryChargePaise,
  isDeliveryOverdue,
  latestDeliveryOf,
  minutesInStatus,
  nextAttemptNo,
  nextDeliveryStatuses,
  openDeliveryOf,
  orderEffectOfDeliveryMove,
  paiseToRupees,
  rupeesToPaise,
  statusEnteredAt,
  validateDeliveryMove,
} from "./deliveryLifecycle.js";

const NOW = Date.parse("2026-11-22T12:00:00+05:30");
const minutesAgo = (minutes) => new Date(NOW - minutes * 60000).toISOString();

const delivery = (overrides = {}) => ({
  id: "d-1",
  order_id: "o-1",
  attempt_no: 1,
  status: DELIVERY_STATUS.PENDING,
  quoted_paise: 6000,
  final_paise: null,
  paid_by: PAID_BY.SHOP,
  created_at: minutesAgo(120),
  updated_at: minutesAgo(120),
  events: [],
  ...overrides,
});

const order = (overrides = {}) => ({
  id: "o-1",
  order_no: "ORD-1",
  status: ORDER_STATUS.PACKED,
  deliveries: [],
  ...overrides,
});

const LEGAL = {
  pending: ["booked", "cancelled"],
  booked: ["picked_up", "cancelled", "failed"],
  picked_up: ["delivered", "failed"],
  delivered: ["closed"],
  closed: [],
  cancelled: [],
  failed: [],
};

test("vocabulary matches the shared contract", () => {
  assert.deepEqual(Object.values(DELIVERY_STATUS), ["pending", "booked", "picked_up", "delivered", "closed", "cancelled", "failed"]);
  assert.deepEqual(DELIVERY_STATUS_LABEL, {
    pending: "Pending", booked: "Booked", picked_up: "Picked up", delivered: "Delivered", closed: "Closed", cancelled: "Cancelled", failed: "Failed",
  });
  assert.deepEqual(PAID_BY, { SHOP: "shop", CUSTOMER: "customer" });
  assert.deepEqual([...OPEN_DELIVERY_STATUSES], ["pending", "booked", "picked_up"]);
  assert.deepEqual([...TERMINAL_DELIVERY_STATUSES], ["closed", "cancelled", "failed"]);
  assert.deepEqual([...REASON_REQUIRED_STATUSES], ["cancelled", "failed"]);
  assert.ok(!OPEN_DELIVERY_STATUSES.includes("delivered") && !TERMINAL_DELIVERY_STATUSES.includes("delivered"));
});

test("every legal move is allowed and every other pair is refused", () => {
  for (const from of KNOWN_DELIVERY_STATUSES) {
    assert.deepEqual([...nextDeliveryStatuses(from)], LEGAL[from], from);
    for (const to of KNOWN_DELIVERY_STATUSES) {
      const legal = LEGAL[from].includes(to);
      assert.equal(canMoveDelivery(from, to), legal, `${from} -> ${to}`);
      const result = validateDeliveryMove({ delivery: delivery({ status: from }), to, reason: "Customer not reachable" });
      assert.equal(result.ok, legal, `${from} -> ${to}: ${result.message}`);
      if (!legal) assert.ok(result.message.length > 10, `${from} -> ${to} explains itself`);
    }
  }
});

test("unknown statuses offer no moves and are refused in words", () => {
  assert.deepEqual(nextDeliveryStatuses("shipped"), []);
  assert.deepEqual(nextDeliveryStatuses(undefined), []);
  assert.equal(canMoveDelivery("shipped", "delivered"), false);
  assert.match(validateDeliveryMove({ delivery: delivery({ status: "shipped" }), to: "delivered" }).message, /does not know/);
  assert.match(validateDeliveryMove({ delivery: delivery(), to: "teleported" }).message, /not a delivery status/);
  assert.equal(validateDeliveryMove({ delivery: null, to: "booked" }).ok, false);
});

test("refusals name the way forward", () => {
  const msg = (from, to) => validateDeliveryMove({ delivery: delivery({ status: from }), to, reason: "x" }).message;
  assert.match(msg("picked_up", "cancelled"), /mark it Failed/);
  assert.match(msg("pending", "failed"), /Cancel it/);
  assert.match(msg("pending", "picked_up"), /Booked first/);
  assert.match(msg("booked", "pending"), /cannot go back/);
  assert.match(msg("delivered", "failed"), /close it/);
  assert.match(msg("failed", "booked"), /Start a new delivery/);
  assert.match(msg("cancelled", "booked"), /Start a new delivery/);
  assert.match(msg("closed", "delivered"), /closed/);
  assert.match(msg("booked", "booked"), /already Booked/);
});

test("cancelled and failed require a non-blank reason; other moves do not", () => {
  for (const [from, to] of [["pending", "cancelled"], ["booked", "cancelled"], ["booked", "failed"], ["picked_up", "failed"]]) {
    for (const reason of [undefined, null, "", "   "]) {
      const result = validateDeliveryMove({ delivery: delivery({ status: from }), to, reason });
      assert.equal(result.ok, false, `${from} -> ${to} with ${JSON.stringify(reason)}`);
      assert.match(result.message, /why/i);
    }
    assert.equal(validateDeliveryMove({ delivery: delivery({ status: from }), to, reason: "Wrong address" }).ok, true);
  }
  assert.equal(validateDeliveryMove({ delivery: delivery({ status: "pending" }), to: "booked" }).ok, true);
  assert.equal(validateDeliveryMove({ delivery: delivery({ status: "delivered" }), to: "closed" }).ok, true);
});

test("rupeesToPaise: blank is null, junk and negatives are NaN, amounts round to the paisa", () => {
  for (const blank of [null, undefined, "", "   "]) assert.equal(rupeesToPaise(blank), null);
  for (const junk of ["abc", "12abc", "-5", -5, "1.2.3", Number.NaN, Infinity, "₹", "1e999"]) {
    assert.ok(Number.isNaN(rupeesToPaise(junk)), `junk ${String(junk)}`);
  }
  assert.equal(rupeesToPaise("0"), 0);
  assert.equal(rupeesToPaise(0), 0);
  assert.equal(rupeesToPaise("60"), 6000);
  assert.equal(rupeesToPaise(" 45.5 "), 4550);
  assert.equal(rupeesToPaise("₹1,250.75"), 125075);
  assert.equal(rupeesToPaise("12.345"), 1235);
  assert.equal(rupeesToPaise(1.005), 101);
  assert.ok(Number.isNaN(rupeesToPaise("2000000000")), "beyond the cloud's 1e11 paise limit");
  assert.ok(Number.isInteger(rupeesToPaise("19.99")));
});

test("paiseToRupees: null for no amount, never 0", () => {
  assert.equal(paiseToRupees(null), null);
  assert.equal(paiseToRupees(undefined), null);
  assert.equal(paiseToRupees(""), null);
  assert.equal(paiseToRupees("junk"), null);
  assert.equal(paiseToRupees(0), 0);
  assert.equal(paiseToRupees(4550), 45.5);
  assert.equal(paiseToRupees(125075), 1250.75);
});

test("deliveryChargePaise: final wins even at 0, else quoted, else null", () => {
  assert.equal(deliveryChargePaise(delivery({ quoted_paise: 6000, final_paise: 7500 })), 7500);
  assert.equal(deliveryChargePaise(delivery({ quoted_paise: 6000, final_paise: 0 })), 0);
  assert.equal(deliveryChargePaise(delivery({ quoted_paise: 6000, final_paise: null })), 6000);
  assert.equal(deliveryChargePaise(delivery({ quoted_paise: 6000, final_paise: "" })), 6000);
  assert.equal(deliveryChargePaise(delivery({ quoted_paise: 0, final_paise: null })), 0);
  assert.equal(deliveryChargePaise(delivery({ quoted_paise: null, final_paise: null })), null);
  assert.equal(deliveryChargePaise(null), null);
});

test("closing charge rule: blank final means quoted; a typed amount wins; junk is NaN", () => {
  const quoted = delivery({ status: "delivered", quoted_paise: 6000 });
  assert.equal(closingFinalPaise(quoted, ""), 6000);
  assert.equal(closingFinalPaise(quoted, "   "), 6000);
  assert.equal(closingFinalPaise(quoted, null), 6000);
  assert.equal(closingFinalPaise(quoted, undefined), 6000);
  assert.equal(closingFinalPaise(quoted, "72"), 7200);
  assert.equal(closingFinalPaise(quoted, "0"), 0, "a typed zero is a real answer");
  assert.ok(Number.isNaN(closingFinalPaise(quoted, "sixty")));
  assert.equal(closingFinalPaise(delivery({ quoted_paise: null }), ""), null);
  // A final recorded earlier is kept rather than overwritten by the quote (matches the Rust rule).
  assert.equal(closingFinalPaise(delivery({ quoted_paise: 6000, final_paise: 8000 }), ""), 8000);
  assert.equal(closingFinalPaise(delivery({ quoted_paise: 6000, final_paise: 0 }), ""), 0);
});

test("statusEnteredAt: latest event into the current status, then the stamp, then updated/created", () => {
  const events = [
    { id: "e1", to_status: "pending", at: minutesAgo(90) },
    { id: "e2", from_status: "pending", to_status: "booked", at: minutesAgo(50) },
    { id: "e3", from_status: "booked", to_status: "booked", at: minutesAgo(20) },
  ];
  assert.equal(statusEnteredAt(delivery({ status: "booked", events })), minutesAgo(20));
  assert.equal(statusEnteredAt(delivery({ status: "booked", events: [], booked_at: minutesAgo(33) })), minutesAgo(33));
  assert.equal(statusEnteredAt(delivery({ status: "booked", events: [], updated_at: minutesAgo(7) })), minutesAgo(7));
  assert.equal(statusEnteredAt(delivery({ status: "pending", events: [], created_at: minutesAgo(9), updated_at: null })), minutesAgo(9));
  assert.equal(statusEnteredAt(delivery({ status: "booked", events: [{ to_status: "booked", at: "nonsense" }], updated_at: minutesAgo(4) })), minutesAgo(4));
  assert.equal(statusEnteredAt(delivery({ status: "booked", events: [], created_at: "x", updated_at: "y" })), null);
  assert.equal(statusEnteredAt(null), null);
});

test("overdue flag: 44 minutes is not overdue, 46 is; only open statuses; unreadable time is never red", () => {
  for (const status of OPEN_DELIVERY_STATUSES) {
    const at44 = delivery({ status, events: [{ to_status: status, at: minutesAgo(44) }] });
    const at46 = delivery({ status, events: [{ to_status: status, at: minutesAgo(46) }] });
    assert.equal(minutesInStatus(at44, NOW), 44);
    assert.equal(isDeliveryOverdue(at44, NOW), false, `${status} at 44`);
    assert.equal(isDeliveryOverdue(at46, NOW), true, `${status} at 46`);
    assert.equal(isDeliveryOverdue(at46, NOW, 60), false, "custom threshold");
    assert.equal(isDeliveryOverdue(at46, NOW, "junk"), true, "bad threshold falls back to 45");
  }
  assert.equal(DEFAULT_OVERDUE_MINUTES, 45);
  for (const status of ["delivered", "closed", "cancelled", "failed"]) {
    assert.equal(isDeliveryOverdue(delivery({ status, events: [{ to_status: status, at: minutesAgo(300) }] }), NOW), false, status);
  }
  const unreadable = delivery({ status: "booked", events: [], created_at: null, updated_at: null });
  assert.equal(minutesInStatus(unreadable, NOW), null);
  assert.equal(isDeliveryOverdue(unreadable, NOW), false);
});

test("deliveriesOf / openDeliveryOf / latestDeliveryOf read attempts in order", () => {
  const first = delivery({ id: "a", attempt_no: 1, status: "failed" });
  const second = delivery({ id: "b", attempt_no: 2, status: "booked" });
  const subject = order({ deliveries: [second, null, first] });
  assert.deepEqual(deliveriesOf(subject).map((entry) => entry.id), ["a", "b"]);
  assert.equal(openDeliveryOf(subject).id, "b");
  assert.equal(latestDeliveryOf(subject).id, "b");
  assert.deepEqual(deliveriesOf(order({ deliveries: undefined })), []);
  assert.equal(openDeliveryOf(order()), null);
  assert.equal(latestDeliveryOf(order()), null);
  // An attempt with an unreadable number is kept, last.
  assert.deepEqual(deliveriesOf(order({ deliveries: [delivery({ id: "z", attempt_no: null }), first] })).map((entry) => entry.id), ["a", "z"]);
});

test("re-booking: attempt 2 after a failed attempt and after a cancelled one", () => {
  assert.equal(nextAttemptNo(order()), 1);
  assert.deepEqual(canStartDelivery(order()), { ok: true, message: "" });

  const failed = order({ status: ORDER_STATUS.SENT, deliveries: [delivery({ status: "failed", status_reason: "Not home" })] });
  assert.equal(canStartDelivery(failed).ok, true);
  assert.equal(nextAttemptNo(failed), 2);

  const cancelled = order({ status: ORDER_STATUS.PACKED, deliveries: [delivery({ status: "cancelled", status_reason: "Rider did not come" })] });
  assert.equal(canStartDelivery(cancelled).ok, true);
  assert.equal(nextAttemptNo(cancelled), 2);

  const third = order({ status: ORDER_STATUS.SENT, deliveries: [delivery({ attempt_no: 1, status: "failed" }), delivery({ id: "d-2", attempt_no: 2, status: "cancelled" })] });
  assert.equal(nextAttemptNo(third), 3);
});

test("canStartDelivery refuses with a reason", () => {
  for (const status of OPEN_DELIVERY_STATUSES) {
    const result = canStartDelivery(order({ deliveries: [delivery({ status })] }));
    assert.equal(result.ok, false, status);
    assert.match(result.message, /attempt 1 is still/);
  }
  assert.match(canStartDelivery(order({ status: ORDER_STATUS.RECEIVED })).message, /Pack the order/);
  assert.equal(canStartDelivery(order({ status: ORDER_STATUS.DELIVERED })).ok, false);
  assert.equal(canStartDelivery(order({ status: ORDER_STATUS.CANCELLED })).ok, false);
  assert.equal(canStartDelivery(order({ status: ORDER_STATUS.RETURNED })).ok, false);
  assert.match(canStartDelivery(order({ deleted_at: "2026-11-22T05:00:00Z" })).message, /deleted/);
  assert.equal(canStartDelivery(null).ok, false);
  assert.equal(canStartDelivery(order({ status: ORDER_STATUS.SENT, deliveries: [delivery({ status: "delivered" })] })).ok, false);
  assert.equal(canStartDelivery(order({ status: ORDER_STATUS.SENT, deliveries: [delivery({ status: "closed" })] })).ok, false);
  assert.equal(canStartDelivery(order({ status: "packed" })).ok, true, "order status case does not matter");
  // Ids are opaque: "004" is an id, and is never coerced.
  assert.equal(canStartDelivery(order({ id: "004" })).ok, true);
});

test("order effects: picked up sends a packed order; delivered delivers a sent order; nothing else", () => {
  assert.deepEqual(orderEffectOfDeliveryMove({ order: order({ status: ORDER_STATUS.PACKED }), to: "picked_up" }), { orderTo: "SENT" });
  assert.deepEqual(orderEffectOfDeliveryMove({ order: order({ status: ORDER_STATUS.SENT }), to: "delivered" }), { orderTo: "DELIVERED" });
  assert.equal(orderEffectOfDeliveryMove({ order: order({ status: ORDER_STATUS.SENT }), to: "picked_up" }), null, "already sent");
  assert.equal(orderEffectOfDeliveryMove({ order: order({ status: ORDER_STATUS.PACKED }), to: "delivered" }), null);
  for (const to of ["booked", "failed", "cancelled", "closed", "pending"]) {
    assert.equal(orderEffectOfDeliveryMove({ order: order({ status: ORDER_STATUS.PACKED }), to }), null, `packed + ${to}`);
    assert.equal(orderEffectOfDeliveryMove({ order: order({ status: ORDER_STATUS.SENT }), to }), null, `sent + ${to}`);
  }
  assert.equal(orderEffectOfDeliveryMove({}), null);
});
