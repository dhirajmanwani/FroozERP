import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import {
  CHECKOUT_GATE,
  DEFAULT_DATE_OVERRIDE_REASON,
  cartEntryFits,
  cartLineProblem,
  checkoutDateReasonDialog,
  checkoutGateDialog,
  checkoutGateRefusal,
  chargeRefusalProblem,
  describeMandiTaxPanel,
  describeSavedBillRefreshFailure,
  editLineAmount,
  editedBillDateTime,
  localDateTimeText,
  lotLeftAfterCart,
  lotTapQuantity,
  posLineProblem,
  resolveDateOverrideReason,
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

test("a tap adds one unit, or what is left of a lot holding less than one", () => {
  assert.equal(lotTapQuantity({ available: 5, inCart: 0 }), 1);
  assert.equal(lotTapQuantity({ available: 0.75, inCart: 0 }), 0.75, "a 0.75 kg lot can be sold");
  assert.equal(lotTapQuantity({ available: 5.5, inCart: 5 }), 0.5, "the last half kilo of a lot");
  assert.equal(lotTapQuantity({ available: 3.6, inCart: 3.2 }), 0.4, "3 decimals, no float tail");
  assert.equal(lotTapQuantity({ available: 2, inCart: 2 }), 1, "nothing left: the stock check refuses as before");
  assert.equal(lotTapQuantity({ available: undefined }), 1, "unknown balance: unchanged behaviour");
});

// ------------------------------------------------------------------------------------------------
// Phase 3: checkout's questions in the app's own box. Same checks, same order, Go back stops.
// ------------------------------------------------------------------------------------------------

test("every checkout gate asks in a danger box whose safe choice is Go back", () => {
  for (const gate of Object.values(CHECKOUT_GATE)) {
    const dialog = checkoutGateDialog(gate, { billDate: "12/11/2026", productName: "Apple" });
    assert.equal(dialog.tone, "danger", gate);
    assert.equal(dialog.cancelLabel, "Go back", gate);
    assert.ok(dialog.title.endsWith("?"), `${gate} asks a question`);
    assert.notEqual(dialog.confirmLabel, "OK", `${gate} names what confirming does`);
  }
  assert.match(checkoutGateDialog(CHECKOUT_GATE.BACKDATE, { billDate: "12/11/2026" }).message, /12\/11\/2026/);
  assert.match(checkoutGateDialog(CHECKOUT_GATE.FUTURE_DATE, { billDate: "18/11/2026" }).message, /18\/11\/2026/);
  assert.equal(checkoutGateDialog(CHECKOUT_GATE.BELOW_COST, { productName: "Apple" }).title, "Sell Apple below cost?");
  assert.equal(checkoutGateDialog(CHECKOUT_GATE.ZERO_RATE, { productName: "Kiwi" }).confirmLabel, "Sell at ₹0");
  // When the server is the one asking (HTTP 409), its own sentence is shown.
  assert.equal(checkoutGateDialog(CHECKOUT_GATE.BELOW_COST, { serverMessage: "Rate 10 is below cost 12." }).message, "Rate 10 is below cost 12.");
});

test("the reason after a re-dated bill is optional, and skipping it keeps the old default reason", () => {
  for (const gate of [CHECKOUT_GATE.BACKDATE, CHECKOUT_GATE.FUTURE_DATE]) {
    const dialog = checkoutDateReasonDialog(gate);
    assert.equal(dialog.required, false);
    assert.equal(dialog.cancelLabel, "Skip");
    assert.equal(dialog.defaultValue, DEFAULT_DATE_OVERRIDE_REASON[gate]);
    // The old prompt: Cancel (null) and an emptied box both saved the default.
    assert.equal(resolveDateOverrideReason(gate, null), DEFAULT_DATE_OVERRIDE_REASON[gate]);
    assert.equal(resolveDateOverrideReason(gate, "   "), DEFAULT_DATE_OVERRIDE_REASON[gate]);
    assert.equal(resolveDateOverrideReason(gate, "  Missed yesterday's bill "), "Missed yesterday's bill");
  }
  assert.equal(DEFAULT_DATE_OVERRIDE_REASON[CHECKOUT_GATE.BACKDATE], "Backdated POS bill created");
  assert.equal(DEFAULT_DATE_OVERRIDE_REASON[CHECKOUT_GATE.FUTURE_DATE], "Future-dated POS bill created");
});

test("a gate that stops a person who may not answer it says why", () => {
  assert.match(checkoutGateRefusal(CHECKOUT_GATE.ZERO_RATE), /Owner or an Admin/);
  assert.match(checkoutGateRefusal(CHECKOUT_GATE.BELOW_COST), /below cost/);
  assert.match(checkoutGateRefusal(CHECKOUT_GATE.FUTURE_DATE), /future date/);
  assert.match(checkoutGateRefusal(CHECKOUT_GATE.WALK_IN_CREDIT), /saved customer/);
});

const appText = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
const checkoutStart = appText.indexOf("  const checkout = async (printAfterSave = false, confirmations = {}) => {");
const checkoutBody = appText.slice(checkoutStart, appText.indexOf("  const handleSearchKeys = ", checkoutStart));
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("checkout has no browser alert, confirm or prompt left", () => {
  assert.ok(checkoutStart > 0 && checkoutBody.length > 2000, "checkout found");
  assert.doesNotMatch(checkoutBody, /window\.(confirm|prompt|alert)\(|[^.\w]alert\(/);
});

test("each checkout gate is still there, in the same order, and Go back stops checkout", () => {
  const gates = [
    // [what is asked, the line that asks it and returns on Go back]
    ["back-dated bill", "if (!(await askCheckout(() => confirmGate(checkoutGateDialog(CHECKOUT_GATE.BACKDATE, { billDate: formatDisplayDate(selectedBillDate) }))))) return;"],
    ["future-dated bill", "if (!(await askCheckout(() => confirmGate(checkoutGateDialog(CHECKOUT_GATE.FUTURE_DATE, { billDate: formatDisplayDate(selectedBillDate) }))))) return;"],
    ["mobile number", "if (customer.mobile && !/^\\d{10,15}$/.test(customer.mobile)) {"],
    ["credit with no saved customer", "if (!(await askCheckout(() => confirmGate(checkoutGateDialog(CHECKOUT_GATE.WALK_IN_CREDIT))))) return;"],
    ["zero rate", "if (!(await askCheckout(() => confirmGate(checkoutGateDialog(CHECKOUT_GATE.ZERO_RATE, { productName: item.product_name }))))) return;"],
    ["below cost", "if (!(await askCheckout(() => confirmGate(checkoutGateDialog(CHECKOUT_GATE.BELOW_COST, { productName: item.product_name }))))) return;"],
  ];
  let previous = -1;
  for (const [name, line] of gates) {
    const at = checkoutBody.indexOf(line);
    assert.ok(at > 0, `${name}: the gate is missing or changed`);
    assert.ok(at > previous, `${name}: asked out of order`);
    previous = at;
  }
  // Each gate keeps its own condition.
  assert.match(checkoutBody, /if \(selectedBillDate < today && !confirmations\.backdate_confirmed\) \{\s*(\/\/[^\n]*\n\s*)*if \(!\(await askCheckout/);
  assert.match(checkoutBody, /if \(selectedBillDate > today && !confirmations\.future_date_confirmed\) \{\s*if \(!\["Owner", "Admin"\]\.includes\(user\.role\)\) \{/);
  assert.match(checkoutBody, /if \(paymentMode === "CREDIT" && !customer\.account_id\) \{\s*if \(!\["Owner", "Admin"\]\.includes\(user\.role\)\) \{/);
  assert.match(checkoutBody, /if \(rateChanged && !discountControlledRate && rate === 0 && !zeroRateConfirmed\) \{\s*if \(!\["Owner", "Admin"\]\.includes\(user\.role\)\) \{/);
  assert.match(checkoutBody, /if \(rateChanged && !discountControlledRate && estimatedCost > 0 && rate < estimatedCost && !belowCostConfirmed\) \{\s*if \(!\["Owner", "Admin"\]\.includes\(user\.role\)\) \{/);
  // A person who may not answer is stopped, now with a reason, and nothing is asked.
  for (const gate of ["FUTURE_DATE", "WALK_IN_CREDIT", "ZERO_RATE", "BELOW_COST"]) {
    assert.match(checkoutBody, new RegExp(`showCheckoutNotice\\(errorNotice\\(checkoutGateRefusal\\(CHECKOUT_GATE\\.${gate}\\)\\)\\);\\s*return;`), gate);
  }
  // The reason after a re-dated bill never stops checkout: Skip keeps the default, as Cancel did.
  for (const gate of ["BACKDATE", "FUTURE_DATE"]) {
    assert.match(checkoutBody, new RegExp(escape(`dateOverrideReason = resolveDateOverrideReason(CHECKOUT_GATE.${gate}, await askCheckout(() => askGateReason(checkoutDateReasonDialog(CHECKOUT_GATE.${gate}))));`)));
  }
});

test("when the server asks (409), the same four questions come in the same order, and Go back falls to the refusal", () => {
  const conflict = checkoutBody.slice(checkoutBody.indexOf("if (error.response?.status === 409) {"));
  assert.ok(conflict.length > 200, "the 409 branch is there");
  const order = ["below_cost", "zero_rate", "backdate", "future_date"].map((key) => conflict.indexOf(`responseData.requires_${key}_confirmation && await askCheckout(() => confirmGate(checkoutGateDialog(`));
  order.forEach((at, index) => assert.ok(at > 0 && (index === 0 || at > order[index - 1]), `409 question ${index + 1} is in its place`));
  for (const flag of ["below_cost_confirmed", "zero_rate_confirmed", "backdate_confirmed", "future_date_confirmed"]) {
    assert.match(conflict, new RegExp(`checkout\\(printAfterSave, \\{ \\.\\.\\.confirmations, ${flag}: true,[^}]*retry: true \\}\\)`), flag);
  }
  const refusal = conflict.indexOf("showCheckoutNotice(errorNotice(plainRefusalMessage(error) || getErrorMessage(error, ");
  assert.ok(refusal > order[3], "a declined question falls through to the refusal");
});

test("while a question is open, a second F4 or an Alt shortcut does nothing behind it", () => {
  assert.match(appText, /const askCheckout = async \(ask\) => \{\s*checkoutAskingRef\.current = true;\s*try \{\s*return await ask\(\);\s*\} finally \{\s*checkoutAskingRef\.current = false;/);
  assert.match(checkoutBody, /if \(checkoutAskingRef\.current\) return;/);
  assert.ok(checkoutBody.indexOf("if (checkoutAskingRef.current) return;") < checkoutBody.indexOf("CHECKOUT_GATE.BACKDATE"));
  assert.match(appText, /const handleShortcuts = \(event\) => \{\s*if \(event\.defaultPrevented \|\| shortcutsPaused\) return;\s*(\/\/[^\n]*\n\s*)*if \(appDialogQueue\.current\(\)\) return;/);
  assert.match(appText, /if \(shortcutTarget && user && !appDialogQueue\.current\(\)\) \{/);
  // Enter never confirms: the box opens with the focus on the safe choice.
  const dialogs = readFileSync(new URL("../feedbackDialogs.jsx", import.meta.url), "utf8");
  assert.match(dialogs, /cancelRef\.current\?\.focus\(\);/);
});
