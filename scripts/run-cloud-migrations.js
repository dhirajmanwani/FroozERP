const fs = require("fs");
const path = require("path");
const { Client } = require("../backend/node_modules/pg");

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
];

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

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
