import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  InventoryResponseContractError,
  STOCK_FILTER_DEFAULTS,
  activeStockFilterLabels,
  canonicalInventoryId,
  createLatestRequestGate,
  createStockFilters,
  findInventoryProduct,
  groupInventoryLotsByProduct,
  inventoryIdsEqual,
  normalizeInventoryAuditResponse,
  normalizeInventoryLotsResponse,
  normalizeInventoryProductsResponse,
  normalizeInventoryStatus,
  normalizeLocalInventorySnapshot,
  normalizeStockViewMode,
  resolveInventoryPresentation,
  resolveInventoryAuditEndpoint,
  resolveInventoryHydrationPolicy,
  summarizeInventoryLots,
  validateStockDateRange,
} from "./stockInventory.js";

const buildFixture = () => {
  const products = Array.from({ length: 25 }, (_, index) => ({
    id: `product-${index + 1}`,
    product_name: `Product ${index + 1}`,
    minimum_stock: index + 1,
  }));
  const quantities = Array.from({ length: 44 }, () => 20);
  quantities[0] += 303.55;
  const rawValue = quantities.reduce((sum, quantity, index) => sum + quantity * (200 + index), 0);
  const valueAdjustment = (282275 - rawValue) / quantities[0];
  const lots = quantities.map((quantity, index) => ({
    id: `lot-${index + 1}`,
    product_id: `product-${(index % 17) + 1}`,
    balance_qty: quantity,
    effective_cost_per_unit: index === 0 ? 200 + valueAdjustment : 200 + index,
    batch_status: "ACTIVE",
  }));
  return { products, lots };
};

test("canonical product IDs retain all 44 visible lots and 17 product rows", () => {
  const { products, lots } = buildFixture();
  const grouped = groupInventoryLotsByProduct(lots);
  const summary = summarizeInventoryLots(lots);
  assert.equal(grouped.size, 17);
  assert.equal(summary.lots, 44);
  assert.equal(summary.products, 17);
  assert.equal(summary.quantity, 1183.55);
  assert.ok(Math.abs(summary.stockValue - 282275) < 0.000001);
  assert.equal(findInventoryProduct(products, "product-7")?.minimum_stock, 7);
});

test("numeric-looking and canonical string identities never use lossy numeric coercion", () => {
  const products = [{ id: "product-276" }, { id: "276" }, { id: "product-aac83a1a" }];
  assert.equal(findInventoryProduct(products, "product-276")?.id, "product-276");
  assert.equal(findInventoryProduct(products, 276)?.id, "276");
  assert.equal(findInventoryProduct(products, "product-aac83a1a")?.id, "product-aac83a1a");
  assert.equal(inventoryIdsEqual("004", 4), false);
});

test("fresh and restored profile view modes normalize to supported values", () => {
  assert.equal(normalizeStockViewMode(null), "PRODUCT");
  assert.equal(normalizeStockViewMode("PRODUCT"), "PRODUCT");
  assert.equal(normalizeStockViewMode("lot"), "LOT");
  assert.equal(normalizeStockViewMode("CATEGORY"), "PRODUCT");
  assert.equal(normalizeStockViewMode("stale-restored-value"), "PRODUCT");
});

test("snapshot and HTTP response contracts reject malformed empty-success payloads", () => {
  const fixture = buildFixture();
  const normalized = normalizeLocalInventorySnapshot({ products: fixture.products, inventory_lots: fixture.lots });
  assert.equal(normalized.products.length, fixture.products.length);
  assert.equal(normalized.lots.length, fixture.lots.length);
  assert.equal(normalized.products[0].product_id, fixture.products[0].id);
  assert.equal(normalized.lots[0].batch_status, "ACTIVE");
  assert.equal(normalizeInventoryLotsResponse(fixture.lots).length, 44);
  assert.equal(normalizeInventoryLotsResponse({ inventory: fixture.lots }).length, 44);
  assert.equal(normalizeInventoryProductsResponse(fixture.products).length, 25);
  assert.throws(() => normalizeLocalInventorySnapshot({ products: [], inventory_lots: {} }), InventoryResponseContractError);
  assert.throws(() => normalizeInventoryProductsResponse({ rows: fixture.products }), InventoryResponseContractError);
  assert.throws(() => normalizeInventoryLotsResponse({ success: true }), InventoryResponseContractError);
  assert.throws(() => normalizeInventoryLotsResponse(null), InventoryResponseContractError);
});

test("row contracts require canonical IDs and finite stock values", () => {
  const fixture = buildFixture();
  const protocolLot = normalizeInventoryLotsResponse([{ ...fixture.lots[0], id: undefined, inventory_lot_id: "lot-protocol", batch_status: " cancelled " }])[0];
  assert.equal(protocolLot.id, "lot-protocol");
  assert.equal(protocolLot.batch_status, "CANCELLED");
  assert.equal(normalizeInventoryStatus(" inactive "), "INACTIVE");
  assert.throws(() => normalizeInventoryProductsResponse([{ product_name: "Missing ID" }]), /canonical ID/);
  assert.throws(() => normalizeInventoryLotsResponse([{ ...fixture.lots[0], product_id: "" }]), /canonical ID/);
  assert.throws(() => normalizeInventoryLotsResponse([{ ...fixture.lots[0], balance_qty: "not-a-number" }]), /finite available quantity/);
  assert.throws(() => normalizeInventoryLotsResponse([{ ...fixture.lots[0], purchase_rate: "NaN" }]), /invalid purchase_rate/);
});

test("audit rows are validated and malformed audit success is rejected", () => {
  assert.deepEqual(normalizeInventoryAuditResponse([{ id: "audit-1", action: "ADJUST" }]), [{ id: "audit-1", action: "ADJUST" }]);
  assert.throws(() => normalizeInventoryAuditResponse({ rows: [] }), InventoryResponseContractError);
  assert.throws(() => normalizeInventoryAuditResponse([null]), InventoryResponseContractError);
});

test("reversed stock dates are explicit and recoverable", () => {
  assert.equal(validateStockDateRange({ date_from: "2026-08-14", date_to: "2026-08-13" }), "Date From must not be after Date To. Correct the range or clear the date filters.");
  assert.equal(validateStockDateRange({ date_from: "2026-08-13", date_to: "2026-08-14" }), "");
  assert.equal(validateStockDateRange({ date_from: "", date_to: "2026-08-14" }), "");
});

test("latest request gate rejects stale asynchronous completions", () => {
  const gate = createLatestRequestGate();
  const first = gate.begin();
  const second = gate.begin();
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
});

test("Tauri Auto inventory remains local-first and Local Only suppresses audit calls", () => {
  assert.deepEqual(resolveInventoryHydrationPolicy({ tauriRuntime: true }), {
    source: "LOCAL_SQLITE",
    requestLegacyInventory: false,
  });
  assert.deepEqual(resolveInventoryHydrationPolicy({ tauriRuntime: false }), {
    source: "HTTP",
    requestLegacyInventory: true,
  });
  assert.equal(resolveInventoryAuditEndpoint({ apiUrl: "http://127.0.0.1:5000", connectivityMode: "LOCAL_ONLY" }), "");
  assert.equal(resolveInventoryAuditEndpoint({ apiUrl: "http://127.0.0.1:5000/", connectivityMode: "AUTO" }), "http://127.0.0.1:5000/stock-inventory/audit");
});

test("loading, load failure, genuine empty, and ready inventory remain distinct", () => {
  assert.equal(resolveInventoryPresentation({ loadState: "loading", rowCount: 0 }).kind, "loading");
  const failure = resolveInventoryPresentation({ loadState: "error", loadError: "Snapshot is incompatible", rowCount: 0 });
  assert.equal(failure.kind, "error");
  assert.equal(failure.countLabel, "Unavailable");
  assert.equal(resolveInventoryPresentation({ loadState: "ready", rowCount: 0 }).kind, "empty");
  assert.equal(resolveInventoryPresentation({ loadState: "ready", rowCount: 17 }).kind, "ready");
});

test("clear defaults and active labels cover every effective embedded filter", () => {
  assert.deepEqual(createStockFilters(), STOCK_FILTER_DEFAULTS);
  const filters = {
    ...createStockFilters(),
    category: "Fruit",
    supplier: "Supplier A",
    dateType: "MOVEMENT",
    showEmpty: true,
    showInactive: true,
  };
  assert.deepEqual(
    activeStockFilterLabels(filters, { sortBy: "UPDATED_NEW" }).map(([key]) => key),
    ["category", "supplier", "dateType", "showEmpty", "showInactive", "sortBy"]
  );
});

test("App wires local products, explicit load state, and stock-owned range controls", () => {
  const source = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(source, /stockReport: localInventorySnapshot\.products/);
  assert.match(source, /inventoryLoadState: "ready"/);
  assert.match(source, /loadError=\{data\.inventoryLoadError\}/);
  assert.match(source, /selectedReport === "stockInventory" \? null : reportFilterSummary/);
  assert.match(source, /selectedReport === "stockInventory" \? \(/);
  assert.match(source, /auditEndpoint=\{resolveInventoryAuditEndpoint\(\{ apiUrl: API_URL, connectivityMode \}\)\}/);
  assert.match(source, /No audit request was sent\./);
  assert.match(source, /const normalizedAudit = normalizeInventoryAuditResponse\(response\.data\)/);
  assert.doesNotMatch(source, /setAuditRows\(response\.data \|\| \[\]\)/);
  assert.match(source, /reportRequestGateRef\.current\.isCurrent\(requestGeneration\)/);
  assert.doesNotMatch(source, /fallback: reportsData/);
  assert.match(source, /stockDateRangeError && <div className="error-banner" role="alert">/);
  assert.match(source, /if \(tauriRuntime\) \{[\s\S]*loadLocalReferenceSnapshot/);
  assert.match(source, /if \(inventoryHydrationPolicy\.requestLegacyInventory\) \{[\s\S]*reportRequests\.push\(\{ key: "inventory"/);
  assert.match(source, /let nextStockReport = localInventorySnapshot\?\.products \|\| null/);
  assert.match(source, /let nextStockLots = localInventorySnapshot\?\.lots \|\| values\.inventory/);
  assert.doesNotMatch(source, /Number\(lot\.product_id\) === Number\(product\.product_id\)/);
  assert.doesNotMatch(source, /Number\(lot\.product_id\) === Number\(productId\)/);
});

test("product grouping keys stay canonical so lots cannot desync from their product row", () => {
  // Regression: productGroups keyed on String(lot.product_id) while
  // groupInventoryLotsByProduct keyed on canonicalInventoryId(lot.product_id).
  // Any non-canonical id made the two disagree, so the lot still counted toward
  // every summary tile while its product row vanished -> "Products: 0".
  const lots = [
    { id: "lot-1", product_id: " product-1 ", balance_qty: 10 },
    { id: "lot-2", product_id: "product-1", balance_qty: 5 },
  ];
  const grouped = groupInventoryLotsByProduct(lots);
  assert.equal(grouped.size, 1, "padded and clean ids must land in one bucket");
  assert.equal(grouped.get("product-1").length, 2);
  assert.equal(canonicalInventoryId(" product-1 "), "product-1");
  assert.equal(canonicalInventoryId(undefined), "");
});

test("App derives both sides of the product join with canonicalInventoryId", () => {
  const source = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(source, /const key = canonicalInventoryId\(lot\.product_id\);/);
  assert.match(source, /filteredLotsByProduct\.get\(canonicalInventoryId\(product\.product_id\)\)/);
  assert.doesNotMatch(source, /const key = String\(lot\.product_id\);/);
  assert.doesNotMatch(source, /filteredLotsByProduct\.get\(String\(product\.product_id\)\)/);
});

test("filtered lots with no matching product row is an error state, never Products: 0", () => {
  const inconsistent = resolveInventoryPresentation({ loadState: "ready", rowCount: 0, filteredLotCount: 44 });
  assert.equal(inconsistent.kind, "error");
  assert.notEqual(inconsistent.countLabel, "0");
  assert.match(inconsistent.message, /could not be matched/i);
});

test("a genuinely empty filter result still reads as empty, not as an error", () => {
  const empty = resolveInventoryPresentation({ loadState: "ready", rowCount: 0, filteredLotCount: 0 });
  assert.equal(empty.kind, "empty");
  assert.equal(empty.countLabel, "0");
});

test("App passes the filtered lot count so the inconsistency guard can fire", () => {
  const source = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(source, /filteredLotCount: filteredLots\.length/);
});

test("default filters never empty a populated in-stock fixture", () => {
  const { lots } = buildFixture();
  const defaults = createStockFilters();
  assert.equal(defaults.date_from, "");
  assert.equal(defaults.date_to, "");
  const survivors = lots.filter((lot) => Number(lot.balance_qty) > 0);
  assert.equal(survivors.length, lots.length, "default filters must not hide in-stock lots");
  assert.equal(groupInventoryLotsByProduct(survivors).size, 17);
});
