"use strict";

/**
 * Discounts: lot discounts, bill slabs, and how a sale takes them.
 *
 * Four halves. The rules in `discounts.js` are driven directly. `buildSalePayload` (desktop sync
 * and edits) is driven against a scripted client. The routes -- slab and lot-discount writes, and
 * browser checkout -- are driven through `routeAuthCoverage.loadServerApp()`: the real Express app,
 * a scripted database, no network, no `app.listen`. The Discount Report SQL runs in PGlite, an
 * in-process Postgres, because the double count it fixes is a join fact no regex can see.
 *
 * Every bug fixed on 30 Sep 2026 has a test here: a blank value saving a ₹0 special price, 150%,
 * "₹200 off" a ₹150 lot, overlapping slabs matched differently at counter and server, a desktop
 * bill rejected at sync because a slab changed, an edit re-discounted by today's slab, a SPECIAL_RATE
 * nobody checked, another shop's discounts writable by id, two running discounts on one lot, and a
 * report that left bill discounts out and counted two-lot lines twice.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rules = require("./discounts");
const {
  activeLotDiscount,
  billSlabAmount,
  boundBillDiscount,
  compareIds,
  dateKey,
  describeSlabRange,
  editDiscountRule,
  expectedLotDiscount,
  findSlabOverlap,
  lotDiscountStatus,
  matchBillSlab,
  readDiscountRuleSnapshot,
  resolveInvoiceDiscount,
  slabsOverlap,
  validateLotDiscountInput,
  validateSlabInput,
  verifyLotDiscountClaim,
} = rules;

const {
  loadServerApp,
  probe,
  setQueryResponder,
  clearQueryResponder,
  setConnectionResponder,
  clearConnectionResponder,
} = require("./routeAuthCoverage");
const { issueDeviceSession } = require("./deviceSession");

const app = loadServerApp();
const { buildSalePayload } = require("./server");
const SOURCE = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

// ---------------------------------------------------------------------------------------------
// Rules: bill slabs
// ---------------------------------------------------------------------------------------------

const slab = (overrides = {}) => ({
  id: 1,
  rule_name: "",
  minimum_bill_amount: "1000.00",
  maximum_bill_amount: null,
  discount_type: "FLAT_AMOUNT",
  discount_value: "50.00",
  payment_mode: "ALL",
  active: true,
  ...overrides,
});

test("a slab needs a value above 0 and a percentage of at most 100", () => {
  for (const value of ["", null, undefined, 0, "0", -5, "abc"]) {
    assert.ok(validateSlabInput({ minimum_bill_amount: 0, discount_type: "FLAT_AMOUNT", discount_value: value }).error, `should refuse ${JSON.stringify(value)}`);
  }
  assert.ok(validateSlabInput({ discount_type: "PERCENTAGE", discount_value: 100.01 }).error, "150% made every bill in range free");
  assert.equal(validateSlabInput({ discount_type: "PERCENTAGE", discount_value: 100 }).rule.discount_value, 100);
  assert.ok(validateSlabInput({ discount_type: "BOGUS", discount_value: 5 }).error);
  assert.ok(validateSlabInput({ discount_value: 5, payment_mode: "BITCOIN" }).error);
});

test("a slab's maximum is blank, 0 (both no upper limit) or above the minimum", () => {
  assert.equal(validateSlabInput({ minimum_bill_amount: 500, maximum_bill_amount: "", discount_value: 5 }).rule.maximum_bill_amount, null);
  assert.equal(validateSlabInput({ minimum_bill_amount: 500, maximum_bill_amount: 0, discount_value: 5 }).rule.maximum_bill_amount, null);
  assert.ok(validateSlabInput({ minimum_bill_amount: 500, maximum_bill_amount: 500, discount_value: 5 }).error);
  assert.ok(validateSlabInput({ minimum_bill_amount: 500, maximum_bill_amount: 400, discount_value: 5 }).error);
  assert.ok(validateSlabInput({ minimum_bill_amount: -1, discount_value: 5 }).error);
  assert.equal(validateSlabInput({ minimum_bill_amount: "", discount_value: 5 }).rule.minimum_bill_amount, 0, "a blank lowest amount is from ₹0");
});

test("a slab with no name is named by its range", () => {
  assert.equal(validateSlabInput({ minimum_bill_amount: 1000, maximum_bill_amount: 1999, discount_value: 5 }).rule.rule_name, "Bills ₹1,000 – ₹1,999");
  assert.equal(validateSlabInput({ minimum_bill_amount: 100000, discount_value: 5 }).rule.rule_name, "Bills ₹1,00,000 and above");
  assert.equal(validateSlabInput({ rule_name: "  Weekend  ", minimum_bill_amount: 1, discount_value: 5 }).rule.rule_name, "Weekend");
  assert.equal(describeSlabRange({ minimum_bill_amount: "999.50", maximum_bill_amount: null }), "Bills ₹999.50 and above");
});

test("a maximum of 0 is no upper limit, at the server as at the counter", () => {
  const rule = slab({ maximum_bill_amount: "0.00" });
  assert.equal(matchBillSlab([rule], 5000, "CASH"), rule, "the old SQL read max 0 as 'nothing matches'");
  assert.equal(matchBillSlab([slab({ maximum_bill_amount: "1999" })], 2000, "CASH"), null);
  assert.equal(matchBillSlab([slab({ maximum_bill_amount: "1999" })], 1999, "CASH")?.id, 1, "the maximum is inclusive");
  assert.equal(matchBillSlab([slab()], 999.99, "CASH"), null);
});

test("payment mode: ALL (or blank) meets every bill, otherwise the modes must match", () => {
  assert.ok(matchBillSlab([slab({ payment_mode: "" })], 1500, "UPI"));
  assert.ok(matchBillSlab([slab({ payment_mode: "upi" })], 1500, "UPI"), "case-insensitive");
  assert.equal(matchBillSlab([slab({ payment_mode: "CASH" })], 1500, "UPI"), null);
  assert.equal(matchBillSlab([slab({ payment_mode: "CASH" })], 1500, "MIXED"), null);
  assert.ok(matchBillSlab([slab()], 1500, "MIXED"));
});

test("slabs off, or a slab switched off, gives no bill discount", () => {
  assert.equal(matchBillSlab([slab()], 1500, "CASH", { enabled: false }), null);
  assert.equal(matchBillSlab([slab({ active: false })], 1500, "CASH"), null);
  assert.equal(rules.slabsEnabled({ bill_level_slab_discount_enabled: false }), false);
  assert.equal(rules.slabsEnabled({ bill_level_slab_discount_enabled: true }), true);
  assert.equal(rules.slabsEnabled(undefined), true, "no settings row is the old default: on");
});

test("several match: the largest amount wins, not the largest raw value across types", () => {
  const flat = slab({ id: 1, discount_type: "FLAT_AMOUNT", discount_value: "50" });
  const percent = slab({ id: 2, discount_type: "PERCENTAGE", discount_value: "5" });
  assert.equal(matchBillSlab([flat, percent], 5000, "CASH"), percent, "5% of ₹5,000 is ₹250, more than ₹50");
  assert.equal(matchBillSlab([flat, percent], 1000, "CASH"), percent, "5% of ₹1,000 is ₹50, a tie: the higher id (2) wins");
  const sixty = slab({ id: 1, discount_type: "FLAT_AMOUNT", discount_value: "60" });
  assert.equal(matchBillSlab([sixty, percent], 1000, "CASH"), sixty, "₹60 flat beats 5% of ₹1,000");
});

test("a tie goes to the highest id, compared without Number()", () => {
  const nine = slab({ id: "9", discount_type: "FLAT_AMOUNT", discount_value: "10" });
  const ten = slab({ id: "10", discount_type: "PERCENTAGE", discount_value: "1" });
  assert.equal(matchBillSlab([ten, nine], 1000, "CASH"), ten, "₹10 flat and 1% of ₹1,000 tie; id 10 beats id 9");
  assert.equal(matchBillSlab([nine, ten], 1000, "CASH"), ten, "order of the list does not matter");
  assert.equal(compareIds("9", "10"), -1);
  assert.equal(compareIds("004", "4") !== 0, true, "'004' and 4 are different ids");
  assert.equal(compareIds(12, "12"), 0);
});

test("the slab amount is rounded like roundCurrency and capped at the subtotal after item discounts", () => {
  const percent = slab({ discount_type: "PERCENTAGE", discount_value: "7.5", minimum_bill_amount: 0 });
  assert.equal(billSlabAmount(percent, 999, 999), 74.93, "999 x 7.5% = 74.925, half away from zero");
  assert.equal(billSlabAmount(slab({ discount_value: 500 }), 1200, 300), 300, "capped at what is left after item discounts");
  assert.equal(billSlabAmount(slab({ discount_value: 500 }), 1200, -5), 0, "never below 0");
  assert.equal(billSlabAmount(null, 1200, 1200), 0);
});

test("overlap: ranges that share a rupee, when the payment modes can meet", () => {
  const a = slab({ id: 1, minimum_bill_amount: 1000, maximum_bill_amount: 1999 });
  assert.equal(slabsOverlap(a, slab({ minimum_bill_amount: 1999, maximum_bill_amount: 3000 })), true, "touching at 1999 overlaps (both inclusive)");
  assert.equal(slabsOverlap(a, slab({ minimum_bill_amount: 2000, maximum_bill_amount: null })), false);
  assert.equal(slabsOverlap(a, slab({ minimum_bill_amount: 0, maximum_bill_amount: 0 })), true, "max 0 is no upper limit");
  assert.equal(slabsOverlap(slab({ payment_mode: "CASH" }), slab({ payment_mode: "UPI" })), false, "cash and UPI never meet on one bill");
  assert.equal(slabsOverlap(slab({ payment_mode: "CASH" }), slab({ payment_mode: "ALL" })), true, "ALL meets everything");
  assert.equal(findSlabOverlap(a, [a], { excludeId: 1 }), null, "a slab does not clash with itself on edit");
  assert.equal(findSlabOverlap(a, [slab({ id: 2, active: false })]), null, "a switched-off slab clashes with nothing");
  assert.equal(findSlabOverlap({ ...a, active: false }, [slab({ id: 2 })]), null, "saving a slab switched off is not a clash");
  assert.equal(rules.slabOverlapRefusal(slab({ id: 2, rule_name: "", minimum_bill_amount: 1000 })).message, "Overlaps 'Bills ₹1,000 and above'. Change the range.");
});

// ---------------------------------------------------------------------------------------------
// Rules: the bill discount a sale records
// ---------------------------------------------------------------------------------------------

const TEN_PERCENT = slab({ id: 3, rule_name: "Big bills", minimum_bill_amount: 100, discount_type: "PERCENTAGE", discount_value: 10 });

test("browser checkout: the client's slab amount must be the server's, or DISCOUNT_RULES_CHANGED", () => {
  const ok = resolveInvoiceDiscount({ mode: "SLAB", requested: 40, gross: 400, subtotalAfterItems: 400, paymentMode: "CASH", rules: [TEN_PERCENT] });
  assert.deepEqual(ok, { amount: 40, rule: TEN_PERCENT });
  const stale = resolveInvoiceDiscount({ mode: "SLAB", requested: 20, gross: 400, subtotalAfterItems: 400, paymentMode: "CASH", rules: [TEN_PERCENT] });
  assert.equal(stale.error.status, 409);
  assert.equal(stale.error.code, "DISCOUNT_RULES_CHANGED");
  assert.equal(stale.error.expected_invoice_discount, 40);
  assert.equal(stale.error.message, "Bill discount rules changed. POS has reloaded them - check the total and try again.");
  assert.ok(resolveInvoiceDiscount({ mode: "SLAB", requested: 40.01, gross: 400, subtotalAfterItems: 400, paymentMode: "CASH", rules: [TEN_PERCENT] }).amount === 40, "a paisa is tolerance");
});

test("browser checkout: a slab the POS claims that no longer matches is DISCOUNT_RULES_CHANGED with 0", () => {
  const snapshot = readDiscountRuleSnapshot({ discount_rule_id: 3, discount_rule_name: "Big bills" });
  const result = resolveInvoiceDiscount({ mode: "SLAB", requested: 40, gross: 400, subtotalAfterItems: 400, paymentMode: "CASH", rules: [], snapshot });
  assert.equal(result.error.code, "DISCOUNT_RULES_CHANGED");
  assert.equal(result.error.expected_invoice_discount, 0);
});

test("browser checkout: no slab and no claim leaves a manual bill discount as sent (no permission change)", () => {
  assert.deepEqual(resolveInvoiceDiscount({ mode: "SLAB", requested: 15, gross: 400, subtotalAfterItems: 400, paymentMode: "CASH", rules: [] }), { amount: 15, rule: null });
  assert.equal(resolveInvoiceDiscount({ mode: "SLAB", requested: 500, gross: 400, subtotalAfterItems: 400, rules: [] }).error.status, 400);
});

test("as billed: the amount billed, bounded by the subtotal, with the device's snapshot", () => {
  const snapshot = readDiscountRuleSnapshot({ discount_rule_id: "7", discount_rule_name: "Old slab", discount_rule_type: "FLAT_AMOUNT", discount_rule_value: "25", discount_rule_payment_mode: "ALL" });
  const result = resolveInvoiceDiscount({ mode: "AS_BILLED", requested: 25, gross: 400, subtotalAfterItems: 400, paymentMode: "CASH", rules: [TEN_PERCENT], snapshot });
  assert.equal(result.amount, 25, "today's 10% slab (₹40) does not re-price a bill already given to the customer");
  assert.deepEqual(result.rule, { id: "7", rule_name: "Old slab", discount_type: "FLAT_AMOUNT", discount_value: 25, payment_mode: "ALL" });
  assert.equal(resolveInvoiceDiscount({ mode: "AS_BILLED", requested: 0, subtotalAfterItems: 400, snapshot }).rule, null, "no discount, no rule");
  assert.equal(resolveInvoiceDiscount({ mode: "AS_BILLED", requested: 400.02, subtotalAfterItems: 400 }).error.status, 400);
  assert.equal(boundBillDiscount("400.004", 400).amount, 400, "a desktop's 3-dp rounding is not a refusal");
  assert.equal(boundBillDiscount(74.925, 999).amount, 74.93);
  assert.ok(boundBillDiscount(-1, 999).error);
});

test("a rule snapshot keeps only an id the server could have made", () => {
  assert.equal(readDiscountRuleSnapshot({ discount_rule_id: "004", discount_rule_name: "x" }).id, null, "'004' is not the server's 4");
  assert.equal(readDiscountRuleSnapshot({ discount_rule_id: "99999999999" , discount_rule_name: "x" }).id, null, "beyond INTEGER");
  assert.equal(readDiscountRuleSnapshot({ discount_rule_id: 12 }).id, "12");
  assert.equal(readDiscountRuleSnapshot({ discount_rule: { id: 5, rule_name: "Nested" } }).rule_name, "Nested");
  assert.equal(readDiscountRuleSnapshot({}), null);
  assert.equal(readDiscountRuleSnapshot({ discount_rule_type: "BOGUS", discount_rule_name: "n" }).discount_type, null);
});

test("an edit keeps the sale's rule only while its bill discount is unchanged", () => {
  const currentSale = { invoice_discount_amount: "40.00", discount_rule_id: 3, discount_rule_name: "Big bills", discount_rule_type: "PERCENTAGE", discount_rule_value: "10.00", discount_rule_payment_mode: "ALL" };
  assert.equal(editDiscountRule({ requestSnapshot: null, currentSale, invoiceDiscountAmount: 40 }).rule_name, "Big bills");
  assert.equal(editDiscountRule({ requestSnapshot: null, currentSale, invoiceDiscountAmount: 30 }), null, "the editor typed another discount; no slab gave it");
  assert.equal(editDiscountRule({ requestSnapshot: null, currentSale, invoiceDiscountAmount: 0 }), null);
  const named = readDiscountRuleSnapshot({ discount_rule_name: "Named" });
  assert.equal(editDiscountRule({ requestSnapshot: named, currentSale, invoiceDiscountAmount: 30 }), named);
});

// ---------------------------------------------------------------------------------------------
// Rules: lot discounts
// ---------------------------------------------------------------------------------------------

const lotInput = (overrides = {}) => ({ type: "FIXED_AMOUNT", value: 10, currentRate: 150, cost: 100, lotLabel: "Lot A", ...overrides });

test("a lot discount needs a value above 0 -- a blank special price is not ₹0", () => {
  for (const value of ["", null, undefined, 0, "0", -1, "abc"]) {
    for (const type of ["FIXED_AMOUNT", "PERCENTAGE", "SPECIAL_RATE"]) {
      assert.ok(validateLotDiscountInput(lotInput({ type, value })).error, `${type} ${JSON.stringify(value)}`);
    }
  }
  assert.ok(validateLotDiscountInput(lotInput({ type: "WHATEVER" })).error);
});

test("a percentage lot discount is at most 100", () => {
  assert.equal(validateLotDiscountInput(lotInput({ type: "PERCENTAGE", value: 100 })).value, 100);
  assert.ok(validateLotDiscountInput(lotInput({ type: "PERCENTAGE", value: 100.01 })).error);
});

test("₹ off and a fixed price must be below the price POS charges", () => {
  assert.match(validateLotDiscountInput(lotInput({ value: 150 })).error, /₹150 off is not below Lot A's price of ₹150/);
  assert.match(validateLotDiscountInput(lotInput({ value: 200 })).error, /give the fruit away/);
  assert.equal(validateLotDiscountInput(lotInput({ value: 149.99 })).value, 149.99);
  assert.match(validateLotDiscountInput(lotInput({ type: "SPECIAL_RATE", value: 150 })).error, /That is not a discount/);
  assert.match(validateLotDiscountInput(lotInput({ type: "SPECIAL_RATE", value: 175 })).error, /not a discount/, "a silent price increase");
  assert.equal(validateLotDiscountInput(lotInput({ type: "SPECIAL_RATE", value: 120 })).value, 120);
  assert.match(validateLotDiscountInput(lotInput({ currentRate: 0 })).error, /no selling rate/);
  assert.match(validateLotDiscountInput(lotInput({ type: "PERCENTAGE", currentRate: null })).error, /no selling rate/);
});

test("below cost is a warning, not a refusal", () => {
  const result = validateLotDiscountInput(lotInput({ type: "SPECIAL_RATE", value: 90, cost: 100 }));
  assert.equal(result.error, undefined);
  assert.equal(result.warning, "Below cost (₹100).");
  assert.equal(validateLotDiscountInput(lotInput({ type: "SPECIAL_RATE", value: 90, cost: null })).warning, null, "unknown cost is not ₹0 cost");
});

test("the end date cannot be before the start", () => {
  assert.ok(validateLotDiscountInput(lotInput({ startDate: "2026-10-05", endDate: "2026-10-04" })).error);
  assert.equal(validateLotDiscountInput(lotInput({ startDate: "2026-10-05", endDate: "2026-10-05" })).endDate, "2026-10-05");
  assert.ok(validateLotDiscountInput(lotInput({ startDate: "not a date" })).error);
});

test("per-unit discount: % rounded, ₹ off capped at the rate, fixed price is the price", () => {
  assert.deepEqual(expectedLotDiscount({ discount_type: "PERCENTAGE", discount_value: "7.5" }, 99.99, 3), { sellingRate: 99.99, perUnitDiscount: 7.5, lineDiscount: 22.5 });
  assert.deepEqual(expectedLotDiscount({ discount_type: "FIXED_AMOUNT", discount_value: 10 }, 150, 2.5), { sellingRate: 150, perUnitDiscount: 10, lineDiscount: 25 });
  assert.deepEqual(expectedLotDiscount({ discount_type: "SPECIAL_RATE", discount_value: 90 }, 150, 2), { sellingRate: 90, perUnitDiscount: 0, lineDiscount: 0 });
  assert.equal(expectedLotDiscount({ discount_type: "PERCENTAGE", discount_value: 0 }, 150, 1), null);
});

test("status by date: stopped, upcoming, ended, running (start and end inclusive)", () => {
  const today = "2026-09-30";
  assert.equal(lotDiscountStatus({ active: false, start_date: "2026-09-01" }, today), "STOPPED");
  assert.equal(lotDiscountStatus({ active: true, start_date: "2026-10-01" }, today), "UPCOMING");
  assert.equal(lotDiscountStatus({ active: true, start_date: "2026-09-01", end_date: "2026-09-29" }, today), "ENDED");
  assert.equal(lotDiscountStatus({ active: true, start_date: "2026-09-30", end_date: "2026-09-30" }, today), "RUNNING");
  assert.equal(lotDiscountStatus({ active: true, start_date: new Date(2026, 8, 30), end_date: null }, today), "RUNNING", "a pg DATE arrives as local midnight");
  assert.equal(dateKey(new Date(2026, 8, 30)), "2026-09-30");
});

test("the running discount on a lot: highest id, lots compared as opaque strings", () => {
  const discounts = [
    { id: 9, inventory_batch_id: "004", active: true, start_date: "2026-09-01" },
    { id: 10, inventory_batch_id: 4, active: true, start_date: "2026-09-01" },
    { id: 11, inventory_batch_id: 4, active: true, start_date: "2026-10-05" },
  ];
  assert.equal(activeLotDiscount(discounts, "4", "2026-09-30").id, 10, "'004' is another lot; 11 has not started");
  assert.equal(activeLotDiscount(discounts, "004", "2026-09-30").id, 9);
  assert.equal(activeLotDiscount(discounts, 5, "2026-09-30"), null);
});

const RUNNING_SPECIAL = { id: 55, product_id: 11, inventory_batch_id: 900, discount_type: "SPECIAL_RATE", discount_value: "80.00", start_date: "2026-01-01", end_date: null, active: true };

test("a line's lot-discount claim holds only for that lot's running discount, same id, type and value", () => {
  const base = { discounts: [RUNNING_SPECIAL], lotId: 900, productId: 11, day: "2026-09-30" };
  assert.equal(verifyLotDiscountClaim({ ...base, claim: { id: 55, type: "SPECIAL_RATE", value: 80 } }), RUNNING_SPECIAL);
  assert.equal(verifyLotDiscountClaim({ ...base, claim: { id: 55, type: "SPECIAL_RATE", value: 70 } }), null, "value changed");
  assert.equal(verifyLotDiscountClaim({ ...base, claim: { id: 55, type: "PERCENTAGE", value: 80 } }), null, "type changed");
  assert.equal(verifyLotDiscountClaim({ ...base, claim: { id: 56, type: "SPECIAL_RATE", value: 80 } }), null, "another discount");
  assert.equal(verifyLotDiscountClaim({ ...base, lotId: 901, claim: { id: 55, type: "SPECIAL_RATE", value: 80 } }), null, "another lot");
  assert.equal(verifyLotDiscountClaim({ ...base, productId: 12, claim: { id: 55, type: "SPECIAL_RATE", value: 80 } }), null, "another fruit");
  assert.equal(verifyLotDiscountClaim({ ...base, claim: { id: null, type: "SPECIAL_RATE", value: 80 } }), null, "no id, no claim");
  const stopped = { ...RUNNING_SPECIAL, active: false };
  assert.equal(verifyLotDiscountClaim({ ...base, discounts: [stopped], claim: { id: 55, type: "SPECIAL_RATE", value: 80 } }), null, "stopped");
  assert.equal(verifyLotDiscountClaim({ ...base, discounts: [{ ...RUNNING_SPECIAL, end_date: "2026-09-29" }], claim: { id: 55, type: "SPECIAL_RATE", value: 80 } }), null, "ended");
});

test("an edit keeps a special price the sale already carried, even if the discount stopped since", () => {
  const stopped = { ...RUNNING_SPECIAL, active: false };
  const priorClaims = [{ id: 7001, product_id: 11, lot_discount_id: 55, lot_discount_type: "SPECIAL_RATE", lot_discount_value: "80.00" }];
  const claim = { id: 55, type: "SPECIAL_RATE", value: 80 };
  assert.equal(verifyLotDiscountClaim({ discounts: [stopped], lotId: 900, productId: 11, day: "2026-09-30", claim, priorClaims }), stopped);
  const wrongPrior = [{ id: 55, product_id: 11, lot_discount_id: 99, lot_discount_type: "SPECIAL_RATE", lot_discount_value: "80.00" }];
  assert.equal(verifyLotDiscountClaim({ discounts: [stopped], lotId: 900, productId: 11, day: "2026-09-30", claim, priorClaims: wrongPrior }), null, "a sale item's own id is not its discount id");
});

// ---------------------------------------------------------------------------------------------
// buildSalePayload: desktop sync and edits, against a scripted client
// ---------------------------------------------------------------------------------------------

const PRODUCT_ID = 11;
const LOT_ID = 900;

const saleClient = ({ lotDiscounts = [], slabs = [TEN_PERCENT], slabsOn = true } = {}) => {
  const statements = [];
  return {
    statements,
    release: () => {},
    query: async (text, values) => {
      const sql = String(typeof text === "object" && text ? text.text : text || "").replace(/\s+/g, " ").trim();
      statements.push({ sql, values: values || [] });
      if (/FROM customers WHERE id = \$1/i.test(sql)) return { rows: [{ id: 5, customer_name: "Walk-in", system_account: true, active: true }] };
      if (/FROM products WHERE id = ANY/i.test(sql)) return { rows: [{ id: PRODUCT_ID, product_name: "Alphonso", selling_rate: "100.00", unit: "KG" }] };
      if (/FROM lot_discounts/i.test(sql)) return { rows: lotDiscounts };
      if (/^SELECT[\s\S]*FROM inventory_batches/i.test(sql)) {
        return { rows: [{ id: LOT_ID, remaining_qty: "50.000", purchase_rate: "60.00", purchase_bill_status: "BILL_COMPLETED", temporary_sale_rate: "0", lot_name: "LOT-1", lot_size: "10" }] };
      }
      if (/FROM sale_rate_settings/i.test(sql)) return { rows: [{ bill_level_slab_discount_enabled: slabsOn }] };
      if (/FROM sale_discount_rules/i.test(sql)) return { rows: slabs };
      return { rows: [], rowCount: 0 };
    },
  };
};

const lotDiscountRow = (overrides = {}) => ({
  id: 55, product_id: PRODUCT_ID, inventory_batch_id: LOT_ID, discount_type: "SPECIAL_RATE", discount_value: "80.00",
  start_date: "2026-01-01", end_date: null, active: true, ...overrides,
});

const recordedBill = (client, overrides = {}) => buildSalePayload(client, {
  items: [{ product_id: PRODUCT_ID, inventory_batch_id: LOT_ID, quantity: 4, discount_amount: 0 }],
  branchId: 2,
  createdBy: 7,
  customer: { account_id: 5 },
  invoiceDiscount: 0,
  payments: [{ mode: "CASH", amount: 400 }],
  allowRateOverride: false,
  invoiceDiscountMode: "AS_BILLED",
  billDate: "2026-09-30",
  ...overrides,
});

test("sync/edit: a bill discount is recorded as billed, and today's slabs are not even read", async () => {
  const client = saleClient();
  const snapshot = readDiscountRuleSnapshot({ discount_rule_id: 7, discount_rule_name: "Old slab", discount_rule_type: "FLAT_AMOUNT", discount_rule_value: 25, discount_rule_payment_mode: "ALL" });
  const result = await recordedBill(client, { invoiceDiscount: 25, discountRuleSnapshot: snapshot, payments: [{ mode: "CASH", amount: 375 }] });
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.equal(result.invoiceDiscountAmount, 25, "today's 10% slab would have made it 40 and refused the bill");
  assert.equal(result.discountRule.rule_name, "Old slab");
  assert.equal(result.totalAmount, 375);
  assert.equal(client.statements.filter(({ sql }) => /sale_discount_rules|sale_rate_settings/.test(sql)).length, 0);
});

test("sync/edit: a bill discount above the subtotal is still refused", async () => {
  const result = await recordedBill(saleClient(), { invoiceDiscount: 401, payments: [{ mode: "CASH", amount: 1 }] });
  assert.equal(result.error.status, 400);
  assert.match(result.error.message, /cannot exceed the cart subtotal/);
});

test("sync: a desktop's 3-dp bill discount lands at 2 dp and the payment still matches", async () => {
  const result = await recordedBill(saleClient(), { invoiceDiscount: "33.335", payments: [{ mode: "CASH", amount: 366.66 }] });
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.equal(result.invoiceDiscountAmount, 33.34);
});

test("the default mode is the server's slabs, never a client's number", async () => {
  const result = await recordedBill(saleClient(), { invoiceDiscountMode: undefined, invoiceDiscount: 40, payments: [{ mode: "CASH", amount: 360 }] });
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.equal(result.discountRule.id, 3);
});

const specialLine = { product_id: PRODUCT_ID, inventory_batch_id: LOT_ID, quantity: 4, discount_amount: 0, selling_rate: 80, lot_discount_id: 55, lot_discount_type: "SPECIAL_RATE", lot_discount_value: 80 };

test("edit by a non-Owner: a verified special price is not a rate override", async () => {
  const client = saleClient({ lotDiscounts: [lotDiscountRow()] });
  const result = await recordedBill(client, { items: [specialLine], payments: [{ mode: "CASH", amount: 320 }], allowRateOverride: false });
  assert.equal(result.error, undefined, "used to be 'You do not have permission to change sale rate'");
  assert.equal(result.invoiceItems[0].manualRateOverride, false);
  assert.equal(result.invoiceItems[0].defaultSellingRate, 100, "the lot's price stays the default, so the report sees the special-price difference");
  const [lookup] = client.statements.filter(({ sql }) => /FROM lot_discounts/.test(sql));
  assert.match(lookup.sql, /ib\.branch_id = \$2/);
  assert.deepEqual(lookup.values, [[LOT_ID], 2]);
});

test("sync: an offline special price is stored as a special price, not a cashier override", async () => {
  const result = await recordedBill(saleClient({ lotDiscounts: [lotDiscountRow()] }), { items: [specialLine], payments: [{ mode: "CASH", amount: 320 }], allowRateOverride: true });
  assert.equal(result.invoiceItems[0].manualRateOverride, false);
});

test("sync: an unverified special price is kept as billed, and recorded as an override", async () => {
  const result = await recordedBill(saleClient({ lotDiscounts: [lotDiscountRow({ active: false })] }), { items: [specialLine], payments: [{ mode: "CASH", amount: 320 }], allowRateOverride: true });
  assert.equal(result.error, undefined, "the sync path never refuses a bill the customer already has");
  assert.equal(result.invoiceItems[0].manualRateOverride, true);
  assert.equal(result.invoiceItems[0].sellingRate, 80);
});

test("edit by a non-Owner: an unverified special price still needs the override permission", async () => {
  const result = await recordedBill(saleClient({ lotDiscounts: [lotDiscountRow({ discount_value: "70.00" })] }), { items: [specialLine], payments: [{ mode: "CASH", amount: 320 }] });
  assert.equal(result.error.status, 403);
});

test("edit: a special price the sale already carried survives the discount being stopped", async () => {
  const priorLotDiscounts = [{ id: 7001, product_id: PRODUCT_ID, lot_discount_id: 55, lot_discount_type: "SPECIAL_RATE", lot_discount_value: "80.00" }];
  const result = await recordedBill(saleClient({ lotDiscounts: [lotDiscountRow({ active: false })] }), { items: [specialLine], payments: [{ mode: "CASH", amount: 320 }], priorLotDiscounts });
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.equal(result.invoiceItems[0].manualRateOverride, false);
});

// ---------------------------------------------------------------------------------------------
// Routes, against a scripted database
// ---------------------------------------------------------------------------------------------

const TEST_SIGNING_KEY = "route-auth-coverage-isolated-signing-key-000000";
const SESSION_BRANCH_ID = 2;
const OWNER_ID = 7;

const tokenFor = ({ deviceId = "FZDEV-DISCOUNTS", companyId = 1, branchId = SESSION_BRANCH_ID } = {}) => issueDeviceSession({
  userId: OWNER_ID, deviceId, companyId, branchId, role: "Owner", secret: TEST_SIGNING_KEY,
});

const normalise = (sql) => String(sql).replace(/\s+/g, " ").trim();
const MANAGER_SQL = /^SELECT u\.id, u\.full_name, r\.role_name FROM users u JOIN roles r/;
const rows = (list) => ({ rows: list, rowCount: list.length });
const find = (statements, pattern) => statements.filter(({ sql }) => pattern.test(sql));
const writes = (statements) => statements.filter(({ sql }) => /^(INSERT|UPDATE|DELETE)\b/i.test(sql));

const call = async (method, url, { body, role = "Owner", answer = () => undefined } = {}) => {
  const statements = [];
  const respond = (sql, values) => {
    const text = normalise(sql);
    statements.push({ sql: text, values: values || [] });
    if (MANAGER_SQL.test(text)) {
      return role ? rows([{ id: OWNER_ID, full_name: "Rig Owner", role_name: role }]) : rows([]);
    }
    if (/role_permission_settings/i.test(text)) {
      return rows([{ id: OWNER_ID, full_name: "Rig Owner", username: "rig", branch_id: SESSION_BRANCH_ID, role_name: role, permissions: {} }]);
    }
    const scripted = answer(text, values || []);
    return scripted === undefined ? { rows: [], rowCount: 0 } : scripted;
  };
  setQueryResponder(respond);
  setConnectionResponder(() => ({
    query: async (sql, values) => respond(typeof sql === "object" && sql ? sql.text : sql, values),
    release: () => {},
  }));
  try {
    const response = await probe(app, method, url, { authorization: `Bearer ${tokenFor()}`, "content-type": "application/json" }, body);
    return { response, statements };
  } finally {
    clearQueryResponder();
    clearConnectionResponder();
  }
};

// --- Slabs ------------------------------------------------------------------------------------

const slabStore = (existing = []) => (sql, values) => {
  if (/^SELECT \* FROM sale_discount_rules WHERE active = TRUE/.test(sql)) return rows(existing);
  if (/^SELECT id FROM sale_discount_rules WHERE id = \$1/.test(sql)) return rows(existing.filter((rule) => String(rule.id) === String(values[0])));
  if (/^(INSERT INTO|UPDATE) sale_discount_rules/.test(sql)) return rows([{ id: 99 }]);
  return undefined;
};

test("POST /settings/discount-rules: 150% is refused before anything is written", async () => {
  const { response, statements } = await call("POST", "/settings/discount-rules", {
    body: { rule_name: "Too much", minimum_bill_amount: 0, discount_type: "PERCENTAGE", discount_value: 150 },
    answer: slabStore(),
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, "SLAB_INVALID");
  assert.equal(writes(statements).length, 0);
});

test("POST /settings/discount-rules: an overlapping slab is refused with SLAB_OVERLAP and the clash's name", async () => {
  const { response, statements } = await call("POST", "/settings/discount-rules", {
    body: { minimum_bill_amount: 1500, maximum_bill_amount: 2500, discount_type: "FLAT_AMOUNT", discount_value: 20, payment_mode: "CASH" },
    answer: slabStore([slab({ id: 4, rule_name: "", minimum_bill_amount: "1000.00", maximum_bill_amount: "1999.00", payment_mode: "ALL" })]),
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "SLAB_OVERLAP");
  assert.equal(response.body.message, "Overlaps 'Bills ₹1,000 – ₹1,999'. Change the range.");
  assert.equal(writes(statements).length, 0);
  assert.equal(find(statements, /^ROLLBACK$/).length, 1);
});

test("POST /settings/discount-rules: a clean slab is saved under a table lock, named by its range", async () => {
  const { response, statements } = await call("POST", "/settings/discount-rules", {
    body: { minimum_bill_amount: 2000, maximum_bill_amount: "", discount_type: "PERCENTAGE", discount_value: "2", payment_mode: "UPI", updated_by: 999 },
    answer: slabStore([slab({ id: 4, minimum_bill_amount: "1000.00", maximum_bill_amount: "1999.00", payment_mode: "ALL" })]),
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(find(statements, /^LOCK TABLE sale_discount_rules/).length, 1);
  const [insert] = find(statements, /^INSERT INTO sale_discount_rules/);
  assert.deepEqual(insert.values, ["Bills ₹2,000 and above", 2000, null, "PERCENTAGE", 2, "UPI", true, OWNER_ID], "updated_by comes from the session");
  assert.equal(find(statements, /^COMMIT$/).length, 1);
});

test("PUT /settings/discount-rules/:id: a slab does not overlap itself", async () => {
  const own = slab({ id: 4, minimum_bill_amount: "1000.00", maximum_bill_amount: "1999.00" });
  const { response, statements } = await call("PUT", "/settings/discount-rules/4", {
    body: { rule_name: "Mid", minimum_bill_amount: 1000, maximum_bill_amount: 2499, discount_type: "FLAT_AMOUNT", discount_value: 30 },
    answer: slabStore([own]),
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const [update] = find(statements, /^UPDATE sale_discount_rules/);
  assert.equal(update.values[8], 4);
});

test("slab writes are refused to a role that does not manage rates", async () => {
  const { response, statements } = await call("POST", "/settings/discount-rules", {
    role: "Cashier",
    body: { minimum_bill_amount: 0, discount_value: 5 },
    answer: slabStore(),
  });
  assert.equal(response.status, 403);
  assert.equal(writes(statements).length, 0);
});

// --- Lot discounts ----------------------------------------------------------------------------

const LOT = { id: 11, product_id: 1, lot_name: "Lot A", batch_no: "B-11", temporary_sale_rate: "0.00", cost_rate: "100.00", product_name: "Rig Apple", product_selling_rate: "150.00" };

const lotStore = ({ lot = LOT, lotBranch = SESSION_BRANCH_ID, running = [], locked = null, lockedBranch = SESSION_BRANCH_ID } = {}) => (sql, values) => {
  if (/^SELECT ib\.id, ib\.product_id, ib\.lot_name/.test(sql)) {
    return rows(values[2] === lotBranch && values[0].includes(lot.id) ? [lot] : []);
  }
  if (/^INSERT INTO lot_discounts/.test(sql)) {
    return rows([{ id: 200, product_id: values[0], inventory_batch_id: values[1], discount_type: values[2], discount_value: values[3], start_date: values[4], end_date: values[5], active: values[6] }]);
  }
  if (/^SELECT \* FROM lot_discounts WHERE inventory_batch_id = \$1 AND id <> \$2/.test(sql)) return rows(running);
  if (/^SELECT ld\.\*, ib\.lot_name/.test(sql)) return rows(locked && values[1] === lockedBranch ? [locked] : []);
  if (/^UPDATE lot_discounts/.test(sql)) return rows([{ ...(locked || running[0] || {}), id: values[values.length - 1] ?? values[1], active: false, product_id: 1, inventory_batch_id: 11 }]);
  return undefined;
};

test("POST /lot-discounts: a blank value is refused before any lot is read", async () => {
  const { response, statements } = await call("POST", "/lot-discounts", {
    body: { product_id: 1, inventory_batch_ids: [11], discount_type: "SPECIAL_RATE", discount_value: "" },
    answer: lotStore(),
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, "LOT_DISCOUNT_INVALID");
  assert.equal(find(statements, /^BEGIN$/).length, 0);
});

test("POST /lot-discounts: lots are found only in the session's branch; another shop's lot is 404", async () => {
  const { response, statements } = await call("POST", "/lot-discounts", {
    body: { product_id: 1, inventory_batch_ids: [11], discount_type: "PERCENTAGE", discount_value: 10 },
    answer: lotStore({ lotBranch: 9 }),
  });
  assert.equal(response.status, 404);
  const [select] = find(statements, /^SELECT ib\.id, ib\.product_id, ib\.lot_name/);
  assert.match(select.sql, /ib\.branch_id = \$3/);
  assert.deepEqual(select.values, [[11], 1, SESSION_BRANCH_ID]);
  assert.equal(writes(statements).length, 0);
});

test("POST /lot-discounts: ₹ off at or above the lot's price is refused, with the lot named", async () => {
  const { response, statements } = await call("POST", "/lot-discounts", {
    body: { product_id: 1, inventory_batch_ids: [11], discount_type: "FIXED_AMOUNT", discount_value: 150 },
    answer: lotStore(),
  });
  assert.equal(response.status, 400);
  assert.match(response.body.message, /Lot A's price of ₹150/, "a lot at the product rate is priced at the product rate, not 0");
  assert.equal(writes(statements).length, 0);
  assert.equal(find(statements, /^ROLLBACK$/).length, 1);
});

test("POST /lot-discounts: a new discount replaces the lot's running one, in the same transaction, audited REPLACE", async () => {
  const old = { id: 150, product_id: 1, inventory_batch_id: 11, discount_type: "FIXED_AMOUNT", discount_value: "5.00", start_date: "2026-09-01", end_date: null, active: true };
  const { response, statements } = await call("POST", "/lot-discounts", {
    body: { product_id: 1, inventory_batch_ids: [11], discount_type: "SPECIAL_RATE", discount_value: "120", created_by: 999 },
    answer: lotStore({ running: [old] }),
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.ok(Array.isArray(response.body), "still one row per discount made");
  assert.deepEqual(response.body[0].replaced_discount_ids, [150]);
  const [insert] = find(statements, /^INSERT INTO lot_discounts/);
  assert.deepEqual(insert.values.slice(0, 4), [1, 11, "SPECIAL_RATE", 120]);
  assert.equal(insert.values[8], OWNER_ID, "created_by comes from the session");
  const [stop] = find(statements, /^UPDATE lot_discounts SET active = FALSE/);
  assert.deepEqual(stop.values, [OWNER_ID, 150]);
  const audits = find(statements, /^INSERT INTO lot_discount_audit/).map(({ values }) => values[3]);
  assert.deepEqual(audits, ["CREATE", "REPLACE"]);
  const order = statements.map(({ sql }) => sql);
  assert.ok(order.indexOf("COMMIT") > order.findIndex((sql) => /^UPDATE lot_discounts/.test(sql)), "the replace commits with the new discount");
});

test("POST /lot-discounts: below cost saves, with a warning", async () => {
  const { response } = await call("POST", "/lot-discounts", {
    body: { product_id: 1, inventory_batch_ids: [11], discount_type: "SPECIAL_RATE", discount_value: 90 },
    answer: lotStore(),
  });
  assert.equal(response.status, 201);
  assert.equal(response.body[0].warning, "Below cost (₹100).");
});

const LOCKED = { id: 150, product_id: 1, inventory_batch_id: 11, discount_type: "FIXED_AMOUNT", discount_value: "5.00", start_date: "2026-09-01", end_date: null, active: true, lot_name: "Lot A", batch_no: "B-11", temporary_sale_rate: "0.00", cost_rate: "100.00", product_selling_rate: "150.00" };

test("PUT /lot-discounts/:id: another shop's discount is 404 and untouched", async () => {
  const { response, statements } = await call("PUT", "/lot-discounts/150", {
    body: { discount_type: "FIXED_AMOUNT", discount_value: 8 },
    answer: lotStore({ locked: LOCKED, lockedBranch: 9 }),
  });
  assert.equal(response.status, 404);
  const [lock] = find(statements, /^SELECT ld\.\*, ib\.lot_name/);
  assert.match(lock.sql, /ib\.branch_id = \$2/);
  assert.deepEqual(lock.values, [150, SESSION_BRANCH_ID]);
  assert.equal(writes(statements).length, 0);
});

test("PUT /lot-discounts/:id: validates against the lot's price like a new discount", async () => {
  const { response, statements } = await call("PUT", "/lot-discounts/150", {
    body: { discount_type: "PERCENTAGE", discount_value: 101 },
    answer: lotStore({ locked: LOCKED }),
  });
  assert.equal(response.status, 400);
  assert.equal(writes(statements).length, 0);
  const good = await call("PUT", "/lot-discounts/150", {
    body: { discount_type: "FIXED_AMOUNT", discount_value: 8 },
    answer: lotStore({ locked: LOCKED }),
  });
  assert.equal(good.response.status, 200, JSON.stringify(good.response.body));
  const [audit] = find(good.statements, /^INSERT INTO lot_discount_audit/);
  assert.equal(audit.values[3], "UPDATE");
  assert.equal(audit.values[4].lot_name, undefined, "the audit's old value is the discount row, not the joined lot");
});

test("POST /lot-discounts/:id/deactivate: another shop's discount is 404 and untouched", async () => {
  const { response, statements } = await call("POST", "/lot-discounts/150/deactivate", {
    body: { remarks: "stop" },
    answer: lotStore({ locked: LOCKED, lockedBranch: 9 }),
  });
  assert.equal(response.status, 404);
  assert.equal(writes(statements).length, 0);
  const own = await call("POST", "/lot-discounts/150/deactivate", { body: {}, answer: lotStore({ locked: LOCKED }) });
  assert.equal(own.response.status, 200);
  assert.equal(find(own.statements, /^INSERT INTO lot_discount_audit/)[0].values[3], "DEACTIVATE");
});

test("lot-discount writes are refused to a role that does not manage rates", async () => {
  const { response, statements } = await call("POST", "/lot-discounts", {
    role: "Cashier",
    body: { product_id: 1, inventory_batch_ids: [11], discount_type: "PERCENTAGE", discount_value: 10 },
    answer: lotStore(),
  });
  assert.equal(response.status, 403);
  assert.equal(writes(statements).length, 0);
});

// --- Browser checkout (/api/v3/sales) ---------------------------------------------------------

const SALE_BRANCH_ID = 1;

const scopeResponder = (sql) => {
  if (/FROM authorized_devices d/i.test(sql)) {
    return rows([{
      device_id: "FZDEV-DISCOUNT-SALE", device_status: "APPROVED", company_id: 1, branch_id: SALE_BRANCH_ID,
      operational_location_id: 10, assignment_generation: 1, fixed_operational: true, intended_usage: "POS",
      device_permissions: {}, device_assignment_active: true, location_active: true, branch_active: true,
      role_id: 1, is_default: true, staff_permissions: {}, staff_assignment_active: true, role_name: "Owner",
    }]);
  }
  if (/SELECT session_revocation_version FROM users WHERE id = \$1 AND active IS DISTINCT FROM FALSE/i.test(sql)) {
    return rows([{ session_revocation_version: 0 }]);
  }
  return undefined;
};

let billNumber = 0;

const checkout = async (body, clientOptions = {}, answer = () => undefined) => {
  const client = saleClient({ slabs: [], slabsOn: false, ...clientOptions });
  billNumber += 1;
  const wrapped = {
    ...client,
    query: async (text, values) => {
      const sql = String(typeof text === "object" && text ? text.text : text || "").replace(/\s+/g, " ").trim();
      const scripted = answer(sql, values || []);
      if (scripted !== undefined) {
        client.statements.push({ sql, values: values || [] });
        return scripted;
      }
      if (/^INSERT INTO sales/i.test(sql)) {
        client.statements.push({ sql, values: values || [] });
        return rows([{ id: 4242, sale_date: new Date(), global_id: "sale-test", entity_version: 1 }]);
      }
      if (/^INSERT INTO sale_items/i.test(sql)) {
        client.statements.push({ sql, values: values || [] });
        return rows([{ id: 77 }]);
      }
      return client.query(text, values);
    },
  };
  setConnectionResponder(() => wrapped);
  setQueryResponder(scopeResponder);
  try {
    const response = await probe(app, "POST", "/api/v3/sales", {
      authorization: `Bearer ${tokenFor({ deviceId: "FZDEV-DISCOUNT-SALE", branchId: SALE_BRANCH_ID })}`,
      "content-type": "application/json",
    }, { customer: { account_id: 5 }, invoice_discount: 0, idempotency_key: `discount-test-${billNumber}`, ...body });
    return { response, statements: client.statements };
  } finally {
    clearConnectionResponder();
    clearQueryResponder();
  }
};

const columnsOf = (statement) => {
  const columns = statement.sql.slice(statement.sql.indexOf("(") + 1, statement.sql.indexOf(") VALUES")).split(",").map((name) => name.trim());
  return Object.fromEntries(columns.map((name, index) => [name, statement.values[index]]));
};

test("checkout: a verified special price bills at that price and is not an override", async () => {
  const { response, statements } = await checkout(
    { items: [specialLine], payments: [{ mode: "CASH", amount: 320 }] },
    { lotDiscounts: [lotDiscountRow()] },
  );
  assert.equal(response.status, 201, response.text);
  const item = columnsOf(find(statements, /^INSERT INTO sale_items/)[0]);
  assert.equal(item.manual_rate_override, false);
  assert.equal(Number(item.selling_rate), 80);
  assert.equal(find(statements, /pos_rate_override_audit/).length, 0);
  const [lookup] = find(statements, /FROM lot_discounts/);
  assert.deepEqual(lookup.values, [[LOT_ID], SALE_BRANCH_ID], "checked through the lot's branch");
});

test("checkout: a stopped or changed lot discount is DISCOUNT_CHANGED, and nothing is written", async () => {
  for (const [label, discounts] of [
    ["stopped", [lotDiscountRow({ active: false })]],
    ["value changed", [lotDiscountRow({ discount_value: "85.00" })]],
    ["gone", []],
    ["not started", [lotDiscountRow({ start_date: "2999-01-01" })]],
  ]) {
    const { response, statements } = await checkout({ items: [specialLine], payments: [{ mode: "CASH", amount: 320 }] }, { lotDiscounts: discounts });
    assert.equal(response.status, 409, label);
    assert.equal(response.body.code, "DISCOUNT_CHANGED", label);
    assert.equal(response.body.message, "A discount on Alphonso has changed. POS has reloaded discounts - check the bill and try again.");
    assert.equal(find(statements, /^INSERT INTO sales/).length, 0, label);
  }
});

test("checkout: a percentage lot discount is checked the same way", async () => {
  const line = { product_id: PRODUCT_ID, inventory_batch_id: LOT_ID, quantity: 4, discount_amount: 40, lot_discount_id: 56, lot_discount_type: "PERCENTAGE", lot_discount_value: 10 };
  const ok = await checkout({ items: [line], payments: [{ mode: "CASH", amount: 360 }] }, { lotDiscounts: [lotDiscountRow({ id: 56, discount_type: "PERCENTAGE", discount_value: "10.00" })] });
  assert.equal(ok.response.status, 201, ok.response.text);
  const stale = await checkout({ items: [line], payments: [{ mode: "CASH", amount: 360 }] }, { lotDiscounts: [lotDiscountRow({ id: 56, discount_type: "PERCENTAGE", discount_value: "10.00", end_date: "2020-01-01" })] });
  assert.equal(stale.response.body.code, "DISCOUNT_CHANGED");
});

test("checkout: a line with no lot discount claim is not looked up", async () => {
  const { response, statements } = await checkout({ items: [{ product_id: PRODUCT_ID, inventory_batch_id: LOT_ID, quantity: 4, discount_amount: 0 }], payments: [{ mode: "CASH", amount: 400 }] });
  assert.equal(response.status, 201, response.text);
  assert.equal(find(statements, /FROM lot_discounts/).length, 0);
});

test("checkout: a POS with older slabs gets DISCOUNT_RULES_CHANGED with the amount the server expects", async () => {
  const line = { product_id: PRODUCT_ID, inventory_batch_id: LOT_ID, quantity: 4, discount_amount: 0 };
  const stale = await checkout({ items: [line], invoice_discount: 0, payments: [{ mode: "CASH", amount: 400 }] }, { slabs: [TEN_PERCENT], slabsOn: true });
  assert.equal(stale.response.status, 409);
  assert.deepEqual(stale.response.body, {
    code: "DISCOUNT_RULES_CHANGED",
    expected_invoice_discount: 40,
    message: "Bill discount rules changed. POS has reloaded them - check the total and try again.",
  });
  assert.equal(find(stale.statements, /^INSERT INTO sales/).length, 0);

  const current = await checkout({ items: [line], invoice_discount: 40, discount_rule_id: 3, payments: [{ mode: "CASH", amount: 360 }] }, { slabs: [TEN_PERCENT], slabsOn: true });
  assert.equal(current.response.status, 201, current.response.text);
  const sale = columnsOf(find(current.statements, /^INSERT INTO sales/)[0]);
  assert.equal(Number(sale.invoice_discount_amount), 40);
  assert.equal(sale.discount_rule_id, 3);
  assert.equal(sale.discount_rule_name, "Big bills");
});

// ---------------------------------------------------------------------------------------------
// A cashier's own item discount over 5% needs Owner/Admin approval (owner's rule, 30 Sep 2026)
// ---------------------------------------------------------------------------------------------

const {
  assessManualDiscounts,
  lotDiscountOfRecord,
  manualDiscountExempt,
  manualDiscountLine,
  MANUAL_DISCOUNT_FREE_PERCENT,
} = rules;
const { hashPasswordSync } = require("./passwordHash");

test("rule: 5.00% of a line is free, anything past a paisa over it needs approval", () => {
  assert.equal(MANUAL_DISCOUNT_FREE_PERCENT, 5);
  // ₹1,000 line: 5% is ₹50.
  assert.equal(manualDiscountLine({ quantity: 10, rate: 100, discountAmount: 50 }).needsApproval, false, "5.00% is free");
  assert.equal(manualDiscountLine({ quantity: 10, rate: 100, discountAmount: 50.01 }).needsApproval, false, "a paisa of rounding is not a discount");
  assert.equal(manualDiscountLine({ quantity: 10, rate: 100, discountAmount: 50.1 }).needsApproval, true, "5.01% needs approval");
  assert.equal(manualDiscountLine({ quantity: 10, rate: 100, discountAmount: 50.02 }).needsApproval, true);
  assert.deepEqual(manualDiscountLine({ quantity: 10, rate: 100, discountAmount: 50.1 }), {
    lotPart: 0, manualPart: 50.1, base: 1000, freeLimit: 50, needsApproval: true, unreadable: false,
  });
  // A 3-decimal quantity: 1.25 kg x ₹99.99 = ₹124.99 (2 dp); 5% = ₹6.25.
  assert.equal(manualDiscountLine({ quantity: 1.25, rate: 99.99, discountAmount: 6.26 }).needsApproval, false);
  assert.equal(manualDiscountLine({ quantity: 1.25, rate: 99.99, discountAmount: 6.27 }).needsApproval, true);
  assert.equal(manualDiscountLine({ quantity: 4, rate: 100, discountAmount: 0 }).needsApproval, false);
  assert.equal(manualDiscountLine({ quantity: 4, rate: 100, discountAmount: "" }).needsApproval, false, "a blank discount is no discount");
});

test("rule: a line that cannot be read is not waved through as no discount", () => {
  const line = manualDiscountLine({ quantity: "abc", rate: 100, discountAmount: 10 });
  assert.equal(line.unreadable, true);
  assert.equal(line.needsApproval, true);
  assert.equal(manualDiscountLine({ quantity: null, rate: 100, discountAmount: 0 }).needsApproval, false, "nothing taken off, nothing to approve");
});

test("rule: the lot's own discount is not the cashier's, and is not counted as manual", () => {
  const tenPercent = { discount_type: "PERCENTAGE", discount_value: "10.00" };
  // ₹400 line, lot gives ₹40; base ₹360, 5% = ₹18.
  assert.deepEqual(manualDiscountLine({ quantity: 4, rate: 100, discountAmount: 40, lotDiscount: tenPercent }), {
    lotPart: 40, manualPart: 0, base: 360, freeLimit: 18, needsApproval: false, unreadable: false,
  });
  assert.equal(manualDiscountLine({ quantity: 4, rate: 100, discountAmount: 58, lotDiscount: tenPercent }).needsApproval, false, "₹18 on top is 5% of what is left");
  assert.equal(manualDiscountLine({ quantity: 4, rate: 100, discountAmount: 58.02, lotDiscount: tenPercent }).needsApproval, true);
  const rupeesOff = { discount_type: "FIXED_AMOUNT", discount_value: "10.00" };
  assert.equal(manualDiscountLine({ quantity: 4, rate: 100, discountAmount: 58, lotDiscount: rupeesOff }).manualPart, 18);
  // Without the lot discount, the same ₹40 would be 10% of the line.
  assert.equal(manualDiscountLine({ quantity: 4, rate: 100, discountAmount: 40 }).needsApproval, true);
});

test("rule: a special-price line is measured at the special price, with no lot part", () => {
  const special = { discount_type: "SPECIAL_RATE", discount_value: "80.00" };
  // 4 x ₹80 = ₹320; 5% = ₹16.
  assert.deepEqual(manualDiscountLine({ quantity: 4, rate: 80, discountAmount: 16, lotDiscount: special }), {
    lotPart: 0, manualPart: 16, base: 320, freeLimit: 16, needsApproval: false, unreadable: false,
  });
  assert.equal(manualDiscountLine({ quantity: 4, rate: 80, discountAmount: 16.02, lotDiscount: special }).needsApproval, true, "not 5% of the ₹400 list price");
});

test("rule: the bill needs approval when any one line does; lines do not share headroom", () => {
  const bill = assessManualDiscounts([
    { quantity: 10, rate: 100, discountAmount: 0 },
    { quantity: 1, rate: 100, discountAmount: 6 },
  ]);
  assert.equal(bill.needsApproval, true, "₹6 off a ₹100 line is 6%, however big the bill");
  assert.equal(bill.manualDiscountTotal, 6);
  assert.equal(assessManualDiscounts([]).needsApproval, false);
});

test("rule: Owner, Admin and a holder of manual_pos_rate_override are exempt; nobody else", () => {
  assert.equal(manualDiscountExempt({ role_name: "Owner", permissions: {} }), true);
  assert.equal(manualDiscountExempt({ role_name: "Admin", permissions: { manual_pos_rate_override: false } }), true, "Admin is exempt by role");
  assert.equal(manualDiscountExempt({ role_name: "Cashier", permissions: { manual_pos_rate_override: true } }), true);
  assert.equal(manualDiscountExempt({ role_name: "Cashier", permissions: { manual_pos_rate_override: "true" } }), false, "only a stored true grants");
  assert.equal(manualDiscountExempt({ role_name: "Cashier", permissions: {} }), false);
  assert.equal(manualDiscountExempt({ role_name: "Cashier", permissions: null }), false);
  assert.equal(manualDiscountExempt(null), false, "an unknown or inactive user is not exempt");
});

test("rule: a synced line's lot discount counts when the lot has or had it, not on the line's word", () => {
  const row = { id: 56, product_id: PRODUCT_ID, inventory_batch_id: LOT_ID, discount_type: "PERCENTAGE", discount_value: "10.00", active: false };
  const claim = { id: 56, type: "PERCENTAGE", value: 10 };
  assert.equal(lotDiscountOfRecord({ claim, discounts: [row], lotId: LOT_ID, productId: PRODUCT_ID }), row, "stopped since billing still counts");
  assert.equal(lotDiscountOfRecord({ claim: { ...claim, value: 20 }, discounts: [row], lotId: LOT_ID, productId: PRODUCT_ID }), null);
  assert.equal(lotDiscountOfRecord({ claim, discounts: [row], lotId: 901, productId: PRODUCT_ID }), null);
  assert.equal(lotDiscountOfRecord({ claim: { ...claim, id: "056" }, discounts: [row], lotId: LOT_ID, productId: PRODUCT_ID }), null, "'056' is not discount 56");
  assert.equal(lotDiscountOfRecord({ claim, discounts: [], lotId: LOT_ID, productId: PRODUCT_ID }), null);
});

// --- Browser checkout ------------------------------------------------------------------------

const REQUESTER_ID = OWNER_ID; // the session's user in `checkout`
const SALE_DEVICE = "FZDEV-DISCOUNT-SALE";
const NOW_PLUS_HOUR = () => new Date(Date.now() + 60 * 60 * 1000);
const ACTOR_SQL = /^SELECT u\.id, u\.full_name, r\.role_name, COALESCE\(rps\.permissions/;
const APPROVAL_SQL = /FROM sale_change_approvals a/;

const discountApproval = (overrides = {}) => ({
  id: "3f1c9a52-0000-4000-8000-00000000d15c",
  status: "ISSUED",
  action: "discount",
  sale_ref: "bill-op-1",
  requester_id: REQUESTER_ID,
  approver_id: 1,
  approver_role: "Owner",
  approver_active: true,
  company_id: 1,
  branch_id: SALE_BRANCH_ID,
  device_id: SALE_DEVICE,
  reason: "Item discount over 5%",
  expires_at: NOW_PLUS_HOUR(),
  ...overrides,
});

const discountStore = ({ role = "Cashier", permissions = {}, approval = null } = {}) => (sql, values) => {
  if (ACTOR_SQL.test(sql)) return rows(role ? [{ id: REQUESTER_ID, full_name: "Counter", role_name: role, permissions }] : []);
  if (APPROVAL_SQL.test(sql)) return rows(approval && values[0] === approval.id ? [approval] : []);
  if (/^UPDATE sale_change_approvals/.test(sql)) return rows([]);
  if (/^INSERT INTO sale_audit_trail/.test(sql)) return rows([]);
  return undefined;
};

// 10 kg at ₹100 = ₹1,000; 5% = ₹50.
const plainLine = (discount) => ({ product_id: PRODUCT_ID, inventory_batch_id: LOT_ID, quantity: 10, discount_amount: discount });
const paid = (amount) => [{ mode: "CASH", amount }];

test("checkout: a cashier's 5.00% discount bills without asking anyone", async () => {
  const { response, statements } = await checkout({ items: [plainLine(50)], payments: paid(950) }, {}, discountStore());
  assert.equal(response.status, 201, response.text);
  assert.equal(find(statements, ACTOR_SQL).length, 0, "no line over 5%, nobody is looked up");
  assert.equal(find(statements, /sale_change_approvals|sale_audit_trail/).length, 0);
});

test("checkout: a cashier's 5.01% discount without approval is 403 DISCOUNT_APPROVAL_REQUIRED, nothing kept", async () => {
  const { response, statements } = await checkout({ items: [plainLine(50.1)], payments: paid(949.9) }, {}, discountStore());
  assert.equal(response.status, 403);
  assert.deepEqual(response.body, {
    code: "DISCOUNT_APPROVAL_REQUIRED",
    detail: "APPROVAL_MISSING",
    message: "A discount over 5% needs an Owner or Admin to approve it.",
  });
  assert.equal(find(statements, /^INSERT INTO sales/).length, 0);
  assert.equal(find(statements, /^ROLLBACK$/).length, 1);
  const [actor] = find(statements, ACTOR_SQL);
  assert.deepEqual(actor.values, [REQUESTER_ID], "the actor is the session's user, read from the database");
});

test("checkout: a lot discount is not the cashier's; only what is on top of it is measured", async () => {
  const line = { product_id: PRODUCT_ID, inventory_batch_id: LOT_ID, quantity: 10, discount_amount: 145, lot_discount_id: 56, lot_discount_type: "PERCENTAGE", lot_discount_value: 10 };
  const lots = { lotDiscounts: [lotDiscountRow({ id: 56, discount_type: "PERCENTAGE", discount_value: "10.00" })] };
  // Lot ₹100 off ₹1,000; ₹45 on top is 5% of ₹900.
  const ok = await checkout({ items: [line], payments: paid(855) }, lots, discountStore());
  assert.equal(ok.response.status, 201, ok.response.text);
  const over = await checkout({ items: [{ ...line, discount_amount: 145.1 }], payments: paid(854.9) }, lots, discountStore());
  assert.equal(over.response.body.code, "DISCOUNT_APPROVAL_REQUIRED");
});

test("checkout: a special-price line is measured at the special price", async () => {
  const lots = { lotDiscounts: [lotDiscountRow()] };
  // 4 x ₹80 = ₹320; 5% = ₹16.
  const ok = await checkout({ items: [{ ...specialLine, discount_amount: 16 }], payments: paid(304) }, lots, discountStore());
  assert.equal(ok.response.status, 201, ok.response.text);
  const over = await checkout({ items: [{ ...specialLine, discount_amount: 17 }], payments: paid(303) }, lots, discountStore());
  assert.equal(over.response.status, 403, "₹17 is under 5% of the ₹400 list price, but over 5% of what is charged");
});

test("checkout: Owner, Admin and a holder of manual_pos_rate_override need no approval", async () => {
  for (const actor of [
    { role: "Owner" },
    { role: "Admin", permissions: { manual_pos_rate_override: false } },
    { role: "Cashier", permissions: { manual_pos_rate_override: true } },
  ]) {
    const { response, statements } = await checkout({ items: [plainLine(200)], payments: paid(800) }, {}, discountStore(actor));
    assert.equal(response.status, 201, `${actor.role}: ${response.text}`);
    assert.equal(find(statements, /sale_change_approvals|sale_audit_trail/).length, 0, actor.role);
  }
});

test("checkout: a valid approval is spent on this bill and its approver is on the audit trail", async () => {
  const approval = discountApproval();
  const { response, statements } = await checkout({
    idempotency_key: "bill-op-1",
    discount_approval_id: approval.id,
    items: [plainLine(200)],
    payments: paid(800),
  }, {}, discountStore({ approval }));
  assert.equal(response.status, 201, response.text);
  const [lock] = find(statements, APPROVAL_SQL);
  assert.match(lock.sql, /FOR UPDATE OF a/);
  const [consume] = find(statements, /^UPDATE sale_change_approvals SET status = 'CONSUMED'/);
  assert.deepEqual(consume.values, [approval.id, 4242]);
  assert.match(consume.sql, /WHERE id = \$1 AND status = 'ISSUED'/);
  const [audit] = find(statements, /^INSERT INTO sale_audit_trail/);
  assert.match(audit.sql, /'DISCOUNT_APPROVED'/);
  assert.equal(audit.values[0], 4242);
  assert.equal(audit.values[3], REQUESTER_ID, "edited_by is the cashier");
  assert.equal(audit.values[4], 1, "approved_by is the approver");
  const trace = JSON.parse(audit.values[1]);
  assert.equal(trace.approval_id, approval.id);
  assert.deepEqual(trace.lines.map((line) => [line.manual_part, line.free_limit]), [[200, 50]]);
  const order = statements.map(({ sql }) => sql);
  assert.ok(order.findIndex((sql) => /^INSERT INTO sales/.test(sql)) < order.findIndex((sql) => /^UPDATE sale_change_approvals/.test(sql)));
});

test("checkout: an approval for another cashier, counter, bill or action is refused by name", async () => {
  const cases = [
    [{ requester_id: 99 }, "APPROVAL_WRONG_REQUESTER"],
    [{ device_id: "FZDEV-OTHER-COUNTER" }, "APPROVAL_WRONG_DEVICE"],
    [{ sale_ref: "another-bill" }, "APPROVAL_WRONG_SALE"],
    [{ company_id: 2 }, "APPROVAL_WRONG_COMPANY"],
    [{ action: "edit" }, "APPROVAL_WRONG_ACTION"],
    [{ expires_at: new Date(Date.now() - 1000) }, "APPROVAL_EXPIRED"],
    [{ approver_role: "Cashier" }, "APPROVER_NO_LONGER_ALLOWED"],
    [{ status: "CONSUMED" }, "APPROVAL_ALREADY_USED"],
  ];
  for (const [override, detail] of cases) {
    const approval = discountApproval(override);
    const { response, statements } = await checkout({
      idempotency_key: "bill-op-1",
      discount_approval_id: approval.id,
      items: [plainLine(200)],
      payments: paid(800),
    }, {}, discountStore({ approval }));
    assert.equal(response.status, 403, detail);
    assert.equal(response.body.code, "DISCOUNT_APPROVAL_REQUIRED", detail);
    assert.equal(response.body.detail, detail);
    assert.equal(find(statements, /^INSERT INTO sales/).length, 0, detail);
    assert.equal(find(statements, /^UPDATE sale_change_approvals/).length, 0, `${detail}: an approval that does not hold is not spent`);
  }
  const unknown = await checkout({ idempotency_key: "bill-op-1", discount_approval_id: "no-such-approval", items: [plainLine(200)], payments: paid(800) }, {}, discountStore());
  assert.equal(unknown.response.body.detail, "APPROVAL_NOT_FOUND");
});

test("checkout: an approval is single use -- the second bill cannot spend it", async () => {
  // The first bill consumed it; the row now reads CONSUMED under its lock.
  const spent = discountApproval({ status: "CONSUMED" });
  const { response } = await checkout({ idempotency_key: "bill-op-1", discount_approval_id: spent.id, items: [plainLine(200)], payments: paid(800) }, {}, discountStore({ approval: spent }));
  assert.equal(response.status, 403);
  assert.equal(response.body.detail, "APPROVAL_ALREADY_USED");
});

// --- Desktop sync ----------------------------------------------------------------------------

const { processSyncOperation } = require("./server");
const SYNC_DEVICE = "FZDEV-DISCOUNT-DESKTOP";

const syncContext = () => ({
  user: { id: REQUESTER_ID, full_name: "Counter" },
  device: { device_id: SYNC_DEVICE, status: "APPROVED" },
  branch: { id: 2, company_id: 1, active: true },
  companyId: 1,
  branchId: 2,
  deviceId: SYNC_DEVICE,
  operationalLocationId: null,
  assignmentGeneration: null,
});

const syncBill = async ({ items, payments, approvalId, lotDiscounts = [], store, extra = {} }) => {
  const client = saleClient({ lotDiscounts });
  const wrapped = {
    ...client,
    query: async (text, values) => {
      const sql = String(typeof text === "object" && text ? text.text : text || "").replace(/\s+/g, " ").trim();
      const scripted = store(sql, values || []);
      if (scripted !== undefined) {
        client.statements.push({ sql, values: values || [] });
        return scripted;
      }
      if (/^SELECT id, product_id, remaining_qty, batch_status FROM inventory_batches/.test(sql)) {
        client.statements.push({ sql, values: values || [] });
        return rows([{ id: LOT_ID, product_id: PRODUCT_ID, remaining_qty: "50.000", batch_status: "ACTIVE" }]);
      }
      if (/^INSERT INTO sales/.test(sql)) {
        client.statements.push({ sql, values: values || [] });
        return rows([{ id: 5151, sale_date: new Date(), global_id: "invoice-desk-1", entity_version: 1 }]);
      }
      if (/^INSERT INTO sale_items/.test(sql)) {
        client.statements.push({ sql, values: values || [] });
        return rows([{ id: 88 }]);
      }
      if (/^INSERT INTO sync_pos_sale_staging/.test(sql)) {
        client.statements.push({ sql, values: values || [] });
        return rows([{ entity_version: 1, updated_at: new Date() }]);
      }
      if (/^INSERT INTO sync_change_log/.test(sql)) {
        client.statements.push({ sql, values: values || [] });
        return rows([{ change_id: 1, created_at: new Date() }]);
      }
      return client.query(text, values);
    },
  };
  const ack = await processSyncOperation(wrapped, {
    operation_id: "desk-op-1",
    entity_type: "pos_sale",
    entity_id: "invoice-desk-1",
    operation_type: "UPSERT",
    payload: {
      operation_id: "desk-op-1",
      invoice_global_id: "invoice-desk-1",
      offline_invoice_ref: "OFF-20260930-0001",
      customer: { account_id: 5 },
      bill_date: "2026-09-30",
      bill_datetime: "2026-09-30T10:00",
      bill_discount_total: 0,
      items,
      payments,
      ...(approvalId ? { discount_approval_id: approvalId } : {}),
      ...extra,
    },
  }, syncContext());
  return { ack, statements: client.statements };
};

const deskApproval = (overrides = {}) => discountApproval({ sale_ref: "desk-op-1", device_id: SYNC_DEVICE, branch_id: 2, ...overrides });

test("sync: a desktop bill over 5% with no approval is accepted and leaves a DISCOUNT_UNAPPROVED trace", async () => {
  const { ack, statements } = await syncBill({ items: [plainLine(200)], payments: paid(800), store: discountStore() });
  assert.equal(ack.status, "accepted", ack.message);
  assert.equal(find(statements, /^INSERT INTO sales/).length, 1, "the bill the customer has is kept");
  const [trace] = find(statements, /^INSERT INTO sale_audit_trail/);
  assert.match(trace.sql, /'DISCOUNT_UNAPPROVED'/);
  assert.match(trace.sql, /NULL\)$/, "no approver");
  assert.deepEqual(trace.values.slice(0, 1), [5151]);
  assert.equal(trace.values[2], "Discount over 5% without approval");
  assert.equal(trace.values[3], REQUESTER_ID);
  assert.equal(JSON.parse(trace.values[1]).detail, "APPROVAL_MISSING");
});

test("sync: an invalid approval never rejects the bill; the trace names why, and the approval is not spent", async () => {
  for (const [override, detail] of [
    [{ device_id: "FZDEV-OTHER-COUNTER" }, "APPROVAL_WRONG_DEVICE"],
    [{ requester_id: 99 }, "APPROVAL_WRONG_REQUESTER"],
    [{ sale_ref: "another-bill" }, "APPROVAL_WRONG_SALE"],
    [{ status: "CONSUMED" }, "APPROVAL_ALREADY_USED"],
  ]) {
    const approval = deskApproval(override);
    const { ack, statements } = await syncBill({ items: [plainLine(200)], payments: paid(800), approvalId: approval.id, store: discountStore({ approval }) });
    assert.equal(ack.status, "accepted", `${detail}: ${ack.message}`);
    assert.equal(find(statements, /^UPDATE sale_change_approvals/).length, 0, detail);
    const trace = JSON.parse(find(statements, /^INSERT INTO sale_audit_trail/)[0].values[1]);
    assert.equal(trace.detail, detail);
    assert.equal(trace.approval_id, approval.id);
  }
});

test("sync: a valid approval is spent on the synced bill and its approver recorded", async () => {
  for (const saleRef of ["desk-op-1", "invoice-desk-1", "OFF-20260930-0001"]) {
    const approval = deskApproval({ sale_ref: saleRef });
    const { ack, statements } = await syncBill({ items: [plainLine(200)], payments: paid(800), approvalId: approval.id, store: discountStore({ approval }) });
    assert.equal(ack.status, "accepted", ack.message);
    const [consume] = find(statements, /^UPDATE sale_change_approvals SET status = 'CONSUMED'/);
    assert.deepEqual(consume.values, [approval.id, 5151], saleRef);
    const [audit] = find(statements, /^INSERT INTO sale_audit_trail/);
    assert.match(audit.sql, /'DISCOUNT_APPROVED'/);
    assert.equal(audit.values[4], 1);
  }
});

test("sync: within 5%, exempt, or on top of the lot's own discount leaves no trace", async () => {
  const within = await syncBill({ items: [plainLine(50)], payments: paid(950), store: discountStore() });
  assert.equal(within.ack.status, "accepted");
  assert.equal(find(within.statements, /sale_audit_trail|sale_change_approvals/).length, 0);

  const owner = await syncBill({ items: [plainLine(200)], payments: paid(800), store: discountStore({ role: "Owner" }) });
  assert.equal(owner.ack.status, "accepted");
  assert.equal(find(owner.statements, /sale_audit_trail|sale_change_approvals/).length, 0);

  // A 10% lot discount stopped since billing was still the lot's when the customer got it.
  const lotLine = { ...plainLine(145), lot_discount_id: 56, lot_discount_type: "PERCENTAGE", lot_discount_value: 10 };
  const stopped = [lotDiscountRow({ id: 56, discount_type: "PERCENTAGE", discount_value: "10.00", active: false })];
  const lot = await syncBill({ items: [lotLine], payments: paid(855), lotDiscounts: stopped, store: discountStore() });
  assert.equal(lot.ack.status, "accepted", lot.ack.message);
  assert.equal(find(lot.statements, /sale_audit_trail/).length, 0);

  // A lot discount the lot never had is the cashier's.
  const invented = await syncBill({ items: [lotLine], payments: paid(855), lotDiscounts: [], store: discountStore() });
  assert.equal(invented.ack.status, "accepted");
  assert.match(find(invented.statements, /^INSERT INTO sale_audit_trail/)[0].sql, /'DISCOUNT_UNAPPROVED'/);
});

// --- The approval itself ---------------------------------------------------------------------

const APPROVER_PASSWORD = "owner approves 5%";
const APPROVER_HASH = hashPasswordSync(APPROVER_PASSWORD);

const askApproval = async (body, { role = "Cashier", permissions = {} } = {}) => {
  const statements = [];
  const respond = (sql, values) => {
    const text = normalise(typeof sql === "object" && sql ? sql.text : sql);
    statements.push({ sql: text, values: values || [] });
    const scope = scopeResponder(text);
    if (scope) return scope;
    if (ACTOR_SQL.test(text)) return rows(role ? [{ id: REQUESTER_ID, full_name: "Counter", role_name: role, permissions }] : []);
    if (/FROM sale_change_approvals WHERE requester_id = \$1 AND status = 'FAILED'/.test(text)) return rows([{ failures: 0, daily_failures: 0 }]);
    if (/WHERE LOWER\(u\.username\) = LOWER\(\$1\)/.test(text)) {
      return rows([{ id: 1, full_name: "Rig Owner", username: "owner", password_hash: APPROVER_HASH, active: true, locked_until: null, role_name: "Owner", company_id: 1 }]);
    }
    return { rows: [], rowCount: 0 };
  };
  setQueryResponder(respond);
  setConnectionResponder(() => ({ query: async (sql, values) => respond(sql, values), release: () => {} }));
  try {
    const response = await probe(app, "POST", "/api/v3/sale-change-approvals", {
      authorization: `Bearer ${tokenFor({ deviceId: SALE_DEVICE, branchId: SALE_BRANCH_ID })}`,
      "content-type": "application/json",
    }, { idempotency_key: `approval-request-${billNumber += 1}`, ...body });
    return { response, statements };
  } finally {
    clearQueryResponder();
    clearConnectionResponder();
  }
};

test("approval route: a cashier gets a discount approval bound to the bill's operation id, this counter and themselves", async () => {
  const { response, statements } = await askApproval({ action: "discount", sale_ref: "bill-op-1", approver_username: "OWNER", approver_password: APPROVER_PASSWORD });
  assert.equal(response.status, 201, response.text);
  assert.equal(response.body.approver_name, "Rig Owner");
  const [insert] = find(statements, /^INSERT INTO sale_change_approvals/);
  assert.deepEqual(insert.values.slice(1, 10), ["ISSUED", "discount", "bill-op-1", REQUESTER_ID, 1, 1, SALE_BRANCH_ID, SALE_DEVICE, "Item discount over 5%"]);
  assert.equal(insert.values[0], response.body.approval_id);
});

test("approval route: a wrong password is refused and counted against the cashier", async () => {
  const { response, statements } = await askApproval({ action: "discount", sale_ref: "bill-op-1", approver_username: "owner", approver_password: "guess" });
  assert.equal(response.status, 401);
  assert.equal(response.body.code, "APPROVER_CREDENTIALS_INVALID");
  const [failure] = find(statements, /^INSERT INTO sale_change_approvals/);
  assert.equal(failure.values[1], "FAILED");
  assert.equal(failure.values[2], "discount");
});

test("approval route: someone the 5% rule already exempts is told they need no approval", async () => {
  for (const actor of [{ role: "Owner" }, { role: "Admin" }, { role: "Cashier", permissions: { manual_pos_rate_override: true } }]) {
    const { response, statements } = await askApproval({ action: "discount", sale_ref: "bill-op-1", approver_username: "owner", approver_password: APPROVER_PASSWORD }, actor);
    assert.equal(response.status, 400, actor.role);
    assert.equal(response.body.code, "APPROVAL_NOT_NEEDED");
    assert.equal(find(statements, /^INSERT INTO sale_change_approvals/).length, 0);
  }
  const inactive = await askApproval({ action: "discount", sale_ref: "bill-op-1", approver_username: "owner", approver_password: APPROVER_PASSWORD }, { role: null });
  assert.equal(inactive.response.status, 403);
  assert.equal(inactive.response.body.code, "REQUESTER_NOT_ALLOWED");
});

// ---------------------------------------------------------------------------------------------
// A cashier's own bill discount, under the same 5% (owner's rule, 1 Oct 2026)
// ---------------------------------------------------------------------------------------------

const { assessBillManualDiscount, readManualBillDiscount, withExtraDiscountName, EXTRA_DISCOUNT_SUFFIX } = rules;

// One ₹1,000 line (10 x ₹100); 5% of the bill is ₹50.
const thousand = (discountAmount = 0) => [{ quantity: 10, rate: 100, discountAmount }];

test("bill rule: exactly 5% of the bill in total is free, a paisa of rounding too, anything more needs approval", () => {
  assert.equal(assessBillManualDiscount({ lines: thousand(), manualBill: 50 }).needsApproval, false, "5.00% on the bill");
  assert.equal(assessBillManualDiscount({ lines: thousand(), manualBill: 50.01 }).needsApproval, false, "a paisa is rounding");
  assert.equal(assessBillManualDiscount({ lines: thousand(), manualBill: 50.02 }).needsApproval, true, "just over");
  assert.equal(assessBillManualDiscount({ lines: thousand(), manualBill: 50.1 }).needsApproval, true);
  assert.deepEqual(assessBillManualDiscount({ lines: thousand(), manualBill: 50.1 }).bill, {
    manualBill: 50.1, base: 1000, freeLimit: 50, manualTotal: 50.1, needsApproval: true, unreadable: false,
  });
});

test("bill rule: the 5% is shared between the lines and the bill, spread however the cashier likes", () => {
  const lines = [{ quantity: 6, rate: 100, discountAmount: 30 }, { quantity: 4, rate: 100, discountAmount: 0 }];
  // ₹30 on the ₹600 line (5%) + ₹20 on the bill = ₹50 = 5% of ₹1,000.
  const spread = assessBillManualDiscount({ lines, manualBill: 20 });
  assert.equal(spread.needsApproval, false);
  assert.equal(spread.manualDiscountTotal, 50);
  assert.equal(spread.lineManualDiscountTotal, 30);
  assert.equal(assessBillManualDiscount({ lines, manualBill: 20.02 }).needsApproval, true, "₹50.02 in all");
  assert.equal(assessBillManualDiscount({ lines, manualBill: 20.02 }).bill.needsApproval, true);
  // The per-line rule still holds: ₹31 on a ₹600 line is over 5% of that line, whatever the bill.
  const lineOver = assessBillManualDiscount({ lines: [{ quantity: 6, rate: 100, discountAmount: 31 }, { quantity: 4, rate: 100, discountAmount: 0 }], manualBill: 1 });
  assert.equal(lineOver.needsApproval, true);
  assert.equal(lineOver.bill.needsApproval, false, "₹32 is within 5% of the bill; the line alone is over");
});

test("bill rule: the lot's own discount is set aside from the base, as on a line", () => {
  const tenPercentLot = { discount_type: "PERCENTAGE", discount_value: "10.00" };
  // ₹1,000 line, lot gives ₹100: base ₹900, 5% = ₹45.
  const lines = [{ quantity: 10, rate: 100, discountAmount: 100, lotDiscount: tenPercentLot }];
  assert.equal(assessBillManualDiscount({ lines, manualBill: 45 }).needsApproval, false);
  assert.equal(assessBillManualDiscount({ lines, manualBill: 45.02 }).needsApproval, true);
  assert.equal(assessBillManualDiscount({ lines, manualBill: 45 }).bill.base, 900);
});

test("bill rule: no bill discount answers exactly as the per-line rule did", () => {
  // Three lines each a paisa over their own 5% pass the line rule; summed they are three paise
  // over the bill's 5%. With no bill discount of the cashier's, that bill must not change answer.
  const lines = [1, 2, 3].map(() => ({ quantity: 1, rate: 100, discountAmount: 5.01 }));
  for (const manualBill of [0, "", null, undefined]) {
    const bill = assessBillManualDiscount({ lines, manualBill });
    assert.equal(bill.needsApproval, assessManualDiscounts(lines).needsApproval, JSON.stringify(manualBill));
    assert.equal(bill.needsApproval, false);
  }
  assert.equal(assessBillManualDiscount({ lines, manualBill: 0.01 }).needsApproval, true, "once the bill has a part, the bill total counts");
});

test("bill rule: an unreadable bill discount, or one on a bill with an unreadable line, needs approval", () => {
  for (const manualBill of ["abc", -1, NaN]) {
    const bill = assessBillManualDiscount({ lines: thousand(), manualBill });
    assert.equal(bill.needsApproval, true, String(manualBill));
    assert.equal(bill.bill.unreadable, true);
    assert.equal(bill.bill.manualBill, null, "unreadable is not ₹0");
  }
  const unknownLine = [{ quantity: "abc", rate: 100, discountAmount: 0 }];
  assert.equal(assessBillManualDiscount({ lines: unknownLine, manualBill: 0 }).needsApproval, false);
  assert.equal(assessBillManualDiscount({ lines: unknownLine, manualBill: 1 }).needsApproval, true, "5% of an unknown base is not known");
});

test("manual_bill_discount: absent, readable at 2 dp, or unreadable -- never read as 0", () => {
  for (const value of [undefined, null, "", "  "]) assert.deepEqual(readManualBillDiscount(value), { present: false, amount: 0, unreadable: false });
  assert.deepEqual(readManualBillDiscount(0), { present: true, amount: 0, unreadable: false });
  assert.deepEqual(readManualBillDiscount("12.345"), { present: true, amount: 12.35, unreadable: false });
  for (const value of ["abc", -0.5, true, Infinity]) assert.equal(readManualBillDiscount(value).unreadable, true, String(value));
});

test("browser checkout, manual part: expected = server's slab + manual; differ by over a paisa is 409", () => {
  const base = { mode: "SLAB", gross: 400, subtotalAfterItems: 400, paymentMode: "CASH", rules: [TEN_PERCENT] };
  const ok = resolveInvoiceDiscount({ ...base, requested: 60, manualBill: 20 });
  assert.equal(ok.amount, 60);
  assert.equal(ok.slabAmount, 40);
  assert.equal(ok.manualBill, 20);
  assert.equal(ok.rule.id, 3);
  assert.equal(ok.rule.rule_name, "Big bills + extra", "the stored name does not claim ₹60 was the slab");
  assert.equal(TEN_PERCENT.rule_name, "Big bills", "the slab row itself is not renamed");
  assert.equal(resolveInvoiceDiscount({ ...base, requested: 60.01, manualBill: 20 }).amount, 60, "a paisa is tolerance");

  const stale = resolveInvoiceDiscount({ ...base, requested: 40, manualBill: 20 });
  assert.deepEqual(stale.error, {
    status: 409,
    code: "DISCOUNT_RULES_CHANGED",
    expected_invoice_discount: 60,
    expected_slab_discount: 40,
    message: "Bill discount rules changed. POS has reloaded them - check the total and try again.",
  });
  assert.equal(resolveInvoiceDiscount({ ...base, requested: 60.02, manualBill: 20 }).error.code, "DISCOUNT_RULES_CHANGED");

  // Manual only: no slab matches; the amount stands and no rule name is stored.
  const manualOnly = resolveInvoiceDiscount({ ...base, rules: [], requested: 15, manualBill: 15 });
  assert.deepEqual(manualOnly, { amount: 15, rule: null, slabAmount: 0, manualBill: 15 });
  // A slab the POS claims that no longer matches: the server expects the manual part alone.
  const claim = readDiscountRuleSnapshot({ discount_rule_id: 3, discount_rule_name: "Big bills" });
  assert.equal(resolveInvoiceDiscount({ ...base, rules: [], requested: 55, manualBill: 15, snapshot: claim }).error.expected_invoice_discount, 15);
  // A manual part of 0 is the slab exactly as before, with its own name.
  assert.deepEqual(resolveInvoiceDiscount({ ...base, requested: 40, manualBill: 0 }), { amount: 40, rule: TEN_PERCENT, slabAmount: 40, manualBill: 0 });
});

test("browser checkout, manual part: bounded -- never negative, unreadable, or past the subtotal", () => {
  const base = { mode: "SLAB", gross: 400, subtotalAfterItems: 400, paymentMode: "CASH", rules: [TEN_PERCENT] };
  assert.deepEqual(resolveInvoiceDiscount({ ...base, requested: 40, manualBill: "abc" }).error, { status: 400, message: "Enter a valid bill discount" });
  assert.equal(resolveInvoiceDiscount({ ...base, requested: 40, manualBill: -5 }).error.status, 400);
  // ₹40 slab + ₹370 manual is ₹410 on a ₹400 bill: the total is refused before anything else.
  assert.equal(resolveInvoiceDiscount({ ...base, requested: 410, manualBill: 370 }).error.status, 400);
  // ₹360 manual + ₹40 slab = the whole subtotal is allowed (the cashier's 5% rule is separate).
  assert.equal(resolveInvoiceDiscount({ ...base, requested: 400, manualBill: 360 }).amount, 400);
  // ₹40 slab + ₹380 manual = ₹420 on a ₹400 bill, though the client sent ₹400: said as too large,
  // with the most the cashier may give -- not as "rules changed" with an amount above the bill.
  assert.deepEqual(resolveInvoiceDiscount({ ...base, requested: 400, manualBill: 380 }).error, {
    status: 400,
    code: "BILL_DISCOUNT_TOO_LARGE",
    max_manual_bill_discount: 360,
    message: "Bill discount cannot be more than the bill after its slab discount",
  });
  assert.equal(resolveInvoiceDiscount({ ...base, requested: 400, manualBill: 360.01 }).amount, 400, "a paisa over is rounding, capped at the subtotal");
});

test("old clients: no manual_bill_discount resolves exactly as before, shape and all", () => {
  for (const manualBill of [undefined, null, ""]) {
    assert.deepEqual(resolveInvoiceDiscount({ mode: "SLAB", requested: 40, gross: 400, subtotalAfterItems: 400, paymentMode: "CASH", rules: [TEN_PERCENT], manualBill }), { amount: 40, rule: TEN_PERCENT });
    assert.deepEqual(resolveInvoiceDiscount({ mode: "SLAB", requested: 15, gross: 400, subtotalAfterItems: 400, paymentMode: "CASH", rules: [], manualBill }), { amount: 15, rule: null });
    const snapshot = readDiscountRuleSnapshot({ discount_rule_name: "Old slab" });
    assert.deepEqual(resolveInvoiceDiscount({ mode: "AS_BILLED", requested: 25, subtotalAfterItems: 400, snapshot, manualBill }), { amount: 25, rule: snapshot });
  }
});

test("as billed, manual part: never refused; the rule says ' + extra', or nothing when manual only", () => {
  const snapshot = readDiscountRuleSnapshot({ discount_rule_id: "7", discount_rule_name: "Old slab", discount_rule_type: "FLAT_AMOUNT", discount_rule_value: "25", discount_rule_payment_mode: "ALL" });
  const base = { mode: "AS_BILLED", gross: 400, subtotalAfterItems: 400, paymentMode: "CASH", rules: [TEN_PERCENT], snapshot };
  const both = resolveInvoiceDiscount({ ...base, requested: 45, manualBill: 20 });
  assert.equal(both.amount, 45);
  assert.deepEqual(both.rule, { id: "7", rule_name: "Old slab + extra", discount_type: "FLAT_AMOUNT", discount_value: 25, payment_mode: "ALL" });
  assert.equal(both.slabAmount, 25);
  assert.equal(both.manualBill, 20);
  assert.equal(resolveInvoiceDiscount({ ...base, requested: 20, manualBill: 20 }).rule, null, "manual only: no slab name");
  const over = resolveInvoiceDiscount({ ...base, requested: 20, manualBill: 999 });
  assert.equal(over.error, undefined, "a desktop's manual figure above its own bill discount is not a refusal");
  assert.equal(over.manualBill, 20, "the cashier gave at most the discount billed");
  const unreadable = resolveInvoiceDiscount({ ...base, requested: 45, manualBill: "abc" });
  assert.equal(unreadable.error, undefined);
  assert.equal(unreadable.manualBill, null);
  assert.equal(unreadable.rule, snapshot, "kept as the device sent it");
  assert.equal(resolveInvoiceDiscount({ ...base, requested: 0, manualBill: 0 }).rule, null);
  assert.equal(resolveInvoiceDiscount({ ...base, requested: 25, manualBill: 0 }).rule, snapshot, "no manual part: the snapshot as sent");
});

test("the ' + extra' name fits VARCHAR(140), and a nameless slab is named", () => {
  assert.equal(EXTRA_DISCOUNT_SUFFIX, " + extra");
  const long = withExtraDiscountName({ id: "9", rule_name: "x".repeat(140) });
  assert.equal(long.rule_name.length, 140);
  assert.ok(long.rule_name.endsWith(" + extra"));
  assert.equal(withExtraDiscountName(slab({ rule_name: "" })).rule_name, "Bills ₹1,000 and above + extra");
  assert.equal(withExtraDiscountName({ id: "9", rule_name: null }).rule_name, "Bill slab + extra");
});

// --- Browser checkout with a bill discount ---------------------------------------------------

const billOf = (manual, { line = 0, slabPart = 0 } = {}) => ({
  items: [plainLine(line)],
  manual_bill_discount: manual,
  invoice_discount: Math.round((slabPart + manual) * 100) / 100,
  payments: paid(Math.round((1000 - line - slabPart - manual) * 100) / 100),
});

test("checkout: a cashier's 5.00% bill discount bills without asking anyone; no slab name is stored", async () => {
  const { response, statements } = await checkout(billOf(50), {}, discountStore());
  assert.equal(response.status, 201, response.text);
  assert.equal(find(statements, ACTOR_SQL).length, 0, "within 5%, nobody is looked up");
  const sale = columnsOf(find(statements, /^INSERT INTO sales/)[0]);
  assert.equal(Number(sale.invoice_discount_amount), 50);
  assert.equal(sale.discount_rule_name, null);
  assert.equal(sale.discount_rule_id, null);
});

test("checkout: a bill discount just over 5% is 403 DISCOUNT_APPROVAL_REQUIRED, nothing kept", async () => {
  const { response, statements } = await checkout(billOf(50.02), {}, discountStore());
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "DISCOUNT_APPROVAL_REQUIRED");
  assert.equal(response.body.detail, "APPROVAL_MISSING");
  assert.equal(find(statements, /^INSERT INTO sales/).length, 0);
});

test("checkout: 5% spread across a line and the bill is free; a paisa past it on the bill is not", async () => {
  const ok = await checkout(billOf(20, { line: 30 }), {}, discountStore());
  assert.equal(ok.response.status, 201, ok.response.text);
  const over = await checkout(billOf(20.02, { line: 30 }), {}, discountStore());
  assert.equal(over.response.status, 403);
  assert.equal(over.response.body.code, "DISCOUNT_APPROVAL_REQUIRED");
});

test("checkout: slab + manual must be the server's slab plus the manual part, or 409 with the amount expected", async () => {
  // 10 kg x ₹100 = ₹1,000; TEN_PERCENT gives ₹100; ₹40 on top is within 5%.
  const slabs = { slabs: [TEN_PERCENT], slabsOn: true };
  const ok = await checkout({ ...billOf(40, { slabPart: 100 }), discount_rule_id: 3 }, slabs, discountStore());
  assert.equal(ok.response.status, 201, ok.response.text);
  const sale = columnsOf(find(ok.statements, /^INSERT INTO sales/)[0]);
  assert.equal(Number(sale.invoice_discount_amount), 140);
  assert.equal(sale.discount_rule_id, 3);
  assert.equal(sale.discount_rule_name, "Big bills + extra");

  const stale = await checkout({ ...billOf(40, { slabPart: 50 }), discount_rule_id: 3 }, slabs, discountStore());
  assert.equal(stale.response.status, 409);
  assert.deepEqual(stale.response.body, {
    code: "DISCOUNT_RULES_CHANGED",
    expected_invoice_discount: 140,
    expected_slab_discount: 100,
    message: "Bill discount rules changed. POS has reloaded them - check the total and try again.",
  });
  assert.equal(find(stale.statements, /^INSERT INTO sales/).length, 0);
});

test("checkout: an unreadable bill discount is 400 before anything is opened", async () => {
  const { response, statements } = await checkout({ ...billOf(0), manual_bill_discount: "ten" }, {}, discountStore());
  assert.equal(response.status, 400);
  assert.equal(response.body.message, "Enter a valid bill discount");
  assert.equal(find(statements, /^BEGIN$/).length, 0);
});

test("checkout: Owner, Admin and a holder of manual_pos_rate_override give any bill discount without approval", async () => {
  for (const actor of [
    { role: "Owner" },
    { role: "Admin" },
    { role: "Cashier", permissions: { manual_pos_rate_override: true } },
  ]) {
    const { response, statements } = await checkout(billOf(200), {}, discountStore(actor));
    assert.equal(response.status, 201, `${actor.role}: ${response.text}`);
    assert.equal(find(statements, /sale_change_approvals|sale_audit_trail/).length, 0, actor.role);
  }
});

test("checkout: an approval covers a bill discount over 5%, and the trace carries the bill part", async () => {
  const approval = discountApproval();
  const { response, statements } = await checkout({ idempotency_key: "bill-op-1", discount_approval_id: approval.id, ...billOf(80) }, {}, discountStore({ approval }));
  assert.equal(response.status, 201, response.text);
  const [audit] = find(statements, /^INSERT INTO sale_audit_trail/);
  assert.match(audit.sql, /'DISCOUNT_APPROVED'/);
  const trace = JSON.parse(audit.values[1]);
  assert.deepEqual(trace.lines, [], "no line was over 5% on its own");
  assert.equal(trace.manual_discount_total, 80);
  assert.deepEqual(trace.bill, {
    manual_bill_discount: 80, line_manual_total: 0, manual_total: 80, base: 1000, free_limit: 50, needs_approval: true, unreadable: false,
  });
});

test("bill part without manual_bill_discount: what the invoice discount gives beyond the server's slab", () => {
  const { impliedManualBillDiscount } = rules;
  const base = { gross: 1000, subtotalAfterItems: 1000, paymentMode: "CASH" };
  assert.equal(impliedManualBillDiscount({ ...base, requested: 100, rules: [] }), 100, "no slab: all of it is the cashier's");
  assert.equal(impliedManualBillDiscount({ ...base, requested: 0, rules: [] }), 0);
  assert.equal(impliedManualBillDiscount({ ...base, requested: 100, rules: [TEN_PERCENT] }), 0, "exactly the slab");
  assert.equal(impliedManualBillDiscount({ ...base, requested: 160.004, rules: [TEN_PERCENT] }), 60);
  assert.equal(impliedManualBillDiscount({ ...base, requested: 40, rules: [TEN_PERCENT] }), 0, "under the slab is not negative");
  assert.equal(impliedManualBillDiscount({ ...base, requested: 100, rules: [TEN_PERCENT], enabled: false }), 100, "slabs off: no slab part");
  assert.equal(impliedManualBillDiscount({ ...base, requested: 1001, rules: [] }), 0, "unboundable: refused later by resolveInvoiceDiscount");
});

test("checkout without manual_bill_discount: a bill discount beyond the slab is held to the 5% (no unchecked shape)", async () => {
  // No slab: ₹100 off ₹1,000 sent as a bare invoice_discount is 10% of the cashier's own.
  const bare = await checkout({ items: [plainLine(0)], invoice_discount: 100, payments: paid(900) }, {}, discountStore());
  assert.equal(bare.response.status, 403, bare.response.text);
  assert.equal(bare.response.body.code, "DISCOUNT_APPROVAL_REQUIRED");
  assert.equal(find(bare.statements, /^INSERT INTO sales/).length, 0);
  // Within 5% it bills, as before, with no rule name.
  const within = await checkout({ items: [plainLine(0)], invoice_discount: 50, payments: paid(950) }, {}, discountStore());
  assert.equal(within.response.status, 201, within.response.text);
  assert.equal(columnsOf(find(within.statements, /^INSERT INTO sales/)[0]).discount_rule_name, null);
  // Shared with the lines: ₹30 on the line + ₹20.02 bare on the bill is past 5%.
  const spread = await checkout({ items: [plainLine(30)], invoice_discount: 20.02, payments: paid(949.98) }, {}, discountStore());
  assert.equal(spread.response.status, 403);
  // The slab is not the cashier's: a ₹100 slab bill asks nobody.
  const slabbed = await checkout({ items: [plainLine(0)], invoice_discount: 100, discount_rule_id: 3, payments: paid(900) }, { slabs: [TEN_PERCENT], slabsOn: true }, discountStore());
  assert.equal(slabbed.response.status, 201, slabbed.response.text);
  assert.equal(find(slabbed.statements, ACTOR_SQL).length, 0);
  assert.equal(columnsOf(find(slabbed.statements, /^INSERT INTO sales/)[0]).discount_rule_name, "Big bills", "no ' + extra' without the field");
  // An exempt user still gives it without approval.
  const owner = await checkout({ items: [plainLine(0)], invoice_discount: 100, payments: paid(900) }, {}, discountStore({ role: "Owner" }));
  assert.equal(owner.response.status, 201, owner.response.text);
  // With an approval, the trace names the bill part.
  const approval = discountApproval();
  const approved = await checkout({ idempotency_key: "bill-op-1", discount_approval_id: approval.id, items: [plainLine(0)], invoice_discount: 100, payments: paid(900) }, {}, discountStore({ approval }));
  assert.equal(approved.response.status, 201, approved.response.text);
  const trace = JSON.parse(find(approved.statements, /^INSERT INTO sale_audit_trail/)[0].values[1]);
  assert.equal(trace.bill.manual_bill_discount, 100);
  assert.equal(trace.bill.needs_approval, true);
});

// --- Desktop sync with a bill discount -------------------------------------------------------

test("sync: a bill discount over 5% is never refused; the DISCOUNT_UNAPPROVED trace carries the bill part", async () => {
  const { ack, statements } = await syncBill({
    items: [plainLine(0)], payments: paid(940), store: discountStore(),
    extra: { bill_discount_total: 60, manual_bill_discount: 60 },
  });
  assert.equal(ack.status, "accepted", ack.message);
  assert.equal(find(statements, /^INSERT INTO sales/).length, 1);
  const [audit] = find(statements, /^INSERT INTO sale_audit_trail/);
  assert.match(audit.sql, /'DISCOUNT_UNAPPROVED'/);
  const trace = JSON.parse(audit.values[1]);
  assert.equal(trace.detail, "APPROVAL_MISSING");
  assert.equal(trace.bill.manual_bill_discount, 60);
  assert.equal(trace.bill.free_limit, 50);
  assert.equal(trace.bill.needs_approval, true);
});

test("sync: a bill discount within 5% (or spread within it), or by an exempt user, leaves no trace", async () => {
  const within = await syncBill({ items: [plainLine(30)], payments: paid(950), store: discountStore(), extra: { bill_discount_total: 20, manual_bill_discount: 20 } });
  assert.equal(within.ack.status, "accepted", within.ack.message);
  assert.equal(find(within.statements, /sale_audit_trail|sale_change_approvals/).length, 0);
  const owner = await syncBill({ items: [plainLine(0)], payments: paid(800), store: discountStore({ role: "Owner" }), extra: { bill_discount_total: 200, manual_bill_discount: 200 } });
  assert.equal(owner.ack.status, "accepted", owner.ack.message);
  assert.equal(find(owner.statements, /sale_audit_trail|sale_change_approvals/).length, 0);
});

test("sync: the rule stored is the slab's name + extra, or none for a manual-only bill", async () => {
  const slabFields = { discount_rule_id: 7, discount_rule_name: "Old slab", discount_rule_type: "FLAT_AMOUNT", discount_rule_value: 25, discount_rule_payment_mode: "ALL" };
  const both = await syncBill({ items: [plainLine(0)], payments: paid(955), store: discountStore(), extra: { ...slabFields, bill_discount_total: 45, manual_bill_discount: 20 } });
  assert.equal(both.ack.status, "accepted", both.ack.message);
  const bothSale = columnsOf(find(both.statements, /^INSERT INTO sales/)[0]);
  assert.equal(Number(bothSale.invoice_discount_amount), 45);
  assert.equal(bothSale.discount_rule_name, "Old slab + extra");
  assert.equal(String(bothSale.discount_rule_id), "7");

  const manualOnly = await syncBill({ items: [plainLine(0)], payments: paid(980), store: discountStore(), extra: { ...slabFields, bill_discount_total: 20, manual_bill_discount: 20 } });
  assert.equal(manualOnly.ack.status, "accepted", manualOnly.ack.message);
  const manualSale = columnsOf(find(manualOnly.statements, /^INSERT INTO sales/)[0]);
  assert.equal(manualSale.discount_rule_name, null);
  assert.equal(manualSale.discount_rule_id, null);
});

test("sync: an unreadable bill discount is accepted and traced as unreadable, never as none", async () => {
  const { ack, statements } = await syncBill({ items: [plainLine(0)], payments: paid(990), store: discountStore(), extra: { bill_discount_total: 10, manual_bill_discount: "ten" } });
  assert.equal(ack.status, "accepted", ack.message);
  const trace = JSON.parse(find(statements, /^INSERT INTO sale_audit_trail/)[0].values[1]);
  assert.equal(trace.bill.unreadable, true);
  assert.equal(trace.bill.manual_bill_discount, null);
});

// ---------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------

test("server.js matches slabs in JS from discounts.js and keeps no SQL matcher", () => {
  assert.match(SOURCE, /require\("\.\/discounts"\)/);
  assert.doesNotMatch(SOURCE, /const getMatchingDiscountRule\s*=/);
  assert.doesNotMatch(SOURCE, /const calculateInvoiceDiscount\s*=/);
  assert.doesNotMatch(SOURCE, /ORDER BY\s+CASE WHEN payment_mode = \$2/);
});

test("every recorded bill (desktop sync, sync edit, edit route) takes its bill discount as billed", () => {
  const calls = SOURCE.split("await buildSalePayload(client, {").slice(1).map((chunk) => chunk.slice(0, chunk.indexOf("});")));
  assert.equal(calls.length, 3);
  for (const body of calls) {
    assert.match(body, /invoiceDiscountMode: "AS_BILLED"/);
    assert.match(body, /discountRuleSnapshot:/);
    assert.match(body, /billDate:/);
  }
});

test("lot-discount writes name the session, never a body field, as the actor", () => {
  const start = SOURCE.indexOf('app.post("/lot-discounts"');
  const block = SOURCE.slice(start, SOURCE.indexOf('app.post("/settings/mandi-tax-rules"'));
  assert.doesNotMatch(block, /req\.body\.(created_by|updated_by|edited_by|deactivated_by)/);
  assert.match(block, /requireRateManager\(req\.auth\.userId/);
});

// ---------------------------------------------------------------------------------------------
// Discount Report, against PGlite
// ---------------------------------------------------------------------------------------------

test("Discount Report: bill-discount share in its own column and the total; a two-lot line counted once", async () => {
  const { PGlite } = require("@electric-sql/pglite");
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE products (id INTEGER PRIMARY KEY, product_name TEXT, unit TEXT);
      CREATE TABLE inventory_batches (id INTEGER PRIMARY KEY, lot_name TEXT, batch_no TEXT, lot_size NUMERIC);
      CREATE TABLE sales (
        id INTEGER PRIMARY KEY, sale_date DATE, invoice_no TEXT, payment_mode TEXT, branch_id INTEGER,
        sale_status TEXT, invoice_discount_amount NUMERIC(14,2), discount_rule_name TEXT
      );
      CREATE TABLE sale_items (
        id INTEGER PRIMARY KEY, sale_id INTEGER, product_id INTEGER, quantity NUMERIC(14,3),
        selling_rate NUMERIC(14,2), default_selling_rate NUMERIC(14,2), amount NUMERIC(14,2),
        discount_amount NUMERIC(14,2), net_amount NUMERIC(14,2), profit NUMERIC(14,2),
        lot_discount_id INTEGER, lot_discount_type TEXT, lot_discount_value NUMERIC(14,2)
      );
      CREATE TABLE sale_batch_allocations (id SERIAL PRIMARY KEY, sale_item_id INTEGER, inventory_batch_id INTEGER, quantity NUMERIC(14,3));

      INSERT INTO products VALUES (1, 'Apple', 'KG'), (2, 'Mango', 'KG');
      INSERT INTO inventory_batches VALUES (10, 'L1', 'B10', 20), (11, 'L2', 'B11', 20), (12, 'L3', 'B12', 20);

      -- Bill 1: a ₹50 slab discount. Apple 10 kg @100 drawn 6 + 4 from two lots; Mango 5 kg at a
      -- special ₹50 (lot price ₹60).
      INSERT INTO sales VALUES (1, '2026-09-30', 'FZ-1', 'CASH', 2, 'COMPLETED', 50, 'Bills ₹1,000 and above');
      INSERT INTO sale_items VALUES
        (101, 1, 1, 10, 100, 100, 1000, 0, 1000, 200, NULL, NULL, 0),
        (102, 1, 2, 5, 50, 60, 250, 0, 250, 40, 55, 'SPECIAL_RATE', 50);
      INSERT INTO sale_batch_allocations (sale_item_id, inventory_batch_id, quantity) VALUES (101, 10, 6), (101, 11, 4), (102, 12, 5);

      -- Excluded: cancelled, another branch, outside the dates, and a bill with no discount at all.
      INSERT INTO sales VALUES (2, '2026-09-30', 'FZ-2', 'CASH', 2, 'CANCELLED', 50, NULL);
      INSERT INTO sales VALUES (3, '2026-09-30', 'FZ-3', 'CASH', 9, 'COMPLETED', 50, NULL);
      INSERT INTO sales VALUES (4, '2026-08-01', 'FZ-4', 'CASH', 2, 'COMPLETED', 50, NULL);
      INSERT INTO sales VALUES (5, '2026-09-30', 'FZ-5', 'CASH', 2, 'COMPLETED', 0, NULL);
      INSERT INTO sale_items VALUES
        (201, 2, 1, 1, 100, 100, 100, 0, 100, 10, NULL, NULL, 0),
        (301, 3, 1, 1, 100, 100, 100, 0, 100, 10, NULL, NULL, 0),
        (401, 4, 1, 1, 100, 100, 100, 0, 100, 10, NULL, NULL, 0),
        (501, 5, 1, 1, 100, 100, 100, 0, 100, 10, NULL, NULL, 0);
      INSERT INTO sale_batch_allocations (sale_item_id, inventory_batch_id, quantity) VALUES (201, 10, 1), (301, 10, 1), (401, 10, 1), (501, 10, 1);
    `);
    const result = await db.query(rules.DISCOUNT_REPORT_SQL, ["2026-09-01", "2026-09-30", 2]);
    const pick = (row) => ({
      product: row.product_name,
      lot: row.lot_name,
      qty: Number(row.quantity_sold),
      gross: Number(row.gross_amount),
      item: Number(row.item_discount_amount),
      bill: Number(row.bill_discount_share),
      discount: Number(row.discount_amount),
      net: Number(row.net_amount),
      profit: Number(row.profit_impact),
    });
    const got = result.rows.map(pick).sort((a, b) => `${a.product}${a.lot}`.localeCompare(`${b.product}${b.lot}`));
    assert.deepEqual(got, [
      { product: "Apple", lot: "L1", qty: 6, gross: 600, item: 0, bill: 24, discount: 24, net: 576, profit: 120 },
      { product: "Apple", lot: "L2", qty: 4, gross: 400, item: 0, bill: 16, discount: 16, net: 384, profit: 80 },
      { product: "Mango", lot: "L3", qty: 5, gross: 300, item: 50, bill: 10, discount: 60, net: 240, profit: 40 },
    ]);
    const total = (field) => got.reduce((sum, row) => sum + row[field], 0);
    assert.equal(total("discount"), 100, "₹50 bill discount + ₹50 special-price difference, each once");
    assert.equal(total("gross"), 1300, "the two-lot line used to be ₹1,000 on each lot row");
    for (const row of got) assert.equal(Math.round((row.gross - row.discount) * 100) / 100, row.net, "gross - discount = net");
    assert.equal(result.rows[0].bill_discount_rule_name, "Bills ₹1,000 and above");
  } finally {
    await db.close();
  }
});
