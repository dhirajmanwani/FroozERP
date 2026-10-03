"use strict";

/**
 * One computer, one ID, one name.
 *
 * A device id is minted per installation, so a reinstalled counter registered under a new id and
 * "Computers & phones" showed the one machine as several boxes: every PENDING row forever, every
 * assignment generation ever made, and devices that can no longer sign in. The Windows app now
 * sends `machine_fp` (sha256 hex of the machine identity) and the backend:
 *
 *   - stores it only when it is exactly 64 lowercase hex, and never lets an absent one erase it;
 *   - folds one machine's pending requests into one, and drops them when that machine is approved;
 *   - lists one assignment per device (its latest generation), and none for a retired device;
 *   - lets the Owner retire an old box, without deleting anything and never their own device.
 *
 * The SQL runs in PGlite, a real Postgres, so `COALESCE`, `EXISTS`, `FOR UPDATE` and the status
 * filters are judged by a database rather than by a regex over the query text.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  foldPendingDevices,
  latestAssignmentPerDevice,
  normalizeMachineFingerprint,
  registerScopeManagementRoutes,
} = require("./scopeManagement");
const { loadServerApp } = require("./routeAuthCoverage");

const FP_A = "a".repeat(64);
const FP_B = "0123456789abcdef".repeat(4);

const OWNER = {
  role: "Owner",
  device_permissions: { manage_assignments: true },
  staff_permissions: { manage_assignments: true },
  company_id: 1,
  branch_id: 1,
  user_id: 7,
  device_id: "FZDEV-OWNER-LAPTOP",
};

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

test("only a 64-character lowercase hex fingerprint is accepted; anything else is absent", () => {
  assert.equal(normalizeMachineFingerprint(FP_A), FP_A);
  assert.equal(normalizeMachineFingerprint(FP_B), FP_B);
  for (const bad of [
    "", " ", null, undefined, 42, {}, [],
    "A".repeat(64), // uppercase
    "a".repeat(63), "a".repeat(65),
    ` ${FP_A}`, `${FP_A}\n`,
    "g".repeat(64),
    "4C4C4544-0035-3010-8052-B4C04F4B4E32", // a raw machine GUID must never be stored as one
  ]) {
    assert.equal(normalizeMachineFingerprint(bad), null, `${JSON.stringify(bad)} must be treated as absent`);
  }
});

// ---------------------------------------------------------------------------------------------
// The device upsert every registering route goes through, against PGlite
// ---------------------------------------------------------------------------------------------

loadServerApp();
const { readDevicePayload, upsertDeviceRequest } = require("./server");

const freshDeviceTable = async () => {
  const { PGlite } = require("@electric-sql/pglite");
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE authorized_devices (
      id SERIAL PRIMARY KEY,
      device_id VARCHAR(160) UNIQUE NOT NULL,
      device_name VARCHAR(160) NOT NULL,
      device_type VARCHAR(60) DEFAULT 'Browser',
      user_agent TEXT,
      local_ip VARCHAR(80),
      assigned_branch_id INTEGER DEFAULT 1,
      assigned_counter_id INTEGER,
      status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
      request_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      machine_fp VARCHAR(80)
    );
  `);
  return db;
};

const register = (db, body) => upsertDeviceRequest(readDevicePayload(body, {}), db);

test("every registering route reads machine_fp from the body, and only a valid one", () => {
  // /login, /devices/activate, /bootstrap/first-owner-device, /api/sync/register-device,
  // /api/device/register and /api/cloud/device/register all build their device from readDevicePayload.
  assert.equal(readDevicePayload({ device_id: "FZDEV-1", machine_fp: FP_A }).machine_fp, FP_A);
  assert.equal(readDevicePayload({ device_id: "FZDEV-1", machine_fp: "nope" }).machine_fp, null);
  assert.equal(readDevicePayload({ device_id: "FZDEV-1" }).machine_fp, null);
  const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  for (const route of ["/login", "/devices/activate", "/bootstrap/first-owner-device", "/api/cloud/device/register"]) {
    const start = source.indexOf(`app.post("${route}"`);
    assert.ok(start > 0, `${route} moved; this assertion is stale`);
    assert.match(source.slice(start, start + 4000), /readDevicePayload\(/, `${route} must read the device through readDevicePayload`);
  }
  // The local backend's hop to the cloud builds its own body; the fingerprint has to be on it.
  const cloudHop = source.slice(source.indexOf('app.post("/api/cloud/device/register"'));
  assert.match(cloudHop.slice(0, 1500), /machine_fp: device\.machine_fp \|\| undefined/);
});

test("a valid fingerprint is stored on insert and on a later upsert", async () => {
  const db = await freshDeviceTable();
  const first = await register(db, { device_id: "FZDEV-1", device_name: "Counter 1" });
  assert.equal(first.machine_fp, null, "absent stays NULL");
  const second = await register(db, { device_id: "FZDEV-1", device_name: "Counter 1", machine_fp: FP_A });
  assert.equal(second.machine_fp, FP_A);
  const third = await register(db, { device_id: "FZDEV-2", device_name: "Counter 2", machine_fp: FP_B });
  assert.equal(third.machine_fp, FP_B);
  await db.close();
});

test("an absent or malformed fingerprint never erases a stored one", async () => {
  const db = await freshDeviceTable();
  await register(db, { device_id: "FZDEV-1", device_name: "Counter 1", machine_fp: FP_A });
  for (const body of [{}, { machine_fp: "" }, { machine_fp: "UPPER".repeat(13) }, { machine_fp: null }]) {
    const row = await register(db, { device_id: "FZDEV-1", device_name: "Counter 1", ...body });
    assert.equal(row.machine_fp, FP_A, `${JSON.stringify(body)} must keep the stored fingerprint`);
  }
  const replaced = await register(db, { device_id: "FZDEV-1", device_name: "Counter 1", machine_fp: FP_B });
  assert.equal(replaced.machine_fp, FP_B, "a new valid value does replace it");
  await db.close();
});

test("an upsert never changes a device's status", async () => {
  // A retired or disabled id that registers again must not come back as PENDING on its own.
  const db = await freshDeviceTable();
  await register(db, { device_id: "FZDEV-1", device_name: "Counter 1" });
  await db.query("UPDATE authorized_devices SET status = 'RETIRED' WHERE device_id = 'FZDEV-1'");
  const row = await register(db, { device_id: "FZDEV-1", device_name: "Counter 1", machine_fp: FP_A });
  assert.equal(row.status, "RETIRED");
  await db.close();
});

// ---------------------------------------------------------------------------------------------
// The scope-management read and the retire route, against PGlite
// ---------------------------------------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE companies (id INTEGER PRIMARY KEY);
  CREATE TABLE branches (id INTEGER PRIMARY KEY, company_id INTEGER, branch_name TEXT, active BOOLEAN DEFAULT TRUE);
  CREATE TABLE roles (id INTEGER PRIMARY KEY, role_name TEXT);
  CREATE TABLE users (id INTEGER PRIMARY KEY, full_name TEXT, username TEXT, active BOOLEAN DEFAULT TRUE,
    role_id INTEGER, branch_id INTEGER, company_id INTEGER);
  CREATE TABLE operational_locations (id INTEGER PRIMARY KEY, company_id INTEGER, branch_id INTEGER,
    location_name TEXT, active BOOLEAN DEFAULT TRUE);
  CREATE TABLE staff_location_assignments (id SERIAL PRIMARY KEY, user_id INTEGER, company_id INTEGER, branch_id INTEGER,
    operational_location_id INTEGER, role_id INTEGER, is_default BOOLEAN, active BOOLEAN);
  CREATE TABLE authorized_devices (
    id SERIAL PRIMARY KEY, device_id VARCHAR(160) UNIQUE NOT NULL, device_name VARCHAR(160) NOT NULL,
    device_type VARCHAR(60), platform VARCHAR(80), status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    request_time TIMESTAMP, last_active_at TIMESTAMP, updated_at TIMESTAMP,
    requested_physical_location TEXT, requested_intended_usage TEXT, requested_user_id INTEGER, requested_role_id INTEGER,
    assigned_branch_id INTEGER, company_id INTEGER, machine_fp VARCHAR(80)
  );
  CREATE TABLE device_assignments (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    device_id VARCHAR(160) NOT NULL REFERENCES authorized_devices(device_id),
    company_id INTEGER NOT NULL, branch_id INTEGER NOT NULL, operational_location_id INTEGER NOT NULL,
    intended_usage VARCHAR(80), assignment_generation INTEGER NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE,
    deactivated_at TIMESTAMP, deactivated_by INTEGER, deactivation_reason TEXT, updated_at TIMESTAMP,
    UNIQUE (device_id, assignment_generation)
  );
  CREATE UNIQUE INDEX device_assignments_one_active_idx ON device_assignments(device_id) WHERE active = TRUE;
  CREATE TABLE device_assignment_history (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, device_id VARCHAR(160) NOT NULL REFERENCES authorized_devices(device_id),
    assignment_id BIGINT REFERENCES device_assignments(id), action VARCHAR(40) NOT NULL, old_scope JSONB, new_scope JSONB,
    reason TEXT NOT NULL, changed_by INTEGER NOT NULL, changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE operational_scope_audit (
    id SERIAL PRIMARY KEY, company_id INTEGER, entity_type TEXT, entity_id TEXT, action VARCHAR(60) NOT NULL,
    old_value JSONB, new_value JSONB, reason TEXT, changed_by INTEGER, changed_by_device_id TEXT
  );
  -- A sale that names a device: retiring must leave both standing.
  CREATE TABLE sales (id INTEGER PRIMARY KEY, device_id VARCHAR(160));

  INSERT INTO companies VALUES (1), (2);
  INSERT INTO branches VALUES (1, 1, 'Main Shop', TRUE), (3, 2, 'Other Company', TRUE);
  INSERT INTO roles VALUES (1, 'Owner'), (3, 'Cashier');
  INSERT INTO users VALUES (7, 'Owner', 'owner', TRUE, 1, 1, NULL);
  INSERT INTO operational_locations VALUES (10, 1, 1, 'Front counter', TRUE), (11, 1, 1, 'Back counter', TRUE), (30, 2, 3, 'Theirs', TRUE);

  INSERT INTO authorized_devices (device_id, device_name, status, request_time, last_active_at, updated_at, assigned_branch_id, machine_fp) VALUES
    -- The Owner's laptop: approved, posted, fingerprinted.
    ('FZDEV-OWNER-LAPTOP', 'Owner laptop', 'APPROVED', '2026-09-01', '2026-10-02', '2026-10-02', 1, '${FP_A}'),
    -- A reinstall of the same laptop that asked again. Already approved as the id above: not listed.
    ('FZDEV-OWNER-REINSTALL', 'Owner laptop', 'PENDING', '2026-09-20', NULL, '2026-09-20', 1, '${FP_A}'),
    -- The counter PC asked three times, never approved: one entry, the most recently seen.
    ('FZDEV-COUNTER-1', 'Counter PC', 'PENDING', '2026-09-10', NULL, '2026-09-10', 1, '${FP_B}'),
    ('FZDEV-COUNTER-2', 'Counter PC', 'PENDING', '2026-09-11', '2026-09-30', '2026-09-30', 1, '${FP_B}'),
    ('FZDEV-COUNTER-3', 'Counter PC', 'PENDING', '2026-09-12', NULL, '2026-09-12', 1, '${FP_B}'),
    -- Old clients send no fingerprint: listed exactly as before, however many there are.
    ('FZDEV-PHONE-1', 'Phone', 'PENDING', '2026-09-05', NULL, '2026-09-05', 1, NULL),
    ('FZDEV-PHONE-2', 'Phone', 'PENDING', '2026-09-06', NULL, '2026-09-06', 1, NULL),
    -- Retired and disabled devices are not boxes.
    ('FZDEV-OLD-TILL', 'Old till', 'RETIRED', '2026-08-01', NULL, '2026-08-01', 1, NULL),
    ('FZDEV-DISABLED', 'Disabled till', 'DISABLED', '2026-08-02', NULL, '2026-08-02', 1, NULL),
    -- A till moved between counters three times: one box, its latest generation.
    ('FZDEV-MOVED', 'Moving till', 'APPROVED', '2026-08-03', '2026-10-01', '2026-10-01', 1, NULL),
    -- Another company's device.
    ('FZDEV-THEIRS', 'Their till', 'APPROVED', '2026-08-04', NULL, '2026-08-04', 3, NULL);

  INSERT INTO device_assignments (device_id, company_id, branch_id, operational_location_id, intended_usage, assignment_generation, active) VALUES
    ('FZDEV-OWNER-LAPTOP', 1, 1, 10, 'POS', 1, TRUE),
    ('FZDEV-MOVED', 1, 1, 10, 'POS', 1, FALSE),
    ('FZDEV-MOVED', 1, 1, 11, 'POS', 2, FALSE),
    ('FZDEV-MOVED', 1, 1, 10, 'POS', 3, TRUE),
    ('FZDEV-OLD-TILL', 1, 1, 11, 'POS', 1, TRUE),
    ('FZDEV-DISABLED', 1, 1, 11, 'POS', 1, FALSE),
    ('FZDEV-THEIRS', 2, 3, 30, 'POS', 1, TRUE);

  INSERT INTO sales VALUES (1, 'FZDEV-MOVED');
`;

const scopeDatabase = async () => {
  const { PGlite } = require("@electric-sql/pglite");
  const db = new PGlite();
  await db.exec(SCHEMA);
  const statements = [];
  return {
    db,
    statements,
    // No `connect`, so withTransaction runs BEGIN/COMMIT on this object itself, as on a single client.
    database: { query: (sql, values = []) => { statements.push(sql); return db.query(sql, values); } },
  };
};

const routes = (database) => {
  const handlers = {};
  registerScopeManagementRoutes({
    use(method, route, handler) { handlers[`${method.toUpperCase()} ${route}`] = handler; },
    database,
  });
  return handlers;
};

const call = async (handler, { params = {}, body = {} } = {}, context = OWNER) => {
  let payload = null;
  await handler({ params, body, query: {} }, { json: (value) => { payload = value; return value; }, status() { return this; } }, context);
  return payload;
};

const readScreen = async (env) => call(routes(env.database)["GET /api/v3/admin/scope-management"]);

test("waiting for approval shows one box per machine and none for an approved machine", async () => {
  const env = await scopeDatabase();
  const payload = await readScreen(env);
  assert.deepEqual(
    payload.pending_devices.map((row) => row.device_id),
    ["FZDEV-PHONE-1", "FZDEV-PHONE-2", "FZDEV-COUNTER-2"],
    "the reinstall of an approved laptop is gone, the counter's three requests are one, phones untouched",
  );
  const counter = payload.pending_devices.find((row) => row.device_id === "FZDEV-COUNTER-2");
  assert.deepEqual(counter.previous_device_ids, ["FZDEV-COUNTER-3", "FZDEV-COUNTER-1"]);
  assert.equal(counter.machine_fp, FP_B);
  assert.deepEqual(payload.pending_devices.find((row) => row.device_id === "FZDEV-PHONE-1").previous_device_ids, []);
  await env.db.close();
});

test("approved devices show their latest assignment generation only, and no retired or disabled device", async () => {
  const env = await scopeDatabase();
  const payload = await readScreen(env);
  const boxes = payload.device_assignments.map((row) => `${row.device_id}#${row.assignment_generation}`);
  assert.deepEqual(boxes.sort(), ["FZDEV-MOVED#3", "FZDEV-OWNER-LAPTOP#1"]);
  const laptop = payload.device_assignments.find((row) => row.device_id === "FZDEV-OWNER-LAPTOP");
  assert.equal(laptop.machine_fp, FP_A);
  assert.deepEqual(laptop.previous_device_ids, ["FZDEV-OWNER-REINSTALL"]);
  assert.deepEqual(laptop.waiting_device_ids, ["FZDEV-OWNER-REINSTALL"], "the folded request is named on the approved box, never silently gone");
  const moved = payload.device_assignments.find((row) => row.device_id === "FZDEV-MOVED");
  assert.equal(moved.machine_fp, null);
  assert.deepEqual(moved.previous_device_ids, []);
  assert.deepEqual(moved.waiting_device_ids, []);
  assert.equal(payload.retired_devices, 2, "the retired and the disabled till are counted, not shown");
  for (const field of ["branches", "operational_locations", "staff_assignments", "device_assignments", "users", "pending_devices", "roles"]) {
    assert.ok(Array.isArray(payload[field]), `${field} keeps its shape for old clients`);
  }
  await env.db.close();
});

test("a machine moved off every counter keeps its latest, inactive, box", () => {
  const rows = [
    { device_id: "FZDEV-X", assignment_generation: 2, active: false },
    { device_id: "FZDEV-X", assignment_generation: 1, active: false },
    { device_id: "FZDEV-Y", assignment_generation: 1, active: false },
    { device_id: "FZDEV-Y", assignment_generation: 2, active: true },
  ];
  assert.deepEqual(
    latestAssignmentPerDevice(rows).map((row) => `${row.device_id}#${row.assignment_generation}`),
    ["FZDEV-X#2", "FZDEV-Y#2"],
  );
});

test("ids are compared as strings: 004 and 4 are two devices", () => {
  const rows = [
    { device_id: "004", assignment_generation: 1, active: true },
    { device_id: "4", assignment_generation: 1, active: true },
  ];
  assert.equal(latestAssignmentPerDevice(rows).length, 2);
  const pending = foldPendingDevices(
    [{ device_id: "004", status: "PENDING", machine_fp: null }, { device_id: "4", status: "PENDING", machine_fp: null }],
    [],
  );
  assert.equal(pending.length, 2);
});

test("a pending request is not hidden behind a machine whose only approval is retired or disabled", () => {
  const pending = foldPendingDevices(
    [{ device_id: "FZDEV-NEW", status: "PENDING", machine_fp: FP_A }],
    [
      { device_id: "FZDEV-OLD", status: "RETIRED", machine_fp: FP_A, has_active_assignment: false },
      { device_id: "FZDEV-OLDER", status: "DISABLED", machine_fp: FP_A, has_active_assignment: true },
      { device_id: "FZDEV-NEW", status: "PENDING", machine_fp: FP_A, has_active_assignment: false },
    ],
  );
  assert.deepEqual(pending.map((row) => row.device_id), ["FZDEV-NEW"]);
});

const retire = (env, deviceId, context = OWNER, body = {}) =>
  call(routes(env.database)["POST /api/v3/admin/devices/:deviceId/retire"], { params: { deviceId }, body }, context);

const count = async (db, table) => Number((await db.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n);

test("the Owner retires an old box: status RETIRED, posting ended, history and audit written, nothing deleted", async () => {
  const env = await scopeDatabase();
  const before = {
    devices: await count(env.db, "authorized_devices"),
    assignments: await count(env.db, "device_assignments"),
    sales: await count(env.db, "sales"),
  };
  const result = await retire(env, "FZDEV-MOVED", OWNER, { reason: "Replaced by the new till" });
  assert.equal(result.device.status, "RETIRED");
  assert.equal(result.already_retired, false);
  assert.deepEqual(result.deactivated_assignments.map((row) => row.assignment_generation), [3]);

  const assignments = await env.db.query("SELECT active, deactivated_by, deactivation_reason FROM device_assignments WHERE device_id = 'FZDEV-MOVED'");
  assert.ok(assignments.rows.every((row) => row.active === false), "no posting left active");
  assert.ok(assignments.rows.some((row) => row.deactivated_by === 7 && row.deactivation_reason === "Replaced by the new till"));

  const history = await env.db.query("SELECT action, old_scope, new_scope, changed_by FROM device_assignment_history WHERE device_id = 'FZDEV-MOVED'");
  assert.equal(history.rows.length, 1);
  assert.equal(history.rows[0].action, "RETIRE");
  assert.equal(history.rows[0].old_scope.active, true);
  assert.equal(history.rows[0].new_scope.active, false);
  const audit = await env.db.query("SELECT entity_type, entity_id, action, changed_by, changed_by_device_id FROM operational_scope_audit");
  assert.deepEqual(audit.rows, [{
    entity_type: "device", entity_id: "FZDEV-MOVED", action: "RETIRE", changed_by: 7, changed_by_device_id: "FZDEV-OWNER-LAPTOP",
  }]);

  assert.deepEqual({
    devices: await count(env.db, "authorized_devices"),
    assignments: await count(env.db, "device_assignments"),
    sales: await count(env.db, "sales"),
  }, before, "retiring deletes nothing");
  assert.ok(!env.statements.some((sql) => /\bDELETE\b|\bTRUNCATE\b/i.test(sql)), "no DELETE is ever issued");

  const screen = await readScreen(env);
  assert.ok(!screen.device_assignments.some((row) => row.device_id === "FZDEV-MOVED"), "and the box is gone");
  assert.equal(screen.retired_devices, 3);
  await env.db.close();
});

test("retiring a pending request takes it off the waiting list", async () => {
  const env = await scopeDatabase();
  await retire(env, "FZDEV-PHONE-1");
  const screen = await readScreen(env);
  assert.ok(!screen.pending_devices.some((row) => row.device_id === "FZDEV-PHONE-1"));
  assert.ok(screen.pending_devices.some((row) => row.device_id === "FZDEV-PHONE-2"));
  await env.db.close();
});

test("the Owner cannot retire the computer they are using", async () => {
  const env = await scopeDatabase();
  await assert.rejects(
    retire(env, "FZDEV-OWNER-LAPTOP"),
    (error) => error.status === 409 && error.code === "CANNOT_RETIRE_CURRENT_DEVICE" && /using now/.test(error.message),
  );
  const row = await env.db.query("SELECT status FROM authorized_devices WHERE device_id = 'FZDEV-OWNER-LAPTOP'");
  assert.equal(row.rows[0].status, "APPROVED");
  await env.db.close();
});

test("only the Owner with assignment permission may retire", async () => {
  const env = await scopeDatabase();
  for (const context of [
    { ...OWNER, role: "Admin" },
    { ...OWNER, role: "Cashier" },
    { ...OWNER, device_permissions: {} },
    { ...OWNER, staff_permissions: {} },
  ]) {
    await assert.rejects(retire(env, "FZDEV-MOVED", context), (error) => error.status === 403 && error.code === "ASSIGNMENT_ADMIN_REQUIRED");
  }
  assert.equal(env.statements.length, 0, "refused before touching the database");
  await env.db.close();
});

test("another company's device, or an unknown one, is not found", async () => {
  const env = await scopeDatabase();
  for (const deviceId of ["FZDEV-THEIRS", "FZDEV-NOBODY"]) {
    await assert.rejects(retire(env, deviceId), (error) => error.status === 404 && error.code === "DEVICE_NOT_FOUND");
  }
  const theirs = await env.db.query("SELECT status FROM authorized_devices WHERE device_id = 'FZDEV-THEIRS'");
  assert.equal(theirs.rows[0].status, "APPROVED");
  await env.db.close();
});

test("retiring twice is harmless", async () => {
  const env = await scopeDatabase();
  const again = await retire(env, "FZDEV-OLD-TILL");
  assert.equal(again.already_retired, true);
  assert.deepEqual(again.deactivated_assignments, []);
  assert.equal(await count(env.db, "operational_scope_audit"), 0, "a no-op writes no audit row");
  await env.db.close();
});

test("a retired device signing in is told it is disabled, not that it is pending approval", () => {
  // A retired id is never listed for approval again, so "pending approval" would be a wait with no
  // end. DEVICE_DISABLED is a code every shipped client already handles.
  const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  assert.match(source, /deviceStatus === "DISABLED" \|\| deviceStatus === "RETIRED"\s*\n\s*\? "DEVICE_DISABLED"/);
});
