import {
  LOCATION_SCOPE_STATUS,
  counterScopeMessage,
  filterLotsForScope,
  resolveScopedLots,
} from "./locationScope.js";

export const STOCK_VIEW_MODES = Object.freeze({
  PRODUCT: "PRODUCT",
  LOT: "LOT",
});

export const STOCK_FILTER_DEFAULTS = Object.freeze({
  productSearch: "",
  lotSearch: "",
  category: "",
  product: "",
  lot: "",
  supplier: "",
  status: "IN_STOCK",
  origin: "ALL",
  dateType: "ARRIVAL",
  date_from: "",
  date_to: "",
  showEmpty: false,
  showInactive: false,
});

export const normalizeStockViewMode = (value) => (
  Object.values(STOCK_VIEW_MODES).includes(String(value || "").toUpperCase())
    ? String(value).toUpperCase()
    : STOCK_VIEW_MODES.PRODUCT
);

export const createStockFilters = () => ({ ...STOCK_FILTER_DEFAULTS });

export const resolveInventoryHydrationPolicy = ({ tauriRuntime = false } = {}) => ({
  source: tauriRuntime ? "LOCAL_SQLITE" : "HTTP",
  requestLegacyInventory: !tauriRuntime,
});

export const resolveInventoryAuditEndpoint = ({ apiUrl = "", connectivityMode = "LOCAL_ONLY" } = {}) => (
  String(connectivityMode).trim().toUpperCase() === "AUTO" ? `${String(apiUrl).replace(/\/$/, "")}/stock-inventory/audit` : ""
);

export const normalizeInventoryStatus = (value, fallback = "ACTIVE") => (
  String(value ?? fallback).trim().toUpperCase() || fallback
);

export const canonicalInventoryId = (value) => String(value ?? "").trim();

export const inventoryIdsEqual = (left, right) => (
  canonicalInventoryId(left) !== ""
  && canonicalInventoryId(left) === canonicalInventoryId(right)
);

export const findInventoryProduct = (products, productId) => (
  (Array.isArray(products) ? products : []).find((product) => (
    inventoryIdsEqual(product?.product_id ?? product?.id, productId)
  ))
);

/**
 * Lots bucketed by product, optionally narrowed to one counter's shelf.
 *
 * `scope` is optional and defaults to "none supplied", which leaves the grouping byte-for-byte what
 * it was before location scoping existed — the Stock Inventory screen is also a *manager's* view,
 * and `docs/stock-distribution-decision.md` rules that looking binds to the person while selling
 * binds to the machine. So the filter is something a caller turns on, not something imposed here.
 *
 * This feeds the table. `summarizeInventoryLots` feeds the tiles above it and filters through the
 * same call, because a summary and a detail that filter differently eventually disagree and the
 * disagreement looks exactly like data loss.
 */
export const groupInventoryLotsByProduct = (lots, scope = null) => (
  filterLotsForScope(Array.isArray(lots) ? lots : [], scope).reduce((groups, lot) => {
    const key = canonicalInventoryId(lot?.product_id);
    if (!key) return groups;
    const current = groups.get(key) || [];
    current.push(lot);
    groups.set(key, current);
    return groups;
  }, new Map())
);

/**
 * The tiles: lot count, product count, quantity and value — for the same rows the table shows.
 *
 * The filtered set is resolved **once** here and the grouping is done on that result rather than on
 * the caller's raw list, so the tiles and `groupInventoryLotsByProduct` cannot be looking at two
 * different universes. Passing the already-filtered rows on (rather than the scope) is what
 * guarantees it: there is only one filtering step in the whole call.
 *
 * The four numbers are only answers when `scopeUsable` is true. Under an unknown counter scope they
 * are all zero because nothing may be shown, and zero there is *not* a stock figure — it is the
 * absence of one. Feed `scopeStatus`/`scopeMessage` into `resolveInventoryPresentation` and render
 * what it returns; do not put these numbers on a screen without consulting it.
 */
export const summarizeInventoryLots = (lots, scope = null) => {
  const resolution = resolveScopedLots(Array.isArray(lots) ? lots : [], scope);
  const rows = resolution.lots;
  const groups = groupInventoryLotsByProduct(rows);
  return {
    lots: rows.length,
    products: groups.size,
    quantity: rows.reduce((sum, lot) => sum + Number(lot?.balance_qty ?? lot?.remaining_qty ?? 0), 0),
    stockValue: rows.reduce((sum, lot) => {
      const quantity = Number(lot?.balance_qty ?? lot?.remaining_qty ?? 0);
      const cost = Number(lot?.effective_cost_per_unit ?? lot?.purchase_rate ?? 0);
      return sum + quantity * cost;
    }, 0),
    scopeStatus: resolution.status,
    scopeUsable: resolution.usable !== false,
    scopeMessage: resolution.message,
    scopeCounts: resolution.counts,
  };
};

export class InventoryResponseContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "InventoryResponseContractError";
    this.code = "INVENTORY_RESPONSE_CONTRACT";
  }
}

const requireRows = (value, label) => {
  if (!Array.isArray(value)) {
    throw new InventoryResponseContractError(`${label} must be an array.`);
  }
  return value;
};

const requireRecord = (value, label, index) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InventoryResponseContractError(`${label} row ${index + 1} must be an object.`);
  }
  return value;
};

const requireCanonicalId = (value, label, index) => {
  const id = canonicalInventoryId(value);
  if (!id) throw new InventoryResponseContractError(`${label} row ${index + 1} is missing its canonical ID.`);
  return id;
};

const requireFiniteFields = (row, fields, label, index) => {
  fields.forEach((field) => {
    if (row[field] !== undefined && row[field] !== null && row[field] !== "" && !Number.isFinite(Number(row[field]))) {
      throw new InventoryResponseContractError(`${label} row ${index + 1} has an invalid ${field} value.`);
    }
  });
};

const normalizeProductRows = (value, label) => requireRows(value, label).map((rawRow, index) => {
  const row = requireRecord(rawRow, label, index);
  const productId = requireCanonicalId(row.product_id ?? row.id, label, index);
  requireFiniteFields(row, ["minimum_stock", "selling_rate", "sale_rate"], label, index);
  return { ...row, product_id: productId };
});

const normalizeLotRows = (value, label) => requireRows(value, label).map((rawRow, index) => {
  const row = requireRecord(rawRow, label, index);
  const id = requireCanonicalId(row.id ?? row.inventory_lot_id, label, index);
  const productId = requireCanonicalId(row.product_id, label, index);
  const quantity = row.balance_qty ?? row.remaining_qty;
  if (quantity === undefined || quantity === null || quantity === "" || !Number.isFinite(Number(quantity))) {
    throw new InventoryResponseContractError(`${label} row ${index + 1} has no finite available quantity.`);
  }
  requireFiniteFields(row, [
    "balance_qty",
    "remaining_qty",
    "purchase_qty",
    "sold_qty",
    "reserved_qty",
    "effective_cost_per_unit",
    "purchase_rate",
    "sale_rate",
    "selling_rate",
    "temporary_sale_rate",
  ], label, index);
  return {
    ...row,
    id,
    product_id: productId,
    batch_status: normalizeInventoryStatus(row.batch_status),
  };
});

export const normalizeLocalInventorySnapshot = (snapshot) => {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new InventoryResponseContractError("Local inventory snapshot is unavailable or malformed.");
  }
  return {
    products: normalizeProductRows(snapshot.products, "Local inventory products"),
    lots: normalizeLotRows(snapshot.inventory_lots, "Local inventory lots"),
  };
};

export const normalizeInventoryLotsResponse = (payload) => {
  if (Array.isArray(payload)) return normalizeLotRows(payload, "Inventory response");
  if (!payload || typeof payload !== "object") {
    throw new InventoryResponseContractError("Inventory response is unavailable or malformed.");
  }
  for (const key of ["inventory", "lots", "data", "rows", "items"]) {
    if (Object.hasOwn(payload, key)) return normalizeLotRows(payload[key], `Inventory response ${key}`);
  }
  throw new InventoryResponseContractError("Inventory response does not contain a supported collection.");
};

export const normalizeInventoryProductsResponse = (payload) => (
  normalizeProductRows(payload, "Inventory response products")
);

export const normalizeInventoryAuditResponse = (payload) => (
  requireRows(payload, "Inventory audit response").map((row, index) => ({
    ...requireRecord(row, "Inventory audit response", index),
  }))
);

export const validateStockDateRange = (filters = {}) => {
  const from = String(filters.date_from || "").trim();
  const to = String(filters.date_to || "").trim();
  if (from && to && from > to) return "Date From must not be after Date To. Correct the range or clear the date filters.";
  return "";
};

export const createLatestRequestGate = () => {
  let generation = 0;
  return {
    begin: () => ++generation,
    isCurrent: (candidate) => candidate === generation,
  };
};

export const sanitizedInventoryLoadError = (error) => {
  if (error?.code === "INVENTORY_RESPONSE_CONTRACT") return error.message;
  return "Inventory could not be loaded. Existing local data was preserved; retry when the local service is ready.";
};

/**
 * What the screen shows, and why — one decision so the tiles and the table cannot contradict.
 *
 * Every arm answers the same question: is this number an answer, or the absence of one? The rule
 * from CLAUDE.md is that a failure, a contract violation or an internal inconsistency must produce
 * a distinct state and never a `0`, because `Products: 0` is indistinguishable from "the shop is
 * out of apples" and a shopkeeper acts on it as if it were.
 *
 * Scope adds two arms to that:
 *
 * - **The counter does not know which shop it is in** (`SCOPE_UNKNOWN`). `resolveScopedLots` fails
 *   closed, so there are no rows — but the truth is "I cannot tell", not "there is none". This
 *   returns `kind: "error"` deliberately: every existing consumer already renders an `error` as a
 *   banner carrying `message`, so the operator is told what to do even before a screen learns the
 *   new `reason`. `reason` and `scopeStatus` are what a screen keys on to offer "assign this
 *   counter" instead of "retry". Ordered *after* the load-failure arm, because a snapshot that
 *   never loaded is the more immediate fault and its message is the more specific one.
 * - **Every row on the device belongs to another shop** (`FOREIGN_ROWS_EXCLUDED` with nothing
 *   kept). Here `0` is honest — this shop really is holding none — so it stays an `empty`, but the
 *   message says the fruit may have been distributed to the wrong branch rather than sold, which is
 *   the difference between checking Stock Distribution and telling a customer the item is finished.
 *
 * A scope that merely excluded some rows, or admitted untagged ones, is not a state of its own: the
 * figures shown are correct for this counter. That reaches the screen as `notice`, alongside a
 * normal `ready` or `empty`, so it informs without blocking.
 */
export const resolveInventoryPresentation = ({
  loadState = "idle",
  loadError = "",
  rowCount = 0,
  filteredLotCount = 0,
  scopeStatus = LOCATION_SCOPE_STATUS.UNFILTERED,
  scopeCounts = null,
  scopeMessage = "",
} = {}) => {
  const scopeNote = scopeMessage || counterScopeMessage(scopeStatus, { counts: scopeCounts || {} });
  const base = { reason: "", scopeStatus, notice: "" };
  if (loadState === "idle" || loadState === "loading") {
    return { ...base, kind: "loading", countLabel: rowCount > 0 ? String(rowCount) : "Loading", message: "Loading local inventory..." };
  }
  if (loadState === "error" || loadError) {
    return {
      ...base,
      kind: "error",
      reason: "LOAD_FAILED",
      countLabel: rowCount > 0 ? String(rowCount) : "Unavailable",
      message: loadError || "Inventory could not be loaded. Existing local data was preserved; retry when the local service is ready.",
    };
  }
  // The counter's own shop is unknown, so no figure here is this counter's figure. Never a "0".
  if (scopeStatus === LOCATION_SCOPE_STATUS.SCOPE_UNKNOWN) {
    return {
      ...base,
      kind: "error",
      reason: LOCATION_SCOPE_STATUS.SCOPE_UNKNOWN,
      countLabel: "Unavailable",
      message: scopeNote,
    };
  }
  // Lots survived filtering but none could be matched to a product row. That is an
  // internal inconsistency, never a legitimate empty result, and must not render as
  // "Products: 0" while the summary tiles still show stock.
  if (rowCount === 0 && Number(filteredLotCount) > 0) {
    return {
      ...base,
      kind: "error",
      reason: "PRODUCT_JOIN_INCONSISTENT",
      countLabel: "Unavailable",
      message: "Inventory lots could not be matched to their products. Local data was preserved; retry, and report this if it persists.",
    };
  }
  if (rowCount === 0 && scopeStatus === LOCATION_SCOPE_STATUS.FOREIGN_ROWS_EXCLUDED) {
    return {
      ...base,
      kind: "empty",
      reason: LOCATION_SCOPE_STATUS.FOREIGN_ROWS_EXCLUDED,
      countLabel: "0",
      message: scopeNote,
    };
  }
  if (rowCount === 0) return { ...base, kind: "empty", notice: scopeNote, countLabel: "0", message: "No inventory records match the selected filters." };
  return { ...base, kind: "ready", notice: scopeNote, countLabel: String(rowCount), message: "" };
};

export const activeStockFilterLabels = (filters, { sortBy = "PRODUCT_ASC" } = {}) => {
  const current = { ...STOCK_FILTER_DEFAULTS, ...(filters || {}) };
  const labels = [];
  if (current.productSearch) labels.push(["productSearch", `Product search: ${current.productSearch}`]);
  if (current.lotSearch) labels.push(["lotSearch", `Lot search: ${current.lotSearch}`]);
  if (current.category) labels.push(["category", `Category: ${current.category}`]);
  if (current.product) labels.push(["product", "Product selected"]);
  if (current.lot) labels.push(["lot", "Lot selected"]);
  if (current.supplier) labels.push(["supplier", `Supplier: ${current.supplier}`]);
  if (current.status !== STOCK_FILTER_DEFAULTS.status) labels.push(["status", `Status: ${current.status.replaceAll("_", " ")}`]);
  if (current.origin !== STOCK_FILTER_DEFAULTS.origin) labels.push(["origin", `Origin: ${current.origin}`]);
  if (current.dateType !== STOCK_FILTER_DEFAULTS.dateType) labels.push(["dateType", `Date type: ${current.dateType}`]);
  if (current.date_from) labels.push(["date_from", `From: ${current.date_from}`]);
  if (current.date_to) labels.push(["date_to", `To: ${current.date_to}`]);
  if (current.showEmpty) labels.push(["showEmpty", "Showing empty lots"]);
  if (current.showInactive) labels.push(["showInactive", "Showing inactive lots"]);
  if (sortBy !== "PRODUCT_ASC") labels.push(["sortBy", `Sort: ${sortBy.replaceAll("_", " ")}`]);
  return labels;
};
