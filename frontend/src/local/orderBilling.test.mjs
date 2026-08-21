import test from "node:test";
import assert from "node:assert/strict";

import { ORDER_BILLING_PROBLEM, buildOrderCartSeed, describeOrderBillingProblems } from "./orderBilling.js";

const products = [
  { id: "004", product_name: "Apple", unit: "kg", selling_rate: 210 },
  { id: "005", product_name: "Banana", unit: "kg", selling_rate: 60 },
];

const lots = [
  { id: "lot-old", product_id: "004", remaining_qty: 4, purchase_date: "2026-08-18", unit: "kg", lot_name: "A-1" },
  { id: "lot-new", product_id: "004", remaining_qty: 10, purchase_date: "2026-08-20", unit: "kg", lot_name: "A-2" },
  { id: "lot-ban", product_id: "005", remaining_qty: 20, purchase_date: "2026-08-19", unit: "kg", lot_name: "B-1" },
];

const order = (overrides = {}) => ({
  id: "order-1",
  items: [{ product_id: "004", product_name: "Apple", quantity: 6, agreed_rate: 180 }],
  ...overrides,
});

test("the customer is billed the rate they were quoted, not today's", () => {
  // The whole reason agreed_rate is stored. Apple's current rate is 210; the order said 180.
  const seed = buildOrderCartSeed(order(), { products, lots });
  assert.ok(seed.lines.every((line) => line.selling_rate === 180));
  assert.equal(seed.complete, true);
});

test("stock is taken oldest lot first, and split across lots when needed", () => {
  // 6kg from a 4kg old crate and a 10kg new one: 4 then 2, in that order.
  const seed = buildOrderCartSeed(order(), { products, lots });
  assert.deepEqual(seed.lines.map((line) => [line.inventory_batch_id, line.quantity]), [
    ["lot-old", 4],
    ["lot-new", 2],
  ]);
});

test("two lines for the same product cannot both claim the same crate", () => {
  // Allocation is cumulative. Without that, the seed promises more than exists and the shortfall
  // only appears when POS refuses the second line — after the order has been marked sent.
  const seed = buildOrderCartSeed(order({
    items: [
      { product_id: "004", quantity: 4, agreed_rate: 180 },
      { product_id: "004", quantity: 4, agreed_rate: 180 },
    ],
  }), { products, lots });
  const fromOldLot = seed.lines.filter((line) => line.inventory_batch_id === "lot-old")
    .reduce((total, line) => total + line.quantity, 0);
  assert.equal(fromOldLot, 4, "the 4kg crate must not be allocated twice");
  assert.equal(seed.lines.reduce((total, line) => total + line.quantity, 0), 8);
});

test("a short order is refused, never quietly billed short", () => {
  // Billing 6kg of an 8kg order under-charges the customer and leaves the order looking complete.
  const seed = buildOrderCartSeed(order({ items: [{ product_id: "004", quantity: 20, agreed_rate: 180 }] }), { products, lots });
  assert.equal(seed.complete, false);
  assert.equal(seed.problems[0].code, ORDER_BILLING_PROBLEM.NOT_ENOUGH_STOCK);
  assert.match(seed.problems[0].message, /6 kg of Apple is short/);
  assert.match(seed.problems[0].message, /may have been sold while it was waiting/);
});

test("a product that no longer exists is named, not skipped", () => {
  const seed = buildOrderCartSeed(order({ items: [{ product_id: "999", product_name: "Chikoo", quantity: 2, agreed_rate: 90 }] }), { products, lots });
  assert.equal(seed.complete, false);
  assert.equal(seed.problems[0].code, ORDER_BILLING_PROBLEM.PRODUCT_GONE);
  assert.match(seed.problems[0].message, /Chikoo/);
});

test("an empty order is a problem, not an empty cart", () => {
  const seed = buildOrderCartSeed(order({ items: [] }), { products, lots });
  assert.equal(seed.complete, false);
  assert.equal(seed.problems[0].code, ORDER_BILLING_PROBLEM.NO_LINES);
  assert.deepEqual(seed.lines, []);
});

test("what could be allocated is still returned alongside the problem", () => {
  // The operator can then bill what is there and deal with the rest, rather than starting again.
  const seed = buildOrderCartSeed(order({
    items: [
      { product_id: "004", quantity: 2, agreed_rate: 180 },
      { product_id: "999", product_name: "Chikoo", quantity: 2, agreed_rate: 90 },
    ],
  }), { products, lots });
  assert.equal(seed.complete, false);
  assert.equal(seed.lines.length, 1);
  assert.equal(seed.lines[0].quantity, 2);
});

test("product ids are matched canonically", () => {
  // "004" and 4 are different products. CLAUDE.md records the coercion emptying the Inventory table.
  const seed = buildOrderCartSeed(order({ items: [{ product_id: "004", quantity: 1, agreed_rate: 180 }] }), {
    products: [{ id: "004", product_name: "Apple", unit: "kg", selling_rate: 210 }],
    lots: [{ id: "l", product_id: "004", remaining_qty: 5, purchase_date: "2026-08-01" }],
  });
  assert.equal(seed.complete, true);
});

test("a missing agreed rate falls back to the product rate rather than billing zero", () => {
  // Zero is a real number on a real bill. New orders cannot be saved without a rate, but an order
  // taken before that rule existed can still reach here.
  const seed = buildOrderCartSeed(order({ items: [{ product_id: "004", quantity: 1, agreed_rate: null }] }), { products, lots });
  assert.equal(seed.lines[0].selling_rate, 210);
});

test("cancelled or empty lots are never allocated from", () => {
  const seed = buildOrderCartSeed(order({ items: [{ product_id: "004", quantity: 1, agreed_rate: 180 }] }), {
    products,
    lots: [{ id: "empty", product_id: "004", remaining_qty: 0, purchase_date: "2026-08-01" }],
  });
  assert.equal(seed.complete, false);
  assert.equal(seed.lines.length, 0);
});

test("problems are summarised in one sentence for the operator", () => {
  const seed = buildOrderCartSeed(order({ items: [{ product_id: "004", quantity: 99, agreed_rate: 180 }] }), { products, lots });
  assert.match(describeOrderBillingProblems(seed), /short/);
  assert.equal(describeOrderBillingProblems({ problems: [] }), "");
});
