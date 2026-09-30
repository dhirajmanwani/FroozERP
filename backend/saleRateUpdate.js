"use strict";

/**
 * The owner's morning rate update (`GET /sale-rates`, `POST /sale-rates/bulk`): the rules, kept out
 * of `server.js` so they can be driven by `node:test` (see `saleRateUpdate.test.js`).
 *
 * What went wrong before 30 Sep 2026, and is pinned here:
 *
 *   - A product with no purchase cost was "suggested" its own current rate, a suggestion with no
 *     basis. No cost now means no suggestion (null), never a number standing in for one.
 *   - A target margin of 0% became 25%: `parseNonNegativeNumber(undefined)` is 0, so the saved
 *     setting was never consulted, and `setting || 25` turned a saved 0 into 25.
 *   - Rates were compared and written to history unrounded (12.345), while the column holds 12.35.
 *   - A lot priced at the product rate (its own rate 0) was recorded in history as "old rate 0".
 *   - A product-rate change reached a desktop counter never. When one is published it now carries
 *     `selling_rate` as a number: node-postgres returns NUMERIC as text, and the desktop's product
 *     change handler reads that field with `as_f64()`, which is None for text.
 *
 * The suggestion arithmetic is the same as `frontend/src/local/saleRateUpdate.js`, which the screen
 * uses so a change to the target margin shows at once; both are markup on cost.
 */

const DEFAULT_DESIRED_MARGIN = 25;
const SALE_RATE_ROUNDING_RULES = Object.freeze(["NEAREST_RUPEE", "ROUND_UP_5", "ROUND_UP_10", "NO_ROUND"]);

const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

// Float noise only: 40 × 1.25 must ceil to 50, not to 55 via 50.000000000001. Six places is far
// below a paisa, so it cannot move a real value across a rounding step.
const settle = (value) => Math.round(value * 1e6) / 1e6;

/** A finite number, or null. Blank text is null, not 0. */
const finiteOrNull = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/**
 * The margin a suggestion is made at: the one asked for, else the saved setting, else 25.
 * 0 is a real answer at every step.
 */
const resolveDesiredMargin = (requested, setting) => {
  const pick = (value) => {
    const number = finiteOrNull(value);
    return number !== null && number >= 0 ? number : null;
  };
  return pick(requested) ?? pick(setting) ?? DEFAULT_DESIRED_MARGIN;
};

/** A known rounding rule, else the nearest rupee. */
const resolveRoundingRule = (rule) => {
  const text = String(rule || "").trim().toUpperCase();
  return SALE_RATE_ROUNDING_RULES.includes(text) ? text : "NEAREST_RUPEE";
};

/** Round a suggested rate the way Settings says. Null in, null out. */
const roundSuggestedRate = (amount, rule) => {
  const value = finiteOrNull(amount);
  if (value === null) return null;
  const settled = settle(value);
  switch (resolveRoundingRule(rule)) {
    case "ROUND_UP_5": return Math.ceil(settled / 5) * 5;
    case "ROUND_UP_10": return Math.ceil(settled / 10) * 10;
    case "NO_ROUND": return roundMoney(settled);
    default: return Math.round(settled);
  }
};

/** Cost plus the target margin on cost, rounded. Null when there is no cost to work from. */
const suggestSellingRate = (cost, desiredMargin, rule) => {
  const basis = finiteOrNull(cost);
  const margin = finiteOrNull(desiredMargin);
  if (basis === null || basis <= 0 || margin === null || margin < 0) return null;
  return roundSuggestedRate(basis * (1 + margin / 100), rule);
};

/**
 * One entry of a bulk save, checked. Ids are the server's own integers and are parsed as such;
 * the rate is money and is rounded to 2 dp before anything compares or stores it.
 * Returns `{ error }` or `{ productId, inventoryBatchId, newRate, reason }`.
 */
const normalizeRateUpdate = (update) => {
  const positiveInteger = (value) => {
    const text = String(value ?? "").trim();
    if (!/^\d+$/.test(text)) return null;
    const number = Number(text);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  };
  const productId = positiveInteger(update?.product_id);
  const lotValue = update?.inventory_batch_id;
  const lotGiven = lotValue !== null && lotValue !== undefined && String(lotValue).trim() !== "";
  const inventoryBatchId = lotGiven ? positiveInteger(lotValue) : null;
  const rate = finiteOrNull(update?.new_selling_rate);
  const newRate = rate !== null && rate > 0 ? roundMoney(rate) : null;
  if (!productId || (lotGiven && !inventoryBatchId) || !newRate) {
    return { error: "Enter valid selling rates" };
  }
  const reason = typeof update?.reason === "string" ? update.reason.trim() : "";
  return { productId, inventoryBatchId, newRate, reason };
};

/**
 * What POS charges for a lot today: its own rate when above zero, else the product rate. The same
 * rule as the list's `COALESCE(NULLIF(ib.temporary_sale_rate, 0), p.selling_rate)`.
 */
const effectiveLotRate = (lotRate, productRate) => {
  const own = finiteOrNull(lotRate);
  if (own !== null && own > 0) return roundMoney(own);
  const base = finiteOrNull(productRate);
  return base !== null && base > 0 ? roundMoney(base) : 0;
};

/** Equal as money (2 dp). */
const sameRate = (left, right) => {
  const a = finiteOrNull(left);
  const b = finiteOrNull(right);
  return a !== null && b !== null && roundMoney(a) === roundMoney(b);
};

/**
 * The `sync_change_log` payload for a product whose rate changed: the row, with the fields the
 * desktop reads as numbers turned into numbers (NUMERIC arrives from pg as text).
 */
const productRateSyncPayload = (row) => {
  const payload = { ...(row || {}) };
  for (const field of ["selling_rate", "minimum_stock"]) {
    const number = finiteOrNull(payload[field]);
    if (number !== null) payload[field] = number;
  }
  return payload;
};

module.exports = {
  DEFAULT_DESIRED_MARGIN,
  SALE_RATE_ROUNDING_RULES,
  effectiveLotRate,
  finiteOrNull,
  normalizeRateUpdate,
  productRateSyncPayload,
  resolveDesiredMargin,
  resolveRoundingRule,
  roundSuggestedRate,
  sameRate,
  suggestSellingRate,
};
