/**
 * Money totals in Report Center's sales and payment reports.
 *
 * - **Card is bank money.** "Total UPI / Bank" counted UPI, BANK and BANK_TRANSFER and left CARD
 *   out, so card takings were in no tile at all.
 * - **Mixed bills split by their payments.** A bill paid partly in cash and partly by UPI carries a
 *   `payments` array; each part goes to its own tile. A row without one falls back to its single
 *   `payment_mode` as before.
 * - **Gross is gross.** "Gross Total" read `gross_total || total_amount`, and the report rows carry
 *   `gross_amount`, so the tile showed the net figure under the gross label.
 * - **Cancelled payments are not money in.** The Payment Report summed every row, cancelled ones
 *   included, where the Expense Report beside it already left them out.
 */

export const CASH_PAYMENT_MODES = Object.freeze(["CASH"]);
export const UPI_BANK_PAYMENT_MODES = Object.freeze(["UPI", "BANK", "BANK_TRANSFER", "CARD"]);

const amountOf = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const pickFinite = (...values) => {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
};

/** The payments a sale was settled with: its own split when it has one, else its single mode. */
export const salePaymentParts = (row = {}) => {
  if (Array.isArray(row.payments) && row.payments.length) return row.payments;
  if (Array.isArray(row.payment_allocations) && row.payment_allocations.length) return row.payment_allocations;
  return [{ mode: row.payment_mode || "UNKNOWN", amount: amountOf(row.total_amount || row.net_total) }];
};

/** How much of a sale was paid in any of `modes`. */
export const salePaymentAmountIn = (row, modes = []) => {
  const wanted = new Set(modes.map((mode) => String(mode).toUpperCase()));
  return salePaymentParts(row).reduce((sum, payment) => {
    const mode = String(payment?.mode || payment?.payment_mode || "").toUpperCase();
    return wanted.has(mode) ? sum + amountOf(payment?.amount ?? payment?.payment_amount) : sum;
  }, 0);
};

/** A sale's gross (before discounts). `gross_amount` first; zero is a real gross, not "missing". */
export const saleGrossAmount = (row = {}) => pickFinite(row.gross_amount, row.gross_total, row.total_amount) ?? 0;

/**
 * Cash, UPI/Bank and Gross for the invoices on screen. When an invoice is shown only in part (an
 * item or search filter narrowed it), its gross is the sum of the items shown, through `itemGross`,
 * so the tile agrees with the rows under it.
 */
export const salesHistoryMoneyTotals = (invoices = [], { itemGross = () => 0 } = {}) => {
  let cash = 0;
  let upiBank = 0;
  let gross = 0;
  for (const row of Array.isArray(invoices) ? invoices : []) {
    cash += salePaymentAmountIn(row, CASH_PAYMENT_MODES);
    upiBank += salePaymentAmountIn(row, UPI_BANK_PAYMENT_MODES);
    const visible = Array.isArray(row.visible_items) ? row.visible_items : null;
    const all = Array.isArray(row.all_items) ? row.all_items : null;
    gross += visible && all && visible.length < all.length
      ? visible.reduce((sum, item) => sum + amountOf(itemGross(item)), 0)
      : saleGrossAmount(row);
  }
  return { cash, upiBank, gross };
};

const isCancelledPayment = (row) => row?.cancelled === true || String(row?.status || "").toUpperCase() === "CANCELLED";

/** Payment Report tiles: active payments and rebates, with cancelled ones counted apart. */
export const paymentReportTotals = (rows = []) => {
  const list = Array.isArray(rows) ? rows : [];
  const active = list.filter((row) => !isCancelledPayment(row));
  const cancelled = list.filter(isCancelledPayment);
  return {
    payments: active.reduce((sum, row) => sum + amountOf(row.payment_amount), 0),
    rebates: active.reduce((sum, row) => sum + amountOf(row.rebate_amount), 0),
    cancelled: cancelled.reduce((sum, row) => sum + amountOf(row.payment_amount), 0),
    entries: list.length,
  };
};

/**
 * The Day Book's voucher type. A cancellation is tested first: "Customer Sale Cancellation" holds
 * "customer sale", and used to be labelled a POS Sale — the reversal shown as the sale itself.
 */
export const dayBookVoucherLabel = (row = {}) => {
  const original = row.transaction_type || row.voucher_type || "";
  const raw = String(original).toLowerCase();
  if (raw.includes("cancellation") || raw.includes("cancelled")) return String(original).trim();
  if (raw.includes("sale return")) return "Sale Return";
  if (raw.includes("customer sale") || raw === "sale" || raw.includes("pos sale")) return "POS Sale";
  if (raw.includes("supplier purchase") || raw === "purchase") return "Purchase";
  if (raw.includes("supplier payment")) return "Supplier Payment";
  if (raw.includes("customer payment") || raw.includes("customer receipt") || raw === "receipt") return "Customer Receipt";
  if (raw.includes("expense")) return "Expense";
  if (raw.includes("waste")) return "Waste";
  if (raw.includes("opening")) return "Opening Stock";
  if (raw.includes("adjust")) return "Stock Adjustment";
  if (raw.includes("capital")) return "Owner Capital";
  if (raw.includes("drawing")) return "Drawings";
  return original || "-";
};
