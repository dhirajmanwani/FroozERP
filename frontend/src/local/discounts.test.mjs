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
