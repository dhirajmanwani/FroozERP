#!/usr/bin/env node
/**
 * Look inside this device's local SQLite database, read-only, and say what is in it.
 *
 * ## Why this exists
 *
 * On 2026-09-07 the shop's app opened onto the activation screen with a device id it had never had
 * before, and `%APPDATA%\com.srtcompany.froozerp` was down to four entries -- the webview profile
 * and `cloud-network-policy.json` were gone. The only question that mattered was whether the
 * business data was still there, and there was no way to answer it: the app could not be signed
 * into, the file size alone proves nothing, and the machine has no SQLite client.
 *
 * A local-first system whose whole promise is "the data is on this computer" must be able to show
 * that the data is on this computer, without being signed in and without extra software. That is
 * this script.
 *
 * ## Safety
 *
 * Opens read-only and never writes. Prints **counts and identifiers only** -- never a customer, a
 * price or an amount -- so the output can be pasted into a chat or an issue while a shop is down.
 *
 * Usage:
 *   node scripts/inspect-local-db.mjs
 *   node scripts/inspect-local-db.mjs "D:\\some\\other\\froozerp-local.sqlite3"
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const APP_DIR_NAME = "com.srtcompany.froozerp";
const DB_FILE = "froozerp-local.sqlite3";

const defaultDatabasePath = () => {
  const roaming = process.env.APPDATA
    || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(roaming, APP_DIR_NAME, DB_FILE);
};

/** Tables worth counting, and what each one means to somebody who is not a programmer. */
const TABLES_OF_INTEREST = [
  ["local_device_identity", "this computer's identity"],
  ["local_entitlements", "activation"],
  ["users", "sign-in accounts"],
  ["products", "products"],
  ["inventory_batches", "stock lots"],
  ["pos_sales", "bills"],
  ["pos_sale_items", "bill lines"],
  ["purchases", "purchases"],
  ["parties", "customers and suppliers"],
  ["sync_outbox", "bills waiting to reach the cloud"],
];

const openDatabase = async (file) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch (error) {
    console.error("This Node cannot open SQLite files (needs Node 22 or newer).");
    console.error(String(error?.message || error));
    process.exit(2);
  }
  // Read-only, always. This script runs when a shop is already in trouble; it must not be capable
  // of making that worse, even by a schema touch on open.
  return new DatabaseSync(file, { readOnly: true });
};

const main = async () => {
  const file = process.argv[2] || defaultDatabasePath();
  console.log(`Database: ${file}`);

  if (!fs.existsSync(file)) {
    console.log("RESULT: this file does not exist.");
    process.exit(1);
  }
  const stat = fs.statSync(file);
  console.log(`Size: ${stat.size.toLocaleString("en-IN")} bytes`);
  console.log(`Last changed: ${stat.mtime.toISOString()}`);

  // A -wal alongside means recent writes may not be in the main file yet. Worth saying, because it
  // changes what a size on disk means.
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(file + suffix)) {
      console.log(`Companion file present: ${path.basename(file)}${suffix} (${fs.statSync(file + suffix).size} bytes)`);
    }
  }

  const db = await openDatabase(file);

  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().map((row) => row.name);
  console.log(`\nTables in this database: ${tables.length}`);
  if (tables.length === 0) {
    console.log("RESULT: the file has no tables at all. It is not a FroozERP database.");
    return;
  }

  console.log("\nWhat is in it:");
  let businessRows = 0;
  for (const [table, meaning] of TABLES_OF_INTEREST) {
    if (!tables.includes(table)) {
      console.log(`  ${meaning.padEnd(34)} table not present`);
      continue;
    }
    try {
      const { count } = db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get();
      console.log(`  ${meaning.padEnd(34)} ${count}`);
      if (["products", "pos_sales", "purchases", "parties", "inventory_batches"].includes(table)) {
        businessRows += Number(count) || 0;
      }
    } catch (error) {
      console.log(`  ${meaning.padEnd(34)} could not be read: ${error.message}`);
    }
  }

  // The identity rows, because a missing one is what sends the app to the activation screen. Ids
  // and status only -- these are not secrets and they are exactly what a diagnosis needs.
  if (tables.includes("local_device_identity")) {
    const rows = db.prepare(
      "SELECT device_id, device_name, registration_status, branch_id FROM local_device_identity ORDER BY device_id",
    ).all();
    console.log("\nDevice identities recorded here:");
    if (rows.length === 0) console.log("  (none -- this is why the app asks to be activated)");
    for (const row of rows) {
      console.log(`  ${row.device_id}  status=${row.registration_status || "?"}  branch=${row.branch_id ?? "?"}  name=${row.device_name || "?"}`);
    }
  }

  console.log("");
  console.log(businessRows > 0
    ? `RESULT: this database holds business data (${businessRows} rows across products, stock, bills, purchases and parties).`
    : "RESULT: this database has the FroozERP tables but no business data in them. It is a fresh database.");

  db.close();
};

main().catch((error) => {
  console.error(`Could not inspect the database: ${error?.message || error}`);
  process.exit(1);
});
