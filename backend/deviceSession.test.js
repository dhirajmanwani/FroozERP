const test = require("node:test");
const assert = require("node:assert/strict");
const {
  issueDeviceSession,
  rejectDeviceSessionSubstitution,
  verifyDeviceSession,
} = require("./deviceSession");

const secret = "isolated-test-secret";
const scope = {
  userId: 1,
  deviceId: "FZDEV-SECOND",
  companyId: 1,
  branchId: 2,
  sessionRevocationVersion: 4,
  nowMs: 1_000_000,
  ttlSeconds: 60,
  secret,
};

test("signed device session binds the canonical user, device, company and branch", () => {
  const token = issueDeviceSession(scope);
  const verified = verifyDeviceSession(token, secret, 1_010_000);
  assert.equal(verified.claims.user_id, 1);
  assert.equal(verified.claims.device_id, "FZDEV-SECOND");
  assert.equal(verified.claims.branch_id, 2);
  assert.equal(rejectDeviceSessionSubstitution(verified.claims, {
    user_id: 1,
    device_id: "FZDEV-SECOND",
    branch_id: 2,
  }), null);
});

test("tampering, expiry and device substitution are rejected", () => {
  const token = issueDeviceSession(scope);
  assert.equal(verifyDeviceSession(`${token}x`, secret, 1_010_000).error.code, "DEVICE_SESSION_INVALID");
  assert.equal(verifyDeviceSession(token, secret, 1_061_000).error.code, "DEVICE_SESSION_EXPIRED");
  assert.equal(
    rejectDeviceSessionSubstitution(verifyDeviceSession(token, secret, 1_010_000).claims, {
      device_id: "FZDEV-MAIN",
    }).code,
    "DEVICE_SESSION_SUBSTITUTION_REJECTED"
  );
});
