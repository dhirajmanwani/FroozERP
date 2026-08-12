"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Pool } = require("../../backend/node_modules/pg");
const { issueDeviceSession } = require("../../backend/deviceSession");

const databaseUrl = String(process.env.DATABASE_URL || "");
const evidenceDir = String(process.env.EVIDENCE_DIR || "");
const port = Number(process.env.TEST_BACKEND_PORT || 55558);
if (!/^postgres(?:ql)?:\/\/[^/]*(?:127\.0\.0\.1|localhost)[^/]*\/[^/?]*_staging(?:[?]|$)/i.test(databaseUrl)) {
  throw new Error("Mixed-version rehearsal requires a loopback *_staging database");
}
if (!evidenceDir) throw new Error("EVIDENCE_DIR is required");
fs.mkdirSync(evidenceDir, { recursive: true });

const pool = new Pool({ connectionString: databaseUrl });
const secret = crypto.randomBytes(48).toString("base64url");
const devices = {
  legacy63: "FZDEV-STAGING-LEGACY-1063",
  legacy65: "FZDEV-STAGING-LEGACY-1065",
  other: "FZDEV-STAGING-OTHER-LOCATION",
  unassigned: "FZDEV-STAGING-UNASSIGNED",
  unapproved: "FZDEV-STAGING-UNAPPROVED",
};
let backend;

const request = async (method, route, { token, body } = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-froozerp-device-session": token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, payload: await response.json().catch(() => ({})) };
};

const waitForHealth = async () => {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (backend?.exitCode != null) {
      throw new Error(`Isolated backend exited before health check (${backend.exitCode})`);
    }
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Isolated backend did not become healthy");
};

const addDevice = async ({ deviceId, version, locationId, status = "APPROVED", assigned = true }) => {
  await pool.query(
    `INSERT INTO authorized_devices
       (device_id,device_name,device_type,status,assigned_branch_id,company_id,app_version,approved_by,approved_at)
     VALUES ($1,$2,'LAPTOP',$3,1,1,$4,1,CURRENT_TIMESTAMP)
     ON CONFLICT (device_id) DO UPDATE SET status=EXCLUDED.status,app_version=EXCLUDED.app_version`,
    [deviceId, `Disposable ${version}`, status, version]
  );
  if (!assigned) return;
  await pool.query(
    `INSERT INTO device_assignments
       (device_id,company_id,branch_id,operational_location_id,physical_label,device_type,
        intended_usage,fixed_operational,permission_set,permitted_user_ids,permitted_roles,
        assignment_generation,active,approved_by)
     VALUES ($1,1,1,$2,$3,'LAPTOP','POS',TRUE,
       '{"operational_access":true,"sync":true}'::jsonb,'[1]'::jsonb,'[1]'::jsonb,1,TRUE,1)`,
    [deviceId, locationId, `Disposable ${version}`]
  );
};

const prepareFixture = async () => {
  const locations = await pool.query(
    `INSERT INTO operational_locations
       (company_id,branch_id,location_code,location_name,location_type,active,is_default)
     VALUES
       (1,1,'MIXED-A','Mixed Version Location A','STORE',TRUE,TRUE),
       (1,1,'MIXED-B','Mixed Version Location B','STORE',TRUE,FALSE)
     RETURNING id,location_code`
  );
  const locationA = Number(locations.rows.find((row) => row.location_code === "MIXED-A").id);
  const locationB = Number(locations.rows.find((row) => row.location_code === "MIXED-B").id);
  for (const locationId of [locationA, locationB]) {
    await pool.query(
      `INSERT INTO staff_location_assignments
         (user_id,company_id,branch_id,operational_location_id,role_id,permission_set,is_default,active,assigned_by)
       VALUES (1,1,1,$1,1,'{"operational_access":true,"sync":true}'::jsonb,$2,TRUE,1)`,
      [locationId, locationId === locationA]
    );
  }
  await pool.query(
    `UPDATE products
     SET company_id=1
     WHERE company_id IS NULL`
  );
  await pool.query(
    `UPDATE inventory_batches
     SET company_id=1,branch_id=1,operational_location_id=$1
     WHERE operational_location_id IS NULL`,
    [locationA]
  );
  await addDevice({ deviceId: devices.legacy63, version: "1.0.63", locationId: locationA });
  await addDevice({ deviceId: devices.legacy65, version: "1.0.65", locationId: locationA });
  await addDevice({ deviceId: devices.other, version: "current", locationId: locationB });
  await addDevice({ deviceId: devices.unassigned, version: "1.0.65", locationId: locationA, assigned: false });
  await addDevice({ deviceId: devices.unapproved, version: "1.0.65", locationId: locationA, status: "PENDING", assigned: false });
  return { locationA, locationB };
};

const run = async () => {
  const { locationA, locationB } = await prepareFixture();
  const token63 = issueDeviceSession({ userId: 1, deviceId: devices.legacy63, companyId: 1, branchId: 1, secret });
  const token65 = issueDeviceSession({ userId: 1, deviceId: devices.legacy65, companyId: 1, branchId: 1, secret });
  const tokenOther = issueDeviceSession({ userId: 1, deviceId: devices.other, companyId: 1, branchId: 1, secret });
  const tokenUnassigned = issueDeviceSession({ userId: 1, deviceId: devices.unassigned, companyId: 1, branchId: 1, secret });
  const tokenUnapproved = issueDeviceSession({ userId: 1, deviceId: devices.unapproved, companyId: 1, branchId: 1, secret });
  const log = fs.openSync(path.join(evidenceDir, "backend.log"), "a");
  backend = spawn(process.execPath, [path.resolve(__dirname, "../../backend/server.js")], {
    cwd: path.resolve(__dirname, "../.."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      APP_MODE: "CLOUD_PRODUCTION",
      FROOZERP_DEPLOYMENT_TYPE: "cloud",
      FROOZERP_RUNTIME_MODE: "cloud-server",
      FROOZERP_ALLOW_LOOPBACK_POSTGRES_FOR_ISOLATED_TESTS: "true",
      FROOZERP_OPERATIONAL_SCOPE_MODE: "enforce",
      DATABASE_URL: databaseUrl,
      DB_SSL: "false",
      DEVICE_SESSION_SECRET: secret,
      PORT: String(port),
    },
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  await waitForHealth();

  const legacy63 = await request("GET", `/api/sync/pull?user_id=1&device_id=${devices.legacy63}&branch_id=1&cursor=0`, { token: token63 });
  assert.equal(legacy63.status, 400);
  assert.equal(legacy63.payload.code, "SYNC_SCOPE_REQUIRED");
  const legacy65 = await request("POST", "/api/sync/push", {
    token: token65,
    body: { user_id: 1, device_id: devices.legacy65, branch_id: 1, operations: [] },
  });
  assert.equal(legacy65.status, 400);
  assert.equal(legacy65.payload.code, "SYNC_SCOPE_REQUIRED");

  const scopeA = { user_id: 1, device_id: devices.legacy65, company_id: 1, branch_id: 1, operational_location_id: locationA };
  const unsigned = await request("GET", `/api/sync/status?${new URLSearchParams(scopeA)}`);
  assert.equal(unsigned.status, 401);
  assert.equal(unsigned.payload.code, "DEVICE_SESSION_REQUIRED");
  const substitutedBranch = await request("GET", `/api/sync/status?${new URLSearchParams({ ...scopeA, branch_id: 2 })}`, { token: token65 });
  assert.equal(substitutedBranch.status, 403);
  const substitutedLocation = await request("GET", `/api/sync/status?${new URLSearchParams({ ...scopeA, operational_location_id: locationB })}`, { token: token65 });
  assert.equal(substitutedLocation.status, 403);
  const invalidSignature = await request("GET", `/api/sync/status?${new URLSearchParams(scopeA)}`, { token: `${token65}x` });
  assert.equal(invalidSignature.status, 401);

  const unassignedScope = { ...scopeA, device_id: devices.unassigned };
  assert.equal((await request("GET", `/api/sync/status?${new URLSearchParams(unassignedScope)}`, { token: tokenUnassigned })).status, 403);
  const unapprovedScope = { ...scopeA, device_id: devices.unapproved };
  assert.equal((await request("GET", `/api/sync/status?${new URLSearchParams(unapprovedScope)}`, { token: tokenUnapproved })).status, 403);

  const status = await request("GET", `/api/sync/status?${new URLSearchParams(scopeA)}`, { token: token65 });
  assert.equal(status.status, 200, JSON.stringify(status.payload));
  assert.equal(Number(status.payload.operational_location_id), locationA);
  const startingCursor = Number(status.payload.latest_cursor || 0);
  const operation = {
    operation_id: "mixed-version-idempotent-op",
    idempotency_key: "mixed-version-idempotent-op",
    entity_type: "sync_test",
    entity_id: "mixed-version-entity",
    operation_type: "UPSERT",
    version: 1,
    payload: { value: "authorized", company_id: 1, branch_id: 1, operational_location_id: locationA },
  };
  const pushBody = { ...scopeA, operations: [operation] };
  const firstPush = await request("POST", "/api/sync/push", { token: token65, body: pushBody });
  assert.equal(firstPush.status, 200, JSON.stringify(firstPush.payload));
  assert.equal(firstPush.payload.acknowledgements[0].status, "accepted");
  const duplicatePush = await request("POST", "/api/sync/push", { token: token65, body: pushBody });
  assert.equal(duplicatePush.status, 200);
  const counts = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM sync_processed_operations WHERE operation_id=$1) processed,
       (SELECT COUNT(*)::int FROM sync_change_log WHERE payload->>'source_operation_id'=$1) changes,
       (SELECT COUNT(*)::int FROM sync_test_entities WHERE id='mixed-version-entity') entities`,
    [operation.operation_id]
  );
  assert.deepEqual(counts.rows[0], { processed: 1, changes: 1, entities: 1 });

  const pullA = await request("GET", `/api/sync/pull?${new URLSearchParams({ ...scopeA, cursor: startingCursor, limit: 50 })}`, { token: token65 });
  assert.equal(pullA.status, 200);
  assert.equal(pullA.payload.changes.filter((row) => row.entity_id === "mixed-version-entity").length, 1);
  const scopeB = { user_id: 1, device_id: devices.other, company_id: 1, branch_id: 1, operational_location_id: locationB };
  const pullB = await request("GET", `/api/sync/pull?${new URLSearchParams({ ...scopeB, cursor: startingCursor, limit: 50 })}`, { token: tokenOther });
  assert.equal(pullB.status, 200);
  assert.equal(pullB.payload.changes.some((row) => row.entity_id === "mixed-version-entity"), false);

  const legacyWrite = await request("POST", "/sales", { body: {} });
  assert.equal(legacyWrite.status, 426);
  const legacyApproval = await request("PUT", `/settings/devices/${devices.unapproved}`, {
    body: { action: "APPROVE", branch_id: 1, updated_by: 1 },
  });
  assert.equal(legacyApproval.status, 426);

  const result = {
    versions: ["1.0.63", "1.0.65"],
    legacy_sync_rejections: { "1.0.63": legacy63.payload.code, "1.0.65": legacy65.payload.code },
    unsigned: unsigned.payload.code,
    substituted_branch: substitutedBranch.payload.code,
    substituted_location: substitutedLocation.payload.code,
    invalid_signature: invalidSignature.payload.code,
    correct_scope: { status: status.status, operational_location_id: locationA },
    idempotency: counts.rows[0],
    authorized_change_count: pullA.payload.changes.filter((row) => row.entity_id === "mixed-version-entity").length,
    other_location_change_count: pullB.payload.changes.filter((row) => row.entity_id === "mixed-version-entity").length,
    legacy_write_status: legacyWrite.status,
    legacy_approval_status: legacyApproval.status,
  };
  fs.writeFileSync(path.join(evidenceDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
};

run().finally(async () => {
  if (backend && !backend.killed) backend.kill();
  await pool.end();
});
