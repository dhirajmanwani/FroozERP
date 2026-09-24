const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeReportDate(value) {
  const key = String(value || "").trim();
  if (!DATE_KEY.test(key)) return "";
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? key : "";
}

const dateKey = (date) => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");

export function resolveReportDateRange({ range = "today", date_from, date_to } = {}, now = new Date()) {
  let from;
  let to;
  if (range === "custom") {
    from = normalizeReportDate(date_from);
    to = normalizeReportDate(date_to);
    if (!from || !to) throw new Error("Select a valid Date From and Date To in DD/MM/YYYY format.");
  } else {
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const start = new Date(end);
    if (range === "yesterday") {
      start.setDate(start.getDate() - 1);
      end.setDate(end.getDate() - 1);
    } else if (range === "week") {
      start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    } else if (range === "month") {
      start.setDate(1);
    }
    from = dateKey(start);
    to = dateKey(end);
  }
  if (from > to) throw new Error("Date From cannot be after Date To.");
  return { range, date_from: from, date_to: to };
}

export function buildReportRefreshParams({ range, customRange, search, selectedReport, salesFilters, purchaseFilters, accountReportFilters, cashBookFilters, inventoryLotReportFilter } = {}) {
  const dates = resolveReportDateRange(range === "custom" ? { range, ...customRange } : { range });
  const reportFilters = selectedReport === "salesHistory" ? salesFilters
    : selectedReport === "purchaseHistory" ? purchaseFilters
      : ["customerLedger", "supplierLedger", "accountStatement"].includes(selectedReport) ? accountReportFilters
        : selectedReport === "cashBook" ? cashBookFilters
          : selectedReport === "stockInventory" ? { lot_visibility: inventoryLotReportFilter }
            : {};
  return {
    ...dates,
    search: String(search || "").trim(),
    report: selectedReport || "",
    filters: JSON.stringify(reportFilters || {}),
  };
}

const rowDate = (row) => ["sale_date", "return_date", "purchase_date", "expense_date", "waste_date", "transaction_date", "date", "created_at"]
  .map((key) => row?.[key])
  .find(Boolean);

export function filterRowsForReportRange(rows, params) {
  const { date_from: from, date_to: to } = resolveReportDateRange(params);
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const raw = rowDate(row);
    if (!raw) return true;
    const text = String(raw);
    const parsed = DATE_KEY.test(text) && text.length === 10 ? null : new Date(text);
    const key = parsed && !Number.isNaN(parsed.getTime()) ? dateKey(parsed) : normalizeReportDate(text.slice(0, 10));
    return Boolean(key && key >= from && key <= to);
  });
}

export function formatIndianReportDate(value) {
  const key = normalizeReportDate(value);
  if (!key) return "-";
  const [year, month, day] = key.split("-");
  return `${day}/${month}/${year}`;
}

/**
 * Which report range a load should use.
 *
 * Report Center is reloaded from many places that have no opinion about dates: the refresh after
 * every background sync (once a minute), a POS save, cancelling a sale, a lot action, opening the
 * module again. Each of those used to call the loader with nothing, which means "today", and so a
 * year the owner had just asked for was quietly replaced by today's figures a minute later -- a
 * profit-and-loss of 0.00 under a range chip that still said the year.
 *
 * A request that names a range is the owner choosing one and is used as it is. A request that names
 * none keeps the range last chosen (its other keys, such as a cash-book filter, still apply). Only
 * when nothing has been chosen yet does the default "today" apply.
 */
export function reportLoadParams(requested, remembered) {
  const asked = requested && typeof requested === "object" ? requested : {};
  if (asked.range) return asked;
  if (remembered?.range) return { ...remembered, ...asked };
  return asked;
}
