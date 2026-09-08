#!/usr/bin/env node
/**
 * Approve a device from the server side, when no approved device is left to approve it from.
 *
 * ## The deadlock this exists to break
 *
 * Device approval lives in Settings, which needs a signed-in Owner, which needs `/login`, which
 * refuses `DEVICE_PENDING_APPROVAL` for any device that is not already approved. That is correct
 * and is the whole point of the gate — right up until the only device the shop has stops being
 * approved, at which point there is no way in at all.
 *
 * It happened on 2026-09-08. The maintainer ticked "clear application data" while uninstalling; the
 * local database went with it; the app came back with a new device identity it had generated for
 * itself; and the cloud, correctly, had never heard of it. Everything else had already been fixed
 * by then — the mode, the missing columns, the sign-in — and the shop still could not open, because
 * approving a device requires a device that is approved.
 *
 * This is the same shape as the first-Owner and first-Counter problems, and it takes the same
 * answer `bootstrap-first-owner.mjs` gives: move the trust boundary to shell access on the server,
 * which the deployment already has and already protects. There is nothing here for a stranger to
 * reach, because nothing is listening.
 *
 * ## Deliberately narrow
 *
 * It sets `authorized_devices.status` to `APPROVED` and nothing else. It does not create a device
 * assignment, does not grant permissions, and does not touch users — those are the ordinary
 * screens' work, and duplicating them here would build a second, unaudited way to do them.
 *
 * ## Usage
 *
 *   node scripts/approve-device.mjs --device-id FZDEV-...            (dry run: says what it would do)
 *   node scripts/approve-device.mjs --device-id FZDEV-... --apply
 *
 * Dry run is the default, matching `run-cloud-migrations.js`: these are writes to a live shop's
 * database, and the shape that does something should be the one you have to ask for.
 *
 * ## What it refuses
 *
 * A device it has never seen, because a device id typed by hand is a device id that can be typed
 * wrong, and inserting one would authorise a machine that has never registered. The device must
 * have reached the cloud once — which it does the moment somebody tries to sign in on it, and which
 * is why the id on the login screen is the id to pass here.
 *
 * A device that was DISABLED or REVOKED, because that was somebody's decision and reversing it
 * silently from a shell is exactly the move this script must not make. `--reinstate` says it out
 * loud instead.
 *
 * ## Shape
 *
 * `approveDevice` takes a database client and returns a decision; it never prints and never exits.
 * Everything below it is the terminal wrapper. That split exists so the refusals — which are the
 * whole safety of this command — can be proven without a database.
 */

import { argv, env, exit, stdout } from "node:process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/** Every way this can say no, named so a caller never has to compare on message text. */
export const REFUSALS = Object.freeze({
  USAGE: "USAGE",
  NO_DEVICE: "NO_DEVICE",
  ALREADY_APPROVED: "ALREADY_APPROVED",
  DELIBERATELY_BLOCKED: "DELIBERATELY_BLOCKED",
});

const refuse = (code, message) => ({ ok: false, code, message });

const USAGE = `Usage:
  node scripts/approve-device.mjs --device-id <id shown on the app's login screen> [--apply]

  --apply        actually write. Without it this is a dry run.
  --reinstate    also allow a DISABLED or REVOKED device to be approved again.`;

/** Statuses that mean somebody deliberately shut this device out. */
export const BLOCKED_STATUSES = Object.freeze(["DISABLED", "REVOKED"]);

/**
 * Decide, and — unless this is a dry run — write.
 *
 * @param {{query: Function}} client a connected client, already checked out of a pool
 */
export const approveDevice = async (client, options = {}) => {
  const deviceId = String(options.deviceId || "").trim();
  const apply = Boolean(options.apply);
  const reinstate = Boolean(options.reinstate);

  if (!deviceId) return refuse(REFUSALS.USAGE, USAGE);

  const found = await client.query(
    "SELECT device_id, device_name, status, approved_at, last_active_at FROM authorized_devices WHERE device_id = $1",
    [deviceId]
  );
  const device = found.rows[0];
  if (!device) {
    // Never insert. A device that has never registered has never proved it exists, and a typo in a
    // device id would otherwise authorise a machine nobody has seen.
    return refuse(
      REFUSALS.NO_DEVICE,
      `No device is registered with id ${deviceId}.\n`
      + "The id must be the one shown on that machine's login screen, and the machine must have\n"
      + "reached the cloud at least once — which it does as soon as somebody tries to sign in on it."
    );
  }

  const status = String(device.status || "").toUpperCase();
  if (status === "APPROVED") {
    return refuse(
      REFUSALS.ALREADY_APPROVED,
      `${deviceId} is already approved (${device.device_name || "unnamed"}). Nothing to do.`
    );
  }
  if (BLOCKED_STATUSES.includes(status) && !reinstate) {
    return refuse(
      REFUSALS.DELIBERATELY_BLOCKED,
      `${deviceId} is ${status}. That was a decision somebody made, not a device waiting its turn.\n`
      + "Pass --reinstate as well if you mean to undo it."
    );
  }

  const plan = {
    deviceId: device.device_id,
    deviceName: device.device_name || "unnamed",
    previousStatus: status || "UNKNOWN",
    lastActiveAt: device.last_active_at,
  };
  if (!apply) return { ok: true, dryRun: true, plan };

  await client.query(
    `UPDATE authorized_devices
        SET status = 'APPROVED',
            approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP),
            updated_at = CURRENT_TIMESTAMP
      WHERE device_id = $1`,
    [deviceId]
  );
  return { ok: true, dryRun: false, plan };
};

// ---------------------------------------------------------------------------------------------
// Terminal wrapper
// ---------------------------------------------------------------------------------------------

const readFlag = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? "" : String(argv[at + 1] || "").trim();
};
const hasFlag = (name) => argv.includes(`--${name}`);

const fail = (message) => {
  stdout.write(`\n${message}\n\n`);
  exit(1);
};

const describe = (plan) =>
  "\n  Device      " + plan.deviceId
  + "\n  Name        " + plan.deviceName
  + "\n  Status      " + plan.previousStatus + " -> APPROVED"
  + "\n  Last seen   " + (plan.lastActiveAt ? new Date(plan.lastActiveAt).toISOString() : "never")
  + "\n\n";

const main = async () => {
  const options = {
    deviceId: readFlag("device-id"),
    apply: hasFlag("apply"),
    reinstate: hasFlag("reinstate"),
  };

  // Both names. A hosted database exposes its outside-reachable string as DATABASE_PUBLIC_URL, and
  // accepting only DATABASE_URL has already sent the maintainer to "DATABASE_URL is not set" with
  // the right value sitting in the shell under the other name.
  const connectionString = env.DATABASE_PUBLIC_URL || env.DATABASE_URL;
  if (!connectionString) {
    fail("Neither DATABASE_PUBLIC_URL nor DATABASE_URL is set. Run this with the same database\n"
      + "configuration the backend uses, or the public connection string from your host.");
  }

  // Loaded here rather than at the top so the usage message still works on a machine that has not
  // installed the backend's dependencies.
  const require = createRequire(new URL("../backend/package.json", import.meta.url));
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString });
  const client = await pool.connect();

  try {
    const result = await approveDevice(client, options);
    if (!result.ok) fail(result.message);

    stdout.write(describe(result.plan));
    if (result.dryRun) {
      stdout.write("  Dry run: nothing was written. Add --apply to do it.\n\n");
      return;
    }
    stdout.write(
      "  Approved.\n\n"
      + "  Sign in again on that machine. Approval alone does not give it a counter — assign one\n"
      + "  from Branches & Counters once you are in.\n\n"
    );
  } finally {
    client.release();
    await pool.end();
  }
};

// Only when run as a command. Importing this file — which the test suite does — must not open a
// database connection or exit the process.
const invokedDirectly = Boolean(argv[1]) && import.meta.url === pathToFileURL(argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => fail(`Nothing was written. ${error.message}`));
}
