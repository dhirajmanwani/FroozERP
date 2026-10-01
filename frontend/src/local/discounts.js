import { labelFor } from "./displayLabels.js";
import { finiteOrNull } from "./productMaster.js";
import { canonicalInventoryId, inventoryIdsEqual } from "./stockInventory.js";

/**
 * Discounts: money off a lot at the counter, and money off a bill by its total.
 *
 * ## Why this is not in App.jsx any more
 *
 * POS, the Discounts screen and the server each had their own idea of what a discount is:
 *
 *   - POS picked the highest-id running discount on a lot; the screen showed the first row of a
 *     list ordered by start date and ignored the start date, so a future discount showed as
 *     current and a back-dated newer one was given at the till but not shown.
 *   - POS matched a bill slab with `!maximum_bill_amount` (0 means "no limit") and the server with
 *     `IS NULL`; they broke ties differently and POS did not round a percentage. A bill in the gap
 *     was priced one way at the till and refused as "Payment amounts must match" at the server.
 *   - A blank amount saved as ₹0, which priced a "Fixed price" lot at nothing; 150% off was taken.
 *
 * Everything here is a pure function of the rows the server sent and what was typed, and
 * `backend/discounts.js` implements the same rules (the shared contract), so the till and the
 * server cannot disagree about a price. Each rule is pinned by `discounts.test.mjs`.
 *
 * Ids are opaque: they are compared with `inventoryIdsEqual`, never `Number()`, so `"004"` and `4`
 * stay two different lots.
 */

export const MISSING = "—";

/** Lot discount kinds. FIXED_AMOUNT is money off *each unit* (per kg), not off the line. */
export const LOT_DISCOUNT_TYPES = Object.freeze(["FIXED_AMOUNT", "PERCENTAGE", "SPECIAL_RATE"]);
/** Bill-total discount kinds. */
export const BILL_DISCOUNT_TYPES = Object.freeze(["FLAT_AMOUNT", "PERCENTAGE"]);
/** Payment modes a bill-total discount can be limited to (backend DISCOUNT_PAYMENT_MODES). */
export const BILL_DISCOUNT_PAYMENT_MODES = Object.freeze(["ALL", "CASH", "UPI", "CARD"]);

export const LOT_DISCOUNT_STATUS = Object.freeze({
  RUNNING: "RUNNING",
  UPCOMING: "UPCOMING",
  ENDED: "ENDED",
  STOPPED: "STOPPED",
});

/** Money to 2 dp, half away from zero (the server's `roundCurrency` for every positive amount). */
export const roundMoney = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const sign = number < 0 ? -1 : 1;
  return (sign * Math.round((Math.abs(number) + Number.EPSILON) * 100)) / 100;
};

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

/** "YYYY-MM-DD" for a date key, an ISO text or a Date (local day). "" when there is none. */
export const toDateKey = (value) => {
  if (value === null || value === undefined || value === "") return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toLocaleDateString("en-CA");
  const key = String(value).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : "";
};

/**
 * Order two ids without turning them into numbers. Plain digit ids (no leading zero) order by
 * length first, so "10" comes after "9" the way the database issued them; anything else ("004")
 * compares as text. The same rule as `compareIds` in backend/discounts.js.
 */
export const compareIds = (left, right) => {
  const a = canonicalInventoryId(left);
  const b = canonicalInventoryId(right);
  const plain = (value) => /^(0|[1-9]\d*)$/.test(value);
  if (plain(a) && plain(b) && a.length !== b.length) return a.length - b.length;
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

/** Rupees as the shop says them: "₹10", "₹10.50", "₹1,250". */
export const formatRupees = (value) => {
  const number = finiteOrNull(value);
  if (number === null) return MISSING;
  const rounded = roundMoney(number);
  const whole = Number.isInteger(rounded);
  return `₹${rounded.toLocaleString("en-IN", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
};

const formatPercent = (value) => {
  const number = finiteOrNull(value);
  if (number === null) return MISSING;
  return `${Math.round(number * 100) / 100}%`;
};

/** The unit word in "per kg": the product's unit, lower case, or "unit" when it has none. */
export const unitWord = (unit) => {
  const code = text(unit).toUpperCase();
  if (!code) return "unit";
  return { KG: "kg", PIECE: "piece", BOX: "box", DOZEN: "dozen" }[code] || code.toLowerCase();
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2 Oct", or "2 Oct 2027" when not this year. "—" for no date. */
export const formatShortDate = (value, today = "") => {
  const key = toDateKey(value);
  if (!key) return MISSING;
  const [year, month, day] = key.split("-");
  const thisYear = toDateKey(today).slice(0, 4);
  return `${Number.parseInt(day, 10)} ${MONTHS[Number.parseInt(month, 10) - 1]}${thisYear && thisYear !== year ? ` ${year}` : ""}`;
};

// ---------------------------------------------------------------------------------------------
// Lots
// ---------------------------------------------------------------------------------------------

/**
 * Today's selling rate for a lot: its own temporary rate when above zero, else the product rate.
 * The same rule POS and Sale Rate Update use. Null when neither is a price.
 */
export const lotCurrentRate = (lot, product = null) => {
  const own = finiteOrNull(lot?.temporary_sale_rate);
  if (own !== null && own > 0) return own;
  const productRate = finiteOrNull(product?.selling_rate ?? lot?.selling_rate);
  return productRate !== null && productRate > 0 ? productRate : null;
};

/**
 * What a unit of the lot cost. `effective_cost_per_unit` first, the purchase rate second -- with
 * explicit finite checks, because `??` would stop on a legitimate 0 and `||` would skip it. Null
 * when neither is a positive number: an unknown cost is not ₹0.
 */
export const lotCost = (lot) => {
  const effective = finiteOrNull(lot?.effective_cost_per_unit);
  if (effective !== null && effective > 0) return effective;
  const purchase = finiteOrNull(lot?.purchase_rate);
  return purchase !== null && purchase > 0 ? purchase : null;
};

/** Stock left in a lot, or null when not known. */
export const lotStock = (lot) => {
  const remaining = finiteOrNull(lot?.remaining_qty);
  if (remaining !== null) return remaining;
  return finiteOrNull(lot?.balance_qty);
};

/** "Lot A · Large", "Lot 12" -- how a lot is named on this screen. */
export const lotLabel = (lot) => {
  const name = text(lot?.lot_name) || text(lot?.batch_no) || (text(lot?.id ?? lot?.inventory_batch_id) ? `Lot ${text(lot?.id ?? lot?.inventory_batch_id)}` : "");
  return [name, text(lot?.lot_size)].filter(Boolean).join(" · ") || MISSING;
};

/** Lots of one product that can still take a discount: not cancelled, with stock left. */
export const discountableLots = (lots, productId) => (Array.isArray(lots) ? lots : []).filter((lot) =>
  inventoryIdsEqual(lot?.product_id, productId)
  && text(lot?.batch_status).toUpperCase() !== "CANCELLED"
  && (lotStock(lot) ?? 0) > 0);

/** Products that have at least one discountable lot, by name. Built from the lots themselves. */
export const discountableProducts = (lots) => {
  const byId = new Map();
  for (const lot of Array.isArray(lots) ? lots : []) {
    const key = canonicalInventoryId(lot?.product_id);
    if (!key || text(lot?.batch_status).toUpperCase() === "CANCELLED" || !((lotStock(lot) ?? 0) > 0)) continue;
    const entry = byId.get(key) || { id: lot.product_id, name: text(lot.product_name) || MISSING, unit: text(lot.unit), lotCount: 0 };
    entry.lotCount += 1;
    byId.set(key, entry);
  }
  return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
};

// ---------------------------------------------------------------------------------------------
// Lot discounts
// ---------------------------------------------------------------------------------------------

/** Status by date: STOPPED (switched off), UPCOMING (starts later), ENDED (end passed), RUNNING. */
export const lotDiscountStatus = (discount, today) => {
  if (!discount || discount.active === false) return LOT_DISCOUNT_STATUS.STOPPED;
  const day = toDateKey(today);
  const start = toDateKey(discount.start_date);
  const end = toDateKey(discount.end_date);
  if (start && day && start > day) return LOT_DISCOUNT_STATUS.UPCOMING;
  if (end && day && end < day) return LOT_DISCOUNT_STATUS.ENDED;
  return LOT_DISCOUNT_STATUS.RUNNING;
};

/** The words on a row's badge: "Running", "Starts 2 Oct", "Ended", "Stopped". */
export const lotDiscountStatusText = (discount, today) => {
  const status = lotDiscountStatus(discount, today);
  if (status === LOT_DISCOUNT_STATUS.UPCOMING) return `Starts ${formatShortDate(discount.start_date, today)}`;
  return { RUNNING: "Running", ENDED: "Ended", STOPPED: "Stopped" }[status];
};

const newestFirst = (left, right) => compareIds(right?.id, left?.id);

/**
 * The discount POS gives on a lot for a bill dated `dateKey`: active, started, not ended. One per
 * lot is the rule (a new one replaces the old on the server); if two ever overlap, the newest id
 * wins, the same way on the till and on the server.
 */
export const activeLotDiscount = (discounts, lotId, dateKey) => {
  if (canonicalInventoryId(lotId) === "") return null;
  return (Array.isArray(discounts) ? discounts : [])
    .filter((discount) => inventoryIdsEqual(discount?.inventory_batch_id, lotId)
      && lotDiscountStatus(discount, dateKey) === LOT_DISCOUNT_STATUS.RUNNING)
    .sort(newestFirst)[0] || null;
};

/**
 * The discount the screen shows against a lot: the running one, or else the next upcoming one.
 * This is what a new discount on that lot replaces.
 */
export const currentLotDiscount = (discounts, lotId, today) => {
  const running = activeLotDiscount(discounts, lotId, today);
  if (running) return running;
  return (Array.isArray(discounts) ? discounts : [])
    .filter((discount) => inventoryIdsEqual(discount?.inventory_batch_id, lotId)
      && lotDiscountStatus(discount, today) === LOT_DISCOUNT_STATUS.UPCOMING)
    .sort((left, right) => toDateKey(left.start_date).localeCompare(toDateKey(right.start_date)) || newestFirst(left, right))[0] || null;
};

/**
 * A lot discount applied to a rate and a quantity. SPECIAL_RATE replaces the price; PERCENTAGE
 * and FIXED_AMOUNT take money off each unit (FIXED never below zero). The line discount is the
 * per-unit amount times the quantity, rounded to 2 dp.
 */
export const applyLotDiscount = (baseRate, quantity, discount) => {
  const rate = finiteOrNull(baseRate) ?? 0;
  const qty = finiteOrNull(quantity) ?? 0;
  if (!discount) return { sellingRate: rate, discountAmount: 0, discountPerUnit: 0 };
  const value = finiteOrNull(discount.discount_value) ?? 0;
  const type = text(discount.discount_type).toUpperCase();
  if (type === "SPECIAL_RATE") return { sellingRate: value, discountAmount: 0, discountPerUnit: 0 };
  const discountPerUnit = type === "PERCENTAGE" ? roundMoney((rate * value) / 100) : Math.min(value, rate);
  return { sellingRate: rate, discountAmount: roundMoney(discountPerUnit * qty), discountPerUnit };
};

/** The price per unit the customer pays under a discount, or null when the rate is unknown. */
export const discountedUnitPrice = (rate, discount) => {
  const base = finiteOrNull(rate);
  if (!discount) return base;
  if (text(discount.discount_type).toUpperCase() === "SPECIAL_RATE") return finiteOrNull(discount.discount_value);
  if (base === null) return null;
  const applied = applyLotDiscount(base, 1, discount);
  return roundMoney(Math.max(base - applied.discountPerUnit, 0));
};

/** "₹10 off per kg" / "10% off" / "₹90 per kg". */
export const describeLotOffer = (discount, unit) => {
  if (!discount) return MISSING;
  const type = text(discount.discount_type).toUpperCase();
  const value = discount.discount_value;
  if (type === "PERCENTAGE") return `${formatPercent(value)} off`;
  if (type === "SPECIAL_RATE") return `${formatRupees(value)} per ${unitWord(unit)}`;
  if (type === "FIXED_AMOUNT") return `${formatRupees(value)} off per ${unitWord(unit)}`;
  return MISSING;
};

const LOT_OFFER_LABELS = { FIXED_AMOUNT: "₹ off per", PERCENTAGE: "% off", SPECIAL_RATE: "Fixed price per" };
/** The three offer buttons: "₹ off per kg", "% off", "Fixed price per kg". */
export const lotOfferChoices = (unit) => LOT_DISCOUNT_TYPES.map((type) => ({
  type,
  label: type === "PERCENTAGE" ? LOT_OFFER_LABELS[type] : `${LOT_OFFER_LABELS[type]} ${unitWord(unit)}`,
  suffix: type === "PERCENTAGE" ? "%" : "₹",
}));

/**
 * Checks a typed lot discount against one lot. Refusals keep the form open with the reason;
 * warnings (below cost) are shown and still savable.
 *
 *   - amount > 0 always (a blank box is not ₹0 -- ₹0 "Fixed price" gave the fruit away)
 *   - % at most 100
 *   - ₹ off per unit below today's price, and a fixed price below today's price
 *   - end on or after start, and not already over
 */
export const validateLotDiscountDraft = ({ type, value, currentRate, cost = null, startDate = "", endDate = "", today = "", unit = "" } = {}) => {
  const errors = [];
  const warnings = [];
  const kind = text(type).toUpperCase();
  const amount = finiteOrNull(value);
  const rate = finiteOrNull(currentRate);
  const basis = finiteOrNull(cost);
  const per = unitWord(unit);
  if (!LOT_DISCOUNT_TYPES.includes(kind)) errors.push("Choose what kind of offer this is.");
  if (text(value) === "") errors.push("Enter the amount.");
  else if (amount === null || amount <= 0) errors.push("The amount must be more than 0.");
  else if (kind === "PERCENTAGE" && amount > 100) errors.push("A discount cannot be more than 100%.");
  if (errors.length === 0) {
    if (rate === null || rate <= 0) {
      errors.push("This lot has no selling rate yet. Set one in Sale Rate Update first.");
    } else if (kind === "FIXED_AMOUNT" && amount >= rate) {
      errors.push(`${formatRupees(amount)} off is the whole price (${formatRupees(rate)} per ${per}) or more.`);
    } else if (kind === "SPECIAL_RATE" && amount >= rate) {
      errors.push(`${formatRupees(amount)} is not below today's price of ${formatRupees(rate)} per ${per}, so it is not a discount.`);
    }
  }
  const start = toDateKey(startDate);
  const end = toDateKey(endDate);
  if (start && end && end < start) errors.push("The end date is before the start date.");
  else if (end && toDateKey(today) && end < toDateKey(today)) errors.push("The end date has already passed.");
  if (errors.length === 0 && basis !== null && rate !== null) {
    const pays = discountedUnitPrice(rate, { discount_type: kind, discount_value: amount });
    if (pays !== null && pays < basis) warnings.push(`Below cost (${formatRupees(basis)} per ${per}).`);
  }
  return { errors, warnings };
};

/**
 * The `POST /lot-discounts` body. Ids go through untouched; no identity is sent (the server takes
 * who did it from the signed session). A blank end date means "until stopped".
 */
export const buildLotDiscountPayload = ({ productId, lotIds = [], type, value, startDate, endDate = "", remarks = "" } = {}) => ({
  product_id: productId,
  inventory_batch_ids: [...lotIds],
  discount_type: text(type).toUpperCase(),
  discount_value: roundMoney(finiteOrNull(value) ?? 0),
  start_date: toDateKey(startDate),
  end_date: toDateKey(endDate) || null,
  active: true,
  remarks: text(remarks),
});

const STATUS_ORDER = { RUNNING: 0, UPCOMING: 1, ENDED: 2, STOPPED: 3 };

/**
 * The rows of the "Discounts" table. Running and upcoming by default; ended and stopped only when
 * asked (`hiddenCount` says how many are behind the link). Prices come from the lot the screen
 * loaded when it has it, else from the discount row; an unknown price is null, never 0.
 */
export const buildDiscountRows = (discounts, lots = [], { today = "", showEnded = false } = {}) => {
  const all = (Array.isArray(discounts) ? discounts : []).map((discount) => {
    const lot = (Array.isArray(lots) ? lots : []).find((item) => inventoryIdsEqual(item?.id, discount?.inventory_batch_id)) || null;
    const status = lotDiscountStatus(discount, today);
    const fromRow = finiteOrNull(discount?.current_sale_rate);
    const rate = lot ? lotCurrentRate(lot) : (fromRow !== null && fromRow > 0 ? fromRow : null);
    const unit = text(discount?.unit) || text(lot?.unit);
    const stock = lot ? lotStock(lot) : finiteOrNull(discount?.remaining_qty);
    return {
      key: canonicalInventoryId(discount?.id),
      id: discount?.id,
      discount,
      status,
      productName: text(discount?.product_name) || text(lot?.product_name) || MISSING,
      lotLabel: lotLabel({ ...(lot || {}), ...discount, id: discount?.inventory_batch_id }),
      offer: describeLotOffer(discount, unit),
      unit: unitWord(unit),
      currentRate: rate,
      customerPays: discountedUnitPrice(rate, discount),
      startDate: toDateKey(discount?.start_date),
      endDate: toDateKey(discount?.end_date),
      soldOut: stock !== null && stock <= 0,
      canStop: status === LOT_DISCOUNT_STATUS.RUNNING || status === LOT_DISCOUNT_STATUS.UPCOMING,
    };
  }).sort((left, right) => (STATUS_ORDER[left.status] - STATUS_ORDER[right.status])
    || left.productName.localeCompare(right.productName)
    || left.lotLabel.localeCompare(right.lotLabel)
    || compareIds(right.id, left.id));
  const shown = showEnded ? all : all.filter((row) => row.canStop);
  return { rows: shown, hiddenCount: all.length - all.filter((row) => row.canStop).length };
};

/**
 * Brings the cart's lot discounts in line with a fresh discount list, for a bill dated `dateKey`.
 *
 * A line whose lot discount changed (stopped, replaced, a new one started) is re-priced from its
 * default rate; a line that never had one is only given a new one when nobody typed a rate or a
 * discount on it, so a manual price is never overwritten. A line marked `keep_price` (billed from
 * an order at its agreed price) is never touched. Returns the new cart and the names of
 * the lines that changed, for the note POS shows.
 */
export const reconcileCartLotDiscounts = (cart, discounts, dateKey) => {
  const changed = [];
  const next = (Array.isArray(cart) ? cart : []).map((item) => {
    if (canonicalInventoryId(item?.inventory_batch_id) === "" || item.keep_price === true) return item;
    const base = finiteOrNull(item.default_selling_rate);
    if (base === null) return item;
    const fresh = activeLotDiscount(discounts, item.inventory_batch_id, dateKey);
    const hadOne = canonicalInventoryId(item.lot_discount_id) !== "" || text(item.lot_discount_type) !== "";
    const same = hadOne && fresh
      && inventoryIdsEqual(item.lot_discount_id, fresh.id)
      && text(item.lot_discount_type).toUpperCase() === text(fresh.discount_type).toUpperCase()
      && roundMoney(item.lot_discount_value) === roundMoney(fresh.discount_value);
    if (same || (!hadOne && !fresh)) return item;
    if (!hadOne) {
      const manualRate = roundMoney(item.selling_rate) !== roundMoney(base);
      const manualDiscount = (finiteOrNull(item.discount_amount) ?? 0) !== 0;
      if (manualRate || manualDiscount) return item;
    }
    const quantity = finiteOrNull(item.quantity) ?? 0;
    const applied = applyLotDiscount(base, quantity, fresh);
    changed.push(text(item.product_name) || MISSING);
    return {
      ...item,
      selling_rate: applied.sellingRate,
      discount_amount: applied.discountAmount,
      lot_discount_id: fresh?.id ?? null,
      lot_discount_type: fresh?.discount_type ?? null,
      lot_discount_value: fresh ? roundMoney(fresh.discount_value) : 0,
      lot_discount_per_unit: applied.discountPerUnit,
    };
  });
  return { cart: changed.length ? next : cart, changed };
};

// ---------------------------------------------------------------------------------------------
// Discount on bill total (slabs)
// ---------------------------------------------------------------------------------------------

/** A slab's upper limit, or null for "no limit" (null, blank and 0 all mean no limit). */
export const slabMaximum = (rule) => {
  const maximum = finiteOrNull(rule?.maximum_bill_amount);
  return maximum === null || maximum === 0 ? null : maximum;
};

const slabMinimum = (rule) => finiteOrNull(rule?.minimum_bill_amount) ?? 0;

/** Payment modes meet when either is empty/"ALL" or they are the same (case ignored). */
export const paymentModesMeet = (left, right) => {
  const a = text(left).toUpperCase();
  const b = text(right).toUpperCase();
  return !a || !b || a === "ALL" || b === "ALL" || a === b;
};

/** Does this slab apply to a bill with this gross (before item discounts) and payment mode? */
export const slabMatches = (rule, gross, paymentMode) => {
  if (!rule || rule.active === false) return false;
  const total = finiteOrNull(gross);
  if (total === null || total <= 0) return false;
  const mode = text(rule.payment_mode).toUpperCase();
  if (mode && mode !== "ALL" && mode !== text(paymentMode).toUpperCase()) return false;
  const maximum = slabMaximum(rule);
  return slabMinimum(rule) <= total && (maximum === null || total <= maximum);
};

/** What a slab takes off before the cap: flat value, or gross × value / 100, 2 dp. */
export const slabRawAmount = (rule, gross) => {
  const value = finiteOrNull(rule?.discount_value);
  const base = finiteOrNull(gross);
  if (value === null || value <= 0 || base === null || base <= 0) return 0;
  return text(rule.discount_type).toUpperCase() === "PERCENTAGE" ? roundMoney((base * value) / 100) : roundMoney(value);
};

/**
 * The money a slab takes off: its raw amount, never more than the bill after item discounts and
 * never below 0.
 */
export const billSlabAmount = (rule, gross, subtotalAfterItems) => {
  if (!rule) return 0;
  const cap = Math.max(finiteOrNull(subtotalAfterItems) ?? 0, 0);
  return roundMoney(Math.max(Math.min(slabRawAmount(rule, gross), cap), 0));
};

/**
 * The bill-total discount for a bill: only when switched on; of the slabs that match, the one
 * with the largest raw amount wins, and a tie goes to the newest id (backend `matchBillSlab`).
 */
export const matchBillSlab = (rules, { gross, subtotalAfterItems, paymentMode, enabled = true } = {}) => {
  if (!enabled) return { rule: null, amount: 0 };
  let best = null;
  let bestRaw = -1;
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!slabMatches(rule, gross, paymentMode)) continue;
    const raw = slabRawAmount(rule, gross);
    if (raw > bestRaw || (raw === bestRaw && compareIds(rule.id, best?.id) > 0)) {
      best = rule;
      bestRaw = raw;
    }
  }
  return best ? { rule: best, amount: billSlabAmount(best, gross, subtotalAfterItems) } : { rule: null, amount: 0 };
};

/**
 * The bill total slabs are measured on: each line's quantity × its rate, rounded to 2 dp, summed.
 * A SPECIAL_RATE line's rate is already the special price. The server adds up the same way.
 */
export const billGross = (cart) => roundMoney((Array.isArray(cart) ? cart : [])
  .reduce((sum, item) => sum + roundMoney((finiteOrNull(item?.quantity) ?? 0) * (finiteOrNull(item?.selling_rate) ?? 0)), 0));

/**
 * The payment mode a bill is matched on, as the server reads it from the payments: one payment is
 * its own mode; several are "MIXED" (only an "any payment" slab matches); none is "CASH". POS's
 * Mixed choice with a single amount filled in is that one mode.
 */
export const slabPaymentMode = (paymentMode, mixedAmounts = {}) => {
  const mode = text(paymentMode).toUpperCase();
  if (mode !== "MIXED") return mode || "CASH";
  const paid = Object.entries(mixedAmounts || {}).filter(([, amount]) => (finiteOrNull(amount) ?? 0) > 0);
  if (paid.length === 0) return "CASH";
  return paid.length === 1 ? text(paid[0][0]).toUpperCase() : "MIXED";
};

/** "Bills ₹1,000 – ₹1,999" or "Bills ₹2,000 and above". */
export const describeSlabRange = (rule) => {
  const minimum = slabMinimum(rule);
  const maximum = slabMaximum(rule);
  if (maximum === null) return `Bills ${formatRupees(minimum)} and above`;
  return `Bills ${formatRupees(minimum)} – ${formatRupees(maximum)}`;
};

/** "₹50 off" / "2% off". */
export const describeSlabOffer = (rule) => text(rule?.discount_type).toUpperCase() === "PERCENTAGE"
  ? `${formatPercent(rule?.discount_value)} off`
  : `${formatRupees(rule?.discount_value)} off`;

/** "any payment" / "Cash only". */
export const describeSlabPayment = (rule) => {
  const mode = text(rule?.payment_mode).toUpperCase();
  if (!mode || mode === "ALL") return "any payment";
  return `${labelFor("paymentMode", mode)} only`;
};

/** A slab as one sentence: "Bills ₹1,000 – ₹1,999 → 2% off · any payment". */
export const describeSlab = (rule) => `${describeSlabRange(rule)} → ${describeSlabOffer(rule)} · ${describeSlabPayment(rule)}`;

/** How a slab is named in a message: its own name, or its range. */
export const slabDisplayName = (rule) => text(rule?.rule_name) || describeSlabRange(rule);

/**
 * Checks a typed slab. Returns field -> message; empty when it can be saved.
 * value > 0; % at most 100; from at least 0; to blank or above from.
 */
export const validateSlabDraft = (draft = {}) => {
  const errors = {};
  const minimum = finiteOrNull(draft.minimum_bill_amount);
  const maximumText = text(draft.maximum_bill_amount);
  const maximum = finiteOrNull(draft.maximum_bill_amount);
  const value = finiteOrNull(draft.discount_value);
  const type = text(draft.discount_type).toUpperCase();
  // A blank From is ₹0, as the server reads it.
  if (text(draft.minimum_bill_amount) !== "" && (minimum === null || minimum < 0)) errors.minimum_bill_amount = "Enter the lowest bill total, 0 or more.";
  if (maximumText !== "" && (maximum === null || maximum < 0)) errors.maximum_bill_amount = "Enter an amount, or leave it blank for no upper limit.";
  else if (maximumText !== "" && maximum !== 0 && maximum <= (minimum ?? 0)) errors.maximum_bill_amount = "Must be more than the From amount.";
  if (!BILL_DISCOUNT_TYPES.includes(type)) errors.discount_type = "Choose ₹ or %.";
  if (text(draft.discount_value) === "") errors.discount_value = "Enter the discount.";
  else if (value === null || value <= 0) errors.discount_value = "The discount must be more than 0.";
  else if (type === "PERCENTAGE" && value > 100) errors.discount_value = "A discount cannot be more than 100%.";
  if (!BILL_DISCOUNT_PAYMENT_MODES.includes(text(draft.payment_mode || "ALL").toUpperCase())) errors.payment_mode = "Choose a payment mode.";
  return errors;
};

/**
 * The first active slab (other than `ignoreId`) whose range meets the draft's range for a payment
 * mode that can meet it. Ranges include both ends, because a bill of exactly that total would
 * match both.
 */
export const findSlabOverlap = (draft, rules, { ignoreId = null } = {}) => {
  // A slab that is switched off matches no bill, so it clashes with nothing.
  if (!draft || draft.active === false) return null;
  const minimum = slabMinimum(draft);
  const maximum = slabMaximum(draft);
  return (Array.isArray(rules) ? rules : []).find((rule) => {
    if (!rule || rule.active === false) return false;
    if (ignoreId !== null && ignoreId !== undefined && inventoryIdsEqual(rule.id, ignoreId)) return false;
    if (!paymentModesMeet(rule.payment_mode, draft.payment_mode)) return false;
    const otherMin = slabMinimum(rule);
    const otherMax = slabMaximum(rule);
    return (otherMax === null || minimum <= otherMax) && (maximum === null || otherMin <= maximum);
  }) || null;
};

/** "Overlaps 'Bills ₹1,000 – ₹1,999'. Change the range." -- the same words as the server's 409. */
export const describeSlabOverlap = (rule) => `Overlaps '${slabDisplayName(rule)}'. Change the range.`;

/**
 * The `POST/PUT /settings/discount-rules` body. A blank name is filled from the range, because the
 * name is what the printed bill shows beside the discount. No identity is sent.
 */
export const buildSlabPayload = (draft = {}) => {
  const maximumText = text(draft.maximum_bill_amount);
  const maximum = finiteOrNull(draft.maximum_bill_amount);
  const payload = {
    minimum_bill_amount: roundMoney(finiteOrNull(draft.minimum_bill_amount) ?? 0),
    maximum_bill_amount: maximumText === "" || maximum === null || maximum === 0 ? null : roundMoney(maximum),
    discount_type: text(draft.discount_type).toUpperCase(),
    discount_value: roundMoney(finiteOrNull(draft.discount_value) ?? 0),
    payment_mode: text(draft.payment_mode || "ALL").toUpperCase(),
    active: true,
  };
  return { rule_name: text(draft.rule_name) || describeSlabRange(payload), ...payload };
};

/** The rule a bill carries with it, so a bill made offline keeps the discount it was given. */
export const slabSnapshot = (rule) => ({
  discount_rule_id: rule?.id ?? null,
  discount_rule_name: rule ? slabDisplayName(rule) : null,
  discount_rule_type: rule ? text(rule.discount_type).toUpperCase() || null : null,
  discount_rule_value: rule ? finiteOrNull(rule.discount_value) : null,
  discount_rule_payment_mode: rule ? text(rule.payment_mode).toUpperCase() || "ALL" : null,
});

/** What POS says under "Bill discount". */
export const describeBillDiscountPreview = ({ enabled = true, rule = null } = {}) => {
  if (!enabled) return "Bill discounts are off";
  if (!rule) return "No bill-total discount for this bill";
  return slabDisplayName(rule);
};

// ---------------------------------------------------------------------------------------------
// Availability and server answers
// ---------------------------------------------------------------------------------------------

/**
 * Why discounts cannot be changed here right now, or null when they can. Discounts live on the
 * server; in Local Only, offline, or on a desktop with no cloud, nothing is loaded or sent, and the
 * screen says so instead of looking editable.
 */
export const resolveDiscountAvailability = ({ localOnly = false, offline = false, noCloud = false } = {}) => {
  if (localOnly) {
    return "This computer is in Local Only mode. Discounts are kept on the server, so they cannot be loaded or changed here until Local Only is turned off. POS keeps giving the discounts it already has.";
  }
  if (noCloud) {
    return "This computer is not connected to a cloud server. Discounts are kept on the server, so they cannot be loaded or changed here. POS keeps giving the discounts it already has.";
  }
  if (offline) {
    return "This computer is offline. Discounts are kept on the server, so they cannot be loaded or changed until the connection is back. POS keeps giving the discounts it already has.";
  }
  return null;
};

export const DISCOUNT_CONFLICT_CODES = Object.freeze(["DISCOUNT_CHANGED", "DISCOUNT_RULES_CHANGED"]);

/**
 * A checkout refusal because discounts changed under the till, or null for any other answer.
 * The server's own sentence is shown; the fallback only covers an answer without one.
 */
export const readDiscountConflict = (status, data) => {
  if (Number(status) !== 409) return null;
  const code = text(data?.code).toUpperCase();
  if (!DISCOUNT_CONFLICT_CODES.includes(code)) return null;
  const fallback = code === "DISCOUNT_CHANGED"
    ? "A discount on this bill has changed. POS has reloaded discounts - check the bill and try again."
    : "Bill discount rules changed. POS has reloaded them - check the total and try again.";
  const expected = finiteOrNull(data?.expected_invoice_discount);
  return {
    code,
    message: text(data?.message) || fallback,
    expectedInvoiceDiscount: expected === null ? null : roundMoney(expected),
  };
};

/** What the owner is told after starting a discount. */
export const describeStartResult = (created, lotCount) => {
  const rows = Array.isArray(created) ? created : [];
  const count = rows.length || lotCount;
  const lots = count === 1 ? "1 lot" : `${count} lots`;
  const replaced = rows.reduce((sum, row) => sum + (Array.isArray(row?.replaced_discount_ids) ? row.replaced_discount_ids.length : 0), 0);
  const replacedText = replaced ? ` It replaced ${replaced === 1 ? "the discount" : `${replaced} discounts`} already on ${replaced === 1 ? "that lot" : "those lots"}.` : "";
  return `Discount started on ${lots}.${replacedText} Counters pick it up on their next sync.`;
};

// ---------------------------------------------------------------------------------------------
// Manual item discount: up to 5% without approval
// ---------------------------------------------------------------------------------------------

/**
 * The owner's rule (30 Sep 2026): a cashier may give up to 5% off an item on their own; more than
 * that needs an Owner or Admin to type their password at the counter. `backend/discounts.js`
 * keeps the same rule, so the till never bills something the server refuses, and the other way
 * round.
 *
 * Per line:
 *   - lotPart: what the line's lot discount takes off (0 when it has none; 0 for SPECIAL_RATE,
 *     because there the price itself is the special price),
 *   - manualPart = max(0, round2(discount_amount - lotPart)),
 *   - base = round2(qty x rate) - lotPart,
 *   - the line needs approval when manualPart > round2(base x 5 / 100) + 0.01.
 * A bill needs approval when any line does. Owner, Admin and anyone who may already set any rate
 * (`manual_pos_rate_override`) never need it.
 */
export const MANUAL_DISCOUNT_FREE_PERCENT = 5;
const MANUAL_DISCOUNT_TOLERANCE = 0.01;

/** The approval action `POST /api/v3/sale-change-approvals` takes for a discount. */
export const DISCOUNT_APPROVAL_ACTION = "discount";
/** The server's 403 code when a bill's discount needs an approval it does not have. */
export const DISCOUNT_APPROVAL_REQUIRED_CODE = "DISCOUNT_APPROVAL_REQUIRED";
/** The note beside the item discount, for someone who is not exempt. */
export const DISCOUNT_APPROVAL_NOTE = `Up to ${MANUAL_DISCOUNT_FREE_PERCENT}% without approval`;
/** Said when approval is needed and cannot happen here (offline, Local Only, no cloud). */
export const DISCOUNT_APPROVAL_OFFLINE_MESSAGE = "A discount over 5% needs an Owner or Admin's approval, which needs internet. Give up to 5%, or wait for the connection.";
/** Said by the server (and here, when it gives no sentence) when the approval is missing. */
export const DISCOUNT_APPROVAL_REQUIRED_MESSAGE = "A discount over 5% needs an Owner or Admin to approve it.";

const EXEMPT_ROLES = Object.freeze(["Owner", "Admin"]);
/**
 * Never asked: Owner, Admin, or someone holding `manual_pos_rate_override`. Anything else is asked.
 * The role is matched exactly (spaces trimmed), as the server's `manualDiscountExempt` does, so the
 * till never waves through a bill the server would refuse.
 */
export const discountApprovalExempt = ({ role, canManualRateOverride = false } = {}) => (
  EXEMPT_ROLES.includes(text(role)) || canManualRateOverride === true
);

/**
 * What a cart line's lot discount takes off the line, 2 dp -- the backend's `expectedLotDiscount`
 * on the line's rate. 0 when the line claims no lot discount, for SPECIAL_RATE, and when the rate,
 * value or quantity is not usable.
 */
export const lineLotDiscountPart = (line) => {
  const claimed = canonicalInventoryId(line?.lot_discount_id) !== "" || text(line?.lot_discount_type) !== "";
  if (!claimed) return 0;
  const type = text(line?.lot_discount_type).toUpperCase();
  const rate = finiteOrNull(line?.selling_rate);
  const value = finiteOrNull(line?.lot_discount_value);
  const quantity = finiteOrNull(line?.quantity);
  if (rate === null || rate <= 0 || value === null || value <= 0 || quantity === null || quantity <= 0) return 0;
  let perUnit = 0;
  if (type === "PERCENTAGE") perUnit = roundMoney((rate * value) / 100);
  else if (type === "FIXED_AMOUNT") perUnit = roundMoney(Math.min(value, rate));
  return roundMoney(perUnit * quantity);
};

/**
 * One line against the 5% rule -- `manualDiscountLine` in backend/discounts.js, to the paisa.
 * `percent` is the typed discount as a share of the line after its lot discount, or null when that
 * is not above 0 (a percentage of nothing is not 0%).
 *
 * A blank discount is no discount. A line whose quantity, rate or discount cannot be read is not
 * waved through: with any discount on it at all, it needs approval (`unreadable: true`).
 */
export const lineManualDiscount = (line) => {
  const quantity = finiteOrNull(line?.quantity);
  const rate = finiteOrNull(line?.selling_rate);
  const discount = text(line?.discount_amount) === "" ? 0 : finiteOrNull(line?.discount_amount);
  if (quantity === null || rate === null || discount === null) {
    return {
      lotPart: 0,
      base: null,
      manualPart: discount ?? 0,
      freeLimit: 0,
      percent: null,
      needsApproval: discount === null || discount > 0,
      unreadable: true,
    };
  }
  const lotPart = lineLotDiscountPart(line);
  const base = roundMoney(roundMoney(quantity * rate) - lotPart);
  const manualPart = Math.max(0, roundMoney(discount - lotPart));
  const freeLimit = Math.max(0, roundMoney((base * MANUAL_DISCOUNT_FREE_PERCENT) / 100));
  return {
    lotPart,
    base,
    manualPart,
    freeLimit,
    percent: base > 0 ? roundMoney((manualPart / base) * 100) : null,
    needsApproval: manualPart > roundMoney(freeLimit + MANUAL_DISCOUNT_TOLERANCE),
    unreadable: false,
  };
};

/**
 * Does this cart need an Owner or Admin's approval before it is billed? `lines` are the lines over
 * the limit, in cart order, for the dialog and the stored reason. An exempt user is never asked.
 */
export const cartDiscountApproval = (cart, { exempt = false } = {}) => {
  if (exempt === true) return { needed: false, lines: [] };
  const lines = [];
  for (const item of Array.isArray(cart) ? cart : []) {
    const check = lineManualDiscount(item);
    if (!check.needsApproval) continue;
    lines.push({
      lineId: item?.line_id ?? null,
      productName: text(item?.product_name) || MISSING,
      discount: check.manualPart,
      base: check.base,
      percent: check.percent,
    });
  }
  return { needed: lines.length > 0, lines };
};

/** "Apple 12.5% (₹50 of ₹400)", or "Apple ₹50 off" when the line has no value to measure against. */
export const describeDiscountApprovalLine = (line) => (line?.percent === null || line?.percent === undefined
  ? `${text(line?.productName) || MISSING} ${formatRupees(line?.discount)} off`
  : `${text(line?.productName) || MISSING} ${formatPercent(line.percent)} (${formatRupees(line.discount)} of ${formatRupees(line.base)})`);

const REASON_LIMIT = 500;
/** The reason the approval is stored with (the server takes at most 500 characters). */
export const describeDiscountApprovalReason = (lines) => {
  const parts = (Array.isArray(lines) ? lines : []).map(describeDiscountApprovalLine);
  const reason = `Item discount over ${MANUAL_DISCOUNT_FREE_PERCENT}%: ${parts.join("; ") || MISSING}`;
  return reason.length > REASON_LIMIT ? `${reason.slice(0, REASON_LIMIT - 1)}…` : reason;
};

export const DISCOUNT_APPROVAL_MODE = Object.freeze({ NONE: "NONE", CLOUD: "CLOUD", REFUSED: "REFUSED" });

/**
 * Which way a discount approval goes, decided before anything is billed or sent.
 *
 * `needsApproval` must be exactly `false` to skip, and `cloudGateAllowed` exactly `true` to reach
 * the cloud. Offline or Local Only refuses whatever the gate says, so Local Only never makes the
 * approval call. REFUSED means: do not bill, do not call, show `message`.
 */
export const resolveDiscountApprovalRoute = ({ needsApproval, offlineMode, localOnly, cloudGateAllowed } = {}) => {
  if (needsApproval === false) return { mode: DISCOUNT_APPROVAL_MODE.NONE };
  if (offlineMode || localOnly || cloudGateAllowed !== true) {
    return { mode: DISCOUNT_APPROVAL_MODE.REFUSED, message: DISCOUNT_APPROVAL_OFFLINE_MESSAGE };
  }
  return { mode: DISCOUNT_APPROVAL_MODE.CLOUD };
};

/** A checkout refusal because the discount needs approval, or null for any other answer. */
export const readDiscountApprovalRequired = (status, data) => {
  if (Number(status) !== 403) return null;
  if (text(data?.code).toUpperCase() !== DISCOUNT_APPROVAL_REQUIRED_CODE) return null;
  return { message: text(data?.message) || DISCOUNT_APPROVAL_REQUIRED_MESSAGE };
};

const CART_KEPT = "The bill is not saved yet; the cart is still here.";

/**
 * Approval answers whose own sentence is shown. These are plain sentences the approval route
 * writes for the counter (a wrong password says so in the server's words); anything else gets a
 * fixed line, so a stray technical message never reaches the counter screen.
 */
const DISCOUNT_APPROVAL_SERVER_CODES = Object.freeze([
  "APPROVER_CREDENTIALS_INVALID",
  "APPROVER_NOT_ALLOWED",
  "REQUESTER_NOT_ALLOWED",
  "APPROVAL_ATTEMPTS_LOCKED",
  "PASSWORD_RESET_REQUIRED",
  "APPROVAL_REQUEST_INVALID",
  "APPROVAL_NOT_NEEDED",
  DISCOUNT_APPROVAL_REQUIRED_CODE,
]);

const DISCOUNT_APPROVAL_FALLBACKS = Object.freeze({
  APPROVER_CREDENTIALS_INVALID: "The Owner or Admin username or password is wrong.",
  APPROVER_NOT_ALLOWED: "That person cannot approve this. Only an active Owner or Admin can.",
  REQUESTER_NOT_ALLOWED: "You are not allowed to ask for this approval.",
  APPROVAL_ATTEMPTS_LOCKED: "Too many wrong approval attempts. Wait 15 minutes and try again.",
  PASSWORD_RESET_REQUIRED: "The approver's password has to be reset before they can approve.",
  [DISCOUNT_APPROVAL_REQUIRED_CODE]: DISCOUNT_APPROVAL_REQUIRED_MESSAGE,
});

/**
 * One line for a failed discount approval, always ending with "the cart is still here". Known
 * approval codes show the server's own sentence (its fallback when it sent none); a request that
 * never reached the server says so; anything else is a generic line.
 */
export const describeDiscountApprovalError = (error) => {
  const data = error && typeof error === "object" ? (error.response?.data || error.data || null) : null;
  const code = text(data?.code || (error && typeof error === "object" ? error.code : "")).toUpperCase();
  if (code && DISCOUNT_APPROVAL_SERVER_CODES.includes(code)) {
    const sentence = text(data?.message) || DISCOUNT_APPROVAL_FALLBACKS[code] || "The approval was refused.";
    return `${sentence} ${CART_KEPT}`;
  }
  const axiosLike = error && typeof error === "object" && ("isAxiosError" in error || "request" in error);
  if (axiosLike && !error.response) return `The approval could not be checked because the server could not be reached. ${CART_KEPT}`;
  return `The approval could not be completed. ${CART_KEPT}`;
};

// ---------------------------------------------------------------------------------------------
// Manual bill discount: the cashier's own money off the whole bill, under the same 5% rule
// ---------------------------------------------------------------------------------------------

/**
 * The owner's rule (1 Oct 2026): "agar kal ko item pr nhi du aur poore total pr dedu" -- a cashier
 * may give the discount on the whole bill instead of on an item, in rupees or as a percentage, and
 * the 5% rule covers both together. `backend/discounts.js` keeps the same rule.
 *
 * Amounts, all 2 dp:
 *   itemsSubtotal = sum(line gross) - sum(line discounts)
 *   slabAmount    = the automatic bill-total discount (matchBillSlab), unchanged
 *   room          = itemsSubtotal - slabAmount           -- what the box can still take off
 *   manualBill    = typed rupees, or typed % of room
 *   invoice_discount = slabAmount + manualBill           -- the bill discount the bill records
 */
export const MANUAL_BILL_DISCOUNT_MODE = Object.freeze({ AMOUNT: "AMOUNT", PERCENT: "PERCENT" });
/** Appended to a slab's name on a bill that also has a manual bill discount (server snapshot). */
export const MANUAL_BILL_DISCOUNT_RULE_SUFFIX = " + extra";

/**
 * What the "Bill discount" box takes off, or why it cannot. A blank box is no discount (₹0, no
 * error). Anything that is not a number, below 0, over 100%, or more than the bill has left after
 * its other discounts is an error with `amount: null` -- never quietly ₹0, so POS can refuse to
 * bill it and say why.
 */
export const resolveManualBillDiscount = ({ mode = MANUAL_BILL_DISCOUNT_MODE.AMOUNT, value = "", itemsSubtotal = 0, slabAmount = 0 } = {}) => {
  const room = Math.max(0, roundMoney((finiteOrNull(itemsSubtotal) ?? 0) - (finiteOrNull(slabAmount) ?? 0)));
  const percentMode = text(mode).toUpperCase() === MANUAL_BILL_DISCOUNT_MODE.PERCENT;
  if (text(value) === "") return { amount: 0, percent: null, room, error: null };
  const typed = finiteOrNull(value);
  if (typed === null) return { amount: null, percent: null, room, error: "Enter the bill discount as a number." };
  if (typed < 0) return { amount: null, percent: null, room, error: "The bill discount cannot be less than 0." };
  if (percentMode && typed > 100) return { amount: null, percent: null, room, error: "A discount cannot be more than 100%." };
  const amount = percentMode ? roundMoney((room * typed) / 100) : roundMoney(typed);
  if (amount > room) {
    return { amount: null, percent: null, room, error: `The bill discount cannot be more than what is left of the bill (${formatRupees(room)}).` };
  }
  return { amount, percent: percentMode ? typed : null, room, error: null };
};

/**
 * The whole bill against the 5% rule, with the manual bill discount in it -- the `bill` part of
 * `assessBillManualDiscount` in backend/discounts.js, to the paisa:
 *
 *   base        = round2(sum of line bases)          -- null when any line cannot be read
 *   manualTotal = round2(sum of line manual parts + manualBill)
 *   freeLimit   = max(0, round2(base x 5 / 100))
 *   needs approval when manualBill > 0 and manualTotal > round2(freeLimit + 0.01)
 *
 * So a cashier can give up to 5% in all, on items or on the bill, however they like. The per-line
 * rule still applies on its own (`cartDiscountApproval`). With no bill discount (0 or blank) this
 * asks nothing, so a bill billed without the box is judged exactly as before. A bill discount that
 * cannot be read (`unreadable`), or a positive one on a bill with a line that cannot be measured,
 * is not waved through.
 */
export const assessBillManualDiscount = ({ lines = [], manualBill = 0 } = {}) => {
  const read = text(manualBill) === "" ? 0 : finiteOrNull(manualBill);
  const unreadable = read === null || read < 0;
  const billPart = unreadable ? 0 : roundMoney(read);
  const assessed = (Array.isArray(lines) ? lines : []).map(lineManualDiscount);
  const lineManual = roundMoney(assessed.reduce((sum, line) => sum + line.manualPart, 0));
  const base = assessed.every((line) => line.base !== null)
    ? roundMoney(assessed.reduce((sum, line) => sum + line.base, 0))
    : null;
  const freeLimit = base === null ? 0 : Math.max(0, roundMoney((base * MANUAL_DISCOUNT_FREE_PERCENT) / 100));
  const manualTotal = roundMoney(lineManual + billPart);
  const needsApproval = unreadable
    || (billPart > 0 && (base === null || manualTotal > roundMoney(freeLimit + MANUAL_DISCOUNT_TOLERANCE)));
  return {
    manualBill: unreadable ? null : billPart,
    lineManual,
    manualTotal,
    base,
    freeLimit,
    percent: base !== null && base > 0 ? roundMoney((manualTotal / base) * 100) : null,
    needsApproval,
    unreadable,
  };
};

/**
 * Everything POS asks before billing: the lines over 5% (`lines`) and, when the bill discount
 * takes the whole bill over 5%, the bill (`bill`, else null). An exempt user is never asked.
 */
export const posDiscountApproval = (cart, { exempt = false, manualBill = 0 } = {}) => {
  if (exempt === true) return { needed: false, lines: [], bill: null };
  const { lines } = cartDiscountApproval(cart);
  const assessment = assessBillManualDiscount({ lines: cart, manualBill });
  const bill = assessment.needsApproval ? assessment : null;
  return { needed: lines.length > 0 || bill !== null, lines, bill };
};

/** "Whole bill 6.2% with the bill discount (₹62 of ₹1,000)" -- for the dialog and the reason. */
export const describeBillApprovalLine = (bill) => {
  if (!bill) return "";
  if (bill.percent === null || bill.percent === undefined) {
    return bill.manualBill === null ? "Bill discount that cannot be read" : `Bill discount ${formatRupees(bill.manualBill)} off`;
  }
  return `Whole bill ${formatPercent(bill.percent)} with the bill discount (${formatRupees(bill.manualTotal)} of ${formatRupees(bill.base)})`;
};

/** The approval reason with the bill in it (the server takes at most 500 characters). */
export const describePosDiscountApprovalReason = (lines, bill = null) => {
  const list = Array.isArray(lines) ? lines : [];
  if (!bill) return describeDiscountApprovalReason(list);
  const billPart = describeBillApprovalLine(bill);
  const reason = list.length
    ? `${describeDiscountApprovalReason(list)}; ${billPart}`
    : `Bill discount over ${MANUAL_DISCOUNT_FREE_PERCENT}%: ${billPart}`;
  return reason.length > REASON_LIMIT ? `${reason.slice(0, REASON_LIMIT - 1)}…` : reason;
};

/**
 * The rule name a bill stores for its bill discount -- `billDiscountRule` in backend/discounts.js.
 * No cashier's part: the slab's own name. A slab part and a cashier's part: the slab's name with
 * " + extra", so the bill never claims the slab gave all of it. A cashier's part only: none.
 *
 * Only for what POS shows and prints straight after billing. The payload still carries the slab's
 * own snapshot (`slabSnapshot`): the server adds " + extra" itself from `manual_bill_discount`, and
 * a name sent already marked would come back marked twice.
 */
const RULE_NAME_MAX = 140;
export const billDiscountRuleName = (rule, slabAmount, manualAmount) => {
  if (!rule) return null;
  const name = slabDisplayName(rule);
  if (!((finiteOrNull(manualAmount) ?? 0) > 0)) return name;
  if (!((finiteOrNull(slabAmount) ?? 0) > MANUAL_DISCOUNT_TOLERANCE)) return null;
  return `${name.slice(0, RULE_NAME_MAX - MANUAL_BILL_DISCOUNT_RULE_SUFFIX.length)}${MANUAL_BILL_DISCOUNT_RULE_SUFFIX}`;
};

/** The server's code when slab + bill discount is more than the bill. */
export const BILL_DISCOUNT_TOO_LARGE_CODE = "BILL_DISCOUNT_TOO_LARGE";

/**
 * A checkout refusal because the bill discount is more than the bill can take, or null for any
 * other answer. `maxManualBillDiscount` is the most the box may give (null when not sent).
 */
export const readBillDiscountTooLarge = (status, data) => {
  if (Number(status) !== 400) return null;
  if (text(data?.code).toUpperCase() !== BILL_DISCOUNT_TOO_LARGE_CODE) return null;
  const most = finiteOrNull(data?.max_manual_bill_discount);
  const maxManualBillDiscount = most === null ? null : roundMoney(Math.max(0, most));
  const sentence = text(data?.message) || "The bill discount is more than the bill after its slab discount.";
  const ending = /[.!?]$/.test(sentence) ? "" : ".";
  return {
    maxManualBillDiscount,
    message: maxManualBillDiscount === null
      ? `${sentence}${ending} ${CART_KEPT}`
      : `${sentence}${ending} The most this bill can take off is ${formatRupees(maxManualBillDiscount)}. ${CART_KEPT}`,
  };
};
