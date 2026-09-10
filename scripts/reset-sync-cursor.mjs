#!/usr/bin/env node
/**
 * Let a device ask the cloud for a full copy of the shop's data again.
 *
 * ## The trap this opens
 *
 * `frontend/src/local/syncService.js:432`:
 *
 *     bootstrap_protocol: cursor === "0" ? "reference-v1" : undefined
 *
 * The reference bootstrap -- the only thing that fills a device from the cloud -- is requested
 * exactly once, when the local cursor is still zero. Applying it stores the server's high
 * watermark as the new cursor, and from then on the device asks only for changes *after* that
 * point, which are read from `sync_change_log`. The shop's existing products, suppliers and lots
 * are not in that log; they predate it. They can only ever arrive by bootstrap.
 *
 * So a bootstrap that returns zero rows is a one-way door. On 2026-09-09 the DELL walked through
 * it: the cloud's business rows had no `company_id`, the bootstrap matched none of them, sent
 * nothing, and recorded the watermark anyway. The device then had a valid session, a healthy
 * cloud, an approved assignment, no error anywhere -- and no way, through any screen in the app,
 * to ever ask again. Repairing the cloud afterwards changes nothing on its own, because the
 * device has stopped asking the only question whose answer contains that data.
 *
 * Setting the cursor back to zero reopens the door.
 *
 * ## What it touches
 *
 * Sync bookkeeping on this device only: the pull cursor, and the stored note saying a bootstrap
 * has already been applied. It does not touch business rows, and it does not touch anything on the
 * cloud. Work this device has done and not yet pushed lives in the outbox, which is a different
 * table and is left alone -- the pull cursor has no bearing on it.
 *
 * Dry run by default. `--apply` is required.
 *
 * Usage:
 *   node scripts/reset-sync-cursor.mjs
 *   node scripts/reset-sync-cursor.mjs --apply
 */

import fs from "node:fs";
import path from "node:path";
import { argv, env, exit, stdout } from "node:process";
import { pathToFileURL } from "node:url";

const APP_DIR = "com.srtcompany.froozerp";
const DB_NAME = "froozerp-local.sqlite3";

export const defaultDatabasePath = (environment = env) => {
  const appData = environment.APPDATA
    || (environment.HOME ? path.join(environment.HOME, ".local", "share") : null);
  return appData ? path.join(appData, APP_DIR, DB_NAME) : null;
};

/**
 * What resetting would mean, given what the device holds. Pure, so the refusals are testable
 * without a database on disk.
 */
export const planReset = ({ syncRows, pendingOperations }) => {
  const alreadyZero = syncRows.every((row) =>
    !row.last_pull_cursor || String(row.last_pull_cursor) === "0");
  if (!syncRows.length) {
    return {
      refused: "NO_SYNC_STATE",
      message: "This device has no sync state at all, so it will request a bootstrap on its next "
        + "sync already. Nothing to reset.",
    };
  }
  if (alreadyZero) {
    return {
      refused: "ALREADY_ZERO",
      message: "The cursor is already zero, so the next sync will request a full bootstrap. "
        + "Nothing to reset.",
    };
  }
  return {
    rows: syncRows.map((row) => ({ device_id: row.device_id, from: String(row.last_pull_cursor) })),
    pendingOperations,
  };
};

const main = async () => {
  const apply = argv.includes("--apply");
  const explicit = argv.find((value) => value.endsWith(".sqlite3"));
  const databasePath = explicit || defaultDatabasePath();
  if (!databasePath || !fs.existsSync(databasePath)) {
    stdout.write(`\nNo local database found${databasePath ? ` at ${databasePath}` : ""}.\n`
      + "Pass the path to froozerp-local.sqlite3 as an argument if it lives somewhere else.\n\n");
    exit(1);
  }

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    stdout.write("\nThis Node build has no node:sqlite. Use Node 22 or newer.\n\n");
    exit(1);
  }

  const db = new DatabaseSync(databasePath);
  try {
    const syncRows = db.prepare(
      "SELECT device_id, last_pull_cursor, last_server_cursor FROM sync_state WHERE device_id <> 'default'"
    ).all();
    let pendingOperations = 0;
    try {
      pendingOperations = Number(db.prepare(
        "SELECT COUNT(*) AS n FROM sync_outbox WHERE status <> 'COMPLETED'"
      ).get()?.n || 0);
    } catch {
      pendingOperations = 0;
    }

    stdout.write(`\nDatabase: ${databasePath}\n`);
    const plan = planReset({ syncRows, pendingOperations });
    if (plan.refused) {
      stdout.write(`\nNothing was changed (${plan.refused}).\n${plan.message}\n\n`);
      exit(0);
    }

    stdout.write("\nThis device has already applied a bootstrap, so it is only asking for changes\n"
      + "made since then -- and the shop's existing products are older than that log.\n\n");
    for (const row of plan.rows) {
      stdout.write(`  ${row.device_id}: pull cursor ${row.from} -> 0\n`);
    }
    if (plan.pendingOperations) {
      stdout.write(`\n  ${plan.pendingOperations} operations are waiting to be pushed. They are in the outbox,\n`
        + "  which this does not touch, and they will still be pushed.\n");
    }

    if (!apply) {
      stdout.write("\nDRY RUN. Nothing was changed. Re-run with --apply, then sign out and back in.\n\n");
      return;
    }

    db.exec("BEGIN");
    db.prepare("UPDATE sync_state SET last_pull_cursor = '0', last_server_cursor = '0' WHERE device_id <> 'default'").run();
    db.prepare("DELETE FROM local_kv WHERE key = 'reference_bootstrap_meta'").run();
    db.exec("COMMIT");
    stdout.write("\nDone. The next sync will ask the cloud for a full copy.\n"
      + "Sign out and back in on the app, then run scripts/inspect-local-db.mjs.\n\n");
  } finally {
    db.close();
  }
};

const invokedDirectly = Boolean(argv[1]) && import.meta.url === pathToFileURL(argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    stdout.write(`\nNothing was changed. ${error.message}\n\n`);
    exit(1);
  });
}
