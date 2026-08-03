import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appSource = fs.readFileSync(path.join(here, "../App.jsx"), "utf8");
const backendSource = fs.readFileSync(path.join(here, "../../../backend/scopeManagement.js"), "utf8");

test("Settings renders canonical branch and operational-location management", () => {
  assert.match(appSource, /<OperationalScopeManagement canManage=\{canManage\} user=\{user\} \/>/);
  assert.match(appSource, /Branch, Location, Staff and Device Control/);
  assert.match(appSource, /\/api\/v3\/admin\/operational-locations/);
  assert.match(appSource, /Operational Location/);
  assert.match(appSource, /updateBranch\(branch, false\)/);
  assert.match(appSource, /updateLocation\(location, false\)/);
  assert.doesNotMatch(appSource, /<BranchCounterSettings /);
  assert.doesNotMatch(appSource, /<SecurityDevicesSection /);
});

test("staff assignment binds a user role to one explicit default location", () => {
  assert.match(appSource, /\/api\/v3\/admin\/staff-assignments\/\$\{staffDraft\.user_id\}/);
  assert.match(appSource, /Default Operational Location/);
  assert.match(appSource, /permission_set: \{ operational_access: true \}/);
  assert.match(appSource, /target_operational_location_id: staffDraft\.operational_location_id/);
  assert.match(appSource, /deactivateStaffAssignment/);
  assert.match(backendSource, /STAFF_ASSIGNMENT_REQUIRED/);
  assert.match(backendSource, /UPDATE staff_location_assignments SET is_default = FALSE/);
});

test("pending device approval requires branch, location, usage, user, and role", () => {
  for (const field of [
    "branch_id",
    "operational_location_id",
    "physical_label",
    "intended_usage",
    "permitted_user_id",
    "role_id",
  ]) {
    assert.match(appSource, new RegExp(`draft\\.${field}`));
  }
  assert.match(appSource, /Approve Assigned Device/);
  assert.match(appSource, /target_operational_location_id: draft\.operational_location_id/);
  assert.match(appSource, /\/api\/v3\/admin\/devices\/\$\{encodeURIComponent\(device\.device_id\)\}\/approve/);
  assert.match(backendSource, /Only a pending device can be approved/);
  assert.match(backendSource, /Select an active operational location in the selected branch/);
  assert.doesNotMatch(backendSource, /branchId[^\n]*\|\|\s*1/);
});

test("all management requests use signed protocol-v3 helpers", () => {
  assert.match(appSource, /createOperationalReadConfig\(user\)/);
  assert.match(appSource, /const write = createOperationalWrite\(user, payload\)/);
  assert.match(appSource, /url: `\$\{SYNC_API_URL\}\$\{path\}`/);
});
