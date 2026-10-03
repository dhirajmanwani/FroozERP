import { labelFor } from "./displayLabels.js";

/**
 * POS payment confirmation: "Has the customer paid?" before a bill is saved, and the UPI QR that
 * goes with it.
 *
 * ## Why this is not in App.jsx
 *
 * The till used to save a bill the moment Checkout was pressed, and the only UPI QR was the one on
 * the printed invoice. That QR was decided by
 *
 *   enabled && upiId && (hasUpiPayment || showOnAllBills || enabled)
 *
 * whose trailing `|| enabled` is always true once the first `enabled` passed, so every bill —
 * cash, card, credit — printed a QR, and it always asked for the full bill total, so a mixed bill
 * of ₹400 UPI + ₹56 cash asked the customer's phone for ₹456.
 *
 * Here, as pure functions:
 *
 *   - `buildPosPayments` is the payment rows Checkout already built, with the same error text and
 *     the same ₹0.01 tolerance, so the server sees exactly what it saw before;
 *   - `upiQrAmount` is the UPI part of a bill — all of a UPI bill, only the UPI row of a mixed one,
 *     nothing for cash, card, bank transfer or credit — for a POS draft and a saved invoice alike;
 *   - `buildUpiPayload` is the `upi://pay?` string, field for field what InvoiceModal wrote;
 *   - `resolveInvoiceUpiQr` is the invoice QR decision without the always-true clause;
 *   - `describePaymentConfirmation` is what the confirm dialog says. A UPI amount that is due but
 *     cannot be shown as a QR (no UPI ID in Settings) is said in a note, never silently dropped.
 *
 * Money is INR, rounded to 2 decimals in paise so 0.1 + 0.2 never prints ₹0.30000000000000004.
 * A missing or unreadable amount is never treated as ₹0: it means "no QR", and the dialog says why.
 */

export const DEFAULT_UPI_PAYEE_NAME = "FEEL THE FREAKIN' FROOZ";

/** The four rows a mixed bill can be split into at the till (App.jsx `mixedPaymentModes`). */
export const MIXED_PAYMENT_MODES = Object.freeze(["CASH", "UPI", "CARD", "BANK_TRANSFER"]);

/** Same text Checkout alerted before this module existed; the server refuses the same mismatch. */
export const PAYMENT_MISMATCH_ERROR = "Payment amounts must match the tax-inclusive invoice total.";
export const PAYMENT_TOTAL_UNREADABLE_ERROR = "The bill total could not be read, so this bill cannot be paid. Check the cart and try again.";
const PAYMENT_TOLERANCE = 0.01;

/** Payment rows that no longer count (same rule as invoiceLayout's `buildPayment`). */
const VOID_PAYMENT = /CANCEL|VOID|REVERS|FAIL/i;

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const modeOf = (value) => text(value).toUpperCase();

const readAmount = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
};

const toPaise = (value) => Math.round(value * 100 + (value >= 0 ? 1e-7 : -1e-7));
const fromPaise = (paise) => paise / 100;
const roundMoney = (value) => fromPaise(toPaise(value));

const RUPEE_FORMAT = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** ₹1,234.50 — en-IN grouping, 2 decimals. An unreadable amount is "₹—", never "₹0.00". */
export const formatRupees = (value) => {
  const amount = readAmount(value);
  return amount === null ? "₹—" : `₹${RUPEE_FORMAT.format(roundMoney(amount))}`;
};

/**
 * The payment rows Checkout sends. MIXED: one row per mode typed above zero, in the order the
 * till keeps them; anything else: one row for the whole total. Then the rows must add up to the
 * total within ₹0.01.
 *
 * Identical to the App.jsx code it replaces, with one addition: a total that is not a finite
 * number used to slip through (NaN never compares greater than the tolerance) and is now refused.
 *
 * @returns {{ payments: Array<{ mode: string, amount: number }>, error: string | null }}
 */
export const buildPosPayments = ({ paymentMode, mixedPayments, total } = {}) => {
  const payments = paymentMode === "MIXED"
    ? Object.entries(mixedPayments || {})
      .filter(([, amount]) => Number(amount) > 0)
      .map(([mode, amount]) => ({ mode, amount: Number(amount) }))
    : [{ mode: paymentMode, amount: total }];
  if (!Number.isFinite(Number(total)) || total === null || total === undefined || total === "") {
    return { payments, error: PAYMENT_TOTAL_UNREADABLE_ERROR };
  }
  const paidAmount = payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
  if (Math.abs(paidAmount - total) > PAYMENT_TOLERANCE) {
    return { payments, error: PAYMENT_MISMATCH_ERROR };
  }
  return { payments, error: null };
};

/** Live rows with their mode upper-cased; `mode` (POS draft) or `payment_mode` (saved invoice). */
const liveRows = (payments) => (Array.isArray(payments) ? payments : [])
  .filter((payment) => payment && !VOID_PAYMENT.test(text(payment.status)))
  .map((payment) => ({ mode: modeOf(payment.mode || payment.payment_mode), amount: readAmount(payment.amount) }))
  .filter((payment) => payment.mode);

/**
 * The UPI part of the rows: { paise, unreadable }. `unreadable` is set when a UPI row exists but
 * its amount cannot be read, so the caller can say so instead of showing a QR for less.
 */
const upiPortion = (payments) => {
  let paise = 0;
  let unreadable = false;
  let found = false;
  for (const row of liveRows(payments)) {
    if (row.mode !== "UPI") continue;
    found = true;
    if (row.amount === null) unreadable = true;
    else paise += toPaise(row.amount);
  }
  return { found, paise, unreadable };
};

const upiAmountDetail = ({ paymentMode, payments } = {}) => {
  const mode = modeOf(paymentMode);
  // Cash, card, bank transfer and credit bills have nothing to collect by UPI. A blank mode
  // (a payload with rows but no header mode) is read from the rows themselves.
  if (mode && mode !== "UPI" && mode !== "MIXED") return { amount: null, unreadable: false };
  const portion = upiPortion(payments);
  if (portion.unreadable) return { amount: null, unreadable: true };
  if (portion.paise <= 0) return { amount: null, unreadable: false };
  return { amount: fromPaise(portion.paise), unreadable: false };
};

/**
 * What the customer pays by UPI, rounded to 2 decimals, or null when nothing is due by UPI.
 * UPI bill: the UPI row(s). MIXED: only the UPI row(s). Any other mode: null. Zero, negative or
 * unreadable: null (no QR) — never a QR for ₹0.
 */
export const upiQrAmount = ({ paymentMode, payments } = {}) => upiAmountDetail({ paymentMode, payments }).amount;

/**
 * The `upi://pay?` string the QR encodes: pa, pn, am, cu, tn — same order and encoding as the
 * invoice QR always used. "" when there is no UPI ID or no positive amount, so no QR is drawn.
 */
export const buildUpiPayload = ({ upiId, payeeName, amount, note } = {}) => {
  const payeeId = text(upiId);
  const value = readAmount(amount);
  if (!payeeId || value === null || value <= 0) return "";
  const parts = [
    "upi://pay?",
    `pa=${encodeURIComponent(payeeId)}`,
    `&pn=${encodeURIComponent(payeeName || DEFAULT_UPI_PAYEE_NAME)}`,
    `&am=${encodeURIComponent(roundMoney(value).toFixed(2))}`,
    "&cu=INR",
  ];
  const noteText = text(note);
  if (noteText) parts.push(`&tn=${encodeURIComponent(noteText)}`);
  return parts.join("");
};

/** The note InvoiceModal put on the QR: `FroozERP-Invoice-<invoice no or id>`. */
export const invoiceUpiNote = (invoice = {}) => `FroozERP-Invoice-${(invoice && (invoice.invoice_no || invoice.id)) || ""}`;

const invoiceQr = (show, amount, reason) => Object.freeze({ show, amount, reason });

/**
 * Whether a saved invoice prints a UPI QR, and for how much.
 *
 *   QR_DISABLED          `enable_upi_qr_on_invoice` is not true (default off)
 *   NO_UPI_ID            no business UPI ID in Settings
 *   UPI_DUE              the bill has a UPI part: the QR asks for that part only
 *   ALL_BILLS            no UPI part, but `show_upi_qr_on_all_bills`: the QR asks for the total
 *   UPI_AMOUNT_UNKNOWN   a UPI row (or a MIXED bill with no rows) whose amount cannot be read
 *   INVALID_TOTAL        show-on-all-bills, but the bill total is not a positive number
 *   NO_UPI_DUE           cash, card, bank transfer or credit, and not show-on-all-bills
 */
export const resolveInvoiceUpiQr = ({ paymentSettings, invoice } = {}) => {
  const settings = paymentSettings || {};
  const sale = invoice || {};
  if (settings.enable_upi_qr_on_invoice !== true) return invoiceQr(false, null, "QR_DISABLED");
  if (!text(settings.business_upi_id)) return invoiceQr(false, null, "NO_UPI_ID");

  const rows = liveRows(sale.payments);
  const headerMode = modeOf(sale.payment_mode);
  let upiAmount = null;
  let unknown = false;
  if (rows.length > 0) {
    // The rows are what was actually taken; the header mode is only a summary of them.
    const portion = upiPortion(sale.payments);
    if (portion.unreadable) unknown = true;
    else if (portion.paise > 0) upiAmount = fromPaise(portion.paise);
  } else if (headerMode === "UPI") {
    const total = readAmount(sale.total_amount);
    if (total === null) unknown = true;
    else if (total > 0) upiAmount = roundMoney(total);
  } else if (headerMode === "MIXED") {
    // A split bill with no rows: the UPI share is not known, and the total would overcharge.
    unknown = true;
  }

  if (upiAmount !== null) return invoiceQr(true, upiAmount, "UPI_DUE");
  if (settings.show_upi_qr_on_all_bills === true) {
    const total = readAmount(sale.total_amount);
    if (total === null || total <= 0) return invoiceQr(false, null, "INVALID_TOTAL");
    return invoiceQr(true, roundMoney(total), "ALL_BILLS");
  }
  return invoiceQr(false, null, unknown ? "UPI_AMOUNT_UNKNOWN" : "NO_UPI_DUE");
};

/**
 * What the "Has the customer paid?" dialog says after Checkout, before anything is saved.
 *
 * kind "CREDIT" for an udhaar bill (no QR, the dialog confirms the credit sale); "PAID" for
 * everything else. `qrAmount` is the UPI part when a UPI ID is configured, else null; when UPI is
 * due but cannot be shown, `note` says why. `rows` lists every payment row with its label.
 */
export const describePaymentConfirmation = ({ paymentMode, payments, total, upiConfigured } = {}) => {
  const mode = modeOf(paymentMode);
  const rows = Object.freeze(liveRows(payments).map((row) => Object.freeze({
    mode: row.mode,
    label: labelFor("paymentMode", row.mode),
    amount: row.amount === null ? null : roundMoney(row.amount),
  })));
  const totalText = formatRupees(total);
  const isCredit = mode === "CREDIT" || (!mode && rows.length > 0 && rows.every((row) => row.mode === "CREDIT"));

  if (isCredit) {
    return Object.freeze({
      kind: "CREDIT",
      title: `Save ${totalText} as a credit (udhaar) bill?`,
      rows,
      qrAmount: null,
      primaryLabel: "Save credit bill",
      secondaryLabel: "Not yet",
      note: `Nothing is collected now. ${totalText} is added to the customer's balance.`,
    });
  }

  const upi = upiAmountDetail({ paymentMode, payments });
  let note = null;
  let qrAmount = null;
  if (upi.unreadable) {
    note = "The UPI amount on this bill could not be read, so no QR can be shown. Check the payment split.";
  } else if (upi.amount !== null) {
    if (upiConfigured === true) {
      qrAmount = upi.amount;
    } else {
      note = `The UPI ID is not set in Settings > UPI, Payment QR, so no QR can be shown. Collect ${formatRupees(upi.amount)} by UPI another way.`;
    }
  }

  return Object.freeze({
    kind: "PAID",
    title: `Has the customer paid ${totalText}?`,
    rows,
    qrAmount,
    primaryLabel: "Paid – save bill",
    secondaryLabel: "Not yet",
    note,
  });
};
