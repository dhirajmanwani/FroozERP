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
  return { tables, columns };
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

test("a column added to the bootstrap reaches the cloud", () => {
  const stranded = declared.columns.filter((name) => {
    const [table] = name.split(".");
    // A column of a table the migration creates is carried by that CREATE TABLE. Saying so again
    // as an ALTER would be noise, and demanding it would make this test unpassable for any new
    // table -- the same shape of unsatisfiable check that `above` was.
    if (migrated.tables.has(table)) return false;
    return !baselineColumns.has(name) && !migrated.columns.has(name) && !excused(name);
  });
  assert.deepEqual(
    stranded,
    [],
    `these columns are declared in initializeDatabase() but no registered cloud migration adds `
    + `them, so the hosted backend will refuse to start once it is redeployed: ${stranded.join(", ")}. `
    + "Write a migration under backend/migrations/cloud/ and register it in "
    + "scripts/run-cloud-migrations.js.",
  );
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
