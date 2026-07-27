"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const cloudMigration = fs.readFileSync(
  path.join(__dirname, "migrations/cloud/009_operational_location_foundation.sql"),
  "utf8"
);
const protocolMigration = fs.readFileSync(
  path.join(__dirname, "migrations/cloud/010_operational_protocol_v3.sql"),
  "utf8"
);
const publicationMigration = fs.readFileSync(
  path.join(__dirname, "migrations/cloud/011_inventory_incremental_publication.sql"),
  "utf8"
);
const sqliteMigration = fs.readFileSync(
  path.join(__dirname, "../src-tauri/migrations/sqlite/013_operational_location_foundation.sql"),
  "utf8"
);
const backendSource = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

test("operational-location migrations are additive and do not backfill ownership", () => {
  for (const migration of [cloudMigration, protocolMigration, publicationMigration, sqliteMigration]) {
    assert.doesNotMatch(migration, /\bDROP\s+(TABLE|COLUMN|SCHEMA|DATABASE)\b/i);
    assert.doesNotMatch(migration, /\bDELETE\s+FROM\b/i);
    assert.doesNotMatch(migration, /\bTRUNCATE\b/i);
  }
  assert.doesNotMatch(cloudMigration, /Badwasiya|Jodhpur/i);
  assert.doesNotMatch(sqliteMigration, /Badwasiya|Jodhpur/i);
});

test("inventory publication is transactional, scoped, and does not manufacture history", () => {
  assert.match(publicationMigration, /AFTER INSERT OR UPDATE OR DELETE ON inventory_batches/i);
  assert.match(publicationMigration, /INSERT INTO sync_change_log/i);
  assert.match(publicationMigration, /operational_location_id/i);
  assert.match(publicationMigration, /OLD IS NOT DISTINCT FROM NEW/i);
  assert.match(publicationMigration, /ON CONFLICT \(idempotency_key\)/i);
  assert.match(publicationMigration, /AFTER INSERT OR UPDATE OR DELETE ON operational_location_products/i);
  assert.match(publicationMigration, /'location_product'/i);
  assert.doesNotMatch(
    publicationMigration,
    /INSERT INTO sync_change_log[\s\S]*SELECT[\s\S]*FROM inventory_batches/i
  );
  assert.doesNotMatch(
    publicationMigration,
    /^\s*(?:DELETE\s+FROM|TRUNCATE|DROP\s+TABLE|UPDATE\s+\w+\s+SET)\b/im
  );
  assert.doesNotMatch(backendSource, /seedReferenceChangeLog/);
});

test("canonical location schema contains required ownership and authorization entities", () => {
  for (const entity of [
    "operational_locations",
    "operational_location_products",
    "staff_location_assignments",
    "device_assignments",
    "device_assignment_history",
    "purchase_orders",
    "goods_receipts",
    "supplier_bills",
    "payment_allocations",
    "dispatch_batches",
    "inventory_transfers",
    "inventory_transfer_items",
    "inventory_transfer_events",
    "stock_reservations",
  ]) {
    assert.match(cloudMigration, new RegExp(`CREATE TABLE IF NOT EXISTS ${entity}\\b`));
  }
  assert.match(cloudMigration, /operational_location_id/i);
  assert.doesNotMatch(cloudMigration, /CREATE TABLE IF NOT EXISTS sub_branch/i);
});

test("SQLite foundation carries location scope into offline inventory and sync", () => {
  assert.match(sqliteMigration, /local_operational_locations/);
  assert.match(sqliteMigration, /local_device_assignment/);
  assert.match(sqliteMigration, /ALTER TABLE local_inventory_lots ADD COLUMN operational_location_id/);
  assert.match(sqliteMigration, /ALTER TABLE sync_outbox ADD COLUMN operational_location_id/);
  assert.match(sqliteMigration, /ALTER TABLE sync_outbox ADD COLUMN assignment_generation/);
});

test("protocol v3 inventory and sync enforce exact operational scope", () => {
  const inventoryRoute = backendSource.slice(
    backendSource.indexOf('app.get("/api/v3/inventory"'),
    backendSource.indexOf('app.get("/api/device/identity"')
  );
  assert.match(inventoryRoute, /ib\.company_id = olp\.company_id/);
  assert.match(inventoryRoute, /ib\.branch_id = olp\.branch_id/);
  assert.match(inventoryRoute, /ib\.operational_location_id = olp\.operational_location_id/);
  assert.match(inventoryRoute, /olp\.operational_location_id = \$3/);
  assert.match(backendSource, /validateSyncBatchScope\(operations/);
  assert.match(backendSource, /operationalLocationId: req\.body\.operational_location_id/);
  assert.match(backendSource, /operationalLocationId: req\.query\.operational_location_id/);
});

test("branch aggregates cannot be persisted as inventory in the new schema", () => {
  assert.match(cloudMigration, /CREATE TABLE IF NOT EXISTS operational_locations/);
  assert.match(cloudMigration, /inventory_batches ADD COLUMN IF NOT EXISTS operational_location_id/);
  assert.doesNotMatch(cloudMigration, /CREATE TABLE IF NOT EXISTS branch_inventory\b/);
  assert.doesNotMatch(cloudMigration, /CREATE TABLE IF NOT EXISTS branch_stock\b/);
});

test("protocol v3 constraints remain additive and preserve pending-bill cost semantics", () => {
  assert.match(protocolMigration, /ALTER TABLE inventory_batches ALTER COLUMN purchase_rate DROP NOT NULL/i);
  assert.match(protocolMigration, /ALTER TABLE products ALTER COLUMN selling_rate DROP NOT NULL/i);
  assert.match(protocolMigration, /DROP INDEX IF EXISTS products_category_name_lower_unique_idx/i);
  assert.match(protocolMigration, /products_company_name_search_idx/i);
  assert.match(protocolMigration, /goods_receipt_items_lot_global_id_idx/i);
  assert.match(protocolMigration, /inventory_transfers_status_v3_check/i);
  assert.doesNotMatch(protocolMigration, /\b(?:DELETE|TRUNCATE|DROP TABLE|UPDATE\s+\w+\s+SET)\b/i);
});
