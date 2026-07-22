const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  canonicalAliasClaim,
  isOwnerBootstrapEligible,
  unresolvedLoginDeviceGate,
} = require("./identityPolicy");

const freshDeviceId = () => `FZDEV-${crypto.randomUUID().toUpperCase()}`;

test("owner eligibility is role based and does not force a username", () => {
  assert.equal(isOwnerBootstrapEligible({ username: "dhirajmanwani", role_name: "Owner", active: true }), true);
  assert.equal(isOwnerBootstrapEligible({ username: "owner", role_name: "Cashier", active: true }), false);
  assert.equal(isOwnerBootstrapEligible({ username: "dhirajmanwani", role_name: "Owner", active: false }), false);
});

test("production authentication source contains no bootstrap password literal", () => {
  const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  assert.equal(source.includes('String(password || "") ==='), false);
  assert.equal(source.includes('toLowerCase() === "owner"'), false);
  assert.doesNotMatch(source, /ownerBootstrapDeviceAllowlist/);
  assert.doesNotMatch(source, /FZDEV-[A-Z0-9-]{8,}/);
});

test("canonical login alias requires an existing user claim and device identity", () => {
  const deviceId = freshDeviceId();
  assert.deepEqual(canonicalAliasClaim({
    canonicalUserId: 1,
    deviceId,
    requestedUsername: "DhirajManwani",
  }), {
    userId: 1,
    deviceId,
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
    device: { device_id: freshDeviceId(), status: "PENDING" },
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
    device: { device_id: freshDeviceId(), status: "APPROVED", approved_by: 1 },
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

test("fresh-device reference seed includes branch-scoped inventory lots", () => {
  const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  assert.match(source, /'inventory_lot'/);
  assert.match(source, /'product_global_id', p\.global_id/);
  assert.match(source, /scl\.company_id = b\.company_id/);
  assert.match(source, /scl\.branch_id = ib\.branch_id/);
});

test("stable product identities survive historical duplicate names and null rates", () => {
  const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  assert.match(source, /ALTER TABLE products ALTER COLUMN selling_rate DROP NOT NULL/);
  assert.match(source, /product_name IS NOT NULL AND TRIM\(product_name\) <> '' AND global_id IS NULL/);
  assert.match(source, /WHERE active IS DISTINCT FROM FALSE AND global_id IS NULL/);

  const activeSchemaInitializer = source.match(/const ensureProductEntrySchema = async[\s\S]*?\n};/)?.[0] || "";
  assert.match(activeSchemaInitializer, /ALTER TABLE products ALTER COLUMN selling_rate DROP NOT NULL/);
  assert.match(activeSchemaInitializer, /DROP INDEX IF EXISTS products_category_name_lower_unique_idx/);
  assert.match(activeSchemaInitializer, /WHERE active IS DISTINCT FROM FALSE AND global_id IS NULL/);
});
