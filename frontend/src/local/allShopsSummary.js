/**
 * What the Owner's All Shops screen is allowed to show, given what came back.
 *
 * This is the one view in FroozERP that reads across branches, and it is assembled from several
 * independent per-shop loads, so "some of it worked" is a normal outcome rather than an edge case.
 * That makes it exactly the screen where the house rule in CLAUDE.md bites hardest: **a failed load
 * must never render as a zero.** A shop whose figures errored, shown as ₹0, is indistinguishable
 * from a shop that had a quiet day — except that the company total is now silently short by whatever
 * that shop was worth, with nothing on screen to say so.
 *
 * So `totals` is null in every state where the numbers are not trustworthy. The renderer cannot
 * accidentally display a zero it was never given.
 */

export const ALL_SHOPS_STATUS = Object.freeze({
  LOADING: "loading",
  OFFLINE: "offline",
  ERROR: "error",
  EMPTY: "empty",
  PARTIAL: "partial",
  READY: "ready",
});

const asNumber = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

const formatShopList = (names) => {
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
};

/**
 * Turn one response into a state the screen can render without lying.
 *
 * @param {object} input
 * @param {string} input.loadState   "idle" | "loading" | "loaded" | "error"
 * @param {string} input.loadError   message from a failed request, if any
 * @param {boolean} input.offline    true when this device cannot reach the backend
 * @param {object} input.payload     the body of GET /api/owner/all-branches-summary
 */
export const resolveAllShopsPresentation = ({
  loadState = "idle",
  loadError = "",
  offline = false,
  payload = null,
} = {}) => {
  // Offline is checked first and deliberately: this view has no local equivalent. Every other
  // figure in the app can fall back to the device's own SQLite copy, but no device holds another
  // shop's books, so there is nothing honest to show while disconnected.
  if (offline) {
    return {
      status: ALL_SHOPS_STATUS.OFFLINE,
      message: "All Shops needs a connection. This device only holds its own shop's records, so company totals cannot be worked out offline.",
      shops: [],
      totals: null,
      warnings: [],
    };
  }
  if (loadState === "idle" || loadState === "loading") {
    return {
      status: ALL_SHOPS_STATUS.LOADING,
      message: "Loading every shop...",
      shops: [],
      totals: null,
      warnings: [],
    };
  }
  if (loadState === "error" || loadError) {
    return {
      status: ALL_SHOPS_STATUS.ERROR,
      message: loadError || "All Shops could not be loaded. Nothing was changed; try again.",
      shops: [],
      totals: null,
      warnings: [],
    };
  }
  // A response that arrived but does not carry the shape this screen needs is an error, not an
  // empty company. Reading `payload.totals.cash` off a malformed body would produce undefined,
  // which renders as a blank cell that looks like a zero.
  if (!payload || !Array.isArray(payload.branches) || !payload.totals) {
    return {
      status: ALL_SHOPS_STATUS.ERROR,
      message: "All Shops returned an unexpected reply, so the figures were not displayed.",
      shops: [],
      totals: null,
      warnings: [],
    };
  }

  const shops = payload.branches.map((branch) => ({
    branchId: branch?.branchId ?? null,
    branchName: branch?.branchName || "Unnamed shop",
    ok: branch?.ok === true,
    error: branch?.ok === true ? "" : (branch?.error || "This shop's figures could not be loaded."),
    cash: asNumber(branch?.cash),
    bank: asNumber(branch?.bank),
    inventory: asNumber(branch?.inventory),
    customerReceivable: asNumber(branch?.customerReceivable),
    supplierPayable: asNumber(branch?.supplierPayable),
    netProfit: asNumber(branch?.netProfit),
    netPosition: asNumber(branch?.netPosition),
    salesRevenue: asNumber(branch?.salesRevenue),
    expenses: asNumber(branch?.expenses),
  }));

  if (shops.length === 0) {
    return {
      status: ALL_SHOPS_STATUS.EMPTY,
      message: "No shops are set up for this company yet.",
      shops: [],
      totals: null,
      warnings: [],
    };
  }

  const warnings = [];
  const reconciliation = payload.reconciliation;
  if (reconciliation && reconciliation.balanced === false) {
    // A gap means a purchase or sale is recorded against no shop, or a shop outside this company.
    // Naming the amount matters: "something is off" sends the reader nowhere.
    const parts = [];
    if (Math.abs(asNumber(reconciliation.payableGap)) > 0) {
      parts.push(`supplier dues differ by ${Math.abs(asNumber(reconciliation.payableGap)).toFixed(2)}`);
    }
    if (Math.abs(asNumber(reconciliation.receivableGap)) > 0) {
      parts.push(`customer dues differ by ${Math.abs(asNumber(reconciliation.receivableGap)).toFixed(2)}`);
    }
    warnings.push(`The shop-by-shop figures do not add up to the company figures: ${parts.join(", ")}. Some entries may not be linked to any shop.`);
  }

  const failed = shops.filter((shop) => !shop.ok);
  if (failed.length > 0) {
    warnings.push(`${failed.length} of ${shops.length} shops could not be loaded (${formatShopList(failed.map((shop) => shop.branchName))}). The totals below leave them out.`);
    return {
      status: ALL_SHOPS_STATUS.PARTIAL,
      message: "Some shops are missing from these totals.",
      shops,
      totals: { ...payload.totals, complete: false },
      warnings,
    };
  }
  // Belt and braces: the server marks its own totals incomplete, and the client does not simply
  // trust its own count of failures to agree.
  if (payload.totals.complete !== true) {
    warnings.push("The server reported these totals as incomplete.");
    return {
      status: ALL_SHOPS_STATUS.PARTIAL,
      message: "Some shops are missing from these totals.",
      shops,
      totals: { ...payload.totals, complete: false },
      warnings,
    };
  }

  return {
    status: ALL_SHOPS_STATUS.READY,
    message: "",
    shops,
    totals: payload.totals,
    warnings,
  };
};

/** True when the screen has figures it is allowed to put on the page. */
export const allShopsHasFigures = (presentation) =>
  Boolean(presentation && presentation.totals);
