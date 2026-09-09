#!/usr/bin/env node
/**
 * Say why a device that syncs successfully still has no data.
 *
 * ## The failure this exists for
 *
 * On 2026-09-09 the DELL completed a reference bootstrap cleanly -- `sync_state` went to IDLE with
 * no error, the operational location and the device assignment were written, `local_kv` got the
 * bootstrap meta -- and every business table on it stayed empty. A successful sync that transfers
 * nothing looks identical, from the device, to a sync that has not happened.
 *
 * It transfers nothing when the device's canonical scope does not match where the rows are. The
 * bootstrap's own filters say what has to line up, and they are not the same filter for every
 * entity:
 *
 *     product, product_category, supplier   company_id
 *     charge_type                           company_id, or NULL for all companies
 *     operational_location_products         company_id + branch_id + operational_location_id
 *     inventory_lot (inventory_batches)     company_id + branch_id + operational_location_id
 *
 * So a device can be approved, assigned, authenticated and correct in every screen the app shows,
 * and still receive zero products because its company id is not the company id on the products.
 * Nothing in the app can say this: the device only ever learns how many rows arrived, never how
 * many existed or why they were excluded.
 *
 * ## What it prints
 *
 * The scope the server would resolve for this device, what the bootstrap would send under that
 * scope, and -- the part that actually answers the question -- where the rows are instead, grouped
 * by the same columns the filters use. A mismatch is then visible rather than deduced.
 *
 * ## Read-only
 *
 * Every statement is a SELECT. Deciding what to do about a mismatch is a separate, deliberate act:
 * moving business rows between companies or locations is not something a diagnostic may do.
 *
 * Usage:
 *   $env:DATABASE_PUBLIC_URL = "..."
 *   node scripts/cloud/explain-empty-device.mjs FZDEV-....
 */

import { argv, env, exit, stdout } from "node:process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/**
 * The bootstrap's filters, named. Kept beside `backend/syncReferenceBootstrap.js`: if a filter
 * there changes and this list does not, the report explains the wrong thing -- which is worse than
 * not reporting, because it is believed.
 */
export const BOOTSTRAP_SCOPES = Object.freeze([
  { entity: "product_category", table: "product_categories", by: ["company_id"], softDelete: true },
  { entity: "product", table: "products", by: ["company_id"], softDelete: true },
  { entity: "supplier", table: "suppliers", by: ["company_id"], softDelete: false },
  { entity: "inventory_lot", table: "inventory_batches", by: ["company_id", "branch_id", "operational_location_id"], softDelete: true },
  { entity: "location_product", table: "operational_location_products", by: ["company_id", "branch_id", "operational_location_id"], softDelete: false },
]);

/**
 * The one-line verdict.
 *
 * Pure, so the judgement can be tested without a database. `sent` is what the device would receive
 * per entity; `available` is how many rows of that table exist at all.
 */
/**
 * Tables the bootstrap reads that this report deliberately does not count, each with the reason.
 * `backend/emptyDeviceExplanation.test.js` fails if the bootstrap grows a query whose table is
 * neither counted above nor excused here -- a silently uncovered entity would make this report
 * confidently incomplete, which is worse than no report.
 */
export const NOT_COUNTED = Object.freeze({
  operational_locations: "the device's own location, printed above as its assignment; its absence "
    + "raises BOOTSTRAP_LOCATION_UNAVAILABLE rather than producing an empty screen",
  device_assignments: "printed above as the device's assignment, and its absence is already the "
    + "NO_ACTIVE_ASSIGNMENT verdict",
  sync_change_log: "the high watermark, not business data",
  charge_types: "filtered as `company_id IS NULL OR company_id = $1` -- a row with no company "
    + "belongs to every company, so a count grouped by company id would describe it wrongly",
  charge_rate_slabs: "read only as a nested subquery of charge_types, never on its own",
});

export const explainEmptiness = ({ assignment, sent, available }) => {
  if (!assignment) {
    return {
      code: "NO_ACTIVE_ASSIGNMENT",
      message: "This device has no active row in device_assignments, so the bootstrap refuses "
        + "before it reads any business data. Post the device to a counter first.",
    };
  }
  const empty = BOOTSTRAP_SCOPES.filter(({ entity }) => !sent[entity]);
  if (!empty.length) {
    return { code: "SCOPE_MATCHES", message: "The bootstrap would send rows for every entity. An empty device is not explained by scope." };
  }
  const emptyBecauseNothingExists = empty.filter(({ table }) => !available[table]);
  if (emptyBecauseNothingExists.length === empty.length) {
    return {
      code: "NOTHING_TO_SEND",
      message: "The scope matches, but these tables have no rows at all on the cloud. The device is "
        + "empty because the cloud is empty -- this is not a scope fault.",
    };
  }
  return {
    code: "SCOPE_MISMATCH",
    message: "Rows exist that this device is not receiving. Each line under 'where the rows are "
      + "instead' shows a scope the data carries and this device does not, and the difference is "
      + "the reason the screens are blank.",
  };
};

const pad = (value, width) => String(value).padEnd(width);

const main = async () => {
  const deviceId = argv[2];
  if (!deviceId) {
    stdout.write("\nUsage: node scripts/cloud/explain-empty-device.mjs <DEVICE-ID>\n\n"
      + "The device id is on the app's Settings screen under 'This device'.\n\n");
    exit(1);
  }
  const connectionString = env.DATABASE_PUBLIC_URL || env.DATABASE_URL;
  if (!connectionString) {
    stdout.write("\nNeither DATABASE_PUBLIC_URL nor DATABASE_URL is set.\n\n");
    exit(1);
  }

  const require = createRequire(new URL("../../backend/package.json", import.meta.url));
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    const device = (await client.query(
      "SELECT device_id, device_name, status, branch_id, counter_id FROM authorized_devices WHERE device_id = $1",
      [deviceId],
    )).rows[0];
    stdout.write(`\nDevice ${deviceId}\n`);
    if (!device) {
      stdout.write("  Not present in authorized_devices at all. Nothing else can be true of it.\n\n");
      return;
    }
    stdout.write(`  name=${device.device_name || "(none)"}  status=${device.status}  `
      + `branch=${device.branch_id ?? "(none)"}  counter=${device.counter_id ?? "(none)"}\n`);

    const assignment = (await client.query(
      `SELECT company_id, branch_id, operational_location_id, assignment_generation, active
       FROM device_assignments WHERE device_id = $1 AND active = TRUE
       ORDER BY assignment_generation DESC LIMIT 1`,
      [deviceId],
    )).rows[0];
    if (assignment) {
      stdout.write(`  assignment: company=${assignment.company_id} branch=${assignment.branch_id} `
        + `location=${assignment.operational_location_id} generation=${assignment.assignment_generation}\n`);
    } else {
      stdout.write("  assignment: none active\n");
    }

    const sent = {};
    const available = {};
    if (assignment) {
      for (const scope of BOOTSTRAP_SCOPES) {
        const where = scope.by.map((column, index) => `${column} = $${index + 1}`);
        if (scope.softDelete) where.push("deleted_at IS NULL");
        const values = scope.by.map((column) =>
          column === "company_id" ? assignment.company_id
            : column === "branch_id" ? assignment.branch_id
              : assignment.operational_location_id);
        sent[scope.entity] = Number((await client.query(
          `SELECT COUNT(*)::INT AS n FROM ${scope.table} WHERE ${where.join(" AND ")}`, values,
        )).rows[0].n);
      }
    }
    for (const scope of BOOTSTRAP_SCOPES) {
      available[scope.table] = Number((await client.query(
        `SELECT COUNT(*)::INT AS n FROM ${scope.table}${scope.softDelete ? " WHERE deleted_at IS NULL" : ""}`,
      )).rows[0].n);
    }

    stdout.write("\nWhat the bootstrap would send to this device:\n");
    for (const { entity, table } of BOOTSTRAP_SCOPES) {
      stdout.write(`  ${pad(entity, 20)} ${pad(assignment ? sent[entity] : "-", 8)}`
        + `(rows in ${table}: ${available[table]})\n`);
    }

    stdout.write("\nWhere the rows are instead, grouped by the columns the filter uses:\n");
    for (const scope of BOOTSTRAP_SCOPES) {
      if (!available[scope.table]) continue;
      if (assignment && sent[scope.entity] === available[scope.table]) continue;
      const columns = scope.by.join(", ");
      const rows = (await client.query(
        `SELECT ${columns}, COUNT(*)::INT AS n FROM ${scope.table}`
        + `${scope.softDelete ? " WHERE deleted_at IS NULL" : ""}`
        + ` GROUP BY ${columns} ORDER BY n DESC LIMIT 10`,
      )).rows;
      stdout.write(`  ${scope.table}:\n`);
      for (const row of rows) {
        const scopeText = scope.by.map((column) => `${column}=${row[column] ?? "NULL"}`).join(" ");
        stdout.write(`    ${pad(scopeText, 62)} ${row.n} rows\n`);
      }
    }

    const verdict = explainEmptiness({ assignment, sent, available });
    stdout.write(`\nRESULT (${verdict.code}): ${verdict.message}\n\n`);
  } finally {
    client.release();
    await pool.end();
  }
};

const invokedDirectly = Boolean(argv[1]) && import.meta.url === pathToFileURL(argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    stdout.write(`\nCould not explain this device: ${error.message}\n\n`);
    exit(1);
  });
}
