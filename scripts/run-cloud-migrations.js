const fs = require("fs");
const path = require("path");
const { Client } = require("../backend/node_modules/pg");

/**
 * Files under `backend/migrations/cloud/` that this runner deliberately does not apply, each with
 * the reason. Anything not listed here and not in `migrationFiles` fails
 * `backend/cloudMigrationCoverage.test.js`.
 *
 * This list exists because 011 went missing from the runner and nobody noticed. 011 installs the
 * only mechanism that publishes an inventory-lot change to a device, so for as long as it was
 * absent no stock movement of any kind reached a counter. The list below is the only thing that
 * decides what runs, and a silent omission from it has no symptom until fruit goes missing.
 */
const deliberatelyNotRun = {
  "002_sync_engine_foundation.sql":
    "applied by the server's own startup bootstrap (CREATE TABLE IF NOT EXISTS sync_processed_operations, backend/server.js)",
  "003_pos_sync_sale_foundation.sql":
    "applied by the server's own startup bootstrap (CREATE UNIQUE INDEX IF NOT EXISTS sales_global_id_unique_idx, backend/server.js)",
  "004_auth_recovery_foundation.sql":
    "applied by the server's own startup bootstrap (ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_email ..., backend/server.js)",
  "007_cloud_sync_entity_metadata.sql":
    "the file itself says 'Migration plan only. Do not apply automatically.' — it is a plan awaiting a module-by-module rollout review, not a pending change",
};

const migrationFiles = [
  "backend/migrations/cloud/005_multibranch_identity_foundation.sql",
  "backend/migrations/cloud/006_cloud_device_runtime_foundation.sql",
  "backend/migrations/cloud/008_canonical_utc_timestamps.sql",
  "backend/migrations/cloud/009_operational_location_foundation.sql",
  "backend/migrations/cloud/010_operational_protocol_v3.sql",
  // 011 installs froozerp_publish_inventory_lot_sync, the only mechanism that publishes an
  // inventory-lot change to a device. Without it no stock movement of any kind reaches a counter
  // except through a full reference bootstrap. It was missing from this list, and the list is the
  // only thing that decides what runs.
  "backend/migrations/cloud/011_inventory_incremental_publication.sql",
  "backend/migrations/cloud/012_scope_management.sql",
  "backend/migrations/cloud/013_transfer_request_without_lot.sql",
];

module.exports = { migrationFiles, deliberatelyNotRun };

async function main() {
  const apply = process.argv.includes("--apply");
  const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    for (const relativeFile of migrationFiles) {
      const sql = fs.readFileSync(path.resolve(relativeFile), "utf8");
      await client.query(sql);
      console.log(`validated ${relativeFile}`);
    }
    await client.query(apply ? "COMMIT" : "ROLLBACK");
    console.log(apply ? "cloud migrations committed" : "cloud migration dry run rolled back");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

// Only when run as a command. Requiring this file -- which the coverage test does -- must not
// open a database connection.
if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
