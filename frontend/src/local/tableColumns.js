/**
 * Which table columns hold figures.
 *
 * A column of rupees or quantities reads properly only when it lines up on its last digit, so
 * DataTable right-aligns a column declared `{ label, numeric: true }`. Most tables name their
 * columns as plain strings; `markNumericColumns` turns the ones whose heading is a money or
 * quantity heading into that shape, so a table opts in with one call instead of rewriting its
 * header list.
 *
 * Only exact headings are matched, and only headings that mean a figure wherever this app uses
 * them. Words that are sometimes a figure and sometimes a label ("Payment" is a mode in one
 * report and an amount in another, "Value" is a setting's text in System Info) are left out and
 * named per table through `also`.
 */

export const NUMERIC_HEADINGS = Object.freeze([
  "Amount", "Total Amount", "Sale Amount", "Gross Amount", "Net Amount", "Discount Amount", "Return Value",
  "Rate", "Rate agreed", "Sale Rate", "Average Cost", "Temp Sale Rate", "Expected Rate", "Cost Rate", "Discount Value",
  "Qty", "Quantity", "Qty Sold", "Return Quantity", "Total Quantity", "Cancelled Qty", "Received", "Remaining",
  "Stock", "Total Stock", "Minimum", "Minimum Stock",
  "Balance", "Opening", "Debit", "Credit", "Receivable", "Payable", "Outstanding",
  "Gross", "Gross Total", "Net", "Net Total", "Net Purchase", "Paid", "Rebate", "Mandi Tax",
  "Cost", "Revenue", "Sales", "Profit", "Net Profit", "Provisional Profit", "Profit Impact",
  "Item Discount", "Bill Discount Share", "Discount", "Item Disc.", "Bill Disc.",
  "Cash", "Bank", "UPI", "Bank/Card", "Cash (₹)", "Bank (₹)",
  "Stock Value", "Customers Owe", "We Owe", "Purchases",
  "Estimated Value", "Estimated Total", "Total Credit Amount", "Amount Received", "Returned",
  "Bills", "Orders", "Invoices", "Entries", "Transactions", "Returns", "Count", "Average Order",
  "Pending Bill Count", "Total Pending Items", "Low Stock Count", "Available Lots",
  "Sold", "Already Returned", "Returnable", "Refund per unit",
]);

const key = (value) => String(value ?? "").trim().toLowerCase();
const NUMERIC_KEYS = new Set(NUMERIC_HEADINGS.map(key));

export const isNumericHeading = (heading) => typeof heading === "string" && NUMERIC_KEYS.has(key(heading));

/**
 * The headers with every figure heading as `{ label, numeric: true }`. `also` adds headings for
 * this table only; `except` keeps a heading plain in this table. Anything that is not a string
 * (a node, or a column already declared) is passed through untouched.
 */
export const markNumericColumns = (headers, { also = [], except = [] } = {}) => {
  const extra = new Set((also || []).map(key));
  const skip = new Set((except || []).map(key));
  return (Array.isArray(headers) ? headers : []).map((header) => {
    if (typeof header !== "string") return header;
    const name = key(header);
    if (skip.has(name)) return header;
    return NUMERIC_KEYS.has(name) || extra.has(name) ? { label: header, numeric: true } : header;
  });
};
