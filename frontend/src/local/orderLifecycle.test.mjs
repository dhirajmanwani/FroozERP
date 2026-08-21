import test from "node:test";
import assert from "node:assert/strict";

import {
  ORDER_STATUS,
  RESERVATION_STATE,
  RESERVATION_TTL_MS,
  availableQuantity,
  canTransition,
  isHoldingStock,
  nextStatuses,
  ordersNeedingAttention,
  reservationState,
  reservedQuantityByProduct,
  transitionRefusal,
} from "./orderLifecycle.js";

const NOW = Date.parse("2026-08-21T12:00:00+05:30");
const agoMs = (ms) => new Date(NOW - ms).toISOString();

const order = (overrides = {}) => ({
  id: 1,
  order_no: "ORD-1",
  customer_name: "Ram",
  status: ORDER_STATUS.RECEIVED,
  reserved_at: agoMs(60 * 1000),
  items: [{ product_id: "product-apple", quantity: 10 }],
  ...overrides,
});

test("an order walks received to packed to sent to delivered", () => {
  assert.ok(canTransition(ORDER_STATUS.RECEIVED, ORDER_STATUS.PACKED));
  assert.ok(canTransition(ORDER_STATUS.PACKED, ORDER_STATUS.SENT));
  assert.ok(canTransition(ORDER_STATUS.SENT, ORDER_STATUS.DELIVERED));
});

test("a sent order cannot be un-sent, and the refusal says what to do instead", () => {
  // Sending raises the bill and moves the stock. Undoing that is a sale return — a recorded event
  // with money attached — not an edit to a status field.
  assert.equal(canTransition(ORDER_STATUS.SENT, ORDER_STATUS.PACKED), false);
  assert.match(transitionRefusal(ORDER_STATUS.SENT, ORDER_STATUS.PACKED), /sale return/i);
  assert.match(transitionRefusal(ORDER_STATUS.SENT, ORDER_STATUS.CANCELLED), /sale return/i);
});

test("a refusal names the alternative rather than only saying no", () => {
  for (const [from, to] of [
    [ORDER_STATUS.CANCELLED, ORDER_STATUS.PACKED],
    [ORDER_STATUS.DELIVERED, ORDER_STATUS.SENT],
    [ORDER_STATUS.SENT, ORDER_STATUS.RECEIVED],
  ]) {
    const message = transitionRefusal(from, to);
    assert.ok(message.length > 0, `${from} -> ${to} must be refused`);
    assert.doesNotMatch(message, /^An order cannot go/, `${from} -> ${to} deserves a specific message`);
  }
});

test("an allowed move produces no refusal message", () => {
  assert.equal(transitionRefusal(ORDER_STATUS.RECEIVED, ORDER_STATUS.PACKED), "");
});

test("an unknown status offers no moves rather than throwing", () => {
  assert.deepEqual(nextStatuses("NONSENSE"), []);
  assert.match(transitionRefusal("NONSENSE", ORDER_STATUS.SENT), /not a status/i);
});

test("a fresh order holds its stock", () => {
  assert.equal(reservationState(order(), NOW), RESERVATION_STATE.ACTIVE);
  assert.equal(isHoldingStock(order(), NOW), true);
});

test("an unpacked order lapses after six hours, and is not cancelled", () => {
  // The customer is still waiting. Releasing the stock is right; deciding on their behalf that
  // they no longer want it is not.
  const stale = order({ reserved_at: agoMs(RESERVATION_TTL_MS + 1000) });
  assert.equal(reservationState(stale, NOW), RESERVATION_STATE.LAPSED);
  assert.equal(isHoldingStock(stale, NOW), false);
  assert.equal(stale.status, ORDER_STATUS.RECEIVED, "the order itself must not change");
});

test("a packed order never lapses, however old", () => {
  // Packing is a box on the floor, not a promise. Lapsing it would put stock back on the books
  // that is demonstrably not on the shelf.
  const old = order({ status: ORDER_STATUS.PACKED, reserved_at: agoMs(RESERVATION_TTL_MS * 10) });
  assert.equal(reservationState(old, NOW), RESERVATION_STATE.ACTIVE);
});

test("sent stock is consumed, not released", () => {
  // Two different things that both read as "no longer reserved". Only one means the fruit is
  // available again, and it is not this one.
  for (const status of [ORDER_STATUS.SENT, ORDER_STATUS.DELIVERED, ORDER_STATUS.RETURNED]) {
    assert.equal(reservationState(order({ status }), NOW), RESERVATION_STATE.CONSUMED);
  }
  assert.equal(reservationState(order({ status: ORDER_STATUS.CANCELLED }), NOW), RESERVATION_STATE.RELEASED);
});

test("an order with no reservation timestamp is treated as holding, not as lapsed", () => {
  // Fails towards holding stock. Guessing "lapsed" would free fruit that an order is relying on.
  assert.equal(reservationState(order({ reserved_at: null, created_at: null }), NOW), RESERVATION_STATE.ACTIVE);
});

test("reserved quantities add up across orders, per product", () => {
  const totals = reservedQuantityByProduct([
    order({ id: 1, items: [{ product_id: "product-apple", quantity: 10 }] }),
    order({ id: 2, items: [{ product_id: "product-apple", quantity: 5 }, { product_id: "product-banana", quantity: 3 }] }),
  ], NOW);
  assert.equal(totals.get("product-apple"), 15);
  assert.equal(totals.get("product-banana"), 3);
});

test("cancelled and lapsed orders release their stock from the total", () => {
  const totals = reservedQuantityByProduct([
    order({ id: 1, items: [{ product_id: "product-apple", quantity: 10 }] }),
    order({ id: 2, status: ORDER_STATUS.CANCELLED, items: [{ product_id: "product-apple", quantity: 99 }] }),
    order({ id: 3, reserved_at: agoMs(RESERVATION_TTL_MS + 1), items: [{ product_id: "product-apple", quantity: 99 }] }),
    order({ id: 4, status: ORDER_STATUS.SENT, items: [{ product_id: "product-apple", quantity: 99 }] }),
  ], NOW);
  assert.equal(totals.get("product-apple"), 10);
});

test("product ids are never numerically coerced", () => {
  // CLAUDE.md names this as a bug that already emptied the Inventory table once: "004" and 4 are
  // different products, and Number() silently merges them.
  const totals = reservedQuantityByProduct([
    order({ id: 1, items: [{ product_id: "004", quantity: 2 }] }),
    order({ id: 2, items: [{ product_id: "4", quantity: 7 }] }),
  ], NOW);
  assert.equal(totals.get("004"), 2);
  assert.equal(totals.get("4"), 7);
});

test("available stock is on-hand minus reserved", () => {
  const result = availableQuantity({ onHand: 25, reserved: 10 });
  assert.equal(result.available, 15);
  assert.equal(result.oversold, false);
});

test("promising more than you hold is reported, not hidden behind a zero", () => {
  // A clamp with nothing to say is how "we have none" and "we have promised fruit we do not own"
  // become the same screen. The second needs somebody to act before a customer finds out.
  const result = availableQuantity({ onHand: 5, reserved: 12 });
  assert.equal(result.available, 0);
  assert.equal(result.oversold, true);
  assert.equal(result.shortfall, 7);
});

test("non-numeric stock figures read as zero rather than NaN", () => {
  const result = availableQuantity({ onHand: undefined, reserved: "abc" });
  assert.equal(result.available, 0);
  assert.ok(!Number.isNaN(result.available));
});

test("a lapsed order is listed for attention with an instruction", () => {
  const flagged = ordersNeedingAttention([
    order({ id: 1 }),
    order({ id: 2, order_no: "ORD-2", reserved_at: agoMs(RESERVATION_TTL_MS + 1) }),
  ], NOW);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].orderNo, "ORD-2");
  assert.match(flagged[0].reason, /Check it is still in the shop/);
});
