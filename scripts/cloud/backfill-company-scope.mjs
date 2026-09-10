#!/usr/bin/env node
/**
 * Give the shop's pre-multi-company rows the company they always belonged to.
 *
 * ## What is wrong
 *
 * Migration 009 added `company_id` to `product_categories`, `products`, `customers` and
 * `suppliers` as a *nullable* column, and no migration -- and nothing in `initializeDatabase()` --
 * ever filled it in for the rows that already existed. `inventory_batches` is the same story for
 * `company_id` and `operational_location_id`.
 *
 * Nothing failed when that happened, which is why it went unnoticed for months. Every reader that
 * scopes by company simply stopped seeing those rows:
 *
 *     WHERE p.company_id = $1        -- NULL = 1 is NULL, so the row is not returned
 *
 * On 2026-09-09 the shop's cloud held 25 products, 13 suppliers and 70 inventory lots, all with
 * `company_id IS NULL`, and a device assigned to company 1 completed a reference bootstrap
 * successfully and received none of them. The bootstrap reported success because it *was*
 * successful: it sent every row that matched, and none matched.
 *
 * ## Why this is a repair and not a guess
 *
 * A row with no company is not ambiguous when the installation has exactly one company: there is
 * one answer and it is forced. The moment there is more than one, there is no way to tell from the
 * data which company a product belonged to, and guessing would move a shop's stock into another
 * shop's books. So this refuses instead, and says so.
 *
 * The same rule governs `operational_location_id` on lots: a lot already carries its branch, so if
 * that branch has exactly one operational location the answer is forced. Two, and it refuses --
 * putting stock at the wrong counter is precisely the failure the location split exists to prevent.
 *
 * ## It changes business data, so it does nothing by default
 *
 * A dry run prints what it would write and stops. `--apply` is required, and everything happens in
 * one transaction. Only NULLs are ever written to; a row that already has a company is never
 * touched, so re-running it is safe and changes nothing the second time.
 *
 * This is a one-off repair, deliberately not a migration: a migration runs unattended on every
 * deploy, and rewriting business rows is not something that should happen without somebody
 * choosing it.
 *
 * Usage:
 *   $env:DATABASE_PUBLIC_URL = "..."
 *   node scripts/cloud/backfill-company-scope.mjs            # dry run, writes nothing
 *   node scripts/cloud/backfill-company-scope.mjs --apply
 */

import { argv, env, exit, stdout } from "node:process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/** Tables whose orphan rows are adopted by the one company, and how. */
export const COMPANY_SCOPED_TABLES = Object.freeze([
  "product_categories", "products", "customers", "suppliers", "inventory_batches",
]);

/**
 * What to do, given what the database contains. Pure, so every refusal can be tested without a
 * database -- and the refusals are the important half of this script.
 *
 * `companies` is the list of company ids. `locationsByBranch` maps a branch id to the operational
 * location ids it has. `orphans` is the count of NULL-company rows per table, and `orphanLots`
 * maps a branch id to how many of its lots have no operational location.
 */
export const planBackfill = ({ companies, locationsByBranch, orphans, orphanLots }) => {
  if (!companies.length) {
    return { refused: "NO_COMPANY", message: "This database has no company at all. There is nothing to adopt these rows into." };
  }
  if (companies.length > 1) {
    return {
      refused: "MANY_COMPANIES",
      message: `This database has ${companies.length} companies (${companies.join(", ")}). A row with no `
        + "company cannot be assigned to one of several without guessing, and a wrong guess moves one "
        + "shop's stock into another shop's books. Assign them by hand, or by a rule only you know.",
    };
  }
  const companyId = companies[0];

  const writes = COMPANY_SCOPED_TABLES
    .filter((table) => orphans[table] > 0)
    .map((table) => ({ table, column: "company_id", value: companyId, rows: orphans[table] }));

  const locationWrites = [];
  const locationRefusals = [];
  for (const [branch, count] of Object.entries(orphanLots || {})) {
    if (!count) continue;
    const locations = locationsByBranch?.[branch] || [];
    if (locations.length === 1) {
      locationWrites.push({ table: "inventory_batches", column: "operational_location_id", value: locations[0], branch, rows: count });
    } else {
      locationRefusals.push({
        branch,
        rows: count,
        reason: locations.length
          ? `branch ${branch} has ${locations.length} operational locations (${locations.join(", ")}), so which counter holds this stock is not recorded anywhere`
          : `branch ${branch} has no operational location, so there is no counter to put this stock at`,
      });
    }
  }

  if (!writes.length && !locationWrites.length) {
    return { refused: "NOTHING_TO_DO", message: "Every row already carries its company and location. Nothing to repair.", locationRefusals };
  }
  return { companyId, writes, locationWrites, locationRefusals };
};

const main = async () => {
  const apply = argv.includes("--apply");
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
    const columns = new Map();
    for (const row of (await client.query(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'"
    )).rows) {
      if (!columns.has(row.table_name)) columns.set(row.table_name, new Set());
      columns.get(row.table_name).add(row.column_name);
    }
    const has = (table, column) => columns.get(table)?.has(column);

    const companies = (await client.query("SELECT id FROM companies ORDER BY id")).rows.map((row) => Number(row.id));

    const locationsByBranch = {};
    for (const row of (await client.query(
      "SELECT branch_id, id FROM operational_locations WHERE active IS NOT FALSE ORDER BY branch_id, id"
    )).rows) {
      (locationsByBranch[row.branch_id] ||= []).push(Number(row.id));
    }

    const orphans = {};
    for (const table of COMPANY_SCOPED_TABLES) {
      if (!has(table, "company_id")) continue;
      orphans[table] = Number((await client.query(
        `SELECT COUNT(*)::INT AS n FROM ${table} WHERE company_id IS NULL`
      )).rows[0].n);
    }

    const orphanLots = {};
    if (has("inventory_batches", "operational_location_id")) {
      for (const row of (await client.query(
        "SELECT branch_id, COUNT(*)::INT AS n FROM inventory_batches"
        + " WHERE operational_location_id IS NULL AND branch_id IS NOT NULL GROUP BY branch_id"
      )).rows) {
        orphanLots[row.branch_id] = Number(row.n);
      }
    }

    const plan = planBackfill({ companies, locationsByBranch, orphans, orphanLots });
    if (plan.refused) {
      stdout.write(`\nNothing was written (${plan.refused}).\n${plan.message}\n\n`);
      exit(plan.refused === "NOTHING_TO_DO" ? 0 : 1);
    }

    stdout.write(`\nOne company on this database: ${plan.companyId}. Every row below has no company at all,\n`
      + "so there is exactly one company it can belong to.\n\n");
    for (const write of [...plan.writes, ...plan.locationWrites]) {
      const where = write.branch ? ` (branch ${write.branch})` : "";
      stdout.write(`  ${write.table}.${write.column} = ${write.value}${where}  ->  ${write.rows} rows\n`);
    }
    if (plan.locationRefusals.length) {
      stdout.write("\nLots left alone, because putting stock at the wrong counter is worse than leaving it:\n");
      for (const refusal of plan.locationRefusals) {
        stdout.write(`  ${refusal.rows} lots: ${refusal.reason}\n`);
      }
    }

    if (!apply) {
      stdout.write("\nDRY RUN. Nothing was written. Re-run with --apply to make these changes.\n\n");
      return;
    }

    await client.query("BEGIN");
    let written = 0;
    for (const write of plan.writes) {
      const result = await client.query(
        `UPDATE ${write.table} SET company_id = $1 WHERE company_id IS NULL`, [write.value],
      );
      written += result.rowCount;
    }
    for (const write of plan.locationWrites) {
      const result = await client.query(
        "UPDATE inventory_batches SET operational_location_id = $1"
        + " WHERE operational_location_id IS NULL AND branch_id = $2", [write.value, write.branch],
      );
      written += result.rowCount;
    }
    await client.query("COMMIT");
    stdout.write(`\nApplied. ${written} rows now carry the company and counter they belong to.\n`
      + "Sign out and back in on the device, then run scripts/inspect-local-db.mjs.\n\n");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
};

const invokedDirectly = Boolean(argv[1]) && import.meta.url === pathToFileURL(argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    stdout.write(`\nNothing was written. ${error.message}\n\n`);
    exit(1);
  });
}
