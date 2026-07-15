const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { isOwnerBootstrapEligible } = require("./identityPolicy");

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
