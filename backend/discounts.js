"use strict";

/**
 * Discounts: the rules, kept out of `server.js` so they can be driven by `node:test`
 * (see `discounts.test.js`). The same rules live in `frontend/src/local/discounts.js`, which the
 * POS and the Discounts screen use; the two must agree to the paisa, or a bill the counter showed
 * is refused at the server.
 *
 * What went wrong before 30 Sep 2026, and is pinned here:
 *
 *   - A blank or zero lot discount saved. A blank "Special Sale Rate" priced fruit at ₹0: the
 *     browser refused every bill for that lot, and a desktop bill never reached the books.
 *   - 150% saved, lot and slab. A 150% slab made every bill in its range free.
 *   - "₹200 off" on a ₹150 lot, and a "special rate" above the price, saved without a word.
 *   - Slab matching differed between POS and server: a maximum of 0 was "no limit" at the counter
 *     and "nothing matches" at the server; ties were broken on the raw value across types (₹50
 *     "beat" 5% of ₹5,000); POS percentages were unrounded. Different slab, different total,
 *     refused bill. Now one matcher, and overlapping slabs are refused at save.
 *   - A desktop bill carrying a slab discount was re-priced at sync against the server's current
 *     slabs, so a slab edited while a counter was offline stranded the bill in the queue.
 *   - A line could say "SPECIAL_RATE" and name any price; nothing checked the lot had that discount.
 *
 * Ids are opaque strings and are compared as such (`canonicalId`), never through `Number()`.
 * Money rounds to 2 dp, half away from zero, like `roundCurrency` in server.js.
 */

const SLAB_TYPES = Object.freeze(["FLAT_AMOUNT", "PERCENTAGE"]);
const SLAB_PAYMENT_MODES = Object.freeze(["ALL", "CASH", "UPI", "CARD"]);
const LOT_DISCOUNT_TYPES = Object.freeze(["FIXED_AMOUNT", "PERCENTAGE", "SPECIAL_RATE"]);
const LOT_DISCOUNT_STATUSES = Object.freeze(["RUNNING", "UPCOMING", "ENDED", "STOPPED"]);

/** Tolerance, in rupees, for "the client's bill discount is the server's". */
const BILL_DISCOUNT_TOLERANCE = 0.01;

const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

/** A finite number, or null. Blank text is null, not 0. */
const finiteOrNull = (value) => {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const isBlank = (value) => value === null || value === undefined || (typeof value === "string" && value.trim() === "");

/** An id as an opaque string. `"004"` and `4` are different ids. */
const canonicalId = (value) => (value === null || value === undefined ? "" : String(value).trim());
const idsEqual = (left, right) => canonicalId(left) !== "" && canonicalId(left) === canonicalId(right);

/**
 * Order two ids without `Number()`. Two digit strings with no leading zero are ordered by length
 * and then text, which is numeric order ("9" < "10"). Anything else is ordered as text. Used only
 * to break a tie, so the answer must be stable, not meaningful.
 */
const compareIds = (left, right) => {
  const a = canonicalId(left);
  const b = canonicalId(right);
  const plain = (text) => /^(0|[1-9]\d*)$/.test(text);
  if (plain(a) && plain(b) && a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

/**
 * A date as `YYYY-MM-DD`, or null. A `Date` (node-postgres hands DATE columns back as local
 * midnight) is read in local time, like `toDateKey` in server.js.
 */
const dateKey = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const pad = (number) => String(number).padStart(2, "0");
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  const match = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
};

const formatRupees = (value) => {
  const number = roundMoney(value);
  const text = number.toLocaleString("en-IN", {
    minimumFractionDigits: Number.isInteger(number) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `₹${text}`;
};

// ---------------------------------------------------------------------------------------------
// Bill slabs
// ---------------------------------------------------------------------------------------------

const normalizeSlabPaymentMode = (value) => {
  const text = String(value ?? "").trim().toUpperCase();
  return text === "" ? "ALL" : text;
};

/** The slab's upper limit, or null for "no upper limit" (null, blank or 0). */
const slabUpperLimit = (rule) => {
  const maximum = finiteOrNull(rule?.maximum_bill_amount);
  return maximum === null || maximum === 0 ? null : maximum;
};

const slabLowerLimit = (rule) => finiteOrNull(rule?.minimum_bill_amount) ?? 0;

/** A rule mode of ALL (or blank) meets every bill; otherwise the modes must be equal. */
const slabPaymentModeMatches = (ruleMode, billMode) => {
  const rule = normalizeSlabPaymentMode(ruleMode);
  return rule === "ALL" || rule === String(billMode ?? "").trim().toUpperCase();
};

/** Two slab payment modes that can both match one bill. */
const slabPaymentModesMeet = (left, right) => {
  const a = normalizeSlabPaymentMode(left);
  const b = normalizeSlabPaymentMode(right);
  return a === "ALL" || b === "ALL" || a === b;
};

const slabMatchesGross = (rule, gross) => {
  const amount = finiteOrNull(gross);
  if (amount === null) return false;
  const upper = slabUpperLimit(rule);
  return slabLowerLimit(rule) <= amount && (upper === null || amount <= upper);
};

/**
 * What a slab takes off a bill, before the cap. FLAT_AMOUNT is its value; PERCENTAGE is a share of
 * the gross (the bill before item discounts). 2 dp.
 */
const slabRawAmount = (rule, gross) => {
  const value = finiteOrNull(rule?.discount_value);
  const base = finiteOrNull(gross);
  if (value === null || value <= 0 || base === null || base <= 0) return 0;
  const type = String(rule?.discount_type || "").toUpperCase();
  return type === "PERCENTAGE" ? roundMoney((base * value) / 100) : roundMoney(value);
};

/**
 * The bill discount a slab gives: its raw amount capped at the subtotal after item discounts and
 * never below 0. With no subtotal to hand, capped at the gross.
 */
const billSlabAmount = (rule, gross, subtotalAfterItems) => {
  if (!rule) return 0;
  const raw = slabRawAmount(rule, gross);
  const capSource = finiteOrNull(subtotalAfterItems);
  const cap = capSource === null ? finiteOrNull(gross) ?? 0 : capSource;
  return roundMoney(Math.max(0, Math.min(raw, cap)));
};

const slabsEnabled = (settings) => settings?.bill_level_slab_discount_enabled !== false;

/**
 * The one slab a bill gets, or null. Only when slabs are switched on, only active slabs, only a
 * slab whose payment mode meets the bill's and whose range holds the gross. Several match: the
 * largest raw amount wins; a tie goes to the highest id.
 */
const matchBillSlab = (rules, gross, paymentMode, { enabled = true } = {}) => {
  if (!enabled) return null;
  let best = null;
  let bestAmount = -1;
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!rule || rule.active === false) continue;
    if (!slabPaymentModeMatches(rule.payment_mode, paymentMode)) continue;
    if (!slabMatchesGross(rule, gross)) continue;
    const amount = slabRawAmount(rule, gross);
    if (amount > bestAmount || (amount === bestAmount && compareIds(rule.id, best?.id) > 0)) {
      best = rule;
      bestAmount = amount;
    }
  }
  return best;
};

/** "Bills ₹1,000 – ₹1,999" or "Bills ₹1,000 and above". */
const describeSlabRange = (rule) => {
  const upper = slabUpperLimit(rule);
  const lower = formatRupees(slabLowerLimit(rule));
  return upper === null ? `Bills ${lower} and above` : `Bills ${lower} – ${formatRupees(upper)}`;
};

const describeSlab = (rule) => cleanName(rule?.rule_name) || describeSlabRange(rule);

const cleanName = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * A slab from a request body, checked. Returns `{ rule }` or `{ error }`.
 *
 * value > 0; PERCENTAGE <= 100; minimum >= 0 (blank is 0); maximum blank, 0 (both "no upper
 * limit", stored as null) or above the minimum. A blank name is made from the range.
 */
const validateSlabInput = (body) => {
  const input = body || {};
  const type = String(input.discount_type ?? "FLAT_AMOUNT").trim().toUpperCase();
  const paymentMode = normalizeSlabPaymentMode(input.payment_mode);
  const minimum = isBlank(input.minimum_bill_amount) ? 0 : finiteOrNull(input.minimum_bill_amount);
  const maximumRaw = isBlank(input.maximum_bill_amount) ? null : finiteOrNull(input.maximum_bill_amount);
  const value = finiteOrNull(input.discount_value);

  if (!SLAB_TYPES.includes(type)) return { error: "Choose ₹ off or % off." };
  if (!SLAB_PAYMENT_MODES.includes(paymentMode)) return { error: "Choose a payment mode: Any, Cash, UPI or Card." };
  if (minimum === null || minimum < 0) return { error: "Enter the lowest bill amount, ₹0 or more." };
  if (!isBlank(input.maximum_bill_amount) && (maximumRaw === null || maximumRaw < 0)) {
    return { error: "Enter the highest bill amount, or leave it blank for no upper limit." };
  }
  const maximum = maximumRaw === null || maximumRaw === 0 ? null : roundMoney(maximumRaw);
  if (maximum !== null && maximum <= roundMoney(minimum)) {
    return { error: "The highest bill amount must be above the lowest, or blank." };
  }
  if (value === null || value <= 0) return { error: "Enter a discount above 0." };
  if (type === "PERCENTAGE" && value > 100) return { error: "A percentage discount cannot be more than 100%." };

  const rule = {
    minimum_bill_amount: roundMoney(minimum),
    maximum_bill_amount: maximum,
    discount_type: type,
    discount_value: roundMoney(value),
    payment_mode: paymentMode,
    active: input.active !== false,
  };
  rule.rule_name = (cleanName(input.rule_name) || describeSlabRange(rule)).slice(0, 140);
  return { rule };
};

/** Two slabs that could both match one bill: payment modes meet and the ranges share a rupee. */
const slabsOverlap = (left, right) => {
  if (!left || !right) return false;
  if (!slabPaymentModesMeet(left.payment_mode, right.payment_mode)) return false;
  const leftUpper = slabUpperLimit(left) ?? Infinity;
  const rightUpper = slabUpperLimit(right) ?? Infinity;
  return slabLowerLimit(left) <= rightUpper && slabLowerLimit(right) <= leftUpper;
};

/**
 * The active slab a candidate clashes with, or null. An inactive candidate clashes with nothing
 * (it matches no bill); `excludeId` is the slab being edited.
 */
const findSlabOverlap = (candidate, rules, { excludeId = null } = {}) => {
  if (!candidate || candidate.active === false) return null;
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!rule || rule.active === false) continue;
    if (excludeId !== null && idsEqual(rule.id, excludeId)) continue;
    if (slabsOverlap(candidate, rule)) return rule;
  }
  return null;
};

const slabOverlapRefusal = (clash) => ({
  code: "SLAB_OVERLAP",
  message: `Overlaps '${describeSlab(clash)}'. Change the range.`,
  overlapping_rule_id: clash?.id ?? null,
});

// ---------------------------------------------------------------------------------------------
// Bill discount on a sale
// ---------------------------------------------------------------------------------------------

/**
 * The rule snapshot a sale stores (`sales.discount_rule_*`), from the fields a POS sends, or null
 * when it sent none. The id is the server's own integer and is kept only when it reads as one.
 */
const readDiscountRuleSnapshot = (source) => {
  const input = source || {};
  const nested = input.discount_rule && typeof input.discount_rule === "object" ? input.discount_rule : {};
  const pick = (flat, inner) => (isBlank(input[flat]) ? nested[inner] : input[flat]);
  const idText = canonicalId(pick("discount_rule_id", "id"));
  const name = cleanName(pick("discount_rule_name", "rule_name"));
  const typeText = String(pick("discount_rule_type", "discount_type") ?? "").trim().toUpperCase();
  const value = finiteOrNull(pick("discount_rule_value", "discount_value"));
  const modeText = String(pick("discount_rule_payment_mode", "payment_mode") ?? "").trim().toUpperCase();
  // Kept as text: the column is INTEGER and Postgres casts it. Only a plain positive integer that
  // fits the column is kept; anything else (a device-made id, "004") is not the server's slab.
  const fitsInteger = /^[1-9]\d{0,9}$/.test(idText) && (idText.length < 10 || idText <= "2147483647");
  const id = fitsInteger ? idText : null;
  if (id === null && !name && !typeText && value === null && !modeText) return null;
  return {
    id,
    rule_name: name ? name.slice(0, 140) : null,
    discount_type: SLAB_TYPES.includes(typeText) ? typeText : null,
    discount_value: value !== null && value >= 0 ? roundMoney(value) : 0,
    payment_mode: modeText ? modeText.slice(0, 20) : null,
  };
};

const hasRuleClaim = (snapshot) => Boolean(snapshot && (snapshot.id !== null || snapshot.rule_name));

/**
 * A bill discount as billed: rounded to 2 dp, 0 <= x <= subtotal after item discounts. Within a
 * paisa over the subtotal is the subtotal (a desktop keeps 3 dp); further over is refused.
 * Returns `{ amount }` or `{ error }`.
 */
const boundBillDiscount = (requested, subtotalAfterItems) => {
  const value = isBlank(requested) ? 0 : finiteOrNull(requested);
  if (value === null || value < 0) return { error: "Enter a valid invoice discount" };
  const subtotal = Math.max(0, roundMoney(finiteOrNull(subtotalAfterItems) ?? 0));
  const amount = roundMoney(value);
  if (amount > subtotal + BILL_DISCOUNT_TOLERANCE) return { error: "Invoice discount cannot exceed the cart subtotal" };
  return { amount: Math.min(amount, subtotal) };
};

/**
 * A cashier's own bill discount, as a sale payload carries it (`manual_bill_discount`, 1 Oct 2026).
 *
 *   absent      (undefined, null, blank)  -> `{ present: false, amount: 0 }`: an older POS, which has
 *               no such box. Every path then behaves exactly as it did before the field existed.
 *   readable    a number >= 0             -> `{ present: true, amount }`, 2 dp.
 *   unreadable  text, negative, NaN       -> `{ present: true, amount: null, unreadable: true }`.
 *               Never read as "no discount".
 */
const readManualBillDiscount = (value) => {
  if (isBlank(value)) return { present: false, amount: 0, unreadable: false };
  const number = finiteOrNull(value);
  if (number === null || number < 0) return { present: true, amount: null, unreadable: true };
  return { present: true, amount: roundMoney(number), unreadable: false };
};

/** Appended to a slab's name on a bill that also carries a cashier's own bill discount. */
const EXTRA_DISCOUNT_SUFFIX = " + extra";
/** `sales.discount_rule_name` is VARCHAR(140). */
const RULE_NAME_MAX = 140;

/**
 * The rule snapshot a bill stores when its bill discount is a slab plus a cashier's own amount:
 * the slab's name with " + extra", so the stored row never claims the whole amount was the slab.
 * A slab row with no name is named by its range; a device snapshot with no name is "Bill slab".
 */
const withExtraDiscountName = (rule) => {
  if (!rule) return null;
  const hasRange = Object.prototype.hasOwnProperty.call(rule, "minimum_bill_amount");
  const name = cleanName(rule.rule_name) || (hasRange ? describeSlabRange(rule) : "Bill slab");
  return { ...rule, rule_name: `${name.slice(0, RULE_NAME_MAX - EXTRA_DISCOUNT_SUFFIX.length)}${EXTRA_DISCOUNT_SUFFIX}` };
};

/**
 * The rule a bill stores given how its bill discount splits. No cashier's part: the slab's rule as
 * it is. A cashier's part and a slab part: the slab with " + extra". A cashier's part only: none.
 */
const billDiscountRule = (rule, slabAmount, manualAmount) => {
  if (!rule) return null;
  if (!(manualAmount > 0)) return rule;
  return slabAmount > BILL_DISCOUNT_TOLERANCE ? withExtraDiscountName(rule) : null;
};

/**
 * The bill discount a sale records, and the rule snapshot stored with it.
 *
 *   SLAB       browser checkout. The server's current slabs decide. When one matches and the
 *              client's amount differs by more than a paisa, or the client claims a slab and none
 *              matches, the answer is DISCOUNT_RULES_CHANGED with the amount the server expects.
 *              With no slab and no claim, the client's amount stands (a manual bill discount).
 *   AS_BILLED  a bill already handed to a customer (desktop sync) or an edit. The amount billed,
 *              bounded; the rule snapshot the caller passes (`snapshot`), else none.
 *
 * `manualBill` is the payload's `manual_bill_discount`. Absent, the above is all, unchanged; the
 * result is `{ amount, rule }`. Present (`resolveWithManualBill`), the cashier's own part is
 * separated from the slab's and the result also carries `slabAmount` and `manualBill`.
 *
 * Returns `{ amount, rule }` or `{ error: { status, code?, message, ... } }`.
 */
const resolveInvoiceDiscount = ({
  mode = "SLAB",
  requested,
  gross,
  subtotalAfterItems,
  paymentMode,
  rules = [],
  enabled = true,
  snapshot = null,
  manualBill,
} = {}) => {
  const bounded = boundBillDiscount(requested, subtotalAfterItems);
  if (bounded.error) return { error: { status: 400, message: bounded.error } };

  const manual = readManualBillDiscount(manualBill);
  if (manual.present) {
    return resolveWithManualBill({ mode, billed: bounded.amount, manual, gross, subtotalAfterItems, paymentMode, rules, enabled, snapshot });
  }

  if (mode === "AS_BILLED") {
    return { amount: bounded.amount, rule: bounded.amount > 0 && snapshot ? snapshot : null };
  }

  const rule = matchBillSlab(rules, gross, paymentMode, { enabled });
  const expected = rule ? billSlabAmount(rule, gross, subtotalAfterItems) : 0;
  const changed = rule
    ? Math.abs(bounded.amount - expected) > BILL_DISCOUNT_TOLERANCE
    : hasRuleClaim(snapshot) && bounded.amount > 0;
  if (changed) {
    return {
      error: {
        status: 409,
        code: "DISCOUNT_RULES_CHANGED",
        expected_invoice_discount: expected,
        message: "Bill discount rules changed. POS has reloaded them - check the total and try again.",
      },
    };
  }
  if (rule) return { amount: expected, rule };
  return { amount: bounded.amount, rule: null };
};

/**
 * The cashier's part of a browser bill discount that came without `manual_bill_discount`: what the
 * invoice discount gives beyond the server's slab for this bill, max(0, round2(bounded invoice
 * discount - slab amount)). 0 when the invoice discount cannot be bounded (that bill is refused by
 * `resolveInvoiceDiscount` anyway). Only for the 5% check; the amount stored is still decided by
 * `resolveInvoiceDiscount`.
 */
const impliedManualBillDiscount = ({ requested, gross, subtotalAfterItems, paymentMode, rules = [], enabled = true } = {}) => {
  const bounded = boundBillDiscount(requested, subtotalAfterItems);
  if (bounded.error) return 0;
  const rule = matchBillSlab(rules, gross, paymentMode, { enabled });
  const slabAmount = rule ? billSlabAmount(rule, gross, subtotalAfterItems) : 0;
  return roundMoney(Math.max(0, bounded.amount - slabAmount));
};

const rulesChangedRefusal = (expected, extra = {}) => ({
  error: {
    status: 409,
    code: "DISCOUNT_RULES_CHANGED",
    expected_invoice_discount: expected,
    ...extra,
    message: "Bill discount rules changed. POS has reloaded them - check the total and try again.",
  },
});

/**
 * `resolveInvoiceDiscount` for a payload that carries `manual_bill_discount`.
 *
 *   SLAB       expected = round2(server's slab amount + manual). An unreadable manual amount is
 *              400; expected past the subtotal (by over a paisa) is 400 BILL_DISCOUNT_TOO_LARGE with
 *              `max_manual_bill_discount`. Then the client's invoice discount must be expected,
 *              within a paisa, or 409 DISCOUNT_RULES_CHANGED with `expected_invoice_discount` (and
 *              `expected_slab_discount`, the slab's part alone). The amount stored is expected,
 *              capped at the subtotal.
 *   AS_BILLED  never refused for the manual part (the customer has the bill). The amount billed,
 *              bounded as always; the manual part is the cashier's figure capped at that amount, the
 *              slab part is the rest. An unreadable manual part is `manualBill: null` and the
 *              snapshot is kept as the device sent it.
 *
 * The rule stored follows `billDiscountRule`: " + extra" when both parts, none when manual only.
 */
const resolveWithManualBill = ({ mode, billed, manual, gross, subtotalAfterItems, paymentMode, rules, enabled, snapshot }) => {
  if (mode === "AS_BILLED") {
    if (manual.unreadable) {
      return { amount: billed, rule: billed > 0 && snapshot ? snapshot : null, slabAmount: null, manualBill: null };
    }
    const manualPart = roundMoney(Math.min(manual.amount, billed));
    const slabPart = roundMoney(billed - manualPart);
    const rule = billed > 0 ? billDiscountRule(snapshot, slabPart, manualPart) : null;
    return { amount: billed, rule, slabAmount: slabPart, manualBill: manualPart };
  }

  if (manual.unreadable) return { error: { status: 400, message: "Enter a valid bill discount" } };
  const rule = matchBillSlab(rules, gross, paymentMode, { enabled });
  const slabAmount = rule ? billSlabAmount(rule, gross, subtotalAfterItems) : 0;
  const expected = roundMoney(slabAmount + manual.amount);
  // The slab plus the cashier's part may not pass the subtotal. Said as such (with the most the
  // cashier may give), not as "rules changed" with an amount larger than the bill.
  const subtotal = Math.max(0, roundMoney(finiteOrNull(subtotalAfterItems) ?? 0));
  if (expected > subtotal + BILL_DISCOUNT_TOLERANCE) {
    return {
      error: {
        status: 400,
        code: "BILL_DISCOUNT_TOO_LARGE",
        max_manual_bill_discount: roundMoney(Math.max(0, subtotal - slabAmount)),
        message: "Bill discount cannot be more than the bill after its slab discount",
      },
    };
  }
  if (Math.abs(billed - expected) > BILL_DISCOUNT_TOLERANCE) {
    return rulesChangedRefusal(expected, { expected_slab_discount: slabAmount });
  }
  const amount = roundMoney(Math.min(expected, subtotal));
  const manualPart = roundMoney(Math.max(0, amount - slabAmount));
  return { amount, rule: billDiscountRule(rule, slabAmount, manualPart), slabAmount, manualBill: manualPart };
};

/** The `sales.discount_rule_*` values for a stored rule (a slab row or a snapshot), in column order. */
const discountRuleColumns = (rule) => [
  rule?.id ?? null,
  rule?.rule_name || null,
  rule?.discount_type || null,
  finiteOrNull(rule?.discount_value) ?? 0,
  rule?.payment_mode || null,
];

/**
 * The rule an edit stores: the one the request names, else the sale's own when the bill discount
 * did not change, else none (the editor typed a different discount; no slab gave it).
 */
const editDiscountRule = ({ requestSnapshot, currentSale, invoiceDiscountAmount }) => {
  if (!(finiteOrNull(invoiceDiscountAmount) > 0)) return null;
  if (requestSnapshot) return requestSnapshot;
  const previous = finiteOrNull(currentSale?.invoice_discount_amount);
  if (previous === null || Math.abs(roundMoney(previous) - roundMoney(invoiceDiscountAmount)) > 0.005) return null;
  return readDiscountRuleSnapshot(currentSale);
};

// ---------------------------------------------------------------------------------------------
// Lot discounts
// ---------------------------------------------------------------------------------------------

/**
 * Where a lot discount stands on a day. STOPPED (switched off), UPCOMING (starts later), ENDED
 * (end date passed), else RUNNING. Start and end are inclusive.
 */
const lotDiscountStatus = (discount, today) => {
  if (!discount || discount.active === false) return "STOPPED";
  const day = dateKey(today);
  const start = dateKey(discount.start_date);
  const end = dateKey(discount.end_date);
  if (day && start && start > day) return "UPCOMING";
  if (day && end && end < day) return "ENDED";
  return "RUNNING";
};

const isRunningOrUpcoming = (discount, today) => {
  const status = lotDiscountStatus(discount, today);
  return status === "RUNNING" || status === "UPCOMING";
};

/**
 * The lot discount POS applies to a lot on a day: running on that day, highest id wins. Ids and
 * lots compared as opaque strings.
 */
const activeLotDiscount = (discounts, lotId, day) => {
  let best = null;
  for (const discount of Array.isArray(discounts) ? discounts : []) {
    if (!discount || !idsEqual(discount.inventory_batch_id, lotId)) continue;
    if (lotDiscountStatus(discount, day) !== "RUNNING") continue;
    if (!best || compareIds(discount.id, best.id) > 0) best = discount;
  }
  return best;
};

/**
 * What one unit costs after a lot discount, and what it takes off. PERCENTAGE round2(rate×v/100);
 * FIXED_AMOUNT min(v, rate); SPECIAL_RATE sells at v. Null when the rate or discount is unusable.
 */
const lotDiscountPerUnit = (discount, rate) => {
  const price = finiteOrNull(rate);
  const value = finiteOrNull(discount?.discount_value);
  const type = String(discount?.discount_type || "").toUpperCase();
  if (price === null || price <= 0 || value === null || value <= 0) return null;
  if (type === "SPECIAL_RATE") return { sellingRate: roundMoney(value), perUnitDiscount: 0 };
  if (type === "PERCENTAGE") return { sellingRate: roundMoney(price), perUnitDiscount: roundMoney((price * value) / 100) };
  if (type === "FIXED_AMOUNT") return { sellingRate: roundMoney(price), perUnitDiscount: roundMoney(Math.min(value, price)) };
  return null;
};

/** The line a lot discount produces: rate, per-unit discount and line discount (2 dp). */
const expectedLotDiscount = (discount, rate, quantity) => {
  const perUnit = lotDiscountPerUnit(discount, rate);
  const qty = finiteOrNull(quantity);
  if (!perUnit || qty === null || qty <= 0) return null;
  return { ...perUnit, lineDiscount: roundMoney(perUnit.perUnitDiscount * qty) };
};

/**
 * A lot discount from a request body, checked against the price POS charges for that lot.
 * `currentRate` is the lot's own rate when above 0, else the product rate (`effectiveLotRate`).
 * Returns `{ error }` or `{ type, value, startDate, endDate, warning }`.
 */
const validateLotDiscountInput = ({ type, value, currentRate, cost = null, startDate, endDate, lotLabel = "this lot" } = {}) => {
  const kind = String(type || "").trim().toUpperCase();
  if (!LOT_DISCOUNT_TYPES.includes(kind)) return { error: "Choose ₹ off per unit, % off or a fixed price." };
  const amount = finiteOrNull(value);
  if (amount === null || amount <= 0) {
    return { error: kind === "SPECIAL_RATE" ? "Enter the price per unit, above ₹0." : "Enter a discount above 0." };
  }
  if (kind === "PERCENTAGE" && amount > 100) return { error: "A percentage discount cannot be more than 100%." };
  const rate = finiteOrNull(currentRate);
  if (rate === null || rate <= 0) {
    return { error: `${lotLabel} has no selling rate. Set one on Sale Rates first.` };
  }
  const rounded = roundMoney(amount);
  if (kind === "FIXED_AMOUNT" && rounded >= roundMoney(rate)) {
    return { error: `${formatRupees(rounded)} off is not below ${lotLabel}'s price of ${formatRupees(rate)}. That would give the fruit away.` };
  }
  if (kind === "SPECIAL_RATE" && rounded >= roundMoney(rate)) {
    return { error: `${formatRupees(rounded)} is not below ${lotLabel}'s price of ${formatRupees(rate)}. That is not a discount.` };
  }
  const start = isBlank(startDate) ? null : dateKey(startDate);
  const end = isBlank(endDate) ? null : dateKey(endDate);
  if (!isBlank(startDate) && !start) return { error: "Enter a valid start date." };
  if (!isBlank(endDate) && !end) return { error: "Enter a valid end date." };
  if (start && end && end < start) return { error: "The end date cannot be before the start date." };

  const perUnit = lotDiscountPerUnit({ discount_type: kind, discount_value: rounded }, rate);
  const customerPays = perUnit ? roundMoney(perUnit.sellingRate - perUnit.perUnitDiscount) : null;
  const costRate = finiteOrNull(cost);
  const warning = costRate !== null && costRate > 0 && customerPays !== null && customerPays < costRate
    ? `Below cost (${formatRupees(costRate)}).`
    : null;
  return { type: kind, value: rounded, startDate: start, endDate: end, warning };
};

/**
 * Whether a sale line's lot-discount claim is a discount the lot really has.
 *
 * `claim` is `{ id, type, value }` from the line; `discounts` are the lot's `lot_discounts` rows
 * (already scoped to the branch). A claim holds when a row has the same id, lot, product, type
 * and value (as money) and is running on `day` -- or, for an edit, when the sale being edited
 * already carried that same discount (`priorClaims`), since a discount stopped since the sale does
 * not make the sale wrong. Returns the row, or null.
 */
const verifyLotDiscountClaim = ({ claim, discounts, lotId, productId, day, priorClaims = [] }) => {
  if (!claim || canonicalId(claim.id) === "" || !lotId) return null;
  const type = String(claim.type || "").trim().toUpperCase();
  const value = finiteOrNull(claim.value);
  if (!LOT_DISCOUNT_TYPES.includes(type) || value === null) return null;
  const sameShape = (id, rowType, rowValue) => (
    idsEqual(id, claim.id)
    && String(rowType ?? "").toUpperCase() === type
    && finiteOrNull(rowValue) !== null
    && roundMoney(rowValue) === roundMoney(value)
  );
  // A prior claim is a `sale_items` row: its own `id` is the line's, the discount is lot_discount_*.
  const carried = (row) => (Array.isArray(priorClaims) ? priorClaims : []).some((prior) => (
    sameShape(prior?.lot_discount_id, prior?.lot_discount_type, prior?.lot_discount_value)
    && (prior?.product_id === undefined || prior?.product_id === null || idsEqual(prior.product_id, row.product_id))
  ));
  for (const row of Array.isArray(discounts) ? discounts : []) {
    if (!sameShape(row?.id, row?.discount_type, row?.discount_value)) continue;
    if (!idsEqual(row.inventory_batch_id, lotId)) continue;
    if (productId !== undefined && productId !== null && !idsEqual(row.product_id, productId)) continue;
    if (lotDiscountStatus(row, day) === "RUNNING") return row;
    if (carried(row)) return row;
  }
  return null;
};

/**
 * The lot discount a recorded bill line names, if the lot really has (or had) one of that shape:
 * the same id, type and value, on that lot and product, whatever its status today. Used only to
 * tell a desktop bill's lot discount apart from a cashier's own discount when the bill syncs --
 * a discount stopped between billing and sync was still the lot's discount when the customer got
 * it. Unlike `verifyLotDiscountClaim` it grants nothing (no rate, no permission); it only decides
 * how much of the line's discount is not the cashier's. Returns the row, or null.
 */
const lotDiscountOfRecord = ({ claim, discounts, lotId, productId }) => {
  if (!claim || canonicalId(claim.id) === "" || !lotId) return null;
  const type = String(claim.type || "").trim().toUpperCase();
  const value = finiteOrNull(claim.value);
  if (!LOT_DISCOUNT_TYPES.includes(type) || value === null) return null;
  for (const row of Array.isArray(discounts) ? discounts : []) {
    if (!row || !idsEqual(row.id, claim.id) || !idsEqual(row.inventory_batch_id, lotId)) continue;
    if (productId !== undefined && productId !== null && !idsEqual(row.product_id, productId)) continue;
    if (String(row.discount_type ?? "").toUpperCase() !== type) continue;
    if (finiteOrNull(row.discount_value) === null || roundMoney(row.discount_value) !== roundMoney(value)) continue;
    return row;
  }
  return null;
};

// ---------------------------------------------------------------------------------------------
// A cashier's own item discount (owner's rule, 30 Sep 2026)
// ---------------------------------------------------------------------------------------------

/**
 * Up to this share of a line, a cashier may take off on their own. Above it, an Owner or Admin
 * types their password on the counter first (`POST /api/v3/sale-change-approvals`, action
 * "discount"). The same rule, to the paisa, is in `frontend/src/local/discounts.js`.
 */
const MANUAL_DISCOUNT_FREE_PERCENT = 5;
/** Headroom on the free limit, in rupees: a paisa of rounding is not a discount. */
const MANUAL_DISCOUNT_TOLERANCE = 0.01;
/** Whoever holds this may already set any rate, so a discount needs no approval from them. */
const MANUAL_DISCOUNT_EXEMPT_PERMISSION = "manual_pos_rate_override";
const MANUAL_DISCOUNT_EXEMPT_ROLES = Object.freeze(["Owner", "Admin"]);

/**
 * How much of a line's discount the lot gave. SPECIAL_RATE gives nothing here -- its discount is
 * the price itself, already in `rate`. PERCENTAGE and FIXED_AMOUNT give what they give at this
 * rate and quantity (`expectedLotDiscount`). No lot discount, or one that cannot be priced, is 0.
 */
const lotDiscountPart = (lotDiscount, rate, quantity) => {
  if (!lotDiscount) return 0;
  if (String(lotDiscount.discount_type || "").trim().toUpperCase() === "SPECIAL_RATE") return 0;
  const expected = expectedLotDiscount(lotDiscount, rate, quantity);
  return expected ? expected.lineDiscount : 0;
};

/**
 * One line against the 5% rule.
 *
 *   lotPart    = the line's lot discount (0 for none and for SPECIAL_RATE)
 *   manualPart = max(0, round2(discount_amount - lotPart))           -- the cashier's own
 *   base       = round2(round2(qty x rate) - lotPart)                 -- rate is the special price
 *                                                                        on a SPECIAL_RATE line
 *   freeLimit  = round2(base x 5 / 100)
 *   needsApproval when manualPart > round2(freeLimit + 0.01)
 *
 * A line whose quantity or rate cannot be read is not waved through as "no discount": if it carries
 * any discount at all it needs approval (`unreadable: true`).
 */
const manualDiscountLine = ({ quantity, rate, discountAmount, lotDiscount = null } = {}) => {
  const qty = finiteOrNull(quantity);
  const price = finiteOrNull(rate);
  const discount = isBlank(discountAmount) ? 0 : finiteOrNull(discountAmount);
  if (qty === null || price === null || discount === null) {
    return { lotPart: 0, manualPart: discount ?? 0, base: null, freeLimit: 0, needsApproval: discount === null || discount > 0, unreadable: true };
  }
  const lotPart = lotDiscountPart(lotDiscount, price, qty);
  const manualPart = Math.max(0, roundMoney(discount - lotPart));
  const base = roundMoney(roundMoney(qty * price) - lotPart);
  const freeLimit = Math.max(0, roundMoney((base * MANUAL_DISCOUNT_FREE_PERCENT) / 100));
  const needsApproval = manualPart > roundMoney(freeLimit + MANUAL_DISCOUNT_TOLERANCE);
  return { lotPart, manualPart, base, freeLimit, needsApproval, unreadable: false };
};

/**
 * Every line of a bill against the 5% rule. The bill needs approval when any line does; a small
 * discount on one line never lends headroom to another.
 */
const assessManualDiscounts = (lines) => {
  const assessed = (Array.isArray(lines) ? lines : []).map((line) => ({ ...line, ...manualDiscountLine(line) }));
  return {
    needsApproval: assessed.some((line) => line.needsApproval),
    lines: assessed,
    manualDiscountTotal: roundMoney(assessed.reduce((sum, line) => sum + line.manualPart, 0)),
  };
};

/**
 * The bill against the 5% rule, with a cashier's own bill discount (`manualBill`, the payload's
 * `manual_bill_discount`) on top of the lines (owner's rule, 1 Oct 2026).
 *
 *   - Every line is held to the per-line rule exactly as `assessManualDiscounts` does.
 *   - When `manualBill` > 0, the bill as a whole is held to 5% too:
 *       base        = round2(sum of line bases)                 -- line base as `manualDiscountLine`
 *       manualTotal = round2(sum of line manual parts + manualBill)
 *       freeLimit   = round2(base x 5 / 100)
 *       needsApproval when manualTotal > round2(freeLimit + 0.01)
 *     So a cashier may give up to 5% in all, on the lines or on the bill, however they spread it.
 *   - With `manualBill` 0 or blank the bill-level test is not applied: the per-line rule already
 *     holds the bill to 5% (give or take a paisa a line), and a bill with no bill discount must
 *     answer exactly as it did before this rule existed.
 *   - An unreadable `manualBill` (text, negative) needs approval; so does a positive one on a bill
 *     with a line that cannot be read (its base is unknown).
 *
 * Returns the `assessManualDiscounts` shape -- `{ needsApproval, lines, manualDiscountTotal }`,
 * where `manualDiscountTotal` now includes the bill part -- plus `lineManualDiscountTotal` and
 * `bill: { manualBill, base, freeLimit, manualTotal, needsApproval, unreadable }`.
 */
const assessBillManualDiscount = ({ lines, manualBill = 0 } = {}) => {
  const items = assessManualDiscounts(lines);
  const read = isBlank(manualBill) ? 0 : finiteOrNull(manualBill);
  const unreadable = read === null || read < 0;
  const billPart = unreadable ? 0 : roundMoney(read);
  const bases = items.lines.map((line) => line.base);
  const base = bases.every((value) => value !== null) ? roundMoney(bases.reduce((sum, value) => sum + value, 0)) : null;
  const freeLimit = base === null ? 0 : Math.max(0, roundMoney((base * MANUAL_DISCOUNT_FREE_PERCENT) / 100));
  const manualTotal = roundMoney(items.manualDiscountTotal + billPart);
  const billNeedsApproval = unreadable
    || (billPart > 0 && (base === null || manualTotal > roundMoney(freeLimit + MANUAL_DISCOUNT_TOLERANCE)));
  return {
    needsApproval: items.needsApproval || billNeedsApproval,
    lines: items.lines,
    lineManualDiscountTotal: items.manualDiscountTotal,
    manualDiscountTotal: manualTotal,
    bill: {
      manualBill: unreadable ? null : billPart,
      base,
      freeLimit,
      manualTotal,
      needsApproval: billNeedsApproval,
      unreadable,
    },
  };
};

/**
 * Who never needs approval for a discount: an Owner or Admin, or anyone whose role holds
 * `manual_pos_rate_override` (they can already set any rate). `actor` is a database row
 * (`role_name`, `permissions`), never a token claim. No actor is not exempt.
 */
const manualDiscountExempt = (actor) => {
  if (!actor) return false;
  const role = typeof actor.role_name === "string" ? actor.role_name.trim() : "";
  if (MANUAL_DISCOUNT_EXEMPT_ROLES.includes(role)) return true;
  const permissions = actor.permissions && typeof actor.permissions === "object" ? actor.permissions : {};
  return permissions[MANUAL_DISCOUNT_EXEMPT_PERMISSION] === true;
};

/**
 * The lines that broke the rule, as stored with the bill's audit row. Money at 2 dp. An
 * assessment from `assessBillManualDiscount` also carries the bill part (`bill`), whether or not
 * it was the bill part that broke the rule; one from `assessManualDiscounts` has no `bill` key.
 */
const manualDiscountTrace = (assessment) => ({
  free_percent: MANUAL_DISCOUNT_FREE_PERCENT,
  manual_discount_total: assessment?.manualDiscountTotal ?? null,
  lines: (assessment?.lines || []).filter((line) => line.needsApproval).map((line) => ({
    product_id: line.productId ?? null,
    inventory_batch_id: line.inventoryBatchId ?? null,
    quantity: finiteOrNull(line.quantity),
    rate: finiteOrNull(line.rate),
    discount_amount: finiteOrNull(line.discountAmount),
    lot_part: line.lotPart,
    manual_part: line.manualPart,
    free_limit: line.freeLimit,
    unreadable: line.unreadable === true,
  })),
  ...(assessment?.bill
    ? {
      bill: {
        manual_bill_discount: assessment.bill.manualBill,
        line_manual_total: assessment.lineManualDiscountTotal ?? null,
        manual_total: assessment.bill.manualTotal,
        base: assessment.bill.base,
        free_limit: assessment.bill.freeLimit,
        needs_approval: assessment.bill.needsApproval === true,
        unreadable: assessment.bill.unreadable === true,
      },
    }
    : {}),
});

const discountChangedRefusal = (productName) => ({
  status: 409,
  code: "DISCOUNT_CHANGED",
  message: `A discount on ${productName || "an item"} has changed. POS has reloaded discounts - check the bill and try again.`,
});

// ---------------------------------------------------------------------------------------------
// Discount Report
// ---------------------------------------------------------------------------------------------

/**
 * The Discount Report rows (Report Center), for `$1` date from, `$2` date to, `$3` branch.
 * Kept here, not inline in server.js, so `discounts.test.js` runs it against a real Postgres
 * (PGlite) and not a regex.
 *
 * Columns: sale_date, invoice_no, payment_mode, bill_discount_rule_name, product_name, unit,
 * lot_name, lot_size, discount_type, discount_value (the lot discount), quantity_sold,
 * gross_amount, item_discount_amount (line + special-rate difference), bill_discount_share,
 * discount_amount (= item + bill share), net_amount (= gross - discount), profit_impact.
 */
const DISCOUNT_REPORT_SQL = `
  -- One row per bill line per lot it was drawn from. Every amount is scaled by that lot's
  -- share of the line's quantity: a line drawn from two lots used to be counted in full on
  -- both rows. Each line also carries its share of the bill discount (prorated on the line's
  -- net, as sale_items.profit is), in its own column and in discount_amount, so a bill with
  -- only a slab discount no longer reads as a blank type and 0. gross - discount = net.
  WITH report_sales AS (
    SELECT s.id, s.sale_date, s.invoice_no, s.payment_mode, s.discount_rule_name,
           COALESCE(s.invoice_discount_amount, 0) AS invoice_discount_amount
    FROM sales s
    WHERE s.sale_status <> 'CANCELLED' AND s.branch_id = $3
      AND s.sale_date BETWEEN $1 AND $2
  ),
  sale_subtotals AS (
    SELECT si.sale_id,
           SUM(COALESCE(si.net_amount, si.amount - COALESCE(si.discount_amount, 0))) AS subtotal
    FROM sale_items si
    JOIN report_sales rs ON rs.id = si.sale_id
    GROUP BY si.sale_id
  ),
  report_lines AS (
    SELECT
      rs.sale_date,
      rs.invoice_no,
      rs.payment_mode,
      rs.discount_rule_name,
      p.product_name,
      p.unit,
      COALESCE(ib.lot_name, ib.batch_no, '') AS lot_name,
      ib.lot_size,
      si.lot_discount_type,
      si.lot_discount_value,
      CASE WHEN si.quantity > 0 THEN COALESCE(sba.quantity, si.quantity) / si.quantity ELSE 1 END AS lot_share,
      si.quantity,
      CASE
        WHEN si.lot_discount_type = 'SPECIAL_RATE'
        THEN si.quantity * COALESCE(si.default_selling_rate, si.selling_rate)
        ELSE si.amount
      END AS line_gross,
      COALESCE(si.discount_amount, 0) +
      CASE
        WHEN si.lot_discount_type = 'SPECIAL_RATE'
        THEN GREATEST((COALESCE(si.default_selling_rate, si.selling_rate) - si.selling_rate) * si.quantity, 0)
        ELSE 0
      END AS line_item_discount,
      COALESCE(si.net_amount, si.amount - COALESCE(si.discount_amount, 0)) AS line_net,
      CASE
        WHEN COALESCE(st.subtotal, 0) > 0
        THEN rs.invoice_discount_amount * COALESCE(si.net_amount, si.amount - COALESCE(si.discount_amount, 0)) / st.subtotal
        ELSE 0
      END AS line_bill_discount,
      COALESCE(si.profit, 0) AS line_profit
    FROM report_sales rs
    JOIN sale_items si ON si.sale_id = rs.id
    JOIN products p ON p.id = si.product_id
    LEFT JOIN sale_subtotals st ON st.sale_id = rs.id
    LEFT JOIN sale_batch_allocations sba ON sba.sale_item_id = si.id
    LEFT JOIN inventory_batches ib ON ib.id = sba.inventory_batch_id
    WHERE COALESCE(si.discount_amount, 0) > 0
      OR si.lot_discount_id IS NOT NULL
      OR rs.invoice_discount_amount > 0
  )
  SELECT
    sale_date,
    invoice_no,
    payment_mode,
    discount_rule_name AS bill_discount_rule_name,
    product_name,
    unit,
    lot_name,
    lot_size,
    lot_discount_type AS discount_type,
    lot_discount_value AS discount_value,
    ROUND(SUM(quantity * lot_share)::NUMERIC, 3) AS quantity_sold,
    ROUND(SUM(line_gross * lot_share)::NUMERIC, 2) AS gross_amount,
    ROUND(SUM(line_item_discount * lot_share)::NUMERIC, 2) AS item_discount_amount,
    ROUND(SUM(line_bill_discount * lot_share)::NUMERIC, 2) AS bill_discount_share,
    ROUND(SUM((line_item_discount + line_bill_discount) * lot_share)::NUMERIC, 2) AS discount_amount,
    ROUND(SUM((line_net - line_bill_discount) * lot_share)::NUMERIC, 2) AS net_amount,
    ROUND(SUM(line_profit * lot_share)::NUMERIC, 2) AS profit_impact
  FROM report_lines
  GROUP BY
    sale_date, invoice_no, payment_mode, discount_rule_name, product_name, unit,
    lot_name, lot_size, lot_discount_type, lot_discount_value
  ORDER BY sale_date DESC, product_name, lot_name
`;

module.exports = {
  BILL_DISCOUNT_TOLERANCE,
  DISCOUNT_REPORT_SQL,
  EXTRA_DISCOUNT_SUFFIX,
  LOT_DISCOUNT_STATUSES,
  LOT_DISCOUNT_TYPES,
  MANUAL_DISCOUNT_EXEMPT_PERMISSION,
  MANUAL_DISCOUNT_EXEMPT_ROLES,
  MANUAL_DISCOUNT_FREE_PERCENT,
  MANUAL_DISCOUNT_TOLERANCE,
  SLAB_PAYMENT_MODES,
  SLAB_TYPES,
  activeLotDiscount,
  assessBillManualDiscount,
  assessManualDiscounts,
  billDiscountRule,
  impliedManualBillDiscount,
  readManualBillDiscount,
  withExtraDiscountName,
  lotDiscountOfRecord,
  lotDiscountPart,
  manualDiscountExempt,
  manualDiscountLine,
  manualDiscountTrace,
  billSlabAmount,
  boundBillDiscount,
  canonicalId,
  compareIds,
  dateKey,
  describeSlab,
  describeSlabRange,
  discountChangedRefusal,
  discountRuleColumns,
  editDiscountRule,
  expectedLotDiscount,
  findSlabOverlap,
  finiteOrNull,
  hasRuleClaim,
  idsEqual,
  isRunningOrUpcoming,
  lotDiscountPerUnit,
  lotDiscountStatus,
  matchBillSlab,
  readDiscountRuleSnapshot,
  resolveInvoiceDiscount,
  roundMoney,
  slabOverlapRefusal,
  slabPaymentModeMatches,
  slabRawAmount,
  slabUpperLimit,
  slabsEnabled,
  slabsOverlap,
  validateLotDiscountInput,
  validateSlabInput,
  verifyLotDiscountClaim,
};
