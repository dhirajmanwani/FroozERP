import test from "node:test";
import assert from "node:assert/strict";

import { buildOrdersBoard, presentOrder } from "./ordersBoard.js";
import {
  NEXT_STEP_KIND,
  finishedAt,
  orderAgeLabel,
  orderCountChips,
  orderItemSummary,
  orderNextStep,
  orderPaymentChip,
  splitFinishedToday,
} from "./ordersScreen.js";

const NOW = new Date("2026-11-22T12:00:00").getTime();
const order = (patch = {}) => ({
  id: "o1",
  order_no: "ORD-1",
  customer_name: "Sunita",
  status: "RECEIVED",
  reserved_at: new Date(NOW - 30 * 60000).toISOString(),
  items: [{ product_id: "p1", product_name: "Apple", quantity: 2, unit: "KG", agreed_rate: 150 }],
  ...patch,
});

test("an order reads in one line, with units and a count of the rest", () => {
  assert.equal(orderItemSummary([{ product_name: "Apple", quantity: 2, unit: "KG" }]), "Apple 2 Kg");
  assert.equal(orderItemSummary([
    { product_name: "Apple", quantity: 2, unit: "KG" },
    { product_name: "Kiwi", quantity: 6, unit: "PCS" },
    { product_name: "Mango", quantity: 1, unit: "KG" },
    { product_name: "Grapes", quantity: 0.5, unit: "KG" },
  ]), "Apple 2 Kg, Kiwi 6 Piece +2 more");
  assert.equal(orderItemSummary([]), "No items recorded");
});

test("age reads in minutes, hours and days, and an unreadable time says nothing", () => {
  assert.equal(orderAgeLabel(new Date(NOW - 20000).toISOString(), NOW), "just now");
  assert.equal(orderAgeLabel(new Date(NOW - 12 * 60000).toISOString(), NOW), "12 min");
  assert.equal(orderAgeLabel(new Date(NOW - 3 * 3600000).toISOString(), NOW), "3 h");
  assert.equal(orderAgeLabel(new Date(NOW - 50 * 3600000).toISOString(), NOW), "2 d");
  assert.equal(orderAgeLabel("", NOW), "");
  assert.equal(orderAgeLabel("not a date", NOW), "");
});

test("the payment chip never claims Paid for an unanswered question", () => {
  assert.equal(orderPaymentChip("PAID").label, "Paid");
  assert.equal(orderPaymentChip(null).label, "Payment?");
  assert.equal(orderPaymentChip("").tone, "attention");
  assert.equal(orderPaymentChip("ON_DELIVERY").label, "Pay on delivery");
});

test("each card offers one next step, and only a step the lifecycle allows", () => {
  const received = orderNextStep(presentOrder(order(), NOW));
  assert.equal(received.kind, NEXT_STEP_KIND.MOVE);
  assert.equal(received.to, "PACKED");
  assert.equal(received.label, "Pack");

  // Packed and not yet asked about money: the step is to answer it (Send is withheld until then).
  const unpaid = orderNextStep(presentOrder(order({ status: "PACKED" }), NOW), { canStart: true });
  assert.equal(unpaid.kind, NEXT_STEP_KIND.OPEN);
  assert.equal(unpaid.label, "Record payment");

  const paid = presentOrder(order({ status: "PACKED", payment_state: "PAID" }), NOW);
  assert.equal(orderNextStep(paid, { canStart: true }).label, "Book delivery");
  assert.equal(orderNextStep(paid, { open: true }).label, "Track delivery");
  assert.equal(orderNextStep(paid, {}).label, "Send");
  assert.equal(orderNextStep(paid, {}).kind, NEXT_STEP_KIND.OPEN, "sending needs a carrier, so it opens the order");

  const sent = orderNextStep(presentOrder(order({ status: "SENT", payment_state: "PAID" }), NOW));
  assert.equal(sent.kind, NEXT_STEP_KIND.MOVE);
  assert.equal(sent.to, "DELIVERED");

  assert.equal(orderNextStep(presentOrder(order({ status: "DELIVERED" }), NOW)).kind, NEXT_STEP_KIND.NONE);
});

test("finished orders split into today's and earlier, and none is dropped", () => {
  const rows = [
    order({ id: "a", status: "DELIVERED", delivered_at: new Date(NOW - 3600000).toISOString() }),
    order({ id: "b", status: "CANCELLED", cancelled_at: new Date(NOW - 3 * 86400000).toISOString() }),
    order({ id: "c", status: "RETURNED", updated_at: "" }),
  ];
  const board = buildOrdersBoard(rows, NOW);
  const rawById = new Map(rows.map((row) => [row.id, row]));
  const split = splitFinishedToday(board.finished, rawById, NOW);
  assert.deepEqual(split.today.map((row) => row.id), ["a"]);
  assert.deepEqual(split.earlier.map((row) => row.id).sort(), ["b", "c"]);
  assert.equal(finishedAt({ status: "DELIVERED", updated_at: "2026-11-22T10:00:00Z" }), new Date("2026-11-22T10:00:00Z").getTime());
});

test("header chips count each column, and needs-checking appears only when there is something", () => {
  const board = buildOrdersBoard([
    order({ id: "1" }),
    order({ id: "2", status: "PACKED" }),
    order({ id: "3", status: "SENT" }),
  ], NOW);
  const chips = orderCountChips(board);
  assert.deepEqual(chips.map((chip) => `${chip.label}:${chip.count}`), ["New:1", "Packed:1", "Out for delivery:1"]);
  const lapsed = buildOrdersBoard([order({ reserved_at: new Date(NOW - 7 * 3600000).toISOString() })], NOW);
  assert.equal(orderCountChips(lapsed).at(-1).label, "Needs checking");
});
