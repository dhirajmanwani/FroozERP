"use strict";

/**
 * What `initializeDatabase()` declares the database should contain, and how to compare that with
 * what a database actually has.
 *
 * ## Why this is a module and not a script
 *
 * `runStartupSchemaBootstrap` is hard-off on a hosted deployment (`server.js:208`), deliberately,
 * so that nothing rewrites a live shop's schema on a restart. The cost, which nobody had priced,
 * is that `initializeDatabase()` is the only place the `CREATE TABLE IF NOT EXISTS` and
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements live -- so on the cloud they have never
 * run, and the database is frozen at whatever it looked like the day it was created.
 *
 * The check that follows startup looks for a short list of required *tables* and nothing else, so
 * the server boots clean and each absence waits to be discovered by whichever route reads it
 * first. Two were found that way, each costing an evening:
 *
 *     column u.failed_login_attempts does not exist   -> every cloud sign-in answered 500
 *     relation "charge_types" does not exist          -> the reference bootstrap answered 500, so
 *                                                        no device could ever be filled
 *
 * These functions began as a diagnostic script run by hand after the damage. They live here so the
 * server can run the same comparison at startup, before a deployment goes live -- and so there is
 * one definition of "what the schema should be" rather than two that drift apart, which is the
 * failure this whole area keeps producing.
 *
 * ## What it cannot see
 *
 * Indexes, constraints, functions and triggers. It compares tables and columns, which is what both
 * known failures were. A missing index degrades; a missing column raises.
 */

/**
 * The SQL `initializeDatabase()` would run, as text.
 *
 * Bounded to that function on purpose: `server.js` is one 19.7k-line file and its route handlers
 * are full of SQL. Scanning the whole file would collect statements that were never part of the
 * schema bootstrap and report drift that does not exist.
 */
const bootstrapSql = (source) => {
  const start = source.indexOf("const initializeDatabase = async");
  if (start === -1) throw new Error("initializeDatabase() was not found in server.js");

  // `\r?\n`, not `\n`. Windows is the shipped target and the checkout there has CRLF endings, so a
  // search for "\n};\n" finds nothing and the whole check fails with "the end of
  // initializeDatabase() was not found" -- on the one machine it was written for, while passing
  // everywhere it was tested.
  const closing = /\r?\n\};\r?\n/g;
  closing.lastIndex = start;
  const match = closing.exec(source);
  if (!match) throw new Error("the end of initializeDatabase() was not found");
  return source.slice(start, match.index);
};

/** Tables the bootstrap creates. */
const declaredTables = (sql) =>
  [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/g)]
    .map(([, name]) => name.toLowerCase());

/** Columns the bootstrap adds, as `[table, column]`. */
const declaredColumns = (sql) =>
  [...sql.matchAll(/ALTER TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD COLUMN IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/g)]
    .map(([, table, column]) => [table.toLowerCase(), column.toLowerCase()]);

/**
 * Compare what is declared with what exists.
 *
 * Pure: takes the declarations and the live catalogue, returns the difference. The whole judgement
 * is here so it can be tested without a database, the way every other decision in this repository
 * is.
 *
 * A column of a table that is itself missing is not reported separately -- the table line already
 * says everything, and repeating each of its columns turns a short report into an unreadable one.
 *
 * Every name is folded to lower case on the way in, both sides. Postgres folds unquoted identifiers
 * itself, so `Users` in the source and `users` in the catalogue are one table; comparing them as
 * written would report a column that is plainly there.
 */
const compareSchema = ({ tables, columns, liveTables, liveColumns }) => {
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

/** Read the live catalogue. Two SELECTs against information_schema, nothing else. */
const readLiveSchema = async (client) => {
  const liveTables = (await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
  )).rows.map((row) => row.table_name);
  const liveColumns = (await client.query(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'"
  )).rows.map((row) => [row.table_name, row.column_name]);
  return { liveTables, liveColumns };
};

/** The whole comparison, from a copy of server.js and a connected client. */
const findSchemaDrift = async (serverSource, client) => {
  const sql = bootstrapSql(serverSource);
  const { liveTables, liveColumns } = await readLiveSchema(client);
  return compareSchema({
    tables: declaredTables(sql),
    columns: declaredColumns(sql),
    liveTables,
    liveColumns,
  });
};

/** A refusal message that says what is missing and what to do about it. */
const describeSchemaDrift = (drift) => {
  const lines = [];
  if (drift.missingTables.length) {
    lines.push(`missing tables (${drift.missingTables.length}): ${drift.missingTables.join(", ")}`);
  }
  if (drift.missingColumns.length) {
    lines.push(`missing columns (${drift.missingColumns.length}): ${drift.missingColumns.join(", ")}`);
  }
  return "This database is behind the code. "
    + lines.join("; ")
    + ". Each of these raises at runtime on the first route that reads it, not here. "
    + "Write a migration under backend/migrations/cloud/, register it in "
    + "scripts/run-cloud-migrations.js, and apply it before deploying.";
};

module.exports = {
  bootstrapSql,
  declaredTables,
  declaredColumns,
  compareSchema,
  readLiveSchema,
  findSchemaDrift,
  describeSchemaDrift,
};
