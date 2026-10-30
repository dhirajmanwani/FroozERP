/**
 * Small rules POS checkout and the sale edit screen lean on, kept out of App.jsx so they can be
 * tested: the bill's own date and time, what a cart line must be before the device is asked to
 * save it, how a saved bill whose screen could not refresh is reported, what the Mandi Tax panel
 * says, and how an edited bill adds up.
 *
 * Nothing here talks to the network or to storage.
 */

import { billGross, lineGross, roundMoney } from "./discounts.js";
import { isComboLine } from "./combos.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const pad = (value) => String(value).padStart(2, "0");

/** "YYYY-MM-DDTHH:mm" for a Date, in this computer's own time (the bill date input's format). */
export const localDateTimeText = (date = new Date()) => (
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
);

/**
 * The bill's date and time at the moment it is saved.
 *
 * A bill nobody re-dated is stamped with now, not with when POS opened or the last bill was saved:
 * the field used to freeze at that moment, so every bill carried the time of the one before it and
 * a counter left on POS overnight refused every bill the next morning as "back-dated". A date the
 * Owner typed on purpose is kept exactly as typed.
 */
export const resolvePosBillDateTime = ({ typed = "", edited = false, now = "" } = {}) => {
  const chosen = text(typed);
  return edited && chosen ? chosen : text(now);
};

/**
 * The date and time an edited bill is saved with: the date the editor picked, and the time the bill
 * was first made. An edit used to send midnight, so fixing a rate moved an 18:45 bill to 00:00 on
 * its printout and in every hour-of-day report.
 */
export const editedBillDateTime = (invoice = {}, billDate = "") => {
  const date = text(billDate).slice(0, 10);
  const savedText = text(invoice?.bill_datetime || invoice?.sale_datetime);
  // A date with no time says nothing about the time; `created_at` may.
  const saved = /^\d{4}-\d{2}-\d{2}$/.test(savedText) ? "" : savedText;
  let time = "";
  // A plain local "YYYY-MM-DDTHH:mm" (or with a space) carries the time as the counter wrote it.
  const plain = saved.match(/^\d{4}-\d{2}-\d{2}[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/);
  if (plain) time = plain[1];
  else {
    // A timestamp with a zone (or only `created_at`) is read as an instant and shown in local time.
    const source = saved || text(invoice?.created_at);
    const instant = source ? new Date(source) : null;
    if (instant && !Number.isNaN(instant.getTime())) {
      time = `${pad(instant.getHours())}:${pad(instant.getMinutes())}`;
    }
  }
  return `${date}T${time || "00:00"}`;
};

const decimals = (value) => {
  const raw = text(value);
  const match = raw.match(/\.(\d*)$/);
  return match ? match[1].length : 0;
};

/**
 * Whether a typed cart value fits the precision it is billed at: quantities carry 3 decimals,
 * rates and discounts 2. A value past that is refused as it is typed (the box keeps its last good
 * value), rather than sent to the device with four decimals and rounded somewhere out of sight.
 */
export const cartEntryFits = (field, value) => {
  const raw = text(value);
  if (/[eE]/.test(raw)) return false;
  const limit = field === "quantity" ? 3 : 2;
  return decimals(raw) <= limit;
};

/**
 * Why a loose cart line cannot be billed as it stands, or "". The device refuses the same lines,
 * but in words that do not name the product ("POS item quantity must be greater than zero"), with
 * the customer standing there. A combo's line is priced and checked by the combo, so it is passed.
 */
export const posLineProblem = (item) => {
  if (!item || isComboLine(item)) return "";
  const name = text(item.product_name) || "this item";
  const quantity = Number(text(item.quantity) === "" ? Number.NaN : item.quantity);
  if (!(Number.isFinite(quantity) && quantity > 0)) return `Enter a quantity for ${name}.`;
  const discount = Number(item.discount_amount || 0);
  if (!Number.isFinite(discount) || discount < 0) return `${name}: the item discount is not a valid amount.`;
  if (roundMoney(discount) > lineGross(item)) return `${name}: the item discount is more than the line.`;
  return "";
};

/** The first line problem on the cart, or "". */
export const cartLineProblem = (cart) => {
  for (const item of Array.isArray(cart) ? cart : []) {
    const problem = posLineProblem(item);
    if (problem) return problem;
  }
  return "";
};

/**
 * A charge that could not price itself stops the bill. The bill would otherwise save without it,
 * and a bill quietly missing its delivery looks finished (local/otherCharges.js).
 */
export const chargeRefusalProblem = (refusals) => {
  const first = (Array.isArray(refusals) ? refusals : [])[0];
  if (!first) return "";
  const message = text(first.message) || "A charge on this bill could not be priced.";
  return `${message} Fix or remove the charge before saving.`;
};

/**
 * Said when a bill is saved but the screen behind it could not refresh. The bill exists: it must be
 * reported as saved, with its number, so nobody rings it up again and takes the stock twice.
 */
export const describeSavedBillRefreshFailure = (invoiceNo, error, { edited = false } = {}) => {
  const number = text(invoiceNo);
  const reason = text(error?.message || error) || "no reason was given";
  return edited
    ? `Bill ${number || "being edited"} is updated. The screen could not refresh afterwards (${reason}). Do not edit it again; reopen the bill list to see the change.`
    : `Bill ${number || "just made"} is saved. The screen could not refresh afterwards (${reason}). Do not bill it again; press Sync now or reopen POS to update the lists.`;
};

/**
 * What the Mandi Tax panel says, driven by the same figures the totals use. The badge used to look
 * only at "is a registered customer picked", so with the scope set to every customer a walk-in bill
 * showed "Not Applicable" next to a total that was charging it.
 */
export const describeMandiTaxPanel = ({ scope = "REGISTERED_CUSTOMERS", enabled = false, percent = 0, registered = false, appliedRate = 0 } = {}) => {
  const customerScope = text(scope).toUpperCase() || "REGISTERED_CUSTOMERS";
  const relevant = customerScope === "ALL_CUSTOMERS" || (customerScope === "REGISTERED_CUSTOMERS" && registered === true);
  const applied = Number(appliedRate) > 0;
  // Scope "NONE" is Mandi Tax switched off for every sale.
  const disabled = !applied && (customerScope === "NONE" || (relevant && enabled !== true));
  const needsConfiguration = !applied && relevant && enabled === true && !(Number(percent) > 0);
  const badge = applied ? "Applied" : disabled ? "Disabled" : needsConfiguration ? "Configuration Required" : "Not Applicable";
  return {
    badge,
    applied,
    disabled,
    needsConfiguration,
    // The walk-in note only where the walk-in is the reason: registered-customer scope.
    walkInNote: !applied && customerScope === "REGISTERED_CUSTOMERS" && registered !== true,
    salesLabel: customerScope === "REGISTERED_CUSTOMERS" ? "registered-customer sales" : "all sales",
    showPreview: applied,
  };
};

/** An edited line's amount, added up line by line to the paisa as POS and the server do. */
export const editLineAmount = (item) => roundMoney(Math.max(lineGross(item) - Number(item?.discount_amount || 0), 0));

/**
 * An edited bill's gross and item discount, the way POS adds up a new bill (`billGross`, line by
 * line). Summing the unrounded products moved Net Payable by a paisa or two on an edit that
 * changed nothing.
 */
export const saleEditTotals = (items) => {
  const rows = Array.isArray(items) ? items : [];
  return {
    gross: billGross(rows),
    itemDiscount: roundMoney(rows.reduce((sum, item) => sum + Number(item?.discount_amount || 0), 0)),
  };
};

/**
 * What is left in a cart line's lot once this line and every other line from that lot are taken,
 * to 3 decimals, never below zero. The row used to show the raw lot balance from when the line was
 * added -- a REAL like 3.5999999999999996 -- however much of it the cart had already taken.
 */
export const lotLeftAfterCart = ({ available, inOtherLines = 0, quantity = 0 } = {}) => {
  const balance = Number(available);
  if (!Number.isFinite(balance)) return null;
  const left = balance - Number(inOtherLines || 0) - (Number(quantity) || 0);
  return Math.max(Math.round(left * 1000) / 1000, 0);
};
