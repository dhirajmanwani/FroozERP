const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  approvedAliasCredentialFailure,
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

test("canonical alias SQL uses the explicit claim and server-authorized location intersection", () => {
  const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  const start = source.indexOf('app.post("/login"');
  const end = source.indexOf('const listProductCategoriesHandler', start);
  const loginRoute = source.slice(start, end);

  assert.ok(start > 0 && end > start);
  assert.match(loginRoute, /\$2::INTEGER IS NOT NULL[\s\S]*u\.id = \$2/);
  assert.match(loginRoute, /d\.device_id = \$3/);
  assert.match(loginRoute, /d\.status = 'APPROVED'/);
  assert.match(loginRoute, /JOIN device_assignments da/);
  assert.match(loginRoute, /JOIN staff_location_assignments sla/);
  assert.match(loginRoute, /sla\.user_id = u\.id/);
  assert.match(loginRoute, /u\.company_id = da\.company_id/);
  assert.doesNotMatch(loginRoute, /d\.approved_by = u\.id/);
  assert.doesNotMatch(loginRoute, /d\.assigned_branch_id = COALESCE\(u\.branch_id, 1\)/);
  // Renamed to checkPassword in auth-hardening A-1 (salted scrypt + legacy dispatch). The
  // assertion's intent is unchanged: the login route must verify the supplied password
  // against this user's stored hash, and must not be reachable around.
  assert.match(loginRoute, /checkPassword\(password, user\.password_hash\)/);
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
  assert.match(source, /\$2::INTEGER IS NOT NULL/);
  assert.match(source, /checkPassword\(password, user\.password_hash\)/);
  assert.match(source, /canonical_alias_used: canonicalAliasUsed/);
});

test("approved login returns the active server-authorized operational assignment", () => {
  const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  const start = source.indexOf('app.post("/login"');
  const end = source.indexOf('const listProductCategoriesHandler', start);
  const loginRoute = source.slice(start, end);

  assert.ok(start > 0 && end > start);
  assert.match(loginRoute, /FROM device_assignments da/);
  assert.match(loginRoute, /LEFT JOIN staff_location_assignments sla/);
  assert.match(loginRoute, /WHERE da\.device_id = \$1[\s\S]*da\.active = TRUE/);
  assert.match(loginRoute, /DEVICE_LOCATION_MISMATCH/);
  assert.match(loginRoute, /canonicalCompanyId = operationalAssignment\?\.company_id/);
  assert.match(loginRoute, /canonicalBranchId = operationalAssignment\?\.branch_id/);
  assert.match(loginRoute, /operational_location_id: canonicalOperationalLocationId/);
  assert.match(loginRoute, /operational_location: operationalAssignment\?\.location_name/);
  assert.match(loginRoute, /device_id: device\.device_id/);
  const assignmentIndex = loginRoute.indexOf("const operationalAssignmentResult");
  const auditIndex = loginRoute.indexOf('action: "LOGIN_SUCCESS"');
  assert.ok(assignmentIndex > 0 && auditIndex > assignmentIndex);
  assert.match(loginRoute, /details:\s*\{[\s\S]*company_id: canonicalCompanyId[\s\S]*user_id: user\.id[\s\S]*device_id: device\.device_id[\s\S]*branch_id: canonicalBranchId[\s\S]*operational_location_id: canonicalOperationalLocationId/);
});

test("approved alias password mismatch requests canonical verification without bypassing it", () => {
  assert.deepEqual(approvedAliasCredentialFailure({
    canonicalAliasUsed: true,
    device: { status: "APPROVED", approved_by: 1 },
  }), {
    code: "CANONICAL_CREDENTIALS_REQUIRED",
    status: 401,
    message: "Device approved. Enter the password for the canonical FroozERP account to finish secure provisioning.",
  });
  assert.equal(approvedAliasCredentialFailure({
    canonicalAliasUsed: false,
    device: { status: "APPROVED", approved_by: 1 },
  }), null);
  assert.equal(approvedAliasCredentialFailure({
    canonicalAliasUsed: true,
    device: { status: "PENDING", approved_by: 1 },
  }), null);
});

test("post-approval status route is read-only and does not provision identities", () => {
  const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  const start = source.indexOf('app.post("/api/auth/device-bootstrap-status"');
  const end = source.indexOf('app.post("/login"', start);
  const route = source.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(route, /SELECT device_id, status FROM authorized_devices/);
  assert.doesNotMatch(route, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  assert.doesNotMatch(route, /password_hash|token|approved_by/);
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

test("fresh-device bootstrap snapshots scoped lots without manufacturing history", () => {
  const serverSource = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  const bootstrapSource = fs.readFileSync(path.join(__dirname, "syncReferenceBootstrap.js"), "utf8");
  assert.match(bootstrapSource, /"inventory_lot"/);
  assert.match(bootstrapSource, /'product_global_id', COALESCE\(p\.global_id/);
  assert.match(bootstrapSource, /ib\.company_id = \$1/);
  assert.match(bootstrapSource, /ib\.branch_id = \$2/);
  assert.match(bootstrapSource, /ib\.operational_location_id = \$3/);
  assert.doesNotMatch(serverSource, /seedReferenceChangeLog/);
});

test("stable product identities survive historical duplicate names and null rates", () => {
  const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  assert.match(source, /ALTER TABLE products ALTER COLUMN selling_rate DROP NOT NULL/);
  assert.match(source, /product_name IS NOT NULL AND TRIM\(product_name\) <> '' AND global_id IS NULL/);
  assert.match(source, /WHERE active IS DISTINCT FROM FALSE AND global_id IS NULL/);

  const activeSchemaInitializer = source.match(/const ensureProductEntrySchema = async[\s\S]*?\n};/)?.[0] || "";
  assert.match(activeSchemaInitializer, /ALTER TABLE products ALTER COLUMN selling_rate DROP NOT NULL/);
  assert.match(activeSchemaInitializer, /ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS global_id VARCHAR\(180\)/);
  assert.match(activeSchemaInitializer, /DROP INDEX IF EXISTS products_category_name_lower_unique_idx/);
  assert.match(activeSchemaInitializer, /WHERE active IS DISTINCT FROM FALSE AND global_id IS NULL/);
  assert.match(activeSchemaInitializer, /CREATE UNIQUE INDEX IF NOT EXISTS inventory_batches_global_id_unique_idx/);
});
