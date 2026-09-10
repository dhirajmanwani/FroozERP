#!/usr/bin/env node
/**
 * Retire the device rows a machine leaves behind every time it is reinstalled.
 *
 * ## Why there are eleven of them
 *
 * A device id is minted per installation, not per machine. Reinstall the app, clear its data, or
 * rebuild the laptop, and the same physical counter asks to be registered again under a new id.
 * The old row stays exactly as it was -- `APPROVED`, posted to a counter, with a name identical to
 * the new one.
 *
 * On 2026-09-09 the shop's cloud held eleven rows for one laptop, five of them created that week.
 * Nothing is broken by this on its own, which is why it accumulated. What it costs is the ability
 * to answer a question: when a counter misbehaves, "which of these five identical rows is the one
 * in front of me" has no answer, and an approval or a posting can land on a row nobody is using
 * while the live one stays untouched. That is an evening, and it has already been spent once.
 *
 * ## What retiring means here
 *
 * `status = 'DISABLED'` -- the state the app's own reject/disable action already writes, and one
 * the sync path already refuses. Not a new status, and not a DELETE: the row is the record that a
 * machine was once approved and by whom, and deleting it destroys the only account of that.
 *
 * ## What it will not touch
 *
 * A device holding an active `device_assignments` row is posted to a counter and may be somebody's
 * till right now. Those are reported and left alone, however old they look. Retiring one would
 * take a working counter off the air to tidy a list, which is the wrong trade in every case.
 *
 * So this only ever retires rows that are **not posted anywhere** and have **not synced recently**.
 * If that leaves the mess untouched -- several posted rows for one machine -- it says so, and the
 * decision stays with the maintainer, who can see which laptop is which.
 *
 * Dry run by default. `--apply` writes, in one transaction.
 *
 * Usage:
 *   $env:DATABASE_PUBLIC_URL = "..."
 *   node scripts/retire-devices.mjs                 # show what would be retired
 *   node scripts/retire-devices.mjs --days 60       # stricter idea of "recent" (default 30)
 *   node scripts/retire-devices.mjs --apply
 */

import { argv, env, exit, stdout } from "node:process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/** Statuses worth retiring. Anything already retired or refused is left as it is. */
export const RETIRABLE = Object.freeze(["PENDING", "APPROVED"]);

const daysBetween = (from, to) => (to.getTime() - new Date(from).getTime()) / 86400000;

/**
 * Decide which device rows to retire.
 *
 * Pure, so every refusal is testable without a database -- and the refusals are the point. `now` is
 * a parameter for the same reason: a rule about "recently" that reads the clock cannot be tested.
 *
 * Each device: { device_id, device_name, status, posted (bool), last_seen (ISO string or null) }
 */
export const planRetirement = ({ devices, now = new Date(), idleDays = 30 }) => {
  const retirable = devices.filter((device) => RETIRABLE.includes(String(device.status).toUpperCase()));

  const posted = retirable.filter((device) => device.posted);
  const candidates = retirable.filter((device) => {
    if (device.posted) return false;
    // Never seen is not "idle for a long time" -- it is a registration that was never completed,
    // and those are exactly the five this shop collected in a week.
    if (!device.last_seen) return true;
    return daysBetween(device.last_seen, now) >= idleDays;
  });

  const recentlyActive = retirable.filter(
    (device) => !device.posted && device.last_seen && daysBetween(device.last_seen, now) < idleDays,
  );

  if (!candidates.length) {
    return {
      refused: "NOTHING_TO_RETIRE",
      message: "Every device row is either posted to a counter or has synced recently. Nothing here "
        + "is safe to retire, and nothing needs to be.",
      posted,
      recentlyActive,
    };
  }

  // A shop with no usable device cannot bill. If retiring everything proposed would leave nothing
  // posted and nothing recently active, this is not tidying -- it is taking the shop off the air.
  const survivors = posted.length + recentlyActive.length;
  if (survivors === 0) {
    return {
      refused: "WOULD_RETIRE_EVERY_DEVICE",
      message: `All ${candidates.length} device rows are unposted and idle, so retiring them would `
        + "leave the shop with none. That is a bigger decision than tidying a list: post the machine "
        + "that is actually in use to a counter first (scripts/approve-device.mjs --counter), then "
        + "run this again.",
      posted,
      recentlyActive,
    };
  }

  return { retire: candidates, posted, recentlyActive, survivors };
};

const pad = (value, width) => String(value ?? "").padEnd(width);
const describe = (device, now) => `${pad(device.device_id, 44)} ${pad(device.status, 9)} `
  + `${pad(device.device_name, 22)} ${device.last_seen ? `last seen ${Math.floor(daysBetween(device.last_seen, now))}d ago` : "never seen"}`;

const main = async () => {
  const apply = argv.includes("--apply");
  const daysFlag = argv.indexOf("--days");
  const idleDays = daysFlag === -1 ? 30 : Number(argv[daysFlag + 1]);
  if (!Number.isFinite(idleDays) || idleDays < 1) {
    stdout.write("\n--days needs a whole number of days, at least 1.\n\n");
    exit(1);
  }
  const connectionString = env.DATABASE_PUBLIC_URL || env.DATABASE_URL;
  if (!connectionString) {
    stdout.write("\nNeither DATABASE_PUBLIC_URL nor DATABASE_URL is set.\n\n");
    exit(1);
  }

  const require = createRequire(new URL("../backend/package.json", import.meta.url));
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    const columns = new Set((await client.query(
      "SELECT column_name FROM information_schema.columns"
      + " WHERE table_schema = 'public' AND table_name = 'authorized_devices'"
    )).rows.map((row) => row.column_name));

    // `last_sync_at` arrives by ALTER and a database that has not had it applied is exactly the
    // kind this repository keeps meeting. Fall back rather than crash on the column being absent.
    const lastSeen = columns.has("last_sync_at")
      ? "GREATEST(COALESCE(d.last_sync_at, 'epoch'::TIMESTAMP), COALESCE(d.last_active_at, 'epoch'::TIMESTAMP))"
      : "COALESCE(d.last_active_at, 'epoch'::TIMESTAMP)";

    const devices = (await client.query(
      `SELECT d.device_id, d.device_name, d.status,
              (da.device_id IS NOT NULL) AS posted,
              NULLIF(${lastSeen}, 'epoch'::TIMESTAMP) AS last_seen
       FROM authorized_devices d
       LEFT JOIN device_assignments da ON da.device_id = d.device_id AND da.active = TRUE
       ORDER BY d.device_name, d.status, d.device_id`
    )).rows;

    const now = new Date();
    stdout.write(`\n${devices.length} device rows on this cloud.\n`);

    const plan = planRetirement({ devices, now, idleDays });

    if (plan.posted?.length) {
      stdout.write(`\nPosted to a counter -- left alone, whatever their age:\n`);
      for (const device of plan.posted) stdout.write(`  ${describe(device, now)}\n`);
      if (plan.posted.length > 1) {
        stdout.write("\n  More than one row is posted. If these are the same physical machine, only\n"
          + "  one of them is real, and this cannot tell which -- that needs somebody who can see\n"
          + "  the counter.\n");
      }
    }
    if (plan.recentlyActive?.length) {
      stdout.write(`\nSynced within ${idleDays} days -- left alone:\n`);
      for (const device of plan.recentlyActive) stdout.write(`  ${describe(device, now)}\n`);
    }

    if (plan.refused) {
      stdout.write(`\nNothing was written (${plan.refused}).\n${plan.message}\n\n`);
      exit(plan.refused === "NOTHING_TO_RETIRE" ? 0 : 1);
    }

    stdout.write(`\nWould retire (unposted, and not seen for ${idleDays} days or never):\n`);
    for (const device of plan.retire) stdout.write(`  ${describe(device, now)}\n`);
    stdout.write(`\n${plan.survivors} device rows stay usable.\n`);

    if (!apply) {
      stdout.write("\nDRY RUN. Nothing was changed. Re-run with --apply.\n\n");
      return;
    }

    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE authorized_devices SET status = 'DISABLED', updated_at = CURRENT_TIMESTAMP
       WHERE device_id = ANY($1::TEXT[]) AND status = ANY($2::TEXT[])`,
      [plan.retire.map((device) => device.device_id), RETIRABLE],
    );
    await client.query("COMMIT");
    stdout.write(`\nRetired ${result.rowCount} device rows. Their history is kept; they can no longer sync.\n\n`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
};

const invokedDirectly = Boolean(argv[1]) && import.meta.url === pathToFileURL(argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    stdout.write(`\nNothing was changed. ${error.message}\n\n`);
    exit(1);
  });
}
