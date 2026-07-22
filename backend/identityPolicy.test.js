const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  canonicalAliasClaim,
  isOwnerBootstrapEligible,
  unresolvedLoginDeviceGate,
} = require("./identityPolicy");

test("owner eligibility is role based and does not force a username", () => {
  assert.equal(isOwnerBootstrapEligible({ username: "dhirajmanwani", role_name: "Owner", active: true }), true);
  assert.equal(isOwnerBootstrapEligible({ username: "owner", role_name: "Cashier", active: true }), false);
  assert.equal(isOwnerBootstrapEligible({ username: "dhirajmanwani", role_name: "Owner", active: false }), false);
});

test("production authentication source contains no bootstrap password literal", () => {
  const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  assert.equal(source.includes('String(password || "") ==='), false);
  assert.equal(source.includes('toLowerCase() === "owner"'), false);
});

test("canonical login alias requires an existing user claim and device identity", () => {
  assert.deepEqual(canonicalAliasClaim({
    canonicalUserId: 1,
    deviceId: "FZDEV-DELL-1781852580596",
    requestedUsername: "DhirajManwani",
  }), {
    userId: 1,
    deviceId: "FZDEV-DELL-1781852580596",
    requestedUsername: "dhirajmanwani",
  });
  assert.equal(canonicalAliasClaim({ canonicalUserId: 1, requestedUsername: "dhirajmanwani" }), null);
  assert.equal(canonicalAliasClaim({ canonicalUserId: 0, deviceId: "device", requestedUsername: "alias" }), null);
});

test("canonical alias SQL remains device-bound and password verification remains mandatory", () => {
  const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  assert.match(source, /d\.device_id = \$3/);
  assert.match(source, /d\.status = 'APPROVED'/);
  assert.match(source, /d\.approved_by = u\.id/);
  assert.match(source, /passwordMatches\(password, user\.password_hash\)/);
  assert.doesNotMatch(source, /INSERT INTO users[\s\S]{0,300}canonical.*alias/i);
});

test("fresh alias login registers one pending device without authenticating a user", () => {
  assert.deepEqual(unresolvedLoginDeviceGate({
    username: "dhirajmanwani",
    password: "entered-but-never-stored",
    device: { device_id: "FZDEV-SECOND-LAPTOP", status: "PENDING" },
  }), { code: "DEVICE_PENDING_APPROVAL", status: 403 });

  const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  assert.match(source, /ON CONFLICT \(device_id\) DO UPDATE/);
  assert.doesNotMatch(source, /ON CONFLICT \(device_id\)[\s\S]{0,400}status\s*=\s*EXCLUDED\.status/);
  assert.doesNotMatch(source, /INSERT INTO users[\s\S]{0,500}DEVICE_PENDING_APPROVAL/);
});

test("approval state cannot bypass canonical password verification", () => {
  assert.deepEqual(unresolvedLoginDeviceGate({
    username: "dhirajmanwani",
    password: "wrong",
    device: { device_id: "FZDEV-SECOND-LAPTOP", status: "APPROVED", approved_by: 1 },
  }), { code: "INVALID_CREDENTIALS", status: 401 });

  const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  assert.match(source, /d\.device_id = \$3/);
  assert.match(source, /d\.approved_by = u\.id/);
  assert.match(source, /passwordMatches\(password, user\.password_hash\)/);
  assert.match(source, /canonical_alias_used: canonicalAliasUsed/);
});

test("disabled and revoked fresh devices are never returned to pending", () => {
  assert.deepEqual(unresolvedLoginDeviceGate({
    username: "dhirajmanwani",
    password: "entered",
    device: { device_id: "disabled", status: "DISABLED" },
  }), { code: "DEVICE_DISABLED", status: 403 });
  assert.deepEqual(unresolvedLoginDeviceGate({
    username: "dhirajmanwani",
    password: "entered",
    device: { device_id: "revoked", status: "REVOKED" },
  }), { code: "DEVICE_REVOKED", status: 403 });
});
