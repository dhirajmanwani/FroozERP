"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("../../backend/node_modules/pg");
const { createOperationalScopeService } = require("../../backend/operationalScope");
const {
  issueDeviceSession,
  rejectDeviceSessionSubstitution,
  verifyDeviceSession,
} = require("../../backend/deviceSession");
const {
  REFERENCE_BOOTSTRAP_PROTOCOL,
  captureReferenceBootstrap,
  lockReferenceBootstrapBoundary,
  readVisibleIncrementalChanges,
} = require("../../backend/syncReferenceBootstrap");

const connectionString = process.env.STAGING_DATABASE_URL;
const outputPath = path.resolve(process.argv[2] || "");
const MAIN_DEVICE = "FZDEV-DELL-1781852580596";
const SECOND_DEVICE = "FZDEV-B138C714-C159-40BB-BDBF-5588ECC04756";
const LOCATION_ONE = 1001;
const LOCATION_TWO = 1002;

if (!connectionString || !outputPath) {
  throw new Error("Usage: STAGING_DATABASE_URL=... node isolated-reference-bootstrap-integration.js <output-json>");
}
const parsed = new URL(connectionString);
if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || parsed.pathname !== "/froozerp_bootstrap_staging") {
  throw new Error("Bootstrap integration is restricted to localhost/froozerp_bootstrap_staging");
}

const pool = new Pool({ connectionString, max: 6 });
const scopeService = createOperationalScopeService(pool);
const results = [];

const record = async (name, work) => {
  const started = Date.now();
  try {
    const evidence = await work();
    results.push({ name, passed: true, duration_ms: Date.now() - started, evidence });
    return evidence;
  } catch (error) {
    results.push({ name, passed: false, duration_ms: Date.now() - started, error: error.message, code: error.code || null });
    throw error;
  }
};

const counts = async () => (await pool.query(`
  SELECT
    (SELECT COUNT(*)::INTEGER FROM products) AS products,
    (SELECT COUNT(*)::INTEGER FROM inventory_batches) AS lots,
    (SELECT ROUND(COALESCE(SUM(remaining_qty), 0), 3) FROM inventory_batches) AS quantity,
    (SELECT ROUND(COALESCE(SUM(remaining_qty * COALESCE(effective_cost_per_unit, purchase_rate, 0)), 0), 2)
       FROM inventory_batches) AS stock_value,
    (SELECT COUNT(*)::INTEGER FROM customers) AS customers,
    (SELECT COUNT(*)::INTEGER FROM users) AS users,
    (SELECT COUNT(*)::INTEGER FROM authorized_devices) AS devices,
    (SELECT COUNT(*)::INTEGER FROM sync_change_log) AS changes
`)).rows[0];

const customerFingerprint = async () => (await pool.query(`
  SELECT COUNT(*)::INTEGER AS count,
         MD5(COALESCE(STRING_AGG((TO_JSONB(c) - 'company_id')::TEXT, '|' ORDER BY c.id), '')) AS digest
  FROM customers c
`)).rows[0];

const applyFoundationAndFixtures = async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const migration of [
      "backend/migrations/cloud/009_operational_location_foundation.sql",
      "backend/migrations/cloud/010_operational_protocol_v3.sql",
    ]) {
      await client.query(fs.readFileSync(path.resolve(__dirname, "../..", migration), "utf8"));
    }
    await client.query(`
      UPDATE product_categories SET company_id = 1;
      UPDATE products SET company_id = 1;

      INSERT INTO branches (id, branch_name, location, active, company_id)
      VALUES (2, 'Isolated Jaipur', 'Test-only staging', TRUE, 1)
      ON CONFLICT (id) DO UPDATE SET company_id = 1, active = TRUE;

      INSERT INTO operational_locations
        (id, company_id, branch_id, location_code, location_name, location_type, active, is_default)
      VALUES
        (${LOCATION_ONE}, 1, 1, 'BADWASIYA-STAGING', 'Badwasiya Fruit Market', 'MARKET', TRUE, TRUE),
        (${LOCATION_TWO}, 1, 2, 'MANSAROVAR-STAGING', 'Mansarovar Isolated Test', 'STORE', TRUE, TRUE)
      ON CONFLICT (id) DO NOTHING;

      UPDATE inventory_batches
      SET company_id = 1, branch_id = 1, operational_location_id = ${LOCATION_ONE};
      WITH selected AS (SELECT MIN(id) AS id FROM inventory_batches WHERE remaining_qty > 0)
      UPDATE inventory_batches
      SET branch_id = 2, operational_location_id = ${LOCATION_TWO}
      WHERE id = (SELECT id FROM selected);

      INSERT INTO operational_location_products
        (company_id, branch_id, operational_location_id, product_id, enabled, pos_available, selling_rate, reorder_level)
      SELECT 1, 1, ${LOCATION_ONE}, id, active, active, selling_rate, COALESCE(minimum_stock, 0)
      FROM products
      ON CONFLICT (operational_location_id, product_id) DO NOTHING;
      INSERT INTO operational_location_products
        (company_id, branch_id, operational_location_id, product_id, enabled, pos_available, selling_rate, reorder_level)
      SELECT 1, 2, ${LOCATION_TWO}, id, active, active, selling_rate, COALESCE(minimum_stock, 0)
      FROM products
      ON CONFLICT (operational_location_id, product_id) DO NOTHING;

      UPDATE authorized_devices SET company_id = 1, assigned_branch_id = 1 WHERE device_id = '${MAIN_DEVICE}';
      UPDATE authorized_devices SET company_id = 1, assigned_branch_id = 2 WHERE device_id = '${SECOND_DEVICE}';

      INSERT INTO staff_location_assignments
        (user_id, company_id, branch_id, operational_location_id, role_id, permission_set, is_default, active, assigned_by)
      SELECT 1, 1, 1, ${LOCATION_ONE}, role_id, '{}'::JSONB, TRUE, TRUE, 1 FROM users WHERE id = 1
      ON CONFLICT (user_id, operational_location_id) DO NOTHING;
      INSERT INTO staff_location_assignments
        (user_id, company_id, branch_id, operational_location_id, role_id, permission_set, is_default, active, assigned_by)
      SELECT 1, 1, 2, ${LOCATION_TWO}, role_id, '{}'::JSONB, FALSE, TRUE, 1 FROM users WHERE id = 1
      ON CONFLICT (user_id, operational_location_id) DO NOTHING;

      INSERT INTO device_assignments
        (device_id, company_id, branch_id, operational_location_id, physical_label, device_type,
         intended_usage, fixed_operational, permission_set, permitted_user_ids, permitted_roles,
         assignment_generation, active, approved_by)
      VALUES
        ('${MAIN_DEVICE}', 1, 1, ${LOCATION_ONE}, 'Main staging device', 'laptop', 'OWNER_DASHBOARD',
         FALSE, '{}'::JSONB, '[1]'::JSONB, '[\"OWNER\"]'::JSONB, 1, TRUE, 1),
        ('${SECOND_DEVICE}', 1, 2, ${LOCATION_TWO}, 'Second staging device', 'laptop', 'POS',
         TRUE, '{}'::JSONB, '[1]'::JSONB, '[\"OWNER\"]'::JSONB, 1, TRUE, 1)
      ON CONFLICT (device_id, assignment_generation) DO NOTHING;

      DELETE FROM sync_change_log
      WHERE entity_type IN ('product_category', 'product', 'sale_rate', 'inventory_lot');
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const resolve = async (deviceId, submitted = {}) => {
  const result = await scopeService.resolve({
    userId: 1,
    deviceId,
    submitted,
    requireWrite: true,
  });
  if (result.error) {
    const error = new Error(result.error.message);
    error.code = result.error.code;
    error.status = result.error.status;
    throw error;
  }
  return {
    user: { id: 1 },
    device: { device_id: deviceId },
    companyId: result.context.company_id,
    branchId: result.context.branch_id,
    operationalLocationId: result.context.operational_location_id,
    assignmentGeneration: result.context.assignment_generation,
    deviceId,
  };
};

const snapshotFor = async (deviceId) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await lockReferenceBootstrapBoundary(client);
    const context = await resolve(deviceId);
    const snapshot = await captureReferenceBootstrap(client, context);
    await client.query("COMMIT");
    return snapshot;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const run = async () => {
  const baseline = await counts();
  const customersBefore = await customerFingerprint();
  await applyFoundationAndFixtures();
  const prepared = await counts();

  const snapshots = await record("fresh cursor-zero devices receive only canonical reference scope", async () => {
    const main = await snapshotFor(MAIN_DEVICE);
    const second = await snapshotFor(SECOND_DEVICE);
    const summarize = (snapshot) => ({
      protocol: snapshot.protocol,
      high_watermark: snapshot.high_watermark,
      products: snapshot.records.filter((row) => row.entity_type === "product").length,
      lots: snapshot.records.filter((row) => row.entity_type === "inventory_lot").length,
      quantity: snapshot.records
        .filter((row) => row.entity_type === "inventory_lot")
        .reduce((sum, row) => sum + Number(row.payload.remaining_qty || 0), 0),
      location: snapshot.operational_location_id,
    });
    const mainSummary = summarize(main);
    const secondSummary = summarize(second);
    if (main.protocol !== REFERENCE_BOOTSTRAP_PROTOCOL || second.protocol !== REFERENCE_BOOTSTRAP_PROTOCOL) {
      throw new Error("Bootstrap protocol mismatch");
    }
    if (mainSummary.products !== Number(baseline.products) || secondSummary.products !== Number(baseline.products)) {
      throw new Error("Company product visibility mismatch");
    }
    if (mainSummary.lots + secondSummary.lots !== Number(baseline.lots) || secondSummary.lots !== 1) {
      throw new Error(`Location lot isolation mismatch: ${mainSummary.lots}/${secondSummary.lots}`);
    }
    return { main: mainSummary, second: secondSummary };
  });

  await record("canonical second device identity and scope substitution enforcement", async () => {
    const second = await resolve(SECOND_DEVICE);
    if (second.operationalLocationId !== LOCATION_TWO) throw new Error("Second device canonical location mismatch");
    let substitution;
    try {
      await resolve(SECOND_DEVICE, { company_id: 1, branch_id: 1, operational_location_id: LOCATION_ONE });
    } catch (error) {
      substitution = error;
    }
    if (substitution?.code !== "SCOPE_SUBSTITUTION_REJECTED") {
      throw new Error("Cross-location substitution was not rejected");
    }
    let unknown;
    try {
      await resolve("FZDEV-UNAPPROVED-ISOLATED");
    } catch (error) {
      unknown = error;
    }
    if (unknown?.code !== "DEVICE_LOCATION_MISMATCH") {
      throw new Error("Unknown/unapproved device was not rejected");
    }
    const secret = "isolated-bootstrap-device-session";
    const token = issueDeviceSession({
      userId: 1,
      deviceId: SECOND_DEVICE,
      companyId: 1,
      branchId: 2,
      secret,
    });
    const claims = verifyDeviceSession(token, secret).claims;
    const deviceSubstitution = rejectDeviceSessionSubstitution(claims, { device_id: MAIN_DEVICE });
    if (deviceSubstitution?.code !== "DEVICE_SESSION_SUBSTITUTION_REJECTED") {
      throw new Error("Signed canonical device substitution was not rejected");
    }
    return {
      device_id: SECOND_DEVICE,
      location: second.operationalLocationId,
      substitution: substitution.code,
      signed_device_substitution: deviceSubstitution.code,
      unknown: unknown.code,
    };
  });

  await record("bootstrap retry is idempotent and manufactures no history", async () => {
    const before = await counts();
    const first = await snapshotFor(SECOND_DEVICE);
    const second = await snapshotFor(SECOND_DEVICE);
    const after = await counts();
    if (JSON.stringify(first.records) !== JSON.stringify(second.records)) throw new Error("Bootstrap retry changed reference records");
    if (Number(before.changes) !== Number(after.changes)) throw new Error("Bootstrap manufactured sync history");
    return { records: first.records.length, changes_before: before.changes, changes_after: after.changes };
  });

  await record("snapshot high-watermark admits a concurrent change exactly once", async () => {
    const snapshotClient = await pool.connect();
    const writer = await pool.connect();
    try {
      await snapshotClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await lockReferenceBootstrapBoundary(snapshotClient);
      const context = await resolve(SECOND_DEVICE);
      const snapshot = await captureReferenceBootstrap(snapshotClient, context);
      let writerCompleted = false;
      const write = writer.query(
        `INSERT INTO sync_change_log
          (company_id, branch_id, operational_location_id, assignment_generation,
           entity_type, entity_id, operation_type, entity_version, payload)
         VALUES (1, 1, NULL, NULL, 'product', 'concurrent-company-reference', 'UPSERT', 1,
                 '{\"company_id\":1,\"product_name\":\"Concurrent Reference\"}'::JSONB)
         RETURNING change_id`
      ).then((result) => {
        writerCompleted = true;
        return result.rows[0];
      });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
      if (writerCompleted) throw new Error("Concurrent writer crossed the snapshot boundary before commit");
      await snapshotClient.query("COMMIT");
      const written = await write;
      const incremental = await readVisibleIncrementalChanges(
        pool,
        context,
        Number(snapshot.high_watermark),
        50
      );
      const matches = incremental.rows.filter((row) => row.entity_id === "concurrent-company-reference");
      if (Number(written.change_id) <= Number(snapshot.high_watermark) || matches.length !== 1) {
        throw new Error("Concurrent reference was lost or duplicated at snapshot handoff");
      }
      return { high_watermark: snapshot.high_watermark, concurrent_change_id: String(written.change_id), delivered: matches.length };
    } catch (error) {
      await snapshotClient.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      snapshotClient.release();
      writer.release();
    }
  });

  await record("customer state remains unchanged", async () => {
    const after = await customerFingerprint();
    if (after.count !== customersBefore.count || after.digest !== customersBefore.digest) {
      throw new Error("Customer state changed during isolated bootstrap verification");
    }
    return { before: customersBefore, after };
  });

  const finalCounts = await counts();
  const report = {
    generated_at: new Date().toISOString(),
    mode: "ISOLATED_LOCALHOST_STAGING_ONLY",
    source_database: "froozerp_bootstrap_staging",
    devices: { main: MAIN_DEVICE, second: SECOND_DEVICE },
    baseline,
    prepared,
    final_counts_before_restore_rollback: finalCounts,
    snapshots,
    results,
    passed: results.every((item) => item.passed),
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, tests: results.length, baseline, prepared, finalCounts }));
  await pool.end();
};

run().catch(async (error) => {
  console.error(error.stack || error.message);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
