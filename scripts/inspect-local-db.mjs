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

/**
 * Tables whose row counts mean "there is a business in here", by name in the local schema.
 *
 * Deliberately resolved against the tables the database actually has rather than assumed. The
 * first version of this script hardcoded a guessed list, and every guess that missed printed
 * "table not present" -- which reads as "empty" and is not the same thing at all. On a shop that
 * had just lost its database, that is precisely the wrong way to be wrong.
 */
const BUSINESS_TABLE_HINTS = ["product", "sale", "invoice", "bill", "purchase", "part", "stock", "inventory", "lot", "customer", "supplier", "payment", "order", "user"];

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

  // Count every table, not a list somebody remembered. A table this script has never heard of
  // holding a thousand rows is exactly the evidence that matters, and a hardcoded list hides it.
  const counts = [];
  for (const table of tables) {
    try {
      const { count } = db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get();
      counts.push([table, Number(count) || 0]);
    } catch (error) {
      counts.push([table, `unreadable: ${error.message}`]);
    }
  }

  const populated = counts.filter(([, count]) => typeof count === "number" && count > 0);
  const unreadable = counts.filter(([, count]) => typeof count !== "number");

  console.log("\nTables that have rows in them:");
  if (populated.length === 0) console.log("  (none -- every table is empty)");
  for (const [table, count] of populated.sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(8)}  ${table}`);
  }
  console.log(`\nEmpty tables: ${counts.length - populated.length - unreadable.length} of ${counts.length}`);
  for (const [table, reason] of unreadable) console.log(`  ${table}: ${reason}`);

  // "Is there a business in here" is judged on the tables that would hold one, whatever they are
  // called, and never on a table failing to exist.
  const businessRows = populated
    .filter(([table]) => BUSINESS_TABLE_HINTS.some((hint) => table.toLowerCase().includes(hint)))
    .reduce((total, [, count]) => total + count, 0);

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
    ? `RESULT: this database holds business data -- ${businessRows} rows in tables that carry products, stock, bills, purchases, parties or accounts.`
    : "RESULT: this database has the FroozERP tables and no business rows in any of them. It is a fresh database.");

  db.close();
};

main().catch((error) => {
  console.error(`Could not inspect the database: ${error?.message || error}`);
  process.exit(1);
});
