/**
 * Report Center's financial statements: what the P&L, the Supplier Ledger and the Balance Sheet
 * show, worked out away from App.jsx so it can be tested.
 */

const figure = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};
// A number the server actually sent: null, undefined and "" are "not sent", not 0.
const present = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
const round2 = (value) => Math.round((figure(value) + Number.EPSILON) * 100) / 100;

const CHARGE_LINES = Object.freeze([
  ["Mandi Tax", "mandiTax"],
  ["Freight", "freightCharges"],
  ["Labour", "labourCharges"],
  ["Other Purchase Charges", "otherPurchaseCharges"],
]);

/**
 * The cost-of-goods-sold block of the P&L.
 *
 * Purchase cost is landed: a sale is costed at the lot's effective cost, which already holds its
 * share of mandi tax, freight, labour, other charges and the bill rebate. When the server says so
 * (`purchaseChargesIncludedInCost`), those charges are listed apart, for information, and are not
 * cost rows, so the lines above TOTAL COGS add up to it (UI-1). A server that does not say so gets
 * the old layout, charges as cost rows.
 *
 * Returns `{ costLines, includedLines, cogs }`; each line is `{ label, value }`.
 */
export const profitLossCostOfGoods = (profitLoss = {}) => {
  const pl = profitLoss || {};
  const purchaseCost = figure(pl.purchaseCost);
  const supplierRebateReceived = figure(pl.supplierRebateReceived);
  const charges = CHARGE_LINES.map(([label, key]) => ({ label, value: figure(pl[key]) }));
  const rebateLine = { label: "Less Supplier Rebate Received", value: -supplierRebateReceived };
  if (pl.purchaseChargesIncludedInCost === true) {
    const includedLines = [...charges];
    if (present(pl.purchaseBillRebate)) {
      includedLines.push({ label: "Less Bill Rebate", value: -figure(pl.purchaseBillRebate) });
    }
    const computed = purchaseCost - supplierRebateReceived;
    const cogs = present(pl.costOfGoodsSold) ? figure(pl.costOfGoodsSold) : computed;
    return {
      costLines: [{ label: "Purchase Cost (landed)", value: purchaseCost }, rebateLine],
      includedLines,
      cogs: round2(cogs),
    };
  }
  const computed = purchaseCost + charges.reduce((sum, line) => sum + line.value, 0) - supplierRebateReceived;
  const cogs = present(pl.costOfGoodsSold) ? figure(pl.costOfGoodsSold) : computed;
  return {
    costLines: [{ label: "Purchase Cost", value: purchaseCost }, ...charges, rebateLine],
    includedLines: [],
    cogs: round2(cogs),
  };
};

export const INCLUDED_IN_COST_HEADING = "Included in purchase cost (for information)";

/**
 * The Supplier Ledger's balance brought forward (UI-10).
 *
 * `ledgerOpeningBalances` is the server's list of b/f rows, one per supplier; `null` (or missing)
 * means it could not be read, which is not the same as "nothing brought forward" and must not be
 * shown as 0. Only the suppliers the ledger is showing count: one when an account is chosen, every
 * supplier otherwise. A search, voucher-type or payment-mode filter shows part of each account, so no b/f
 * applies and the balance is of the rows shown.
 *
 * Returns `{ status: "ready" | "unavailable" | "partial", rows, total }`; `total` is null unless
 * ready. A positive total is owed to suppliers (payable, Cr).
 */
export const supplierLedgerOpening = (ledgerOpeningBalances, { accountType = "", accountName = "", voucherType = "", paymentMode = "", search = "" } = {}) => {
  if (voucherType || paymentMode || String(search || "").trim() || (accountType && accountType !== "SUPPLIER")) {
    return { status: "partial", rows: [], total: null };
  }
  if (!Array.isArray(ledgerOpeningBalances)) return { status: "unavailable", rows: [], total: null };
  const rows = ledgerOpeningBalances
    .filter((row) => row && String(row.account_type || "SUPPLIER").toUpperCase() === "SUPPLIER")
    .filter((row) => !accountName || row.party_name === accountName)
    .map((row) => ({ ...row, is_opening: true }));
  const total = round2(rows.reduce((sum, row) => sum + figure(row.credit) - figure(row.debit), 0));
  return { status: "ready", rows, total };
};

/**
 * Ledger rows with a running balance, newest first, the way Report Center lists them.
 *
 * `opening` (b/f rows) are counted first and listed last (oldest). With `openingUnavailable` the
 * balance cannot be known, so every running balance is null rather than a figure counted from 0.
 * `mode` "PAYABLE" runs credit − debit; anything else debit − credit.
 */
export const ledgerWithRunningBalance = (rows = [], { mode = "RECEIVABLE", opening = [], openingUnavailable = false, dateKey = (value) => String(value || "").slice(0, 10) } = {}) => {
  const sign = (row) => (mode === "PAYABLE" ? figure(row.credit) - figure(row.debit) : figure(row.debit) - figure(row.credit));
  const compareAsc = (left, right) => dateKey(left.date).localeCompare(dateKey(right.date)) || String(left.voucher_no || "").localeCompare(String(right.voucher_no || ""));
  const ordered = [...(opening || []).map((row) => ({ ...row, is_opening: true })), ...[...(rows || [])].sort(compareAsc)];
  let balance = 0;
  const withBalance = ordered.map((row) => {
    balance = round2(balance + sign(row));
    return { ...row, running_balance: openingUnavailable ? null : balance };
  });
  const openingRows = withBalance.filter((row) => row.is_opening);
  const periodRows = withBalance.filter((row) => !row.is_opening).reverse();
  return [...periodRows, ...openingRows.reverse()];
};

/**
 * The single date the Balance Sheet is as at, for its one date input: the custom date when one is
 * chosen, otherwise the last day of the named range, so the input always shows the date in force.
 */
export const balanceSheetAsAtInput = ({ range = "today", customRange = {}, resolve } = {}) => {
  if (range === "custom") return String(customRange?.date_to || customRange?.date_from || "");
  try {
    return String(resolve?.({ range })?.date_to || "");
  } catch {
    return "";
  }
};

/**
 * The Opening and Closing Balance printed on an Accounts ledger statement for a date range.
 *
 * The server builds every ledger (customer and supplier alike) as a running `balance` that grows
 * by `debit − credit`, oldest first, with an "Opening Balance" row first when the account has one.
 * So the balance brought forward into the range is the first shown row's balance with its own
 * debit and credit taken back out — the formula the screen already used, which is right.
 *
 * What was wrong is what it did with nothing to go on: with no account chosen, and with a range
 * holding no entries, both figures printed ₹0.00, even for an account owing thousands. Now:
 * - no account: `null` for both (the screen prints "—");
 * - a range with no entries: the balance carried in from before the range, for both;
 * - otherwise opening from the first row in range, closing from the last.
 *
 * `rows` is the full ledger as the server sent it; `dateKey` turns a row date into YYYY-MM-DD.
 */
export const ledgerStatementBounds = (rows, { dateFrom = "", dateTo = "", hasAccount = true, dateKey = (value) => String(value || "").slice(0, 10) } = {}) => {
  if (!hasAccount || !Array.isArray(rows)) return { opening: null, closing: null };
  const inRange = (row) => (!dateFrom || dateKey(row.date) >= dateFrom) && (!dateTo || dateKey(row.date) <= dateTo);
  const shown = rows.filter(inRange);
  if (shown.length) {
    const first = shown[0];
    return {
      opening: round2(figure(first.balance) - figure(first.debit) + figure(first.credit)),
      closing: round2(figure(shown.at(-1).balance)),
    };
  }
  const before = dateFrom ? rows.filter((row) => dateKey(row.date) < dateFrom) : [];
  const carried = before.length ? round2(figure(before.at(-1).balance)) : 0;
  return { opening: carried, closing: carried };
};
