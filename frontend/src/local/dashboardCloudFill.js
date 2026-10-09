/**
 * The desktop dashboard's tiles the device cannot work out for itself.
 *
 * On the desktop the dashboard is always built from SQLite (`buildLocalDashboardSnapshot`), which
 * leaves outstanding balances, expenses, returns, waste and rebates `null` — this device does not
 * hold them. That is right offline. Online it left ten tiles saying "Not available offline" on a
 * machine that was online. When the cloud can be reached, those figures are asked of the server's
 * dashboard and fill *only* the tiles still null; the local figures (sales, profit, stock) are never
 * overwritten by the server's.
 *
 * The note under an unknown tile says which unknown it is: offline, or online and the read failed.
 */
import { LOCAL_UNCOMPUTED_METRICS } from "./dashboardSnapshot.js";

/** Every dashboard figure unknown: the state before a load, and after one that failed. */
export const NULL_DASHBOARD_METRICS = Object.freeze({
  todaySales: null,
  todayProfit: null,
  stockValue: null,
  lowStockItems: null,
  transactions: null,
  ...Object.fromEntries(LOCAL_UNCOMPUTED_METRICS.map((key) => [key, null])),
});

export const DASHBOARD_FILL = Object.freeze({
  IDLE: "idle",
  OFFLINE: "offline",
  FAILED: "failed",
  LOADED: "loaded",
});

/** Whether to ask the server at all. LOCAL_ONLY never asks: no request leaves the machine. */
export const shouldFetchCloudDashboardMetrics = ({ localOnly = false, offlineMode = false, cloudOnline = null, internetAvailable = null } = {}) => (
  !localOnly && !offlineMode && cloudOnline !== false && internetAvailable !== false
);

const finite = (value) => {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

// The server spells three of them two ways (`supplierOutstanding` / `total_supplier_outstanding`).
const SERVER_ALIASES = Object.freeze({
  supplierOutstanding: ["supplierOutstanding", "total_supplier_outstanding"],
  totalRebateReceived: ["totalRebateReceived", "total_rebate_received"],
  todaySupplierPayments: ["todaySupplierPayments", "todays_supplier_payments"],
});

/**
 * `local` with each LOCAL_UNCOMPUTED_METRICS key that is still null filled from the server's
 * summary, when the server sent a number for it. Nothing else is touched.
 */
export const fillUncomputedMetrics = (local = {}, server = {}) => {
  const filled = { ...local };
  for (const key of LOCAL_UNCOMPUTED_METRICS) {
    if (finite(filled[key]) !== null) continue;
    for (const name of SERVER_ALIASES[key] || [key]) {
      const value = finite(server?.[name]);
      if (value !== null) {
        filled[key] = value;
        break;
      }
    }
  }
  return filled;
};

/** The note under a tile whose figure is unknown. */
export const unknownMetricNote = ({ fill = DASHBOARD_FILL.IDLE, loadFailed = false } = {}) => {
  if (loadFailed) return "Could not load";
  if (fill === DASHBOARD_FILL.OFFLINE) return "Not available offline";
  if (fill === DASHBOARD_FILL.FAILED || fill === DASHBOARD_FILL.LOADED) return "Could not load";
  return "";
};
