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

/**
 * How much one tap on a fruit adds from a lot: one unit, or what is left of the lot when that is
 * less than one. A lot holding 0.75 kg could not be sold at all, because the tap asked for a whole
 * kilo and was refused ("Only 0.75 more units are available") before any line existed to type 0.75
 * into. When nothing is left (or the lot's balance is unknown) it still asks for one unit, so the
 * stock check that follows refuses with its usual message rather than adding an empty line.
 */
export const lotTapQuantity = ({ available, inCart = 0 } = {}) => {
  const left = lotLeftAfterCart({ available, inOtherLines: inCart });
  if (left === null || left <= 0) return 1;
  return Math.min(1, left);
};

/**
 * The questions checkout stops to ask, in the app's own dialog instead of a browser box.
 *
 * Checkout asks the same things in the same order as it always did: a back-dated or future-dated
 * bill (then an optional reason), credit with no saved customer, a zero rate, a rate below cost, and
 * the same four again when the server asks after a refusal (HTTP 409). Only the box changed. These
 * are the words; App.jsx keeps every condition and the order. "Go back" is the safe choice and has
 * the focus (ConfirmDialog), so an Enter pressed out of habit never bills a risky price, and going
 * back stops checkout exactly where Cancel on the old box did.
 */
export const CHECKOUT_GATE = Object.freeze({
  BACKDATE: "backdate",
  FUTURE_DATE: "future-date",
  WALK_IN_CREDIT: "walk-in-credit",
  ZERO_RATE: "zero-rate",
  BELOW_COST: "below-cost",
});

/** The reason a re-dated bill is saved with when none is typed, as before. */
export const DEFAULT_DATE_OVERRIDE_REASON = Object.freeze({
  [CHECKOUT_GATE.BACKDATE]: "Backdated POS bill created",
  [CHECKOUT_GATE.FUTURE_DATE]: "Future-dated POS bill created",
});

/**
 * The confirm box for one gate. `billDate` is the date as people read it; `productName` names the
 * line; `serverMessage` is the server's own sentence when it is the server asking.
 */
export const checkoutGateDialog = (gate, { billDate = "", productName = "", serverMessage = "" } = {}) => {
  const fromServer = text(serverMessage);
  const date = text(billDate);
  const product = text(productName);
  switch (gate) {
    case CHECKOUT_GATE.BACKDATE:
      return {
        title: "Save this bill with an earlier date?",
        message: fromServer || `This bill will be dated ${date || "before today"}, not today.`,
        confirmLabel: "Use this date",
        cancelLabel: "Go back",
        tone: "danger",
      };
    case CHECKOUT_GATE.FUTURE_DATE:
      return {
        title: "Save this bill with a future date?",
        message: fromServer || `This bill will be dated ${date || "after today"}, not today.`,
        confirmLabel: "Use this date",
        cancelLabel: "Go back",
        tone: "danger",
      };
    case CHECKOUT_GATE.WALK_IN_CREDIT:
      return {
        title: "Put this credit sale on Walk-in Customer Credit?",
        message: "No saved customer is selected, so nobody by name will owe for this bill.",
        confirmLabel: "Bill to Walk-in credit",
        cancelLabel: "Go back",
        tone: "danger",
      };
    case CHECKOUT_GATE.ZERO_RATE:
      return {
        title: product ? `Sell ${product} at a zero rate?` : "Sell at a zero rate?",
        message: fromServer || "The sale rate is ₹0, so this item goes out free.",
        confirmLabel: "Sell at ₹0",
        cancelLabel: "Go back",
        tone: "danger",
      };
    case CHECKOUT_GATE.BELOW_COST:
      return {
        title: product ? `Sell ${product} below cost?` : "Sell below cost?",
        message: fromServer || "This rate is below what the stock cost the shop.",
        confirmLabel: "Sell below cost",
        cancelLabel: "Go back",
        tone: "danger",
      };
    default:
      return { title: "Continue with this bill?", message: fromServer, confirmLabel: "Continue", cancelLabel: "Go back", tone: "danger" };
  }
};

/**
 * The optional reason asked after a re-dated bill is confirmed. Its Cancel never stopped checkout:
 * the old prompt's Cancel saved the bill with the default reason. So the button says what it does,
 * "Skip", and skipping (or Esc, or an empty box) gives that same default.
 */
export const checkoutDateReasonDialog = (gate) => ({
  title: gate === CHECKOUT_GATE.FUTURE_DATE ? "Why the future date?" : "Why the earlier date?",
  message: "Optional. It is kept with the bill's history.",
  label: "Reason",
  defaultValue: DEFAULT_DATE_OVERRIDE_REASON[gate] || "",
  required: false,
  confirmLabel: "Save reason",
  cancelLabel: "Skip",
});

/** The reason the bill carries: what was typed, or the default when skipped or left empty. */
export const resolveDateOverrideReason = (gate, answer) => text(answer) || DEFAULT_DATE_OVERRIDE_REASON[gate] || "";

/**
 * Said when a gate stops a person who may not answer it. The zero-rate and below-cost gates used to
 * stop a Manager's checkout without a word; they still stop it, now saying why.
 */
export const checkoutGateRefusal = (gate) => {
  if (gate === CHECKOUT_GATE.ZERO_RATE) return "Only the Owner or an Admin can bill an item at a zero rate.";
  if (gate === CHECKOUT_GATE.BELOW_COST) return "Only the Owner or an Admin can bill an item below cost.";
  if (gate === CHECKOUT_GATE.FUTURE_DATE) return "Only the Owner or an Admin can save a bill with a future date.";
  if (gate === CHECKOUT_GATE.WALK_IN_CREDIT) return "Choose a saved customer account for a credit sale.";
  return "";
};
