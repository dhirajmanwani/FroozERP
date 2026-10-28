/**
 * Combos & Offers: everything about a combo that can be decided without a screen.
 *
 * A combo is sold at the counter as a group of ordinary sale lines, one per product and lot, so
 * stock, sync, cost and reports keep working line by line. What makes them a combo is eight fields
 * every line carries (`comboLineFields`), shared by all the lines of one combo in the cart.
 *
 *   FIXED   the owner lists the items and a selling price. The cashier says how many; the items
 *           are taken from this counter's own shelf, oldest lot first, and the price is spread over
 *           the lines (`allocateComboPrice`) so the lines add up to it to the paisa.
 *   CUSTOM  no items and no price of its own. The cashier adds whatever the customer wants; the
 *           combo's price is worked out, never typed: the items at their sale rates plus the
 *           combo's extra charge (making, basket). It is spread over the lines exactly as FIXED.
 *
 * Either way the bill shows one price per combo and the items by name and quantity only (owner,
 * 21 Oct 2026: "per combo ya per gift pricing rahegi"), and every combo line is priced by its
 * combo: no rate permission, lot discount, 5% rule or bill-total slab applies to it.
 *
 * The word is "combo" throughout. "Bundle" already means the settings bundle in this codebase.
 *
 * Ids are opaque strings: compared with `inventoryIdsEqual`, never `Number()`ed.
 */

import { canonicalInventoryId, inventoryIdsEqual } from "./stockInventory.js";
import { filterLotsForScope } from "./locationScope.js";
import { lotAvailableQuantity } from "./posInventory.js";
import { parseTargetMargin, roundSuggestedRate, suggestSaleRate } from "./saleRateUpdate.js";
import { packingCostOf } from "./froozPack.js";
import { COMBO_STOCK_REMINDER_KEY_PREFIX, FROST_STOCK_REMINDER_LABEL } from "./frostBellNotifications.js";

export const COMBO_KINDS = Object.freeze(["COMBO_OFFER", "THE_CUTTING", "JUICE", "GIFTING"]);
export const COMBO_TYPES = Object.freeze(["FIXED", "CUSTOM"]);

export const COMBO_KIND_LABELS = Object.freeze({
  COMBO_OFFER: "Combo / Offer",
  THE_CUTTING: "The Cutting",
  JUICE: "Juice",
  GIFTING: "Gifting",
});

export const COMBO_TYPE_LABELS = Object.freeze({
  FIXED: "Fixed items",
  CUSTOM: "Customer's choice",
});

/** Which POS tab a kind of combo is sold from. Products are never placed on the combos tab. */
/**
 * The margin a new combo's form starts with, by kind (owner, Amendment 2). COMBO_OFFER has none of
 * its own: it starts from the Sale Rate desired margin, like a loose product.
 */
export const COMBO_DEFAULT_MARGIN_BY_KIND = Object.freeze({ GIFTING: 40, JUICE: 30, THE_CUTTING: 30, COMBO_OFFER: null });

export const COMBO_MARGIN_MAX = 1000;

/** The Margin % a new combo of `kind` starts with; COMBO_OFFER (and anything unknown) uses `desiredMargin`. */
export const defaultComboMargin = (kind, desiredMargin) => {
  const own = COMBO_DEFAULT_MARGIN_BY_KIND[upper(kind)];
  return Number.isFinite(own) ? own : parseTargetMargin(desiredMargin);
};

export const COMBO_TAB_FOR_KIND = Object.freeze({
  JUICE: "bar",
  THE_CUTTING: "bar",
  GIFTING: "moments",
  COMBO_OFFER: "combos",
});

export const COMBO_EDIT_REFUSAL = "This bill has a combo on it, so it can't be edited. Cancel the bill and bill it again instead.";
export const COMBO_RETURN_REFUSAL = "Combo items can't be returned one by one. Cancel the whole bill instead.";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const upper = (value) => text(value).toUpperCase();

const finiteOrNull = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

// ---------------------------------------------------------------------------------------------
// Money and quantity in whole units: paise and thousandths. Floats only at the edges.
// ---------------------------------------------------------------------------------------------

/** Rupees as whole paise, half away from zero. null for anything that is not a number. */
export const toPaise = (value) => {
  const number = finiteOrNull(value);
  if (number === null) return null;
  return Math.sign(number) * Math.round(Math.abs(number) * 100 + 1e-7);
};

/** A quantity as whole thousandths, half away from zero. null for anything that is not a number. */
export const toThousandths = (value) => {
  const number = finiteOrNull(value);
  if (number === null) return null;
  return Math.sign(number) * Math.round(Math.abs(number) * 1000 + 1e-7);
};

const fromPaise = (paise) => paise / 100;

/**
 * A combo line's amount: qty × rate, half up on the exact paise × thousandths -- the same method
 * the allocation prices a line with and the server bills it with (`comboLineAmount` in
 * backend/combos.js). The float product misreads an exact half paisa (0.7 × 140.85 = 98.595 is
 * 98.59499… as a double), which left a combo bill a paisa short of the server's total.
 * Plain lines keep their own rounding; this is for combo lines only.
 */
export const comboLineAmount = (quantity, rate) => {
  const thousandths = toThousandths(quantity);
  const paise = toPaise(rate);
  if (thousandths === null || paise === null) return Math.round((Number(quantity) * Number(rate) + Number.EPSILON) * 100) / 100;
  const product = thousandths * paise;
  return (Math.sign(product) * Math.floor((Math.abs(product) * 2 + 1000) / 2000)) / 100;
};
const fromThousandths = (thousandths) => thousandths / 1000;

/**
 * How much of a lot is free, in whole thousandths, rounded DOWN and with no tolerance. The desktop
 * compares the raw stored balance (`balance_qty >= qty`), and a balance worn by sales can sit a
 * hair under its 3-dp value (4.3 − 0.7 = 3.5999999999999996): rounding that up to 3.600 asked
 * for more than the lot holds and the bill was refused at checkout. Exact: when the balance is at
 * or above n/1000, so is the quantity sent for n thousandths.
 */
export const floorThousandths = (value) => {
  const number = finiteOrNull(value);
  if (number === null || number <= 0) return 0;
  return Math.floor(number * 1000);
};

/** The number has at most `places` decimals (as typed). */
const hasAtMostDecimals = (value, places) => {
  const raw = text(value);
  if (raw === "") return false;
  if (/e/i.test(raw)) return false;
  const [, fraction = ""] = raw.split(".");
  return fraction.length <= places;
};

// ---------------------------------------------------------------------------------------------
// The master
// ---------------------------------------------------------------------------------------------

const normaliseItem = (item, index) => ({
  product_global_id: text(item?.product_global_id),
  product_id: text(item?.product_id),
  product_name: text(item?.product_name),
  unit: text(item?.unit),
  // The server's word on whether the product is still on sale (`product_active`); absent = yes.
  product_active: item?.product_active !== false && item?.product_active !== 0 && item?.product_active !== "false",
  quantity: finiteOrNull(item?.quantity),
  sort_order: finiteOrNull(item?.sort_order) ?? index,
});

/**
 * One packing row of a combo (Frooz Pack). The API names the size `packing_size_id` (its global
 * id); the snapshot's `local_combo_packing` row may say `size_id`. Either is read.
 */
const normalisePackingRow = (row, index) => ({
  packing_size_id: text(row?.packing_size_id) || text(row?.size_id) || text(row?.size_global_id),
  quantity: finiteOrNull(row?.quantity),
  sort_order: finiteOrNull(row?.sort_order) ?? index,
  type_name: text(row?.type_name),
  design_name: text(row?.design_name),
  size_name: upper(row?.size_name),
  capacity: text(row?.capacity),
  unit_cost: finiteOrNull(row?.unit_cost),
  size_active: row?.size_active !== false && row?.size_active !== 0 && row?.size_active !== "false",
});

/**
 * One combo row as the snapshot or the API sent it, in one shape.
 *
 * `packing` is always an array; `packing_known` says whether the source actually carried one. A
 * row from before Frooz Pack has no `packing` key, and "not told" must not become "none": an edit
 * built from it leaves the stored packing alone (`comboDraftFrom` / `buildComboPayload`).
 */
export const normaliseCombo = (row) => {
  const items = (Array.isArray(row?.items) ? row.items : [])
    .map(normaliseItem)
    .sort((left, right) => left.sort_order - right.sort_order);
  // `global_id` when the row has one. The desktop snapshot's `id` is already the global id
  // ("combo-12"), so it is taken as is; only a bare server id ("12") is made into "combo-12".
  const rawId = text(row?.id);
  const globalId = text(row?.global_id) || (/^combo-/i.test(rawId) ? rawId : (rawId ? `combo-${rawId}` : ""));
  return {
    id: text(row?.id),
    global_id: globalId,
    name: text(row?.name),
    kind: upper(row?.kind),
    combo_type: upper(row?.combo_type),
    price: finiteOrNull(row?.price),
    extra_charge: finiteOrNull(row?.extra_charge) ?? 0,
    margin_percent: finiteOrNull(row?.margin_percent),
    description: text(row?.description),
    active: row?.active !== false && row?.active !== 0 && row?.active !== "false",
    sort_order: finiteOrNull(row?.sort_order) ?? 0,
    items,
    packing_known: Array.isArray(row?.packing),
    packing: (Array.isArray(row?.packing) ? row.packing : [])
      .filter((entry) => entry && typeof entry === "object")
      .map(normalisePackingRow)
      .sort((left, right) => left.sort_order - right.sort_order),
    // Whether a bill names it (server list only). Unknown stays null, never false: Delete is
    // offered only on a plain `false`, so a list that did not say cannot offer a refused delete.
    in_use: row?.in_use === true ? true : (row?.in_use === false ? false : null),
  };
};

/**
 * Delete is for a combo nothing was billed with (owner, 23 Oct 2026; the same rule as Frooz Pack).
 * One on a bill is switched off instead, so old bills and reports can still name it.
 */
export const comboDeletable = (combo) => combo?.in_use === false;

export const COMBO_IN_USE_NOTE = "This combo is on a bill, so it cannot be deleted. Untick \"On sale in POS\" to hide it from the counter.";

/**
 * The combo list from a snapshot or an API reply, as a named state.
 *
 * `missing` is not `ready` with nothing in it: a counter whose snapshot has no `combos` key has not
 * been told what combos exist, and saying "no combos" there would be an error rendered as zero.
 */
export const readCombos = (source) => {
  const list = Array.isArray(source) ? source : source?.combos;
  if (list === undefined || list === null) return { status: "missing", combos: [] };
  if (!Array.isArray(list)) return { status: "invalid", combos: [] };
  return { status: "ready", combos: list.filter((row) => row && typeof row === "object").map(normaliseCombo) };
};

/** Combos in the order the owner set: sort order, then name. */
export const sortCombos = (combos) => [...(Array.isArray(combos) ? combos : [])].sort((left, right) => (
  (left.sort_order - right.sort_order) || left.name.localeCompare(right.name, "en-IN", { sensitivity: "base" })
));

/** The product a combo item names, found by either of its ids. */
export const findComboProduct = (products, item) => {
  const keys = [item?.product_global_id, item?.product_id].map(canonicalInventoryId).filter(Boolean);
  if (keys.length === 0) return null;
  return (Array.isArray(products) ? products : []).find((product) => (
    [product?.id, product?.global_id, product?.product_global_id].some((id) => keys.some((key) => inventoryIdsEqual(id, key)))
  )) || null;
};

/**
 * The checks the server makes on a combo before saving it (`backend/combos.js`), with the same
 * codes, so the form names a problem before it is sent. Returns every problem, and the first.
 */
export const validateComboDraft = (draft = {}, { products = null } = {}) => {
  const errors = [];
  const add = (code, message) => errors.push({ code, message });
  if (text(draft.name) === "") add("COMBO_NAME_REQUIRED", "Give the combo a name.");
  else if (text(draft.name).length > 120) add("COMBO_NAME_REQUIRED", "Keep the name to 120 letters or fewer.");
  const kind = upper(draft.kind);
  if (!COMBO_KINDS.includes(kind)) add("COMBO_KIND_INVALID", "Choose what kind of combo this is.");
  const type = upper(draft.combo_type);
  if (!COMBO_TYPES.includes(type)) add("COMBO_TYPE_INVALID", "Choose Fixed items or Customer's choice.");

  const extraBlank = text(draft.extra_charge) === "";
  const extra = extraBlank ? 0 : finiteOrNull(draft.extra_charge);
  if (type === "FIXED") {
    if (extra === null || extra !== 0) {
      add("COMBO_CHARGE_INVALID", "A fixed combo has no extra charge: put it in the price.");
    }
    const price = finiteOrNull(draft.price);
    if (price === null || price <= 0 || !hasAtMostDecimals(draft.price, 2)) {
      add("COMBO_PRICE_INVALID", "A fixed combo needs a selling price above ₹0, with at most 2 decimals.");
    }
    const items = Array.isArray(draft.items) ? draft.items : [];
    if (items.length === 0) add("COMBO_ITEMS_REQUIRED", "Add at least one item to a fixed combo.");
    const seen = [];
    items.forEach((item, index) => {
      const row = index + 1;
      const key = canonicalInventoryId(item?.product_id) || canonicalInventoryId(item?.product_global_id);
      const quantity = finiteOrNull(item?.quantity);
      if (key === "") {
        add("COMBO_ITEM_INVALID", `Item ${row}: choose a product.`);
        return;
      }
      if (quantity === null || quantity <= 0 || !hasAtMostDecimals(item.quantity, 3)) {
        add("COMBO_ITEM_INVALID", `Item ${row}: enter a quantity above 0, with at most 3 decimals.`);
      }
      if (Array.isArray(products) && !findComboProduct(products, item)) {
        add("COMBO_ITEM_INVALID", `Item ${row}: that product is not in the product list.`);
      }
      if (seen.some((other) => inventoryIdsEqual(other, key))) {
        add("COMBO_ITEM_INVALID", `Item ${row}: ${text(item?.product_name) || "this product"} is listed twice. Put the whole quantity on one row.`);
      }
      seen.push(key);
    });
    // Packing (Frooz Pack): optional, but each row must name a size and a quantity, once.
    const seenSizes = [];
    (Array.isArray(draft.packing) ? draft.packing : []).forEach((entry, index) => {
      const row = index + 1;
      const sizeKey = canonicalInventoryId(entry?.packing_size_id) || canonicalInventoryId(entry?.size_id);
      if (sizeKey === "") {
        add("COMBO_PACKING_INVALID", `Packing ${row}: choose a packing size.`);
        return;
      }
      const quantity = finiteOrNull(entry?.quantity);
      if (quantity === null || quantity <= 0 || !hasAtMostDecimals(entry.quantity, 3)) {
        add("COMBO_PACKING_INVALID", `Packing ${row}: enter a quantity above 0, with at most 3 decimals.`);
      }
      if (seenSizes.some((other) => inventoryIdsEqual(other, sizeKey))) {
        add("COMBO_PACKING_INVALID", `Packing ${row}: this size is listed twice. Put the whole quantity on one row.`);
      }
      seenSizes.push(sizeKey);
    });
  } else if (type === "CUSTOM") {
    if (finiteOrNull(draft.price) !== null) {
      add("COMBO_PRICE_INVALID", "A customer's-choice combo has no price of its own; items are billed at their rates.");
    }
    if (extra === null || extra < 0 || (!extraBlank && !hasAtMostDecimals(draft.extra_charge, 2))) {
      add("COMBO_CHARGE_INVALID", "The extra charge must be ₹0 or more, with at most 2 decimals.");
    }
  }
  if (text(draft.margin_percent) !== "") {
    const margin = finiteOrNull(draft.margin_percent);
    if (margin === null || margin < 0 || margin > COMBO_MARGIN_MAX || !hasAtMostDecimals(draft.margin_percent, 2)) {
      add("COMBO_MARGIN_INVALID", `The margin must be between 0% and ${COMBO_MARGIN_MAX}%, with at most 2 decimals.`);
    }
  }
  return { ok: errors.length === 0, errors, first: errors[0] || null };
};

/** A blank form for a new combo of `kind`, its margin pre-filled by kind (`defaultComboMargin`). */
export const newComboDraft = ({ kind = "COMBO_OFFER", desiredMargin } = {}) => ({
  ref: "",
  name: "",
  kind: upper(kind) || "COMBO_OFFER",
  combo_type: "FIXED",
  price: "",
  extra_charge: "0",
  margin_percent: String(defaultComboMargin(kind, desiredMargin)),
  description: "",
  active: true,
  sort_order: "0",
  items: [{ product_id: "", product_name: "", unit: "", quantity: "" }],
  packing: [],
});

/**
 * The form for an existing combo, every number as the text a box shows. `ref` is what PUT takes.
 * `packing` is set only when the combo carried one (`packing_known`), so a draft made from a row
 * that never said what packing it has sends no `packing` key and the server keeps what it stored.
 */
export const comboDraftFrom = (combo) => {
  const row = normaliseCombo(combo);
  const box = (value) => (value === null || value === undefined ? "" : String(value));
  const packing = row.packing_known
    ? {
      packing: row.packing.map((entry) => ({
        packing_size_id: entry.packing_size_id,
        quantity: box(entry.quantity),
        type_name: entry.type_name,
        design_name: entry.design_name,
        size_name: entry.size_name,
        capacity: entry.capacity,
        unit_cost: entry.unit_cost,
        size_active: entry.size_active,
      })),
    }
    : {};
  return {
    ref: row.global_id || row.id,
    name: row.name,
    kind: row.kind,
    combo_type: row.combo_type,
    price: box(row.price),
    extra_charge: box(row.extra_charge),
    margin_percent: box(row.margin_percent),
    description: row.description,
    active: row.active,
    sort_order: box(row.sort_order),
    items: row.items.map((item) => ({
      product_id: item.product_id || item.product_global_id,
      product_name: item.product_name,
      unit: item.unit,
      quantity: box(item.quantity),
    })),
    ...packing,
    // Shown, never sent: a combo on a bill tells the owner why it has no Delete.
    inUse: row.in_use === true,
  };
};

/**
 * What POST and PUT /api/v3/combos take. No identity: the server records who from the session.
 *
 * `packing` follows the server's rule: ABSENT keeps the stored packing, [] clears it. So it is sent
 * only when the draft has a `packing` array (a `null` or missing one is "not told", never "none"),
 * and a CUSTOM combo always sends [] (its packing is picked at the counter).
 */
export const buildComboPayload = (draft = {}) => {
  const type = upper(draft.combo_type);
  const fixed = type === "FIXED";
  const packing = Array.isArray(draft.packing)
    ? {
      packing: fixed
        ? draft.packing.map((entry, index) => ({
          packing_size_id: canonicalInventoryId(entry?.packing_size_id) || canonicalInventoryId(entry?.size_id),
          quantity: finiteOrNull(entry?.quantity),
          sort_order: index,
        }))
        : [],
    }
    : {};
  return {
    name: text(draft.name),
    kind: upper(draft.kind),
    combo_type: type,
    price: fixed ? finiteOrNull(draft.price) : null,
    extra_charge: fixed ? 0 : (finiteOrNull(draft.extra_charge) ?? 0),
    margin_percent: text(draft.margin_percent) === "" ? null : finiteOrNull(draft.margin_percent),
    description: text(draft.description),
    active: draft.active !== false,
    sort_order: Math.trunc(finiteOrNull(draft.sort_order) ?? 0),
    items: fixed
      ? (Array.isArray(draft.items) ? draft.items : []).map((item, index) => ({
        product_id: canonicalInventoryId(item?.product_id) || canonicalInventoryId(item?.product_global_id),
        quantity: finiteOrNull(item?.quantity),
        sort_order: index,
      }))
      : [],
    ...packing,
  };
};

/** The rate a product sells at today, from the product row (the owner's list price). */
export const productListRate = (product) => {
  for (const value of [product?.selling_rate, product?.sale_rate]) {
    const rate = finiteOrNull(value);
    if (rate !== null && rate > 0) return rate;
  }
  return null;
};

/**
 * "Items at today's rates ₹X vs combo price ₹Y" for the Combos screen. `known` is false when any
 * item has no product or no rate: a part-sum is never shown as the whole.
 */
export const comboItemsValue = (items, products) => {
  let paise = 0;
  let known = true;
  for (const item of Array.isArray(items) ? items : []) {
    const product = findComboProduct(products, item);
    const rate = productListRate(product);
    const quantity = toThousandths(item?.quantity);
    if (!product || rate === null || quantity === null || quantity <= 0) {
      known = false;
      continue;
    }
    paise += Math.round((quantity * toPaise(rate)) / 1000);
  }
  return { known, value: known ? fromPaise(paise) : null };
};

/** Products in the combo that are switched off or gone: "Orange is not on sale". */
export const comboProductsNotOnSale = (combo, products) => (Array.isArray(combo?.items) ? combo.items : [])
  .filter((item) => {
    if (item?.product_active === false) return true;
    const product = findComboProduct(products, item);
    return !product || product.active === false || product.deleted_at;
  })
  .map((item) => item.product_name || "A product");

/**
 * Each product's purchase cost per unit today, from the Sale Rate Update rows (`GET /sale-rates`,
 * `latest_effective_cost`) -- the same cost that screen suggests rates from. A product with rows
 * that disagree takes the highest, so a suggestion never undercuts the dearest stock on hand.
 */
const costForProduct = (rates, product, item) => {
  const keys = [item?.product_global_id, item?.product_id, product?.id, product?.global_id].map(canonicalInventoryId).filter(Boolean);
  let best = null;
  for (const row of Array.isArray(rates) ? rates : []) {
    if (!keys.some((key) => inventoryIdsEqual(row?.product_id, key) || inventoryIdsEqual(row?.product_global_id, key))) continue;
    const cost = finiteOrNull(row?.latest_effective_cost);
    if (cost !== null && cost > 0 && (best === null || cost > best)) best = cost;
  }
  return best;
};

/**
 * What a FIXED combo's items cost today, and the price Sale Rate Update would suggest for it:
 * cost × (1 + the combo's own margin %, or the Sale Rate desired margin when it has none), rounded by
 * the shop's rounding rule (`suggestSaleRate`). An item with
 * no known cost means no cost and no suggestion -- a part-sum would suggest a loss.
 *
 * Its packing (Frooz Pack) is part of the cost: fruit + Σ packing quantity × unit cost (the row's
 * own, else `catalogue`'s). A packing row with no known cost is treated like a fruit with none.
 */
export const suggestComboPrice = ({ items = [], rates = [], products = [], marginPercent = null, targetMargin, roundingRule, packing = [], catalogue = null } = {}) => {
  const rows = Array.isArray(items) ? items : [];
  const own = text(marginPercent) === "" ? null : finiteOrNull(marginPercent);
  const margin = own !== null && own >= 0 ? own : parseTargetMargin(targetMargin);
  if (rows.length === 0) return { cost: null, suggested: null, margin };
  let paise = 0;
  for (const item of rows) {
    const product = findComboProduct(products, item);
    const cost = costForProduct(rates, product, item);
    const quantity = toThousandths(item?.quantity);
    if (cost === null || quantity === null || quantity <= 0) return { cost: null, suggested: null, margin };
    paise += Math.round((quantity * Math.round(cost * 100 * 100)) / 100000);
  }
  const packingCost = packingCostOf(packing, catalogue);
  if (!packingCost.known) return { cost: null, suggested: null, margin };
  const cost = fromPaise(paise + toPaise(packingCost.cost));
  return { cost, suggested: suggestSaleRate({ cost, targetMargin: margin, roundingRule }), margin };
};

// ---------------------------------------------------------------------------------------------
// Allocation of a FIXED combo's price over its lines (mirrored in backend/combos.js)
// ---------------------------------------------------------------------------------------------

/**
 * Spread `total` rupees over `lines` ({ quantity, rate }) so the lines add up to it exactly.
 *
 * Done in whole paise and thousandths:
 *   value_i  = qty_i × rate_i                     (weights; all zero → qty_i is the weight)
 *   share_i  = round half up (total × value_i / Σvalue) for every line but the last;
 *   share_n  = total − Σ other shares             (negative → refused)
 *   rate_i   = ceil to the paisa (share_i / qty_i)
 *   amount_i = round half up (qty_i × rate_i)
 *   discount_i = amount_i − share_i               (0 ≤ discount_i < qty_i paise + 1 paisa)
 * so amount_i − discount_i = share_i and Σ(amount − discount) = total, to the paisa.
 */
export const allocateComboPrice = (lines, total) => {
  const rows = Array.isArray(lines) ? lines : [];
  const totalPaise = toPaise(total);
  if (rows.length === 0) return { ok: false, code: "COMBO_NO_LINES", message: "This combo has no items to bill." };
  if (totalPaise === null || totalPaise < 0) return { ok: false, code: "COMBO_PRICE_INVALID", message: "This combo has no usable price." };
  const quantities = rows.map((line) => toThousandths(line?.quantity));
  if (quantities.some((quantity) => quantity === null || quantity <= 0)) {
    return { ok: false, code: "COMBO_QUANTITY_INVALID", message: "Every item in a combo needs a quantity above 0." };
  }
  const rates = rows.map((line) => {
    const paise = toPaise(line?.rate);
    return paise !== null && paise > 0 ? paise : 0;
  });
  let weights = quantities.map((quantity, index) => BigInt(quantity) * BigInt(rates[index]));
  let weightSum = weights.reduce((sum, weight) => sum + weight, 0n);
  if (weightSum === 0n) {
    weights = quantities.map((quantity) => BigInt(quantity));
    weightSum = weights.reduce((sum, weight) => sum + weight, 0n);
  }
  const bigTotal = BigInt(totalPaise);
  const shares = [];
  let allocated = 0;
  for (let index = 0; index < rows.length - 1; index += 1) {
    // Half up on the exact fraction: floor((2·T·w + W) / 2W).
    const share = Number((2n * bigTotal * weights[index] + weightSum) / (2n * weightSum));
    shares.push(share);
    allocated += share;
  }
  shares.push(totalPaise - allocated);
  if (shares.some((share) => share < 0)) {
    return { ok: false, code: "COMBO_ALLOCATION_NEGATIVE", message: "This combo's price could not be spread over its items." };
  }
  const allocatedLines = shares.map((share, index) => {
    const quantity = quantities[index];
    const ratePaise = Math.floor((share * 1000 + quantity - 1) / quantity);
    const amountPaise = Math.floor((quantity * ratePaise * 2 + 1000) / 2000);
    const discountPaise = amountPaise - share;
    return {
      quantity: fromThousandths(quantity),
      selling_rate: fromPaise(ratePaise),
      amount: fromPaise(amountPaise),
      discount_amount: fromPaise(discountPaise),
      net: fromPaise(share),
    };
  });
  return { ok: true, total: fromPaise(totalPaise), lines: allocatedLines };
};

// ---------------------------------------------------------------------------------------------
// The POS shelf: availability and oldest-lot-first expansion
// ---------------------------------------------------------------------------------------------

/** A lot's sale rate as the counter prices it: its own temporary or sale rate, else the product's. */
export const lotSaleRate = (lot, product) => {
  for (const value of [lot?.temporary_sale_rate, lot?.sale_rate, lot?.selling_rate]) {
    const rate = finiteOrNull(value);
    if (rate !== null && rate > 0) return rate;
  }
  return productListRate(product) ?? 0;
};

const lotDateKey = (lot) => text(lot?.purchase_date || lot?.opening_date || lot?.created_at).slice(0, 10);
const lotName = (lot) => text(lot?.lot_name || lot?.batch_no || lot?.lot_no || lot?.id);

/** Order two ids without turning them into numbers ("10" after "9"; "004" as text). */
const compareIds = (left, right) => {
  const a = canonicalInventoryId(left);
  const b = canonicalInventoryId(right);
  const plain = (value) => /^(0|[1-9]\d*)$/.test(value);
  if (plain(a) && plain(b) && a.length !== b.length) return a.length - b.length;
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

/** Oldest lot first: by date (undated last), then lot name, then id — the lot picker's order. */
export const fifoLotOrder = (left, right) => {
  const dateCompare = (lotDateKey(left) || "9999-12-31").localeCompare(lotDateKey(right) || "9999-12-31");
  if (dateCompare !== 0) return dateCompare;
  const nameCompare = lotName(left).localeCompare(lotName(right), undefined, { numeric: true, sensitivity: "base" });
  if (nameCompare !== 0) return nameCompare;
  return compareIds(left?.id, right?.id);
};

const cartThousandthsFor = (cart, matches) => (Array.isArray(cart) ? cart : [])
  .filter(matches)
  .reduce((sum, item) => sum + Math.max(toThousandths(item?.quantity) || 0, 0), 0);

const formatQuantity = (thousandths) => fromThousandths(thousandths).toLocaleString("en-IN", { maximumFractionDigits: 3 });

/**
 * A product's lots on this counter's shelf that can be sold now, oldest first. A lot kept in
 * another unit cannot make up a quantity written in the product's unit, so it is left out.
 */
const productShelfLots = (shelfLots, product, now) => {
  const unit = text(product?.unit).toLowerCase();
  return shelfLots
    .filter((lot) => inventoryIdsEqual(lot?.product_id, product?.id))
    .filter((lot) => !text(lot?.unit) || !unit || text(lot.unit).toLowerCase() === unit)
    .filter((lot) => lotAvailableQuantity(lot, now) > 0)
    .sort(fifoLotOrder);
};

/**
 * Take `combo × comboQty` from the shelf, oldest lot first, without touching anything.
 *
 * `lots` are the POS shelf's lots (already this counter's), narrowed by `scope` again here as POS
 * does everywhere it decides what can be sold. What the cart already holds is not free.
 * `reservedFor(productId)` is what orders have promised (0 when not given). Returns the picks
 * ({ product, lot, quantity, rate }) or a named refusal — never part of a combo.
 */
export const pickFixedCombo = ({ combo, comboQty = 1, products = [], lots = [], cart = [], scope = null, now = new Date(), reservedFor = null } = {}) => {
  const count = finiteOrNull(comboQty);
  if (count === null || count < 1 || !Number.isInteger(count)) {
    return { ok: false, code: "COMBO_QTY_INVALID", message: "Enter how many, as a whole number of 1 or more." };
  }
  if (!combo || combo.combo_type !== "FIXED") return { ok: false, code: "COMBO_TYPE_INVALID", message: "This is not a fixed combo." };
  if (combo.active === false) return { ok: false, code: "COMBO_INACTIVE", message: `${combo.name || "This combo"} is switched off.` };
  if (!(finiteOrNull(combo.price) > 0)) return { ok: false, code: "COMBO_PRICE_INVALID", message: `${combo.name || "This combo"} has no price set.` };
  if (!Array.isArray(combo.items) || combo.items.length === 0) {
    return { ok: false, code: "COMBO_ITEMS_REQUIRED", message: `${combo.name || "This combo"} has no items set.` };
  }
  const shelfLots = filterLotsForScope(Array.isArray(lots) ? lots : [], scope);
  const takenByLot = new Map();
  const picks = [];
  for (const item of combo.items) {
    const product = findComboProduct(products, item);
    const name = text(product?.product_name) || item.product_name || "A product";
    if (!product || product.active === false || product.deleted_at) {
      return { ok: false, code: "COMBO_PRODUCT_NOT_ON_SALE", productName: name, message: `${name} is not on sale.` };
    }
    const perCombo = toThousandths(item.quantity);
    if (perCombo === null || perCombo <= 0) {
      return { ok: false, code: "COMBO_ITEMS_REQUIRED", message: `${combo.name || "This combo"} has an item with no quantity.` };
    }
    let need = perCombo * count;
    const productLots = productShelfLots(shelfLots, product, now);
    const inCartForProduct = cartThousandthsFor(cart, (line) => inventoryIdsEqual(line?.product_id, product.id));
    const onShelf = productLots.reduce((sum, lot) => sum + floorThousandths(lotAvailableQuantity(lot, now)), 0);
    const reserved = Math.max(toThousandths(typeof reservedFor === "function" ? reservedFor(product.id) : 0) || 0, 0);
    const alreadyPicked = [...takenByLot.entries()]
      .filter(([lotId]) => productLots.some((lot) => inventoryIdsEqual(lot.id, lotId)))
      .reduce((sum, [, quantity]) => sum + quantity, 0);
    const free = onShelf - reserved - inCartForProduct - alreadyPicked;
    if (free < need) {
      return {
        ok: false,
        code: "COMBO_NOT_ENOUGH",
        productName: name,
        message: `Not enough ${name}: ${formatQuantity(need)} ${product.unit || ""} needed, ${formatQuantity(Math.max(free, 0))} free.`.replace(/\s+,/, ","),
      };
    }
    for (const lot of productLots) {
      if (need <= 0) break;
      const lotKey = canonicalInventoryId(lot.id);
      const inCart = cartThousandthsFor(cart, (line) => inventoryIdsEqual(line?.inventory_batch_id, lot.id));
      const lotFree = floorThousandths(lotAvailableQuantity(lot, now)) - inCart - (takenByLot.get(lotKey) || 0);
      if (lotFree <= 0) continue;
      const take = Math.min(lotFree, need);
      takenByLot.set(lotKey, (takenByLot.get(lotKey) || 0) + take);
      picks.push({ product, lot, quantity: fromThousandths(take), rate: lotSaleRate(lot, product) });
      need -= take;
    }
    if (need > 0) {
      return { ok: false, code: "COMBO_NOT_ENOUGH", productName: name, message: `Not enough ${name}.` };
    }
  }
  return { ok: true, picks };
};

/**
 * Is a FIXED combo sellable on this shelf right now, for one? `{ ok }` or the refusal the tile
 * shows ("Not enough Orange").
 */
export const comboAvailability = (args) => {
  const picked = pickFixedCombo({ ...args, comboQty: 1 });
  if (picked.ok) return { ok: true, message: "" };
  const short = picked.code === "COMBO_NOT_ENOUGH" ? `Not enough ${picked.productName}` : picked.message;
  return { ok: false, code: picked.code, message: short };
};

/**
 * The cart lines for a FIXED combo: picked, priced and tagged. `newLineId` makes each line's id;
 * `comboLineKey` is the id every line of this one combo shares.
 */
export const expandFixedCombo = ({ combo, comboQty = 1, comboLineKey, newLineId, ...shelf } = {}) => {
  const picked = pickFixedCombo({ combo, comboQty, ...shelf });
  if (!picked.ok) return picked;
  const count = Number(comboQty);
  const total = fromPaise(toPaise(combo.price) * count);
  const allocated = allocateComboPrice(picked.picks.map((pick) => ({ quantity: pick.quantity, rate: pick.rate })), total);
  if (!allocated.ok) return allocated;
  const key = text(comboLineKey);
  const lines = picked.picks.map((pick, index) => {
    const priced = allocated.lines[index];
    const lineId = typeof newLineId === "function" ? newLineId() : `${key}-${index}`;
    const { product, lot } = pick;
    return {
      line_id: lineId,
      cart_key: lineId,
      cart_identity: `combo|${key}|${canonicalInventoryId(lot.id)}|${index}`,
      product_id: product.id,
      inventory_batch_id: lot.id,
      product_name: product.product_name,
      lot_name: lot.lot_name || lot.batch_no || "",
      lot_size: lot.lot_size || lot.size_grade || "",
      unit: lot.unit || product.unit,
      available_qty: lotAvailableQuantity(lot),
      default_selling_rate: pick.rate,
      selling_rate: priced.selling_rate,
      quantity: priced.quantity,
      discount_amount: priced.discount_amount,
      // A combo's price is fixed: no lot discount, and a sync re-pricing discounts leaves it alone.
      keep_price: true,
      lot_discount_id: null,
      lot_discount_type: null,
      lot_discount_value: 0,
      lot_discount_per_unit: 0,
      combo_line_key: key,
      combo_id: combo.global_id,
      combo_name: combo.name,
      combo_kind: combo.kind,
      combo_type: "FIXED",
      combo_qty: count,
      combo_price: combo.price,
    };
  });
  return { ok: true, total: allocated.total, lines };
};

/**
 * The combo fields a CUSTOM combo's line carries. `combo_extra_charge` and `combo_base_rate` (the
 * line's own sale rate) stay in the cart: they are what the combo's price is worked out from.
 */
export const customComboTag = (combo, comboLineKey, { roundingRule = "NEAREST_RUPEE" } = {}) => ({
  combo_line_key: text(comboLineKey),
  combo_id: combo?.global_id || "",
  combo_name: combo?.name || "",
  combo_kind: combo?.kind || "",
  combo_type: "CUSTOM",
  combo_qty: 1,
  combo_price: null,
  combo_extra_charge: finiteOrNull(combo?.extra_charge) ?? 0,
  combo_margin_percent: finiteOrNull(combo?.margin_percent) ?? 0,
  combo_rounding_rule: text(roundingRule) || "NEAREST_RUPEE",
  keep_price: true,
  lot_discount_id: null,
  lot_discount_type: null,
  lot_discount_value: 0,
  lot_discount_per_unit: 0,
});

/**
 * A CUSTOM combo's one price: the items at their sale rates, plus the combo's margin on top (its
 * "bonus"; none = 0%), plus its extra charge, rounded by the Sale Rate rounding rule
 * (`roundSuggestedRate`). Null when the items' value is not a finite amount of 0 or more.
 */
export const customComboPrice = ({ itemsValue, marginPercent = 0, extraCharge = 0, roundingRule = "NEAREST_RUPEE" } = {}) => {
  const value = finiteOrNull(itemsValue);
  if (value === null || value < 0) return null;
  const margin = Math.max(finiteOrNull(marginPercent) ?? 0, 0);
  const extra = Math.max(finiteOrNull(extraCharge) ?? 0, 0);
  const price = roundSuggestedRate(value * (1 + margin / 100) + extra, roundingRule);
  return price !== null && price >= 0 ? price : null;
};

/**
 * How a CUSTOM combo is priced, in words: "items at their rates + 10% + ₹30". `money` formats rupees.
 * A 0% margin and a ₹0 extra charge are left out rather than shown as "+ 0%".
 */
export const describeCustomPricing = ({ marginPercent = 0, extraCharge = 0 } = {}, money = (value) => `₹${value}`) => {
  const margin = finiteOrNull(marginPercent) ?? 0;
  const extra = finiteOrNull(extraCharge) ?? 0;
  return `items at their rates${margin > 0 ? ` + ${margin}%` : ""}${extra > 0 ? ` + ${money(extra)}` : ""}`;
};

/**
 * Re-price one CUSTOM combo in the cart after an item was added, changed or removed: its price is
 * `customComboPrice` of Σ(qty × the item's sale rate), never typed, and it is spread over the lines
 * by `allocateComboPrice`. A line whose quantity cannot be read leaves the combo without a price
 * (`combo_price: null`), which checkout refuses by name rather than billing a guess.
 */
export const repriceCustomCombo = (cart, comboLineKey) => {
  const key = text(comboLineKey);
  const rows = Array.isArray(cart) ? cart : [];
  const group = rows.filter((line) => comboKeyOf(line) === key);
  if (!key || group.length === 0) return rows;
  let itemsPaise = 0;
  let readable = true;
  for (const line of group) {
    const quantity = toThousandths(line.quantity);
    const rate = toPaise(line.combo_base_rate ?? line.default_selling_rate);
    if (quantity === null || quantity <= 0 || rate === null || rate < 0) {
      readable = false;
      break;
    }
    itemsPaise += Math.floor((quantity * rate * 2 + 1000) / 2000);
  }
  const price = readable ? customComboPrice({
    itemsValue: fromPaise(itemsPaise),
    marginPercent: group[0].combo_margin_percent,
    extraCharge: group[0].combo_extra_charge,
    roundingRule: group[0].combo_rounding_rule,
  }) : null;
  const allocated = price !== null
    ? allocateComboPrice(group.map((line) => ({ quantity: line.quantity, rate: line.combo_base_rate ?? line.default_selling_rate })), price)
    : { ok: false };
  let index = 0;
  return rows.map((line) => {
    if (comboKeyOf(line) !== key) return line;
    const priced = allocated.ok ? allocated.lines[index] : null;
    index += 1;
    return priced
      ? { ...line, selling_rate: priced.selling_rate, discount_amount: priced.discount_amount, combo_qty: 1, combo_price: allocated.total }
      : { ...line, combo_qty: 1, combo_price: null };
  });
};

// ---------------------------------------------------------------------------------------------
// Lines, groups and payloads
// ---------------------------------------------------------------------------------------------

export const comboKeyOf = (line) => canonicalInventoryId(line?.combo_line_key);
export const isComboLine = (line) => comboKeyOf(line) !== "";
export const isFixedComboLine = (line) => isComboLine(line) && upper(line?.combo_type) === "FIXED";

/**
 * The eight combo fields every sale line carries, combo or not. One mapper for every payload, so
 * no call site can send seven of them. `lineIndex` is the line's place on the bill (0-based).
 */
export const comboLineFields = (item, lineIndex) => {
  const combo = isComboLine(item);
  const index = finiteOrNull(lineIndex ?? item?.line_index);
  return {
    combo_line_key: combo ? comboKeyOf(item) : null,
    combo_id: combo ? text(item.combo_id) || null : null,
    combo_name: combo ? text(item.combo_name) || null : null,
    combo_kind: combo ? upper(item.combo_kind) || null : null,
    combo_type: combo ? upper(item.combo_type) || null : null,
    combo_qty: combo ? finiteOrNull(item.combo_qty) : null,
    combo_price: combo ? finiteOrNull(item.combo_price) : null,
    line_index: index === null ? null : Math.trunc(index),
  };
};

/** Does this sale have any combo line? (Edit refused; see COMBO_EDIT_REFUSAL.) */
export const saleHasCombos = (sale) => (Array.isArray(sale?.items) ? sale.items : []).some(isComboLine);

/**
 * Lines in bill order, with each combo's lines gathered at the place its first line stands.
 * Returns `[{ kind: "line", line }, { kind: "combo", key, name, comboKind, comboType, comboQty,
 * comboPrice, lines }]`. A combo is never split, even if its lines are not next to each other.
 */
export const groupComboLines = (lines) => {
  const groups = [];
  const byKey = new Map();
  for (const line of Array.isArray(lines) ? lines : []) {
    const key = comboKeyOf(line);
    if (key === "") {
      groups.push({ kind: "line", line });
      continue;
    }
    let group = byKey.get(key);
    if (!group) {
      group = {
        kind: "combo",
        key,
        name: text(line.combo_name) || "Combo",
        comboKind: upper(line.combo_kind),
        comboType: upper(line.combo_type),
        comboQty: finiteOrNull(line.combo_qty),
        comboPrice: finiteOrNull(line.combo_price),
        lines: [],
      };
      byKey.set(key, group);
      groups.push(group);
    }
    group.lines.push(line);
  }
  return groups;
};

/** What a cart line comes to: qty × rate rounded, less its discount, in paise. */
const lineNetPaise = (line) => {
  const quantity = toThousandths(line?.quantity);
  const rate = toPaise(line?.selling_rate ?? line?.rate);
  const discount = toPaise(line?.discount_amount ?? line?.discount) || 0;
  if (quantity === null || rate === null) return null;
  return Math.round((quantity * rate) / 1000) - discount;
};

/** A FIXED combo's lines add up to price × qty. Problems in words; [] when the cart is sound. */
export const validateComboCart = (cart) => {
  const problems = [];
  for (const group of groupComboLines(cart)) {
    if (group.kind !== "combo") continue;
    const first = group.lines[0];
    const consistent = group.lines.every((line) => (
      text(line.combo_id) === text(first.combo_id)
      && upper(line.combo_type) === upper(first.combo_type)
      && finiteOrNull(line.combo_qty) === finiteOrNull(first.combo_qty)
      && finiteOrNull(line.combo_price) === finiteOrNull(first.combo_price)
    ));
    if (!consistent) {
      problems.push(`${group.name}: its lines disagree about the combo. Remove it and add it again.`);
      continue;
    }
    const expected = toPaise(group.comboPrice) === null || group.comboQty === null
      ? null
      : toPaise(group.comboPrice) * group.comboQty;
    const nets = group.lines.map(lineNetPaise);
    const actual = nets.some((net) => net === null) ? null : nets.reduce((sum, net) => sum + net, 0);
    if (expected === null || actual === null || Math.abs(expected - actual) > 1) {
      problems.push(group.comboType === "CUSTOM" && group.comboPrice === null
        ? `${group.name}: enter a quantity above 0 for every item in it.`
        : `${group.name}: the items no longer add up to the combo price. Remove it and add it again.`);
    }
  }
  return problems;
};

/** The combo shown at the head of its group in the cart and on the bill. */
export const comboGroupTotal = (group) => {
  const nets = (group?.lines || []).map(lineNetPaise);
  if (nets.some((net) => net === null)) return null;
  return fromPaise(nets.reduce((sum, net) => sum + net, 0));
};

/** How many things are on the bill, as the cart badge says it: each combo is 1, each loose line is 1. */
export const cartItemCount = (cart) => groupComboLines(cart).length;

/** "Orange Juice × 2": one price per combo, whichever type. */
export const comboGroupTitle = (group) => (group?.comboQty !== null && group?.comboQty !== undefined
  ? `${group.name} × ${group.comboQty}`
  : group?.name || "Combo");

/** The combos a POS tab sells, active only, in the owner's order. */
export const combosForTab = (combos, tabKey) => sortCombos(
  (Array.isArray(combos) ? combos : []).filter((combo) => combo.active !== false && COMBO_TAB_FOR_KIND[combo.kind] === tabKey),
);

/**
 * Why the Frooz Menu screen cannot load or save here, or null. Combos are kept on the server
 * (like discounts and sale rates), so Local Only, no cloud and offline each say so instead of
 * trying; POS keeps selling the combos its snapshot already has.
 */
export const resolveComboAvailability = ({ localOnly = false, offline = false, noCloud = false } = {}) => {
  if (localOnly) {
    return "This computer is in Local Only mode. Combos are kept on the server, so they cannot be loaded or changed here until Local Only is turned off. POS keeps selling the combos it already has.";
  }
  if (noCloud) {
    return "This computer is not connected to a cloud server. Combos are kept on the server, so they cannot be loaded or changed here. POS keeps selling the combos it already has.";
  }
  if (offline) {
    return "This computer is offline. Combos are kept on the server, so they cannot be loaded or changed until the connection is back. POS keeps selling the combos it already has.";
  }
  return null;
};

// ---------------------------------------------------------------------------------------------
// Combos whose fruit is missing (the owner, 22 Oct 2026)
// ---------------------------------------------------------------------------------------------

/**
 * The products the combo form offers: on sale and with stock in this shop (`current_stock` from
 * `GET /products`). A fruit with nothing on the shelf cannot go into a juice or a gift, so it is not
 * offered (owner, 22 Oct 2026). An unreadable stock figure is not "zero": the product is kept, so a
 * missing column cannot empty the list.
 */
export const comboPickableProducts = (products) => (Array.isArray(products) ? products : [])
  .filter((product) => product && product.active !== false && !product.deleted_at)
  .filter((product) => {
    const stock = finiteOrNull(product.current_stock);
    return stock === null || stock > 0;
  })
  .sort((left, right) => text(left.product_name).localeCompare(text(right.product_name), "en-IN", { sensitivity: "base" }));

/**
 * Why an item already in a combo is not in `comboPickableProducts`, for its line in the form:
 * "(not on sale)" or "(no stock)". Empty when it is offered as usual.
 */
export const comboItemProductNote = (products, item) => {
  const product = findComboProduct(products, item);
  if (!product || product.active === false || product.deleted_at) return "not on sale";
  const stock = finiteOrNull(product.current_stock);
  return stock !== null && stock <= 0 ? "no stock" : "";
};

/**
 * Every FIXED combo this counter cannot make even one of right now, with each item that stops it:
 * a product that is not on sale, or one whose stock on this shelf is less than one combo takes.
 * The cart is not counted: this is about the shelf, not about what a cashier is holding.
 *
 * Switched-off combos and customer's-choice combos (no items of their own) are never reported.
 * Each problem has a stable `key`, so the bell can raise it once and retract it when it clears.
 */
export const comboStockProblems = ({ combos = [], products = [], lots = [], scope = null, now = new Date() } = {}) => {
  const shelfLots = filterLotsForScope(Array.isArray(lots) ? lots : [], scope);
  const problems = [];
  for (const combo of sortCombos(combos)) {
    if (!combo || combo.active === false || combo.combo_type !== "FIXED") continue;
    const items = Array.isArray(combo.items) ? combo.items : [];
    if (items.length === 0) continue;
    const missing = [];
    for (const item of items) {
      const product = findComboProduct(products, item);
      const name = text(product?.product_name) || text(item?.product_name) || "A product";
      if (!product || product.active === false || product.deleted_at) {
        missing.push({ productName: name, reason: "NOT_ON_SALE" });
        continue;
      }
      const perCombo = toThousandths(item.quantity);
      if (perCombo === null || perCombo <= 0) continue;
      const onShelf = productShelfLots(shelfLots, product, now)
        .reduce((sum, lot) => sum + floorThousandths(lotAvailableQuantity(lot, now)), 0);
      if (onShelf < perCombo) missing.push({ productName: name, reason: onShelf > 0 ? "NOT_ENOUGH" : "OUT_OF_STOCK" });
    }
    if (missing.length === 0) continue;
    const comboKey = canonicalInventoryId(combo.global_id || combo.id) || text(combo.name);
    problems.push({ key: `combo-stock:${comboKey}`, comboName: text(combo.name) || "A combo", kind: combo.kind, missing });
  }
  return problems;
};

const MISSING_REASON_WORDS = Object.freeze({
  NOT_ON_SALE: "is not on sale",
  OUT_OF_STOCK: "is out of stock",
  NOT_ENOUGH: "is too low for one",
});

/** One sentence naming what stops a combo: "Alphonso Mango is out of stock, Kiwi is too low for one". */
export const describeComboStockProblem = (problem) => (problem?.missing || [])
  .map((entry) => `${entry.productName} ${MISSING_REASON_WORDS[entry.reason] || "is not available"}`)
  .join(", ");

const STOCK_ONLY_REASONS = Object.freeze(["OUT_OF_STOCK", "NOT_ENOUGH"]);

/** True when only fruit running out holds the combo up (nothing switched off). */
export const comboHeldUpByStockOnly = (problem) => {
  const missing = Array.isArray(problem?.missing) ? problem.missing : [];
  return missing.length > 0 && missing.every((entry) => STOCK_ONLY_REASONS.includes(entry?.reason));
};

/**
 * The bell's rows for `comboStockProblems`, one per combo, telling the owner what to do. Keys are
 * the problems' own, so a combo that is fixed (stock added or the combo edited) drops out.
 *
 * A combo held up only by fruit that ran out is a season ending, not an alarm (owner, 23 Oct 2026,
 * the same rule as the fruit's own zero-stock row): an Info "Reminder", under its own key so the
 * dismissal can be remembered on this computer until the combo can be made again. A product switched
 * off stays a warning. The caller raises these only for the Owner and Admins, who can edit combos.
 */
export const comboStockNotifications = (problems) => (Array.isArray(problems) ? problems : []).map((problem) => {
  const reminder = comboHeldUpByStockOnly(problem);
  return {
    severity: reminder ? "info" : "warning",
    title: `Edit combo: ${problem.comboName}`,
    message: reminder
      ? `${describeComboStockProblem(problem)}. Add stock, or if its season is over, edit ${problem.comboName} in Frooz Menu or dismiss this.`
      : `${describeComboStockProblem(problem)}. Edit ${problem.comboName} in Frooz Menu, or add stock, before selling it.`,
    source: "Frooz Menu",
    dedupeKey: reminder ? `${COMBO_STOCK_REMINDER_KEY_PREFIX}${problem.key}` : problem.key,
    ...(reminder ? { label: FROST_STOCK_REMINDER_LABEL } : {}),
  };
});

/**
 * What an empty combo tab says. With combos on other tabs it names them, so a combo saved under
 * another kind is found rather than taken for lost; with none on this computer at all it says how a
 * combo just saved arrives here (a sync).
 */
export const emptyComboTabMessage = ({ nothingHere = "", elsewhere = [] } = {}) => {
  const others = (Array.isArray(elsewhere) ? elsewhere : []).filter((entry) => entry && entry.count > 0);
  if (others.length > 0) {
    const where = others.map((entry) => `${entry.label} (${entry.names.join(", ")})`).join("; ");
    return `${nothingHere} Combos on this computer are on other tabs: ${where}.`;
  }
  return `${nothingHere} The Owner or an Admin adds them in Frooz Menu. One just saved reaches this computer with the next sync: press Sync now, then open POS again.`;
};
