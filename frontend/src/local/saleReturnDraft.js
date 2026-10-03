// ---------------------------------------------------------------------------------------------
// Sale Returns screen (3 Oct 2026)
//
// What the Return Entry form may send, worked out before it is sent: which invoices can be picked,
// which quantities are valid, and what the refund will come to. The server checks all of it again;
// this exists so a wrong quantity is named on the screen instead of coming back as a refusal, and
// so a saved return can never be sent twice by a double click.
//
// Quantities carry 3 decimals and are compared in whole thousandths, so 0.3 - 0.1 leaves exactly
// 0.2 returnable, not 0.19999... Money rounds to 2.
// ---------------------------------------------------------------------------------------------

import { canonicalInventoryId } from "./stockInventory.js";

export const RETURN_INVOICE_LIST_LIMIT = 50;

const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

/**
 * A quantity typed in the form as whole thousandths, or `null` for an empty box. `NaN` for anything
 * that is not a plain non-negative number with at most 3 decimals.
 */
export const quantityToThousandths = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text === "") return null;
  if (!/^\d*(?:\.\d{0,3})?$/.test(text) || text === ".") return Number.NaN;
  const [whole = "0", fraction = ""] = text.split(".");
  return Number(whole || "0") * 1000 + Number((fraction + "000").slice(0, 3));
};

/** A server quantity (number or numeric string, up to 3 decimals) as whole thousandths. */
const serverThousandths = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 1000) : Number.NaN;
};

/**
 * What one unit of this line refunds: the server's `refund_per_unit` when it sends one, else the
 * line's net amount over the quantity sold. `null` when neither can be worked out, so the screen
 * says the value is unknown instead of showing a refund of zero.
 */
export const refundPerUnit = (item) => {
  const given = Number(item?.refund_per_unit);
  if (item?.refund_per_unit !== null && item?.refund_per_unit !== undefined && item?.refund_per_unit !== "" && Number.isFinite(given)) return given;
  const net = Number(item?.net_amount);
  const sold = Number(item?.sold_quantity);
  if (!Number.isFinite(net) || !Number.isFinite(sold) || sold <= 0) return null;
  return net / sold;
};

/**
 * The form as it stands: the lines that would be returned, their value, and every reason it cannot
 * be saved yet. `quantities` is keyed by the sale item id as typed into the form.
 */
export const buildSaleReturnDraft = ({ invoiceId = "", items = [], quantities = {}, reason = "" } = {}) => {
  const problems = [];
  const lines = [];
  const lineProblems = {};
  let total = 0;
  let totalKnown = true;
  for (const item of Array.isArray(items) ? items : []) {
    const key = canonicalInventoryId(item?.sale_item_id);
    if (key === "") continue;
    const typed = quantities?.[key];
    const wanted = quantityToThousandths(typed);
    if (wanted === null || wanted === 0) continue;
    const name = item?.product_name || "This item";
    if (Number.isNaN(wanted)) {
      lineProblems[key] = "Enter a number with up to 3 decimals.";
      problems.push(`${name}: enter a number with up to 3 decimals.`);
      continue;
    }
    const returnable = serverThousandths(item?.returnable_quantity);
    if (!Number.isFinite(returnable)) {
      lineProblems[key] = "How much can still be returned is unknown.";
      problems.push(`${name}: how much can still be returned is unknown. Pick the invoice again.`);
      continue;
    }
    if (wanted > returnable) {
      const left = (Math.max(returnable, 0) / 1000).toLocaleString("en-IN", { maximumFractionDigits: 3 });
      lineProblems[key] = `Only ${left} can be returned.`;
      problems.push(`${name}: only ${left} can still be returned.`);
      continue;
    }
    const quantity = wanted / 1000;
    const perUnit = refundPerUnit(item);
    const value = perUnit === null ? null : roundMoney(perUnit * quantity);
    if (value === null) totalKnown = false;
    else total += value;
    lines.push({ sale_item_id: item.sale_item_id, return_quantity: quantity, value, product_name: item?.product_name || "" });
  }
  if (canonicalInventoryId(invoiceId) === "") problems.unshift("Pick the invoice the goods came back from.");
  else if (lines.length === 0 && problems.length === 0) problems.push("Enter how much of at least one item came back.");
  if (String(reason || "").trim() === "") problems.push("Write why the goods came back.");
  return {
    lines,
    lineProblems,
    problems,
    total: totalKnown ? roundMoney(total) : null,
    canSave: problems.length === 0 && lines.length > 0,
  };
};

/**
 * Invoices a return can be made against, newest first, narrowed by what was typed (invoice number,
 * customer name or mobile). Cancelled bills are left out. At most `limit` are returned; `total`
 * says how many matched so the screen can say the list is cut.
 */
export const filterReturnInvoices = (sales, search = "", limit = RETURN_INVOICE_LIST_LIMIT) => {
  const needle = String(search || "").trim().toLowerCase();
  const matches = (Array.isArray(sales) ? sales : []).filter((sale) => {
    if (!sale || canonicalInventoryId(sale.id) === "") return false;
    if (String(sale.sale_status || "").toUpperCase() === "CANCELLED") return false;
    if (needle === "") return true;
    return [sale.invoice_no, sale.customer_name, sale.customer_mobile, sale.id]
      .some((field) => String(field ?? "").toLowerCase().includes(needle));
  });
  return { invoices: matches.slice(0, Math.max(0, limit)), total: matches.length };
};

/** The return as the server takes it. The sale id goes as the server gave it, never through Number(). */
export const saleReturnPayload = ({ invoiceId, sale, returnDate, refundType, reason, branchId, userId, draft }) => ({
  sale_id: invoiceId,
  customer_name: sale?.customer_name,
  customer_mobile: sale?.customer_mobile,
  return_date: returnDate,
  refund_type: refundType,
  return_reason: String(reason || "").trim(),
  branch_id: branchId,
  created_by: userId,
  items: (draft?.lines || []).map((line) => ({ sale_item_id: line.sale_item_id, return_quantity: line.return_quantity })),
});

/** A stable fingerprint of what would be sent, so a retry of the same return reuses its key. */
export const saleReturnFingerprint = (payload) => JSON.stringify([
  canonicalInventoryId(payload?.sale_id),
  payload?.return_date || "",
  payload?.refund_type || "",
  payload?.return_reason || "",
  (payload?.items || []).map((item) => [canonicalInventoryId(item.sale_item_id), item.return_quantity]),
]);
