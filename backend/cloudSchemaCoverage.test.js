"use strict";

/**
 * Anything added to `initializeDatabase()` after 2026-09-21 must have a cloud migration behind it.
 *
 * ## The gap this closes
 *
 * `runStartupSchemaBootstrap` is hard-off on a hosted deployment, so `initializeDatabase()` never
 * runs there. A table or column declared only inside it exists in the code, on every counter, and
 * on any locally bootstrapped database -- and on the cloud, never. Three outages have come out of
 * that one fact:
 *
 *     users.failed_login_attempts            every cloud sign-in answered 500, for two weeks
 *     charge_types                           the reference bootstrap answered 500, so no rebuilt
 *                                            device could be filled from the cloud
 *     device_control_settings.auto_update_*  the backend refused to boot at all, for two days
 *
 * `verifyDeclaredSchema` already catches this, and the third one is proof that it works -- the
 * deployment was refused rather than going live broken. But it catches it *at deploy time*, from a
 * Railway log, after the work is merged and the maintainer is trying to ship. This suite catches
 * the same thing in `npm test`, where fixing it costs one file.
 *
 * `autoUpdateDeviceSettings.test.js` makes this check for one table. This is the general form.
 *
 * ## Why a baseline instead of "everything needs a migration"
 *
 * Most of the schema predates the migration system: 82 tables and 255 columns are declared with no
 * migration, and they need none, because they are already on the hosted database. That is measured
 * rather than assumed -- the cloud started clean on 2026-09-21, which happens only when
 * `verifyDeclaredSchema` finds no drift whatsoever, so the live database contained every one of
 * them on that date. `cloudSchemaBaseline.js` records exactly that set and nothing else.
 *
 * So the rule is narrow and checkable: **declared, and not in the baseline, means migrated.**
 *
 * ## What this cannot see
 *
 * That a migration is *correct*, or that anybody applied it. Merging a migration does not run it;
 * `node scripts/run-cloud-migrations.js --apply` does, and forgetting that is its own failure with
 * its own symptom -- the deployment refuses to start, loudly, which is the one we now have.
 * `schemaDrift.test.js` covers the comparison itself, and `cloudMigrationCoverage.test.js` covers
 * a migration existing on disk but not registered in the runner.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  bootstrapSql,
  declaredTables,
  declaredColumns,
  withoutComments,
} = require("./schemaContract");
const { migrationFiles } = require("../scripts/run-cloud-migrations.js");
const baseline = require("./cloudSchemaBaseline");

const SERVER = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const BOOTSTRAP = bootstrapSql(SERVER);

const declared = {
  tables: [...new Set(declaredTables(BOOTSTRAP))],
  columns: [...new Set(declaredColumns(BOOTSTRAP).map(([table, column]) => `${table}.${column}`))],
};

/**
 * The columns each `CREATE TABLE` names, as `Map<table, Set<column>>` (several CREATEs of one
 * table are merged).
 *
 * The body is read up to its balanced closing parenthesis and split on top-level commas, so
 * `NUMERIC(14, 2)` and `CHECK (a > 0)` stay whole. Table constraints (PRIMARY KEY (...), UNIQUE,
 * CONSTRAINT, FOREIGN KEY, CHECK, EXCLUDE) are not columns.
 */
const createTableColumns = (sql) => {
  const out = new Map();
  const pattern = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi;
  let match;
  while ((match = pattern.exec(sql))) {
    let index = pattern.lastIndex;
    let depth = 1;
    const start = index;
    while (depth > 0 && index < sql.length) {
      if (sql[index] === "(") depth += 1;
      else if (sql[index] === ")") depth -= 1;
      index += 1;
    }
    const parts = [];
    let current = "";
    let nested = 0;
    for (const character of sql.slice(start, index - 1)) {
      if (character === "(") nested += 1;
      if (character === ")") nested -= 1;
      if (character === "," && nested === 0) {
        parts.push(current);
        current = "";
      } else {
        current += character;
      }
    }
    parts.push(current);
    const table = match[1].toLowerCase();
    const columns = out.get(table) || new Set();
    for (const part of parts) {
      const word = part.trim().split(/\s+/)[0];
      if (!word || /^(PRIMARY|UNIQUE|CONSTRAINT|FOREIGN|CHECK|EXCLUDE)$/i.test(word)) continue;
      columns.add(word.replace(/"/g, "").toLowerCase());
    }
    out.set(table, columns);
  }
  return out;
};

/** Index names created by `CREATE [UNIQUE] INDEX [IF NOT EXISTS] name ON table`, as `[name, table]`. */
const createdIndexes = (sql) =>
  [...sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF NOT EXISTS)?\s+([A-Za-z_][A-Za-z0-9_]*)\s+ON\s+([A-Za-z_][A-Za-z0-9_]*)/gi)]
    .map(([, name, table]) => [name.toLowerCase(), table.toLowerCase()]);

/**
 * What the registered migrations create, read the same way the bootstrap is read.
 *
 * Comments are stripped first, for the reason `withoutComments` exists: a comment quoting
 * `CREATE TABLE IF NOT EXISTS above` once declared a table named `above` and blocked every hosted
 * deploy. A comment quoting one here would do the quieter opposite -- excuse a real column from
 * needing a migration -- so the same stripping applies on this side.
 *
 * `IF NOT EXISTS` is optional in these patterns. A migration that creates a table unconditionally
 * still carries it to the cloud; whether it is safe to re-run is a different question, and
 * `cloudMigrationCoverage.test.js` is where re-running is considered.
 */
const migrated = (() => {
  const sql = withoutComments(
    migrationFiles
      .map((file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8"))
      .join("\n"),
  );
  const tables = new Set(
    [...sql.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([A-Za-z_][A-Za-z0-9_]*)/gi)]
      .map(([, name]) => name.toLowerCase()),
  );
  const columns = new Set(
    [...sql.matchAll(/ALTER TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD COLUMN(?:\s+IF NOT EXISTS)?\s+([A-Za-z_][A-Za-z0-9_]*)/gi)]
      .map(([, table, column]) => `${table.toLowerCase()}.${column.toLowerCase()}`),
  );
  const indexes = new Set(createdIndexes(sql).map(([name]) => name));
  return { tables, columns, tableColumns: createTableColumns(sql), indexes };
})();

const excused = (name) => Object.prototype.hasOwnProperty.call(baseline.excused, name);
const baselineTables = new Set(baseline.tables);
const baselineColumns = new Set(baseline.columns);

test("a table added to the bootstrap reaches the cloud", () => {
  const stranded = declared.tables.filter(
    (name) => !baselineTables.has(name) && !migrated.tables.has(name) && !excused(name),
  );
  assert.deepEqual(
    stranded,
    [],
    `these tables are declared in initializeDatabase() but no registered cloud migration creates `
    + `them, so they will never exist on the hosted database: ${stranded.join(", ")}. `
    + "Write a migration under backend/migrations/cloud/ and register it in "
    + "scripts/run-cloud-migrations.js.",
  );
});

/**
 * Declared `table.column` names no registered migration carries.
 *
 * A column a migration's CREATE TABLE names is carried by it; saying so again as an ALTER would be
 * noise. But only *that* column: this used to excuse every ALTER on any table a migration creates,
 * so `ALTER TABLE combos ADD COLUMN ...` put in the bootstrap alone passed here -- while
 * `verifyDeclaredSchema` checks ALTER-declared columns and the hosted backend refused to boot,
 * which is the third outage in the header, back through the test meant to stop it.
 */
const strandedColumns = (columns) => columns.filter((name) => {
  const [table, column] = name.split(".");
  if (migrated.tableColumns.get(table)?.has(column)) return false;
  return !baselineColumns.has(name) && !migrated.columns.has(name) && !excused(name);
});

test("a column added to the bootstrap reaches the cloud", () => {
  const stranded = strandedColumns(declared.columns);
  assert.deepEqual(
    stranded,
    [],
    `these columns are declared in initializeDatabase() but no registered cloud migration adds `
    + `them, so the hosted backend will refuse to start once it is redeployed: ${stranded.join(", ")}. `
    + "Write a migration under backend/migrations/cloud/ and register it in "
    + "scripts/run-cloud-migrations.js.",
  );
});

test("a bootstrap CREATE TABLE of a migrated table names no column its migration lacks", () => {
  // The quieter twin of the rule above. A column added inside the bootstrap's CREATE TABLE body of
  // a table a migration also creates exists on every bootstrapped database and never on the cloud,
  // and `verifyDeclaredSchema` cannot see it (it reads only ALTER-declared columns), so the first
  // sign is a 500 at runtime. Baseline tables are left out: the cloud held them whole on the day.
  const bootstrapColumns = createTableColumns(BOOTSTRAP);
  const missing = [];
  for (const [table, columns] of bootstrapColumns) {
    if (baselineTables.has(table) || !migrated.tables.has(table)) continue;
    const carried = migrated.tableColumns.get(table) || new Set();
    for (const column of columns) {
      const name = `${table}.${column}`;
      if (!carried.has(column) && !migrated.columns.has(name) && !excused(name)) missing.push(name);
    }
  }
  assert.ok(bootstrapColumns.size > 50, `the CREATE TABLE reader found only ${bootstrapColumns.size} tables; it has stopped reading`);
  assert.deepEqual(missing, [], `the bootstrap creates these columns and no registered migration does: ${missing.join(", ")}`);
});

test("an index the bootstrap creates on a post-baseline table reaches the cloud", () => {
  // An `ON CONFLICT` target whose unique index is missing on the cloud is not a boot refusal; it is
  // a 500 on the first write (42P10), and a packing bookkeeping failure inside a bill's savepoint is
  // skipped silently. Baseline tables' indexes were on the cloud on the day it was measured.
  const stranded = createdIndexes(BOOTSTRAP)
    .filter(([name, table]) => !baselineTables.has(table) && !migrated.indexes.has(name))
    .map(([name, table]) => `${name} ON ${table}`);
  assert.ok(migrated.indexes.has("packing_purchases_client_ref_key"), "the reader sees migration indexes");
  assert.deepEqual(stranded, [], `these indexes are created in initializeDatabase() and by no registered migration: ${stranded.join(", ")}`);
});

test("the rule catches an ALTER on a table a migration creates when the migration lacks the column", () => {
  // The case the old excuse let through. `combos` is created by 024; this column is in neither its
  // CREATE TABLE nor any ALTER, so it must be reported.
  assert.deepEqual(strandedColumns(["combos.zz_added_only_in_the_bootstrap"]), ["combos.zz_added_only_in_the_bootstrap"]);
  assert.deepEqual(strandedColumns(["combos.margin_percent"]), [], "a column 024's CREATE TABLE names is carried");
  assert.deepEqual(strandedColumns(["packing_purchases.client_ref"]), [], "a column a migration ALTERs in is carried");
});

// -------------------------------------------------------------------------------------------
// The baseline has to stay honest, or the rule above quietly stops applying
// -------------------------------------------------------------------------------------------

test("the baseline names nothing the bootstrap no longer declares", () => {
  // A name left here after its table or column was renamed or dropped is a standing exemption for
  // something that does not exist. Harmless on its own, and exactly how a list like this rots into
  // a place people add things to rather than a record of one measured day.
  const orphanTables = baseline.tables.filter((name) => !declared.tables.includes(name));
  const orphanColumns = baseline.columns.filter((name) => {
    const [table] = name.split(".");
    return !declared.columns.includes(name) && declared.tables.includes(table);
  });
  assert.deepEqual(orphanTables, [], `no longer declared, so remove from the baseline: ${orphanTables.join(", ")}`);
  assert.deepEqual(orphanColumns, [], `no longer declared, so remove from the baseline: ${orphanColumns.join(", ")}`);
});

test("the baseline is the measured set, not a place to add new work", () => {
  // The date is the whole justification: the hosted database was verified drift-free on it. A
  // later date would be a claim nobody measured, so changing it is meant to feel like an edit to
  // the reasoning rather than a routine bump.
  assert.equal(baseline.recordedAt, "2026-09-21");
  assert.equal(baseline.tables.length, 82);
  assert.equal(baseline.columns.length, 255);
});

test("every excusal carries a reason somebody can check", () => {
  for (const [name, reason] of Object.entries(baseline.excused)) {
    assert.ok(
      declared.tables.includes(name) || declared.columns.includes(name),
      `${name} is excused but is not declared at all`,
    );
    assert.ok(
      typeof reason === "string" && reason.trim().length > 30,
      `${name} is excused with no usable reason`,
    );
  }
});

test("the rule catches a column added with no migration", () => {
  // The test above passes today because the tree is correct, which proves nothing about whether it
  // would notice. This drives the same comparison with a column that exists in neither the
  // baseline nor any migration.
  const invented = "sales.some_column_added_without_a_migration";
  const [table] = invented.split(".");
  const wouldStrand = !baselineColumns.has(invented)
    && !migrated.columns.has(invented)
    && !migrated.tables.has(table)
    && !excused(invented);
  assert.ok(wouldStrand, "a newly declared column must be reported as stranded");

  // And that the three ways out all work, so the message is not a dead end.
  assert.ok(baselineColumns.has("users.verified_email"), "baseline exempts");
  assert.ok(
    migrated.columns.has("device_control_settings.auto_update_enabled"),
    "a migration exempts -- 018 is what put the cloud back",
  );
});
