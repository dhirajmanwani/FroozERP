import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

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

// ---------------------------------------------------------------------------
// Orders nobody is handling yet
// ---------------------------------------------------------------------------

test("an order waiting for a shop is listed with what a person needs to decide", async () => {
  const { resolveUnassignedQueue, ORDER_QUEUE_STATUS } = await import("./ordersBoard.js");
  const queue = resolveUnassignedQueue({
    orders: [{
      global_id: "web-1", order_no: "WEB-1", customer_name: "Anita",
      customer_mobile: "9999999999", delivery_address: "Ratanada Road", source: "WEBSITE",
      items: [{ product_name: "Alphonso", quantity: 5, unit: "KG" }],
    }],
  });
  assert.equal(queue.status, ORDER_QUEUE_STATUS.READY);
  assert.equal(queue.countLabel, "1");
  // The address is the whole reason a human decides this rather than a rule: it is how somebody
  // knows Ratanada is nearer.
  assert.equal(queue.orders[0].deliveryAddress, "Ratanada Road");
  assert.equal(queue.orders[0].items.length, 1);
});

test("three different emptinesses, kept apart", async () => {
  // CLAUDE.md, in this screen's clothes. "Nobody is waiting", "you may not look" and "it would not
  // load" all produce no rows. Rendering them the same tells an Owner there is nothing to hand out
  // when nothing could be checked -- while a customer waits for a delivery nobody was given.
  const { resolveUnassignedQueue, ORDER_QUEUE_STATUS } = await import("./ordersBoard.js");

  const empty = resolveUnassignedQueue({ orders: [] });
  assert.equal(empty.status, ORDER_QUEUE_STATUS.READY);
  assert.equal(empty.countLabel, "0", "a real zero is a real answer, and a good one");
  assert.match(empty.message, /No orders are waiting/);

  const denied = resolveUnassignedQueue({ permitted: false });
  assert.equal(denied.status, ORDER_QUEUE_STATUS.NOT_PERMITTED);
  assert.notEqual(denied.countLabel, "0", "a cashier shown 0 would conclude nothing is waiting");

  const failed = resolveUnassignedQueue({ loadError: "The service did not answer." });
  assert.equal(failed.status, ORDER_QUEUE_STATUS.ERROR);
  assert.notEqual(failed.countLabel, "0");
  assert.equal(failed.message, "The service did not answer.");
});

test("an order cannot be handed to the shop already handling it", async () => {
  const { validateOrderAssignment } = await import("./ordersBoard.js");
  assert.equal(validateOrderAssignment({ orderId: "o1", branchId: "2", currentBranchId: "2" }).ok, false);
  assert.equal(validateOrderAssignment({ orderId: "o1", branchId: "2", currentBranchId: "1" }).ok, true);
  // Assigning for the first time: there is no current shop, so any shop is a move.
  assert.equal(validateOrderAssignment({ orderId: "o1", branchId: "2", currentBranchId: null }).ok, true);
  assert.equal(validateOrderAssignment({ orderId: "o1", branchId: "" }).ok, false);
});

test("branch ids are compared as opaque text", async () => {
  // "02" is not 2. The same pitfall that silently emptied the Inventory table.
  const { validateOrderAssignment } = await import("./ordersBoard.js");
  assert.equal(
    validateOrderAssignment({ orderId: "o1", branchId: "02", currentBranchId: "2" }).ok,
    true,
    '"02" and "2" are different branches and must not be treated as the same one',
  );
});

test("the waiting queue is hidden from people who cannot act on it", () => {
  // An Owner-only queue rendered to a cashier as an empty box reads as "nothing is waiting", which
  // is a different and worse statement than "this is not yours to do".
  const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(
    app,
    /\{waiting\.status !== ORDER_QUEUE_STATUS\.NOT_PERMITTED && \(/,
    "the queue card must not render at all for somebody who may not route orders",
  );
  assert.match(app, /const canRoute = \["Owner", "Admin"\]\.includes\(String\(user\?\.role \|\| ""\)\)/);
});

test("the queue never renders a bare empty list", () => {
  const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  // "None waiting", "could not load" and "not allowed" all produce no rows, and only one of them
  // means no customer is waiting. The message is what tells them apart.
  assert.match(app, /\{waiting\.message && <p className="form-note">\{waiting\.message\}<\/p>\}/);
  assert.match(app, /\{waiting\.orders\.length > 0 && \(/);
});

test("handing an order over goes through the same check the server applies", () => {
  const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /const checked = validateOrderAssignment\(\{ orderId, branchId \}\)/);
  assert.match(app, /if \(!checked\.ok\) return;/);
  // The shop list has to be there, or an Owner sees a waiting order and has nowhere to send it.
  assert.match(app, /branches=\{settingsData\.branches \|\| \[\]\}/);
});
