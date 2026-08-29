import test from "node:test";
import assert from "node:assert/strict";

import {
  UNKNOWN_DISPLAY,
  addLine,
  basketRows,
  basketTotals,
  canonicalProductId,
  createBasket,
  describeLineRejection,
  findLine,
  formatKg,
  formatRatePerKg,
  formatRupees,
  lineTotal,
  productIdsEqual,
  removeLine,
  setLineQuantity,
} from "./basket.js";

const mango = { productId: "004", name: "Alphonso mango", ratePerKg: 480, quantityKg: 1.5 };
const banana = { productId: "banana-nendran", name: "Nendran banana", ratePerKg: 62.5, quantityKg: 2 };

const withLines = (...lines) => lines.reduce((basket, line) => addLine(basket, line), createBasket());

test("a new basket is empty and totals to nothing", () => {
  const totals = basketTotals(createBasket());
  assert.deepEqual(totals, { lineCount: 0, totalKg: 0, subtotal: 0 });
});

test("adding a line returns a new basket and leaves the original untouched", () => {
  const empty = createBasket();
  const next = addLine(empty, mango);
  assert.equal(empty.lines.length, 0, "the basket handed in must not be edited");
  assert.equal(next.lines.length, 1);
  assert.notEqual(next, empty);
});

test("adding the same product twice sums into one line rather than making a second", () => {
  const basket = withLines(mango, { ...mango, quantityKg: 0.75 });
  assert.equal(basket.lines.length, 1);
  assert.equal(basket.lines[0].quantityKg, 2.25);
  assert.equal(basketTotals(basket).lineCount, 1);
});

test("the product ids 004 and 4 are different products and never merge into one line", () => {
  // Ids are opaque strings. Coercing them with Number() is the documented way to silently lose rows
  // in this codebase, and it would here charge a customer for fruit they did not ask for.
  const basket = withLines(
    { productId: "004", name: "Alphonso mango", ratePerKg: 480, quantityKg: 1 },
    { productId: 4, name: "Seedless grapes", ratePerKg: 190, quantityKg: 1 },
  );
  assert.equal(basket.lines.length, 2);
  assert.equal(canonicalProductId("004"), "004");
  assert.equal(canonicalProductId(4), "4");
  assert.equal(productIdsEqual("004", 4), false);
  assert.equal(productIdsEqual("004", " 004 "), true, "surrounding whitespace is trimmed, nothing else");
  assert.equal(productIdsEqual("", ""), false, "a blank id matches nothing, not even another blank");
});

test("a quantity typed as a string by a form field is accepted as a number", () => {
  const basket = addLine(createBasket(), { ...mango, quantityKg: "1.5", ratePerKg: "480" });
  assert.equal(basket.lines[0].quantityKg, 1.5);
  assert.equal(basket.lines[0].ratePerKg, 480);
  assert.equal(basketTotals(basket).subtotal, 720);
});

test("quantities are stored rounded to three decimals", () => {
  const basket = addLine(createBasket(), { ...mango, quantityKg: 1.23456 });
  assert.equal(basket.lines[0].quantityKg, 1.235);
});

test("a line that cannot be priced honestly is refused rather than added at zero", () => {
  // A rate of 0 for fruit is a rate that failed to load, and a line printed at Rs 0.00 on that
  // basis is exactly the "errors must never render as zero" failure.
  for (const ratePerKg of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -10, 0, "", "  ", "free"]) {
    const basket = addLine(createBasket(), { ...mango, ratePerKg });
    assert.equal(basket.lines.length, 0, `rate ${String(ratePerKg)} must not create a line`);
    assert.match(describeLineRejection({ ...mango, ratePerKg }), /rate|price/i);
  }
});

test("a line with no usable weight or no product code is refused, and the refusal says why", () => {
  for (const quantityKg of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, 0, "", "abc"]) {
    const basket = addLine(createBasket(), { ...mango, quantityKg });
    assert.equal(basket.lines.length, 0, `quantity ${String(quantityKg)} must not create a line`);
    assert.notEqual(describeLineRejection({ ...mango, quantityKg }), "");
  }
  for (const productId of [null, undefined, "", "   "]) {
    assert.equal(addLine(createBasket(), { ...mango, productId }).lines.length, 0);
    assert.match(describeLineRejection({ ...mango, productId }), /product code/i);
  }
  assert.equal(describeLineRejection(mango), "", "a good line has no refusal");
  assert.equal(addLine(createBasket()).lines.length, 0, "addLine with no line at all is a no-op");
});

test("re-adding a product takes today's rate, because produce is repriced daily", () => {
  const basket = withLines(mango, { ...mango, ratePerKg: 520, quantityKg: 0.5 });
  assert.equal(basket.lines[0].ratePerKg, 520);
  assert.equal(basket.lines[0].quantityKg, 2);
});

test("setting a line quantity replaces it rather than adding to it", () => {
  const basket = setLineQuantity(withLines(mango, banana), "004", "0.25");
  assert.equal(findLine(basket, "004").quantityKg, 0.25);
  assert.equal(basket.lines.length, 2);
});

test("setting a quantity of zero or less removes the line", () => {
  for (const quantity of [0, "0", -2, "-0.5"]) {
    const basket = setLineQuantity(withLines(mango, banana), "004", quantity);
    assert.equal(basket.lines.length, 1, String(quantity));
    assert.equal(findLine(basket, "004"), undefined, String(quantity));
    assert.ok(findLine(basket, banana.productId), "the other line survives");
  }
});

test("a half-typed quantity leaves the basket alone instead of deleting the line", () => {
  // Losing a line to a keystroke is worse than ignoring the keystroke.
  for (const quantity of ["", "  ", "abc", null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    const basket = setLineQuantity(withLines(mango), "004", quantity);
    assert.equal(basket.lines.length, 1, String(quantity));
    assert.equal(basket.lines[0].quantityKg, 1.5, String(quantity));
  }
});

test("removing a line returns a new basket without it, matching on the canonical id", () => {
  const before = withLines(mango, banana);
  const after = removeLine(before, " 004 ");
  assert.equal(before.lines.length, 2, "the original basket is unchanged");
  assert.equal(after.lines.length, 1);
  assert.equal(findLine(after, "004"), undefined);
  assert.equal(removeLine(before, "not-in-basket").lines.length, 2);
});

test("money rounds to two decimals and weights to three", () => {
  const basket = withLines({ productId: "p", name: "Grapes", ratePerKg: 55.55, quantityKg: 1.0074 });
  const totals = basketTotals(basket);
  assert.equal(totals.totalKg, 1.007);
  assert.equal(totals.subtotal, 55.94);
  assert.equal(lineTotal({ ratePerKg: 60.01, quantityKg: 0.5 }), 30.01, "a half-paisa line rounds up, not down");
});

test("the printed line totals add up to the printed subtotal", () => {
  // Rounding once per line and summing the rounded lines gives 115.97 here; accumulating full
  // precision and rounding only the grand total gives 115.96. The customer can see the three line
  // totals on the page, so their arithmetic has to be the one that matches.
  const basket = withLines(
    { productId: "p1", name: "Alphonso mango", ratePerKg: 60.01, quantityKg: 0.5 },
    { productId: "p2", name: "Nendran banana", ratePerKg: 20.01, quantityKg: 1.5 },
    { productId: "p3", name: "Seedless grapes", ratePerKg: 55.55, quantityKg: 1.007 },
  );
  const rows = basketRows(basket);
  assert.deepEqual(rows.map((row) => row.total), [30.01, 30.02, 55.94]);

  const totals = basketTotals(basket);
  const addedUpByHand = rows.reduce((sum, row) => sum + row.total, 0);
  assert.equal(totals.subtotal, Number(addedUpByHand.toFixed(2)));
  assert.equal(totals.subtotal, 115.97);
  assert.equal(totals.lineCount, 3);
  assert.equal(totals.totalKg, 3.007);
});

test("totals survive a basket that was never built by this module", () => {
  assert.deepEqual(basketTotals(undefined), { lineCount: 0, totalKg: 0, subtotal: 0 });
  assert.deepEqual(basketTotals({ lines: null }), { lineCount: 0, totalKg: 0, subtotal: 0 });
  assert.equal(lineTotal({ ratePerKg: "oops", quantityKg: 2 }), 0);
  assert.equal(lineTotal(undefined), 0);
});

test("rupees are grouped the Indian way once the total passes a lakh", () => {
  assert.equal(formatRupees(109340.75), "₹1,09,340.75");
  assert.equal(formatRupees(1234.5), "₹1,234.50");
  assert.equal(formatRupees(80), "₹80.00");
  assert.equal(formatRupees("109340.752"), "₹1,09,340.75");
});

test("weights are printed with three decimals and the unit beside them", () => {
  assert.equal(formatKg(2.5), "2.500 kg");
  assert.equal(formatKg("0.125"), "0.125 kg");
  assert.equal(formatKg(0), "0.000 kg", "a measured zero still prints as zero");
  assert.equal(formatRatePerKg(80), "₹80.00 / kg");
});

test("a figure we could not read prints as a dash, never as zero", () => {
  for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, "", "   ", "abc", {}]) {
    assert.equal(formatRupees(value), UNKNOWN_DISPLAY, String(value));
    assert.equal(formatKg(value), UNKNOWN_DISPLAY, String(value));
    assert.equal(formatRatePerKg(value), UNKNOWN_DISPLAY, String(value));
  }
});

test("a basket handed to page code cannot be mutated by accident", () => {
  const basket = withLines(mango);
  assert.throws(() => { basket.lines.push({}); }, TypeError);
  assert.throws(() => { basket.lines[0].quantityKg = 99; }, TypeError);
});
