"use strict";

/**
 * A-7 step 3 — the defaults that quietly filed records under Branch 1.
 *
 * The branch-isolation audit found `|| 1` and `= 1` scattered through the branch-resolution paths.
 * Most are harmless in a single-branch business, and stay: a fallback that is always correct today
 * is not worth the churn of removing. Two were not harmless, and this file pins both.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const backendSource = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const backendCode = backendSource
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

test("a new user cannot be placed in another business's branch", () => {
  // Was `parsePositiveInteger(req.body.branch_id) || manager.branch_id || 1`, where the middle term
  // is dead — requireRateManager selects only id, full_name and role_name — leaving a
  // client-supplied branch with no validation at all.
  assert.doesNotMatch(
    backendCode,
    /parsePositiveInteger\(req\.body\.branch_id\) \|\| manager\.branch_id \|\| 1/,
    "the unvalidated client-supplied branch must be gone",
  );
  assert.match(backendCode, /const requestedUserBranchId = parsePositiveInteger\(req\.body\.branch_id\);/);
  assert.match(
    backendCode,
    /FROM branches WHERE id = \$1 AND company_id = \$2 AND active IS DISTINCT FROM FALSE LIMIT 1/,
    "a requested branch must be validated against the actor's company",
  );
});

test("a user created without a branch belongs where their creator is, not in Branch 1", () => {
  // Both safer and truer: the actor's branch is a considered answer, 1 is an accident.
  assert.match(backendCode, /const newUserBranchId = requestedUserBranchId \|\| req\.auth\.branchId;/);
  assert.match(backendCode, /^\s*newUserBranchId,$/m, "and it is what gets inserted");
});

test("requireRateManager still does not select branch_id, which is why that fallback was dead", () => {
  // Pins the reason. If a future change adds branch_id to that SELECT, the old expression would
  // start working and look like it always had — this test is the record that it never did.
  const guard = backendCode.slice(backendCode.indexOf("const requireRateManager = async"));
  const select = guard.slice(0, 400);
  assert.match(select, /SELECT u\.id, u\.full_name, r\.role_name/);
  assert.doesNotMatch(select, /u\.branch_id/, "if this changes, revisit every manager.branch_id read");
});

test("the sync change log refuses a row with no branch instead of inventing one", () => {
  // All 21 callers pass a branch, so the old `branchId = 1` default was never exercised and was
  // waiting for caller 22 to forget. A change-log row is what every other device replays; one
  // attributed to the wrong branch does not fail, it propagates.
  assert.doesNotMatch(backendCode, /const logSyncChange = async \(client, \{\s*\n\s*branchId = 1,/);
  assert.match(backendCode, /const logSyncChange = async \(client, \{\s*\n\s*branchId,/);
  assert.match(
    backendCode,
    /if \(!parsePositiveInteger\(branchId\)\) \{\s*\n\s*throw new Error\(`logSyncChange requires a branchId/,
    "a missing branch must throw, not default",
  );
});

test("every logSyncChange caller supplies a branch, so requiring it breaks nothing", () => {
  // The safety argument for making it required. If this count ever drops, the throw above turns a
  // silent misattribution into a visible failure — which is the intent — but it should be a
  // deliberate discovery, not a surprise in production.
  const calls = backendCode.match(/logSyncChange\(client, \{/g) || [];
  const withBranch = backendCode.match(/logSyncChange\(client, \{[^}]*branchId/g) || [];
  assert.ok(calls.length > 0, "there must be callers to check");
  assert.equal(withBranch.length, calls.length, "every caller must pass branchId explicitly");
});
