/**
 * What an order may be taken for: the counter's own shelf, less what open orders already hold.
 *
 * The owner, 22 Nov 2026: "order pos se sync nahi he ... jo product available nhi he vo b dikha rha
 * he." The order form listed every product in the catalogue, stock or none, and read none of the
 * reservations orders already make. So an order could be written for fruit that was not in the shop,
 * or for the same 2 kg another order had already promised, and nobody found out until packing.
 *
 * This module answers the order picker's three questions from the same facts POS uses:
 *
 * 1. **What is on the shelf.** `posShelf` (the SQLite-derived shelf POS sells from), narrowed to
 *    this counter's scope by `resolveScopedLots` exactly as POS narrows it. Never the shared
 *    `products`/`inventory` lists, which some twenty loaders write.
 * 2. **What is free.** On hand minus `reservedQuantityByProduct` over the open orders, through
 *    `availableQuantity` (orderLifecycle.js), keyed canonically (reservedStock.js).
 * 3. **What it costs.** The rate POS charges for the lot it would sell first (`posLotRate`, the one
 *    rule POS's addProduct uses too).
 *
 * And it keeps the CLAUDE.md rule that an error never renders as zero: a shelf that has not been
 * read, could not be read, or cannot be read on this device is a named state with a sentence, never
 * an empty list that looks like a sold-out shop.
 */

import { counterMaySell, resolveScopedLots } from "./locationScope.js";
import { availableQuantity } from "./orderLifecycle.js";
import { counterQuantityWithUnit } from "./counterScreens.js";
import { filterSellableProducts, lotAvailableQuantity } from "./posInventory.js";
import { buildReservedIndex, reservedForProduct } from "./reservedStock.js";
import { canonicalInventoryId } from "./stockInventory.js";

export const ORDER_SHELF_STATUS = Object.freeze({
  READY: "ready",
  LOADING: "loading",
  /** This device cannot read a shelf at all (a browser): there is no local database. */
  UNAVAILABLE: "unavailable",
  ERROR: "error",
  /** The shelf was read, but this counter does not know which shop it is in. */
  NO_SHOP: "no-shop",
});

const rows = (value) => (Array.isArray(value) ? value : []);
const text = (value) => (value === null || value === undefined ? "" : String(value)).trim();
const finitePositive = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};
/** Quantities carry three decimals; anything finer is float noise from adding lot balances. */
const round3 = (value) => Math.round(Number(value) * 1000) / 1000;

/**
 * The rate POS charges for one unit of this lot before any lot discount: the lot's own rate when it
 * has one, otherwise the product's. `||` and not `??` on purpose — a lot whose temporary rate is 0
 * is not free, it has no temporary rate. This is the rule POS's `addProduct` applies when it puts a
 * line in the cart; both now call this one function so they cannot drift.
 */
export const posLotRate = (lot, product) => {
  const lotRate = Number(lot?.temporary_sale_rate || lot?.sale_rate || lot?.selling_rate || 0);
  return lotRate > 0 ? lotRate : Number(product?.selling_rate);
};

const lotDate = (lot) => text(lot?.purchase_date || lot?.opening_date || lot?.created_at).slice(0, 10);
const lotName = (lot) => text(lot?.lot_name || lot?.batch_no || lot?.lot_no || lot?.id);

/**
 * The lot POS offers first: oldest purchase first, then by lot name, the order POS's lot picker
 * lists them in (and Enter in that picker takes the top one). A lot with no date goes last.
 */
export const firstLotForSale = (lots = []) => [...rows(lots)].sort((left, right) => {
  const byDate = (lotDate(left) || "9999-12-31").localeCompare(lotDate(right) || "9999-12-31");
  if (byDate !== 0) return byDate;
  const byName = lotName(left).localeCompare(lotName(right), undefined, { numeric: true, sensitivity: "base" });
  if (byName !== 0) return byName;
  return text(left?.id).localeCompare(text(right?.id), undefined, { numeric: true });
})[0] || null;

const shelfMessage = (status, detail = "") => {
  if (status === ORDER_SHELF_STATUS.UNAVAILABLE) {
    return "Stock is read from this computer's own database, which only the FroozERP desktop app can open. Orders can't be checked against the shelf here.";
  }
  if (status === ORDER_SHELF_STATUS.ERROR) {
    return `The counter's stock could not be read${detail ? ` (${detail})` : ""}. Nothing can be offered until it loads — press refresh to try again.`;
  }
  return "Reading what is on the shelf…";
};

/**
 * The order picker's list.
 *
 * `shelf` is POS's `{ loaded, products, inventoryLots }`; `load` says what happened to the attempt
 * to read it (`{ status, message }`), which matters only while the shelf is not loaded. `orders` are
 * the open orders whose holds come off the shelf.
 *
 * `items` holds only what can be ordered now (free quantity above zero). `held` lists products that
 * are on the shelf but entirely promised to other orders, so the picker can say "Kiwi — all held for
 * orders" instead of the product silently missing.
 */
export const buildOrderPickList = ({
  shelf = null,
  load = null,
  orders = [],
  scope = null,
  now = new Date(),
  nowMs = now.getTime(),
} = {}) => {
  const empty = { items: [], held: [], countLabel: "Unavailable" };
  if (!shelf?.loaded) {
    const status = [ORDER_SHELF_STATUS.UNAVAILABLE, ORDER_SHELF_STATUS.ERROR].includes(load?.status)
      ? load.status
      : ORDER_SHELF_STATUS.LOADING;
    return { ...empty, status, usable: false, countLabel: status === ORDER_SHELF_STATUS.LOADING ? "…" : "Unavailable", message: shelfMessage(status, text(load?.message)) };
  }

  const resolution = resolveScopedLots(rows(shelf.inventoryLots), scope);
  if (!counterMaySell(resolution)) {
    return {
      ...empty,
      status: ORDER_SHELF_STATUS.NO_SHOP,
      usable: false,
      message: resolution.message || "This counter has not been told which shop it is in, so it cannot say what is on the shelf.",
    };
  }

  const lots = resolution.lots;
  const index = buildReservedIndex(orders, nowMs);
  const lotsByProduct = new Map();
  for (const lot of lots) {
    if (lotAvailableQuantity(lot, now) <= 0) continue;
    const key = canonicalInventoryId(lot?.product_id);
    if (!key) continue;
    if (!lotsByProduct.has(key)) lotsByProduct.set(key, []);
    lotsByProduct.get(key).push(lot);
  }

  const all = filterSellableProducts(rows(shelf.products), lots, now).map((product) => {
    const id = canonicalInventoryId(product.id);
    const productLots = lotsByProduct.get(id) || [];
    const onHand = round3(productLots.reduce((total, lot) => total + lotAvailableQuantity(lot, now), 0));
    const reserved = round3(reservedForProduct(index, product.id));
    const free = availableQuantity({ onHand, reserved });
    const rates = productLots.map((lot) => finitePositive(posLotRate(lot, product))).filter((rate) => rate !== null);
    const first = firstLotForSale(productLots);
    return {
      id,
      productId: product.id,
      product,
      name: text(product.product_name) || "Unnamed item",
      category: text(product.category_name || product.category),
      unit: product.unit || "",
      onHand,
      reserved,
      available: round3(free.available),
      oversold: free.oversold,
      shortfall: round3(free.shortfall),
      // null, not 0: an unknown rate must not prefill "Rs 0" on a customer's order.
      rate: finitePositive(posLotRate(first, product)),
      minRate: rates.length ? Math.min(...rates) : null,
      maxRate: rates.length ? Math.max(...rates) : null,
    };
  }).sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));

  const items = all.filter((item) => item.available > 0);
  const held = all.filter((item) => item.available <= 0);
  let message = "";
  if (items.length === 0) {
    message = held.length > 0
      ? `Everything on the shelf is already held for open orders (${held.map((item) => item.name).join(", ")}).`
      : "Nothing on this counter's shelf has stock right now. Stock arrives with purchases; if stock was bought, press refresh.";
  }
  return {
    status: ORDER_SHELF_STATUS.READY,
    usable: true,
    items,
    held,
    countLabel: String(items.length),
    message,
  };
};

/** Narrow the pick list to a search, by name, category or unit. */
export const searchOrderPickList = (items = [], query = "") => {
  const wanted = text(query).toLowerCase();
  if (!wanted) return rows(items);
  return rows(items).filter((item) => [item.name, item.category, item.unit]
    .some((value) => text(value).toLowerCase().includes(wanted)));
};

/**
 * Is this much of this item free to promise?
 *
 * `otherLines` is what the same draft already asks of the same product on its other lines, so two
 * lines of Apple are checked together. Returns `{ ok, level, message }`; `level` is "" when fine,
 * "error" when it must not be saved.
 */
export const checkOrderQuantity = ({ item = null, quantity, otherLines = 0 } = {}) => {
  if (!item) return { ok: false, level: "error", message: "This item is no longer on the shelf. Remove the line." };
  const typed = text(quantity);
  if (typed === "") return { ok: true, level: "", message: "" };
  const wanted = Number(typed);
  if (!Number.isFinite(wanted) || wanted <= 0) return { ok: false, level: "error", message: "Enter a quantity above zero." };
  const asked = round3(wanted + (Number(otherLines) || 0));
  if (asked > item.available + 1e-9) {
    const free = counterQuantityWithUnit(item.available, item.unit);
    const heldNote = item.reserved > 0 ? ` (${counterQuantityWithUnit(item.reserved, item.unit)} of the ${counterQuantityWithUnit(item.onHand, item.unit)} on the shelf is held for other orders)` : "";
    return {
      ok: false,
      level: "error",
      message: `Only ${free} of ${item.name} is free${heldNote}.`,
    };
  }
  return { ok: true, level: "", message: "" };
};

/**
 * Every line of a draft order checked against the shelf, or the first problem in words.
 *
 * Run at Save, after `buildOrderDraftLines` (ordersBoard.js) has made sure each line is complete.
 * Lines of the same product are added up, because two lines of 3 kg against 5 kg free is still 6.
 */
export const checkOrderAgainstShelf = (lines = [], pickList = null) => {
  if (!pickList?.usable) {
    return { ok: false, message: pickList?.message || "The counter's stock has not been read, so the order cannot be checked against it." };
  }
  const byId = new Map(rows(pickList.items).map((item) => [item.id, item]));
  const totals = new Map();
  for (const line of rows(lines)) {
    const key = canonicalInventoryId(line?.product_id);
    totals.set(key, round3((totals.get(key) || 0) + (Number(line?.quantity) || 0)));
  }
  for (const [key, quantity] of totals) {
    const item = byId.get(key);
    if (!item) {
      const name = rows(lines).find((line) => canonicalInventoryId(line?.product_id) === key)?.product_name || "An item";
      return { ok: false, message: `${name} is no longer free on the shelf (sold, or held for another order). Remove it from the order.` };
    }
    const checked = checkOrderQuantity({ item, quantity });
    if (!checked.ok) return { ok: false, message: checked.message };
  }
  return { ok: true, message: "" };
};

/**
 * The note on a POS tile when orders hold some of a product: "12.5 Kg free · 2 Kg held for orders".
 * "" when nothing is held, so an ordinary tile stays as it was. When orders hold more than the shelf
 * has, it says so rather than showing "0 free", which reads as an ordinary sell-out.
 */
export const heldForOrdersNote = ({ onHand = 0, reserved = 0, unit = "" } = {}) => {
  const held = Number(reserved);
  if (!(held > 0)) return "";
  const free = availableQuantity({ onHand, reserved: held });
  if (free.oversold) {
    return `Orders hold ${counterQuantityWithUnit(held, unit)}, more than is here`;
  }
  return `${counterQuantityWithUnit(round3(free.available), unit)} free · ${counterQuantityWithUnit(held, unit)} held for orders`;
};
