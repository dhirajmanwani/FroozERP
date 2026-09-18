"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  hasBlockers,
  registerScopeManagementRoutes,
  requireAssignmentOwner,
} = require("./scopeManagement");

const ownerContext = {
  role: "Owner",
  device_permissions: { manage_assignments: true },
  staff_permissions: { manage_assignments: true },
};

test("scope management requires the owner/device/staff permission intersection", () => {
  assert.doesNotThrow(() => requireAssignmentOwner(ownerContext));
  assert.throws(
    () => requireAssignmentOwner({ ...ownerContext, role: "Admin" }),
    (error) => error.code === "ASSIGNMENT_ADMIN_REQUIRED"
  );
  assert.throws(
    () => requireAssignmentOwner({ ...ownerContext, device_permissions: {} }),
    (error) => error.code === "ASSIGNMENT_ADMIN_REQUIRED"
  );
  assert.throws(
    () => requireAssignmentOwner({ ...ownerContext, staff_permissions: {} }),
    (error) => error.code === "ASSIGNMENT_ADMIN_REQUIRED"
  );
});

test("location deactivation detects every protected operational dependency", () => {
  assert.equal(hasBlockers({ active_devices: 0, active_staff: 0, stocked_lots: 0, open_transfers: 0, pending_sync: 0 }), false);
  for (const field of ["active_devices", "active_staff", "stocked_lots", "open_transfers", "pending_sync"]) {
    assert.equal(hasBlockers({ [field]: 1 }), true, `${field} must block deactivation`);
  }
});

test("management routes cover hierarchy, staff scope, and explicit device approval", () => {
  const routes = [];
  registerScopeManagementRoutes({
    use(method, route) { routes.push(`${method.toUpperCase()} ${route}`); },
    database: {},
  });
  assert.deepEqual(routes, [
    "GET /api/v3/admin/scope-management",
    "POST /api/v3/admin/branches",
    "PUT /api/v3/admin/branches/:branchId",
    "POST /api/v3/admin/operational-locations",
    "PUT /api/v3/admin/operational-locations/:locationId",
    "PUT /api/v3/admin/staff-assignments/:userId",
    "POST /api/v3/admin/devices/:deviceId/approve",
  ]);
});

test("device approval has no branch-one fallback and requires staff/location validation", () => {
  const source = fs.readFileSync(path.join(__dirname, "scopeManagement.js"), "utf8");
  const serverSource = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  assert.match(source, /DEVICE_ASSIGNMENT_REQUIRED/);
  assert.match(source, /STAFF_ASSIGNMENT_REQUIRED/);
  assert.match(source, /ROLE_MISMATCH/);
  assert.match(source, /status = 'APPROVED'/);
  assert.match(source, /INSERT INTO device_assignments/);
  assert.match(source, /INSERT INTO device_assignment_history/);
  assert.doesNotMatch(source, /branchId[^\n]*\|\|\s*1/);
  assert.match(serverSource, /PROTOCOL_V3_DEVICE_APPROVAL_REQUIRED/);
  assert.match(serverSource, /return res\.status\(426\)/);
});

test("scope-management migration is additive and creates no assignment rows", () => {
  const migration = fs.readFileSync(path.join(__dirname, "migrations/cloud/012_scope_management.sql"), "utf8");
  assert.match(migration, /ALTER TABLE authorized_devices ADD COLUMN IF NOT EXISTS/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS operational_scope_audit/);
  assert.doesNotMatch(migration, /INSERT\s+INTO\s+(?:branches|operational_locations|staff_location_assignments|device_assignments)/i);
  assert.doesNotMatch(migration, /DELETE\s+FROM|TRUNCATE|DROP\s+TABLE/i);
});

/**
 * A-7 — the assignment screen reads one company's staff and one company's pending devices.
 *
 * Two of the seven reads behind `GET /api/v3/admin/scope-management` had no tenancy predicate at
 * all: `FROM users u ... WHERE u.active = TRUE`, and `FROM authorized_devices WHERE status =
 * 'PENDING'`. The other five were already scoped by `company_id`, so the screen was mostly right
 * and wrong in exactly the two places that name people and their machines.
 *
 * The handler is registered and then called with a database that really executes its SQL, so these
 * assert on the rows the route hands back rather than on the text of the query. `company_id` is
 * NULL on both tables in production — nothing has ever written it — which is the whole reason the
 * predicate has to reach the company through the row's branch as well, and why a test that only
 * looked for `company_id` in the SQL would have passed on a version that returned nobody.
 */

const { DatabaseSync } = require("node:sqlite");

const scopeFixture = () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE branches (id, branch_name, company_id, active)");
  db.exec("CREATE TABLE roles (id, role_name)");
  db.exec("CREATE TABLE users (id, full_name, username, active, role_id, branch_id, company_id)");
  db.exec(`CREATE TABLE authorized_devices (
    device_id, device_name, device_type, platform, status, request_time,
    requested_physical_location, requested_intended_usage, requested_user_id, requested_role_id,
    assigned_branch_id, company_id, id
  )`);
  const rows = [
    ["INSERT INTO branches VALUES (?, ?, ?, ?)", [1, "Main Shop", 1, 1]],
    ["INSERT INTO branches VALUES (?, ?, ?, ?)", [2, "Market Yard", 1, 1]],
    ["INSERT INTO branches VALUES (?, ?, ?, ?)", [3, "Other Company", 2, 1]],
    ["INSERT INTO roles VALUES (?, ?)", [1, "Owner"]],
    ["INSERT INTO roles VALUES (?, ?)", [2, "Admin"]],
    // company_id NULL on every user, as in production: the company is reachable only via branch.
    ["INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)", [1, "Dhiraj", "dhiraj", 1, 1, 1, null]],
    ["INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)", [2, "Rahul", "rahul", 1, 2, 2, null]],
    ["INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)", [3, "Stranger", "stranger", 1, 2, 3, null]],
    ["INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)", [4, "Unplaced", "unplaced", 1, 2, null, null]],
    ["INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)", [5, "Retired", "retired", 0, 2, 1, null]],
    ["INSERT INTO authorized_devices VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ["FZ-OURS", "Counter 1", "Browser", "Windows", "PENDING", "2026-09-01", null, null, null, null, 1, null, 1]],
    ["INSERT INTO authorized_devices VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ["FZ-THEIRS", "Their counter", "Browser", "Windows", "PENDING", "2026-09-02", null, null, null, null, 3, null, 2]],
    ["INSERT INTO authorized_devices VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ["FZ-UNPLACED", "Unplaced counter", "Browser", "Windows", "PENDING", "2026-09-03", null, null, null, null, null, null, 3]],
    ["INSERT INTO authorized_devices VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ["FZ-APPROVED", "Already approved", "Browser", "Windows", "APPROVED", "2026-09-04", null, null, null, null, 1, null, 4]],
  ];
  for (const [sql, values] of rows) db.prepare(sql).run(...values);
  return db;
};

/** `$1` becomes `?` in order of appearance, so a mis-bound statement fails here as it would live. */
const executeAgainst = (db, sql, values = []) => {
  const order = [];
  const translated = sql.replace(/\$(\d+)/g, (_match, position) => {
    order.push(Number(position));
    return "?";
  });
  return { rows: db.prepare(translated).all(...order.map((position) => values[position - 1])) };
};

const readScopeManagement = async (companyId) => {
  const db = scopeFixture();
  let handler = null;
  registerScopeManagementRoutes({
    use(method, route, fn) {
      if (`${method} ${route}` === "get /api/v3/admin/scope-management") handler = fn;
    },
    database: {
      query: async (sql, values = []) => {
        // Only the two reads under test are executed; the other five already carry `company_id = $1`
        // and answering them emptily keeps this about the pair that did not.
        if (/FROM users u/.test(sql) || /FROM authorized_devices d/.test(sql)) {
          return executeAgainst(db, sql, values);
        }
        return { rows: [] };
      },
    },
  });
  let payload = null;
  await handler({ body: {}, params: {}, query: {} }, { json: (body) => { payload = body; return body; } }, {
    ...ownerContext,
    company_id: companyId,
    user_id: 1,
    device_id: "FZ-OURS",
  });
  db.close();
  return payload;
};

test("the assignment screen lists this company's staff and not another's", async () => {
  const payload = await readScopeManagement(1);
  assert.deepEqual(payload.users.map((row) => row.full_name).sort(), ["Dhiraj", "Rahul", "Unplaced"]);
});

test("a second company's owner sees their own people instead", async () => {
  const payload = await readScopeManagement(2);
  assert.deepEqual(payload.users.map((row) => row.full_name).sort(), ["Stranger", "Unplaced"]);
});

test("pending device requests are scoped the same way", async () => {
  const payload = await readScopeManagement(1);
  assert.deepEqual(payload.pending_devices.map((row) => row.device_id), ["FZ-OURS", "FZ-UNPLACED"]);
});

test("a row nobody can place stays visible rather than vanishing", async () => {
  // The deliberate looseness, asserted so it is a decision rather than an accident. A device or a
  // staff member with no company and no resolvable branch would otherwise be invisible on the only
  // screen that can assign them, with nothing on screen to say why. This route is Owner-only.
  const payload = await readScopeManagement(1);
  assert.ok(payload.users.some((row) => row.full_name === "Unplaced"));
  assert.ok(payload.pending_devices.some((row) => row.device_id === "FZ-UNPLACED"));
});

test("neither read forgets its existing filters", async () => {
  // Adding a tenancy predicate to a `WHERE` that already had one is where an `AND` gets lost.
  const payload = await readScopeManagement(1);
  assert.ok(!payload.users.some((row) => row.full_name === "Retired"), "inactive users stay out");
  assert.ok(!payload.pending_devices.some((row) => row.device_id === "FZ-APPROVED"), "approved devices stay out");
});
