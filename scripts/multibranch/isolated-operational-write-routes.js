"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Pool } = require("../../backend/node_modules/pg");
const { issueDeviceSession } = require("../../backend/deviceSession");

const connectionString = String(process.env.STAGING_DATABASE_URL || "");
const outputPath = path.resolve(process.argv[2] || "");
const parsed = connectionString ? new URL(connectionString) : null;
if (
  !parsed ||
  !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
  parsed.pathname !== "/froozerp_current_staging" ||
  !outputPath
) {
  throw new Error("This runner is restricted to localhost/froozerp_current_staging");
}

const MAIN_DEVICE = "FZDEV-DELL-1781852580596";
const OTHER_DEVICE = "FZDEV-B138C714-C159-40BB-BDBF-5588ECC04756";
const LOCATION_ONE = 1001;
const LOCATION_TWO = 1002;
const port = 55552;
const origin = `http://127.0.0.1:${port}`;
const secret = crypto.randomBytes(64).toString("base64url");
const pool = new Pool({ connectionString, max: 4 });
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

const tokenFor = (deviceId, branchId, options = {}) =>
  issueDeviceSession({
    userId: 1,
    deviceId,
    companyId: 1,
    branchId,
    sessionRevocationVersion: 0,
    nowMs: options.nowMs,
    ttlSeconds: options.ttlSeconds,
    secret,
  });

const api = async ({
  method = "GET",
  route,
  body,
  token = tokenFor(MAIN_DEVICE, 1),
  expected = 200,
  headers = {},
}) => {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-froozerp-device-session": token,
      ...headers,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (response.status !== expected) {
    const error = new Error(
      `${method} ${route}: expected ${expected}, got ${response.status} (${payload.code || payload.message})`
    );
    error.code = payload.code;
    throw error;
  }
  return payload;
};

const abortAfterRequestWrite = ({ method, route, body, token = tokenFor(MAIN_DEVICE, 1) }) =>
  new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: route,
        method,
        headers: {
          "content-type": "application/json",
          "x-froozerp-device-session": token,
        },
      },
      (response) => {
        response.resume();
        response.once("end", resolve);
      }
    );
    request.once("error", (error) => {
      if (error.code === "ECONNRESET") resolve();
      else reject(error);
    });
    request.end(JSON.stringify(body), () => {
      request.destroy();
      resolve();
    });
  });

const op = (id, body = {}) => ({
  ...body,
  idempotency_key: id,
  operation_id: id,
});

const operationEvidence = async (operationId) => {
  const result = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM sync_processed_operations WHERE operation_id=$1) processed,
       (SELECT COUNT(*)::int FROM sync_change_log
         WHERE payload->>'source_operation_id'=$1) changes,
       (SELECT MIN(operational_location_id)::int FROM sync_change_log
         WHERE payload->>'source_operation_id'=$1) location_id`,
    [operationId]
  );
  return result.rows[0];
};

const requireExactlyOnce = async (operationId, expectedChanges = 1, locationId = LOCATION_ONE) => {
  const evidence = await operationEvidence(operationId);
  if (
    evidence.processed !== 1 ||
    evidence.changes !== expectedChanges ||
    (expectedChanges > 0 && evidence.location_id !== locationId)
  ) {
    throw new Error(`Operation ${operationId} was not processed/published exactly once`);
  }
  return evidence;
};

const waitForHealth = async () => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Isolated backend did not become healthy");
};

const preparePurchaseFixture = async ({ productId, lotId }) => {
  await pool.query(
    "UPDATE suppliers SET active=TRUE WHERE id=(SELECT id FROM suppliers ORDER BY id LIMIT 1)"
  );
  const supplier = await pool.query("SELECT id, supplier_name FROM suppliers WHERE active=TRUE ORDER BY id LIMIT 1");
  if (!supplier.rows[0]) throw new Error("Supplier fixture is missing");
  const purchase = await pool.query(
    `INSERT INTO purchases (
       supplier_id,supplier_name,total_amount,branch_id,purchase_date,purchase_bill_status,
       purchase_status,temporary_sale_rate,expected_purchase_rate,company_id,operational_location_id
     ) VALUES ($1,$2,0,1,CURRENT_DATE,'BILL_PENDING','ACTIVE',100,50,1,$3)
     RETURNING id`,
    [supplier.rows[0].id, supplier.rows[0].supplier_name, LOCATION_ONE]
  );
  await pool.query(
    `INSERT INTO purchase_items (purchase_id,product_id,quantity,purchase_rate,amount)
     VALUES ($1,$2,10,50,500)`,
    [purchase.rows[0].id, productId]
  );
  await pool.query(
     `UPDATE inventory_batches
     SET purchase_id=$1,purchase_qty=10,remaining_qty=10,purchase_bill_status='BILL_PENDING',
         temporary_sale_rate=100,stock_source='PURCHASE'
     WHERE id=$2`,
    [purchase.rows[0].id, lotId]
  );
  return { purchaseId: purchase.rows[0].id, supplierId: supplier.rows[0].id };
};

const run = async () => {
  const baselineCustomers = await pool.query(
    "SELECT COUNT(*)::int count, md5(COALESCE(string_agg(row_to_json(c)::text,'|' ORDER BY c.id),'')) digest FROM customers c"
  );
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, "../../backend"),
    env: {
      ...process.env,
      PORT: String(port),
      FROOZERP_RUNTIME_MODE: "cloud-server",
      NODE_ENV: "test",
      FROOZERP_ALLOW_LOOPBACK_POSTGRES_FOR_ISOLATED_TESTS: "true",
      FROOZERP_DEPLOYMENT_TYPE: "cloud",
      APP_MODE: "CLOUD_PRODUCTION",
      DATABASE_URL: connectionString,
      DB_SSL: "false",
      RUN_STARTUP_SCHEMA_BOOTSTRAP: "false",
      FROOZERP_OPERATIONAL_SCOPE_MODE: "enforce",
      DEVICE_SESSION_SECRET: secret,
      BACKUP_DIR: path.resolve(path.dirname(outputPath), "backups"),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const log = [];
  child.stdout.on("data", (chunk) => log.push(chunk.toString()));
  child.stderr.on("data", (chunk) => log.push(chunk.toString()));

  try {
    await waitForHealth();
    await record("signed session and substitution enforcement", async () => {
      const context = await api({ route: "/api/v3/operational-context" });
      const substituted = await api({
        method: "POST",
        route: "/api/v3/waste-entries",
        body: op("substitution-rejected", {
          company_id: 1,
          branch_id: 2,
          operational_location_id: LOCATION_TWO,
        }),
        expected: 403,
      });
      if (context.context.operational_location_id !== LOCATION_ONE ||
          substituted.code !== "DEVICE_SESSION_SUBSTITUTION_REJECTED") {
        throw new Error("Canonical scope or substitution enforcement failed");
      }
      return { location_id: context.context.operational_location_id, rejection: substituted.code };
    });

    await record("session expiry, signature, device, and approval rejection", async () => {
      const expired = tokenFor(MAIN_DEVICE, 1, { nowMs: 1_000_000, ttlSeconds: 1 });
      const expiredResult = await api({ route: "/api/v3/operational-context", token: expired, expected: 401 });
      const valid = tokenFor(MAIN_DEVICE, 1);
      const altered = `${valid.slice(0, -1)}${valid.endsWith("A") ? "B" : "A"}`;
      const alteredResult = await api({ route: "/api/v3/operational-context", token: altered, expected: 401 });
      const substituted = await api({
        route: `/api/v3/operational-context?device_id=${encodeURIComponent(OTHER_DEVICE)}`,
        token: valid,
        expected: 403,
      });
      await pool.query("UPDATE authorized_devices SET status='PENDING' WHERE device_id=$1", [OTHER_DEVICE]);
      const unapproved = await api({
        route: "/api/v3/operational-context",
        token: tokenFor(OTHER_DEVICE, 2),
        expected: 403,
      });
      await pool.query("UPDATE authorized_devices SET status='APPROVED' WHERE device_id=$1", [OTHER_DEVICE]);
      return {
        expired: expiredResult.code,
        altered: alteredResult.code,
        substituted: substituted.code,
        unapproved: unapproved.code,
      };
    });

    const created = await record("product create and retry", async () => {
      const body = op("v3-product-create", {
        product_name: "V3 Isolated Product",
        selling_rate: 100,
        unit: "kg",
        origin_type: "LOCAL",
        category: "Fruit",
        minimum_stock: 1,
        active: true,
      });
      const first = await api({ method: "POST", route: "/api/v3/products", body, expected: 201 });
      const retry = await api({ method: "POST", route: "/api/v3/products", body, expected: 201 });
      const count = await pool.query("SELECT COUNT(*)::int count FROM products WHERE global_id=$1", [first.product.global_id]);
      if (retry.product.id !== first.product.id || count.rows[0].count !== 1) throw new Error("Product retry duplicated");
      // The first product in a restored fixture also creates the missing category.
      await requireExactlyOnce("v3-product-create", 2, null);
      return first.product;
    });

    await record("product update and retry", async () => {
      const body = op("v3-product-update", {
        product_name: "V3 Isolated Product Updated",
        selling_rate: 100,
        unit: "kg",
        origin_type: "LOCAL",
        category_id: created.category_id,
        category: "Fruit",
        minimum_stock: 2,
        active: true,
      });
      await api({ method: "PUT", route: `/api/v3/products/${created.id}`, body });
      const retry = await api({ method: "PUT", route: `/api/v3/products/${created.id}`, body });
      if (!retry.idempotent_replay) throw new Error("Product update retry was not recognized");
      return requireExactlyOnce("v3-product-update", 1, null);
    });

    await record("supported product deactivation and retry", async () => {
      const createBody = op("v3-product-deactivate-create", {
        product_name: "V3 Disposable Product",
        selling_rate: 75,
        unit: "kg",
        origin_type: "LOCAL",
        category_id: created.category_id,
        category: "Fruit",
        minimum_stock: 0,
        active: true,
      });
      const disposable = await api({
        method: "POST",
        route: "/api/v3/products",
        body: createBody,
        expected: 201,
      });
      const body = op("v3-product-deactivate", { reason: "isolated deactivation" });
      const first = await api({
        method: "POST",
        route: `/api/v3/products/${disposable.product.id}/deactivate`,
        body,
      });
      const retry = await api({
        method: "POST",
        route: `/api/v3/products/${disposable.product.id}/deactivate`,
        body,
      });
      if (first.product.active !== false || retry.product.id !== first.product.id) {
        throw new Error("Product deactivation retry mismatch");
      }
      return requireExactlyOnce("v3-product-deactivate", 1, null);
    });

    const category = await record("product category create, update, deactivate, and retries", async () => {
      const createBody = op("v3-category-create", {
        category_name: "V3 Isolated Category",
        reason: "isolated category create",
      });
      const createdCategory = await api({
        method: "POST",
        route: "/api/v3/product-categories",
        body: createBody,
        expected: 201,
      });
      const createRetry = await api({
        method: "POST",
        route: "/api/v3/product-categories",
        body: createBody,
        expected: 201,
      });
      if (createdCategory.id !== createRetry.id) throw new Error("Category create retry duplicated");
      await requireExactlyOnce("v3-category-create", 1, null);

      const updateBody = op("v3-category-update", {
        category_name: "V3 Isolated Category Updated",
        active: true,
        reason: "isolated category update",
      });
      const updatedCategory = await api({
        method: "PUT",
        route: `/api/v3/product-categories/${createdCategory.id}`,
        body: updateBody,
      });
      const updateRetry = await api({
        method: "PUT",
        route: `/api/v3/product-categories/${createdCategory.id}`,
        body: updateBody,
      });
      if (updatedCategory.id !== updateRetry.id) throw new Error("Category update retry duplicated");
      await requireExactlyOnce("v3-category-update", 1, null);

      const deactivateBody = op("v3-category-deactivate", {
        reason: "isolated category deactivation",
      });
      const deactivated = await api({
        method: "DELETE",
        route: `/api/v3/product-categories/${createdCategory.id}`,
        body: deactivateBody,
      });
      const deactivateRetry = await api({
        method: "DELETE",
        route: `/api/v3/product-categories/${createdCategory.id}`,
        body: deactivateBody,
      });
      if (!deactivated.success || !deactivateRetry.success) {
        throw new Error("Category deactivation retry mismatch");
      }
      const visible = await api({ route: "/api/v3/product-categories" });
      if (visible.some((category) => Number(category.id) === Number(createdCategory.id) && category.active !== false)) {
        throw new Error("Deactivated category remained active");
      }
      await requireExactlyOnce("v3-category-deactivate", 1, null);
      return { category_id: createdCategory.id, company_id: createdCategory.company_id };
    });

    const lot = await record("opening lot create and retry", async () => {
      const body = op("v3-opening-lot", {
        quantity: 20,
        purchase_rate: 50,
        sale_rate: 100,
        lot_name: "V3-LOT-1",
        opening_stock_date: "2026-07-28",
      });
      const first = await api({
        method: "POST",
        route: `/api/v3/products/${created.id}/opening-stock-lots`,
        body,
        expected: 201,
      });
      const retry = await api({
        method: "POST",
        route: `/api/v3/products/${created.id}/opening-stock-lots`,
        body,
        expected: 201,
      });
      if (retry.lots[0].id !== first.lots[0].id) throw new Error("Opening lot retry duplicated");
      await requireExactlyOnce("v3-opening-lot");
      return first.lots[0];
    });

    await record("lot metadata, quantity, deactivate, and reactivate lifecycle", async () => {
      const editBody = op("v3-lot-edit", {
        lot_name: "V3-LOT-1-EDITED",
        purchase_qty: 21,
        purchase_rate: 50,
        sale_rate: 105,
        opening_stock_date: "2026-07-28",
        reason: "isolated lot metadata edit",
      });
      await api({ method: "PUT", route: `/api/v3/inventory-lots/${lot.id}`, body: editBody });
      const editRetry = await api({ method: "PUT", route: `/api/v3/inventory-lots/${lot.id}`, body: editBody });
      if (!editRetry.idempotent_replay) throw new Error("Lot metadata retry was not recognized");
      await requireExactlyOnce("v3-lot-edit", 2);

      const addBody = op("v3-lot-add-quantity", {
        quantity: 2,
        reason: "isolated quantity addition",
      });
      await api({
        method: "POST",
        route: `/api/v3/inventory-lots/${lot.id}/add-quantity`,
        body: addBody,
      });
      const addRetry = await api({
        method: "POST",
        route: `/api/v3/inventory-lots/${lot.id}/add-quantity`,
        body: addBody,
      });
      if (!addRetry.idempotent_replay) throw new Error("Lot quantity retry was not recognized");
      await requireExactlyOnce("v3-lot-add-quantity");

      const deactivateBody = op("v3-lot-deactivate", { reason: "isolated lot deactivation" });
      await api({
        method: "POST",
        route: `/api/v3/inventory-lots/${lot.id}/deactivate`,
        body: deactivateBody,
      });
      await api({
        method: "POST",
        route: `/api/v3/inventory-lots/${lot.id}/deactivate`,
        body: deactivateBody,
      });
      await requireExactlyOnce("v3-lot-deactivate");

      const reactivateBody = op("v3-lot-reactivate", { reason: "isolated lot reactivation" });
      await api({
        method: "POST",
        route: `/api/v3/inventory-lots/${lot.id}/reactivate`,
        body: reactivateBody,
      });
      const reactivateRetry = await api({
        method: "POST",
        route: `/api/v3/inventory-lots/${lot.id}/reactivate`,
        body: reactivateBody,
      });
      if (!reactivateRetry.idempotent_replay) throw new Error("Lot reactivation retry was not recognized");
      const current = await pool.query(
        "SELECT lot_name, purchase_qty, remaining_qty, batch_status FROM inventory_batches WHERE id=$1",
        [lot.id]
      );
      if (
        current.rows[0].lot_name !== "V3-LOT-1-EDITED" ||
        Number(current.rows[0].purchase_qty) !== 23 ||
        Number(current.rows[0].remaining_qty) !== 23 ||
        current.rows[0].batch_status !== "ACTIVE"
      ) {
        throw new Error("Lot maintenance lifecycle produced incorrect stock");
      }
      await requireExactlyOnce("v3-lot-reactivate");
      return current.rows[0];
    });

    await record("cross-location lot maintenance is rejected", async () => {
      const foreignLot = await pool.query(
        "SELECT id FROM inventory_batches WHERE operational_location_id=$1 ORDER BY id LIMIT 1",
        [LOCATION_TWO]
      );
      if (!foreignLot.rows[0]) throw new Error("Second-location lot fixture is missing");
      const rejected = await api({
        method: "POST",
        route: `/api/v3/inventory-lots/${foreignLot.rows[0].id}/add-quantity`,
        body: op("v3-foreign-lot-rejected", {
          quantity: 1,
          reason: "must not cross location",
        }),
        expected: 404,
      });
      const evidence = await operationEvidence("v3-foreign-lot-rejected");
      if (evidence.processed !== 0 || evidence.changes !== 0) {
        throw new Error("Rejected cross-location lot mutation left records");
      }
      return { status: 404, message: rejected.message };
    });

    await record("positive and negative administrative adjustments", async () => {
      for (const [operationId, quantity] of [["v3-adjust-positive", 22], ["v3-adjust-negative", 19]]) {
        const body = op(operationId, {
          physical_quantity: quantity,
          adjustment_type: "Physical Count Correction",
          adjustment_date: "2026-07-28",
          reason: operationId,
        });
        await api({ method: "POST", route: `/api/v3/inventory-lots/${lot.id}/adjust`, body });
        await api({ method: "POST", route: `/api/v3/inventory-lots/${lot.id}/adjust`, body });
        await requireExactlyOnce(operationId);
      }
      const quantity = await pool.query("SELECT remaining_qty FROM inventory_batches WHERE id=$1", [lot.id]);
      if (Number(quantity.rows[0].remaining_qty) !== 19) throw new Error("Adjustment quantity mismatch");
      return { remaining_quantity: Number(quantity.rows[0].remaining_qty) };
    });

    await record("concurrent duplicate adjustment is serialized", async () => {
      const operationId = "v3-adjust-concurrent";
      const body = op(operationId, {
        physical_quantity: 18,
        adjustment_type: "Physical Count Correction",
        adjustment_date: "2026-07-28",
        reason: "concurrent isolated retry",
      });
      const [first, second] = await Promise.all([
        api({ method: "POST", route: `/api/v3/inventory-lots/${lot.id}/adjust`, body }),
        api({ method: "POST", route: `/api/v3/inventory-lots/${lot.id}/adjust`, body }),
      ]);
      if (![first, second].some((response) => response.idempotent_replay === true)) {
        throw new Error("Concurrent retry was not replayed from the processed operation");
      }
      const evidence = await requireExactlyOnce(operationId);
      const quantity = await pool.query("SELECT remaining_qty FROM inventory_batches WHERE id=$1", [lot.id]);
      if (Number(quantity.rows[0].remaining_qty) !== 18) {
        throw new Error("Concurrent retry applied the stock mutation more than once");
      }
      return { ...evidence, remaining_quantity: Number(quantity.rows[0].remaining_qty) };
    });

    await record("interrupted response retry remains idempotent", async () => {
      const operationId = "v3-adjust-interrupted-response";
      const body = op(operationId, {
        physical_quantity: 17,
        adjustment_type: "Physical Count Correction",
        adjustment_date: "2026-07-28",
        reason: "client response interrupted",
      });
      await abortAfterRequestWrite({
        method: "POST",
        route: `/api/v3/inventory-lots/${lot.id}/adjust`,
        body,
      });
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const evidence = await operationEvidence(operationId);
        if (evidence.processed === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const retry = await api({
        method: "POST",
        route: `/api/v3/inventory-lots/${lot.id}/adjust`,
        body,
      });
      if (!retry.idempotent_replay) {
        throw new Error("Retry after an interrupted response was not recognized");
      }
      const evidence = await requireExactlyOnce(operationId);
      const quantity = await pool.query("SELECT remaining_qty FROM inventory_batches WHERE id=$1", [lot.id]);
      if (Number(quantity.rows[0].remaining_qty) !== 17) {
        throw new Error("Interrupted-response retry duplicated the stock mutation");
      }
      return { ...evidence, remaining_quantity: Number(quantity.rows[0].remaining_qty) };
    });

    const purchaseFixture = await preparePurchaseFixture({ productId: created.id, lotId: lot.id });
    await record("purchase increase, decrease, cancellation, and retries", async () => {
      const payload = (operationId, quantity, reason) => op(operationId, {
        supplier_id: purchaseFixture.supplierId,
        product_id: created.id,
        quantity,
        purchase_rate: 50,
        expected_purchase_rate: 50,
        temporary_sale_rate: 100,
        purchase_bill_status: "BILL_PENDING",
        purchase_date: "2026-07-28",
        reason,
      });
      await api({ method: "PUT", route: `/api/v3/purchases/${purchaseFixture.purchaseId}`, body: payload("v3-purchase-increase", 12, "increase") });
      await api({ method: "PUT", route: `/api/v3/purchases/${purchaseFixture.purchaseId}`, body: payload("v3-purchase-increase", 12, "increase") });
      await requireExactlyOnce("v3-purchase-increase");
      await api({ method: "PUT", route: `/api/v3/purchases/${purchaseFixture.purchaseId}`, body: payload("v3-purchase-decrease", 11, "decrease") });
      await requireExactlyOnce("v3-purchase-decrease");
      const cancelBody = op("v3-purchase-cancel", { reason: "isolated cancellation" });
      await api({ method: "POST", route: `/api/v3/purchases/${purchaseFixture.purchaseId}/cancel`, body: cancelBody });
      await api({ method: "POST", route: `/api/v3/purchases/${purchaseFixture.purchaseId}/cancel`, body: cancelBody });
      await requireExactlyOnce("v3-purchase-cancel");
      return { purchase_id: purchaseFixture.purchaseId };
    });

    await record("pending purchase bill completion and retry", async () => {
      const completionLot = await pool.query(
        `INSERT INTO inventory_batches (
           global_id,product_id,batch_no,purchase_qty,remaining_qty,purchase_rate,
           effective_cost_per_unit,branch_id,company_id,operational_location_id,
           batch_status,stock_source,purchase_date
         ) VALUES ($1,$2,'V3-COMPLETION-LOT',10,10,50,50,1,1,$3,'ACTIVE','PURCHASE',CURRENT_DATE)
         RETURNING id`,
        [`v3-completion-lot-${crypto.randomUUID()}`, created.id, LOCATION_ONE]
      );
      const fixture = await preparePurchaseFixture({
        productId: created.id,
        lotId: completionLot.rows[0].id,
      });
      const rebate = await pool.query(
        "SELECT id FROM rebate_rules WHERE active=TRUE ORDER BY id LIMIT 1"
      );
      if (!rebate.rows[0]) throw new Error("Active rebate rule fixture is missing");
      const body = op("v3-purchase-complete", {
        supplier_id: fixture.supplierId,
        product_id: created.id,
        quantity: 12,
        purchase_rate: 50,
        expected_purchase_rate: 50,
        temporary_sale_rate: 100,
        freight_charges: 0,
        labour_charges: 0,
        other_charges: 0,
        paid_amount: 0,
        rebate_rule_id: rebate.rows[0].id,
        purchase_date: "2026-07-28",
        purchase_type: "CREDIT",
        reason: "isolated completion",
      });
      const first = await api({
        method: "POST",
        route: `/api/v3/purchases/${fixture.purchaseId}/complete-bill`,
        body,
      });
      const retry = await api({
        method: "POST",
        route: `/api/v3/purchases/${fixture.purchaseId}/complete-bill`,
        body,
      });
      if (
        first.purchase.purchase_bill_status !== "BILL_COMPLETED" ||
        retry.purchase.id !== first.purchase.id
      ) {
        throw new Error("Pending purchase completion retry mismatch");
      }
      return requireExactlyOnce("v3-purchase-complete");
    });

    await record("direct completed purchase receipt and retry", async () => {
      await pool.query(
        "UPDATE suppliers SET active=TRUE WHERE id=(SELECT id FROM suppliers ORDER BY id LIMIT 1)"
      );
      const [supplier, rebate] = await Promise.all([
        pool.query("SELECT id FROM suppliers WHERE active=TRUE ORDER BY id LIMIT 1"),
        pool.query("SELECT id FROM rebate_rules WHERE active=TRUE ORDER BY id LIMIT 1"),
      ]);
      if (!supplier.rows[0] || !rebate.rows[0]) {
        throw new Error("Purchase receipt fixtures are missing");
      }
      const body = op("v3-direct-purchase", {
        supplier_id: supplier.rows[0].id,
        purchase_bill_status: "BILL_COMPLETED",
        purchase_date: "2026-07-28",
        purchase_type: "CREDIT",
        freight_charges: 0,
        labour_charges: 0,
        other_charges: 0,
        paid_amount: 0,
        rebate_rule_id: rebate.rows[0].id,
        items: [{
          product_id: created.id,
          quantity: 4,
          purchase_rate: 50,
          lot_name: "V3-DIRECT-PURCHASE",
        }],
      });
      const first = await api({
        method: "POST",
        route: "/api/v3/purchase-bills",
        body,
        expected: 201,
      });
      const retry = await api({
        method: "POST",
        route: "/api/v3/purchase-bills",
        body,
        expected: 201,
      });
      if (
        first.purchase_ids.length !== 1 ||
        retry.purchase_ids[0] !== first.purchase_ids[0]
      ) {
        throw new Error("Direct purchase retry duplicated");
      }
      const rows = await pool.query(
        `SELECT p.company_id, p.operational_location_id, ib.remaining_qty
         FROM purchases p JOIN inventory_batches ib ON ib.purchase_id=p.id
         WHERE p.id=$1`,
        [first.purchase_ids[0]]
      );
      if (
        rows.rows.length !== 1 ||
        Number(rows.rows[0].company_id) !== 1 ||
        Number(rows.rows[0].operational_location_id) !== LOCATION_ONE ||
        Number(rows.rows[0].remaining_qty) !== 4
      ) {
        throw new Error("Direct purchase receipt scope or stock mismatch");
      }
      const evidence = await requireExactlyOnce("v3-direct-purchase");
      return { purchase_id: first.purchase_ids[0], ...evidence };
    });

    await record("interrupted direct purchase response retries exactly once", async () => {
      const supplier = await pool.query("SELECT id FROM suppliers WHERE active=TRUE ORDER BY id LIMIT 1");
      const rebate = await pool.query("SELECT id FROM rebate_rules WHERE active=TRUE ORDER BY id LIMIT 1");
      const operationId = "v3-direct-purchase-interrupted";
      const body = op(operationId, {
        supplier_id: supplier.rows[0].id,
        purchase_bill_status: "BILL_COMPLETED",
        purchase_date: "2026-07-28",
        purchase_type: "CREDIT",
        freight_charges: 0,
        labour_charges: 0,
        other_charges: 0,
        paid_amount: 0,
        rebate_rule_id: rebate.rows[0].id,
        items: [{
          product_id: created.id,
          quantity: 3,
          purchase_rate: 50,
          lot_name: "V3-INTERRUPTED-PURCHASE",
        }],
      });
      await abortAfterRequestWrite({
        method: "POST",
        route: "/api/v3/purchase-bills",
        body,
      });
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const evidence = await operationEvidence(operationId);
        if (evidence.processed === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const retry = await api({
        method: "POST",
        route: "/api/v3/purchase-bills",
        body,
        expected: 201,
      });
      if (!retry.idempotent_replay || retry.purchase_ids.length !== 1) {
        throw new Error("Interrupted purchase response did not replay committed result");
      }
      const count = await pool.query(
        "SELECT COUNT(*)::int count FROM purchases WHERE id=$1",
        [retry.purchase_ids[0]]
      );
      if (count.rows[0].count !== 1) throw new Error("Interrupted purchase duplicated");
      return requireExactlyOnce(operationId);
    });

    const saleLot = await pool.query(
      `INSERT INTO inventory_batches (
         global_id,product_id,batch_no,purchase_qty,remaining_qty,purchase_rate,
         effective_cost_per_unit,branch_id,company_id,operational_location_id,
         batch_status,stock_source,purchase_date
       ) VALUES ($1,$2,'V3-SALE-LOT',20,20,50,50,1,1,$3,'ACTIVE','OPENING_STOCK',CURRENT_DATE)
       RETURNING id`,
      [`v3-sale-lot-${crypto.randomUUID()}`, created.id, LOCATION_ONE]
    );
    const sale = await record("online sale, retry, and scoped deduction", async () => {
      const body = op("v3-sale-create", {
        items: [{ product_id: created.id, inventory_batch_id: saleLot.rows[0].id, quantity: 2, selling_rate: 100, discount_amount: 0 }],
        customer: {},
        invoice_discount: 0,
        bill_date: "2026-07-28",
        bill_datetime: "2026-07-28T12:00",
        backdate_confirmed: true,
        date_override_reason: "isolated staging",
      });
      const first = await api({ method: "POST", route: "/api/v3/sales", body, expected: 201 });
      const retry = await api({ method: "POST", route: "/api/v3/sales", body, expected: 201 });
      if (retry.sale.id !== first.sale.id) throw new Error("Sale retry duplicated");
      await requireExactlyOnce("v3-sale-create", 2);
      return first.sale;
    });

    await record("online sale edit and cancellation reversals", async () => {
      const createBody = op("v3-sale-edit-create", {
        items: [{
          product_id: created.id,
          inventory_batch_id: saleLot.rows[0].id,
          quantity: 2,
          selling_rate: 100,
          discount_amount: 0,
        }],
        customer: {},
        invoice_discount: 0,
        bill_date: "2026-07-28",
        bill_datetime: "2026-07-28T12:30",
        backdate_confirmed: true,
        date_override_reason: "isolated staging",
      });
      const createdSale = await api({
        method: "POST",
        route: "/api/v3/sales",
        body: createBody,
        expected: 201,
      });
      const editBody = op("v3-sale-edit", {
        reason: "isolated edit",
        bill_date: "2026-07-28",
        items: [{
          product_id: created.id,
          inventory_batch_id: saleLot.rows[0].id,
          quantity: 1,
          selling_rate: 100,
          discount_amount: 0,
        }],
        customer: {},
        invoice_discount: 0,
      });
      await api({
        method: "PUT",
        route: `/api/v3/sales/${createdSale.sale.id}`,
        body: editBody,
      });
      await api({
        method: "PUT",
        route: `/api/v3/sales/${createdSale.sale.id}`,
        body: editBody,
      });
      await requireExactlyOnce("v3-sale-edit", 3);
      const cancelBody = op("v3-sale-cancel", { reason: "isolated cancellation" });
      await api({
        method: "POST",
        route: `/api/v3/sales/${createdSale.sale.id}/cancel`,
        body: cancelBody,
      });
      await api({
        method: "POST",
        route: `/api/v3/sales/${createdSale.sale.id}/cancel`,
        body: cancelBody,
      });
      return requireExactlyOnce("v3-sale-cancel", 2);
    });

    await record("sales return restores stock once", async () => {
      const item = await pool.query("SELECT id FROM sale_items WHERE sale_id=$1 ORDER BY id LIMIT 1", [sale.id]);
      const body = op("v3-sale-return", {
        sale_id: sale.id,
        return_date: "2026-07-28",
        refund_type: "CASH_REFUND",
        return_reason: "isolated return",
        items: [{ sale_item_id: item.rows[0].id, return_quantity: 1 }],
      });
      const first = await api({ method: "POST", route: "/api/v3/sale-returns", body, expected: 201 });
      const retry = await api({ method: "POST", route: "/api/v3/sale-returns", body, expected: 201 });
      if (retry.id !== first.id) throw new Error("Sale return retry duplicated");
      return requireExactlyOnce("v3-sale-return", 2);
    });

    await record("waste deduction and retry", async () => {
      const body = op("v3-waste", {
        product_id: created.id,
        quantity: 1,
        waste_type: "DAAGI",
        waste_date: "2026-07-28",
        remarks: "isolated waste",
      });
      const first = await api({ method: "POST", route: "/api/v3/waste-entries", body, expected: 201 });
      const retry = await api({ method: "POST", route: "/api/v3/waste-entries", body, expected: 201 });
      if (retry.id !== first.id) throw new Error("Waste retry duplicated");
      return requireExactlyOnce("v3-waste", 2);
    });

    await record("cross-location lot delivery is absent", async () => {
      const changes = await pool.query(
        `SELECT operational_location_id, COUNT(*)::int count
         FROM sync_change_log
         WHERE payload->>'source_operation_id' LIKE 'v3-%'
           AND entity_type='inventory_lot'
         GROUP BY operational_location_id`
      );
      if (changes.rows.some((row) => Number(row.operational_location_id) !== LOCATION_ONE)) {
        throw new Error("A v3 inventory change escaped its canonical location");
      }
      return changes.rows;
    });

    await record("legacy unsafe writes remain blocked", async () => {
      const legacyWrites = [
        ["POST", "/sales"],
        ["POST", "/purchase-bill"],
        ["PUT", `/inventory-lots/${lot.id}`],
        ["POST", `/inventory-lots/${lot.id}/add-quantity`],
        ["POST", `/inventory-lots/${lot.id}/deactivate`],
        ["POST", `/inventory-lots/${lot.id}/reactivate`],
        ["POST", "/lots/transfer-stock"],
        ["POST", "/product-categories"],
        ["PUT", `/product-categories/${category.category_id}`],
        ["DELETE", `/product-categories/${category.category_id}`],
      ];
      const evidence = [];
      for (const [method, route] of legacyWrites) {
        const response = await fetch(`${origin}${route}`, {
          method,
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        const payload = await response.json();
        if (response.status !== 426 || payload.code !== "CLIENT_UPGRADE_REQUIRED") {
          throw new Error(`Legacy write was not blocked: ${method} ${route}`);
        }
        evidence.push({ method, route, status: response.status, code: payload.code });
      }
      return evidence;
    });

    await record("customer master unchanged", async () => {
      const after = await pool.query(
        "SELECT COUNT(*)::int count, md5(COALESCE(string_agg(row_to_json(c)::text,'|' ORDER BY c.id),'')) digest FROM customers c"
      );
      if (
        after.rows[0].count !== baselineCustomers.rows[0].count ||
        after.rows[0].digest !== baselineCustomers.rows[0].digest
      ) {
        throw new Error("Customer master changed");
      }
      return after.rows[0];
    });

    const report = {
      generated_at: new Date().toISOString(),
      mode: "ISOLATED_LOCALHOST_ACTUAL_BACKEND",
      database: "froozerp_current_staging",
      device_session_secret: "supplied_in_memory_and_not_persisted",
      results,
      passed: results.every((item) => item.passed),
    };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.passed, tests: results.length }));
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await pool.end();
    const sanitized = log.join("").replaceAll(secret, "[redacted]");
    fs.writeFileSync(`${outputPath}.backend.log`, sanitized);
  }
};

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
