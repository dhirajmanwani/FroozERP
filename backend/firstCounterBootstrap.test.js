"use strict";

/**
 * The command that breaks the first-counter deadlock, and everything it refuses to do.
 *
 * ## The deadlock
 *
 * `POST /api/v3/admin/operational-locations` is guarded by `requireAssignmentOwner`, which requires
 * `manage_assignments` on both the caller's device assignment and their staff assignment. Both come
 * from `resolveOperationalScope`, whose query inner-joins `device_assignments` to
 * `operational_locations`, and `device_assignments.operational_location_id` is `NOT NULL`. No
 * counter means no assignment, no assignment means no scope, no scope means the route that creates
 * a counter refuses. Branches & Counters can manage every counter after the first and cannot create
 * it.
 *
 * `scripts/bootstrap-first-counter.mjs` creates it from the server's shell, exactly as
 * `bootstrap-first-owner.mjs` approves the first device -- moving the trust boundary onto shell
 * access, which the deployment already protects, instead of onto something listening on a port.
 *
 * ## Why this file exists
 *
 * A command that writes directly to the tables the authorization system reads is only as safe as
 * its refusals. Those refusals were proven once by hand against a throwaway PostgreSQL; that proof
 * does not survive the next edit. These tests are the part that does.
 *
 * The two that matter most are the ones a careless later change would break silently:
 *   - granting `manage_assignments` on only one side, which produces a counter that exists, an app
 *     that opens, and the deadlock still in place with nothing to show it;
 *   - leaving a counter behind when the assignments fail, which looks set up and behaves as though
 *     it is not.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SCRIPT = path.join(__dirname, "..", "scripts", "bootstrap-first-counter.mjs");
const loadScript = () => import(require("node:url").pathToFileURL(SCRIPT).href);

const BRANCH = { id: 1, branch_name: "Main Branch", company_id: 1, active: true };
const OWNER = { id: 7, username: "owner", company_id: 1, active: true, role_id: 3, role_name: "Owner" };
const DEVICE = { device_id: "FZDEV-LAPTOP", device_name: "Counter laptop", status: "APPROVED" };

const VALID = Object.freeze({
  branchId: 1,
  name: "Main Branch Counter",
  code: "mb-counter",
  deviceId: "FZDEV-LAPTOP",
  username: "owner",
});

/**
 * A client that answers only the five reads this command makes, and records every write.
 *
 * `failOn` makes one statement throw, which is how the rollback behaviour is proven -- a partial
 * write is the failure this command's transaction exists to prevent, and nothing else in the suite
 * would notice it.
 */
const scriptedClient = ({
  branch = BRANCH,
  existingCounter = null,
  user = OWNER,
  device = DEVICE,
  posting = { generation: 0, active_count: "0" },
  failOn = null,
} = {}) => {
  const statements = [];
  return {
    statements,
    sql: () => statements.map((entry) => entry.sql),
    find: (needle) => statements.find((entry) => entry.sql.includes(needle)),
    query: async (text, values) => {
      const sql = String(text).replace(/\s+/g, " ").trim();
      statements.push({ sql, values: values || [] });

      if (failOn && sql.includes(failOn)) throw new Error(`database said no to ${failOn}`);

      if (sql.startsWith("SELECT id, branch_name")) return { rows: branch ? [branch] : [] };
      if (sql.includes("FROM operational_locations")) return { rows: existingCounter ? [existingCounter] : [] };
      if (sql.includes("FROM users u JOIN roles r")) return { rows: user ? [user] : [] };
      if (sql.includes("FROM authorized_devices")) return { rows: device ? [device] : [] };
      if (sql.includes("FROM device_assignments WHERE device_id")) return { rows: [posting] };
      if (sql.startsWith("INSERT INTO operational_locations")) return { rows: [{ id: 42 }] };
      return { rows: [] };
    },
  };
};

const run = async (options = {}, clientOptions = {}) => {
  const { bootstrapFirstCounter } = await loadScript();
  const client = scriptedClient(clientOptions);
  const result = await bootstrapFirstCounter(client, { ...VALID, ...options });
  return { result, client };
};

test("importing the command neither connects to a database nor exits", async () => {
  // The suite would not survive this being false, but it would fail with a connection error that
  // says nothing about the cause. Stated once, by name.
  const module = await loadScript();
  assert.equal(typeof module.bootstrapFirstCounter, "function");
  assert.ok(module.REFUSALS.COUNTER_EXISTS, "the refusal codes must be exported for callers to test against");
});

test("the happy path creates a counter and both assignments in one transaction", async () => {
  const { result, client } = await run();

  assert.equal(result.ok, true);
  assert.equal(result.locationId, 42);

  const order = client.sql();
  assert.equal(order.filter((sql) => sql === "BEGIN").length, 1, "exactly one transaction");
  assert.equal(order.filter((sql) => sql === "COMMIT").length, 1, "which must commit");
  assert.equal(order.filter((sql) => sql === "ROLLBACK").length, 0);

  const begin = order.indexOf("BEGIN");
  const commit = order.indexOf("COMMIT");
  for (const table of ["operational_locations", "device_assignments", "staff_location_assignments"]) {
    const index = order.findIndex((sql) => sql.startsWith(`INSERT INTO ${table}`));
    assert.ok(index > begin && index < commit, `the ${table} insert must be inside the transaction`);
  }
});

test("both assignments carry manage_assignments, because the route requires both", async () => {
  // The silent half-fix. `requireAssignmentOwner` reads the permission from the device assignment
  // AND from the staff assignment. Granting one leaves a counter that exists, an app that opens,
  // and Branches & Counters still refusing to create the second counter -- the deadlock intact and
  // no longer visible.
  const { client } = await run();

  const deviceRow = client.find("INSERT INTO device_assignments");
  const staffRow = client.find("INSERT INTO staff_location_assignments");
  const permissionsOf = (entry) => JSON.parse(entry.values.find((value) => typeof value === "string" && value.startsWith("{")));

  assert.equal(permissionsOf(deviceRow).manage_assignments, true, "the device must be allowed to manage assignments");
  assert.equal(permissionsOf(staffRow).manage_assignments, true, "and so must the person");
  assert.equal(permissionsOf(staffRow).operational_access, true, "the person must also be able to work the counter");
});

test("everything written is bound to the branch's own company and the new counter", async () => {
  // The whole point of the scoping work is that a counter belongs to exactly one company, one
  // branch and one location. A bootstrap that writes a mismatched tuple would hand a device a scope
  // no screen can reach and no test would otherwise notice.
  const { client } = await run();

  const location = client.find("INSERT INTO operational_locations");
  assert.deepEqual(location.values.slice(0, 5), [1, 1, "MB-COUNTER", "Main Branch Counter", "STORE"]);

  const deviceRow = client.find("INSERT INTO device_assignments");
  assert.deepEqual(deviceRow.values.slice(0, 4), ["FZDEV-LAPTOP", 1, 1, 42]);
  assert.equal(deviceRow.values[5], 1, "a machine that has never been posted starts at generation 1");
  assert.equal(deviceRow.values[6], OWNER.id, "the approval must be attributed to the Owner running this");

  const staffRow = client.find("INSERT INTO staff_location_assignments");
  assert.deepEqual(staffRow.values.slice(0, 5), [OWNER.id, 1, 1, 42, OWNER.role_id]);
});

test("a write that fails rolls back, and reports that nothing was written", async () => {
  // A counter with no assignments looks set up and behaves as though it is not, which is a worse
  // place to be than the deadlock this command exists to break.
  const { result, client } = await run({}, { failOn: "INSERT INTO staff_location_assignments" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "WRITE_FAILED");
  assert.match(result.message, /Nothing was written/);
  assert.ok(client.sql().includes("ROLLBACK"), "the transaction must be rolled back");
  assert.ok(!client.sql().includes("COMMIT"), "and must never commit");
});

test("--dry-run reads everything and writes nothing", async () => {
  const { result, client } = await run({ dryRun: true });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.locationId, null);
  assert.equal(result.plan.branchName, "Main Branch", "it must still report what it would have done");

  const wrote = client.sql().filter((sql) => sql.startsWith("INSERT") || sql === "BEGIN");
  assert.deepEqual(wrote, [], `a dry run must write nothing, wrote: ${wrote.join(", ")}`);
});

test("a company that already has a counter is refused -- even for a branch that has none", async () => {
  // Deliberately company-wide rather than branch-wide. Once one counter exists with assignments on
  // it, somebody can sign in with a working scope, so the deadlock is gone for every branch and the
  // app can do the rest with an audit trail. A branch-wide rule would leave this command alive
  // forever as a second, unrecorded way in.
  //
  // It would also be *wrong*: creating a second counter here walks into two unique indexes --
  // `device_assignments_one_active_idx` (one active posting per machine) and
  // `staff_location_one_default_idx` (one default posting per person). Found by running this
  // against a real PostgreSQL on a second branch; the stubbed client had no opinion about either.
  const { result, client } = await run(
    { branchId: 2 },
    {
      branch: { id: 2, branch_name: "Ratanada", company_id: 1, active: true },
      existingCounter: { id: 5, location_name: "Main Branch Counter", branch_id: 1 },
    },
  );

  assert.equal(result.code, "COUNTER_EXISTS");
  assert.match(result.message, /Branches & Counters/, "a refusal must name what to use instead");
  assert.deepEqual(client.sql().filter((sql) => sql.startsWith("INSERT")), []);

  const lookup = client.find("FROM operational_locations");
  assert.deepEqual(lookup.values, [1], "the check must be by company alone, not company and branch");
});

test("a machine already posted to a counter is refused rather than silently moved", async () => {
  // `device_assignments_one_active_idx` is a unique index on `device_id WHERE active`. Writing a
  // second row is not a merge, it is an error -- and if it were allowed it would be an unrecorded
  // relocation of somebody's till.
  const { result, client } = await run({}, { posting: { generation: 1, active_count: "1" } });

  assert.equal(result.code, "DEVICE_ALREADY_ASSIGNED");
  assert.match(result.message, /one counter at a time/);
  assert.deepEqual(client.sql().filter((sql) => sql.startsWith("INSERT")), []);
});

test("a machine whose earlier posting was ended continues the generation count", async () => {
  // `(device_id, assignment_generation)` is unique and the old rows are kept, so a hardcoded 1
  // collides. The app's own approval path takes MAX + 1; this has to agree with it.
  const { client } = await run({}, { posting: { generation: 3, active_count: "0" } });

  const deviceRow = client.find("INSERT INTO device_assignments");
  assert.equal(deviceRow.values[5], 4, "the new posting must be generation 4, not 1");
});

test("only the Owner can hold the first counter", async () => {
  const { result } = await run({}, { user: { ...OWNER, role_name: "Cashier" } });
  assert.equal(result.code, "NOT_OWNER");
  assert.match(result.message, /Cashier/, "the refusal must say what the account actually is");
});

test("an Owner from another company cannot be attached to this branch", async () => {
  // Without this, one tenant's Owner would end up holding a counter inside another tenant's branch
  // -- with `manage_assignments` on it.
  const { result } = await run({}, { user: { ...OWNER, company_id: 99 } });
  assert.equal(result.code, "WRONG_COMPANY");
});

test("a branch with no company is refused rather than given an unsyncable counter", async () => {
  const { result } = await run({}, { branch: { ...BRANCH, company_id: null } });
  assert.equal(result.code, "BRANCH_HAS_NO_COMPANY");
});

test("a device that has never registered, or is not approved, is refused with instructions", async () => {
  const missing = await run({}, { device: null });
  assert.equal(missing.result.code, "NO_DEVICE");
  assert.match(missing.result.message, /sign in once/, "somebody stuck here needs the next step, not a code");

  const pending = await run({}, { device: { ...DEVICE, status: "PENDING" } });
  assert.equal(pending.result.code, "DEVICE_NOT_APPROVED");
});

test("a missing, closed or unknown branch, a missing user and a missing flag are each refused by name", async () => {
  const cases = [
    [{}, { branch: null }, "NO_BRANCH"],
    [{}, { branch: { ...BRANCH, active: false } }, "BRANCH_CLOSED"],
    [{}, { user: null }, "NO_USER"],
    [{}, { user: { ...OWNER, active: false } }, "USER_INACTIVE"],
    [{ branchId: 0 }, {}, "USAGE"],
    [{ name: "   " }, {}, "USAGE"],
    [{ code: "" }, {}, "USAGE"],
    [{ deviceId: "" }, {}, "USAGE"],
    [{ username: "" }, {}, "USAGE"],
    [{ type: "SHOP" }, {}, "BAD_TYPE"],
  ];
  for (const [options, clientOptions, code] of cases) {
    const { result, client } = await run(options, clientOptions);
    assert.equal(result.code, code, `${JSON.stringify(options)} ${JSON.stringify(Object.keys(clientOptions))}`);
    assert.deepEqual(
      client.sql().filter((sql) => sql.startsWith("INSERT")),
      [],
      "a refusal must never have written anything",
    );
  }
});

test("a warehouse is accepted as a counter type, because one place can be both", async () => {
  // The maintainer's ruling: a main branch and a warehouse can be the same physical place.
  const { result, client } = await run({ type: "warehouse" });
  assert.equal(result.ok, true);
  assert.equal(client.find("INSERT INTO operational_locations").values[4], "WAREHOUSE");
});

test("the command is documented where somebody stuck would look for it", async () => {
  const source = fs.readFileSync(SCRIPT, "utf8");
  assert.match(source, /requireAssignmentOwner/, "the header must explain the deadlock it breaks");
  assert.match(source, /bootstrap-first-owner\.mjs/, "and point at the command it is modelled on");

  // The maintainer runs this, not a developer. A refusal that only makes sense next to the source
  // is not documentation, so the plain-language page has to exist and has to list every refusal --
  // being stuck at setup with an unexplained message is the exact failure this guards against.
  const guide = fs.readFileSync(path.join(__dirname, "..", "docs", "first-counter-setup.md"), "utf8");
  const { REFUSALS } = await loadScript();
  const undocumented = Object.keys(REFUSALS)
    // USAGE prints the usage text itself, and WRITE_FAILED carries the database's own words.
    .filter((code) => !["USAGE", "BAD_TYPE"].includes(code))
    .filter((code) => {
      const phrases = {
        COUNTER_EXISTS: "already has a counter",
        NO_BRANCH: "no company",
        BRANCH_CLOSED: "no company",
        BRANCH_HAS_NO_COMPANY: "has no company",
        NO_USER: "not the Owner",
        USER_INACTIVE: "not the Owner",
        NOT_OWNER: "not the Owner",
        WRONG_COMPANY: "not the Owner",
        NO_DEVICE: "has no device",
        DEVICE_NOT_APPROVED: "not APPROVED",
        DEVICE_ALREADY_ASSIGNED: "already posted to a counter",
        WRITE_FAILED: "Nothing was written",
      };
      return !guide.includes(phrases[code] || code);
    });
  assert.deepEqual(undocumented, [], `docs/first-counter-setup.md explains no way out of: ${undocumented.join(", ")}`);
});
