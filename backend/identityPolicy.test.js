const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { canonicalAliasClaim, isOwnerBootstrapEligible } = require("./identityPolicy");

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
