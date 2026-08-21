import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const PRIMARY_MODULES = [
  ["dashboard", "Dashboard", ["/dashboard-analytics"]],
  ["products", "Products", ["/products", "/product-categories", "/inventory"]],
  ["purchase", "Purchase Entry", ["/purchases", "/suppliers"]],
  ["pending-bills", "Pending Bills", ["/pending-bills/customer"]],
  ["accounts", "Accounts", ["/accounts", "/payments"]],
  ["returns", "Sale Returns", ["/sale-returns"]],
  ["waste", "Waste Management", ["/waste-entries"]],
  ["sales", "POS Billing", ["/api/v3/sales", "/customers"]],
  ["discounts", "Discounts", ["/lot-discounts"]],
  ["sale-rates", "Sale Rate Update", ["/sale-rates", "/sale-rate-history"]],
  ["expenses", "Expenses", ["/expenses"]],
  ["orders", "Orders", ["local_list_customer_orders", "local_save_customer_order"]],
  ["reports", "Report Center", ["/reports/summary", "/inventory"]],
  ["all-shops", "All Shops", ["/api/owner/all-branches-summary"]],
  ["settings", "Settings", ["/settings"]],
].map(([id, title, endpoints]) => ({ id, title, endpoints, primary: true }));

export const EXTENDED_SURFACES = [
  ["purchase-orders", "Purchase Orders", ["purchase-order", "/api/v3/purchases"]],
  ["grn", "Receiving / GRN", ["/api/v3/purchases", "GRN"]],
  ["suppliers", "Suppliers", ["/suppliers"]],
  ["customers", "Customers", ["/customers"]],
  ["transfers", "Transfers", ["/api/v3/transfers", "transfer"]],
  ["users-devices", "Users and Devices", ["/users", "/devices"]],
  ["sync", "Sync Status", ["/api/v3/sync", "sync_status"]],
  ["update-center", "Update Center", ["UpdateCenterSection", "update-center"]],
].map(([id, title, endpoints]) => ({ id, title, endpoints, primary: false }));

export const ALL_SURFACES = [...PRIMARY_MODULES, ...EXTENDED_SURFACES];

export function canonicalId(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

export function finiteNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function lotQuantity(lot) {
  return finiteNumber(lot.balance_qty, lot.remaining_qty, lot.available_qty, lot.quantity);
}

export function lotCost(lot) {
  const candidates = [lot.cost_rate, lot.purchase_rate, lot.effective_cost_per_unit];
  for (const value of candidates) {
    if (value === null || value === undefined || value === "") continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function isActiveAvailableLot(lot) {
  if (lot.deleted_at) return false;
  const status = String(lot.status ?? lot.batch_status ?? "ACTIVE").trim().toUpperCase();
  return !["CANCELLED", "INACTIVE", "DELETED"].includes(status) && lotQuantity(lot) > 0;
}

export function buildInventoryBoundary(products, lots) {
  if (!Array.isArray(products) || !Array.isArray(lots)) {
    throw new TypeError("Inventory contract requires product and lot arrays; malformed data cannot be treated as empty success.");
  }
  const productIds = new Set(products.map((product) => canonicalId(product.id ?? product.product_id)).filter(Boolean));
  const activeLots = lots.filter(isActiveAvailableLot);
  const activeProductIds = new Set(activeLots.map((lot) => canonicalId(lot.product_id)).filter(Boolean));
  const unmatchedLotIds = [...new Set(lots
    .filter((lot) => canonicalId(lot.product_id) && !productIds.has(canonicalId(lot.product_id)))
    .map((lot) => canonicalId(lot.product_id)))];
  const stockValue = activeLots.reduce((sum, lot) => {
    const cost = lotCost(lot);
    return cost === null ? sum : sum + lotQuantity(lot) * cost;
  }, 0);
  return {
    products: products.length,
    lots: lots.length,
    activeAvailableLots: activeLots.length,
    productsWithAvailableStock: activeProductIds.size,
    quantity: activeLots.reduce((sum, lot) => sum + lotQuantity(lot), 0),
    stockValue,
    missingCostLots: activeLots.filter((lot) => lotCost(lot) === null).length,
    unmatchedProductReferences: unmatchedLotIds,
  };
}

export function normalizeCollection(payload, acceptedKeys = []) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    for (const key of acceptedKeys) {
      if (Array.isArray(payload[key])) return payload[key];
    }
  }
  throw new TypeError(`Malformed collection response; expected an array${acceptedKeys.length ? ` or one of: ${acceptedKeys.join(", ")}` : ""}.`);
}

export function normalizeProfile(profile) {
  const storage = profile?.localStorage && typeof profile.localStorage === "object" ? profile.localStorage : {};
  const requestedMode = storage["froozerp-stock-view-mode"];
  const viewMode = ["PRODUCT", "LOT"].includes(requestedMode) ? requestedMode : "PRODUCT";
  return {
    viewMode,
    stockDateFrom: "",
    stockDateTo: "",
    outerReportRangeIsInventoryFilter: false,
    staleViewModeIgnored: Boolean(requestedMode && requestedMode !== viewMode),
  };
}

export function stableValue(value) {
  if (Buffer.isBuffer(value)) return { $buffer: value.toString("base64") };
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function digest(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex").toUpperCase();
}

export function inspectSourceContracts(repoRoot) {
  const appPath = path.join(repoRoot, "frontend", "src", "App.jsx");
  const serverPath = path.join(repoRoot, "backend", "server.js");
  if (!existsSync(appPath) || !existsSync(serverPath)) throw new Error("FroozERP source contracts are unavailable.");
  const app = readFileSync(appPath, "utf8");
  const server = readFileSync(serverPath, "utf8");
  const loadReportsStart = app.indexOf("const loadReports = async");
  const loadReportsEnd = app.indexOf("const loadExpenses = async", loadReportsStart);
  const loadReportsSource = loadReportsStart >= 0 && loadReportsEnd > loadReportsStart
    ? app.slice(loadReportsStart, loadReportsEnd)
    : "";
  const modules = ALL_SURFACES.map((surface) => {
    const navigationRegistered = !surface.primary || app.includes(`["${surface.id}",`);
    const renderPathPresent = !surface.primary || app.includes(`activeView === "${surface.id}"`);
    const endpoints = surface.endpoints.map((endpoint) => ({
      endpoint,
      present: app.includes(endpoint) || server.includes(endpoint),
    }));
    return {
      ...surface,
      assertionLevel: "static-preflight",
      navigationRegistered,
      renderPathPresent,
      endpoints,
      passed: navigationRegistered && renderPathPresent && endpoints.some(({ present }) => present),
      renderedRows: null,
      renderedUiStatus: "not-run-preflight-does-not-render-ui",
    };
  });
  const inventoryContracts = [
    {
      id: "canonical-string-product-identity",
      passed: !/Number\(lot\.product_id\)\s*===\s*Number\(product\.product_id\)/.test(app),
      evidence: "Product/lot association must not numerically coerce canonical string IDs.",
    },
    {
      id: "local-products-hydrated-for-inventory",
      passed: /stockReport:\s*[A-Za-z_$][\w$]*Snapshot\.products/.test(loadReportsSource),
      evidence: "LOCAL_ONLY report hydration must carry product masters as well as lots.",
    },
    {
      id: "inventory-load-error-distinct-from-empty",
      passed: /inventoryLoadError|stockInventoryError|stockReportError/.test(app)
        && !/lots=\{Array\.isArray\(data\.stockLotReport\)\s*\?\s*data\.stockLotReport\s*:\s*\[\]\}/.test(app)
        && !/products=\{Array\.isArray\(data\.stockReport\)\s*\?\s*data\.stockReport\s*:\s*\[\]\}/.test(app),
      evidence: "Inventory requires an explicit load/contract error state.",
    },
    {
      id: "snapshot-failure-not-swallowed",
      passed: loadReportsSource.length > 0
        && !/loadLocalReferenceSnapshot\([\s\S]{0,500}?\.catch\(\(\)\s*=>\s*null\)/.test(loadReportsSource),
      evidence: "A failed local snapshot load must not become null and continue as stale/empty success.",
    },
    {
      id: "persisted-view-mode-validated",
      passed: /\[\"PRODUCT\",\s*\"LOT\"\]\.includes\([^)]*froozerp-stock-view-mode|normalizeStockViewMode/.test(app),
      evidence: "Unsupported persisted Inventory modes must normalize to PRODUCT.",
    },
  ];
  return { modules, inventoryContracts, passed: modules.every((item) => item.passed) && inventoryContracts.every((item) => item.passed) };
}
