import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

import {
  activeLotDiscount,
  applyLotDiscount,
  billGross,
  billSlabAmount,
  buildDiscountRows,
  buildLotDiscountPayload,
  buildSlabPayload,
  compareIds,
  currentLotDiscount,
  describeBillDiscountPreview,
  describeLotOffer,
  describeSlab,
  describeSlabOverlap,
  describeStartResult,
  discountableLots,
  discountableProducts,
  discountedUnitPrice,
  findSlabOverlap,
  formatRupees,
  formatShortDate,
  lotCost,
  lotCurrentRate,
  lotDiscountStatus,
  lotDiscountStatusText,
  lotOfferChoices,
  matchBillSlab,
  readDiscountConflict,
  reconcileCartLotDiscounts,
  resolveDiscountAvailability,
  roundMoney,
  slabMatches,
  slabPaymentMode,
  slabSnapshot,
  validateLotDiscountDraft,
  validateSlabDraft,
  DISCOUNT_APPROVAL_ACTION,
  DISCOUNT_APPROVAL_MODE,
  DISCOUNT_APPROVAL_NOTE,
  DISCOUNT_APPROVAL_OFFLINE_MESSAGE,
  DISCOUNT_APPROVAL_REQUIRED_CODE,
  MANUAL_DISCOUNT_FREE_PERCENT,
  cartDiscountApproval,
  describeDiscountApprovalError,
  describeDiscountApprovalReason,
  discountApprovalExempt,
  lineLotDiscountPart,
  lineManualDiscount,
  readDiscountApprovalRequired,
  resolveDiscountApprovalRoute,
  BILL_DISCOUNT_TOO_LARGE_CODE,
  MANUAL_BILL_DISCOUNT_MODE,
  MANUAL_BILL_DISCOUNT_RULE_SUFFIX,
  assessBillManualDiscount,
  billDiscountRuleName,
  describeBillApprovalLine,
  describePosDiscountApprovalReason,
  posDiscountApproval,
  readBillDiscountTooLarge,
  resolveManualBillDiscount,
} from "./discounts.js";

const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

const TODAY = "2026-09-30";

// ---------------------------------------------------------------------------------------------
// Money and ids
// ---------------------------------------------------------------------------------------------

test("money rounds to 2 dp, half away from zero, the way the server's roundCurrency does", () => {
  assert.equal(roundMoney((999 * 7.5) / 100), 74.93);
  assert.equal(roundMoney(1.005), 1.01);
  assert.equal(roundMoney(-1.005), -1.01);
  assert.equal(roundMoney("12.345"), 12.35);
  assert.equal(roundMoney("not a number"), 0);
});

test("ids order without Number(): digit ids by length first, and '004' is not 4", () => {
  assert.ok(compareIds("10", "9") > 0);
  assert.ok(compareIds(9, "10") < 0);
  assert.equal(compareIds("7", 7), 0);
  assert.notEqual(compareIds("004", 4), 0);
  // A zero-padded id is not a plain number: it orders as text, as the server does.
  assert.ok(compareIds("004", "10") < 0);
});

test("rupees read as the shop says them", () => {
  assert.equal(formatRupees(10), "₹10");
  assert.equal(formatRupees(10.5), "₹10.50");
  assert.equal(formatRupees(1250), "₹1,250");
  assert.equal(formatRupees(null), "—");
  assert.equal(formatRupees(""), "—");
});

// ---------------------------------------------------------------------------------------------
// Lots
// ---------------------------------------------------------------------------------------------

test("a lot's current rate is its own rate when above zero, else the product's; unknown is null", () => {
  assert.equal(lotCurrentRate({ temporary_sale_rate: "130", selling_rate: "120" }), 130);
  assert.equal(lotCurrentRate({ temporary_sale_rate: 0, selling_rate: "120" }), 120);
  assert.equal(lotCurrentRate({ temporary_sale_rate: null }, { selling_rate: 90 }), 90);
  assert.equal(lotCurrentRate({ temporary_sale_rate: 0, selling_rate: 0 }), null);
});

test("an unknown cost is null, never ₹0, and a zero effective cost falls through to the purchase rate", () => {
  assert.equal(lotCost({ effective_cost_per_unit: "95.5" }), 95.5);
  assert.equal(lotCost({ effective_cost_per_unit: 0, purchase_rate: "80" }), 80);
  assert.equal(lotCost({}), null);
  assert.equal(lotCost({ effective_cost_per_unit: 0, purchase_rate: 0 }), null);
});

test("only in-stock, uncancelled lots of the product can take a discount; ids compared as text", () => {
  const lots = [
    { id: 1, product_id: "004", product_name: "Apple", remaining_qty: 10 },
    { id: 2, product_id: 4, product_name: "Kiwi", remaining_qty: 10 },
    { id: 3, product_id: "004", product_name: "Apple", remaining_qty: 0 },
    { id: 4, product_id: "004", product_name: "Apple", remaining_qty: 5, batch_status: "CANCELLED" },
  ];
  assert.deepEqual(discountableLots(lots, "004").map((lot) => lot.id), [1]);
  assert.deepEqual(discountableLots(lots, 4).map((lot) => lot.id), [2]);
  assert.deepEqual(discountableProducts(lots).map((product) => [product.name, product.lotCount]), [["Apple", 1], ["Kiwi", 1]]);
});

// ---------------------------------------------------------------------------------------------
// Lot discounts
// ---------------------------------------------------------------------------------------------

test("status by date: stopped, upcoming, ended, running (start and end inclusive)", () => {
  assert.equal(lotDiscountStatus({ active: false, start_date: TODAY }, TODAY), "STOPPED");
  assert.equal(lotDiscountStatus({ active: true, start_date: "2026-10-01" }, TODAY), "UPCOMING");
  assert.equal(lotDiscountStatus({ active: true, start_date: "2026-09-01", end_date: "2026-09-29" }, TODAY), "ENDED");
  assert.equal(lotDiscountStatus({ active: true, start_date: TODAY, end_date: TODAY }, TODAY), "RUNNING");
  assert.equal(lotDiscountStatus({ active: true, start_date: "2026-09-01" }, TODAY), "RUNNING");
});

test("badges read Running, Starts 2 Oct, Ended, Stopped", () => {
  assert.equal(lotDiscountStatusText({ active: true, start_date: TODAY }, TODAY), "Running");
  assert.equal(lotDiscountStatusText({ active: true, start_date: "2026-10-02" }, TODAY), "Starts 2 Oct");
  assert.equal(lotDiscountStatusText({ active: true, start_date: "2027-01-05" }, TODAY), "Starts 5 Jan 2027");
  assert.equal(lotDiscountStatusText({ active: true, start_date: "2026-09-01", end_date: "2026-09-02" }, TODAY), "Ended");
  assert.equal(lotDiscountStatusText({ active: false }, TODAY), "Stopped");
  assert.equal(formatShortDate("", TODAY), "—");
});

test("POS and the screen pick the same running discount: by lot id as text, newest id wins", () => {
  const discounts = [
    { id: 9, inventory_batch_id: "004", discount_type: "PERCENTAGE", discount_value: 5, start_date: "2026-09-01", active: true },
    { id: 10, inventory_batch_id: "004", discount_type: "PERCENTAGE", discount_value: 10, start_date: "2026-09-02", active: true },
    { id: 11, inventory_batch_id: 4, discount_type: "PERCENTAGE", discount_value: 50, start_date: "2026-09-02", active: true },
    { id: 12, inventory_batch_id: "004", discount_type: "PERCENTAGE", discount_value: 20, start_date: "2026-10-05", active: true },
  ];
  assert.equal(activeLotDiscount(discounts, "004", TODAY).id, 10);
  assert.equal(activeLotDiscount(discounts, 4, TODAY).id, 11);
  assert.equal(activeLotDiscount(discounts, "", TODAY), null);
  // A back-dated bill gets the discount that was running on its date.
  assert.equal(activeLotDiscount(discounts, "004", "2026-09-01").id, 9);
  assert.equal(activeLotDiscount(discounts, "004", "2026-10-06").id, 12);
  // A future discount is what the screen shows only when nothing is running.
  assert.equal(currentLotDiscount(discounts.filter((row) => row.id === 12), "004", TODAY).id, 12);
});

test("a lot discount applied: per unit, rounded, FIXED never below zero, SPECIAL_RATE replaces the price", () => {
  assert.deepEqual(applyLotDiscount(120, 2.5, { discount_type: "PERCENTAGE", discount_value: "10" }), { sellingRate: 120, discountAmount: 30, discountPerUnit: 12 });
  assert.deepEqual(applyLotDiscount(99.9, 1.333, { discount_type: "PERCENTAGE", discount_value: 7.5 }), { sellingRate: 99.9, discountAmount: 9.98, discountPerUnit: 7.49 });
  assert.deepEqual(applyLotDiscount(120, 3, { discount_type: "FIXED_AMOUNT", discount_value: 10 }), { sellingRate: 120, discountAmount: 30, discountPerUnit: 10 });
  assert.deepEqual(applyLotDiscount(120, 1, { discount_type: "FIXED_AMOUNT", discount_value: 200 }), { sellingRate: 120, discountAmount: 120, discountPerUnit: 120 });
  assert.deepEqual(applyLotDiscount(120, 2, { discount_type: "SPECIAL_RATE", discount_value: "90" }), { sellingRate: 90, discountAmount: 0, discountPerUnit: 0 });
  assert.deepEqual(applyLotDiscount(120, 2, null), { sellingRate: 120, discountAmount: 0, discountPerUnit: 0 });
});

test("offers read as sentences with the product's unit", () => {
  assert.equal(describeLotOffer({ discount_type: "FIXED_AMOUNT", discount_value: "10.00" }, "KG"), "₹10 off per kg");
  assert.equal(describeLotOffer({ discount_type: "PERCENTAGE", discount_value: "10.00" }, "KG"), "10% off");
  assert.equal(describeLotOffer({ discount_type: "SPECIAL_RATE", discount_value: "90" }, "PIECE"), "₹90 per piece");
  assert.equal(describeLotOffer({ discount_type: "SPECIAL_RATE", discount_value: "90" }, ""), "₹90 per unit");
  assert.deepEqual(lotOfferChoices("KG").map((choice) => choice.label), ["₹ off per kg", "% off", "Fixed price per kg"]);
  assert.equal(discountedUnitPrice(120, { discount_type: "PERCENTAGE", discount_value: 10 }), 108);
  assert.equal(discountedUnitPrice(null, { discount_type: "PERCENTAGE", discount_value: 10 }), null);
  assert.equal(discountedUnitPrice(null, { discount_type: "SPECIAL_RATE", discount_value: 90 }), 90);
});

test("validation refuses blank, zero, over 100%, the whole price and a price that is not lower", () => {
  const check = (draft) => validateLotDiscountDraft({ currentRate: 120, cost: 100, today: TODAY, startDate: TODAY, unit: "KG", ...draft });
  assert.deepEqual(check({ type: "FIXED_AMOUNT", value: "" }).errors, ["Enter the amount."]);
  assert.deepEqual(check({ type: "SPECIAL_RATE", value: "0" }).errors, ["The amount must be more than 0."]);
  assert.deepEqual(check({ type: "PERCENTAGE", value: "-5" }).errors, ["The amount must be more than 0."]);
  assert.deepEqual(check({ type: "PERCENTAGE", value: "100" }).errors, []);
  assert.deepEqual(check({ type: "PERCENTAGE", value: "100.01" }).errors, ["A discount cannot be more than 100%."]);
  assert.match(check({ type: "FIXED_AMOUNT", value: "120" }).errors[0], /whole price/);
  assert.deepEqual(check({ type: "FIXED_AMOUNT", value: "119.99" }).errors, []);
  assert.match(check({ type: "SPECIAL_RATE", value: "120" }).errors[0], /not a discount/);
  assert.match(check({ type: "SPECIAL_RATE", value: "150" }).errors[0], /not a discount/);
  assert.deepEqual(check({ type: "SPECIAL_RATE", value: "110" }).errors, []);
  assert.deepEqual(check({ type: "", value: "10" }).errors, ["Choose what kind of offer this is."]);
  // A lot with no rate cannot be discounted at all.
  assert.match(validateLotDiscountDraft({ type: "SPECIAL_RATE", value: "10", currentRate: null }).errors[0], /no selling rate/);
  assert.match(validateLotDiscountDraft({ type: "PERCENTAGE", value: "10", currentRate: null }).errors[0], /no selling rate/);
});

test("dates: end before start and an end already passed are refused", () => {
  const base = { type: "PERCENTAGE", value: "10", currentRate: 120, today: TODAY };
  assert.deepEqual(validateLotDiscountDraft({ ...base, startDate: "2026-10-05", endDate: "2026-10-01" }).errors, ["The end date is before the start date."]);
  assert.deepEqual(validateLotDiscountDraft({ ...base, startDate: "2026-09-01", endDate: "2026-09-29" }).errors, ["The end date has already passed."]);
  assert.deepEqual(validateLotDiscountDraft({ ...base, startDate: TODAY, endDate: TODAY }).errors, []);
});

test("below cost is a warning, not a refusal; an unknown cost warns nothing", () => {
  const result = validateLotDiscountDraft({ type: "SPECIAL_RATE", value: "90", currentRate: 120, cost: 100, today: TODAY, unit: "KG" });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, ["Below cost (₹100 per kg)."]);
  assert.deepEqual(validateLotDiscountDraft({ type: "SPECIAL_RATE", value: "90", currentRate: 120, cost: null, today: TODAY }).warnings, []);
});

test("the start body carries ids untouched and no identity", () => {
  const body = buildLotDiscountPayload({ productId: "004", lotIds: ["7", 8], type: "percentage", value: "12.345", startDate: TODAY, endDate: "" });
  assert.deepEqual(body, {
    product_id: "004",
    inventory_batch_ids: ["7", 8],
    discount_type: "PERCENTAGE",
    discount_value: 12.35,
    start_date: TODAY,
    end_date: null,
    active: true,
    remarks: "",
  });
  assert.ok(!("created_by" in body) && !("updated_by" in body));
  assert.equal(describeStartResult([{}, {}], 2), "Discount started on 2 lots. Counters pick it up on their next sync.");
  assert.equal(describeStartResult(null, 1), "Discount started on 1 lot. Counters pick it up on their next sync.");
  assert.equal(
    describeStartResult([{ replaced_discount_ids: [4] }, { replaced_discount_ids: [] }], 2),
    "Discount started on 2 lots. It replaced the discount already on that lot. Counters pick it up on their next sync.",
  );
});

test("the table shows running and upcoming first, hides ended and stopped behind a count, and never prices with 0", () => {
  const lots = [{ id: "7", product_id: 1, product_name: "Apple", unit: "KG", temporary_sale_rate: 0, selling_rate: 120, remaining_qty: 5, lot_name: "Lot A" }];
  const discounts = [
    { id: 1, inventory_batch_id: "7", product_name: "Apple", unit: "KG", discount_type: "PERCENTAGE", discount_value: "10", start_date: "2026-09-01", active: true, lot_name: "Lot A" },
    { id: 2, inventory_batch_id: "8", product_name: "Mango", unit: "KG", discount_type: "FIXED_AMOUNT", discount_value: "5", start_date: "2026-09-01", end_date: "2026-09-10", active: true, current_sale_rate: "0" },
    { id: 3, inventory_batch_id: "9", product_name: "Banana", unit: "DOZEN", discount_type: "SPECIAL_RATE", discount_value: "40", start_date: "2026-10-02", active: true, current_sale_rate: "50" },
    { id: 4, inventory_batch_id: "9", product_name: "Banana", unit: "DOZEN", discount_type: "SPECIAL_RATE", discount_value: "45", start_date: "2026-09-01", active: false },
  ];
  const { rows, hiddenCount } = buildDiscountRows(discounts, lots, { today: TODAY });
  assert.deepEqual(rows.map((row) => [row.productName, row.status]), [["Apple", "RUNNING"], ["Banana", "UPCOMING"]]);
  assert.equal(hiddenCount, 2);
  assert.equal(rows[0].offer, "10% off");
  assert.equal(rows[0].currentRate, 120);
  assert.equal(rows[0].customerPays, 108);
  assert.equal(rows[1].customerPays, 40);
  const all = buildDiscountRows(discounts, lots, { today: TODAY, showEnded: true }).rows;
  assert.equal(all.length, 4);
  const mango = all.find((row) => row.productName === "Mango");
  assert.equal(mango.status, "ENDED");
  assert.equal(mango.currentRate, null, "a ₹0 rate from the server is unknown, not a price");
  assert.equal(mango.customerPays, null);
  assert.equal(mango.canStop, false);
});

test("a changed discount re-prices the cart line; a manual price is never overwritten", () => {
  const discounts = [{ id: 20, inventory_batch_id: "7", discount_type: "PERCENTAGE", discount_value: 10, start_date: "2026-09-01", active: true }];
  const cart = [
    // Had discount 19, now replaced by 20.
    { line_id: "a", product_name: "Apple", inventory_batch_id: "7", default_selling_rate: 120, selling_rate: 90, quantity: 2, discount_amount: 0, lot_discount_id: 19, lot_discount_type: "SPECIAL_RATE", lot_discount_value: 90 },
    // Had a discount that was stopped.
    { line_id: "b", product_name: "Kiwi", inventory_batch_id: "8", default_selling_rate: 50, selling_rate: 50, quantity: 1, discount_amount: 5, lot_discount_id: 30, lot_discount_type: "FIXED_AMOUNT", lot_discount_value: 5, lot_discount_per_unit: 5 },
    // Unchanged.
    { line_id: "c", product_name: "Pear", inventory_batch_id: "9", default_selling_rate: 80, selling_rate: 80, quantity: 1, discount_amount: 0, lot_discount_id: null, lot_discount_type: null, lot_discount_value: 0 },
  ];
  const { cart: next, changed } = reconcileCartLotDiscounts(cart, discounts, TODAY);
  assert.deepEqual(changed, ["Apple", "Kiwi"]);
  assert.equal(next[0].selling_rate, 120);
  assert.equal(next[0].discount_amount, 24);
  assert.equal(next[0].lot_discount_id, 20);
  assert.equal(next[1].discount_amount, 0);
  assert.equal(next[1].lot_discount_id, null);
  assert.equal(next[2], cart[2]);

  // A line the cashier re-priced by hand is left alone when a discount starts on its lot.
  const manual = [{ line_id: "d", product_name: "Apple", inventory_batch_id: "7", default_selling_rate: 120, selling_rate: 110, quantity: 1, discount_amount: 0 }];
  assert.deepEqual(reconcileCartLotDiscounts(manual, discounts, TODAY).changed, []);
  const plain = [{ line_id: "e", product_name: "Apple", inventory_batch_id: "7", default_selling_rate: 120, selling_rate: 120, quantity: 1, discount_amount: 0 }];
  const started = reconcileCartLotDiscounts(plain, discounts, TODAY);
  assert.deepEqual(started.changed, ["Apple"]);
  assert.equal(started.cart[0].discount_amount, 12);
  // An order's agreed price is kept.
  assert.deepEqual(reconcileCartLotDiscounts([{ ...plain[0], keep_price: true }], discounts, TODAY).changed, []);
  // Nothing changed: the same array comes back, so React does not re-render for nothing.
  assert.equal(reconcileCartLotDiscounts(started.cart, discounts, TODAY).cart, started.cart);
});

// ---------------------------------------------------------------------------------------------
// Discount on bill total
// ---------------------------------------------------------------------------------------------

const slab = (id, minimum, maximum, type, value, mode = "ALL", extra = {}) => ({
  id, rule_name: `Slab ${id}`, minimum_bill_amount: minimum, maximum_bill_amount: maximum, discount_type: type, discount_value: value, payment_mode: mode, active: true, ...extra,
});

test("slab match: min <= gross <= max, blank/0/null max is no limit, payment mode ALL or equal", () => {
  assert.equal(slabMatches(slab(1, 1000, 1999, "FLAT_AMOUNT", 50), 1000, "CASH"), true);
  assert.equal(slabMatches(slab(1, 1000, 1999, "FLAT_AMOUNT", 50), 1999, "CASH"), true);
  assert.equal(slabMatches(slab(1, 1000, 1999, "FLAT_AMOUNT", 50), 1999.01, "CASH"), false);
  assert.equal(slabMatches(slab(1, 1000, 0, "FLAT_AMOUNT", 50), 50000, "CASH"), true);
  assert.equal(slabMatches(slab(1, 1000, "", "FLAT_AMOUNT", 50), 50000, "CASH"), true);
  assert.equal(slabMatches(slab(1, 1000, null, "FLAT_AMOUNT", 50), 50000, "CASH"), true);
  assert.equal(slabMatches(slab(1, 0, null, "FLAT_AMOUNT", 50, "upi"), 500, "UPI"), true);
  assert.equal(slabMatches(slab(1, 0, null, "FLAT_AMOUNT", 50, "UPI"), 500, "CASH"), false);
  assert.equal(slabMatches(slab(1, 0, null, "FLAT_AMOUNT", 50, "UPI", { active: false }), 500, "UPI"), false);
  assert.equal(slabMatches(slab(1, 0, null, "FLAT_AMOUNT", 50), 0, "CASH"), false);
});

test("the bill is measured line by line, each rounded, as the server adds it up", () => {
  // 133.1667 -> 133.17 and 15.075 -> 15.08: 148.25, where the unrounded sum would round to 148.24.
  assert.equal(billGross([{ quantity: 1.333, selling_rate: 99.9 }, { quantity: 0.335, selling_rate: 45 }]), 148.25);
  assert.equal(billGross([{ quantity: "2", selling_rate: "90" }]), 180);
  assert.equal(billGross([]), 0);
});

test("the payment mode a slab is matched on is the one the server will read from the payments", () => {
  assert.equal(slabPaymentMode("upi"), "UPI");
  assert.equal(slabPaymentMode("CREDIT"), "CREDIT");
  assert.equal(slabPaymentMode(""), "CASH");
  assert.equal(slabPaymentMode("MIXED", { CASH: "100", UPI: "", CARD: "0" }), "CASH");
  assert.equal(slabPaymentMode("MIXED", { CASH: "100", UPI: "50" }), "MIXED");
  assert.equal(slabPaymentMode("MIXED", {}), "CASH");
  // Mixed matches only an "any payment" slab.
  assert.equal(slabMatches(slab(1, 0, null, "FLAT_AMOUNT", 10, "CASH"), 500, "MIXED"), false);
  assert.equal(slabMatches(slab(1, 0, null, "FLAT_AMOUNT", 10, "ALL"), 500, "MIXED"), true);
});

test("slab amount: percent of gross rounded to 2 dp, capped at the bill after item discounts", () => {
  assert.equal(billSlabAmount(slab(1, 0, null, "PERCENTAGE", 7.5), 999, 999), 74.93);
  assert.equal(billSlabAmount(slab(1, 0, null, "FLAT_AMOUNT", 50), 1000, 30), 30);
  assert.equal(billSlabAmount(slab(1, 0, null, "FLAT_AMOUNT", 50), 1000, -5), 0);
  assert.equal(billSlabAmount(null, 1000, 1000), 0);
});

test("several match: the most money off wins, a tie goes to the newest id; off means nothing", () => {
  const rules = [
    slab(1, 0, null, "FLAT_AMOUNT", 50),
    slab(2, 1000, null, "PERCENTAGE", 5),
    slab(3, 1000, null, "FLAT_AMOUNT", 100, "CASH"),
  ];
  // 5% of 5000 = 250 beats ₹50 and ₹100 (the old code compared the raw 50 with 5).
  assert.equal(matchBillSlab(rules, { gross: 5000, subtotalAfterItems: 5000, paymentMode: "CASH" }).rule.id, 2);
  assert.equal(matchBillSlab(rules, { gross: 5000, subtotalAfterItems: 5000, paymentMode: "CASH" }).amount, 250);
  // ₹100 flat vs 5% of 2000 = ₹100: tie, newest id wins.
  assert.equal(matchBillSlab(rules, { gross: 2000, subtotalAfterItems: 2000, paymentMode: "CASH" }).rule.id, 3);
  assert.equal(matchBillSlab(rules, { gross: 2000, subtotalAfterItems: 2000, paymentMode: "UPI" }).rule.id, 2);
  assert.deepEqual(matchBillSlab(rules, { gross: 2000, subtotalAfterItems: 2000, paymentMode: "CASH", enabled: false }), { rule: null, amount: 0 });
  assert.deepEqual(matchBillSlab([], { gross: 2000, subtotalAfterItems: 2000, paymentMode: "CASH" }), { rule: null, amount: 0 });
  // Both capped at the bill: the larger raw amount still decides which slab the bill records.
  const capped = [slab(1, 0, null, "FLAT_AMOUNT", 500), slab(2, 0, null, "FLAT_AMOUNT", 400)];
  assert.deepEqual(matchBillSlab(capped, { gross: 300, subtotalAfterItems: 300, paymentMode: "CASH" }), { rule: capped[0], amount: 300 });
  // Tie across ids of different lengths orders like the database issued them, without Number().
  const tie = [slab("10", 0, null, "FLAT_AMOUNT", 20), slab("9", 0, null, "FLAT_AMOUNT", 20)];
  assert.equal(matchBillSlab(tie, { gross: 100, subtotalAfterItems: 100, paymentMode: "CASH" }).rule.id, "10");
});

test("slab validation: value > 0, % <= 100, from >= 0, to blank or above from", () => {
  const ok = { minimum_bill_amount: "1000", maximum_bill_amount: "", discount_type: "PERCENTAGE", discount_value: "2", payment_mode: "ALL" };
  assert.deepEqual(validateSlabDraft(ok), {});
  assert.deepEqual(Object.keys(validateSlabDraft({ ...ok, discount_value: "0" })), ["discount_value"]);
  assert.deepEqual(Object.keys(validateSlabDraft({ ...ok, discount_value: "" })), ["discount_value"]);
  assert.deepEqual(Object.keys(validateSlabDraft({ ...ok, discount_value: "100.5" })), ["discount_value"]);
  assert.deepEqual(validateSlabDraft({ ...ok, discount_type: "FLAT_AMOUNT", discount_value: "150" }), {});
  assert.deepEqual(validateSlabDraft({ ...ok, minimum_bill_amount: "" }), {}, "a blank From is ₹0");
  assert.deepEqual(Object.keys(validateSlabDraft({ ...ok, minimum_bill_amount: "-1" })), ["minimum_bill_amount"]);
  assert.deepEqual(Object.keys(validateSlabDraft({ ...ok, maximum_bill_amount: "1000" })), ["maximum_bill_amount"]);
  assert.deepEqual(validateSlabDraft({ ...ok, maximum_bill_amount: "1999" }), {});
  assert.deepEqual(validateSlabDraft({ ...ok, maximum_bill_amount: "0" }), {}, "0 means no upper limit");
});

test("overlapping slabs are refused when their payment modes can meet; ALL meets everything", () => {
  const rules = [slab(1, 1000, 1999, "PERCENTAGE", 2, "ALL", { rule_name: "" }), slab(2, 5000, null, "FLAT_AMOUNT", 200, "UPI")];
  assert.equal(findSlabOverlap({ minimum_bill_amount: 1500, maximum_bill_amount: 2500, payment_mode: "CASH" }, rules).id, 1);
  assert.equal(findSlabOverlap({ minimum_bill_amount: 1999, maximum_bill_amount: "", payment_mode: "CARD" }, rules).id, 1, "touching at one amount is an overlap");
  assert.equal(findSlabOverlap({ minimum_bill_amount: 2000, maximum_bill_amount: 4999, payment_mode: "ALL" }, rules), null);
  assert.equal(findSlabOverlap({ minimum_bill_amount: 6000, maximum_bill_amount: "", payment_mode: "CASH" }, rules), null, "Cash and UPI never meet");
  assert.equal(findSlabOverlap({ minimum_bill_amount: 6000, maximum_bill_amount: "", payment_mode: "ALL" }, rules).id, 2);
  assert.equal(findSlabOverlap({ minimum_bill_amount: 1000, maximum_bill_amount: 1999, payment_mode: "ALL" }, rules, { ignoreId: "1" }), null, "editing a slab does not clash with itself");
  assert.equal(findSlabOverlap({ minimum_bill_amount: 1000, maximum_bill_amount: 1999, payment_mode: "ALL" }, [{ ...rules[0], active: false }]), null);
  assert.equal(findSlabOverlap({ minimum_bill_amount: 1000, maximum_bill_amount: 1999, payment_mode: "ALL", active: false }, rules), null, "a switched-off slab clashes with nothing");
  assert.equal(describeSlabOverlap(rules[0]), "Overlaps 'Bills ₹1,000 – ₹1,999'. Change the range.");
});

test("slabs read as sentences, and the body fills a blank name from the range and sends no identity", () => {
  assert.equal(describeSlab(slab(1, 1000, 1999, "PERCENTAGE", "2.00")), "Bills ₹1,000 – ₹1,999 → 2% off · any payment");
  assert.equal(describeSlab(slab(1, 2000, null, "FLAT_AMOUNT", 100, "CASH")), "Bills ₹2,000 and above → ₹100 off · Cash only");
  const body = buildSlabPayload({ rule_name: " ", minimum_bill_amount: "2000", maximum_bill_amount: "", discount_type: "flat_amount", discount_value: "100", payment_mode: "" });
  assert.deepEqual(body, { rule_name: "Bills ₹2,000 and above", minimum_bill_amount: 2000, maximum_bill_amount: null, discount_type: "FLAT_AMOUNT", discount_value: 100, payment_mode: "ALL", active: true });
  assert.equal(buildSlabPayload({ rule_name: "Diwali", minimum_bill_amount: "0", maximum_bill_amount: "999", discount_type: "PERCENTAGE", discount_value: "5", payment_mode: "UPI" }).rule_name, "Diwali");
});

test("a bill carries the slab it was given; POS says when bill discounts are off", () => {
  assert.deepEqual(slabSnapshot(slab(3, 1000, null, "PERCENTAGE", "5", "cash")), {
    discount_rule_id: 3, discount_rule_name: "Slab 3", discount_rule_type: "PERCENTAGE", discount_rule_value: 5, discount_rule_payment_mode: "CASH",
  });
  assert.deepEqual(slabSnapshot(null), { discount_rule_id: null, discount_rule_name: null, discount_rule_type: null, discount_rule_value: null, discount_rule_payment_mode: null });
  assert.equal(describeBillDiscountPreview({ enabled: false }), "Bill discounts are off");
  assert.equal(describeBillDiscountPreview({ enabled: true, rule: null }), "No bill-total discount for this bill");
});

// ---------------------------------------------------------------------------------------------
// Availability and server answers
// ---------------------------------------------------------------------------------------------

test("Local Only, no cloud and offline each say why, and a working connection says nothing", () => {
  assert.match(resolveDiscountAvailability({ localOnly: true, offline: true }), /Local Only mode/);
  assert.match(resolveDiscountAvailability({ noCloud: true }), /not connected to a cloud server/);
  assert.match(resolveDiscountAvailability({ offline: true }), /offline/);
  assert.equal(resolveDiscountAvailability({}), null);
});

test("a discount conflict at checkout is read with the server's own words", () => {
  const changed = readDiscountConflict(409, { code: "DISCOUNT_CHANGED", message: "A discount on Apple has changed. POS has reloaded discounts - check the bill and try again." });
  assert.equal(changed.code, "DISCOUNT_CHANGED");
  assert.match(changed.message, /Apple/);
  const rules = readDiscountConflict(409, { code: "DISCOUNT_RULES_CHANGED", expected_invoice_discount: "74.925" });
  assert.equal(rules.expectedInvoiceDiscount, 74.93);
  assert.match(rules.message, /Bill discount rules changed/);
  assert.equal(readDiscountConflict(409, { requires_below_cost_confirmation: true }), null);
  assert.equal(readDiscountConflict(400, { code: "DISCOUNT_CHANGED" }), null);
});

// ---------------------------------------------------------------------------------------------
// App.jsx uses these, and only these
// ---------------------------------------------------------------------------------------------

test("App.jsx takes lot and slab maths from local/discounts.js and has no copies of its own", () => {
  assert.match(app, /from "\.\/local\/discounts";/);
  assert.doesNotMatch(app, /const calculateDiscountFromRule\b/);
  assert.doesNotMatch(app, /const getMatchingDiscountRule\b/);
  assert.doesNotMatch(app, /const applyLotDiscount = \(/);
  assert.doesNotMatch(app, /const getActiveLotDiscount = \(lotId\) => \{/);
  assert.match(app, /matchBillSlab\(discountRules, \{/);
});

const functionBody = (name) => {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const next = app.indexOf("\nfunction ", start + 10);
  return app.slice(start, next < 0 ? undefined : next);
};

test("the Discounts screens ask in the page, never with a browser box, and send no identity", () => {
  for (const name of ["DiscountManagementModule", "DiscountSettings"]) {
    const body = functionBody(name);
    assert.doesNotMatch(body, /window\.(prompt|confirm)\(/, `${name} uses a browser prompt`);
    assert.doesNotMatch(body, /\balert\(/, `${name} uses alert()`);
    assert.doesNotMatch(body, /created_by|updated_by/, `${name} sends an identity in the body`);
    assert.match(body, /role="alert"/, `${name} must show a failure as an alert, not as an empty list`);
  }
  // The availability gate comes before any request.
  assert.match(app, /resolveDiscountAvailability\(\{/);
});

test("POS sends the slab it used with the bill, from the browser and from the desktop", () => {
  assert.match(app, /\.\.\.slabSnapshot\(totals\.discountRule\)/);
  assert.equal([...app.matchAll(/\.\.\.slabSnapshot\(totals\.discountRule\)/g)].length, 2);
  assert.match(app, /readDiscountConflict\(error\.response\?\.status, responseData\)/);
});

// ---------------------------------------------------------------------------------------------
// The till and the server agree (backend/discounts.js implements the same contract)
// ---------------------------------------------------------------------------------------------

const backendPath = new URL("../../../backend/discounts.js", import.meta.url);
const backend = existsSync(backendPath) ? createRequire(import.meta.url)(backendPath.pathname) : null;

test("slab choice and amount match backend/discounts.js on the same bills", { skip: backend ? false : "backend/discounts.js not present" }, () => {
  const rules = [
    slab(1, 0, null, "FLAT_AMOUNT", 50),
    slab(2, 1000, 1999, "PERCENTAGE", 7.5),
    slab(3, 1000, 0, "FLAT_AMOUNT", 100, "CASH"),
    slab(4, 2000, "", "PERCENTAGE", 5, "upi"),
    slab("10", 5000, null, "FLAT_AMOUNT", 250),
    slab(11, 0, null, "PERCENTAGE", 50, "ALL", { active: false }),
  ];
  for (const gross of [0.5, 999, 999.99, 1000, 1333.33, 1999, 1999.01, 2000, 4999.5, 5000, 12345.67]) {
    for (const mode of ["CASH", "UPI", "CARD", "BANK_TRANSFER"]) {
      for (const subtotal of [gross, gross / 2, 20]) {
        for (const enabled of [true, false]) {
          const mine = matchBillSlab(rules, { gross, subtotalAfterItems: subtotal, paymentMode: mode, enabled });
          const theirs = backend.matchBillSlab(rules, gross, mode, { enabled });
          const where = `gross ${gross}, ${mode}, subtotal ${subtotal}, enabled ${enabled}`;
          assert.equal(mine.rule?.id ?? null, theirs?.id ?? null, where);
          assert.equal(mine.amount, theirs ? backend.billSlabAmount(theirs, gross, subtotal) : 0, where);
        }
      }
    }
  }
});

test("lot discount status, pick and line amounts match backend/discounts.js", { skip: backend ? false : "backend/discounts.js not present" }, () => {
  const discounts = [
    { id: 9, inventory_batch_id: "7", discount_type: "PERCENTAGE", discount_value: "7.5", start_date: "2026-09-01", active: true },
    { id: 10, inventory_batch_id: "7", discount_type: "FIXED_AMOUNT", discount_value: "12.5", start_date: "2026-09-20", end_date: "2026-09-30", active: true },
    { id: "004", inventory_batch_id: "8", discount_type: "SPECIAL_RATE", discount_value: "90", start_date: "2026-09-01", active: true },
    { id: 12, inventory_batch_id: "8", discount_type: "SPECIAL_RATE", discount_value: "95", start_date: "2026-10-02", active: true },
    { id: 13, inventory_batch_id: "8", discount_type: "PERCENTAGE", discount_value: "10", start_date: "2026-09-01", active: false },
  ];
  for (const day of ["2026-08-31", "2026-09-01", "2026-09-25", "2026-09-30", "2026-10-01", "2026-10-02"]) {
    for (const discount of discounts) assert.equal(lotDiscountStatus(discount, day), backend.lotDiscountStatus(discount, day), `${discount.id} on ${day}`);
    for (const lot of ["7", "8", 8, "9"]) {
      const mine = activeLotDiscount(discounts, lot, day);
      const theirs = backend.activeLotDiscount(discounts, lot, day);
      assert.equal(mine?.id ?? null, theirs?.id ?? null, `lot ${lot} on ${day}`);
      for (const [rate, quantity] of [[120, 1], [99.9, 1.333], [10, 2.5]]) {
        const expected = theirs ? backend.expectedLotDiscount(theirs, rate, quantity) : null;
        const applied = applyLotDiscount(rate, quantity, mine);
        if (!expected) continue;
        assert.equal(applied.sellingRate, expected.sellingRate, `rate, lot ${lot} on ${day}`);
        assert.equal(applied.discountAmount, expected.lineDiscount, `line discount, lot ${lot} on ${day}`);
      }
    }
  }
});

test("slab validation and overlap agree with backend/discounts.js", { skip: backend ? false : "backend/discounts.js not present" }, () => {
  const drafts = [
    { minimum_bill_amount: "1000", maximum_bill_amount: "", discount_type: "PERCENTAGE", discount_value: "2", payment_mode: "ALL" },
    { minimum_bill_amount: "", maximum_bill_amount: "999", discount_type: "FLAT_AMOUNT", discount_value: "20", payment_mode: "CASH" },
    { minimum_bill_amount: "1000", maximum_bill_amount: "1000", discount_type: "FLAT_AMOUNT", discount_value: "20", payment_mode: "CASH" },
    { minimum_bill_amount: "1000", maximum_bill_amount: "0", discount_type: "FLAT_AMOUNT", discount_value: "20", payment_mode: "CASH" },
    { minimum_bill_amount: "0", maximum_bill_amount: "", discount_type: "PERCENTAGE", discount_value: "100.01", payment_mode: "UPI" },
    { minimum_bill_amount: "0", maximum_bill_amount: "", discount_type: "PERCENTAGE", discount_value: "0", payment_mode: "UPI" },
    { minimum_bill_amount: "-1", maximum_bill_amount: "", discount_type: "FLAT_AMOUNT", discount_value: "5", payment_mode: "ALL" },
  ];
  for (const draft of drafts) {
    const mineOk = Object.keys(validateSlabDraft(draft)).length === 0;
    const theirs = backend.validateSlabInput(draft);
    assert.equal(mineOk, Boolean(theirs.rule), JSON.stringify(draft));
    if (theirs.rule) assert.deepEqual(buildSlabPayload(draft), theirs.rule, "same body, same name made from the range");
  }
  const existing = [slab(1, 1000, 1999, "PERCENTAGE", 2), slab(2, 5000, null, "FLAT_AMOUNT", 200, "UPI"), slab(3, 3000, 3999, "FLAT_AMOUNT", 50, "CASH", { active: false })];
  for (const candidate of [
    { minimum_bill_amount: 1500, maximum_bill_amount: 2500, payment_mode: "CASH" },
    { minimum_bill_amount: 1999, maximum_bill_amount: null, payment_mode: "CARD" },
    { minimum_bill_amount: 2000, maximum_bill_amount: 4999, payment_mode: "ALL" },
    { minimum_bill_amount: 6000, maximum_bill_amount: null, payment_mode: "CASH" },
    { minimum_bill_amount: 6000, maximum_bill_amount: 0, payment_mode: "ALL" },
    { minimum_bill_amount: 1000, maximum_bill_amount: 1999, payment_mode: "ALL", active: false },
  ]) {
    assert.equal(findSlabOverlap(candidate, existing)?.id ?? null, backend.findSlabOverlap(candidate, existing)?.id ?? null, JSON.stringify(candidate));
  }
});

test("a lot discount the screen accepts is one the server accepts, and the other way round", { skip: backend ? false : "backend/discounts.js not present" }, () => {
  for (const type of ["FIXED_AMOUNT", "PERCENTAGE", "SPECIAL_RATE", ""]) {
    for (const value of ["", "0", "-1", "5", "99.99", "100", "100.01", "119.99", "120", "150"]) {
      for (const currentRate of [120, null]) {
        const mine = validateLotDiscountDraft({ type, value, currentRate, startDate: TODAY, today: TODAY });
        const theirs = backend.validateLotDiscountInput({ type, value, currentRate, startDate: TODAY });
        assert.equal(mine.errors.length === 0, !theirs.error, `${type} ${value} at ${currentRate}: ${mine.errors[0] || ""} / ${theirs.error || ""}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Manual item discount over 5% needs Owner/Admin approval
// ---------------------------------------------------------------------------------------------

const line = (overrides = {}) => ({
  line_id: "line-1",
  product_name: "Apple",
  quantity: 2,
  selling_rate: 100,
  discount_amount: 0,
  lot_discount_id: null,
  lot_discount_type: null,
  lot_discount_value: 0,
  ...overrides,
});

test("up to 5% off a line needs nobody; a paisa over the limit and its rounding tolerance does", () => {
  assert.equal(MANUAL_DISCOUNT_FREE_PERCENT, 5);
  assert.equal(DISCOUNT_APPROVAL_NOTE, "Up to 5% without approval");
  // 2 x ₹100 = ₹200; 5% is ₹10; the rule allows ₹10.01 (tolerance) and asks at ₹10.02.
  assert.equal(lineManualDiscount(line({ discount_amount: 10 })).needsApproval, false);
  assert.equal(lineManualDiscount(line({ discount_amount: 10.01 })).needsApproval, false);
  assert.equal(lineManualDiscount(line({ discount_amount: 10.02 })).needsApproval, true);
  assert.equal(lineManualDiscount(line({ discount_amount: 0 })).needsApproval, false);
  // A ₹1,000 line: 5% is ₹50; ₹50.01 is inside the paisa of tolerance, ₹50.02 is not.
  const thousand = { quantity: 10, selling_rate: 100 };
  assert.equal(lineManualDiscount(line({ ...thousand, discount_amount: 50 })).needsApproval, false);
  assert.equal(lineManualDiscount(line({ ...thousand, discount_amount: 50.01 })).needsApproval, false);
  assert.equal(lineManualDiscount(line({ ...thousand, discount_amount: 50.02 })).needsApproval, true);
  assert.equal(lineManualDiscount(line({ ...thousand, discount_amount: 60 })).needsApproval, true);
  const over = lineManualDiscount(line({ discount_amount: 25 }));
  assert.deepEqual(over, { lotPart: 0, base: 200, manualPart: 25, freeLimit: 10, percent: 12.5, needsApproval: true, unreadable: false });
  // A blank discount is no discount. An unreadable one is not waved through.
  assert.equal(lineManualDiscount(line({ discount_amount: "" })).needsApproval, false);
  assert.equal(lineManualDiscount(line({ discount_amount: null })).needsApproval, false);
  assert.equal(lineManualDiscount(line({ discount_amount: "abc" })).needsApproval, true);
  // A quantity still being typed ("") with money off it is asked about; with none, it is not.
  assert.equal(lineManualDiscount(line({ quantity: "", discount_amount: 1 })).needsApproval, true);
  assert.equal(lineManualDiscount(line({ quantity: "", discount_amount: 0 })).needsApproval, false);
  // Typed as text (the input's value) it is the same number.
  assert.equal(lineManualDiscount(line({ discount_amount: "10.02", quantity: "2", selling_rate: "100" })).needsApproval, true);
});

test("a lot discount is not the cashier's: only what is typed on top of it counts, against the line after it", () => {
  // 10% lot discount on ₹100 x 2: lot part ₹20, base ₹180, free ₹9.
  const lot = { lot_discount_id: "004", lot_discount_type: "PERCENTAGE", lot_discount_value: 10 };
  assert.equal(lineLotDiscountPart(line(lot)), 20);
  assert.equal(lineManualDiscount(line({ ...lot, discount_amount: 20 })).needsApproval, false, "the lot discount alone");
  assert.equal(lineManualDiscount(line({ ...lot, discount_amount: 29 })).needsApproval, false, "₹9 on top is 5% of ₹180");
  const extra = lineManualDiscount(line({ ...lot, discount_amount: 29.02 }));
  assert.equal(extra.needsApproval, true);
  assert.equal(extra.base, 180);
  assert.equal(extra.manualPart, 9.02);
  // Typing less than the lot discount is not a negative manual discount.
  assert.equal(lineManualDiscount(line({ ...lot, discount_amount: 5 })).manualPart, 0);
  // ₹ off per unit: ₹15 x 2 = ₹30; never more than the rate per unit.
  assert.equal(lineLotDiscountPart(line({ lot_discount_id: "7", lot_discount_type: "FIXED_AMOUNT", lot_discount_value: 15 })), 30);
  assert.equal(lineLotDiscountPart(line({ lot_discount_id: "7", lot_discount_type: "FIXED_AMOUNT", lot_discount_value: 150 })), 200);
  // SPECIAL_RATE: the price is the special price, so the lot part is 0 and base is qty x that price.
  const special = { lot_discount_id: "9", lot_discount_type: "SPECIAL_RATE", lot_discount_value: 80, selling_rate: 80 };
  assert.equal(lineLotDiscountPart(line(special)), 0);
  assert.equal(lineManualDiscount(line({ ...special, discount_amount: 8 })).needsApproval, false);
  assert.equal(lineManualDiscount(line({ ...special, discount_amount: 8.02 })).needsApproval, true);
  // No claim, no lot part, whatever value is lying on the line.
  assert.equal(lineLotDiscountPart(line({ lot_discount_value: 10 })), 0);
});

test("a line with nothing to measure against still asks for any real money off, and says no percentage", () => {
  const free = lineManualDiscount(line({ selling_rate: 0, discount_amount: 5 }));
  assert.equal(free.needsApproval, true);
  assert.equal(free.percent, null, "a percentage of nothing is not 0%");
  assert.equal(lineManualDiscount(line({ selling_rate: 0, discount_amount: 0 })).needsApproval, false);
});

test("the bill needs approval when any line does; Owner, Admin and rate-override holders are never asked", () => {
  const cart = [line({ line_id: "a", discount_amount: 5 }), line({ line_id: "b", product_name: "Mango", discount_amount: 30 })];
  const result = cartDiscountApproval(cart);
  assert.equal(result.needed, true);
  assert.deepEqual(result.lines, [{ lineId: "b", productName: "Mango", discount: 30, base: 200, percent: 15 }]);
  assert.deepEqual(cartDiscountApproval([line({ discount_amount: 5 })]), { needed: false, lines: [] });
  assert.deepEqual(cartDiscountApproval(cart, { exempt: true }), { needed: false, lines: [] });
  assert.deepEqual(cartDiscountApproval(null), { needed: false, lines: [] });

  assert.equal(discountApprovalExempt({ role: "Owner" }), true);
  assert.equal(discountApprovalExempt({ role: " Admin " }), true);
  assert.equal(discountApprovalExempt({ role: "admin" }), false, "matched exactly, as the server does");
  assert.equal(discountApprovalExempt({ role: "Cashier", canManualRateOverride: true }), true);
  assert.equal(discountApprovalExempt({ role: "Cashier" }), false);
  assert.equal(discountApprovalExempt({ role: "Manager", canManualRateOverride: "yes" }), false, "only an exact true exempts");
  assert.equal(discountApprovalExempt({}), false, "no role is asked, not waved through");
});

test("the approval reason names each line over the limit and fits the server's 500 characters", () => {
  const { lines } = cartDiscountApproval([line({ discount_amount: 25 })]);
  assert.equal(describeDiscountApprovalReason(lines), "Item discount over 5%: Apple 12.5% (₹25 of ₹200)");
  const many = Array.from({ length: 40 }, (_, index) => line({ line_id: String(index), product_name: `Product number ${index}`, discount_amount: 50 }));
  const reason = describeDiscountApprovalReason(cartDiscountApproval(many).lines);
  assert.ok(reason.length <= 500);
  assert.equal(DISCOUNT_APPROVAL_ACTION, "discount", "sale_change_approvals.action is VARCHAR(20)");
});

test("approval goes to the cloud only when online, not Local Only, and the gate says yes -- otherwise refused before billing", () => {
  assert.deepEqual(resolveDiscountApprovalRoute({ needsApproval: false, offlineMode: true, localOnly: true }), { mode: DISCOUNT_APPROVAL_MODE.NONE });
  assert.deepEqual(resolveDiscountApprovalRoute({ needsApproval: true, cloudGateAllowed: true }), { mode: DISCOUNT_APPROVAL_MODE.CLOUD });
  for (const state of [
    { needsApproval: true, offlineMode: true, cloudGateAllowed: true },
    { needsApproval: true, localOnly: true, cloudGateAllowed: true },
    { needsApproval: true, cloudGateAllowed: false },
    { needsApproval: true },
    { needsApproval: undefined, cloudGateAllowed: true, offlineMode: true },
  ]) {
    assert.deepEqual(resolveDiscountApprovalRoute(state), { mode: DISCOUNT_APPROVAL_MODE.REFUSED, message: DISCOUNT_APPROVAL_OFFLINE_MESSAGE }, JSON.stringify(state));
  }
  assert.equal(DISCOUNT_APPROVAL_OFFLINE_MESSAGE, "A discount over 5% needs an Owner or Admin's approval, which needs internet. Give up to 5%, or wait for the connection.");
});

test("a 403 DISCOUNT_APPROVAL_REQUIRED is read as 'open the approval dialog'; nothing else is", () => {
  assert.deepEqual(readDiscountApprovalRequired(403, { code: DISCOUNT_APPROVAL_REQUIRED_CODE, message: "Needs approval." }), { message: "Needs approval." });
  assert.deepEqual(readDiscountApprovalRequired("403", { code: "discount_approval_required" }), { message: "A discount over 5% needs an Owner or Admin to approve it." });
  assert.equal(readDiscountApprovalRequired(403, { message: "You do not have permission to change sale rate" }), null);
  assert.equal(readDiscountApprovalRequired(409, { code: DISCOUNT_APPROVAL_REQUIRED_CODE }), null);
});

test("a failed approval shows the server's sentence for a wrong password, and always says the cart is kept", () => {
  const wrong = { isAxiosError: true, response: { status: 401, data: { code: "APPROVER_CREDENTIALS_INVALID", message: "That Owner or Admin username or password is not right." } } };
  assert.equal(describeDiscountApprovalError(wrong), "That Owner or Admin username or password is not right. The bill is not saved yet; the cart is still here.");
  const silent = { isAxiosError: true, response: { status: 401, data: { code: "APPROVER_CREDENTIALS_INVALID" } } };
  assert.match(describeDiscountApprovalError(silent), /^The Owner or Admin username or password is wrong\. /);
  const unreachable = { isAxiosError: true, request: {} };
  assert.match(describeDiscountApprovalError(unreachable), /could not be reached\. The bill is not saved yet; the cart is still here\.$/);
  const technical = { isAxiosError: true, response: { status: 500, data: { code: "XX000", message: "relation \"sale_change_approvals\" does not exist" } } };
  assert.equal(describeDiscountApprovalError(technical), "The approval could not be completed. The bill is not saved yet; the cart is still here.");
  assert.equal(describeDiscountApprovalError(null), "The approval could not be completed. The bill is not saved yet; the cart is still here.");
});

// How POS wires the 5% rule. The decisions are tested above; this pins the order App.jsx asks
// them in, because that order is what keeps LOCAL_ONLY at zero cloud calls and the cart intact.
const appSlice = (startMarker, endMarker) => {
  const start = app.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  const end = app.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing ${endMarker} after ${startMarker}`);
  return app.slice(start, end);
};
const comesBefore = (source, first, second) => {
  const a = source.indexOf(first);
  const b = source.indexOf(second);
  assert.notEqual(a, -1, `missing ${first}`);
  assert.notEqual(b, -1, `missing ${second}`);
  assert.ok(a < b, `${first} must come before ${second}`);
};

test("POS discount approval: offline and Local Only are refused before the cloud gate is asked", () => {
  const route = appSlice("const resolvePosDiscountApprovalRoute = ", "const requestSaleChangeApproval = ");
  comesBefore(route, "isSaleChangeLocalOnly(connectivityMode)", "guardCloudCall(\"discount-approval\"");
  assert.match(route, /!needsApproval \|\| offlineMode \|\| localOnly\s*\?\s*false/);
  assert.match(route, /hasCloudSession\(user\) !== false/);
  assert.match(route, /resolveDiscountApprovalRoute\(\{/);
});

test("POS checkout asks for approval before billing, sends the approval with the bill's own reference, and keeps the cart", () => {
  const checkoutBody = appSlice("const checkout = async (printAfterSave = false, confirmations = {}) => {", "const handleSearchKeys = ");
  // Decided before anything is saved, locally or on the server.
  comesBefore(checkoutBody, "discountApprovalCheck.needed", "setSaving(true)");
  comesBefore(checkoutBody, "resolvePosDiscountApprovalRoute(", "completeLocalPosSale(localSale)");
  comesBefore(checkoutBody, "openDiscountApproval(", "axios.post(`${API_URL}/api/v3/sales`");
  // The approval id and the reference it was issued for travel with both kinds of bill.
  assert.match(checkoutBody, /buildLocalSalePayload\(\{ payments, selectedBillDate, dateOverrideReason, operationId: saleRef, discountApprovalId \}\)/);
  assert.match(checkoutBody, /discount_approval_id: discountApprovalId \} : \{\}\),\n\s*\}, saleRef\);/);
  // A 403 DISCOUNT_APPROVAL_REQUIRED opens the dialog instead of an alert.
  assert.match(checkoutBody, /readDiscountApprovalRequired\(error\.response\?\.status, responseData\)/);
  // Refusals and the dialog never empty the cart: setCart([]) only after a bill is saved.
  const refusal = appSlice("if (!discountApprovalId && confirmations.discount_approval_not_needed !== true && discountApprovalCheck.needed) {", "setSaving(true)");
  assert.doesNotMatch(refusal, /setCart\(/);
  // An approval is never held while the cart can change: the dialog keeps only the bill's
  // reference, drops any earlier approval when it reopens, and checkout is resumed straight away.
  const open = appSlice("const openDiscountApproval = ", "const closeDiscountApproval = ");
  assert.match(open, /discount_approval_id: _usedApproval, discount_approval_not_needed: _notNeeded, sale_ref: _usedRef/);
  assert.doesNotMatch(app, /useState\([^)]*discount_approval_id/);
  const confirmBody = appSlice("const confirmDiscountApproval = async () => {", "const checkout = async (");
  comesBefore(confirmBody, "setDiscountApproval(null);", "await checkout(draft.printAfterSave");
  const payload = appSlice("const buildLocalSalePayload = ", "const openDiscountApproval = ");
  assert.match(payload, /operation_id: operationId \|\| newSyncId\("op"\)/);
  assert.match(payload, /discount_approval_id: discountApprovalId/);
});

test("the approval dialog asks the server only on the CLOUD route and forgets the password every time", () => {
  const confirm = appSlice("const confirmDiscountApproval = async () => {", "const checkout = async (");
  comesBefore(confirm, "resolvePosDiscountApprovalRoute(", "requestSaleChangeApproval(");
  comesBefore(confirm, "if (route.mode !== DISCOUNT_APPROVAL_MODE.CLOUD)", "requestSaleChangeApproval(");
  assert.match(confirm, /action: DISCOUNT_APPROVAL_ACTION/);
  assert.match(confirm, /saleRef: draft\.saleRef/);
  assert.match(confirm, /approverPassword: "", error, saving: false/);
  assert.match(confirm, /describeDiscountApprovalError\(error\)/);
  comesBefore(confirm, "requestSaleChangeApproval(", "discount_approval_id: approvalId");
  // The same username/password fields as a cashier's cancel or edit, not a second copy.
  const modal = appSlice("function DiscountApprovalModal(", "\nfunction ");
  assert.match(modal, /<SaleChangeApprovalFields/);
  assert.doesNotMatch(modal, /type="password"/);
});

test("POS shows the 5% note only to someone who can be asked, and exempts Owner, Admin and rate-override holders", () => {
  assert.match(app, /const discountExempt = discountApprovalExempt\(\{ role: user\?\.role, canManualRateOverride \}\);/);
  assert.match(app, /!discountExempt && <small className="cell-note pos-discount-limit-note">\{DISCOUNT_APPROVAL_NOTE\}<\/small>/);
  assert.match(app, /connectivityMode=\{connectivityMode\}\n\s*offlineMode=\{offlineMode\}/);
});

test("the till and the server agree on every line of the 5% rule", { skip: backend?.manualDiscountLine ? false : "backend/discounts.js has no manualDiscountLine" }, () => {
  const lots = [
    null,
    { id: "004", discount_type: "PERCENTAGE", discount_value: 10 },
    { id: "7", discount_type: "FIXED_AMOUNT", discount_value: 15 },
    { id: "7", discount_type: "FIXED_AMOUNT", discount_value: 150 },
    { id: "9", discount_type: "SPECIAL_RATE", discount_value: 80 },
  ];
  let compared = 0;
  for (const lot of lots) {
    for (const quantity of [2, 0.75, "1.125", "", 0]) {
      for (const rate of [100, 80, 33.33, 0, ""]) {
        for (const discount of [0, "", 5, 9, 9.01, 9.02, 10, 10.01, 10.02, 25, 29.02, 200, "abc"]) {
          const mine = lineManualDiscount({
            quantity,
            selling_rate: rate,
            discount_amount: discount,
            lot_discount_id: lot?.id ?? null,
            lot_discount_type: lot?.discount_type ?? null,
            lot_discount_value: lot?.discount_value ?? 0,
          });
          const theirs = backend.manualDiscountLine({ quantity, rate, discountAmount: discount, lotDiscount: lot });
          const label = JSON.stringify({ lot: lot?.discount_type || null, quantity, rate, discount });
          assert.equal(mine.needsApproval, theirs.needsApproval, label);
          assert.equal(mine.unreadable, theirs.unreadable, label);
          if (!mine.unreadable) {
            assert.equal(mine.lotPart, theirs.lotPart, label);
            assert.equal(mine.manualPart, theirs.manualPart, label);
            assert.equal(mine.base, theirs.base, label);
            assert.equal(mine.freeLimit, theirs.freeLimit, label);
          }
          compared += 1;
        }
      }
    }
  }
  assert.ok(compared > 1000);
  assert.equal(backend.MANUAL_DISCOUNT_FREE_PERCENT, MANUAL_DISCOUNT_FREE_PERCENT);
  if ("MANUAL_DISCOUNT_TOLERANCE" in backend) assert.equal(backend.MANUAL_DISCOUNT_TOLERANCE, 0.01);
  // The whole bill: needs approval when any line does, on both sides.
  if (typeof backend.assessManualDiscounts === "function") {
    const cartLines = [
      { quantity: 10, selling_rate: 100, discount_amount: 50 },
      { quantity: 10, selling_rate: 100, discount_amount: 50.02, product_name: "Mango" },
    ];
    const theirs = backend.assessManualDiscounts(cartLines.map((entry) => ({ quantity: entry.quantity, rate: entry.selling_rate, discountAmount: entry.discount_amount })));
    assert.equal(cartDiscountApproval(cartLines).needed, theirs.needsApproval);
    assert.equal(cartDiscountApproval(cartLines.slice(0, 1)).needed, backend.assessManualDiscounts([{ quantity: 10, rate: 100, discountAmount: 50 }]).needsApproval);
  }
});

test("the till and the server agree on who is never asked", { skip: backend?.manualDiscountExempt ? false : "backend/discounts.js has no manualDiscountExempt" }, () => {
  for (const role of ["Owner", "Admin", " Owner ", "owner", "Cashier", "Manager", "", null]) {
    for (const override of [true, false]) {
      assert.equal(
        discountApprovalExempt({ role, canManualRateOverride: override }),
        backend.manualDiscountExempt({ role_name: role, permissions: { manual_pos_rate_override: override } }),
        JSON.stringify({ role, override }),
      );
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Manual bill discount ("Bill discount" box at POS, 1 Oct 2026)
// ---------------------------------------------------------------------------------------------

const AMOUNT = MANUAL_BILL_DISCOUNT_MODE.AMOUNT;
const PERCENT = MANUAL_BILL_DISCOUNT_MODE.PERCENT;

test("the bill discount box: blank is none, ₹ is taken as typed, % is of what the slab left, 2 dp", () => {
  assert.deepEqual(resolveManualBillDiscount({ mode: AMOUNT, value: "", itemsSubtotal: 1000, slabAmount: 20 }), { amount: 0, percent: null, room: 980, error: null });
  assert.deepEqual(resolveManualBillDiscount({ mode: AMOUNT, value: "  ", itemsSubtotal: 1000 }), { amount: 0, percent: null, room: 1000, error: null });
  assert.equal(resolveManualBillDiscount({ mode: AMOUNT, value: "30", itemsSubtotal: 1000, slabAmount: 20 }).amount, 30);
  assert.equal(resolveManualBillDiscount({ mode: AMOUNT, value: "12.345", itemsSubtotal: 1000 }).amount, 12.35);
  // 5% of (₹999 - ₹20 slab) = 5% of ₹979 = ₹48.95.
  const share = resolveManualBillDiscount({ mode: PERCENT, value: "5", itemsSubtotal: 999, slabAmount: 20 });
  assert.deepEqual(share, { amount: 48.95, percent: 5, room: 979, error: null });
  assert.equal(resolveManualBillDiscount({ mode: PERCENT, value: "100", itemsSubtotal: 999, slabAmount: 20 }).amount, 979, "100% is all that is left, never more");
  assert.equal(resolveManualBillDiscount({ mode: AMOUNT, value: "979", itemsSubtotal: 999, slabAmount: 20 }).error, null, "exactly what is left is allowed");
  assert.equal(resolveManualBillDiscount({ mode: AMOUNT, value: 0, itemsSubtotal: 999 }).amount, 0, "a typed 0 is ₹0, not an error");
});

test("a bill discount that cannot be billed is an error with no amount, never ₹0", () => {
  for (const [input, message] of [
    [{ mode: AMOUNT, value: "abc", itemsSubtotal: 500 }, /as a number/],
    [{ mode: AMOUNT, value: "-1", itemsSubtotal: 500 }, /less than 0/],
    [{ mode: PERCENT, value: "100.5", itemsSubtotal: 500 }, /more than 100%/],
    [{ mode: AMOUNT, value: "480.01", itemsSubtotal: 500, slabAmount: 20 }, /more than what is left of the bill \(₹480\)/],
    [{ mode: AMOUNT, value: "1", itemsSubtotal: 0 }, /more than what is left of the bill \(₹0\)/],
  ]) {
    const result = resolveManualBillDiscount(input);
    assert.equal(result.amount, null, JSON.stringify(input));
    assert.match(result.error, message, JSON.stringify(input));
  }
});

test("the 5% rule over the whole bill: lines and bill discount together, only when the box is used", () => {
  // ₹1,000 bill (10 x ₹100), no line discount: 5% is ₹50; ₹50.01 is the paisa of tolerance.
  const plain = [line({ quantity: 10, selling_rate: 100 })];
  assert.equal(assessBillManualDiscount({ lines: plain, manualBill: 50 }).needsApproval, false);
  assert.equal(assessBillManualDiscount({ lines: plain, manualBill: 50.01 }).needsApproval, false);
  assert.equal(assessBillManualDiscount({ lines: plain, manualBill: 50.02 }).needsApproval, true);
  // ₹30 on the line (3%) + ₹20 on the bill = ₹50 = 5%: fine. ₹21 on the bill: over.
  const spread = [line({ quantity: 10, selling_rate: 100, discount_amount: 30 })];
  assert.equal(assessBillManualDiscount({ lines: spread, manualBill: 20 }).needsApproval, false);
  const over = assessBillManualDiscount({ lines: spread, manualBill: 21 });
  assert.deepEqual(over, { manualBill: 21, lineManual: 30, manualTotal: 51, base: 1000, freeLimit: 50, percent: 5.1, needsApproval: true, unreadable: false });
  // A lot discount is not the cashier's: it lowers the base and does not count against the 5%.
  const lot = [line({ quantity: 10, selling_rate: 100, discount_amount: 100, lot_discount_id: "004", lot_discount_type: "PERCENTAGE", lot_discount_value: 10 })];
  assert.equal(assessBillManualDiscount({ lines: lot, manualBill: 45 }).needsApproval, false, "5% of ₹900");
  assert.equal(assessBillManualDiscount({ lines: lot, manualBill: 45.02 }).needsApproval, true);
  // No bill discount: never asks, even where the lines' own paisas of tolerance add up past it.
  const paisas = [1, 2, 3].map((index) => line({ line_id: String(index), quantity: 1, selling_rate: 100, discount_amount: 5.01 }));
  assert.equal(assessBillManualDiscount({ lines: paisas, manualBill: 0 }).needsApproval, false);
  assert.equal(assessBillManualDiscount({ lines: paisas, manualBill: "" }).needsApproval, false);
  assert.equal(assessBillManualDiscount({ lines: paisas, manualBill: 0.01 }).needsApproval, true, "with it, the whole bill is held to 5%");
});

test("an unreadable bill discount, or a bill discount on a line that cannot be measured, is not waved through", () => {
  const cart = [line({ quantity: 10, selling_rate: 100 })];
  const unreadable = assessBillManualDiscount({ lines: cart, manualBill: "abc" });
  assert.equal(unreadable.needsApproval, true);
  assert.equal(unreadable.unreadable, true);
  assert.equal(unreadable.manualBill, null);
  assert.equal(assessBillManualDiscount({ lines: cart, manualBill: -5 }).needsApproval, true);
  const halfTyped = [line({ quantity: "", selling_rate: 100 })];
  assert.equal(assessBillManualDiscount({ lines: halfTyped, manualBill: 1 }).needsApproval, true);
  assert.equal(assessBillManualDiscount({ lines: halfTyped, manualBill: 1 }).base, null);
  assert.equal(assessBillManualDiscount({ lines: halfTyped, manualBill: 0 }).needsApproval, false);
});

test("POS asks once for lines and bill: exempt users never, the bill only when its discount trips the rule", () => {
  const cart = [line({ line_id: "a", quantity: 10, selling_rate: 100, discount_amount: 30 })];
  assert.deepEqual(posDiscountApproval(cart, { manualBill: 20 }), { needed: false, lines: [], bill: null });
  const billOnly = posDiscountApproval(cart, { manualBill: 40 });
  assert.equal(billOnly.needed, true);
  assert.deepEqual(billOnly.lines, []);
  assert.equal(billOnly.bill.manualTotal, 70);
  assert.equal(billOnly.bill.percent, 7);
  assert.deepEqual(posDiscountApproval(cart, { exempt: true, manualBill: 900 }), { needed: false, lines: [], bill: null });
  const both = posDiscountApproval([line({ line_id: "b", discount_amount: 25 })], { manualBill: 5 });
  assert.equal(both.lines.length, 1);
  assert.ok(both.bill);
  // Same answer for the lines as before the box existed.
  assert.deepEqual(posDiscountApproval([line({ discount_amount: 25 })]).lines, cartDiscountApproval([line({ discount_amount: 25 })]).lines);
});

test("the approval names the whole bill when the bill discount trips it, within 500 characters", () => {
  const bill = assessBillManualDiscount({ lines: [line({ quantity: 10, selling_rate: 100, discount_amount: 30 })], manualBill: 40 });
  assert.equal(describeBillApprovalLine(bill), "Whole bill 7% with the bill discount (₹70 of ₹1,000)");
  assert.equal(describePosDiscountApprovalReason([], bill), "Bill discount over 5%: Whole bill 7% with the bill discount (₹70 of ₹1,000)");
  const { lines } = cartDiscountApproval([line({ discount_amount: 25 })]);
  assert.equal(describePosDiscountApprovalReason(lines, null), describeDiscountApprovalReason(lines), "no bill part: the reason is as before");
  assert.equal(describePosDiscountApprovalReason(lines, bill), `${describeDiscountApprovalReason(lines)}; Whole bill 7% with the bill discount (₹70 of ₹1,000)`);
  const many = Array.from({ length: 40 }, (_, index) => line({ line_id: String(index), product_name: `Product number ${index}`, discount_amount: 50 }));
  assert.ok(describePosDiscountApprovalReason(cartDiscountApproval(many).lines, bill).length <= 500);
  assert.equal(describeBillApprovalLine(assessBillManualDiscount({ lines: [], manualBill: "x" })), "Bill discount that cannot be read");
});

test("the rule name a bill keeps: the slab alone, the slab + extra, or none for the cashier's part alone", () => {
  const rule = { id: "7", rule_name: "Big bills", minimum_bill_amount: 1000, discount_type: "PERCENTAGE", discount_value: 2 };
  assert.equal(MANUAL_BILL_DISCOUNT_RULE_SUFFIX, " + extra");
  assert.equal(billDiscountRuleName(rule, 20, 0), "Big bills");
  assert.equal(billDiscountRuleName(rule, 20, 15), "Big bills + extra");
  assert.equal(billDiscountRuleName(rule, 0, 15), null, "a slab that gave nothing is not named");
  assert.equal(billDiscountRuleName(null, 0, 15), null);
  assert.equal(billDiscountRuleName({ ...rule, rule_name: "" }, 20, 15), "Bills ₹1,000 and above + extra");
  assert.ok(billDiscountRuleName({ ...rule, rule_name: "x".repeat(200) }, 20, 15).length <= 140);
});

test("a 400 BILL_DISCOUNT_TOO_LARGE is read with the most the bill can take, and keeps the cart", () => {
  const answer = readBillDiscountTooLarge(400, { code: BILL_DISCOUNT_TOO_LARGE_CODE, max_manual_bill_discount: 479.996, message: "Bill discount cannot be more than the bill after its slab discount" });
  assert.equal(answer.maxManualBillDiscount, 480);
  assert.equal(answer.message, "Bill discount cannot be more than the bill after its slab discount. The most this bill can take off is ₹480. The bill is not saved yet; the cart is still here.");
  assert.match(readBillDiscountTooLarge("400", { code: "bill_discount_too_large" }).message, /cart is still here\.$/);
  assert.equal(readBillDiscountTooLarge(400, { message: "Enter a valid bill discount" }), null);
  assert.equal(readBillDiscountTooLarge(409, { code: BILL_DISCOUNT_TOO_LARGE_CODE }), null);
});

test("POS: the Bill discount box sits by the totals, is sent from browser and desktop, and is emptied with the bill", () => {
  assert.match(app, /<PosBillDiscountBox\n/);
  // The amount the bill records is slab + manual; the manual part travels on its own, 0 when empty.
  assert.match(app, /const invoiceDiscountAmount = roundDiscountMoney\(slabDiscountAmount \+ manualBillDiscount\);/);
  assert.equal([...app.matchAll(/manual_bill_discount: roundDiscountMoney\(totals\.manualBillDiscount\),/g)].length, 2);
  // The payload keeps the slab's own snapshot; only the just-billed invoice shows " + extra".
  assert.equal([...app.matchAll(/\.\.\.slabSnapshot\(totals\.discountRule\)/g)].length, 2);
  assert.match(app, /discount_rule_name: billDiscountRuleName\(totals\.discountRule, totals\.slabDiscount, totals\.manualBillDiscount\),/);
  // Separate lines: the slab by name, the cashier's part as "Extra discount"; an error is a dash.
  assert.match(app, /label=\{`Bill discount \(\$\{slabDisplayName\(totals\.discountRule\)\}\)`\}/);
  assert.match(app, /<TotalLine label="Extra discount" value=\{-totals\.manualBillDiscount\} \/>/);
  assert.match(app, /total-line-error"><span>Extra discount<\/span><strong>\{MISSING_VALUE\}<\/strong>/);
  // Emptied after each completed sale (desktop and browser) and whenever the cart empties.
  const checkoutBody = appSlice("const checkout = async (printAfterSave = false, confirmations = {}) => {", "const handleSearchKeys = ");
  assert.equal([...checkoutBody.matchAll(/clearBillDiscount\(\);/g)].length, 2);
  assert.match(app, /if \(cart\.length === 0\) setBillDiscountInput\(\{ mode: MANUAL_BILL_DISCOUNT_MODE\.AMOUNT, value: "" \}\);/);
  // An unbillable entry stops checkout before the approval question and before anything is saved.
  comesBefore(checkoutBody, "if (totals.manualBillError) {", "discountApprovalCheck.needed");
  comesBefore(checkoutBody, "if (totals.manualBillError) {", "setSaving(true)");
  // The approval covers the bill too, and is dropped when the cart or the box changes.
  assert.match(app, /posDiscountApproval\(cart, \{ exempt: discountExempt, manualBill: totals\.manualBillDiscount \}\)/);
  assert.match(checkoutBody, /openDiscountApproval\(\{ lines: discountApprovalCheck\.lines, bill: discountApprovalCheck\.bill,/);
  assert.match(app, /setDiscountApproval\(\(current\) => \(current && !current\.saving \? null : current\)\);\n {2}\}, \[cart, billDiscountInput\.mode, billDiscountInput\.value\]\);/);
  assert.match(checkoutBody, /readBillDiscountTooLarge\(error\.response\?\.status, responseData\)/);
  // The 5% hint for whoever can be asked, under the box as well as on the Item Discount column.
  const box = appSlice("function PosBillDiscountBox(", "\nfunction ");
  assert.match(box, /!exempt && <small className="form-note pos-discount-limit-note">\{DISCOUNT_APPROVAL_NOTE\}/);
  assert.match(box, /role="alert">\{error\}/);
});

test("Settings shows the value POS uses: no settings card keeps a copy of its settings", () => {
  // The cause of "Show Item Discount Column on POS" ticked while POS showed no column: each card
  // copied its settings into useState once and only re-read them when `updated_at` changed.
  assert.doesNotMatch(app, /useState\(\{ \.\.\.default(Business|Pos|Payment|Whatsapp|SaleRate|DeviceControl)Settings/);
  assert.doesNotMatch(app, /useState\(syncSettings \|\| \{\}\)/);
  for (const [card, source] of [
    ["BusinessSettingsSection", "businessSettings, defaultBusinessSettings"],
    ["PosSettingsSection", "posSettings, defaultPosSettings"],
    ["PaymentSettingsSection", "paymentSettings, defaultPaymentSettings"],
    ["WhatsAppSettingsSection", "whatsappSettings, defaultWhatsappSettings"],
    ["SaleRateSettingsSection", "saleRateSettings, defaultSaleRateSettings"],
    ["DeviceControlSettingsSection", "deviceControlSettings, defaultDeviceControlSettings"],
    ["SyncSettingsSection", "syncSettings"],
  ]) {
    const body = functionBody(card);
    assert.match(body, new RegExp(`useSettingsDraft\\(${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`), card);
    assert.doesNotMatch(body, /await onReload\(\);/, `${card} must drop its edits only after the reload`);
  }
  // The checkbox and POS read the same live value.
  assert.match(functionBody("BusinessSettingsSection"), /checked=\{draft\.show_item_discount_column_pos !== false\}/);
  assert.match(app, /\{printSettings\.show_item_discount_column_pos !== false && <th>Item Discount/);
  // A desktop counter picks up the switches after a sync, not only when Settings is opened on it.
  assert.match(app, /setSettingsData\(\(current\) => \(\{ \.\.\.current, businessSettings: \{ \.\.\.defaultBusinessSettings, \.\.\.businessBundle \} \}\)\);/);
});

test("the till and the server agree on the 5% rule over the whole bill", { skip: backend?.assessBillManualDiscount ? false : "backend/discounts.js has no assessBillManualDiscount" }, () => {
  const carts = [
    [],
    [line({ quantity: 10, selling_rate: 100 })],
    [line({ quantity: 10, selling_rate: 100, discount_amount: 30 })],
    [line({ quantity: 10, selling_rate: 100, discount_amount: 100, lot_discount_id: "004", lot_discount_type: "PERCENTAGE", lot_discount_value: 10 })],
    [line({ quantity: 2, selling_rate: 80, discount_amount: 8, lot_discount_id: "9", lot_discount_type: "SPECIAL_RATE", lot_discount_value: 80 })],
    [1, 2, 3].map((index) => line({ line_id: String(index), quantity: 1, selling_rate: 100, discount_amount: 5.01 })),
    [line({ quantity: 0.75, selling_rate: 33.33, discount_amount: 1.25 }), line({ line_id: "2", quantity: "1.125", selling_rate: 120, discount_amount: 0 })],
    [line({ quantity: "", selling_rate: 100 }), line({ line_id: "2", quantity: 3, selling_rate: 50 })],
    [line({ quantity: 10, selling_rate: 100, discount_amount: "abc" })],
  ];
  const lotFor = (entry) => (entry.lot_discount_type
    ? { id: entry.lot_discount_id, discount_type: entry.lot_discount_type, discount_value: entry.lot_discount_value }
    : null);
  let compared = 0;
  for (const cart of carts) {
    const serverLines = cart.map((entry) => ({ quantity: entry.quantity, rate: entry.selling_rate, discountAmount: entry.discount_amount, lotDiscount: lotFor(entry) }));
    for (const manualBill of [0, "", null, 0.01, 5, 20, 21, 45, 45.02, 50, 50.01, 50.02, 120, "abc", -1, "12.5"]) {
      const mine = assessBillManualDiscount({ lines: cart, manualBill });
      const theirs = backend.assessBillManualDiscount({ lines: serverLines, manualBill });
      const label = JSON.stringify({ cart: cart.map((entry) => [entry.quantity, entry.selling_rate, entry.discount_amount, entry.lot_discount_type]), manualBill });
      assert.equal(mine.needsApproval, theirs.bill.needsApproval, label);
      assert.equal(mine.unreadable, theirs.bill.unreadable, label);
      assert.equal(mine.manualBill, theirs.bill.manualBill, label);
      assert.equal(mine.base, theirs.bill.base, label);
      assert.equal(mine.freeLimit, theirs.bill.freeLimit, label);
      assert.equal(mine.manualTotal, theirs.bill.manualTotal, label);
      // The whole question POS asks before billing is the one the server asks of the bill.
      assert.equal(posDiscountApproval(cart, { manualBill }).needed, theirs.needsApproval, label);
      compared += 1;
    }
  }
  assert.ok(compared > 100);
});

test("the till and the server name the bill's rule and bound the box the same way", { skip: backend?.billDiscountRule ? false : "backend/discounts.js has no billDiscountRule" }, () => {
  assert.equal(backend.EXTRA_DISCOUNT_SUFFIX, MANUAL_BILL_DISCOUNT_RULE_SUFFIX);
  const rules = [
    { id: "1", rule_name: "Big bills", minimum_bill_amount: 1000, maximum_bill_amount: null, discount_type: "PERCENTAGE", discount_value: 2, payment_mode: "ALL", active: true },
    { id: "2", rule_name: "", minimum_bill_amount: 500, maximum_bill_amount: 999.99, discount_type: "FLAT_AMOUNT", discount_value: 25, payment_mode: "CASH", active: true },
    { id: "3", rule_name: "x".repeat(150), minimum_bill_amount: 5000, maximum_bill_amount: null, discount_type: "FLAT_AMOUNT", discount_value: 60, payment_mode: "ALL", active: true },
  ];
  for (const gross of [200, 600, 999, 1000, 1500.5, 6000]) {
    for (const itemDiscount of [0, 15.5]) {
      const subtotal = roundMoney(gross - itemDiscount);
      for (const mode of ["CASH", "UPI"]) {
        const { rule, amount: slab } = matchBillSlab(rules, { gross, subtotalAfterItems: subtotal, paymentMode: mode });
        for (const [typedMode, typed] of [[AMOUNT, ""], [AMOUNT, "10"], [PERCENT, "5"], [PERCENT, "100"], [AMOUNT, String(subtotal)], [AMOUNT, "99999"]]) {
          const where = JSON.stringify({ gross, itemDiscount, mode, typedMode, typed });
          const box = resolveManualBillDiscount({ mode: typedMode, value: typed, itemsSubtotal: subtotal, slabAmount: slab });
          const manual = box.error ? roundMoney(Number(typed)) : box.amount;
          const invoice = roundMoney(slab + manual);
          const theirs = backend.resolveInvoiceDiscount({ mode: "SLAB", requested: invoice, gross, subtotalAfterItems: subtotal, paymentMode: mode, rules, manualBill: manual });
          if (box.error) {
            // Refused at the till; the server refuses it too (too large, or more than the subtotal).
            assert.ok(theirs.error, where);
            if (theirs.error.code === "BILL_DISCOUNT_TOO_LARGE") assert.equal(theirs.error.max_manual_bill_discount, box.room, where);
            continue;
          }
          assert.equal(theirs.error, undefined, `${where} ${JSON.stringify(theirs.error)}`);
          assert.equal(theirs.amount, invoice, where);
          // A browser bill: the server's slab row (a blank name is named by its range).
          assert.equal(theirs.rule ? backend.describeSlab(theirs.rule) : null, billDiscountRuleName(rule, slab, manual), where);
          // A desktop bill: the slab snapshot it carries, kept as billed, " + extra" added there.
          const synced = backend.resolveInvoiceDiscount({ mode: "AS_BILLED", requested: invoice, gross, subtotalAfterItems: subtotal, paymentMode: mode, snapshot: backend.readDiscountRuleSnapshot(slabSnapshot(rule)), manualBill: manual });
          assert.equal(synced.amount, invoice, where);
          assert.equal(synced.rule?.rule_name ?? null, billDiscountRuleName(rule, slab, manual), where);
        }
      }
    }
  }
});
