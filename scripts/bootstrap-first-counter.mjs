#!/usr/bin/env node
/**
 * Create the first counter, on a deployment that has none.
 *
 * ## The deadlock this exists to break
 *
 * `POST /api/v3/admin/operational-locations` is guarded by `requireAssignmentOwner`, which needs
 * `manage_assignments` on **both** the caller's device assignment and their staff assignment. Both
 * are read by `resolveOperationalScope`, whose query inner-joins `device_assignments` to
 * `operational_locations` -- and `device_assignments.operational_location_id` is `NOT NULL`.
 *
 * So: no counter means no device assignment, no device assignment means no operational context, and
 * no context means the route that creates a counter refuses. The Branches & Counters screen can
 * manage counters perfectly well once one exists, and cannot bring the first one into being.
 *
 * That is the same shape as the first-Owner problem, and it gets the same answer:
 * `bootstrap-first-owner.mjs` moved that trust boundary to shell access on the server, which the
 * deployment already has and already protects. This does likewise. There is nothing here for a
 * stranger to reach, because nothing is listening.
 *
 * ## Usage
 *
 * On the machine running the backend, with the same DATABASE_URL it uses -- or from
 * anywhere, with DATABASE_PUBLIC_URL set to the host's public connection string:
 *
 *   node scripts/bootstrap-first-counter.mjs \
 *     --branch 1 --name "Main Branch Counter" --code MB-COUNTER \
 *     --device-id <the device id shown on the app's login screen> \
 *     --username owner
 *
 *   Optional: --type WAREHOUSE   (default STORE; a warehouse is just a counter that does not sell)
 *             --dry-run          (say what would happen, write nothing)
 *
 * ## What it refuses
 *
 * It refuses when the branch already has a counter. That keeps this a first-install action rather
 * than a second, unaudited way to add counters later -- the screen does that, with an audit trail
 * this deliberately does not duplicate.
 *
 * ## Shape
 *
 * `bootstrapFirstCounter` takes a database client and returns a decision; it never prints and never
 * exits. Everything below it is the terminal wrapper. That split exists so the refusals -- which are
 * the whole safety of this command -- can be proven without a database, in the backend suite, the
 * way every other refusal in this codebase is.
 */
import { argv, env, exit, stdout } from "node:process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const LOCATION_TYPES = Object.freeze(["STORE", "WAREHOUSE", "MANDI_COUNTER", "OFFICE"]);

/**
 * Every way this can say no. Named, because a caller comparing on message text would break the
 * moment a message is reworded, and these messages are meant to be reworded -- they are read by
 * somebody standing at a shop counter.
 */
export const REFUSALS = Object.freeze({
  USAGE: "USAGE",
  BAD_TYPE: "BAD_TYPE",
  NO_BRANCH: "NO_BRANCH",
  BRANCH_CLOSED: "BRANCH_CLOSED",
  BRANCH_HAS_NO_COMPANY: "BRANCH_HAS_NO_COMPANY",
  COUNTER_EXISTS: "COUNTER_EXISTS",
  DEVICE_ALREADY_ASSIGNED: "DEVICE_ALREADY_ASSIGNED",
  NO_USER: "NO_USER",
  USER_INACTIVE: "USER_INACTIVE",
  NOT_OWNER: "NOT_OWNER",
  WRONG_COMPANY: "WRONG_COMPANY",
  NO_DEVICE: "NO_DEVICE",
  DEVICE_NOT_APPROVED: "DEVICE_NOT_APPROVED",
  WRITE_FAILED: "WRITE_FAILED",
});

const refuse = (code, message) => ({ ok: false, code, message });

const USAGE = `Usage:
  node scripts/bootstrap-first-counter.mjs --branch <id> --name "<counter name>" --code <CODE> \\
       --device-id <device id> --username <owner username> [--type STORE|WAREHOUSE] [--dry-run]`;

/**
 * The permissions the first counter has to carry, on both sides.
 *
 * `requireAssignmentOwner` reads `manage_assignments` from the device assignment *and* from the
 * staff assignment and requires both. Granting one is the failure mode that looks like success:
 * the counter exists, the app opens, and Branches & Counters still refuses to create the second
 * one -- with the deadlock intact and no longer obvious.
 */
export const DEVICE_PERMISSIONS = Object.freeze({ manage_assignments: true, consolidated_reports: true });
export const STAFF_PERMISSIONS = Object.freeze({
  manage_assignments: true,
  consolidated_reports: true,
  operational_access: true,
});

/**
 * Decide, and -- unless `dryRun` -- write. Returns a decision; never throws for an expected refusal.
 *
 * @param {{query: Function}} client a connected client, already checked out of a pool
 */
export const bootstrapFirstCounter = async (client, options = {}) => {
  const branchId = Number(options.branchId);
  const name = String(options.name || "").trim();
  const code = String(options.code || "").trim().toUpperCase();
  const deviceId = String(options.deviceId || "").trim();
  const username = String(options.username || "").trim();
  const type = String(options.type || "STORE").trim().toUpperCase();
  const dryRun = Boolean(options.dryRun);

  if (!Number.isInteger(branchId) || branchId <= 0 || !name || !code || !deviceId || !username) {
    return refuse(REFUSALS.USAGE, USAGE);
  }
  if (!LOCATION_TYPES.includes(type)) {
    return refuse(REFUSALS.BAD_TYPE, `--type must be one of ${LOCATION_TYPES.join(", ")}. Got: ${type}`);
  }

  const branch = await client.query(
    "SELECT id, branch_name, company_id, active FROM branches WHERE id = $1",
    [branchId]
  );
  if (!branch.rows[0]) return refuse(REFUSALS.NO_BRANCH, `There is no branch ${branchId}.`);
  if (branch.rows[0].active === false) return refuse(REFUSALS.BRANCH_CLOSED, `Branch ${branchId} is closed.`);

  const companyId = Number(branch.rows[0].company_id || 0);
  if (!companyId) {
    // A branch with no company cannot sync at all (`requireSyncContext` refuses it), so a counter
    // under it would be born unable to do the one thing counters are for.
    return refuse(
      REFUSALS.BRANCH_HAS_NO_COMPANY,
      `Branch ${branchId} has no company. Fix that first, or every counter under it will be unable `
      + "to sync."
    );
  }

  // Company-wide, not branch-wide. The deadlock is company-wide: once *any* counter exists with
  // assignments on it, somebody can sign in with a working scope and Branches & Counters creates
  // every counter after that, for every branch. A branch-wide check would let this command keep
  // running forever as a second, unaudited way in -- and would walk straight into two unique
  // indexes it has no business arguing with (`device_assignments_one_active_idx`, one active
  // assignment per machine, and `staff_location_one_default_idx`, one default posting per person).
  const existing = await client.query(
    "SELECT id, location_name, branch_id FROM operational_locations WHERE company_id = $1 ORDER BY id LIMIT 1",
    [companyId]
  );
  if (existing.rows[0]) {
    return refuse(
      REFUSALS.COUNTER_EXISTS,
      `This company already has a counter ("${existing.rows[0].location_name}", branch `
      + `${existing.rows[0].branch_id}).\n`
      + "This command only creates the very first one, when nothing else can. Use Branches & Counters\n"
      + "in the app for every counter after that -- it records who changed what, which this\n"
      + "deliberately does not duplicate."
    );
  }

  const owner = await client.query(
    `SELECT u.id, u.username, u.company_id, u.active, r.id AS role_id, r.role_name
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE LOWER(u.username) = LOWER($1)`,
    [username]
  );
  const user = owner.rows[0];
  if (!user) return refuse(REFUSALS.NO_USER, `There is no user "${username}".`);
  if (user.active === false) return refuse(REFUSALS.USER_INACTIVE, `"${username}" is not an active user.`);
  if (String(user.role_name).toUpperCase() !== "OWNER") {
    return refuse(
      REFUSALS.NOT_OWNER,
      `"${username}" is a ${user.role_name}, not the Owner. Only the Owner can hold the first counter.`
    );
  }
  if (Number(user.company_id || 0) !== companyId) {
    return refuse(
      REFUSALS.WRONG_COMPANY,
      `"${username}" belongs to a different company than branch ${branchId}.`
    );
  }

  const device = await client.query(
    "SELECT device_id, device_name, status FROM authorized_devices WHERE device_id = $1",
    [deviceId]
  );
  if (!device.rows[0]) {
    return refuse(
      REFUSALS.NO_DEVICE,
      `This database has no device "${deviceId}".\n`
      + "Open the app on that machine, sign in once so it registers, approve it, then run this again.\n"
      + "The device id is shown on the login screen under \"Show technical details\"."
    );
  }
  if (String(device.rows[0].status).toUpperCase() !== "APPROVED") {
    return refuse(
      REFUSALS.DEVICE_NOT_APPROVED,
      `Device "${deviceId}" is ${device.rows[0].status}, not APPROVED. Approve it first.`
    );
  }

  // A machine stands at one counter: `device_assignments_one_active_idx` is a unique index on
  // `device_id WHERE active`. If this machine already has a posting -- including one in another
  // company -- then either it already has a working scope, or moving it is a relocation with an
  // audit trail, and both belong in the app rather than here.
  const posting = await client.query(
    `SELECT COALESCE(MAX(assignment_generation), 0) AS generation,
            COUNT(*) FILTER (WHERE active) AS active_count
     FROM device_assignments WHERE device_id = $1`,
    [deviceId]
  );
  if (Number(posting.rows[0]?.active_count || 0) > 0) {
    return refuse(
      REFUSALS.DEVICE_ALREADY_ASSIGNED,
      `Machine "${deviceId}" is already posted to a counter.\n`
      + "A machine stands at one counter at a time. Move it from Branches & Counters in the app,\n"
      + "which records the move; this command only sets up a machine that has never been posted."
    );
  }
  // Not always 1: a machine whose earlier posting was ended keeps its old generation rows, and
  // `(device_id, assignment_generation)` is unique. Continuing the count is what the app's own
  // approval path does.
  const generation = Number(posting.rows[0]?.generation || 0) + 1;

  const plan = {
    branchId,
    branchName: branch.rows[0].branch_name,
    companyId,
    name,
    code,
    type,
    deviceId,
    deviceName: device.rows[0].device_name || "unnamed",
    username: user.username,
    userId: user.id,
    roleId: user.role_id,
    generation,
  };

  if (dryRun) return { ok: true, dryRun: true, plan, locationId: null };

  try {
    await client.query("BEGIN");

    const location = await client.query(
      `INSERT INTO operational_locations
         (company_id, branch_id, location_code, location_name, location_type, timezone, active, is_default)
       VALUES ($1,$2,$3,$4,$5,'Asia/Kolkata',TRUE,TRUE)
       RETURNING id`,
      [companyId, branchId, code, name, type]
    );
    const locationId = location.rows[0].id;

    await client.query(
      `INSERT INTO device_assignments
         (device_id, company_id, branch_id, operational_location_id, device_type, intended_usage,
          fixed_operational, permission_set, assignment_generation, active, approved_by)
       VALUES ($1,$2,$3,$4,'desktop','COUNTER',TRUE,$5::jsonb,$6,TRUE,$7)`,
      [deviceId, companyId, branchId, locationId, JSON.stringify(DEVICE_PERMISSIONS), generation, user.id]
    );

    await client.query(
      `INSERT INTO staff_location_assignments
         (user_id, company_id, branch_id, operational_location_id, role_id, permission_set,
          is_default, active, assigned_by)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,TRUE,TRUE,$1)`,
      [user.id, companyId, branchId, locationId, user.role_id, JSON.stringify(STAFF_PERMISSIONS)]
    );

    await client.query("COMMIT");
    return { ok: true, dryRun: false, plan, locationId };
  } catch (error) {
    // Nothing partial survives: a counter with no assignments would look set up and behave as though
    // it were not, which is worse than the deadlock this command exists to break.
    await client.query("ROLLBACK").catch(() => null);
    return refuse(REFUSALS.WRITE_FAILED, `Nothing was written. ${error.message}`);
  }
};

const readFlag = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? "" : String(argv[index + 1] ?? "");
};
const hasFlag = (name) => argv.includes(`--${name}`);
const fail = (message) => {
  stdout.write(`\n${message}\n\n`);
  exit(1);
};

const describe = (plan) =>
  `\n  Branch      ${plan.branchId} -- ${plan.branchName}`
  + `\n  Counter     ${plan.name} (${plan.code}, ${plan.type})`
  + `\n  Machine     ${plan.deviceId} -- ${plan.deviceName}`
  + `\n  Owner       ${plan.username}`
  + `\n  Company     ${plan.companyId}\n\n`;

const main = async () => {
  const options = {
    branchId: Number(readFlag("branch")),
    name: readFlag("name"),
    code: readFlag("code"),
    deviceId: readFlag("device-id"),
    username: readFlag("username"),
    type: readFlag("type") || "STORE",
    dryRun: hasFlag("dry-run"),
  };

  // Both names, because these commands are run by hand from a laptop at least as often as from
  // the server. A hosted database exposes its outside-reachable string as DATABASE_PUBLIC_URL,
  // and accepting only DATABASE_URL sent the maintainer to "DATABASE_URL is not set" mid-setup
  // with the right value already sitting in the shell under the other name.
  const connectionString = env.DATABASE_PUBLIC_URL || env.DATABASE_URL;
  if (!connectionString) {
    fail("Neither DATABASE_PUBLIC_URL nor DATABASE_URL is set. Run this with the same database\n"
      + "configuration the backend uses, or the public connection string from your host.");
  }

  // Loaded here rather than at the top so the usage message above still works on a machine that has
  // not installed the backend's dependencies -- which is exactly the machine somebody runs this on
  // by mistake, and the moment they most need a readable error.
  const require = createRequire(new URL("../backend/package.json", import.meta.url));
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString });
  const client = await pool.connect();

  try {
    const result = await bootstrapFirstCounter(client, options);
    if (!result.ok) fail(result.message);

    stdout.write(describe(result.plan));
    if (result.dryRun) {
      stdout.write("  --dry-run: nothing was written.\n\n");
      return;
    }
    stdout.write(
      `  Created counter ${result.locationId}.\n\n`
      + "  Sign out and back in on that machine -- the session carries the old scope until you do.\n"
      + "  Branches & Counters can create every counter after this one.\n\n"
    );
  } finally {
    client.release();
    await pool.end();
  }
};

// Only when run as a command. Importing this file -- which the test suite does -- must not open a
// database connection or exit the process.
// `pathToFileURL` rather than string-building a `file://` URL: Windows is the shipped target, and
// `file://C:\...` does not compare equal to the URL Node gives this module.
const invokedDirectly = Boolean(argv[1]) && import.meta.url === pathToFileURL(argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => fail(`Nothing was written. ${error.message}`));
}
