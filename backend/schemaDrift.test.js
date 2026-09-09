"use strict";

/**
 * The drift between what `initializeDatabase()` declares and what the cloud database has.
 *
 * ## Why a checker exists at all
 *
 * `runStartupSchemaBootstrap` is hard-off on a hosted deployment (server.js:208), and
 * `initializeDatabase()` is the only place the `CREATE TABLE IF NOT EXISTS` and
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements live. So on the cloud they have never run:
 * that database is frozen at the day it was created, and everything added since exists in the code
 * and nowhere else. The startup check that follows looks for missing tables only, so the server
 * boots clean and each absence waits for whichever route reads it first.
 *
 * Two were found that way, each costing an evening:
 *
 *     column u.failed_login_attempts does not exist   -> every cloud sign-in answered 500
 *     relation "charge_types" does not exist          -> the reference bootstrap answered 500, so
 *                                                        no device could ever be filled from cloud
 *
 * Eighty-eight tables and two hundred and sixty-eight added columns are declared there. Finding
 * them one at a time from Railway logs is not a method.
 *
 * ## What is tested
 *
 * The decision, not the database. `compareSchema` takes declarations and a catalogue and returns
 * the difference, so every rule below holds on any machine rather than only where a cloud database
 * happens to be reachable.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const modulePath = pathToFileURL(
  path.join(__dirname, "..", "scripts", "cloud", "check-schema-drift.mjs"),
).href;
const SERVER = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

test("the declarations are read from initializeDatabase, not from the whole file", async () => {
  // server.js is one 19.7k-line file and its route handlers are full of SQL. Scanning all of it
  // would collect statements that were never part of the schema bootstrap and report drift that
  // does not exist.
  const { bootstrapSql, declaredTables, declaredColumns } = await import(modulePath);
  const sql = bootstrapSql(SERVER);

  assert.ok(sql.startsWith("const initializeDatabase"), "the slice must begin at the function");
  assert.ok(sql.length < SERVER.length / 1.5, "and must be a slice, not the file");

  const tables = declaredTables(sql);
  const columns = declaredColumns(sql);
  assert.ok(tables.length > 50, `expected the full table list, got ${tables.length}`);
  assert.ok(columns.length > 200, `expected the full column list, got ${columns.length}`);

  // The two that actually bit, by name.
  assert.ok(tables.includes("charge_types"), "charge_types is declared and was missing on the cloud");
  assert.ok(
    columns.some(([table, column]) => table === "users" && column === "failed_login_attempts"),
    "users.failed_login_attempts is declared and was missing on the cloud",
  );
});

test("a database that has everything reports nothing", async () => {
  // The shape of a false alarm: a checker that always finds drift gets ignored, and then the real
  // drift is ignored with it.
  const { bootstrapSql, declaredTables, declaredColumns, compareSchema } = await import(modulePath);
  const sql = bootstrapSql(SERVER);
  const tables = declaredTables(sql);
  const columns = declaredColumns(sql);

  const result = compareSchema({ tables, columns, liveTables: tables, liveColumns: columns });
  assert.deepEqual(result.missingTables, []);
  assert.deepEqual(result.missingColumns, []);
});

test("the columns of a missing table are not listed again", async () => {
  // A missing table already says everything about its columns. Repeating each one turns a short,
  // actionable report into a wall nobody reads -- and `charge_types` alone would have contributed
  // several.
  const { compareSchema } = await import(modulePath);
  const result = compareSchema({
    tables: ["charge_types", "users"],
    columns: [["charge_types", "charge_name"], ["users", "failed_login_attempts"]],
    liveTables: ["users"],
    liveColumns: [["users", "id"]],
  });
  assert.deepEqual(result.missingTables, ["charge_types"]);
  assert.deepEqual(result.missingColumns, ["users.failed_login_attempts"], "only columns of tables that exist");
});

test("case and duplicates do not create phantom drift", async () => {
  // Postgres folds unquoted identifiers to lower case, and the bootstrap declares a few names more
  // than once. Either would otherwise report a column that is plainly there.
  const { compareSchema } = await import(modulePath);
  const result = compareSchema({
    tables: ["Users", "users"],
    columns: [["Users", "Locked_Until"], ["users", "locked_until"]],
    liveTables: ["users"],
    liveColumns: [["users", "locked_until"]],
  });
  assert.deepEqual(result.missingTables, []);
  assert.deepEqual(result.missingColumns, []);
});

test("the checker only reads", async () => {
  // It runs against a live shop's database, usually when something is already wrong. It must not be
  // capable of making that worse.
  const source = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "cloud", "check-schema-drift.mjs"),
    "utf8",
  );

  // Only what is handed to the driver. The file necessarily *mentions* CREATE TABLE and ALTER TABLE
  // -- those are the patterns it searches server.js for -- and a check over the whole text reports
  // its own parser as a write. That is the difference between naming a statement and running one.
  const executed = [...source.matchAll(/client\.query\(\s*("([^"]*)"|`([^`]*)`)/g)]
    .map(([, , doubleQuoted, backticked]) => doubleQuoted ?? backticked ?? "");
  assert.ok(executed.length >= 2, "the checker must still run its two catalogue queries");

  for (const statement of executed) {
    assert.match(statement, /^\s*SELECT\b/i, `the checker may only SELECT, found: ${statement.slice(0, 60)}`);
  }
  assert.ok(executed.some((s) => s.includes("information_schema.tables")));
  assert.ok(executed.some((s) => s.includes("information_schema.columns")));
});

test("a Windows checkout is parsed too", async () => {
  // The shipped target is Windows and its checkout has CRLF endings. The first version searched for
  // "\n};\n" and therefore found nothing there -- the command failed with "the end of
  // initializeDatabase() was not found" on the one machine it exists to serve, while passing on
  // every machine it was tested on.
  const { bootstrapSql, declaredTables } = await import(modulePath);

  const crlf = SERVER.replace(/\r?\n/g, "\r\n");
  const lf = SERVER.replace(/\r\n/g, "\n");

  const fromCrlf = declaredTables(bootstrapSql(crlf));
  const fromLf = declaredTables(bootstrapSql(lf));

  assert.ok(fromLf.length > 50, "sanity: the LF form must still parse");
  assert.deepEqual(fromCrlf, fromLf, "both line endings must yield the same declarations");
});
