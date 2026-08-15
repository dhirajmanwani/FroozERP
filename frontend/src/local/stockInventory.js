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

export const groupInventoryLotsByProduct = (lots) => (
  (Array.isArray(lots) ? lots : []).reduce((groups, lot) => {
    const key = canonicalInventoryId(lot?.product_id);
    if (!key) return groups;
    const current = groups.get(key) || [];
    current.push(lot);
    groups.set(key, current);
    return groups;
  }, new Map())
);

export const summarizeInventoryLots = (lots) => {
  const rows = Array.isArray(lots) ? lots : [];
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

export const resolveInventoryPresentation = ({ loadState = "idle", loadError = "", rowCount = 0, filteredLotCount = 0 } = {}) => {
  if (loadState === "idle" || loadState === "loading") {
    return { kind: "loading", countLabel: rowCount > 0 ? String(rowCount) : "Loading", message: "Loading local inventory..." };
  }
  if (loadState === "error" || loadError) {
    return {
      kind: "error",
      countLabel: rowCount > 0 ? String(rowCount) : "Unavailable",
      message: loadError || "Inventory could not be loaded. Existing local data was preserved; retry when the local service is ready.",
    };
  }
  // Lots survived filtering but none could be matched to a product row. That is an
  // internal inconsistency, never a legitimate empty result, and must not render as
  // "Products: 0" while the summary tiles still show stock.
  if (rowCount === 0 && Number(filteredLotCount) > 0) {
    return {
      kind: "error",
      countLabel: "Unavailable",
      message: "Inventory lots could not be matched to their products. Local data was preserved; retry, and report this if it persists.",
    };
  }
  if (rowCount === 0) return { kind: "empty", countLabel: "0", message: "No inventory records match the selected filters." };
  return { kind: "ready", countLabel: String(rowCount), message: "" };
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
