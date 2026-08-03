"use strict";

const fs = require("node:fs");
const path = require("node:path");
const express = require("../../backend/node_modules/express");
const { Pool } = require("../../backend/node_modules/pg");
const {
  createOperationalScopeService,
  requiresOperationalProtocolUpgrade,
  validateSyncBatchScope,
} = require("../../backend/operationalScope");
const { registerOperationalV3Routes } = require("../../backend/operationalV3");
const {
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
  throw new Error("Usage: STAGING_DATABASE_URL=... node isolated-protocol-v3-integration.js <output-json>");
}
const parsed = new URL(connectionString);
if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || parsed.pathname !== "/froozerp_current_staging") {
  throw new Error("Integration tests are restricted to localhost/froozerp_current_staging");
}

const pool = new Pool({ connectionString, max: 4 });
const scopeService = createOperationalScopeService(pool);
const results = [];

const record = async (name, work) => {
  const started = Date.now();
  try {
    const evidence = await work();
    results.push({ name, passed: true, duration_ms: Date.now() - started, evidence });
    return evidence;
  } catch (error) {
    results.push({
      name,
      passed: false,
      duration_ms: Date.now() - started,
      error: error.message,
      code: error.code || null,
    });
    throw error;
  }
};

const databaseCounts = async () => (await pool.query(`
  SELECT
    (SELECT COUNT(*)::int FROM products) products,
    (SELECT COUNT(*)::int FROM inventory_batches) lots,
    (SELECT COALESCE(SUM(remaining_qty),0) FROM inventory_batches) quantity,
    (SELECT COALESCE(SUM(remaining_qty * COALESCE(effective_cost_per_unit,purchase_rate,0)),0)
       FROM inventory_batches) stock_value,
    (SELECT COUNT(*)::int FROM customers) customers,
    (SELECT COUNT(*)::int FROM users) users,
    (SELECT COUNT(*)::int FROM authorized_devices) devices,
    (SELECT COUNT(*)::int FROM sync_change_log) changes
`)).rows[0];

const prepareFixtures = async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const migration of [
      "backend/migrations/cloud/009_operational_location_foundation.sql",
      "backend/migrations/cloud/010_operational_protocol_v3.sql",
    ]) {
      await client.query(
        fs.readFileSync(path.resolve(__dirname, "../..", migration), "utf8")
      );
    }
    await client.query(`
      UPDATE products SET company_id = 1;
      UPDATE suppliers SET company_id = 1;

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

      INSERT INTO operational_location_products
        (company_id, branch_id, operational_location_id, product_id, enabled, pos_available,
         selling_rate, reorder_level)
      SELECT 1, 1, ${LOCATION_ONE}, id, active, active, selling_rate, COALESCE(minimum_stock,0)
      FROM products
      ON CONFLICT (operational_location_id, product_id) DO NOTHING;

      INSERT INTO operational_location_products
        (company_id, branch_id, operational_location_id, product_id, enabled, pos_available,
         selling_rate, reorder_level)
      SELECT 1, 2, ${LOCATION_TWO}, id, active, active, selling_rate, COALESCE(minimum_stock,0)
      FROM products
      ON CONFLICT (operational_location_id, product_id) DO NOTHING;

      UPDATE authorized_devices
      SET company_id = 1, assigned_branch_id = 1
      WHERE device_id = '${MAIN_DEVICE}';
      UPDATE authorized_devices
      SET company_id = 1, assigned_branch_id = 2
      WHERE device_id = '${SECOND_DEVICE}';

      INSERT INTO staff_location_assignments
        (user_id, company_id, branch_id, operational_location_id, role_id, permission_set,
         is_default, active, assigned_by)
      SELECT 1, 1, 1, ${LOCATION_ONE}, u.role_id,
             '{"consolidated_reports":true,"manage_assignments":true}'::jsonb,
             TRUE, TRUE, 1
      FROM users u WHERE u.id = 1
      ON CONFLICT (user_id, operational_location_id) DO UPDATE SET
        company_id = EXCLUDED.company_id,
        branch_id = EXCLUDED.branch_id,
        role_id = EXCLUDED.role_id,
        permission_set = EXCLUDED.permission_set,
        active = TRUE;

      INSERT INTO staff_location_assignments
        (user_id, company_id, branch_id, operational_location_id, role_id, permission_set,
         is_default, active, assigned_by)
      SELECT 1, 1, 2, ${LOCATION_TWO}, u.role_id,
             '{"consolidated_reports":true,"manage_assignments":true}'::jsonb,
             FALSE, TRUE, 1
      FROM users u WHERE u.id = 1
      ON CONFLICT (user_id, operational_location_id) DO UPDATE SET
        company_id = EXCLUDED.company_id,
        branch_id = EXCLUDED.branch_id,
        role_id = EXCLUDED.role_id,
        permission_set = EXCLUDED.permission_set,
        active = TRUE;

      INSERT INTO device_assignments
        (device_id, company_id, branch_id, operational_location_id, physical_label, device_type,
         intended_usage, fixed_operational, permission_set, permitted_user_ids, permitted_roles,
         assignment_generation, active, approved_by)
      VALUES
        ('${MAIN_DEVICE}',1,1,${LOCATION_ONE},'Main staging device','laptop','OWNER_DASHBOARD',
         FALSE,'{"consolidated_reports":true,"manage_assignments":true}'::jsonb,'[1]'::jsonb,'["OWNER"]'::jsonb,1,TRUE,1),
        ('${SECOND_DEVICE}',1,2,${LOCATION_TWO},'Second staging device','laptop','POS',
         TRUE,'{"consolidated_reports":false,"manage_assignments":false}'::jsonb,'[1]'::jsonb,'["OWNER"]'::jsonb,1,TRUE,1)
      ON CONFLICT (device_id, assignment_generation) DO UPDATE SET
        company_id = EXCLUDED.company_id,
        branch_id = EXCLUDED.branch_id,
        operational_location_id = EXCLUDED.operational_location_id,
        fixed_operational = EXCLUDED.fixed_operational,
        permission_set = EXCLUDED.permission_set,
        permitted_user_ids = EXCLUDED.permitted_user_ids,
        permitted_roles = EXCLUDED.permitted_roles,
        active = TRUE;
    `);
    await client.query(
      fs.readFileSync(
        path.resolve(__dirname, "../../backend/migrations/cloud/011_inventory_incremental_publication.sql"),
        "utf8"
      )
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const resolveContext = async (req, { requireWrite = false } = {}) =>
  scopeService.resolve({
    userId: req.body?.user_id || req.query?.user_id || req.headers["x-user-id"],
    deviceId: req.body?.device_id || req.query?.device_id || req.headers["x-device-id"],
    submitted: {
      company_id: req.body?.company_id || req.query?.company_id,
      branch_id: req.body?.branch_id || req.query?.branch_id,
      operational_location_id: req.body?.operational_location_id || req.query?.operational_location_id,
      scope: req.body?.scope || req.query?.scope,
    },
    requireWrite,
  });

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  if (requiresOperationalProtocolUpgrade(req.path) && !req.path.startsWith("/api/v3/")) {
    return res.status(426).json({ code: "OPERATIONAL_PROTOCOL_UPGRADE_REQUIRED" });
  }
  return next();
});
registerOperationalV3Routes({
  app,
  database: pool,
  resolveContext,
  sendScopeError: (res, error) => res.status(error.status).json(error),
  serverTimePayload: () => ({ server_time: new Date().toISOString() }),
});

const api = async (origin, method, route, body, expected = 200) => {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (response.status !== expected) {
    const error = new Error(`${method} ${route}: expected ${expected}, received ${response.status}: ${payload.code || payload.message}`);
    error.code = payload.code;
    throw error;
  }
  return payload;
};

const identity = (deviceId, extra = {}) => ({
  user_id: 1,
  device_id: deviceId,
  ...extra,
});

const bootstrapFor = async (deviceId) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await lockReferenceBootstrapBoundary(client);
    const resolved = await scopeService.resolve({ userId: 1, deviceId, requireWrite: true });
    if (resolved.error) throw new Error(resolved.error.message);
    const context = {
      user: { id: 1 },
      device: { device_id: deviceId },
      companyId: resolved.context.company_id,
      branchId: resolved.context.branch_id,
      operationalLocationId: resolved.context.operational_location_id,
      assignmentGeneration: resolved.context.assignment_generation,
      deviceId,
    };
    const bootstrap = await captureReferenceBootstrap(client, context);
    await client.query("COMMIT");
    return { context, bootstrap };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const run = async () => {
  const baseline = await databaseCounts();
  await prepareFixtures();
  const mainSync = await bootstrapFor(MAIN_DEVICE);
  const secondSync = await bootstrapFor(SECOND_DEVICE);
  const server = await new Promise((resolve) => {
    const active = app.listen(0, "127.0.0.1", () => resolve(active));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    await record("two-device canonical authorization", async () => {
      const main = await scopeService.resolve({ userId: 1, deviceId: MAIN_DEVICE });
      const second = await scopeService.resolve({ userId: 1, deviceId: SECOND_DEVICE });
      if (main.context?.operational_location_id !== LOCATION_ONE) throw new Error("Main device scope mismatch");
      if (second.context?.operational_location_id !== LOCATION_TWO) throw new Error("Second device scope mismatch");
      return { main: main.context, second: second.context };
    });

    await record("frontend scope substitution rejected", async () => {
      const payload = await api(
        origin,
        "GET",
        `/api/v3/location-products?user_id=1&device_id=${SECOND_DEVICE}&branch_id=1`,
        null,
        403
      );
      if (payload.code !== "SCOPE_SUBSTITUTION_REJECTED") throw new Error("Unexpected substitution response");
      return payload.code;
    });

    const initialStock = await record("location stock isolation before receipt", async () => {
      const main = await api(origin, "GET", `/api/v3/location-products?user_id=1&device_id=${MAIN_DEVICE}`);
      const second = await api(origin, "GET", `/api/v3/location-products?user_id=1&device_id=${SECOND_DEVICE}`);
      const mainQuantity = main.products.reduce((sum, row) => sum + Number(row.available_quantity), 0);
      const secondQuantity = second.products.reduce((sum, row) => sum + Number(row.available_quantity), 0);
      if (mainQuantity !== Number(baseline.quantity) || secondQuantity !== 0) {
        throw new Error(`Stock isolation failed: ${mainQuantity}/${secondQuantity}`);
      }
      return { main_quantity: mainQuantity, second_quantity: secondQuantity };
    });

    await record("location product mutation publishes once and retry is idempotent", async () => {
      const product = await pool.query("SELECT id FROM products ORDER BY id LIMIT 1");
      const body = identity(SECOND_DEVICE, {
        idempotency_key: "staging-location-product-1",
        enabled: true,
        pos_available: true,
        selling_rate: 321.25,
        reorder_level: 7,
      });
      await api(origin, "PUT", `/api/v3/location-products/${product.rows[0].id}`, body);
      await api(origin, "PUT", `/api/v3/location-products/${product.rows[0].id}`, body);
      const published = await pool.query(
        `SELECT COUNT(*)::int AS count, MIN(operational_location_id)::int AS location_id
         FROM sync_change_log
         WHERE entity_type = 'location_product'
           AND payload->>'source_operation_id' = 'staging-location-product-1'`
      );
      if (published.rows[0].count !== 1 || published.rows[0].location_id !== LOCATION_TWO) {
        throw new Error("Location product mutation was missing, duplicated, or mis-scoped");
      }
      return published.rows[0];
    });

    const purchaseOrder = await record("purchase order CRUD and idempotency", async () => {
      const body = identity(SECOND_DEVICE, {
        idempotency_key: "staging-po-1",
        supplier_id: 1,
        order_number: "STAGING-PO-1",
        items: [{ product_id: 298, ordered_quantity: 10, expected_rate: 60, unit: "kg" }],
      });
      const first = await api(origin, "POST", "/api/v3/purchase-orders", body, 201);
      const second = await api(origin, "POST", "/api/v3/purchase-orders", body, 201);
      const count = await pool.query("SELECT COUNT(*)::int count FROM purchase_orders WHERE idempotency_key='staging-po-1'");
      if (first.purchase_order.id !== second.purchase_order.id || count.rows[0].count !== 1) {
        throw new Error("Purchase order idempotency failed");
      }
      return first.purchase_order;
    });

    const receipt = await record("GRN stock receipt and idempotency", async () => {
      const body = identity(SECOND_DEVICE, {
        idempotency_key: "staging-grn-1",
        global_id: "staging-grn-1",
        purchase_order_id: purchaseOrder.id,
        supplier_id: 1,
        grn_number: "STAGING-GRN-1",
        items: [{ product_id: 298, received_quantity: 10, cost_rate: 60, lot_global_id: "staging-lot-1" }],
      });
      const first = await api(origin, "POST", "/api/v3/goods-receipts", body, 201);
      const second = await api(origin, "POST", "/api/v3/goods-receipts", body, 201);
      const counts = await pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM goods_receipts WHERE idempotency_key='staging-grn-1') receipts,
          (SELECT COUNT(*)::int FROM inventory_batches WHERE global_id='staging-lot-1') lots,
          (SELECT COUNT(*)::int FROM sync_change_log
             WHERE entity_type='inventory_lot'
               AND entity_id='staging-lot-1'
               AND payload->>'source_operation_id'='staging-grn-1') changes
      `);
      if (first.goods_receipt.id !== second.goods_receipt.id ||
          counts.rows[0].receipts !== 1 ||
          counts.rows[0].lots !== 1 ||
          counts.rows[0].changes !== 1) {
        throw new Error("GRN idempotency failed");
      }
      return first.goods_receipt;
    });

    const transfer = await record("transfer reserve dispatch receive and retry", async () => {
      const sourceLot = await pool.query("SELECT id FROM inventory_batches WHERE global_id='staging-lot-1'");
      const created = await api(origin, "POST", "/api/v3/transfers", identity(SECOND_DEVICE, {
        idempotency_key: "staging-transfer-1",
        global_id: "staging-transfer-1",
        transfer_number: "STAGING-TR-1",
        initiation_mode: "SOURCE_INITIATED",
        destination_branch_id: 1,
        destination_operational_location_id: LOCATION_ONE,
        items: [{ product_id: 298, source_lot_id: sourceLot.rows[0].id, requested_quantity: 4 }],
      }), 201);
      const transferId = created.transfer.id;
      const item = await pool.query("SELECT id FROM inventory_transfer_items WHERE transfer_id=$1", [transferId]);
      const itemId = item.rows[0].id;
      await api(origin, "POST", `/api/v3/transfers/${transferId}/actions/submit`, identity(SECOND_DEVICE, { idempotency_key: "staging-transfer-submit" }));
      await api(origin, "POST", `/api/v3/transfers/${transferId}/actions/approve`, identity(SECOND_DEVICE, {
        idempotency_key: "staging-transfer-approve",
        items: [{ item_id: itemId, approved_quantity: 4 }],
      }));
      await api(origin, "POST", `/api/v3/transfers/${transferId}/actions/dispatch`, identity(SECOND_DEVICE, {
        idempotency_key: "staging-transfer-dispatch",
      }));
      await api(origin, "POST", `/api/v3/transfers/${transferId}/actions/receive`, identity(MAIN_DEVICE, {
        idempotency_key: "staging-transfer-receive",
        items: [{ item_id: itemId, received_quantity: 4 }],
      }));
      await api(origin, "POST", `/api/v3/transfers/${transferId}/actions/receive`, identity(MAIN_DEVICE, {
        idempotency_key: "staging-transfer-receive",
        items: [{ item_id: itemId, received_quantity: 4 }],
      }));
      const quantities = await pool.query(`
        SELECT
          (SELECT remaining_qty FROM inventory_batches WHERE global_id='staging-lot-1') source_quantity,
          (SELECT COALESCE(SUM(remaining_qty),0) FROM inventory_batches WHERE global_id LIKE 'transfer-staging-transfer-1%') destination_quantity,
          (SELECT COUNT(*)::int FROM inventory_transfer_events WHERE idempotency_key='staging-transfer-receive') receipt_events,
          (SELECT COUNT(*)::int FROM sync_change_log
             WHERE entity_type='inventory_lot'
               AND payload->>'source_operation_id'='staging-transfer-dispatch') dispatch_changes,
          (SELECT COUNT(*)::int FROM sync_change_log
             WHERE entity_type='inventory_lot'
               AND payload->>'source_operation_id'='staging-transfer-receive') receipt_changes
      `);
      if (Number(quantities.rows[0].source_quantity) !== 6 ||
          Number(quantities.rows[0].destination_quantity) !== 4 ||
          quantities.rows[0].receipt_events !== 1 ||
          quantities.rows[0].dispatch_changes !== 1 ||
          quantities.rows[0].receipt_changes !== 1) {
        throw new Error("Transfer stock or retry idempotency failed");
      }
      return { transfer_id: transferId, ...quantities.rows[0] };
    });

    await record("transfer discrepancy return-to-source reversal publishes exactly once", async () => {
      const sourceLot = await pool.query(
        "SELECT id, product_id, remaining_qty FROM inventory_batches WHERE global_id='staging-lot-1'"
      );
      const before = Number(sourceLot.rows[0].remaining_qty);
      const created = await api(origin, "POST", "/api/v3/transfers", identity(SECOND_DEVICE, {
        idempotency_key: "staging-return-transfer-1",
        global_id: "staging-return-transfer-1",
        transfer_number: "STAGING-RETURN-TR-1",
        initiation_mode: "SOURCE_INITIATED",
        destination_branch_id: 1,
        destination_operational_location_id: LOCATION_ONE,
        items: [{
          product_id: sourceLot.rows[0].product_id,
          source_lot_id: sourceLot.rows[0].id,
          requested_quantity: 1,
        }],
      }), 201);
      const transferId = created.transfer.id;
      const item = await pool.query("SELECT id FROM inventory_transfer_items WHERE transfer_id=$1", [transferId]);
      const itemId = item.rows[0].id;
      await api(origin, "POST", `/api/v3/transfers/${transferId}/actions/submit`, identity(SECOND_DEVICE, {
        idempotency_key: "staging-return-submit",
      }));
      await api(origin, "POST", `/api/v3/transfers/${transferId}/actions/approve`, identity(SECOND_DEVICE, {
        idempotency_key: "staging-return-approve",
        items: [{ item_id: itemId, approved_quantity: 1 }],
      }));
      await api(origin, "POST", `/api/v3/transfers/${transferId}/actions/dispatch`, identity(SECOND_DEVICE, {
        idempotency_key: "staging-return-dispatch",
      }));
      await api(origin, "POST", `/api/v3/transfers/${transferId}/actions/discrepancy`, identity(MAIN_DEVICE, {
        idempotency_key: "staging-return-discrepancy",
      }));
      await api(origin, "POST", `/api/v3/transfers/${transferId}/actions/return`, identity(SECOND_DEVICE, {
        idempotency_key: "staging-return-in-transit",
      }));
      const receiptBody = identity(SECOND_DEVICE, {
        idempotency_key: "staging-return-source-receive",
        items: [{ item_id: itemId, returned_quantity: 1 }],
      });
      await api(origin, "POST", `/api/v3/transfers/${transferId}/actions/source_receive`, receiptBody);
      await api(origin, "POST", `/api/v3/transfers/${transferId}/actions/source_receive`, receiptBody);
      const evidence = await pool.query(
        `SELECT
           (SELECT remaining_qty FROM inventory_batches WHERE id=$1) final_quantity,
           (SELECT COUNT(*)::int FROM sync_change_log
             WHERE payload->>'source_operation_id'='staging-return-dispatch') dispatch_changes,
           (SELECT COUNT(*)::int FROM sync_change_log
             WHERE payload->>'source_operation_id'='staging-return-source-receive') reversal_changes`,
        [sourceLot.rows[0].id]
      );
      if (Number(evidence.rows[0].final_quantity) !== before ||
          evidence.rows[0].dispatch_changes !== 1 ||
          evidence.rows[0].reversal_changes !== 1) {
        throw new Error("Transfer reversal did not restore stock exactly once");
      }
      return evidence.rows[0];
    });

    await record("stock-affecting row mutation publication matrix is transactional", async () => {
      const lot = await pool.query(
        "SELECT id, global_id FROM inventory_batches WHERE global_id LIKE 'transfer-staging-transfer-1%' LIMIT 1"
      );
      const scenarios = [
        ["stock-adjustment", 2],
        ["sale-deduction", -1],
        ["sales-return", 1],
        ["waste-damage", -0.5],
        ["cancellation-reversal", 0.5],
      ];
      for (const [operationId, delta] of scenarios) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            `SELECT SET_CONFIG('froozerp.device_id',$1,TRUE),
                    SET_CONFIG('froozerp.user_id','1',TRUE),
                    SET_CONFIG('froozerp.operation_id',$2,TRUE)`,
            [MAIN_DEVICE, `staging-${operationId}`]
          );
          await client.query(
            "UPDATE inventory_batches SET remaining_qty = remaining_qty + $1 WHERE id = $2",
            [delta, lot.rows[0].id]
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      }
      const published = await pool.query(
        `SELECT payload->>'source_operation_id' AS operation_id, COUNT(*)::int AS count
         FROM sync_change_log
         WHERE entity_type='inventory_lot'
           AND payload->>'source_operation_id' LIKE 'staging-%'
           AND payload->>'source_operation_id' IN (
             'staging-stock-adjustment','staging-sale-deduction','staging-sales-return',
             'staging-waste-damage','staging-cancellation-reversal'
           )
         GROUP BY payload->>'source_operation_id'
         ORDER BY operation_id`
      );
      if (published.rows.length !== scenarios.length || published.rows.some((row) => row.count !== 1)) {
        throw new Error("One or more stock mutation scenarios did not publish exactly once");
      }
      return published.rows;
    });

    await record("offline replay mutation is idempotent", async () => {
      const operationId = "staging-offline-stock-1";
      const lot = await pool.query("SELECT id, global_id FROM inventory_batches WHERE global_id='staging-lot-1'");
      const replay = async () => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const existing = await client.query(
            "SELECT operation_id FROM sync_processed_operations WHERE operation_id=$1",
            [operationId]
          );
          if (existing.rows[0]) {
            await client.query("COMMIT");
            return "duplicate";
          }
          await client.query(
            `SELECT SET_CONFIG('froozerp.device_id',$1,TRUE),
                    SET_CONFIG('froozerp.user_id','1',TRUE),
                    SET_CONFIG('froozerp.operation_id',$2,TRUE)`,
            [SECOND_DEVICE, operationId]
          );
          await client.query(
            "UPDATE inventory_batches SET remaining_qty=remaining_qty-0.25 WHERE id=$1",
            [lot.rows[0].id]
          );
          await client.query(
            `INSERT INTO sync_processed_operations
               (operation_id,device_id,company_id,branch_id,operational_location_id,
                entity_type,entity_id,result_status,result_payload)
             VALUES ($1,$2,1,2,$3,'inventory_lot',$4,'processed','{}'::jsonb)`,
            [operationId, SECOND_DEVICE, LOCATION_TWO, lot.rows[0].global_id]
          );
          await client.query("COMMIT");
          return "processed";
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      };
      const first = await replay();
      const second = await replay();
      const evidence = await pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM sync_processed_operations WHERE operation_id=$1) processed,
           (SELECT COUNT(*)::int FROM sync_change_log
             WHERE entity_type='inventory_lot' AND payload->>'source_operation_id'=$1) changes`,
        [operationId]
      );
      if (first !== "processed" || second !== "duplicate" ||
          evidence.rows[0].processed !== 1 || evidence.rows[0].changes !== 1) {
        throw new Error("Offline replay was not idempotent");
      }
      return { first, second, ...evidence.rows[0] };
    });

    await record("payment allocation and over-allocation guard", async () => {
      const sale = await pool.query(`
        INSERT INTO sales
          (total_amount,total_cost,profit,branch_id,created_by,company_id,operational_location_id,global_id)
        VALUES (100,60,40,2,1,1,${LOCATION_TWO},'staging-sale-1') RETURNING id
      `);
      const payment = await pool.query(`
        INSERT INTO customer_payments
          (customer_id,payment_amount,payment_mode,branch_id,created_by,company_id,operational_location_id)
        VALUES (1,100,'CASH',2,1,1,${LOCATION_TWO}) RETURNING id
      `);
      const body = identity(SECOND_DEVICE, {
        idempotency_key: "staging-allocation-1",
        payment_entity_type: "CUSTOMER_PAYMENT",
        payment_entity_id: payment.rows[0].id,
        target_entity_type: "SALE",
        target_entity_id: sale.rows[0].id,
        target_branch_id: 2,
        target_operational_location_id: LOCATION_TWO,
        allocated_amount: 40,
      });
      const first = await api(origin, "POST", "/api/v3/payment-allocations", body, 201);
      const repeated = await api(origin, "POST", "/api/v3/payment-allocations", body, 200);
      if (first.payment_allocation.id !== repeated.payment_allocation.id) throw new Error("Allocation retry was not idempotent");
      const rejected = await api(origin, "POST", "/api/v3/payment-allocations", {
        ...body,
        idempotency_key: "staging-allocation-over",
        allocated_amount: 70,
      }, 409);
      if (rejected.code !== "PAYMENT_OVER_ALLOCATION") throw new Error("Over-allocation was not rejected");
      return { allocation_id: first.payment_allocation.id, rejection: rejected.code };
    });

    await record("owner consolidated report and assignment previews", async () => {
      const report = await api(origin, "GET", `/api/v3/reports/consolidated?user_id=1&device_id=${MAIN_DEVICE}`);
      if (report.locations.length !== 2 || report.scope.type !== "ALL_LOCATIONS") {
        throw new Error("Consolidated report scope failed");
      }
      const staff = await api(origin, "POST", "/api/v3/admin/staff-assignments/preview", identity(MAIN_DEVICE, {
        target_user_id: 1,
        target_branch_id: 2,
        target_operational_location_id: LOCATION_TWO,
      }));
      const device = await api(origin, "POST", "/api/v3/admin/device-assignments/preview", identity(MAIN_DEVICE, {
        target_device_id: SECOND_DEVICE,
        target_branch_id: 2,
        target_operational_location_id: LOCATION_TWO,
      }));
      if (staff.preview.would_write !== false || device.preview.would_write !== false) {
        throw new Error("Assignment preview attempted a write");
      }
      return { report_scope: report.scope, device_preview: device.preview };
    });

    await record("old client write and mixed-location batch blocked", async () => {
      const legacy = await api(origin, "POST", "/purchases", {}, 426);
      const mixed = validateSyncBatchScope([
        { operation_id: "one", company_id: 1, branch_id: 1, operational_location_id: LOCATION_ONE },
        { operation_id: "two", company_id: 1, branch_id: 2, operational_location_id: LOCATION_TWO },
      ], { company_id: 1, branch_id: 1, operational_location_id: LOCATION_ONE });
      if (legacy.code !== "OPERATIONAL_PROTOCOL_UPGRADE_REQUIRED" || mixed?.code !== "MIXED_LOCATION_BATCH") {
        throw new Error("Legacy or mixed-location write was not blocked");
      }
      return { legacy: legacy.code, mixed_batch: mixed.code };
    });

    await record("customer master remains read-only", async () => {
      const after = await pool.query("SELECT COUNT(*)::int count FROM customers");
      if (after.rows[0].count !== Number(baseline.customers)) throw new Error("Customer count changed");
      return { before: Number(baseline.customers), after: after.rows[0].count };
    });

    const finalCounts = await databaseCounts();
    const mainIncremental = await readVisibleIncrementalChanges(
      pool,
      mainSync.context,
      Number(mainSync.bootstrap.high_watermark),
      500
    );
    const secondIncremental = await readVisibleIncrementalChanges(
      pool,
      secondSync.context,
      Number(secondSync.bootstrap.high_watermark),
      500
    );
    const report = {
      generated_at: new Date().toISOString(),
      mode: "ISOLATED_STAGING_ONLY",
      source_database: "froozerp_current_staging",
      devices: { main: MAIN_DEVICE, second: SECOND_DEVICE },
      baseline,
      final_counts_before_restore_rollback: finalCounts,
      initial_stock: initialStock,
      sync_evidence: {
        main: {
          bootstrap: mainSync.bootstrap,
          incremental_changes: mainIncremental.rows,
          has_more: mainIncremental.hasMore,
        },
        second: {
          bootstrap: secondSync.bootstrap,
          incremental_changes: secondIncremental.rows,
          has_more: secondIncremental.hasMore,
        },
      },
      results,
      passed: results.every((item) => item.passed),
    };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.passed, tests: results.length, baseline, finalCounts }));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
};

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
