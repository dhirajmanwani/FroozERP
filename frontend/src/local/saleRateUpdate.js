import { finiteOrNull } from "./productMaster.js";

/**
 * The owner's morning rate update: what each row shows, what a typed rate means, and what is sent.
 *
 * ## Why this is not in App.jsx any more
 *
 * The screen computed its own numbers inline and got four of them wrong in ways that looked right:
 *
 *   - The suggestion is cost × (1 + target/100) -- a margin on *cost*, the way the shop talks about
 *     it ("25% on the purchase") -- but the Margin column divided by the *sale* rate. At the default
 *     25% the suggested rate showed as "20.0%", the owner's own target displayed as a shortfall.
 *   - A product with no purchase cost showed "₹0.00" cost and a green "100.0%" margin, and the server
 *     "suggested" its current rate back to it. None of those is a fact; they are the absence of one.
 *   - A rate typed and then deleted stayed in the draft as "", counted as a change, and blocked Save
 *     with "must be greater than 0" for a row that looked blank.
 *   - Ids went through `Number()`, which CLAUDE.md forbids, with a fallback to the row id -- which is
 *     `-product_id` for a product row.
 *
 * Everything here is a pure function of the rows the server sent and what the owner typed, so each
 * of those is pinned by `saleRateUpdate.test.mjs`.
 *
 * ## The two kinds of row
 *
 * `GET /sale-rates` sends one row per in-stock lot (`inventory_batch_id` set; saving writes that
 * lot's `temporary_sale_rate`) and one "product" row for a product with no stock here
 * (`inventory_batch_id` null, row id `-product_id`; saving writes `products.selling_rate`). POS
 * prices a lot at its own rate when that is above zero and at the product rate otherwise, which is
 * exactly the "current rate" this screen shows, so the two cannot disagree.
 */

export const MISSING = "—";

/** Rounding rules the server accepts (`ROUNDING_RULES` in backend/server.js). */
export const SALE_RATE_ROUNDING_RULES = Object.freeze(["NEAREST_RUPEE", "ROUND_UP_5", "ROUND_UP_10", "NO_ROUND"]);

export const DEFAULT_TARGET_MARGIN = 25;

const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

// Float noise only (40 × 1.25 must be 50, not 50.000000000001 that rounds *up* to 55). Six places is
// far below a paisa, so it cannot move a real value across a rounding boundary.
const settle = (value) => Math.round(value * 1e6) / 1e6;

/**
 * The same rounding the server applies to its suggestion (`applySaleRateRounding`).
 * Unknown rules fall back to the nearest rupee, as the server does.
 */
export const roundSuggestedRate = (amount, rule = "NEAREST_RUPEE") => {
  const value = finiteOrNull(amount);
  if (value === null) return null;
  const settled = settle(value);
  switch (String(rule || "").toUpperCase()) {
    case "ROUND_UP_5": return Math.ceil(settled / 5) * 5;
    case "ROUND_UP_10": return Math.ceil(settled / 10) * 10;
    case "NO_ROUND": return roundMoney(settled);
    default: return Math.round(settled);
  }
};

/**
 * A target margin the owner typed, or the fallback. 0 is a real target (sell at cost) and is kept;
 * `value || 25` used to turn it into 25.
 */
export const parseTargetMargin = (value, fallback = DEFAULT_TARGET_MARGIN) => {
  const number = finiteOrNull(value);
  if (number !== null && number >= 0) return number;
  const backup = finiteOrNull(fallback);
  return backup !== null && backup >= 0 ? backup : DEFAULT_TARGET_MARGIN;
};

/** Suggested sale rate: cost plus the target margin on cost, rounded. Null when there is no cost. */
export const suggestSaleRate = ({ cost, targetMargin, roundingRule } = {}) => {
  const basis = finiteOrNull(cost);
  const margin = finiteOrNull(targetMargin);
  if (basis === null || basis <= 0 || margin === null || margin < 0) return null;
  return roundSuggestedRate(basis * (1 + margin / 100), roundingRule);
};

/**
 * Margin on cost, in percent, one decimal: (rate − cost) ÷ cost. The same basis as the suggestion,
 * so the suggested rate shows the target it was made from. Null when either side is unknown.
 */
export const marginOnCost = (rate, cost) => {
  const sale = finiteOrNull(rate);
  const basis = finiteOrNull(cost);
  if (sale === null || basis === null || basis <= 0 || sale <= 0) return null;
  return Math.round(((sale - basis) / basis) * 1000) / 10;
};

/**
 * Tone for a margin, in the shared vocabulary: below cost is a loss (danger), under the target is a
 * warning, at or above it is fine. Unknown is neutral, never "fine".
 */
export const marginTone = (margin, targetMargin) => {
  if (margin === null || margin === undefined || !Number.isFinite(margin)) return "neutral";
  if (margin < 0) return "danger";
  const target = finiteOrNull(targetMargin);
  if (target !== null && margin < target) return "warning";
  return "success";
};

/**
 * Tone for a rate on a row. With a suggestion, "under target" means under the suggested rate: a
 * suggestion rounded to the rupee can land a little under the raw target (cost 45 at 25% is 56, which
 * is 24.4%), and flagging the owner's own suggested rate as a shortfall is the confusion this screen
 * had. Without one (suggestions off) the margin is compared with the target directly.
 */
export const rateTone = ({ rate, cost, suggestedRate = null, targetMargin = null } = {}) => {
  const margin = marginOnCost(rate, cost);
  if (margin === null) return "neutral";
  if (margin < 0) return "danger";
  const suggestion = finiteOrNull(suggestedRate);
  if (suggestion !== null) return finiteOrNull(rate) < suggestion ? "warning" : "success";
  return marginTone(margin, targetMargin);
};

/** A row's identity as text. Row ids are opaque; `"004"` and `4` stay different. */
export const saleRateRowKey = (row) => String(row?.id ?? "").trim();

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

/**
 * The server rows turned into what the table shows. Every number is a number or null -- never a
 * 0 standing in for "not known".
 */
export const buildSaleRateRows = (rates, {
  targetMargin = DEFAULT_TARGET_MARGIN,
  roundingRule = "NEAREST_RUPEE",
  suggestionsEnabled = true,
} = {}) => (Array.isArray(rates) ? rates : []).map((rate) => {
  const lotId = rate?.inventory_batch_id;
  const isLot = lotId !== null && lotId !== undefined && text(lotId) !== "";
  const cost = finiteOrNull(rate?.latest_effective_cost);
  const knownCost = cost !== null && cost > 0 ? cost : null;
  const currentRate = finiteOrNull(rate?.selling_rate);
  const pendingStock = finiteOrNull(rate?.pending_bill_stock);
  const lotName = text(rate?.lot_name) || (isLot ? `Lot ${text(lotId)}` : "");
  return {
    key: saleRateRowKey(rate),
    productId: rate?.product_id,
    inventoryBatchId: isLot ? lotId : null,
    isLot,
    productName: text(rate?.product_name) || MISSING,
    lotLabel: isLot ? [lotName, text(rate?.lot_size)].filter(Boolean).join(" · ") : "No stock here · product rate",
    category: text(rate?.category),
    origin: text(rate?.origin_type),
    unit: text(rate?.unit),
    stock: finiteOrNull(rate?.current_stock),
    cost: knownCost,
    // Stock that arrived before its bill: the cost on it is the expected rate, not the billed one.
    costIsEstimate: knownCost !== null && pendingStock !== null && pendingStock > 0,
    currentRate: currentRate !== null && currentRate > 0 ? currentRate : null,
    currentMargin: marginOnCost(currentRate, knownCost),
    suggestedRate: suggestionsEnabled
      ? suggestSaleRate({ cost: knownCost, targetMargin, roundingRule })
      : null,
  };
});

/** Rows matching the search box and the two filters. */
export const filterSaleRateRows = (rows, { search = "", category = "", origin = "" } = {}) => {
  const needle = String(search || "").trim().toLowerCase();
  return (Array.isArray(rows) ? rows : []).filter((row) =>
    (!needle || `${row.productName} ${row.lotLabel}`.toLowerCase().includes(needle))
    && (!category || row.category === category)
    && (!origin || String(row.origin).toUpperCase() === String(origin).toUpperCase()));
};

/**
 * What one input box holds: nothing, something that is not a usable rate, or a rate (2 dp).
 */
export const readDraftRate = (value) => {
  if (value === null || value === undefined || String(value).trim() === "") return { state: "empty", rate: null };
  const number = finiteOrNull(value);
  if (number === null || number <= 0) return { state: "invalid", rate: null };
  return { state: "valid", rate: roundMoney(number) };
};

/**
 * Every draft turned into a change, a refusal, or nothing -- across all rows, not only the ones the
 * filter shows, because Save sends all of them. `hiddenCount` tells the screen how many of the
 * changes are behind the filter, so nothing is saved that the owner cannot see is pending.
 */
export const collectSaleRateChanges = (rows, drafts = {}, visibleRows = null) => {
  const visibleKeys = visibleRows ? new Set(visibleRows.map((row) => row.key)) : null;
  const changes = [];
  const invalid = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const draft = readDraftRate(drafts?.[row.key]);
    if (draft.state === "empty") continue;
    if (draft.state === "invalid") {
      invalid.push(row.key);
      continue;
    }
    if (row.currentRate !== null && roundMoney(row.currentRate) === draft.rate) continue;
    changes.push({
      key: row.key,
      productId: row.productId,
      inventoryBatchId: row.inventoryBatchId,
      productName: row.productName,
      lotLabel: row.lotLabel,
      oldRate: row.currentRate,
      newRate: draft.rate,
      cost: row.cost,
      belowCost: row.cost !== null && draft.rate < row.cost,
      hidden: visibleKeys ? !visibleKeys.has(row.key) : false,
    });
  }
  return {
    changes,
    invalid,
    hiddenCount: changes.filter((change) => change.hidden).length + invalid.filter((key) => visibleKeys && !visibleKeys.has(key)).length,
  };
};

/**
 * The `POST /sale-rates/bulk` body entries. Ids go through untouched -- the server parses them --
 * because `Number()` on an id is how `"004"` became `4` elsewhere in this app.
 */
export const buildBulkRatePayload = (changes) => (Array.isArray(changes) ? changes : []).map((change) => ({
  product_id: change.productId,
  inventory_batch_id: change.inventoryBatchId ?? null,
  new_selling_rate: change.newRate,
}));

/** Suggested rates for the given rows, as drafts. Rows with no suggestion are left alone. */
export const suggestedDrafts = (rows) => Object.fromEntries((Array.isArray(rows) ? rows : [])
  .filter((row) => row.suggestedRate !== null && row.suggestedRate !== row.currentRate)
  .map((row) => [row.key, String(row.suggestedRate)]));

/**
 * What to tell the owner after the server answered. Counts come from the server's `updated_count`,
 * not from how many rows were sent: a rate equal to the current one is skipped there.
 */
export const describeSaveResult = (response, sentCount) => {
  const updated = finiteOrNull(response?.updated_count);
  if (updated === 0) return "Nothing changed: every rate sent was already the current one.";
  const count = updated === null ? sentCount : updated;
  const word = count === 1 ? "rate" : "rates";
  const unchanged = updated !== null && updated < sentCount ? ` ${sentCount - updated} already had that rate.` : "";
  return `Saved ${count} ${word}.${unchanged}`;
};

/**
 * Why this screen cannot work right now, or null when it can. Sale rates live on the server; with
 * Local Only chosen or no connection there is nothing to load and nowhere to save, and an empty
 * table would look like "no products".
 */
export const resolveSaleRateAvailability = ({ localOnly = false, offline = false, noCloud = false } = {}) => {
  if (localOnly) {
    return "This computer is in Local Only mode. Sale rates are kept on the server, so they cannot be loaded or changed here until Local Only is turned off. POS keeps selling at the rates it already has.";
  }
  // A desktop with no cloud address at all (a test copy, or a fresh install before setup): every
  // request would be refused by the gateway, so say why instead of showing that refusal as an error.
  if (noCloud) {
    return "This computer is not connected to a cloud server. Sale rates are kept on the server, so they cannot be loaded or changed here. POS keeps selling at the rates it already has.";
  }
  if (offline) {
    return "This computer is offline. Sale rates are kept on the server, so they cannot be loaded or changed until the connection is back. POS keeps selling at the rates it already has.";
  }
  return null;
};
