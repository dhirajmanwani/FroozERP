import test from "node:test";
import assert from "node:assert/strict";

import {
  cartEntryFits,
  cartLineProblem,
  chargeRefusalProblem,
  describeMandiTaxPanel,
  describeSavedBillRefreshFailure,
  editLineAmount,
  editedBillDateTime,
  localDateTimeText,
  lotLeftAfterCart,
  posLineProblem,
  resolvePosBillDateTime,
  saleEditTotals,
} from "./posCheckout.js";

test("a bill nobody re-dated follows the clock: later the same day, and the next morning", () => {
  const opened = "2026-10-24T09:02";
  assert.equal(resolvePosBillDateTime({ typed: opened, edited: false, now: "2026-10-24T11:40" }), "2026-10-24T11:40");
  assert.equal(resolvePosBillDateTime({ typed: opened, edited: false, now: "2026-10-25T08:15" }), "2026-10-25T08:15", "left on POS overnight is not a back-dated bill");
});

test("a date the Owner typed on purpose is kept; an emptied field falls back to now", () => {
  assert.equal(resolvePosBillDateTime({ typed: "2026-10-20T18:00", edited: true, now: "2026-10-24T11:40" }), "2026-10-20T18:00");
  assert.equal(resolvePosBillDateTime({ typed: "", edited: true, now: "2026-10-24T11:40" }), "2026-10-24T11:40");
});

test("localDateTimeText writes the datetime-local format in local time", () => {
  assert.equal(localDateTimeText(new Date(2026, 0, 5, 7, 3)), "2026-01-05T07:03");
});

test("an edited bill keeps the time it was made, not midnight", () => {
  assert.equal(editedBillDateTime({ bill_datetime: "2026-10-24T18:45" }, "2026-10-24"), "2026-10-24T18:45");
  assert.equal(editedBillDateTime({ bill_datetime: "2026-10-24 18:45:10" }, "2026-10-23"), "2026-10-23T18:45", "a re-dated edit keeps the time too");
  const instant = new Date(2026, 9, 24, 18, 45).toISOString();
  assert.equal(editedBillDateTime({ created_at: instant }, "2026-10-24"), "2026-10-24T18:45", "a zoned timestamp is read in local time");
  assert.equal(editedBillDateTime({ bill_datetime: "2026-10-24", created_at: instant }, "2026-10-24"), "2026-10-24T18:45", "a date-only value says nothing about the time");
  assert.equal(editedBillDateTime({}, "2026-10-24"), "2026-10-24T00:00", "no time anywhere: midnight, as before");
});

test("cart entries fit the precision they are billed at", () => {
  assert.equal(cartEntryFits("quantity", "1.234"), true);
  assert.equal(cartEntryFits("quantity", "1.2345"), false, "a fourth decimal of a kilo is not taken");
  assert.equal(cartEntryFits("quantity", 1.25), true, "a scale reading as a number");
  assert.equal(cartEntryFits("selling_rate", "99.99"), true);
  assert.equal(cartEntryFits("discount_amount", "12.345"), false, "money carries 2 decimals");
  assert.equal(cartEntryFits("quantity", "1e3"), false);
  assert.equal(cartEntryFits("quantity", "1."), true, "half-typed is not refused");
  assert.equal(cartEntryFits("quantity", ""), true);
});

test("a loose line needs a quantity and a discount it can carry; the product is named", () => {
  const line = { product_name: "Apple", quantity: "2", selling_rate: 100, discount_amount: 0 };
  assert.equal(posLineProblem(line), "");
  assert.equal(posLineProblem({ ...line, quantity: "0" }), "Enter a quantity for Apple.");
  assert.equal(posLineProblem({ ...line, quantity: "" }), "Enter a quantity for Apple.");
  assert.equal(posLineProblem({ ...line, discount_amount: "200.01" }), "Apple: the item discount is more than the line.");
  assert.equal(posLineProblem({ ...line, discount_amount: "200" }), "", "the whole line off is allowed");
  assert.equal(posLineProblem({ ...line, quantity: "0", combo_line_key: "K", combo_type: "CUSTOM" }), "", "a combo's line is the combo's to check");
  assert.equal(cartLineProblem([line, { ...line, product_name: "Kiwi", quantity: "" }]), "Enter a quantity for Kiwi.");
  assert.equal(cartLineProblem([]), "");
});

test("a charge that could not be priced stops the bill, in its own words", () => {
  assert.equal(chargeRefusalProblem([]), "");
  assert.equal(chargeRefusalProblem(undefined), "");
  assert.equal(
    chargeRefusalProblem([{ message: "Delivery has no rate for 12 km." }]),
    "Delivery has no rate for 12 km. Fix or remove the charge before saving.",
  );
});

test("a saved bill whose screen failed to refresh is reported as saved, with its number", () => {
  const text = describeSavedBillRefreshFailure("OFF-20261024-0001", new Error("status read failed"));
  assert.match(text, /^Bill OFF-20261024-0001 is saved\./);
  assert.match(text, /status read failed/);
  assert.match(text, /Do not bill it again/);
  assert.match(describeSavedBillRefreshFailure("FZ-1", "x", { edited: true }), /^Bill FZ-1 is updated\./);
});

test("Mandi Tax panel: a walk-in taxed under ALL_CUSTOMERS shows Applied, with no walk-in note", () => {
  const panel = describeMandiTaxPanel({ scope: "ALL_CUSTOMERS", enabled: true, percent: 1, registered: false, appliedRate: 1 });
  assert.equal(panel.badge, "Applied");
  assert.equal(panel.walkInNote, false);
  assert.equal(panel.showPreview, true);
});

test("Mandi Tax panel: the registered-customer rules are as before", () => {
  const walkIn = describeMandiTaxPanel({ scope: "REGISTERED_CUSTOMERS", enabled: true, percent: 1, registered: false, appliedRate: 0 });
  assert.equal(walkIn.badge, "Not Applicable");
  assert.equal(walkIn.walkInNote, true);
  assert.equal(walkIn.showPreview, false);
  assert.equal(describeMandiTaxPanel({ scope: "REGISTERED_CUSTOMERS", enabled: true, percent: 1, registered: true, appliedRate: 1 }).badge, "Applied");
  const off = describeMandiTaxPanel({ scope: "REGISTERED_CUSTOMERS", enabled: false, percent: 1, registered: true, appliedRate: 0 });
  assert.equal(off.badge, "Disabled");
  assert.equal(off.salesLabel, "registered-customer sales");
  assert.equal(describeMandiTaxPanel({ scope: "REGISTERED_CUSTOMERS", enabled: true, percent: 0, registered: true }).badge, "Configuration Required");
  assert.equal(describeMandiTaxPanel({ scope: "ALL_CUSTOMERS", enabled: true, percent: 0, registered: false }).badge, "Configuration Required");
  assert.equal(describeMandiTaxPanel({ scope: "NONE", enabled: true, percent: 1, registered: true }).badge, "Disabled");
});

test("an edited bill adds up line by line, as POS does", () => {
  const items = [0, 1, 2].map(() => ({ quantity: 0.333, selling_rate: 99.99, discount_amount: 0 }));
  // Each line is ₹33.30 (33.29667 rounded); the unrounded sum would be ₹99.89.
  assert.equal(saleEditTotals(items).gross, 99.9);
  assert.equal(saleEditTotals([{ quantity: 1, selling_rate: 10, discount_amount: 1.005 }, { quantity: 1, selling_rate: 10, discount_amount: 2 }]).itemDiscount, 3.01);
  assert.equal(editLineAmount({ quantity: 0.333, selling_rate: 99.99, discount_amount: 0.3 }), 33);
  assert.equal(editLineAmount({ quantity: 1, selling_rate: 10, discount_amount: 20 }), 0, "never below zero");
});

test("what is left in a lot counts the whole cart, to 3 decimals", () => {
  assert.equal(lotLeftAfterCart({ available: 3.5999999999999996, inOtherLines: 0, quantity: 1.2 }), 2.4);
  assert.equal(lotLeftAfterCart({ available: 5, inOtherLines: 2, quantity: "1.5" }), 1.5);
  assert.equal(lotLeftAfterCart({ available: 1, inOtherLines: 1, quantity: 1 }), 0, "never below zero");
  assert.equal(lotLeftAfterCart({ available: undefined }), null, "unknown is not 0");
});
