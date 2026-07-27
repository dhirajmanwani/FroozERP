"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { Client } = require("../../backend/node_modules/pg");

const sqlitePath = path.resolve(process.argv[2] || "");
const outputPath = path.resolve(process.argv[3] || "");
const connectionString = process.env.STAGING_DATABASE_URL;

if (!sqlitePath || !outputPath || !connectionString) {
  throw new Error("Usage: STAGING_DATABASE_URL=... node reconcile-customers-readonly.js <sqlite-backup> <output-json>");
}

const parsedUrl = new URL(connectionString);
if (!["127.0.0.1", "localhost"].includes(parsedUrl.hostname) ||
    !/^\/froozerp_(?:current_)?staging$/.test(parsedUrl.pathname)) {
  throw new Error("Customer reconciliation is restricted to a localhost FroozERP staging database");
}

const normalizeText = (value) => String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const normalizePhone = (value) => String(value ?? "").replace(/\D/g, "").slice(-10);
const masked = (value) => {
  const text = String(value ?? "");
  return text ? `${"*".repeat(Math.max(0, text.length - 4))}${text.slice(-4)}` : null;
};

const safeCustomer = (row, source) => ({
  source,
  id: Number(row.id),
  name: row.customer_name || null,
  firm_name: row.firm_name || null,
  mobile_masked: masked(normalizePhone(row.mobile_number)),
  gst_number_masked: masked(row.gst_number),
  active: row.active !== false && Number(row.active ?? 1) !== 0,
});

const run = async () => {
  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
  const integrity = sqlite.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]);
  const localRows = sqlite.prepare(`
    SELECT id, account_name AS customer_name, NULL AS firm_name,
           mobile_number, NULL AS gst_number, active
    FROM local_customers ORDER BY id
  `).all();
  sqlite.close();

  const cloud = new Client({ connectionString });
  await cloud.connect();
  const currentDatabase = await cloud.query("SELECT current_database() AS name");
  if (!/^froozerp_(?:current_)?staging$/.test(currentDatabase.rows[0]?.name || "")) {
    throw new Error("Unexpected staging database");
  }
  await cloud.query("BEGIN TRANSACTION READ ONLY");
  let cloudRows;
  try {
    cloudRows = (await cloud.query(`
      SELECT id, customer_name, firm_name, mobile_number, gst_number, active
      FROM customers ORDER BY id
    `)).rows;
    await cloud.query("COMMIT");
  } catch (error) {
    await cloud.query("ROLLBACK");
    throw error;
  } finally {
    await cloud.end();
  }

  const comparisons = localRows.map((local) => {
    const exactId = cloudRows.find((cloudRow) => Number(cloudRow.id) === Number(local.id));
    const exactIdentity = cloudRows.filter((cloudRow) => {
      const sameName = normalizeText(cloudRow.customer_name) === normalizeText(local.customer_name);
      const localPhone = normalizePhone(local.mobile_number);
      const cloudPhone = normalizePhone(cloudRow.mobile_number);
      return sameName && (!localPhone || !cloudPhone || localPhone === cloudPhone);
    });
    const candidate = exactId || (exactIdentity.length === 1 ? exactIdentity[0] : null);
    return {
      local: safeCustomer(local, "sqlite"),
      cloud_match: candidate ? safeCustomer(candidate, "postgresql_staging") : null,
      confidence: exactId ? "id_only_requires_review" : exactIdentity.length === 1 ? "name_and_contact_candidate" : "no_unique_match",
      proposed_treatment: candidate ? "review_only_no_write" : "retain_as_unmatched_until_owner_approval",
      owner_approval_required: true,
    };
  });

  const report = {
    generated_at: new Date().toISOString(),
    mode: "READ_ONLY",
    sqlite_source: sqlitePath,
    sqlite_integrity: integrity,
    counts: { sqlite_customers: localRows.length, staging_postgresql_customers: cloudRows.length },
    comparisons,
    cloud_only: cloudRows
      .filter((cloudRow) => !comparisons.some((item) => item.cloud_match?.id === Number(cloudRow.id)))
      .map((row) => safeCustomer(row, "postgresql_staging")),
    writes_performed: 0,
    merges_performed: 0,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.counts));
};

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
