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
  // A-3 moved the token read behind `extractSessionToken`, which accepts `Authorization: Bearer`
  // as well as the legacy header. The property being pinned is unchanged: the v3 context is derived
  // from a *verified signature*, never from an unverified header.
  assert.match(
    backendSource,
    /verifyDeviceSession\(\s*extractSessionToken\(req\),\s*deviceSessionSecret\s*\)/
  );
  assert.match(backendSource, /rejectDeviceSessionSubstitution\(/);
  assert.match(backendSource, /DEVICE_NOT_APPROVED/);
});

test("no request path reads the session header for identity without verifying it", () => {
  // The failure this guards is a future call site pulling the raw header and trusting it, which
  // looks like authentication and is not. Every read must go through extractSessionToken and then
  // through verifyDeviceSession.
  assert.doesNotMatch(
    backendSource,
    /verifyDeviceSession\(\s*req\.headers\[/,
    "session tokens must be extracted, not read straight off the request",
  );
  const rawHeaderReads = backendSource.match(/req\.headers\["x-froozerp-device-session"\]/g) || [];
  assert.equal(rawHeaderReads.length, 0, "the session header is read only inside authMiddleware");
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

test("protocol-v3 purchases accept established suppliers unless explicitly inactive", () => {
  assert.match(
    backendSource,
    /const buildPurchaseFinancials[\s\S]*suppliers WHERE id = \$1 AND active IS DISTINCT FROM FALSE FOR SHARE/
  );
  assert.match(
    backendSource,
    /const getPurchasePartiesForArrival[\s\S]*suppliers WHERE id = \$1 AND active IS DISTINCT FROM FALSE FOR SHARE/
  );
});

test("multi-line purchase aggregate creates one canonical header with child items and lots", () => {
  const handler = backendSource.match(/const createPurchaseBillHandler[\s\S]*?app\.post\("\/purchase-bill"/)[0];
  assert.match(handler, /const purchaseResult = await client\.query[\s\S]*purchase = purchaseResult\.rows\[0\]/);
  assert.match(handler, /for \(const item of completedEntries\)[\s\S]*INSERT INTO purchase_items/);
  assert.match(handler, /purchase_ids: \[purchase\.id\]/);
  assert.match(handler, /purchases: \[canonicalPurchase\]/);
  assert.match(handler, /entityType: "purchase"/);
  assert.match(handler, /action, old_value, new_value[\s\S]*'ADDED_ITEMS'/);
  assert.doesNotMatch(handler, /createdPurchases\.map/);
});