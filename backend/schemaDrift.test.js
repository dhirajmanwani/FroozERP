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

/**
 * A migration that recreates a bootstrap table must recreate the whole of it.
 *
 * ## What went wrong once already
 *
 * Migration 015 copied the `CREATE TABLE` for five tables out of `initializeDatabase()` and
 * stopped there. But a table in that function is not only its CREATE TABLE. `customer_orders` is
 * followed by an added column, a backfill, two `ALTER COLUMN`s and a third index -- the whole
 * order routing split -- so copying the CREATE alone reproduced the table as it looked before that
 * work, on a live shop's cloud.
 *
 * The first version of this test compared CREATE TABLE bodies, so it watched 015 do exactly that
 * and passed. The drift checker did not catch it either: it found the added column only after 015
 * created the table (a column of a missing table is deliberately not reported), and it cannot see
 * the rest at all -- it compares tables and columns, and `branch_id NOT NULL DEFAULT 1` is a column
 * that exists. What was left on the cloud was a table that puts an unassigned order onto branch 1
 * and onto the sync road: the exact confusion `docs/order-routing-decision.md` exists to remove.
 *
 * ## The rule
 *
 * For every table a registered migration creates, every statement in `initializeDatabase()` that
 * names that table must also appear in the migrations. Not the column list -- the statements: the
 * CREATE, the ALTERs, the indexes and the backfills, because between them they are the table.
 *
 * Tables a migration creates that the bootstrap does not are out of scope: they came from a
 * migration in the first place and have no bootstrap definition to agree with.
 */

/** Every statement in a piece of SQL that names `table`, normalised for comparison. */
const statementsNaming = (sql, table) => {
  // Comments differ freely between the two files and whitespace does not carry meaning; a
  // statement is otherwise compared as written, so a changed type or a dropped NOT NULL is a
  // difference.
  const normalise = (text) => text.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim().replace(/;$/, "");
  const patterns = [
    new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}\\s*\\([^;]*\\);`, "gi"),
    new RegExp(`ALTER TABLE\\s+${table}\\s+[^;]*;`, "gi"),
    new RegExp(`CREATE (?:UNIQUE )?INDEX IF NOT EXISTS\\s+[^;]*?\\bON ${table}\\b[^;]*;`, "gi"),
    new RegExp(`UPDATE\\s+${table}\\s+[^;]*;`, "gi"),
  ];
  return new Set(patterns.flatMap((pattern) => [...sql.matchAll(pattern)].map(([text]) => normalise(text))));
};

const createdTables = (sql) =>
  [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/gi)].map(([, name]) => name.toLowerCase());

test("every migration that recreates a bootstrap table recreates all of it", async () => {
  const { bootstrapSql } = await import(modulePath);
  const { migrationFiles } = require(path.join(__dirname, "..", "scripts", "run-cloud-migrations.js"));

  const bootstrap = bootstrapSql(SERVER);
  const bootstrapTables = new Set(createdTables(bootstrap));

  // Everything the runner applies, as one body of SQL -- a table may legitimately be created by
  // one migration and corrected by a later one, which is exactly what 015 and 016 do.
  const applied = migrationFiles
    .map((file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8"))
    .join("\n");

  const covered = [...new Set(createdTables(applied))].filter((table) => bootstrapTables.has(table));
  assert.ok(covered.length >= 5, `expected the migrations to recreate bootstrap tables, found ${covered.length}`);

  const missing = [];
  for (const table of covered) {
    const declared = statementsNaming(bootstrap, table);
    const reproduced = statementsNaming(applied, table);
    for (const statement of declared) {
      if (!reproduced.has(statement)) missing.push(`${table}: ${statement}`);
    }
  }

  assert.deepEqual(
    missing,
    [],
    "initializeDatabase() runs these against a bootstrapped database and no migration runs them "
      + "against the cloud, so the hosted table is not the table the code expects:\n  "
      + missing.join("\n  "),
  );
});

test("the statement extractor sees more than the CREATE TABLE", () => {
  // Without this the test above passes on an extractor that returns nothing -- the failure mode of
  // every comparison that iterates a list -- and it would have passed on one that returns only the
  // CREATE, which is the bug it exists to catch.
  const sql = [
    "CREATE TABLE IF NOT EXISTS example (",
    "  id SERIAL PRIMARY KEY,",
    "  branch_id INTEGER NOT NULL DEFAULT 1",
    ");",
    "-- a comment naming example, which is not a statement",
    "ALTER TABLE example ADD COLUMN IF NOT EXISTS taken_at_branch_id INTEGER;",
    "ALTER TABLE example ALTER COLUMN branch_id DROP NOT NULL;",
    "CREATE INDEX IF NOT EXISTS example_idx ON example (id);",
    "UPDATE example SET taken_at_branch_id = branch_id WHERE taken_at_branch_id IS NULL;",
    "CREATE TABLE IF NOT EXISTS example_items ( id SERIAL PRIMARY KEY );",
    "ALTER TABLE example_items ADD COLUMN IF NOT EXISTS note TEXT;",
  ].join("\n");

  const found = statementsNaming(sql, "example");
  assert.equal(found.size, 5, `expected the CREATE, two ALTERs, the index and the backfill, got ${[...found].join(" | ")}`);
  assert.ok([...found].some((s) => s.startsWith("CREATE TABLE IF NOT EXISTS example (")));
  assert.ok(found.has("ALTER TABLE example ALTER COLUMN branch_id DROP NOT NULL"));
  assert.ok(found.has("CREATE INDEX IF NOT EXISTS example_idx ON example (id)"));
  // A longer sibling table must not be collected as this one.
  assert.ok(![...found].some((s) => s.includes("example_items")), "example_items is a different table");
});

test("a changed declaration is a difference, not a match", () => {
  // The comparison must be on the statement, not on the column name: `branch_id NOT NULL DEFAULT 1`
  // and a nullable `branch_id` are the same column and different tables, and that difference is
  // precisely what reached the shop's cloud.
  const bootstrap = "CREATE TABLE IF NOT EXISTS example (\n  branch_id INTEGER\n);";
  const migration = "CREATE TABLE IF NOT EXISTS example (\n  branch_id INTEGER NOT NULL DEFAULT 1\n);";
  const declared = [...statementsNaming(bootstrap, "example")][0];
  assert.ok(!statementsNaming(migration, "example").has(declared), "a changed column must not compare equal");
});
