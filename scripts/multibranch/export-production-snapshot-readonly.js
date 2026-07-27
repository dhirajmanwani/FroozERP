"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("../../backend/node_modules/pg");

const outputPath = path.resolve(process.argv[2] || "");
const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;

if (!outputPath) throw new Error("An output path is required");
if (!connectionString) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");

const client = new Client({
  connectionString,
  ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: false },
});

const main = async () => {
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '45s'");
    const query = async (sql) => (await client.query(sql)).rows;
    const snapshot = {
      generated_at: new Date().toISOString(),
      mode: "PostgreSQL READ ONLY",
      companies: await query("SELECT id, company_name, company_code, active FROM companies ORDER BY id"),
      branches: await query("SELECT id, company_id, branch_name, active FROM branches ORDER BY id"),
      products: await query(`
        SELECT id, global_id, product_name, selling_rate, minimum_stock, active
        FROM products ORDER BY id
      `),
      inventory_lots: await query(`
        SELECT id, global_id, product_id, branch_id, remaining_qty, purchase_rate,
               effective_cost_per_unit, purchase_date, created_at, batch_status
        FROM inventory_batches ORDER BY id
      `),
      counts: (await query(`
        SELECT
          (SELECT COUNT(*)::INTEGER FROM product_categories) AS product_categories,
          (SELECT COUNT(*)::INTEGER FROM customers) AS customers,
          (SELECT COUNT(*)::INTEGER FROM suppliers) AS suppliers,
          (SELECT COUNT(*)::INTEGER FROM users) AS users,
          (SELECT COUNT(*)::INTEGER FROM authorized_devices) AS devices,
          (SELECT COUNT(*)::INTEGER FROM sales) AS sales,
          (SELECT COUNT(*)::INTEGER FROM purchases) AS purchases,
          (SELECT COUNT(*)::INTEGER FROM sync_processed_operations) AS processed_operations
      `))[0],
    };
    await client.query("ROLLBACK");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    console.log(JSON.stringify({
      output: outputPath,
      products: snapshot.products.length,
      inventory_lots: snapshot.inventory_lots.length,
      mode: snapshot.mode,
    }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
