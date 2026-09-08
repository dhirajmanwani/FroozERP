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

// Imported, not copied. `bootstrap-first-counter.mjs` establishes what a counter machine may do,
// and its own comment warns that granting one half of the pair leaves the deadlock intact. Two
// copies of that set would drift, and the drift would be invisible until a screen refused.
import { DEVICE_PERMISSIONS } from "./bootstrap-first-counter.mjs";

/** Every way this can say no, named so a caller never has to compare on message text. */
export const REFUSALS = Object.freeze({
  USAGE: "USAGE",
  NO_DEVICE: "NO_DEVICE",
  ALREADY_APPROVED: "ALREADY_APPROVED",
  DELIBERATELY_BLOCKED: "DELIBERATELY_BLOCKED",
  NO_COUNTER: "NO_COUNTER",
  COUNTER_CLOSED: "COUNTER_CLOSED",
  ALREADY_POSTED: "ALREADY_POSTED",
  NOBODY_AT_COUNTER: "NOBODY_AT_COUNTER",
  WRITE_FAILED: "WRITE_FAILED",
});

const refuse = (code, message) => ({ ok: false, code, message });

const USAGE = `Usage:
  node scripts/approve-device.mjs --device-id <id shown on the app's login screen> [--apply]

  --apply        actually write. Without it this is a dry run.
  --counter <id> also post this machine to that counter (an operational location id).
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
  const counterId = options.counterId === undefined || options.counterId === null || options.counterId === ""
    ? null
    : Number(options.counterId);

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
  // "Already approved" is only *nothing to do* when approving was the whole request.
  //
  // The first version returned here unconditionally, which made the command useless in exactly the
  // situation it was extended for: a device approved an hour earlier, still posted nowhere, and
  // `--counter` refused with "Nothing to do." An early return that ignores the rest of the request
  // is not a no-op, it is a silent refusal to do the part that was asked for.
  if (status === "APPROVED" && counterId === null) {
    return refuse(
      REFUSALS.ALREADY_APPROVED,
      `${deviceId} is already approved (${device.device_name || "unnamed"}). Nothing to do.\n`
      + "To post it to a counter as well, pass --counter <id>."
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
    counter: null,
  };

  // Posting the machine to a counter, when asked.
  //
  // This command was written approve-only, on the reasoning that assignments belong to Branches &
  // Counters. That reasoning was wrong for the case the command exists to serve. A machine with no
  // posting has no operational scope, so every screen filters to nothing and Branches & Counters
  // itself refuses with "User and device do not share an approved operational location" -- the very
  // screen that would fix it. Approve-only left the maintainer exactly one step further into the
  // same deadlock, at one in the morning.
  //
  // Still opt-in. Approval and posting are different decisions, and the default stays the narrow
  // one.
  if (counterId !== null) {
    const location = await client.query(
      `SELECT ol.id, ol.location_name, ol.company_id, ol.branch_id, ol.active, b.branch_name
         FROM operational_locations ol
         JOIN branches b ON b.id = ol.branch_id AND b.company_id = ol.company_id
        WHERE ol.id = $1`,
      [counterId]
    );
    const counter = location.rows[0];
    if (!counter) return refuse(REFUSALS.NO_COUNTER, `No counter has id ${counterId}. \`node scripts/show-setup.mjs\` lists them under COUNTERS.`);
    if (counter.active === false) {
      return refuse(REFUSALS.COUNTER_CLOSED, `Counter ${counterId} (${counter.location_name}) is closed. Reopen it in the app before posting a machine to it.`);
    }

    // A machine stands at one counter: `device_assignments_one_active_idx` is unique on device_id
    // where active. An existing posting means either a working scope already, or a relocation --
    // and a relocation carries an audit trail that belongs in the app.
    const posting = await client.query(
      `SELECT COALESCE(MAX(assignment_generation), 0) AS generation,
              COUNT(*) FILTER (WHERE active) AS active_count
         FROM device_assignments WHERE device_id = $1`,
      [deviceId]
    );
    if (Number(posting.rows[0]?.active_count || 0) > 0) {
      return refuse(
        REFUSALS.ALREADY_POSTED,
        `${deviceId} is already posted to a counter.\n`
        + "A machine stands at one counter at a time. Move it from Branches & Counters, which records the move."
      );
    }

    // Both halves or neither. `requireAssignmentOwner` reads manage_assignments from the device
    // assignment *and* the staff assignment; posting a machine where nobody is posted produces a
    // login that still fails DEVICE_LOCATION_MISMATCH, which looks identical to doing nothing.
    const staffed = await client.query(
      `SELECT COUNT(*)::INTEGER AS count
         FROM staff_location_assignments
        WHERE operational_location_id = $1 AND active = TRUE`,
      [counterId]
    );
    if (Number(staffed.rows[0]?.count || 0) === 0) {
      return refuse(
        REFUSALS.NOBODY_AT_COUNTER,
        `Nobody is posted to counter ${counterId} (${counter.location_name}).\n`
        + "A machine posted where no person is posted still cannot sign in -- the login gate needs both.\n"
        + "Post a person there first; `node scripts/show-setup.mjs` lists them under PEOPLE POSTED TO COUNTERS."
      );
    }

    // Not always 1: a machine whose earlier posting was ended keeps its old generation rows, and
    // (device_id, assignment_generation) is unique. Continuing the count is what the app does.
    plan.counter = {
      id: counter.id,
      name: counter.location_name,
      branchName: counter.branch_name,
      companyId: counter.company_id,
      branchId: counter.branch_id,
      generation: Number(posting.rows[0]?.generation || 0) + 1,
    };
  }

  if (!apply) return { ok: true, dryRun: true, plan };

  // One transaction. A device approved but not posted, or posted but not approved, is a machine
  // that looks set up and behaves as though it is not -- which is the state this whole command
  // exists to get out of.
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE authorized_devices
          SET status = 'APPROVED',
              approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP),
              updated_at = CURRENT_TIMESTAMP
        WHERE device_id = $1`,
      [deviceId]
    );
    if (plan.counter) {
      await client.query(
        `INSERT INTO device_assignments
           (device_id, company_id, branch_id, operational_location_id, device_type, intended_usage,
            fixed_operational, permission_set, assignment_generation, active)
         VALUES ($1,$2,$3,$4,'desktop','COUNTER',TRUE,$5::jsonb,$6,TRUE)`,
        [
          deviceId,
          plan.counter.companyId,
          plan.counter.branchId,
          plan.counter.id,
          JSON.stringify(DEVICE_PERMISSIONS),
          plan.counter.generation,
        ]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    return refuse(REFUSALS.WRITE_FAILED, `Nothing was written. ${error.message}`);
  }
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
  + (plan.counter
    ? "\n  Counter     " + plan.counter.name + " (" + plan.counter.branchName + "), id " + plan.counter.id
    : "\n  Counter     not posted -- pass --counter <id> to post it")
  + "\n\n";

const main = async () => {
  const options = {
    deviceId: readFlag("device-id"),
    counterId: readFlag("counter"),
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
      (result.plan.counter
        ? `  ${result.plan.previousStatus === "APPROVED" ? "Posted" : "Approved and posted"}.\n\n  Sign in again on that machine -- the session carries the old scope until you do.\n\n`
        : "  Approved.\n\n"
          + "  Approval alone gives no counter, and without one every screen filters to nothing.\n"
          + "  Re-run with --counter <id> (see COUNTERS in show-setup), or post it from the app.\n\n")
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
