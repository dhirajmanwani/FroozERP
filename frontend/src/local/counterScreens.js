/**
 * Words and figures for the counter screens: POS, Sale Returns, Orders and the Dashboard.
 *
 * Display decisions only. Nothing here changes what is billed, saved or sent; it decides what a
 * cashier reads, so that a tile says its stock once with its unit, a refusal names the lot and the
 * unit, and a count agrees with its noun. Kept out of App.jsx so each rule is tested on its own
 * (`counterScreens.test.mjs`).
 */
import { MISSING_VALUE, finiteOrNull, unitDisplayName } from "./productMaster.js";

const text = (value) => (value === null || value === undefined ? "" : String(value)).trim();

/** "1 lot", "4 lots", "0 lots". */
export const countPhrase = (count, one, many = `${one}s`) => {
  const number = finiteOrNull(count);
  if (number === null) return `${MISSING_VALUE} ${many}`;
  return `${number.toLocaleString("en-IN")} ${number === 1 ? one : many}`;
};

/** A quantity as the counter reads it: up to 3 decimals, no trailing zeros ("68", "0.75"). */
export const counterQuantity = (value) => {
  const number = finiteOrNull(value);
  if (number === null) return MISSING_VALUE;
  return number.toLocaleString("en-IN", { maximumFractionDigits: 3 });
};

/** "68 Kg", "0.75 Kg", "6 Piece"; a blank unit is left off, never invented. */
export const counterQuantityWithUnit = (value, unit) => {
  const quantity = counterQuantity(value);
  if (quantity === MISSING_VALUE) return MISSING_VALUE;
  const unitName = unitDisplayName(unit);
  return unitName === MISSING_VALUE ? quantity : `${quantity} ${unitName}`;
};

/**
 * The one stock line on a POS tile: "68 Kg · 4 lots". It replaced four chips that said the same
 * stock twice ("Stock: 68", "68 in stock"), the unit on its own ("Unit: KG") and the lot count.
 */
export const posTileStockLine = ({ stock, unit, lotCount } = {}) => (
  `${counterQuantityWithUnit(stock, unit)} · ${countPhrase(lotCount, "lot")}`
);

/**
 * A tile's rate: "₹30.00 / Piece", or a range with an en dash, "₹170.00–₹180.00 / Kg". `format`
 * is the app's rupee formatter. An unknown rate is a dash, never ₹0.
 */
export const posRateLabel = ({ min, max, unit, format = (value) => String(value) } = {}) => {
  const low = finiteOrNull(min);
  const high = finiteOrNull(max);
  if (low === null || low <= 0) return MISSING_VALUE;
  const unitName = unitDisplayName(unit);
  const per = unitName === MISSING_VALUE ? "" : ` / ${unitName}`;
  if (high === null || high === low) return `${format(low)}${per}`;
  return `${format(Math.min(low, high))}–${format(Math.max(low, high))}${per}`;
};

/**
 * The lot picker's Size, Unit and rate filters are only worth their row when there is something to
 * choose between: more than one size, or more than one unit. A fruit with one size and one unit
 * (most of them) gets the search box and the list, and the list fits at 1366.
 */
export const shouldShowLotFilters = ({ sizes = [], units = [] } = {}) => (
  (Array.isArray(sizes) ? sizes.length : 0) > 1 || (Array.isArray(units) ? units.length : 0) > 1
);

/**
 * Said when a lot cannot take more: "Only 0.75 Kg more is left in lot Chiku lot 1." The old words
 * ("0.75 more units are available in Lot …") had no unit and called kilos "units".
 */
export const lotShortMessage = ({ more, unit, lotName } = {}) => {
  const left = finiteOrNull(more);
  const name = text(lotName);
  const where = name ? ` in lot ${name}` : " in this lot";
  if (left === null || left <= 0) return `Nothing more is left${where}.`;
  return `Only ${counterQuantityWithUnit(left, unit)} more is left${where}.`;
};

/** Orders: "1 order needs checking." / "3 orders need checking." */
export const ordersNeedCheckingText = (count) => {
  const number = finiteOrNull(count) ?? 0;
  return number === 1 ? "1 order needs checking." : `${number.toLocaleString("en-IN")} orders need checking.`;
};

/** What Orders says once an order is written down. */
export const orderSavedText = ({ orderNo = "", customerName = "" } = {}) => {
  const number = text(orderNo);
  const who = text(customerName);
  return `${number ? `Order ${number}` : "The order"}${who ? ` for ${who}` : ""} is saved. Its stock is set aside.`;
};

/**
 * One bill in Sale Returns' picker: "141126-001 · 14/11/2026 · Walk-in · ₹540.00". `formatDate`
 * and `formatMoney` are the app's own, so the date reads the Indian way and money has its ₹.
 */
export const returnInvoiceOptionLabel = (sale, { formatDate = (value) => text(value), formatMoney = (value) => String(value) } = {}) => {
  const amount = finiteOrNull(sale?.amount);
  return [
    text(sale?.invoice_no) || (text(sale?.id) ? `Bill #${text(sale.id)}` : ""),
    text(sale?.sale_date) ? formatDate(sale.sale_date) : "",
    text(sale?.customer_name) || "Walk-in",
    amount === null ? "" : formatMoney(amount),
  ].filter(Boolean).join(" · ");
};

/** Return history's Items cell: "Apple × 0.5 Kg, Kiwi × 2 Piece". */
export const returnItemsText = (items) => (Array.isArray(items) ? items : [])
  .map((item) => `${text(item?.product_name) || "Item"} × ${counterQuantityWithUnit(item?.return_quantity, item?.unit)}`)
  .join(", ");

/**
 * The saved-bill window's way out. Right after a bill is rung up the cashier's next job is the
 * next customer, so it says "New bill"; opened from anywhere else it is a plain "Close".
 */
export const invoiceCloseLabel = ({ fromPos = false } = {}) => (fromPos ? "New bill" : "Close");

/**
 * The Owner's bill-date hint under POS's Bill Date. Said only when it helps: a Cashier is told the
 * date is locked; an Owner is told only once the date has been moved off today, when it matters.
 */
export const billDateHint = ({ canChange = false, edited = false } = {}) => {
  if (!canChange) return "Bill date is locked for your role.";
  if (edited) return "This bill will carry the date and time above, not now.";
  return "";
};
