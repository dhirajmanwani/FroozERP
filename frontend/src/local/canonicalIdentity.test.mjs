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
