"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const backendSource = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const frontendSource = fs.readFileSync(
  path.join(__dirname, "../frontend/src/App.jsx"),
  "utf8"
);

const requiredV3Routes = [
  '"/api/v3/products"',
  '"/api/v3/products/:id"',
  '"/api/v3/products/:id/deactivate"',
  '"/api/v3/products/:id/opening-stock"',
  '"/api/v3/products/:productId/opening-stock-lots"',
  '"/api/v3/product-categories"',
  '"/api/v3/product-categories/:id"',
  '"/api/v3/inventory-lots/:lotId"',
  '"/api/v3/inventory-lots/:lotId/add-quantity"',
  '"/api/v3/inventory-lots/:lotId/adjust"',
  '"/api/v3/inventory-lots/:lotId/deactivate"',
  '"/api/v3/inventory-lots/:lotId/reactivate"',
  '"/api/v3/purchase-bills"',
  '"/api/v3/purchases/:id"',
  '"/api/v3/purchases/:id/complete-bill"',
  '"/api/v3/purchases/:id/cancel"',
  '"/api/v3/sales"',
  '"/api/v3/sales/:id"',
  '"/api/v3/sales/:id/cancel"',
  '"/api/v3/sale-returns"',
  '"/api/v3/waste-entries"',
];

test("confirmed operational writes have protocol-v3 route replacements", () => {
  for (const route of requiredV3Routes) {
    assert.match(backendSource, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(backendSource, /v3WriteAdapter\(createProductHandler\)/);
  assert.match(backendSource, /v3WriteAdapter\(createProductCategoryHandler\)/);
  assert.match(backendSource, /v3WriteAdapter\(updateInventoryLotHandler\)/);
  assert.match(backendSource, /v3WriteAdapter\(createPurchaseBillHandler\)/);
  assert.match(backendSource, /v3WriteAdapter\(updatePurchaseHandler\)/);
  assert.match(backendSource, /v3WriteAdapter\(createSaleHandler\)/);
  assert.match(backendSource, /v3WriteAdapter\(createSaleReturnHandler\)/);
  assert.match(backendSource, /v3WriteAdapter\(createWasteEntryHandler\)/);
});

test("operation processing is serialized and committed with business mutations", () => {
  assert.match(
    backendSource,
    /pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)/
  );
  assert.match(
    backendSource,
    /INSERT INTO sync_processed_operations[\s\S]+ON CONFLICT \(operation_id\) DO NOTHING/
  );
  assert.match(
    backendSource,
    /SET_CONFIG\('froozerp\.operation_id', \$3, TRUE\)/
  );
});

test("protocol-v3 context comes from a verified signed device session", () => {
  assert.match(
    backendSource,
    /verifyDeviceSession\(\s*req\.headers\["x-froozerp-device-session"\],\s*deviceSessionSecret\s*\)/
  );
  assert.match(backendSource, /rejectDeviceSessionSubstitution\(/);
  assert.match(backendSource, /DEVICE_NOT_APPROVED/);
});

test("frontend confirmed workflows call protocol-v3 routes with operational writes", () => {
  assert.match(frontendSource, /const createOperationalWrite =/);
  for (const route of [
    "/api/v3/products",
    "/api/v3/product-categories",
    "/api/v3/inventory-lots/",
    "/api/v3/purchase-bills",
    "/api/v3/purchases/",
    "/api/v3/sales",
    "/api/v3/sale-returns",
    "/api/v3/waste-entries",
  ]) {
    assert.match(frontendSource, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(frontendSource, /axios\.post\(`\$\{API_URL\}\/sales`/);
  assert.doesNotMatch(frontendSource, /axios\.post\(`\$\{API_URL\}\/sale-returns`/);
  assert.doesNotMatch(frontendSource, /axios\.post\(`\$\{API_URL\}\/waste-entries`/);
  assert.doesNotMatch(frontendSource, /axios\.post\(`\$\{API_URL\}\/purchase-bill`/);
  assert.doesNotMatch(frontendSource, /axios\.post\(`\$\{API_URL\}\/lots\/transfer-stock`/);
});

test("legacy operational routes remain registered for explicit HTTP 426 enforcement", () => {
  assert.match(backendSource, /app\.post\("\/sales", createSaleHandler\)/);
  assert.match(backendSource, /app\.post\("\/sale-returns", createSaleReturnHandler\)/);
  assert.match(backendSource, /app\.post\("\/waste-entries", createWasteEntryHandler\)/);
  assert.match(backendSource, /requiresOperationalProtocolUpgrade\(req\.path\)/);
  assert.match(backendSource, /status\(426\)/);
  assert.match(backendSource, /app\.post\("\/lots\/transfer-stock"/);
  assert.doesNotMatch(frontendSource, /openLotAction\("transfer"/);
  assert.doesNotMatch(frontendSource, /lotAction\.type === "transfer"/);
});

test("offline purchase replay preserves signed operation identities and canonical scope", () => {
  assert.match(backendSource, /productGlobalId: nullableText\(body\.product_global_id\)/);
  assert.match(backendSource, /offline-purchase-\$\{operationId\}-\$\{lineIndex\}/);
  assert.match(backendSource, /offline-lot-\$\{operationId\}-\$\{lineIndex\}/);
  assert.match(backendSource, /OFFLINE_PURCHASE_IDENTITY_MISMATCH/);
  assert.match(
    backendSource,
    /WHERE global_id = \$1[\s\S]*AND company_id = \$2[\s\S]*active IS DISTINCT FROM FALSE/
  );
  assert.match(backendSource, /company_id, operational_location_id, global_id/);
  assert.match(backendSource, /lots: createdLots/);
  assert.match(backendSource, /\.\.\.serverTimePayload\(\)/);
});
