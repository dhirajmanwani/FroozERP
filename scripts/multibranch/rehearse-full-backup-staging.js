"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { Client } = require("../../backend/node_modules/pg");

const sqlitePath = path.resolve(process.argv[2] || "");
const cloudSnapshotPath = path.resolve(process.argv[3] || "");
const outputPath = path.resolve(process.argv[4] || "");
const connectionString = process.env.STAGING_DATABASE_URL;

if (!sqlitePath || !cloudSnapshotPath || !outputPath || !connectionString) {
  throw new Error(
    "Usage: STAGING_DATABASE_URL=... node rehearse-full-backup-staging.js <sqlite-backup> <cloud-snapshot> <output-json>"
  );
}
const parsedUrl = new URL(connectionString);
if (!["127.0.0.1", "localhost"].includes(parsedUrl.hostname) || parsedUrl.pathname !== "/froozerp_staging") {
  throw new Error("Full rehearsal is restricted to localhost/froozerp_staging");
}

const snapshot = JSON.parse(fs.readFileSync(cloudSnapshotPath, "utf8"));

const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
const sqliteIntegrity = sqlite.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]);
const localProducts = sqlite.prepare("SELECT * FROM local_products ORDER BY id").all();
const localLots = sqlite.prepare("SELECT * FROM local_inventory_lots ORDER BY id").all();
const localSuppliers = [...new Map(
  localLots
    .filter((lot) => Number(lot.supplier_id) > 0)
    .map((lot) => [
      Number(lot.supplier_id),
      {
        id: Number(lot.supplier_id),
        supplier_name: lot.supplier_name || `Supplier ${lot.supplier_id}`,
        active: 1,
      },
    ])
).values()];
const testInvoices = sqlite.prepare(`
  SELECT COUNT(*) AS count FROM local_pos_invoices
  WHERE CAST(server_sale_id AS INTEGER) BETWEEN 192 AND 198
`).get();
const testOutbox = sqlite.prepare("SELECT COUNT(*) AS count FROM sync_outbox").get();
sqlite.close();

const number = (value) => Number(value || 0);
const positiveInteger = (value) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};
const serialize = (value) => JSON.parse(JSON.stringify(value, (_key, item) => (
  typeof item === "bigint" ? Number(item) : item
)));
const localProductByGlobal = new Map(localProducts.map((row) => [String(row.global_id || row.id), row]));
const localLotByGlobal = new Map(localLots.map((row) => [String(row.global_id || row.id), row]));

const countState = async (client) => {
  const result = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM products) AS products,
      (SELECT COUNT(*)::int FROM inventory_batches) AS inventory_lots,
      (SELECT COALESCE(ROUND(SUM(remaining_qty), 3), 0) FROM inventory_batches) AS quantity,
      (SELECT COALESCE(ROUND(SUM(
        CASE WHEN COALESCE(effective_cost_per_unit, purchase_rate) IS NULL THEN 0
             ELSE remaining_qty * COALESCE(effective_cost_per_unit, purchase_rate) END
      ), 2), 0) FROM inventory_batches) AS stock_value,
      (SELECT COUNT(*)::int FROM suppliers) AS suppliers,
      (SELECT COUNT(*)::int FROM customers) AS customers,
      (SELECT COUNT(*)::int FROM users) AS users,
      (SELECT COUNT(*)::int FROM authorized_devices) AS devices,
      (SELECT COUNT(*)::int FROM sales) AS sales,
      (SELECT COUNT(*)::int FROM purchases) AS purchases,
      (SELECT COUNT(*)::int FROM sync_processed_operations) AS processed_operations
  `);
  return serialize(result.rows[0]);
};

const insertMappedInventory = async (client) => {
  await client.query("UPDATE companies SET company_name = $2 WHERE id = $1", [1, "Feel the Freakin' Frooz"]);
  await client.query("UPDATE branches SET branch_name = $2, company_id = $1 WHERE id = $3", [1, "Jodhpur", 1]);
  await client.query(`
    INSERT INTO operational_locations
      (id, company_id, branch_id, location_code, location_name, location_type, timezone, active, is_default)
    VALUES (1, 1, 1, 'BADWASIYA-FRUIT-MARKET', 'Badwasiya Fruit Market', 'MARKET', 'Asia/Kolkata', TRUE, TRUE)
    ON CONFLICT (id) DO NOTHING
  `);

  const referencedSupplierIds = new Set(
    localLots.map((lot) => Number(lot.supplier_id)).filter((id) => Number.isInteger(id) && id > 0)
  );
  for (const supplier of localSuppliers.filter((row) => referencedSupplierIds.has(Number(row.id)))) {
    await client.query(
      `INSERT INTO suppliers
        (id, supplier_name, firm_name, mobile_number, alternate_number, address, city, gst_number,
         notes, opening_balance, supplier_type, active, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1)
       ON CONFLICT (id) DO NOTHING`,
      [
        Number(supplier.id),
        supplier.supplier_name,
        supplier.firm_name || null,
        supplier.mobile_number || null,
        supplier.alternate_number || null,
        supplier.address || null,
        supplier.city || null,
        supplier.gst_number || null,
        supplier.notes || null,
        number(supplier.opening_balance),
        supplier.supplier_type || "LOCAL_SUPPLIER",
        Number(supplier.active ?? 1) !== 0,
      ]
    );
  }

  for (const product of snapshot.products) {
    const local = localProductByGlobal.get(String(product.global_id || product.id)) || {};
    await client.query(
      `INSERT INTO products
        (id, global_id, product_name, selling_rate, unit, category_id, barcode, category,
         active, remarks, minimum_stock, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1)
       ON CONFLICT (id) DO NOTHING`,
      [
        Number(product.id),
        product.global_id || String(product.id),
        product.product_name,
        product.selling_rate,
        local.unit || "kg",
        positiveInteger(local.category_id),
        local.barcode || null,
        local.category || "Fruit",
        product.active !== false,
        local.remarks || null,
        product.minimum_stock,
      ]
    );
    await client.query(
      `INSERT INTO operational_location_products
        (company_id, branch_id, operational_location_id, product_id, enabled, pos_available,
         selling_rate, reorder_level)
       VALUES (1,1,1,$1,$2,$2,$3,$4)
       ON CONFLICT (operational_location_id, product_id) DO NOTHING`,
      [Number(product.id), product.active !== false, product.selling_rate, number(product.minimum_stock)]
    );
  }

  for (const lot of snapshot.inventory_lots) {
    const local = localLotByGlobal.get(String(lot.global_id || lot.id)) || {};
    const supplierId = Number(local.supplier_id) || null;
    await client.query(
      `INSERT INTO inventory_batches
        (id, global_id, product_id, batch_no, purchase_qty, remaining_qty, purchase_rate,
         effective_cost_per_unit, supplier_id, supplier_name, branch_id, company_id,
         operational_location_id, purchase_date, created_at, batch_status, stock_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,1,1,$11,$12,$13,$14)
       ON CONFLICT (id) DO NOTHING`,
      [
        Number(lot.id),
        lot.global_id || String(lot.id),
        Number(lot.product_id),
        local.batch_no || `MIGRATED-${lot.id}`,
        number(local.purchase_qty || local.opening_qty || lot.remaining_qty),
        number(lot.remaining_qty),
        lot.purchase_rate,
        lot.effective_cost_per_unit,
        supplierId,
        local.supplier_name || null,
        lot.purchase_date,
        lot.created_at,
        lot.batch_status || "ACTIVE",
        local.stock_source || "MIGRATION",
      ]
    );
  }
  await client.query("SELECT setval(pg_get_serial_sequence('products','id'), GREATEST((SELECT MAX(id) FROM products), 1), TRUE)");
  await client.query("SELECT setval(pg_get_serial_sequence('inventory_batches','id'), GREATEST((SELECT MAX(id) FROM inventory_batches), 1), TRUE)");
};

const run = async () => {
  console.log("staging: connect");
  const client = new Client({ connectionString });
  await client.connect();
  const database = await client.query("SELECT current_database() AS name, inet_server_addr()::text AS host");
  if (database.rows[0]?.name !== "froozerp_staging") throw new Error("Unexpected staging database");
  const schemaReady = await client.query(`
    SELECT to_regclass('public.operational_locations') IS NOT NULL AS ready
  `);
  if (schemaReady.rows[0]?.ready !== true) {
    throw new Error("Apply protocol-v3 schema to the isolated staging database before mapping rehearsal");
  }

  const before = await countState(client);
  console.log("staging: rollback pass begin");
  await client.query("BEGIN");
  let rollbackInside;
  try {
    await insertMappedInventory(client);
    console.log("staging: rollback pass mapped");
    rollbackInside = await countState(client);
    await client.query("ROLLBACK");
    console.log("staging: rollback pass complete");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  const rollbackAfter = await countState(client);

  console.log("staging: committed pass begin");
  await client.query("BEGIN");
  let after;
  let secondPass;
  try {
    await insertMappedInventory(client);
    console.log("staging: committed pass mapped");
    after = await countState(client);
    await insertMappedInventory(client);
    console.log("staging: idempotent pass mapped");
    secondPass = await countState(client);
    const langda = await client.query(`
      SELECT p.id, p.product_name, COUNT(ib.id)::int AS lots, COALESCE(SUM(ib.remaining_qty),0) AS quantity
      FROM products p LEFT JOIN inventory_batches ib ON ib.product_id = p.id
      WHERE p.id IN (276, 298) GROUP BY p.id, p.product_name ORDER BY p.id
    `);
    const excludedCloud = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM sales WHERE id BETWEEN 192 AND 198) AS invoices,
        (SELECT COUNT(*)::int FROM sync_processed_operations
         WHERE operation_id IN (
           SELECT operation_id FROM sync_processed_operations WHERE FALSE
         )) AS replayed_outbox
    `);
    await client.query("COMMIT");
    console.log("staging: committed pass complete");
    const report = {
      generated_at: new Date().toISOString(),
      mode: "ISOLATED_FULL_BACKUP_STAGING",
      schema_rehearsal: "009 and 010 applied separately after successful transactional rollback proof",
      sources: { sqlite: sqlitePath, cloud_snapshot: cloudSnapshotPath },
      sqlite_integrity: sqliteIntegrity,
      mapping: {
        company_id: 1,
        company_name: "Feel the Freakin' Frooz",
        branch_id: 1,
        branch_name: "Jodhpur",
        operational_location_id: 1,
        operational_location_name: "Badwasiya Fruit Market",
      },
      before,
      rollback: {
        inside_transaction: rollbackInside,
        after: rollbackAfter,
        restored: JSON.stringify(before) === JSON.stringify(rollbackAfter),
      },
      after,
      idempotent_second_pass: {
        counts: secondPass,
        inserted_additional_records: JSON.stringify(after) === JSON.stringify(secondPass) ? 0 : "nonzero",
      },
      langda_products: serialize(langda.rows),
      excluded_test_data: {
        sqlite_invoices_192_198: Number(testInvoices.count),
        sqlite_outbox_events: Number(testOutbox.count),
        cloud_invoices_192_198: Number(excludedCloud.rows[0].invoices),
        replayed_outbox_events: Number(excludedCloud.rows[0].replayed_outbox),
      },
    };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ before, after, rollback: report.rollback, idempotent: report.idempotent_second_pass }));
  } finally {
    await client.end();
  }
};

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
