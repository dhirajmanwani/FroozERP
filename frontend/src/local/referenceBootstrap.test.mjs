import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const syncService = fs.readFileSync(new URL("./syncService.js", import.meta.url), "utf8");
const localDatabase = fs.readFileSync(new URL("./localDatabase.js", import.meta.url), "utf8");
const repositories = fs.readFileSync(new URL("./repositories.js", import.meta.url), "utf8");
const appSource = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
const rustSource = fs.readFileSync(new URL("../../../src-tauri/src/local_db.rs", import.meta.url), "utf8");
const supplierMigration = fs.readFileSync(
  new URL("../../../src-tauri/migrations/sqlite/015_supplier_reference_cache.sql", import.meta.url),
  "utf8",
);

test("cursor zero opts into reference bootstrap and applies it atomically", () => {
  assert.match(syncService, /bootstrap_protocol: cursor === "0" \? "reference-v1" : undefined/);
  assert.match(syncService, /"x-froozerp-device-session": context\.deviceSessionToken/);
  assert.match(syncService, /response\.data\?\.reference_bootstrap/);
  assert.match(syncService, /repositories\.pull\.bootstrap/);
  assert.match(localDatabase, /sync_apply_reference_bootstrap/);
  assert.match(repositories, /bootstrap: applyReferenceBootstrap/);
});

test("all sync requests carry the canonical signed scope after bootstrap", () => {
  assert.match(syncService, /companyId: String\(user\?\.company_id \|\| deviceInfo\?\.company_id/);
  assert.match(syncService, /operationalLocationId: String\(/);
  assert.match(syncService, /company_id: context\.companyId/);
  assert.match(syncService, /operational_location_id: context\.operationalLocationId/);
  assert.doesNotMatch(syncService, /headers: cursor === "0" && context\.deviceSessionToken/);
  assert.match(syncService, /headers: context\.deviceSessionToken/);
});

test("ordinary incremental pulls retain the existing apply path", () => {
  assert.match(syncService, /applyPulledChanges\(\{/);
  assert.match(syncService, /nextCursor: response\.data\?\.next_cursor \|\| cursor/);
});

test("supplier references use the durable SQLite cache and signed protocol-v3 writes", () => {
  assert.match(supplierMigration, /CREATE TABLE IF NOT EXISTS local_supplier_references/);
  assert.doesNotMatch(supplierMigration, /opening_balance|bank_name|account_number|notes/);
  assert.match(rustSource, /"supplier" =>/);
  assert.match(rustSource, /offlineSuppliers/);
  assert.match(appSource, /SYNC_API_URL}\/api\/v3\/suppliers/);
  assert.match(appSource, /createOperationalWrite\(user, payload\)/);
  assert.match(appSource, /Supplier master changes require Auto mode/);
  assert.match(appSource, /cachedSupplierReferences\.length \? cachedSupplierReferences : \(values\.suppliers \|\| \[\]\)/);
  assert.match(appSource, /company_id: supplier\.company_id \|\| currentUser\?\.company_id/);
  assert.match(appSource, /offlineSuppliers: supplierReferences/);
});

test("purchase rules hydrate from the cached settings bundle for offline purchase entry", () => {
  assert.match(appSource, /const nextPurchaseRules = \{/);
  assert.match(appSource, /mandiTaxRules: bundle\.mandiTaxRules \|\| \[\]/);
  assert.match(appSource, /rebateRules: bundle\.rebateRules \|\| \[\]/);
  assert.match(appSource, /setSettingsRules\(nextPurchaseRules\)/);
  assert.match(appSource, /setPurchaseRules\(nextPurchaseRules\)/);
  assert.match(appSource, /const purchaseRulePayload = await loadPurchaseRules\(\)\.catch/);
  assert.match(appSource, /mandiTaxRules: purchaseRulePayload\.mandiTaxRules \|\| \[\]/);
  assert.match(appSource, /rebateRules: purchaseRulePayload\.rebateRules \|\| \[\]/);
  assert.match(appSource, /return response\.data/);
  assert.match(appSource, /Promise\.all\(\[loadPurchases\(\), loadPurchaseRules\(\)\]\)/);
  assert.match(appSource, /if \(snapshot\?\.reference_ready\) \{/);
  assert.match(appSource, /mandiTaxRules: response\.data\?\.mandiTaxRules \|\| \[\]/);
  assert.match(appSource, /rebateRules: response\.data\?\.rebateRules \|\| \[\]/);
  assert.match(appSource, /mandiTaxRules: preserveVerifiedLocalCollection\(/);
  assert.match(appSource, /rebateRules: preserveVerifiedLocalCollection\(/);
});
