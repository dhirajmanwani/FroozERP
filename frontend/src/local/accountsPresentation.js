/**
 * How the Accounts screens present money they may not have.
 *
 * CLAUDE.md: errors must never render as zero. The Outstanding tab used to start from
 * `{ totalReceivable: 0, totalPayable: 0 }` and a failed load left those zeros on screen, so "the
 * read failed" and "nobody owes anything" looked the same. And the payment preview clamped the
 * balance after payment at zero, so paying more than is owed showed a tidy ₹0.00 instead of the
 * advance it would actually create.
 */
import { inventoryIdsEqual } from "./stockInventory.js";

const finite = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

/**
 * The Outstanding tab's state. `outstanding` is null until a load has answered; an object without
 * both totals (an empty offline bundle, `{}`) is "not available", never zero.
 */
export const resolveOutstandingPresentation = (outstanding, error = "") => {
  const message = String(error || "").trim();
  if (message) return { kind: "error", message: `Outstanding balances could not be loaded: ${message}` };
  if (outstanding === null || outstanding === undefined) return { kind: "loading", message: "Loading outstanding balances…" };
  const receivable = finite(outstanding.totalReceivable);
  const payable = finite(outstanding.totalPayable);
  if (receivable === null || payable === null) {
    return { kind: "unavailable", message: "Outstanding balances are not available on this computer yet. They load from the server." };
  }
  return {
    kind: "ready",
    totalReceivable: receivable,
    totalPayable: payable,
    customerOutstanding: Array.isArray(outstanding.customerOutstanding) ? outstanding.customerOutstanding : [],
    supplierOutstanding: Array.isArray(outstanding.supplierOutstanding) ? outstanding.supplierOutstanding : [],
  };
};

/**
 * The balance a payment leaves behind, signed. A negative result is an advance (the customer or
 * the shop has paid more than was owed), and is reported as such rather than clamped to zero.
 */
export const paymentBalancePreview = ({ outstandingBefore = 0, payment = 0, rebate = 0 } = {}) => {
  const before = finite(outstandingBefore) ?? 0;
  const settled = (finite(payment) ?? 0) + (finite(rebate) ?? 0);
  const after = roundMoney(before - settled);
  const excess = after < 0 ? roundMoney(-after) : 0;
  return { after, overpaid: excess > 0, excess };
};

export const overpaymentWarning = (preview, { supplier = false } = {}) => {
  if (!preview?.overpaid) return "";
  const amount = preview.excess.toFixed(2);
  return supplier
    ? `This is ₹${amount} more than is owed to this supplier. Check the amount before saving.`
    : `This is ₹${amount} more than this customer owes. Check the amount before saving.`;
};

const text = (value) => String(value ?? "").trim();
const lowered = (value) => text(value).toLowerCase();

/**
 * The customer account a report row belongs to.
 *
 * In order: the same id (canonical, never `Number()` — "004" and 4 are different customers), then
 * the same mobile, then the same name, then the walk-in account for a walk-in sale. Each step runs
 * over the whole list before the next starts, so a name shared with another customer can never
 * win over an exact id match further down the list.
 */
export const findSaleCustomer = (customers = [], sale = {}) => {
  const rows = Array.isArray(customers) ? customers : [];
  const ids = [sale?.customer_id, sale?.customer_account_id, sale?.customer_global_id].filter((value) => text(value));
  if (ids.length) {
    const byId = rows.find((item) => ids.some((id) => inventoryIdsEqual(item?.id, id) || inventoryIdsEqual(item?.global_id, id)));
    if (byId) return byId;
  }
  const mobile = text(sale?.customer_mobile);
  if (mobile) {
    const byMobile = rows.find((item) => text(item?.mobile_number) === mobile);
    if (byMobile) return byMobile;
  }
  const name = lowered(sale?.customer_name);
  if (name) {
    const byName = rows.find((item) => lowered(item?.customer_name) === name);
    if (byName) return byName;
    if (name.includes("walk-in")) return rows.find((item) => item?.system_account === true) || null;
  }
  return null;
};
