"use strict";

/**
 * The arithmetic of a sale return, kept out of `server.js` so it can be driven directly.
 *
 * ## Quantities are counted in thousandths
 *
 * Quantities carry three decimals (NUMERIC(14,3)). Subtracting them as floats is wrong in the way
 * that matters: 0.3 - 0.1 is 0.19999999999999998, so a customer who bought 0.3 kg and returned 0.1
 * kg was refused when returning the remaining 0.2 kg. Every comparison and subtraction here is done
 * on whole thousandths, which are exact.
 *
 * ## Which batch a return goes back to
 *
 * A sale line can draw on several inventory batches (`sale_batch_allocations`). The rule is one
 * rule, used by the return and by the cancellation reversal alike: **returns consume a sale line's
 * allocations in allocation `id` order.** The quantity already returned from that line by earlier
 * returns is skipped first, so a second partial return lands on the batch the first one did not
 * already fill. Callers pass allocations already ordered by `id` (their SQL says `ORDER BY id`);
 * ids are opaque and are never compared or sorted here.
 *
 * ## What a return refunds
 *
 * `sale_items.net_amount` is the line after its own item discount and nothing else. The bill-level
 * invoice discount and the Mandi Tax live on `sales` (`invoice_discount_amount`, `tax_amount`) and
 * are not in any line. The customer paid `net - share of bill discount + share of tax` for a line,
 * so that is what a returned unit refunds. Other charges (delivery, crate, labour) are services
 * that were rendered whether or not the fruit comes back, so they are not refunded by default --
 * see `includeOtherCharges`.
 */

const QUANTITY_SCALE = 1000;

/** Refund types that leave the money with the shop as a credit the customer holds. */
const CUSTOMER_CREDIT_REFUND_TYPES = Object.freeze(["CREDIT_NOTE", "FUTURE_ADJUSTMENT"]);
/** Refund types that paid the money back there and then. */
const PAID_OUT_REFUND_TYPES = Object.freeze(["CASH_REFUND", "UPI_REFUND"]);
/** The same list for SQL, so every query that credits a customer for a return uses one rule. */
const CUSTOMER_CREDIT_REFUND_TYPES_SQL = `(${CUSTOMER_CREDIT_REFUND_TYPES.map((type) => `'${type}'`).join(", ")})`;

const SALE_HAS_RETURNS = Object.freeze({
  code: "SALE_HAS_RETURNS",
  message: "This bill already has a return, so it cannot be cancelled or edited. Return the remaining items instead.",
});

const roundCurrency = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

/** A number, or null for null/undefined/blank/non-numeric. Zero is a number. */
const finiteOrNull = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/** Whole thousandths of a quantity, or null when it is not a number. */
const toThousandths = (value) => {
  const number = finiteOrNull(value);
  return number === null ? null : Math.round(number * QUANTITY_SCALE);
};

const fromThousandths = (thousandths) => thousandths / QUANTITY_SCALE;

/** A requested return quantity, rounded to 3 decimals. Null unless it is positive after rounding. */
const normalizeReturnQuantity = (value) => {
  const thousandths = toThousandths(value);
  if (thousandths === null || thousandths <= 0) return null;
  return { thousandths, quantity: fromThousandths(thousandths) };
};

/** What is still returnable on a line, in thousandths, never negative. */
const returnableThousandths = (soldQuantity, returnedQuantity) => {
  const sold = toThousandths(soldQuantity) ?? 0;
  const returned = toThousandths(returnedQuantity) ?? 0;
  return Math.max(sold - returned, 0);
};

const returnableQuantity = (soldQuantity, returnedQuantity) =>
  fromThousandths(returnableThousandths(soldQuantity, returnedQuantity));

/**
 * Walk a line's allocations in the order given (id order), skip what earlier returns already took,
 * and return what is left on each allocation.
 */
const remainingAllocations = (allocations, alreadyReturnedQuantity) => {
  let skip = Math.max(toThousandths(alreadyReturnedQuantity) ?? 0, 0);
  return (allocations || []).map((allocation) => {
    const allocated = Math.max(toThousandths(allocation.quantity) ?? 0, 0);
    const skipped = Math.min(skip, allocated);
    skip -= skipped;
    const remaining = allocated - skipped;
    return { ...allocation, remaining_thousandths: remaining, remaining_quantity: fromThousandths(remaining) };
  });
};

/**
 * Which batches a return of `returnQuantity` restores, and what it costs.
 *
 * @returns {{ lines: Array<{allocation: object, inventory_batch_id: *, quantity: number, cost_amount: number}>,
 *             costAmount: number, unmappedThousandths: number }}
 *   `unmappedThousandths > 0` means the allocations cannot hold the return; the caller must refuse.
 */
const planReturnRestoration = ({ allocations, alreadyReturnedQuantity, returnQuantity }) => {
  let toRestore = Math.max(toThousandths(returnQuantity) ?? 0, 0);
  const lines = [];
  let costAmount = 0;
  for (const allocation of remainingAllocations(allocations, alreadyReturnedQuantity)) {
    if (toRestore <= 0) break;
    const take = Math.min(toRestore, allocation.remaining_thousandths);
    if (take <= 0) continue;
    const quantity = fromThousandths(take);
    const lineCost = roundCurrency(quantity * (finiteOrNull(allocation.purchase_rate) ?? 0));
    const { remaining_thousandths: _r, remaining_quantity: _q, ...original } = allocation;
    lines.push({ allocation: original, inventory_batch_id: allocation.inventory_batch_id, quantity, cost_amount: lineCost });
    costAmount = roundCurrency(costAmount + lineCost);
    toRestore -= take;
  }
  return { lines, costAmount, unmappedThousandths: toRestore };
};

/** A line's amount after its own item discount. `net_amount` wins whenever it is a number, 0 included. */
const lineNetAmount = (line) => {
  const net = finiteOrNull(line?.net_amount);
  if (net !== null) return net;
  const gross = finiteOrNull(line?.amount) ?? 0;
  const discount = finiteOrNull(line?.discount_amount) ?? 0;
  return gross - discount;
};

/**
 * What the customer actually paid for one sale line, before rounding.
 *
 * @param {object} args
 * @param {object} args.line       the sale_items row being returned
 * @param {object[]} args.saleLines every sale_items row of the bill (the line included)
 * @param {object} args.sale       the sales row (invoice_discount_amount, tax_amount, mandi_tax_basis)
 * @param {boolean} [args.includeOtherCharges=false] share sales.other_charges_amount into the line too
 */
const linePaidAmount = ({ line, saleLines, sale, includeOtherCharges = false }) => {
  const lines = Array.isArray(saleLines) && saleLines.length ? saleLines : [line];
  const lineNet = lineNetAmount(line);
  const subtotal = lines.reduce((sum, row) => sum + lineNetAmount(row), 0);
  const netShare = subtotal > 0 ? lineNet / subtotal : 0;

  const invoiceDiscount = finiteOrNull(sale?.invoice_discount_amount) ?? 0;
  const taxAmount = finiteOrNull(sale?.tax_amount) ?? 0;
  // Mandi Tax on a GROSS basis was charged on the lines before their item discounts, so the line's
  // share of it follows its gross amount. Every other basis is after item discounts.
  let taxShare = netShare;
  if (String(sale?.mandi_tax_basis || "").toUpperCase() === "GROSS_BEFORE_DISCOUNTS") {
    const grossOf = (row) => finiteOrNull(row?.amount) ?? lineNetAmount(row);
    const grossTotal = lines.reduce((sum, row) => sum + grossOf(row), 0);
    taxShare = grossTotal > 0 ? grossOf(line) / grossTotal : 0;
  }
  const charges = includeOtherCharges ? (finiteOrNull(sale?.other_charges_amount) ?? 0) * netShare : 0;
  return Math.max(lineNet - invoiceDiscount * netShare + taxAmount * taxShare + charges, 0);
};

/**
 * Refund for one unit of a line, to 6 decimals. The preview and the save both multiply this by the
 * returned quantity and round to 2, so they agree to the paisa.
 * Null when the line has no usable sold quantity -- never a silent 0.
 */
const refundPerUnit = (args) => {
  const soldThousandths = toThousandths(args?.line?.quantity);
  if (soldThousandths === null || soldThousandths <= 0) return null;
  const perUnit = linePaidAmount(args) / fromThousandths(soldThousandths);
  return Math.round(perUnit * 1e6) / 1e6;
};

const refundAmountFor = (perUnit, quantity) => roundCurrency(perUnit * quantity);

/** The first sale_item_id that appears twice in a return request, or null. Compared as written ids. */
const findDuplicateSaleItemId = (items) => {
  const seen = new Set();
  for (const item of items || []) {
    const key = String(item?.sale_item_id ?? "").trim();
    if (!key) continue;
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return null;
};

/** Today's date in India. The server runs in UTC, which is yesterday until 05:30 IST. */
const IST_OFFSET_MINUTES = 330;
const indiaBusinessDateKey = (now = new Date()) =>
  new Date(now.getTime() + IST_OFFSET_MINUTES * 60 * 1000).toISOString().slice(0, 10);

const isRealDateKey = (text) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === text;
};

/**
 * The return date to record.
 *
 * @returns {{ date: string } | { error: string }}
 */
const resolveReturnDate = (value, { today = indiaBusinessDateKey(), saleDate = null } = {}) => {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    return { date: today };
  }
  const text = typeof value === "string" ? value.trim() : "";
  if (!isRealDateKey(text)) return { error: "Enter the return date as YYYY-MM-DD." };
  if (text > today) return { error: "Return date cannot be in the future." };
  if (saleDate && isRealDateKey(saleDate) && text < saleDate) {
    return { error: "Return date cannot be before the bill date." };
  }
  return { date: text };
};

const isCustomerCreditRefund = (refundType) =>
  CUSTOMER_CREDIT_REFUND_TYPES.includes(String(refundType || "").toUpperCase());

/** Id as a Map key without coercing it to a number. Null/undefined/blank is "". */
const idKey = (value) => (value === null || value === undefined ? "" : String(value).trim());

/**
 * The customer pending-bills ledger: each CREDIT bill's balance after what was paid on it, the
 * customer's on-account receipts, and credit-note returns.
 *
 * Order of settlement per bill: (1) payments on the bill, (2) credit-note returns against that very
 * bill, (3) the customer's on-account receipts, (4) the customer's other credit-note returns
 * (against cash bills, or the part of a bill's return larger than its balance). Bills are walked in
 * the order given (customer, then date). Receipts and returns are kept apart so "Received" never
 * contains money that was a return.
 *
 * On-account receipts settle the customer's opening balance before any bill: it is the oldest debt,
 * and Accounts (`getCustomerSummaryRows`) counts it, so spending those receipts on bills instead
 * showed bills as paid while Accounts still showed the customer owing.
 *
 * @param {object[]} rows                 credit sales, as the route selects them
 * @param {Map<string, number>} receiptsByCustomer  idKey(customer_id) -> on-account receipts
 * @param {object[]} returnCredits        { sale_id, customer_id, credit_amount } for CREDIT_NOTE /
 *                                        FUTURE_ADJUSTMENT returns of non-cancelled sales
 * @param {Map<string, number>} openingBalanceByCustomer  idKey(customer_id) -> opening balance
 */
const buildCustomerPendingBills = (rows, {
  receiptsByCustomer = new Map(),
  returnCredits = [],
  openingBalanceByCustomer = new Map(),
} = {}) => {
  const returnBySale = new Map();
  const creditSaleIds = new Set((rows || []).map((row) => idKey(row.id)));
  const returnPool = new Map();
  const addToPool = (customerKey, amount) => {
    if (!customerKey || !(amount > 0)) return;
    returnPool.set(customerKey, roundCurrency((returnPool.get(customerKey) || 0) + amount));
  };
  for (const credit of returnCredits || []) {
    const amount = finiteOrNull(credit.credit_amount) ?? 0;
    if (!(amount > 0)) continue;
    const saleKey = idKey(credit.sale_id);
    if (creditSaleIds.has(saleKey)) {
      returnBySale.set(saleKey, roundCurrency((returnBySale.get(saleKey) || 0) + amount));
    } else {
      addToPool(idKey(credit.customer_id), amount);
    }
  }
  // A return bigger than its own bill's remaining balance leaves credit for the customer's other bills.
  const appliedOnBill = new Map();
  for (const row of rows || []) {
    const saleKey = idKey(row.id);
    const onBill = returnBySale.get(saleKey) || 0;
    const open = Math.max((finiteOrNull(row.total_amount) ?? 0) - (finiteOrNull(row.sale_paid) ?? 0), 0);
    const applied = roundCurrency(Math.min(onBill, open));
    appliedOnBill.set(saleKey, applied);
    addToPool(idKey(row.customer_id), roundCurrency(onBill - applied));
  }

  const remainingReceipts = new Map();
  for (const [key, amount] of receiptsByCustomer) {
    const receipts = finiteOrNull(amount) ?? 0;
    const opening = Math.max(finiteOrNull(openingBalanceByCustomer.get(key)) ?? 0, 0);
    remainingReceipts.set(key, roundCurrency(Math.max(receipts - opening, 0)));
  }

  const invoices = [];
  const summaries = new Map();
  for (const row of rows || []) {
    const customerKey = idKey(row.customer_id);
    const key = customerKey || String(row.customer_name || "Walk-in Customer");
    const total = finiteOrNull(row.total_amount) ?? 0;
    const salePaid = finiteOrNull(row.sale_paid) ?? 0;
    const summary = summaries.get(key) || {
      key,
      customer_id: customerKey ? row.customer_id : null,
      customer_name: row.customer_name || "Walk-in Customer",
      from: row.sale_date,
      to: row.sale_date,
      pending_bill_count: 0,
      total_credit_amount: 0,
      amount_received: 0,
      amount_returned: 0,
      balance: 0,
      rows: [],
    };
    const returnedOnBill = appliedOnBill.get(idKey(row.id)) || 0;
    let open = Math.max(total - salePaid - returnedOnBill, 0);
    const receipts = customerKey ? (remainingReceipts.get(customerKey) || 0) : 0;
    const fromReceipts = roundCurrency(Math.min(receipts, open));
    if (customerKey) remainingReceipts.set(customerKey, roundCurrency(receipts - fromReceipts));
    open = Math.max(open - fromReceipts, 0);
    const pool = customerKey ? (returnPool.get(customerKey) || 0) : 0;
    const fromPool = roundCurrency(Math.min(pool, open));
    if (customerKey) returnPool.set(customerKey, roundCurrency(pool - fromPool));

    const received = roundCurrency(salePaid + fromReceipts);
    const returned = roundCurrency(returnedOnBill + fromPool);
    const balance = roundCurrency(Math.max(total - received - returned, 0));
    const status = balance <= 0.01 ? "Paid" : (received > 0 || returned > 0) ? "Partially Paid" : "Pending";
    const invoice = {
      ...row,
      customer_id: customerKey ? row.customer_id : null,
      gross_amount: finiteOrNull(row.gross_amount) ?? total,
      item_discount_amount: finiteOrNull(row.item_discount_amount) ?? 0,
      invoice_discount_amount: finiteOrNull(row.invoice_discount_amount) ?? 0,
      total_amount: total,
      received_amount: received,
      returned_amount: returned,
      balance_amount: balance,
      credit_status: status,
    };
    invoices.push(invoice);
    if (balance > 0.01) summary.pending_bill_count += 1;
    summary.from = row.sale_date < summary.from ? row.sale_date : summary.from;
    summary.to = row.sale_date > summary.to ? row.sale_date : summary.to;
    summary.total_credit_amount = roundCurrency(summary.total_credit_amount + total);
    summary.amount_received = roundCurrency(summary.amount_received + received);
    summary.amount_returned = roundCurrency(summary.amount_returned + returned);
    summary.balance = roundCurrency(summary.balance + balance);
    summary.rows.push(invoice);
    summaries.set(key, summary);
  }
  const summary = [...summaries.values()]
    .filter((entry) => entry.balance > 0.01)
    .sort((left, right) => left.customer_name.localeCompare(right.customer_name));
  return { summary, invoices };
};

module.exports = {
  CUSTOMER_CREDIT_REFUND_TYPES,
  CUSTOMER_CREDIT_REFUND_TYPES_SQL,
  PAID_OUT_REFUND_TYPES,
  QUANTITY_SCALE,
  SALE_HAS_RETURNS,
  buildCustomerPendingBills,
  finiteOrNull,
  findDuplicateSaleItemId,
  fromThousandths,
  indiaBusinessDateKey,
  isCustomerCreditRefund,
  lineNetAmount,
  linePaidAmount,
  normalizeReturnQuantity,
  planReturnRestoration,
  refundAmountFor,
  refundPerUnit,
  remainingAllocations,
  resolveReturnDate,
  returnableQuantity,
  returnableThousandths,
  toThousandths,
};
