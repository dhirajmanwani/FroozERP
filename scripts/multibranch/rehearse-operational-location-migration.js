"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { DatabaseSync } = require("node:sqlite");

const repoRoot = path.resolve(__dirname, "../..");
const cloudSnapshotPath = path.resolve(process.argv[2] || "");
const sqliteSourcePath = path.resolve(process.argv[3] || "");
const outputDirectory = path.resolve(
  process.argv[4] || path.join(repoRoot, "_recovery_backups", "multibranch-rehearsal")
);
if (!cloudSnapshotPath || !sqliteSourcePath) {
  throw new Error("Usage: node rehearse-operational-location-migration.js <cloud-snapshot.json> <sqlite-source> [output-directory]");
}

const cloudMigration = fs.readFileSync(
  path.join(repoRoot, "backend/migrations/cloud/009_operational_location_foundation.sql"),
  "utf8"
);
const sqliteMigration = fs.readFileSync(
  path.join(repoRoot, "src-tauri/migrations/sqlite/013_operational_location_foundation.sql"),
  "utf8"
);
const snapshot = JSON.parse(fs.readFileSync(cloudSnapshotPath, "utf8"));

const serialize = (value) => JSON.stringify(value, (_key, item) => (
  typeof item === "bigint" ? Number(item) : item
), 2);

const sqliteCounts = (database) => database.prepare(`
  SELECT
    (SELECT COUNT(*) FROM local_products) AS products,
    (SELECT COUNT(*) FROM local_inventory_lots) AS inventory_lots,
    (SELECT ROUND(COALESCE(SUM(balance_qty), 0), 3) FROM local_inventory_lots) AS quantity,
    (SELECT ROUND(COALESCE(SUM(
      CASE WHEN cost_rate IS NULL THEN 0 ELSE balance_qty * cost_rate END
    ), 0), 2) FROM local_inventory_lots) AS stock_value,
    (SELECT COUNT(*) FROM local_pos_invoices
     WHERE CAST(server_sale_id AS INTEGER) BETWEEN 192 AND 198) AS excluded_test_invoices,
    (SELECT COUNT(*) FROM sync_outbox) AS excluded_test_outbox
`).get();

const applySqliteMapping = (database) => {
  database.exec(sqliteMigration);
  applySqliteOwnershipMapping(database);
};

const applySqliteOwnershipMapping = (database) => {
  database.exec(`
    INSERT OR IGNORE INTO local_operational_locations (
      id, company_id, branch_id, location_code, location_name, location_type,
      timezone, active, is_default, assignment_generation, updated_at
    ) VALUES (
      '1', '1', '1', 'BADWASIYA-FRUIT-MARKET', 'Badwasiya Fruit Market',
      'MARKET', 'Asia/Kolkata', 1, 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    );

    UPDATE local_products
    SET company_id = '1'
    WHERE branch_id = '1';

    UPDATE local_inventory_lots
    SET company_id = '1',
        operational_location_id = '1'
    WHERE branch_id = '1';

    INSERT OR IGNORE INTO local_operational_location_products (
      operational_location_id, product_id, enabled, pos_available,
      selling_rate, reorder_level, updated_at
    )
    SELECT
      '1', id, active, active, sale_rate, COALESCE(minimum_stock, 0),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM local_products;
  `);
};

const verifySqliteExclusions = (database) => ({
  test_invoice_locations_populated: Number(database.prepare(`
    SELECT COUNT(*) AS count FROM local_pos_invoices
    WHERE CAST(server_sale_id AS INTEGER) BETWEEN 192 AND 198
      AND operational_location_id IS NOT NULL
  `).get().count),
  test_outbox_locations_populated: Number(database.prepare(`
    SELECT COUNT(*) AS count FROM sync_outbox
    WHERE operational_location_id IS NOT NULL
  `).get().count),
});

const runSqliteRehearsal = () => {
  fs.mkdirSync(outputDirectory, { recursive: true });
  const rollbackPath = path.join(outputDirectory, "sqlite-rollback-rehearsal.sqlite3");
  const committedPath = path.join(outputDirectory, "sqlite-committed-rehearsal.sqlite3");
  fs.copyFileSync(sqliteSourcePath, rollbackPath);
  fs.copyFileSync(sqliteSourcePath, committedPath);

  const rollbackDatabase = new DatabaseSync(rollbackPath);
  const rollbackBefore = sqliteCounts(rollbackDatabase);
  rollbackDatabase.exec("BEGIN IMMEDIATE");
  applySqliteMapping(rollbackDatabase);
  const rollbackInside = sqliteCounts(rollbackDatabase);
  rollbackDatabase.exec("ROLLBACK");
  const rollbackAfter = sqliteCounts(rollbackDatabase);
  const locationTableAfterRollback = Number(rollbackDatabase.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type = 'table' AND name = 'local_operational_locations'
  `).get().count);
  rollbackDatabase.close();

  const committedDatabase = new DatabaseSync(committedPath);
  const before = sqliteCounts(committedDatabase);
  committedDatabase.exec("BEGIN IMMEDIATE");
  applySqliteMapping(committedDatabase);
  const after = sqliteCounts(committedDatabase);
  const location = committedDatabase.prepare(`
    SELECT id, company_id, branch_id, location_code, location_name
    FROM local_operational_locations
  `).get();
  const mappedLots = Number(committedDatabase.prepare(`
    SELECT COUNT(*) AS count FROM local_inventory_lots
    WHERE company_id = '1' AND branch_id = '1' AND operational_location_id = '1'
  `).get().count);
  const locationProducts = Number(committedDatabase.prepare(`
    SELECT COUNT(*) AS count FROM local_operational_location_products
    WHERE operational_location_id = '1'
  `).get().count);
  const exclusions = verifySqliteExclusions(committedDatabase);
  applySqliteOwnershipMapping(committedDatabase);
  const idempotentAfter = sqliteCounts(committedDatabase);
  const idempotentLocationProducts = Number(committedDatabase.prepare(`
    SELECT COUNT(*) AS count FROM local_operational_location_products
    WHERE operational_location_id = '1'
  `).get().count);
  committedDatabase.exec("COMMIT");
  const integrity = committedDatabase.prepare("PRAGMA integrity_check").all()
    .map((row) => Object.values(row)[0]);
  committedDatabase.close();

  return {
    source: sqliteSourcePath,
    rollback: {
      before: rollbackBefore,
      inside_transaction: rollbackInside,
      after: rollbackAfter,
      schema_removed: locationTableAfterRollback === 0,
      counts_restored: serialize(rollbackBefore) === serialize(rollbackAfter),
    },
    committed_copy: {
      path: committedPath,
      before,
      after,
      location,
      mapped_lots: mappedLots,
      location_products: locationProducts,
      idempotent_second_pass: {
        counts_unchanged: serialize(after) === serialize(idempotentAfter),
        location_products: idempotentLocationProducts,
      },
      exclusions,
      integrity,
    },
  };
};

const createCloudBaseline = async (database) => {
  await database.exec(`
    CREATE TABLE companies (
      id INTEGER PRIMARY KEY,
      company_name VARCHAR(180) NOT NULL,
      company_code VARCHAR(80),
      active BOOLEAN DEFAULT TRUE
    );
    CREATE TABLE branches (
      id INTEGER PRIMARY KEY,
      company_id INTEGER,
      branch_name VARCHAR(180),
      active BOOLEAN DEFAULT TRUE
    );
    CREATE TABLE roles (id INTEGER PRIMARY KEY, role_name VARCHAR(80));
    CREATE TABLE users (id INTEGER PRIMARY KEY, role_id INTEGER);
    CREATE TABLE authorized_devices (
      id INTEGER PRIMARY KEY,
      device_id VARCHAR(160) UNIQUE NOT NULL
    );
    CREATE TABLE product_categories (id INTEGER PRIMARY KEY);
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      global_id VARCHAR(180),
      product_name VARCHAR(180),
      selling_rate NUMERIC(14,2),
      minimum_stock NUMERIC(14,3),
      active BOOLEAN DEFAULT TRUE
    );
    CREATE TABLE customers (id INTEGER PRIMARY KEY);
    CREATE TABLE suppliers (id INTEGER PRIMARY KEY);
    CREATE TABLE inventory_batches (
      id INTEGER PRIMARY KEY,
      global_id VARCHAR(180),
      product_id INTEGER,
      branch_id INTEGER,
      remaining_qty NUMERIC(14,3),
      purchase_rate NUMERIC(14,4),
      effective_cost_per_unit NUMERIC(14,4),
      purchase_date DATE,
      created_at TIMESTAMP,
      batch_status VARCHAR(30)
    );
    CREATE TABLE stock_transactions (id INTEGER PRIMARY KEY, branch_id INTEGER);
    CREATE TABLE stock_adjustments (id INTEGER PRIMARY KEY);
    CREATE TABLE purchases (id INTEGER PRIMARY KEY, branch_id INTEGER);
    CREATE TABLE sales (id INTEGER PRIMARY KEY, branch_id INTEGER);
    CREATE TABLE sale_payments (id INTEGER PRIMARY KEY, branch_id INTEGER);
    CREATE TABLE sale_returns (id INTEGER PRIMARY KEY, branch_id INTEGER);
    CREATE TABLE waste_entries (id INTEGER PRIMARY KEY, branch_id INTEGER);
    CREATE TABLE customer_payments (id INTEGER PRIMARY KEY, branch_id INTEGER);
    CREATE TABLE customer_ledger (id INTEGER PRIMARY KEY);
    CREATE TABLE supplier_payments (id INTEGER PRIMARY KEY, branch_id INTEGER);
    CREATE TABLE expenses (id INTEGER PRIMARY KEY, branch_id INTEGER);
    CREATE TABLE contra_entries (id INTEGER PRIMARY KEY, branch_id INTEGER);
    CREATE TABLE sync_processed_operations (
      operation_id VARCHAR(180) PRIMARY KEY,
      device_id VARCHAR(160),
      company_id INTEGER,
      branch_id INTEGER,
      processed_at TIMESTAMP
    );
    CREATE TABLE sync_change_log (
      change_id BIGINT PRIMARY KEY,
      company_id INTEGER,
      branch_id INTEGER
    );
    CREATE TABLE sync_conflict_log (
      id BIGINT PRIMARY KEY,
      company_id INTEGER,
      branch_id INTEGER
    );
    CREATE TABLE sync_pos_sale_staging (
      invoice_global_id VARCHAR(180) PRIMARY KEY,
      company_id INTEGER,
      branch_id INTEGER
    );
    CREATE TABLE sync_inbox_operations (
      operation_id VARCHAR(180) PRIMARY KEY,
      company_id INTEGER,
      branch_id INTEGER
    );
  `);

  for (const company of snapshot.companies) {
    await database.query(
      "INSERT INTO companies(id, company_name, company_code, active) VALUES ($1,$2,$3,$4)",
      [company.id, company.company_name, company.company_code, company.active]
    );
  }
  for (const branch of snapshot.branches) {
    await database.query(
      "INSERT INTO branches(id, company_id, branch_name, active) VALUES ($1,$2,$3,$4)",
      [branch.id, branch.company_id, branch.branch_name, branch.active]
    );
  }
  await database.exec("INSERT INTO roles(id, role_name) VALUES (1, 'Owner'); INSERT INTO users(id, role_id) VALUES (1, 1);");
  for (let id = 1; id <= Number(snapshot.counts.devices || 0); id += 1) {
    await database.query("INSERT INTO authorized_devices(id, device_id) VALUES ($1,$2)", [id, `preserved-device-${id}`]);
  }
  for (let id = 1; id <= Number(snapshot.counts.product_categories || 0); id += 1) {
    await database.query("INSERT INTO product_categories(id) VALUES ($1)", [id]);
  }
  for (const product of snapshot.products) {
    await database.query(
      `INSERT INTO products(id, global_id, product_name, selling_rate, minimum_stock, active)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [product.id, product.global_id, product.product_name, product.selling_rate, product.minimum_stock, product.active]
    );
  }
  for (let id = 1; id <= Number(snapshot.counts.customers || 0); id += 1) {
    await database.query("INSERT INTO customers(id) VALUES ($1)", [id]);
  }
  for (let id = 1; id <= Number(snapshot.counts.suppliers || 0); id += 1) {
    await database.query("INSERT INTO suppliers(id) VALUES ($1)", [id]);
  }
  for (const lot of snapshot.inventory_lots) {
    await database.query(
      `INSERT INTO inventory_batches(
         id, global_id, product_id, branch_id, remaining_qty, purchase_rate,
         effective_cost_per_unit, purchase_date, created_at, batch_status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        lot.id, lot.global_id, lot.product_id, lot.branch_id, lot.remaining_qty,
        lot.purchase_rate, lot.effective_cost_per_unit, lot.purchase_date,
        lot.created_at, lot.batch_status,
      ]
    );
  }
};

const cloudCounts = async (database) => (await database.query(`
  SELECT
    (SELECT COUNT(*)::INTEGER FROM products) AS products,
    (SELECT COUNT(*)::INTEGER FROM inventory_batches) AS inventory_lots,
    (SELECT ROUND(COALESCE(SUM(remaining_qty), 0), 3) FROM inventory_batches) AS quantity,
    (SELECT ROUND(COALESCE(SUM(
      CASE WHEN COALESCE(effective_cost_per_unit, purchase_rate) IS NULL THEN 0
           ELSE remaining_qty * COALESCE(effective_cost_per_unit, purchase_rate) END
    ), 0), 2) FROM inventory_batches) AS stock_value,
    (SELECT COUNT(*)::INTEGER FROM customers) AS customers,
    (SELECT COUNT(*)::INTEGER FROM suppliers) AS suppliers,
    (SELECT COUNT(*)::INTEGER FROM users) AS users,
    (SELECT COUNT(*)::INTEGER FROM authorized_devices) AS devices,
    (SELECT COUNT(*)::INTEGER FROM sales) AS sales
`)).rows[0];

const applyCloudMapping = async (database) => {
  await database.exec(cloudMigration);
  await applyCloudOwnershipMapping(database);
};

const applyCloudOwnershipMapping = async (database) => {
  await database.exec(`
    UPDATE branches
    SET branch_name = 'Jodhpur'
    WHERE id = 1 AND company_id = 1;

    INSERT INTO operational_locations (
      id, company_id, branch_id, location_code, location_name, location_type,
      timezone, active, is_default
    ) VALUES (
      1, 1, 1, 'BADWASIYA-FRUIT-MARKET', 'Badwasiya Fruit Market',
      'MARKET', 'Asia/Kolkata', TRUE, TRUE
    )
    ON CONFLICT (company_id, branch_id, location_code) DO NOTHING;

    UPDATE product_categories SET company_id = 1;
    UPDATE products SET company_id = 1;
    UPDATE customers SET company_id = 1;
    UPDATE suppliers SET company_id = 1;
    UPDATE inventory_batches
    SET company_id = 1,
        operational_location_id = 1
    WHERE branch_id = 1;

    INSERT INTO operational_location_products (
      company_id, branch_id, operational_location_id, product_id,
      enabled, pos_available, selling_rate, reorder_level
    )
    SELECT
      1, 1, 1, id, active, active, selling_rate, COALESCE(minimum_stock, 0)
    FROM products
    ON CONFLICT (operational_location_id, product_id) DO NOTHING;
  `);
};

const runCloudRehearsal = async () => {
  const pgliteEntry = require.resolve("@electric-sql/pglite", {
    paths: [path.join(repoRoot, "backend")],
  });
  const { PGlite } = await import(pathToFileURL(pgliteEntry).href);

  const rollbackDatabase = new PGlite();
  await rollbackDatabase.waitReady;
  await createCloudBaseline(rollbackDatabase);
  const rollbackBefore = await cloudCounts(rollbackDatabase);
  await rollbackDatabase.exec("BEGIN");
  await applyCloudMapping(rollbackDatabase);
  const rollbackInside = await cloudCounts(rollbackDatabase);
  await rollbackDatabase.exec("ROLLBACK");
  const rollbackAfter = await cloudCounts(rollbackDatabase);
  const rollbackTable = await rollbackDatabase.query(`
    SELECT COUNT(*)::INTEGER AS count
    FROM information_schema.tables
    WHERE table_name = 'operational_locations'
  `);
  await rollbackDatabase.close();

  const committedDatabase = new PGlite();
  await committedDatabase.waitReady;
  await createCloudBaseline(committedDatabase);
  const before = await cloudCounts(committedDatabase);
  await committedDatabase.exec("BEGIN");
  await applyCloudMapping(committedDatabase);
  const after = await cloudCounts(committedDatabase);
  const location = (await committedDatabase.query(`
    SELECT id, company_id, branch_id, location_code, location_name
    FROM operational_locations
  `)).rows[0];
  const mappedLots = (await committedDatabase.query(`
    SELECT COUNT(*)::INTEGER AS count FROM inventory_batches
    WHERE company_id = 1 AND branch_id = 1 AND operational_location_id = 1
  `)).rows[0].count;
  const locationProducts = (await committedDatabase.query(`
    SELECT COUNT(*)::INTEGER AS count FROM operational_location_products
    WHERE operational_location_id = 1
  `)).rows[0].count;
  const langda = (await committedDatabase.query(`
    SELECT id, global_id, product_name FROM products WHERE id IN (276, 298) ORDER BY id
  `)).rows;
  await applyCloudOwnershipMapping(committedDatabase);
  const idempotentAfter = await cloudCounts(committedDatabase);
  const idempotentLocationProducts = (await committedDatabase.query(`
    SELECT COUNT(*)::INTEGER AS count FROM operational_location_products
    WHERE operational_location_id = 1
  `)).rows[0].count;
  await committedDatabase.exec("COMMIT");
  await committedDatabase.close();

  return {
    engine: "PGlite embedded PostgreSQL; no production connection",
    rollback: {
      before: rollbackBefore,
      inside_transaction: rollbackInside,
      after: rollbackAfter,
      schema_removed: Number(rollbackTable.rows[0].count) === 0,
      counts_restored: serialize(rollbackBefore) === serialize(rollbackAfter),
    },
    committed_disposable: {
      before,
      after,
      location,
      mapped_lots: Number(mappedLots),
      location_products: Number(locationProducts),
      idempotent_second_pass: {
        counts_unchanged: serialize(after) === serialize(idempotentAfter),
        location_products: Number(idempotentLocationProducts),
      },
      langda,
      excluded_test_sales: Number(after.sales) === 0,
    },
  };
};

const main = async () => {
  if (snapshot.products.length !== 25 || snapshot.inventory_lots.length !== 70) {
    throw new Error("Cloud snapshot does not match the approved 25 product / 70 lot boundary");
  }
  const sqlite = runSqliteRehearsal();
  const cloud = await runCloudRehearsal();
  const report = {
    generated_at: new Date().toISOString(),
    mapping: {
      company_id: 1,
      branch_id: 1,
      branch_name: "Jodhpur",
      operational_location_id: 1,
      operational_location_name: "Badwasiya Fruit Market",
    },
    safety: {
      production_write: false,
      installed_database_write: false,
      release_artifact_write: false,
      test_invoices_replayed: false,
      test_outbox_replayed: false,
    },
    sqlite,
    cloud,
  };
  const reportPath = path.join(outputDirectory, "rehearsal-report.json");
  fs.writeFileSync(reportPath, `${serialize(report)}\n`, "utf8");
  console.log(serialize({ report_path: reportPath, ...report }));
};

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
