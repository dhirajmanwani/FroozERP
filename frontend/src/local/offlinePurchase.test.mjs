import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPurchaseSubmissionTracker } from "./purchaseSubmission.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appSource = fs.readFileSync(path.join(here, "../App.jsx"), "utf8");
const databaseSource = fs.readFileSync(path.join(here, "localDatabase.js"), "utf8");
const repositorySource = fs.readFileSync(path.join(here, "repositories.js"), "utf8");
const syncSource = fs.readFileSync(path.join(here, "syncService.js"), "utf8");
const rustSource = fs.readFileSync(path.join(here, "../../../src-tauri/src/local_db.rs"), "utf8");
const migrationSource = fs.readFileSync(
  path.join(here, "../../../src-tauri/migrations/sqlite/014_offline_purchase_grn.sql"),
  "utf8",
);const aggregateMigrationSource = fs.readFileSync(
  path.join(here, "../../../src-tauri/migrations/sqlite/016_purchase_aggregate_reconciliation.sql"),
  "utf8",
);

test("new offline purchases use a durable protocol-v3 purchase intent", () => {
  assert.match(appSource, /queueLocalPurchase\(\{/);
  assert.match(appSource, /readConnectivityMode\(\) === CONNECTIVITY_MODES\.LOCAL_ONLY/);
  assert.match(appSource, /purchaseSaveInFlightRef\.current/);
  assert.match(appSource, /Pending Cloud Acknowledgement/);
  assert.match(appSource, /Cloud Confirmed/);
  assert.match(databaseSource, /purchase_queue_local/);
  assert.match(repositorySource, /purchases:\s*\{[\s\S]*queue:/);
  assert.match(migrationSource, /CREATE TABLE IF NOT EXISTS local_purchase_intents/);
  assert.match(migrationSource, /CREATE TABLE IF NOT EXISTS local_purchase_intent_lines/);
  assert.match(migrationSource, /intent_checksum TEXT NOT NULL/);
  assert.match(rustSource, /Offline purchase operation already exists with different financial intent/);
});

test("offline replay is signed, idempotent, and recovers after interruption", () => {
  assert.match(syncSource, /x-froozerp-device-session/);
  assert.match(syncSource, /x-idempotency-key/);
  assert.match(syncSource, /operation\.entity_type !== "purchase_grn"/);
  assert.match(syncSource, /replayOfflinePurchase/);
  assert.match(syncSource, /markSyncing\(operationIds\)/);
  assert.match(syncSource, /release\(\s*operationIds/);
  assert.match(rustSource, /state = 'syncing'/);
  assert.match(rustSource, /state = 'pending', last_error/);
  assert.match(rustSource, /server_purchase_ids_json/);
  assert.match(rustSource, /server_lot_id/);
});

test("online protocol-v3 purchase writes use the signed cloud operational endpoint", () => {
  assert.match(appSource, /`\$\{SYNC_API_URL\}\/api\/v3\/purchase-bills`/);
  assert.match(appSource, /`\$\{SYNC_API_URL\}\/api\/v3\/purchases\/\$\{editingPurchaseId\}`/);
  assert.match(appSource, /`\$\{SYNC_API_URL\}\/api\/v3\/purchases\/\$\{editingPurchaseId\}\/complete-bill`/);
  assert.match(appSource, /`\$\{SYNC_API_URL\}\/api\/v3\/purchases\/\$\{purchase\.id\}\/cancel`/);
  assert.doesNotMatch(appSource, /`\$\{API_URL\}\/api\/v3\/purchase/);
});

test("online purchase retry preserves one aggregate idempotency key", () => {
  let sequence = 0;
  const tracker = createPurchaseSubmissionTracker(() => `purchase-op-${++sequence}`);
  const intent = { supplier_id: 2, items: [{ line_id: "line-1", quantity: 10 }] };

  const firstAttempt = tracker.resolve(intent);
  assert.equal(tracker.resolve(intent), firstAttempt);
  assert.notEqual(tracker.resolve({ ...intent, remarks: "changed" }), firstAttempt);

  const changedAttempt = tracker.resolve({ ...intent, remarks: "changed" });
  tracker.complete(changedAttempt);
  assert.notEqual(tracker.resolve({ ...intent, remarks: "changed" }), changedAttempt);
  assert.match(
    appSource,
    /createOperationalWrite\(user, aggregatePayload, aggregateOperationId\)/
  );
  assert.match(
    appSource,
    /await axios\.post\([\s\S]*purchase-bills[\s\S]*purchaseSubmissionRef\.current\.complete\(aggregateOperationId\)/
  );
});

test("purchase rules use cloud in Auto and the local cache in Local Only", () => {
  assert.match(
    appSource,
    /readConnectivityMode\(\) !== CONNECTIVITY_MODES\.LOCAL_ONLY[\s\S]*const rulesApiUrl = useCloudRules \? SYNC_API_URL : API_URL/
  );
  assert.match(
    appSource,
    /axios\.get\(\s*`\$\{rulesApiUrl\}\/purchase-rules`,\s*useCloudRules \? createOperationalReadConfig\(user\) : undefined/
  );
  assert.match(
    appSource,
    /const latestDevice = await resolveLocalDeviceInfo\(deviceInfo\)[\s\S]*deviceId: latestDevice\.device_id/
  );
  assert.match(
    appSource,
    /localBundle\.mandiTaxRules,\s*purchaseRules\.mandiTaxRules \|\| \[\]/
  );
  assert.match(
    appSource,
    /localBundle\.rebateRules,\s*purchaseRules\.rebateRules \|\| \[\]/
  );
  assert.match(appSource, /mandiTaxRules: response\.data\?\.mandiTaxRules \|\| \[\]/);
  assert.match(appSource, /rebateRules: response\.data\?\.rebateRules \|\| \[\]/);
});

test("multi-line offline purchases render once per operation", () => {
  assert.match(
    appSource,
    /new Map\([\s\S]*filter\(\(purchase\) => purchase\.operation_id\)[\s\S]*\[purchase\.operation_id, purchase\]/
  );
  assert.match(appSource, /purchase\.provisional_reference \|\| purchase\.offline_purchase_ref/);
});

test("desktop identity resolution preserves the explicitly configured device", () => {
  assert.match(
    appSource,
    /const provisionedDeviceId = readOfflineSession\(\)\?\.deviceId/
  );
  assert.match(
    appSource,
    /String\(provisionedDeviceId \|\| SAVED_API_CONFIG\.deviceId \|\| localStorage\.getItem\(storageKey\) \|\| ""\)\.trim\(\)/
  );
  assert.match(appSource, /getOrCreateLocalDeviceIdentity\(fallback\?\.device_id\)/);
  assert.match(databaseSource, /preferredDeviceId: String\(preferredDeviceId \|\| ""\)\.trim\(\) \|\| null/);
  assert.match(rustSource, /ensure_device_identity_with_preference_at/);
  assert.match(rustSource, /WHERE device_id = \?1/);
});

test("retired intra-lot transfer has no frontend entry point", () => {
  assert.doesNotMatch(appSource, /openLotAction\("transfer"/);
  assert.doesNotMatch(appSource, /lotAction\.type === "transfer"/);
  assert.doesNotMatch(appSource, /transfer_to_lot_id/);
  assert.doesNotMatch(appSource, /transfer_quantity/);
  assert.doesNotMatch(appSource, />Transfer<\/button>/);
});

test("one offline purchase aggregate keeps stable purchase, line, item, and lot identities", () => {
  assert.match(appSource, /product_global_id:\s*product\.global_id\s*\|\|\s*product\.id/);
  assert.match(appSource, /const postSaveRefreshResults = await Promise\.allSettled/);
  assert.match(appSource, /Purchase saved, but optional module refreshes failed/);
  assert.match(aggregateMigrationSource, /provisional_purchase_id TEXT/);
  assert.match(aggregateMigrationSource, /provisional_line_id TEXT/);
  assert.match(aggregateMigrationSource, /server_purchase_item_id TEXT/);
  assert.match(rustSource, /offline-purchase-\{operation_id\}/);
  assert.match(rustSource, /offline-purchase-line-\{operation_id\}-\{line_index\}/);
  assert.match(rustSource, /SET server_purchase_id = \?2[\s\S]*WHERE intent_id/);
  assert.match(rustSource, /SET server_purchase_item_id = \?2[\s\S]*WHERE provisional_line_id = \?1/);
});
