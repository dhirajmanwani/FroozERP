import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appSource = fs.readFileSync(path.join(here, "../App.jsx"), "utf8");
const backendSource = fs.readFileSync(path.join(here, "../../../backend/scopeManagement.js"), "utf8");

const navigationSource = fs.readFileSync(new URL("./appNavigation.js", import.meta.url), "utf8");

test("branch and counter management is a module of its own, not a settings page", () => {
  // Moved out of Settings on the maintainer's instruction, and the reasoning holds: adding a shop
  // or a counter is not a preference adjusted once and forgotten. It decides which stock a machine
  // sells from, so it belongs where somebody can find it without hunting through Settings.
  //
  // This assertion is stronger than the one it replaces. A settings *section* only has to exist in
  // a map; a module has to be in the sidebar list, in the navigation registry, and rendered by the
  // view switch -- and the registry test checks those three against each other. So this pins the
  // move, and appNavigation.test.mjs pins that the move is complete.
  assert.match(appSource, /<OperationalScopeManagement canManage=\{settingsData\.canManageSettings\} user=\{user\} \/>/);
  assert.match(appSource, /activeView === "branches"/);
  assert.match(appSource, /\["branches", "Branches & Counters"\]/);

  // And it must not still be a Settings section too. Two homes for one screen is how the two
  // quietly drift into behaving differently.
  assert.doesNotMatch(appSource, /"settings\/operational-scope":/);
  assert.doesNotMatch(navigationSource, /settings\/operational-scope/);

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
