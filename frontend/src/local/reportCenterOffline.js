/**
 * Report Center when it is answering from this computer alone (LOCAL_ONLY, or offline on the
 * desktop).
 *
 * Offline, only Sales History (from the local POS sales) and the stock reports (from the SQLite
 * snapshot) are worked out on this computer. Everything else comes from the server. The local load
 * used to spread `...current` over the new state, so every report it did not recompute kept the
 * last cloud figures under the newly chosen period — yesterday's P&L labelled as today's. It also
 * built the cash book as a bare list the screen does not read, and turned a failed local sales read
 * into an empty list, which reads as "no sales".
 *
 * Here those reports are blanked and marked unavailable, and the screen says so in words instead of
 * drawing empty tables and ₹0.00 tiles.
 */

/** Report ids that this computer can work out for itself. */
export const OFFLINE_COMPUTED_REPORTS = Object.freeze([
  "salesHistory",
  "stockInventory",
  "currentStock",
  "lowStock",
  "stockValuation",
  "lotWiseStock",
]);

// Keys holding statements rather than row lists; blanked to an empty object.
const STATEMENT_KEYS = new Set(["balanceSheet", "profitLoss", "cashBookReport"]);
// Load bookkeeping that is not a report and is set explicitly by the caller.
const BOOKKEEPING_KEYS = new Set([
  "inventoryLoadState", "inventoryLoadError", "dateFrom", "dateTo",
  "offlineUnavailable", "salesHistoryLoadError",
]);

/**
 * The next `reportsData` for a local-only load. Every report that came from the server is blanked;
 * Sales History and the stock reports carry what this computer computed.
 */
export const buildLocalOnlyReportsData = (current = {}, {
  salesRows = [],
  salesError = "",
  stockReport = [],
  stockLotReport = [],
  dateFrom = "",
  dateTo = "",
} = {}) => {
  const next = {};
  for (const [key, value] of Object.entries(current || {})) {
    if (BOOKKEEPING_KEYS.has(key)) continue;
    if (STATEMENT_KEYS.has(key)) next[key] = {};
    else if (Array.isArray(value)) next[key] = [];
    else next[key] = value;
  }
  return {
    ...next,
    cashBookReport: {},
    balanceSheet: {},
    profitLoss: {},
    salesHistoryReport: salesError ? [] : (Array.isArray(salesRows) ? salesRows : []),
    salesHistoryLoadError: String(salesError || ""),
    stockReport,
    stockLotReport,
    inventoryLoadState: "ready",
    inventoryLoadError: "",
    offlineUnavailable: true,
    dateFrom,
    dateTo,
  };
};

export const OFFLINE_REPORT_NOTE =
  "Not available offline. This report is worked out by the server; switch to Auto mode with internet to see it. Only Sales History and the stock reports are worked out on this computer.";

/**
 * Whether a report's figures can be shown. `{ available: true }`, or a message and a tone
 * ("note" for offline, "error" for a failed read) to show in place of the tiles and the table.
 * Report ids not built from `reportsData` (the order reports) are always available here — they
 * carry their own state.
 */
export const resolveReportAvailability = (reportId, data = {}, { selfContained = [] } = {}) => {
  if (!reportId || selfContained.includes(reportId)) return { available: true };
  if (reportId === "salesHistory" && String(data?.salesHistoryLoadError || "").trim()) {
    return { available: false, tone: "error", message: `Sales on this computer could not be read: ${data.salesHistoryLoadError}` };
  }
  if (data?.offlineUnavailable === true && !OFFLINE_COMPUTED_REPORTS.includes(reportId)) {
    return { available: false, tone: "note", message: OFFLINE_REPORT_NOTE };
  }
  return { available: true };
};
