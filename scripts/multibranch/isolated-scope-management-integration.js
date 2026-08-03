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
const port = Number(process.env.TEST_BACKEND_PORT || 55553);
if (!/^postgres(?:ql)?:\/\/[^/]*(?:127\.0\.0\.1|localhost)[^/]*\/[^/?]*_staging(?:[?]|$)/i.test(databaseUrl)) {
  throw new Error("Scope-management integration requires a loopback *_staging database");
}
if (!evidenceDir) throw new Error("EVIDENCE_DIR is required");
fs.mkdirSync(evidenceDir, { recursive: true });

const pool = new Pool({ connectionString: databaseUrl });
const ownerDeviceId = "FZDEV-STAGING-SCOPE-OWNER";
const pendingDeviceId = "FZDEV-STAGING-SCOPE-PENDING";
const rejectedDeviceId = "FZDEV-STAGING-SCOPE-UNAPPROVED";
const secret = crypto.randomBytes(48).toString("base64url");
let backend;

const query = (...args) => pool.query(...args);
const request = async (method, route, token, body) => {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-froozerp-device-session": token,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
};
const waitForHealth = async () => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Isolated backend did not become healthy");
};

const fixture = async () => {
  await query("SELECT setval(pg_get_serial_sequence('branches','id'), GREATEST(COALESCE((SELECT MAX(id) FROM branches), 0), 1), TRUE)");
  await query(`INSERT INTO operational_locations
    (company_id,branch_id,location_code,location_name,location_type,active,is_default)
    VALUES (1,1,'STAGING-OWNER','Staging Owner Location','OFFICE',TRUE,TRUE)
    ON CONFLICT (company_id,branch_id,location_code) DO UPDATE SET active=TRUE
    RETURNING id`);
  const location = await query("SELECT id FROM operational_locations WHERE company_id=1 AND branch_id=1 AND location_code='STAGING-OWNER'");
  const locationId = Number(location.rows[0].id);
  await query(`INSERT INTO authorized_devices (device_id,device_name,device_type,status,assigned_branch_id,approved_by,approved_at)
    VALUES ($1,'Staging Scope Owner','DESKTOP','APPROVED',1,1,CURRENT_TIMESTAMP)
    ON CONFLICT (device_id) DO UPDATE SET status='APPROVED'`, [ownerDeviceId]);
  await query(`INSERT INTO staff_location_assignments
    (user_id,company_id,branch_id,operational_location_id,role_id,permission_set,is_default,active,assigned_by)
    VALUES (1,1,1,$1,1,'{"manage_assignments":true,"consolidated_reports":true}'::jsonb,TRUE,TRUE,1)
    ON CONFLICT (user_id,operational_location_id) DO UPDATE SET permission_set=EXCLUDED.permission_set,active=TRUE`, [locationId]);
  await query(`INSERT INTO device_assignments
    (device_id,company_id,branch_id,operational_location_id,physical_label,device_type,intended_usage,
     fixed_operational,permission_set,permitted_user_ids,permitted_roles,assignment_generation,active,approved_by)
    VALUES ($1,1,1,$2,'Staging Owner Desk','DESKTOP','OWNER_DASHBOARD',FALSE,
      '{"manage_assignments":true,"consolidated_reports":true}'::jsonb,'[1]'::jsonb,'[1]'::jsonb,1,TRUE,1)
    ON CONFLICT (device_id,assignment_generation) DO UPDATE SET permission_set=EXCLUDED.permission_set,active=TRUE`, [ownerDeviceId, locationId]);
  for (const [deviceId, name] of [[pendingDeviceId, "Staging Pending Device"], [rejectedDeviceId, "Staging Unapproved Device"]]) {
    await query(`INSERT INTO authorized_devices (device_id,device_name,device_type,status)
      VALUES ($1,$2,'LAPTOP','PENDING') ON CONFLICT (device_id) DO UPDATE SET status='PENDING'`, [deviceId, name]);
  }
  return locationId;
};

const run = async () => {
  const ownerLocationId = await fixture();
  const token = issueDeviceSession({ userId: 1, deviceId: ownerDeviceId, companyId: 1, branchId: 1, secret });
  const unapprovedToken = issueDeviceSession({ userId: 1, deviceId: rejectedDeviceId, companyId: 1, branchId: 1, secret });
  const logPath = path.join(evidenceDir, "backend.log");
  const log = fs.openSync(logPath, "a");
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

  const initial = await request("GET", "/api/v3/admin/scope-management", token);
  assert.equal(initial.status, 200);
  assert.equal(initial.payload.pending_devices.length, 2);

  const unapproved = await request("GET", "/api/v3/admin/scope-management", unapprovedToken);
  assert.equal(unapproved.status, 403);

  const branchResult = await request("POST", "/api/v3/admin/branches", token, {
    operation_id: "scope-branch-create",
    branch_name: "Staging Jaipur",
    reason: "Isolated scope-management test",
  });
  assert.equal(branchResult.status, 201, JSON.stringify(branchResult.payload));
  const branchId = Number(branchResult.payload.branch.id);

  const locationResult = await request("POST", "/api/v3/admin/operational-locations", token, {
    operation_id: "scope-location-create",
    target_branch_id: branchId,
    location_code: "STAGING-MANSAROVAR",
    location_name: "Staging Mansarovar",
    location_type: "STORE",
    reason: "Isolated scope-management test",
  });
  assert.equal(locationResult.status, 201, JSON.stringify(locationResult.payload));
  const targetLocationId = Number(locationResult.payload.operational_location.id);

  const staffResult = await request("PUT", "/api/v3/admin/staff-assignments/1", token, {
    operation_id: "scope-staff-assign",
    target_branch_id: branchId,
    target_operational_location_id: targetLocationId,
    role_id: 1,
    permission_set: { operational_access: true },
    is_default: false,
    reason: "Isolated scope-management test",
  });
  assert.equal(staffResult.status, 200, JSON.stringify(staffResult.payload));

  const incomplete = await request("POST", `/api/v3/admin/devices/${pendingDeviceId}/approve`, token, {
    operation_id: "scope-device-incomplete",
    target_branch_id: branchId,
  });
  assert.equal(incomplete.status, 400);
  const stillPending = await query("SELECT status FROM authorized_devices WHERE device_id=$1", [pendingDeviceId]);
  assert.equal(stillPending.rows[0].status, "PENDING");

  const approval = await request("POST", `/api/v3/admin/devices/${pendingDeviceId}/approve`, token, {
    operation_id: "scope-device-approve",
    target_branch_id: branchId,
    target_operational_location_id: targetLocationId,
    physical_label: "Jaipur Test Counter",
    device_type: "LAPTOP",
    intended_usage: "POS",
    permitted_user_id: 1,
    role_id: 1,
    fixed_operational: true,
    permission_set: { operational_access: true, sync: true },
    reason: "Isolated scope-management test",
  });
  assert.equal(approval.status, 200, JSON.stringify(approval.payload));
  assert.equal(Number(approval.payload.assignment.operational_location_id), targetLocationId);

  const substituted = await request("POST", "/api/v3/admin/branches", token, {
    operation_id: "scope-substitution",
    company_id: 2,
    branch_name: "Rejected Branch",
  });
  assert.equal(substituted.status, 403);

  const deactivate = await request("PUT", `/api/v3/admin/operational-locations/${ownerLocationId}`, token, {
    operation_id: "scope-location-deactivate",
    target_branch_id: 1,
    active: false,
    reason: "Must be blocked",
  });
  assert.equal(deactivate.status, 409, JSON.stringify(deactivate.payload));

  const assertions = await query(`SELECT
    (SELECT COUNT(*) FROM branches WHERE branch_name='Staging Jaipur')::int AS branches,
    (SELECT COUNT(*) FROM operational_locations WHERE location_code='STAGING-MANSAROVAR')::int AS locations,
    (SELECT COUNT(*) FROM staff_location_assignments WHERE user_id=1 AND operational_location_id=$1 AND active)::int AS staff_assignments,
    (SELECT COUNT(*) FROM device_assignments WHERE device_id=$2 AND operational_location_id=$1 AND active)::int AS device_assignments,
    (SELECT COUNT(*) FROM operational_scope_audit)::int AS audits`, [targetLocationId, pendingDeviceId]);
  assert.deepEqual(assertions.rows[0], { branches: 1, locations: 1, staff_assignments: 1, device_assignments: 1, audits: 4 });

  const result = {
    secret_supplied_and_accepted: true,
    owner_location_id: ownerLocationId,
    created_branch_id: branchId,
    created_location_id: targetLocationId,
    pending_device_required_complete_assignment: true,
    approved_device_location_enforced: true,
    unapproved_device_rejected: true,
    caller_scope_substitution_rejected: true,
    deactivation_blockers_enforced: true,
    counts: assertions.rows[0],
  };
  fs.writeFileSync(path.join(evidenceDir, "integration-result.json"), JSON.stringify(result, null, 2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
};

run().finally(async () => {
  if (backend && !backend.killed) backend.kill();
  await pool.end();
}).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
