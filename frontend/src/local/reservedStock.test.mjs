import test from "node:test";
import assert from "node:assert/strict";

import { ORDER_STATUS, RESERVATION_TTL_MS } from "./orderLifecycle.js";
import {
  COUNTER_STOCK,
  buildReservedIndex,
  describeCounterStock,
  reservedForProduct,
  reservedNote,
} from "./reservedStock.js";

const NOW = Date.parse("2026-08-21T12:00:00+05:30");
const agoMs = (ms) => new Date(NOW - ms).toISOString();

const order = (overrides = {}) => ({
  id: "order-1",
  status: ORDER_STATUS.RECEIVED,
  reserved_at: agoMs(60 * 1000),
  items: [{ product_id: "004", quantity: 6 }],
  ...overrides,
});

test("reserved quantities are keyed canonically", () => {
  // Comparing a raw id against a canonical one reports every product as unreserved — the failure
  // that looks exactly like everything working. CLAUDE.md records it emptying the Inventory table.
  const index = buildReservedIndex([order()], NOW);
  assert.equal(reservedForProduct(index, "004"), 6);
});

test("only orders still holding stock count", () => {
  const index = buildReservedIndex([
    order({ id: "a" }),
    order({ id: "b", status: ORDER_STATUS.SENT, items: [{ product_id: "004", quantity: 99 }] }),
    order({ id: "c", status: ORDER_STATUS.CANCELLED, items: [{ product_id: "004", quantity: 99 }] }),
    order({ id: "d", reserved_at: agoMs(RESERVATION_TTL_MS + 1), items: [{ product_id: "004", quantity: 99 }] }),
  ], NOW);
  assert.equal(reservedForProduct(index, "004"), 6);
});

test("nothing reserved leaves the counter alone", () => {
  const decision = describeCounterStock({ onHand: 20, reserved: 0, requested: 5 });
  assert.equal(decision.status, COUNTER_STOCK.FREE);
  assert.equal(decision.message, "");
});

test("selling within the free portion is allowed but still says what is held", () => {
  const decision = describeCounterStock({ onHand: 20, reserved: 6, requested: 5, unit: "kg" });
  assert.equal(decision.status, COUNTER_STOCK.FREE);
  assert.equal(decision.free, 14);
  assert.match(decision.message, /6 kg of this is set aside/);
});

test("selling into reserved stock is refused with the number named", () => {
  // "Not enough stock" sends someone to count crates. This says what is actually happening.
  const decision = describeCounterStock({ onHand: 20, reserved: 18, requested: 5, unit: "kg" });
  assert.equal(decision.status, COUNTER_STOCK.EATS_RESERVED);
  assert.match(decision.message, /Only 2 kg is free to sell/);
  assert.match(decision.message, /18 kg is set aside/);
});

test("promising more than is on hand is its own state, not 'out of stock'", () => {
  // Somebody has to ring a customer. A plain out-of-stock message hides that entirely.
  const decision = describeCounterStock({ onHand: 5, reserved: 12, requested: 1, unit: "kg" });
  assert.equal(decision.status, COUNTER_STOCK.OVERSOLD);
  assert.equal(decision.free, 0);
  assert.match(decision.message, /promised 12 kg .* only 5 kg is on hand/);
  assert.match(decision.message, /Orders screen/);
});

test("the three states are distinguishable, which is the whole point", () => {
  const free = describeCounterStock({ onHand: 20, reserved: 0, requested: 1 });
  const eats = describeCounterStock({ onHand: 20, reserved: 19, requested: 5 });
  const oversold = describeCounterStock({ onHand: 5, reserved: 12, requested: 1 });
  assert.equal(new Set([free.status, eats.status, oversold.status]).size, 3);
});

test("junk quantities read as zero rather than NaN", () => {
  const decision = describeCounterStock({ onHand: "abc", reserved: undefined, requested: null });
  assert.equal(decision.status, COUNTER_STOCK.FREE);
  assert.equal(decision.free, 0);
  assert.ok(!Number.isNaN(decision.free));
});

test("the product note is empty when nothing is promised", () => {
  const index = buildReservedIndex([], NOW);
  assert.equal(reservedNote(index, "004", "kg"), "");
});

test("the product note names the amount when something is", () => {
  const index = buildReservedIndex([order()], NOW);
  assert.equal(reservedNote(index, "004", "kg"), "6 kg promised to orders");
});
