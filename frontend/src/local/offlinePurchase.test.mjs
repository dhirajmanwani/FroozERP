import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appSource = fs.readFileSync(path.join(here, "../App.jsx"), "utf8");
const databaseSource = fs.readFileSync(path.join(here, "localDatabase.js"), "utf8");
const repositorySource = fs.readFileSync(path.join(here, "repositories.js"), "utf8");
const syncSource = fs.readFileSync(path.join(here, "syncService.js"), "utf8");
const rustSource = fs.readFileSync(path.join(here, "../../../src-tauri/src/local_db.rs"), "utf8");
const migrationSource = fs.readFileSync(
  path.join(here, "../../../src-tauri/migrations/sqlite/014_offline_purchase_grn.sql"),
  "utf8",
);

test("new offline purchases use a durable protocol-v3 purchase intent", () => {
  assert.match(appSource, /queueLocalPurchase\(\{/);
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

test("retired intra-lot transfer has no frontend entry point", () => {
  assert.doesNotMatch(appSource, /openLotAction\("transfer"/);
  assert.doesNotMatch(appSource, /lotAction\.type === "transfer"/);
  assert.doesNotMatch(appSource, /transfer_to_lot_id/);
  assert.doesNotMatch(appSource, /transfer_quantity/);
  assert.doesNotMatch(appSource, />Transfer<\/button>/);
});
