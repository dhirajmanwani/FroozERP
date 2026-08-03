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
