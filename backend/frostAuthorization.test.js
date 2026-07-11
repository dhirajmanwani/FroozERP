const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildFrostPolicy,
  normalizeRoleName,
} = require("./aiBusinessAssistantService");

const owner = {
  authenticated: true,
  user_id: 1,
  username: "owner",
  role: "owner",
  is_owner: true,
  branch_id: 1,
  permissions: {},
};

test("normalizes Owner role variants", () => {
  assert.equal(normalizeRoleName("Owner"), "OWNER");
  assert.equal(normalizeRoleName("OWNER"), "OWNER");
  assert.equal(normalizeRoleName("owner"), "OWNER");
});

test("Owner read-only FROST request executes without approval", () => {
  const policy = buildFrostPolicy(owner, "READ_ONLY");
  assert.equal(policy.allowed, true);
  assert.equal(policy.approvalRequired, false);
});

test("Owner reminder creation is a safe personal write", () => {
  const policy = buildFrostPolicy(owner, "SAFE_PERSONAL_WRITE");
  assert.equal(policy.allowed, true);
  assert.equal(policy.approvalRequired, false);
});

test("Owner business write requires a proposal and confirmation", () => {
  const policy = buildFrostPolicy(owner, "BUSINESS_WRITE");
  assert.equal(policy.allowed, true);
  assert.equal(policy.approvalRequired, true);
  assert.match(policy.reason, /confirmation/i);
});

test("Missing session is an authentication error", () => {
  const policy = buildFrostPolicy({ authenticated: false }, "READ_ONLY");
  assert.equal(policy.allowed, false);
  assert.equal(policy.errorCode, "AUTHENTICATION_REQUIRED");
});

test("Forged frontend owner flag is not enough for high risk action", () => {
  const forged = { authenticated: true, role: "Cashier", is_owner: false };
  const policy = buildFrostPolicy(forged, "HIGH_RISK");
  assert.equal(policy.allowed, false);
  assert.equal(policy.approvalRequired, true);
});
