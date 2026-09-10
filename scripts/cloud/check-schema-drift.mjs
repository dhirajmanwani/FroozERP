#!/usr/bin/env node
/**
 * Say, in one run, everything `initializeDatabase()` declares that the cloud database does not have.
 *
 * ## Why this exists
 *
 * `backend/server.js:208`:
 *
 *     const runStartupSchemaBootstrap = hostedCloudDeployment ? false : ...
 *
 * On a hosted deployment the startup bootstrap is off — deliberately, so that nothing rewrites a
 * live shop's schema on a restart. The cost, which nobody had priced, is that `initializeDatabase()`
 * is the only place the `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
 * statements live. So on the cloud they have never run, and the database is frozen at whatever it
 * looked like the day it was created. Everything added since exists in the code and nowhere else.
 *
 * The check that follows startup looks for missing **tables** and nothing else, so the server boots
 * clean and each absence waits to be discovered by whichever route reads it first. Two were found
 * that way on 2026-09-08 and 09, each costing an evening:
 *
 *     column u.failed_login_attempts does not exist   -> every cloud sign-in answered 500
 *     relation "charge_types" does not exist          -> the reference bootstrap answered 500,
 *                                                        so no device could ever be filled
 *
 * Finding them one at a time, each from a Railway log, is not a method. There are 88 tables and 268
 * added columns in that bootstrap; this reports every one that is missing, at once.
 *
 * ## Read-only
 *
 * Opens the database, reads `information_schema`, prints. It creates nothing and alters nothing —
 * deciding what to do about the drift is a separate, deliberate act, and the output is written to
 * be pasted straight into a migration.
 *
 * ## What it cannot see
 *
 * Indexes, constraints, functions and triggers. It compares tables and columns, which is what the
 * two known failures were. A missing index degrades; a missing column raises.
 *
 * Usage:
 *   $env:DATABASE_PUBLIC_URL = "..."      # or DATABASE_URL
 *   node scripts/cloud/check-schema-drift.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { argv, env, exit, stdout } from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, "..", "..", "backend", "server.js");

/**
 * The SQL `initializeDatabase()` would run, as text.
 *
 * Bounded to that function on purpose: `server.js` is one 19.7k-line file and its route handlers are
 * full of SQL. Scanning the whole file would collect statements that were never part of the schema
 * bootstrap and report drift that does not exist.
 */
export const bootstrapSql = (source) => {
  const start = source.indexOf("const initializeDatabase = async");
  if (start === -1) throw new Error("initializeDatabase() was not found in server.js");

  // `\r?\n`, not `\n`. Windows is the shipped target and the checkout there has CRLF endings, so a
  // search for "\n};\n" finds nothing and the whole command fails with "the end of
  // initializeDatabase() was not found" -- on the one machine it was written for, while passing
  // everywhere it was tested.
  const closing = /\r?\n\};\r?\n/g;
  closing.lastIndex = start;
  const match = closing.exec(source);
  if (!match) throw new Error("the end of initializeDatabase() was not found");
  return source.slice(start, match.index);
};

/** Tables the bootstrap creates. */
export const declaredTables = (sql) =>
  [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/g)]
    .map(([, name]) => name.toLowerCase());

/** Columns the bootstrap adds, as `table.column`. */
export const declaredColumns = (sql) =>
  [...sql.matchAll(/ALTER TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD COLUMN IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/g)]
    .map(([, table, column]) => [table.toLowerCase(), column.toLowerCase()]);

/**
 * Compare what is declared with what exists.
 *
 * Pure: takes the declarations and the live catalogue, returns the difference. The whole judgement
 * is here so it can be tested without a database, the way every other decision in this repository is.
 *
 * A column of a table that is itself missing is not reported separately — the table line already
 * says everything, and repeating each of its columns turns a short report into an unreadable one.
 *
 * Every name is folded to lower case on the way in, both sides. Postgres folds unquoted identifiers
 * itself, so `Users` in the source and `users` in the catalogue are one table; comparing them as
 * written would report a column that is plainly there.
 */
export const compareSchema = ({ tables, columns, liveTables, liveColumns }) => {
  const lower = (value) => String(value).toLowerCase();
  const declared = tables.map(lower);
  const declaredCols = columns.map(([table, column]) => [lower(table), lower(column)]);
  const live = new Set(liveTables.map(lower));
  const liveColumnSet = new Set(liveColumns.map(([t, c]) => `${lower(t)}.${lower(c)}`));

  const missingTables = [...new Set(declared.filter((name) => !live.has(name)))].sort();
  const missingTableSet = new Set(missingTables);

  const missingColumns = declaredCols
    .filter(([table]) => live.has(table) && !missingTableSet.has(table))
    .filter(([table, column]) => !liveColumnSet.has(`${table}.${column}`))
    .map(([table, column]) => `${table}.${column}`);

  return {
    missingTables,
    missingColumns: [...new Set(missingColumns)].sort(),
    declaredTables: declared.length,
    declaredColumns: declaredCols.length,
  };
};

const main = async () => {
  const connectionString = env.DATABASE_PUBLIC_URL || env.DATABASE_URL;
  if (!connectionString) {
    stdout.write("\nNeither DATABASE_PUBLIC_URL nor DATABASE_URL is set. Run this with the same database\n"
      + "configuration the backend uses, or the public connection string from your host.\n\n");
    exit(1);
  }

  const sql = bootstrapSql(fs.readFileSync(SERVER, "utf8"));
  const tables = declaredTables(sql);
  const columns = declaredColumns(sql);

  const require = createRequire(new URL("../../backend/package.json", import.meta.url));
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    const liveTables = (await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    )).rows.map((row) => row.table_name);
    const liveColumns = (await client.query(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'"
    )).rows.map((row) => [row.table_name, row.column_name]);

    const result = compareSchema({ tables, columns, liveTables, liveColumns });

    stdout.write(`\nDeclared by the startup bootstrap: ${result.declaredTables} tables, ${result.declaredColumns} added columns.\n`);
    stdout.write(`Present in this database: ${liveTables.length} tables.\n\n`);

    if (!result.missingTables.length && !result.missingColumns.length) {
      stdout.write("RESULT: no drift. Every table and column the bootstrap declares exists here.\n\n");
      return;
    }

    if (result.missingTables.length) {
      stdout.write(`MISSING TABLES (${result.missingTables.length}):\n`);
      for (const name of result.missingTables) stdout.write(`  ${name}\n`);
      stdout.write("\n");
    }
    if (result.missingColumns.length) {
      stdout.write(`MISSING COLUMNS (${result.missingColumns.length}):\n`);
      for (const name of result.missingColumns) stdout.write(`  ${name}\n`);
      stdout.write("\n");
    }
    stdout.write("RESULT: this database is behind the code. Each of these raises at runtime on the\n"
      + "first route that reads it, not at startup. Write a migration under\n"
      + "backend/migrations/cloud/ and register it in scripts/run-cloud-migrations.js.\n\n");
  } finally {
    client.release();
    await pool.end();
  }
};

const invokedDirectly = Boolean(argv[1]) && import.meta.url === pathToFileURL(argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    stdout.write(`\nCould not check the schema: ${error.message}\n\n`);
    exit(1);
  });
}
