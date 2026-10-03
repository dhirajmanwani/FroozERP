import assert from "node:assert/strict";
import test from "node:test";
import { buildCanonicalAliasLoginClaim, findConflictingCloudUsers, reconcileCanonicalIdentity } from "./canonicalIdentity.js";

test("authenticated dhirajmanwani session adopts canonical cloud scope without renaming", () => {
  const result = reconcileCanonicalIdentity({
    authenticatedUser: { id: 1, username: "dhirajmanwani", role: "Owner", branch_id: 1 },
    cloudIdentity: {
      user_id: 1,
      role: "Owner",
      company_id: 1,
      branch_id: 1,
      device_id: "FZDEV-DELL-1781852580596",
      registration_status: "APPROVED",
    },
    deviceInfo: { device_id: "FZDEV-DELL-1781852580596" },
  });
  assert.equal(result.username, "dhirajmanwani");
  assert.equal(result.canonical_user_id, "1");
  assert.equal(result.normalized_role, "OWNER");
  assert.equal(result.company_id, 1);
  assert.equal(result.branch_id, 1);
  assert.equal(result.device_approval_status, "APPROVED");
});

test("canonical identity reconciliation does not create a duplicate cloud user", () => {
  const cloudUsers = [{ user_id: 1, username: "owner" }];
  const before = cloudUsers.length;
  const conflicts = findConflictingCloudUsers(cloudUsers, {
    authenticatedUsername: "dhirajmanwani",
    canonicalUserId: 1,
  });
  assert.equal(conflicts.length, 0);
  assert.equal(cloudUsers.length, before);
});

test("different cloud user IDs are rejected", () => {
  assert.throws(() => reconcileCanonicalIdentity({
    authenticatedUser: { id: 1, username: "dhirajmanwani" },
    cloudIdentity: { user_id: 2, company_id: 1, branch_id: 1, device_id: "device-a" },
    deviceInfo: { device_id: "device-a" },
  }), /canonical cloud user ID/);
});

test("offline identity can claim its canonical user only on the same device", () => {
  const snapshot = {
    user_profile: { id: 1, username: "dhirajmanwani", role: "Owner" },
    device_identity: { device_id: "FZDEV-DELL-1781852580596" },
  };
  assert.deepEqual(buildCanonicalAliasLoginClaim({
    username: "DhirajManwani",
    deviceInfo: { device_id: "FZDEV-DELL-1781852580596" },
    snapshot,
  }), { canonical_user_id: "1" });
  assert.deepEqual(buildCanonicalAliasLoginClaim({
    username: "dhirajmanwani",
    deviceInfo: { device_id: "different-device" },
    snapshot,
  }), {});
});

test("an unchanged identity after a sync is recognised as the same, so screens do not reload", async () => {
  const { sameIdentityRecord, reconcileCanonicalIdentity: reconcile } = await import("./canonicalIdentity.js");
  const user = { id: 2, username: "owner", role: "Owner", branch_id: 1, permissions: { billing: true }, list: [1, 2] };
  assert.equal(sameIdentityRecord(user, { ...user, permissions: { billing: true }, list: [1, 2] }), true);
  assert.equal(sameIdentityRecord(user, { list: [1, 2], permissions: { billing: true }, branch_id: 1, role: "Owner", username: "owner", id: 2 }), true, "key order ignored");
  assert.equal(sameIdentityRecord(user, { ...user, branch_id: 2 }), false);
  assert.equal(sameIdentityRecord(user, { ...user, permissions: { billing: false } }), false);
  assert.equal(sameIdentityRecord(user, { ...user, extra: "x" }), false);
  assert.equal(sameIdentityRecord(user, { ...user, extra: undefined }), true);
  assert.equal(sameIdentityRecord(null, user), false);
  // A second reconcile of the same cloud answer is the same record.
  const cloud = { user_id: "2", device_id: "FZDEV-1", company_id: "1", branch_id: "1", role: "Owner", registration_status: "approved" };
  const first = reconcile({ authenticatedUser: user, cloudIdentity: cloud, deviceInfo: { device_id: "FZDEV-1" } });
  const second = reconcile({ authenticatedUser: first, cloudIdentity: cloud, deviceInfo: { device_id: "FZDEV-1" } });
  assert.notEqual(first, second);
  assert.equal(sameIdentityRecord(first, second), true);
});

test("Branches & Counters keeps its page on a background reload and reloads only when the session changes", async () => {
  const { readFileSync } = await import("node:fs");
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /if \(!sameIdentityRecord\(userRef\.current, canonicalUser\)\) \{\s*userRef\.current = canonicalUser;\s*setUser\(canonicalUser\);/);
  const start = app.indexOf("function OperationalScopeManagement(");
  const body = app.slice(start, app.indexOf("\nfunction ", start + 10));
  assert.match(body, /useEffect\(\(\) => \{ load\(\); \}, \[load, sessionKey\]\);/);
  assert.match(body, /if \(loading && !loadedOnce\) return/);
  assert.doesNotMatch(body, /\}, \[user\]\);/);
});
