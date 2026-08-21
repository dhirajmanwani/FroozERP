"use strict";

/**
 * A-7 step 2 — device re-pointing.
 *
 * `PUT /settings/devices/:deviceId` had a role check and nothing else: any Owner or Admin could
 * rename, disable or **re-point any device in the database** into any branch. The audit called it a
 * possible escalation rather than mere corruption, and that is exactly right — `/login` mints the
 * session's branch claim as
 *
 *     operationalAssignment?.branch_id || device.assigned_branch_id || user.branch_id || 1
 *
 * so moving a device changes which branch its next token *legitimately* claims. Not a forged token:
 * a real one, signed by this server, for somebody else's branch.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const backendSource = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const backendCode = backendSource
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** The device-management handler only, so an assertion cannot pass on some other route's code. */
const deviceHandler = (() => {
  const start = backendCode.indexOf('app.put("/settings/devices/:deviceId"');
  assert.ok(start > 0, "the device management route must exist");
  return backendCode.slice(start, start + 4000);
})();

test("the target device is looked up within the actor's company, not globally", () => {
  // Unscoped, an Owner of one business could manage another business's devices.
  assert.match(
    deviceHandler,
    /FROM authorized_devices WHERE device_id = \$1 AND company_id = \$2/,
    "the device lookup must be company-scoped",
  );
  assert.match(deviceHandler, /req\.auth\.companyId/, "and scoped from the verified session claim");
});

test("a device outside the company is reported as missing, not as forbidden", () => {
  // A distinct "not yours" confirms the device exists to someone who should not be able to learn
  // that. The same 404 an unknown id gets reveals nothing either way.
  assert.match(deviceHandler, /if \(!beforeResult\.rows\[0\]\) return res\.status\(404\)/);
  assert.doesNotMatch(deviceHandler, /status\(403\)[^\n]*device_id/, "no distinct not-yours answer");
});

test("a device cannot be re-pointed into a branch of another business", () => {
  // The escalation: an unchecked integer here becomes a legitimately signed token for that branch.
  assert.match(
    deviceHandler,
    /FROM branches WHERE id = \$1 AND company_id = \$2 AND active IS DISTINCT FROM FALSE/,
    "the target branch must be validated against the actor's company",
  );
  assert.match(deviceHandler, /BRANCH_NOT_IN_COMPANY/);
});

test("the branch check runs before the update, not after", () => {
  // Validating after writing would leave the device already moved.
  const checkIndex = deviceHandler.indexOf("FROM branches WHERE id = $1 AND company_id = $2");
  const updateIndex = deviceHandler.indexOf("UPDATE authorized_devices");
  assert.ok(checkIndex > 0 && updateIndex > 0, "both must exist");
  assert.ok(checkIndex < updateIndex, "the branch must be validated before the device is moved");
});

test("an inactive branch is refused as firmly as a foreign one", () => {
  // A device parked in a closed branch is a device whose next login claims a branch nobody is
  // watching.
  assert.match(deviceHandler, /active IS DISTINCT FROM FALSE/);
});

test("omitting the branch leaves it alone rather than defaulting", () => {
  // COALESCE keeps the existing value, so a rename that does not mention a branch must not move
  // the device. The validation is skipped only when nothing was asked for.
  assert.match(deviceHandler, /assigned_branch_id = COALESCE\(\$3, assigned_branch_id\)/);
  assert.match(deviceHandler, /if \(requestedBranchId\) \{/, "validation applies only when one is supplied");
});

test("the verified company claim is now actually read somewhere", () => {
  // The branch-isolation audit's headline finding was that req.auth.companyId and req.auth.branchId
  // had ZERO read sites in the entire backend — A-3 put them in every token and nothing consumed
  // them. This is the first consumer. If it ever returns to zero, the audit's finding is back.
  const reads = backendCode.match(/req\.auth\.(companyId|branchId)/g) || [];
  assert.ok(reads.length > 0, "the verified tenant claims must be read by something");
});
