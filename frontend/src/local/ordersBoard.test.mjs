import test from "node:test";
import assert from "node:assert/strict";

import { ORDER_STATUS, RESERVATION_STATE, RESERVATION_TTL_MS } from "./orderLifecycle.js";
import { buildOrdersBoard, orderValue, presentOrder, validateOrderAction } from "./ordersBoard.js";

const NOW = Date.parse("2026-08-21T12:00:00+05:30");
const agoMs = (ms) => new Date(NOW - ms).toISOString();

const order = (overrides = {}) => ({
  id: "order-1",
  order_no: "ORD-1",
  customer_name: "Ram",
  status: ORDER_STATUS.RECEIVED,
  // Settled by default so tests about other things are not all about payment. The money gate has
  // its own tests below.
  payment_state: "ON_DELIVERY",
  reserved_at: agoMs(60 * 1000),
  items: [{ product_id: "004", product_name: "Apple", quantity: 10, agreed_rate: 80 }],
  ...overrides,
});

test("an order is worth what the customer was quoted", () => {
  // Not today's counter rate. Produce rates move daily and a customer quoted 80 on Monday is
  // owed 80 on Thursday.
  assert.equal(orderValue(order()), 800);
});

test("a missing or unpriced line does not make the whole order NaN", () => {
  assert.equal(orderValue(order({ items: [{ quantity: 5 }, { agreed_rate: 20 }] })), 0);
  assert.equal(orderValue({}), 0);
});

test("every offered action is one the lifecycle will accept", () => {
  // The rule this module exists for. A button that gets refused teaches an operator that the
  // app's buttons are suggestions.
  for (const status of Object.values(ORDER_STATUS)) {
    // The same order object on both sides. Presenting a settled order and then validating a bare
    // `{ status }` compared two different orders and made the check meaningless the moment any
    // rule started reading a second field.
    const subject = order({ status });
    const presented = presentOrder(subject, NOW);
    for (const action of presented.actions) {
      const check = validateOrderAction({
        order: subject,
        to: action.to,
        carrier: "Rapido",
        reason: "customer changed their mind",
      });
      assert.equal(check.ok, true, `${status} offered ${action.to}, which the lifecycle refuses`);
    }
  }
});

test("a finished order offers nothing", () => {
  assert.deepEqual(presentOrder(order({ status: ORDER_STATUS.DELIVERED }), NOW).actions, []);
  assert.deepEqual(presentOrder(order({ status: ORDER_STATUS.CANCELLED }), NOW).actions, []);
});

test("a lapsed order carries a warning that says what to do", () => {
  // It looks exactly like a fresh one — same customer, same lines, same column. The only
  // difference is that its fruit went back on the shelf and may already be sold.
  const lapsed = presentOrder(order({ reserved_at: agoMs(RESERVATION_TTL_MS + 1) }), NOW);
  assert.equal(lapsed.reservation, RESERVATION_STATE.LAPSED);
  assert.match(lapsed.warning, /Check it is still in the shop/);
});

test("a healthy order carries no warning", () => {
  assert.equal(presentOrder(order(), NOW).warning, "");
});

test("sending requires a carrier", () => {
  // An order marked sent with no record of who took it is a parcel the shop cannot answer a
  // question about, and where it is happens to be the customer's only question.
  const refused = validateOrderAction({ order: order({ status: ORDER_STATUS.PACKED }), to: ORDER_STATUS.SENT });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /who is carrying/i);
  const allowed = validateOrderAction({ order: order({ status: ORDER_STATUS.PACKED }), to: ORDER_STATUS.SENT, carrier: "Rapido" });
  assert.equal(allowed.ok, true);
});

test("the money question is asked before the carrier question", () => {
  // Both are required, and the order matters: telling someone to type a carrier name and only
  // then that the order is unpaid wastes the step and buries the important half.
  const undecided = validateOrderAction({
    order: order({ status: ORDER_STATUS.PACKED, payment_state: null }),
    to: ORDER_STATUS.SENT,
  });
  assert.equal(undecided.ok, false);
  assert.match(undecided.message, /has been paid/i);
});

test("an order explicitly marked unpaid cannot be sent", () => {
  const refused = validateOrderAction({
    order: order({ status: ORDER_STATUS.PACKED, payment_state: "UNPAID" }),
    to: ORDER_STATUS.SENT,
    carrier: "Rapido",
  });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /marked unpaid/i);
});

test("pay-on-delivery is a decision, not an unpaid order", () => {
  // Calling it unpaid would put every cash-on-delivery order on a list of problems and make the
  // list useless.
  const allowed = validateOrderAction({
    order: order({ status: ORDER_STATUS.PACKED, payment_state: "ON_DELIVERY" }),
    to: ORDER_STATUS.SENT,
    carrier: "Rapido",
  });
  assert.equal(allowed.ok, true);
});

test("Send is not offered at all while the money question is open", () => {
  // Not offered rather than offered-and-refused. A button that argues back teaches an operator to
  // stop reading the messages.
  const open = presentOrder(order({ status: ORDER_STATUS.PACKED, payment_state: null }), NOW);
  assert.ok(!open.actions.some((action) => action.to === ORDER_STATUS.SENT));
  assert.match(open.paymentWarning, /has been paid/i);

  const settled = presentOrder(order({ status: ORDER_STATUS.PACKED, payment_state: "PAID" }), NOW);
  assert.ok(settled.actions.some((action) => action.to === ORDER_STATUS.SENT));
  assert.equal(settled.paymentWarning, "");
});

test("cancelling requires a reason", () => {
  const refused = validateOrderAction({ order: order(), to: ORDER_STATUS.CANCELLED });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /reason/i);
});

test("an illegal move is refused even when every field is filled in", () => {
  const refused = validateOrderAction({
    order: order({ status: ORDER_STATUS.SENT }),
    to: ORDER_STATUS.CANCELLED,
    reason: "changed my mind",
  });
  assert.equal(refused.ok, false);
});

test("the board sorts orders into their columns", () => {
  const board = buildOrdersBoard([
    order({ id: "a", status: ORDER_STATUS.RECEIVED }),
    order({ id: "b", status: ORDER_STATUS.PACKED }),
    order({ id: "c", status: ORDER_STATUS.SENT }),
    order({ id: "d", status: ORDER_STATUS.PACKED }),
  ], NOW);
  assert.deepEqual(board.columns.map((column) => column.orders.length), [1, 2, 1]);
  assert.equal(board.openCount, 4);
});

test("finished orders are kept, not hidden", () => {
  // A board that dropped an order the moment it finished would make "did that actually go out?"
  // unanswerable the next morning — the question this module exists to answer.
  const board = buildOrdersBoard([
    order({ id: "a", status: ORDER_STATUS.DELIVERED }),
    order({ id: "b", status: ORDER_STATUS.CANCELLED }),
    order({ id: "c", status: ORDER_STATUS.RETURNED }),
  ], NOW);
  assert.equal(board.finished.length, 3);
  assert.equal(board.openCount, 0);
});

test("reserved value counts only what is still holding stock", () => {
  // Sent orders have left. Counting them would inflate "money tied up in orders" by everything
  // the shop has already shipped and billed.
  const board = buildOrdersBoard([
    order({ id: "a", status: ORDER_STATUS.RECEIVED }),
    order({ id: "b", status: ORDER_STATUS.PACKED }),
    order({ id: "c", status: ORDER_STATUS.SENT }),
  ], NOW);
  assert.equal(board.reservedValue, 1600);
});

test("orders needing attention are collected for the top of the screen", () => {
  const board = buildOrdersBoard([
    order({ id: "a" }),
    order({ id: "b", order_no: "ORD-2", reserved_at: agoMs(RESERVATION_TTL_MS + 1) }),
  ], NOW);
  assert.equal(board.needsAttention.length, 1);
  assert.equal(board.needsAttention[0].orderNo, "ORD-2");
});

test("a malformed order list does not break the board", () => {
  const board = buildOrdersBoard(null, NOW);
  assert.equal(board.openCount, 0);
  assert.deepEqual(board.needsAttention, []);
});

test("an order with an unrecognised status is surfaced, not silently dropped", () => {
  // It belongs in no column and no total, so without this it simply is not on the board — with
  // nothing to say it was dropped. The database refuses such a status, so reaching here means
  // something outside the app wrote it, which is exactly when silence is worst.
  const board = buildOrdersBoard([
    order({ id: "a" }),
    order({ id: "b", order_no: "ORD-X", status: "HALF_PACKED" }),
  ], NOW);
  assert.equal(board.unknown.length, 1);
  assert.equal(board.unknown[0].orderNo, "ORD-X");
  assert.ok(board.needsAttention.some((entry) => /unrecognised status/.test(entry.warning)));
});

test("a blank status is unrecognised too, and says so readably", () => {
  const board = buildOrdersBoard([order({ id: "c", status: "" })], NOW);
  assert.equal(board.unknown.length, 1);
  assert.match(board.needsAttention[0].warning, /blank/);
});
