"use strict";

/**
 * Every cloud migration on disk is either applied by the runner or excluded on the record.
 *
 * `scripts/run-cloud-migrations.js` decides what runs by naming files one at a time. That is
 * deliberate -- these are forward-only changes to a live shop's database and a glob would apply
 * whatever happened to be in the folder -- but it means adding a migration is two steps, and
 * forgetting the second one is silent.
 *
 * It has already happened. `011_inventory_incremental_publication.sql` was written, committed, and
 * left out of the list. 011 installs `froozerp_publish_inventory_lot_sync`, the only mechanism that
 * publishes an inventory-lot change to a device -- so while it was missing, no stock movement of
 * any kind reached a counter except through a full reference bootstrap. Nothing errored. The
 * symptom would have been fruit quietly not arriving.
 *
 * So the rule is: a file is either run, or listed in `deliberatelyNotRun` with a reason somebody
 * can check. Silence is not a third option.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { migrationFiles, deliberatelyNotRun } = require("../scripts/run-cloud-migrations.js");

const MIGRATION_DIR = path.join(__dirname, "migrations", "cloud");
const onDisk = fs.readdirSync(MIGRATION_DIR).filter((name) => name.endsWith(".sql")).sort();
const applied = migrationFiles.map((file) => path.basename(file));

test("no cloud migration is silently left out of the runner", () => {
  const unaccounted = onDisk.filter(
    (name) => !applied.includes(name) && !Object.prototype.hasOwnProperty.call(deliberatelyNotRun, name),
  );
  assert.deepEqual(
    unaccounted,
    [],
    `these migrations exist but nothing decides their fate: ${unaccounted.join(", ")}. `
    + "Add each to migrationFiles, or to deliberatelyNotRun with the reason.",
  );
});

test("the runner names no migration that does not exist", () => {
  // The opposite mistake -- a name left behind after a rename -- makes the runner throw ENOENT
  // partway through, which on a real database means some migrations applied and some did not.
  const absent = applied.filter((name) => !onDisk.includes(name));
  assert.deepEqual(absent, [], `named but missing from disk: ${absent.join(", ")}`);
});

test("nothing is both applied and excluded", () => {
  const both = applied.filter((name) => Object.prototype.hasOwnProperty.call(deliberatelyNotRun, name));
  assert.deepEqual(both, [], `listed in two places, so the reason is a lie: ${both.join(", ")}`);
});

test("no migration is named twice", () => {
  // A duplicate runs the file twice in one transaction. Every migration here is written to be
  // idempotent, so today that is harmless -- but it is harmless by luck, not by design.
  const seen = new Set();
  const duplicates = applied.filter((name) => (seen.has(name) ? true : (seen.add(name), false)));
  assert.deepEqual(duplicates, [], `named more than once: ${duplicates.join(", ")}`);
});

test("every exclusion carries a reason somebody can check", () => {
  for (const [name, reason] of Object.entries(deliberatelyNotRun)) {
    assert.ok(onDisk.includes(name), `${name} is excluded but does not exist`);
    assert.ok(
      typeof reason === "string" && reason.trim().length > 30,
      `${name} is excluded with no usable reason`,
    );
  }
});

test("the migrations excluded as already-bootstrapped really are in the startup path", () => {
  // The reasons say the server creates these itself at startup. If that ever stops being true, a
  // fresh cloud database would come up missing them and nothing would say so -- the same silence
  // 011 taught us to distrust. So the claim is checked rather than believed.
  const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  const proofs = {
    "002_sync_engine_foundation.sql": "CREATE TABLE IF NOT EXISTS sync_processed_operations",
    "003_pos_sync_sale_foundation.sql": "sales_global_id_unique_idx",
    "004_auth_recovery_foundation.sql": "ADD COLUMN IF NOT EXISTS verified_email",
  };
  for (const [name, needle] of Object.entries(proofs)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(deliberatelyNotRun, name),
      `${name} is no longer excluded -- update this test alongside the runner`,
    );
    assert.ok(
      server.includes(needle),
      `${name} is excluded because the startup path covers it, but server.js no longer contains "${needle}"`,
    );
  }
});

test("every applied migration is re-runnable, because the runner applies all of them every time", () => {
  // The runner has no notion of "already applied": it replays the whole list inside one
  // transaction on every invocation. That is what makes the dry run meaningful -- it executes
  // everything for real and then rolls back -- but it only holds together if each file can be
  // applied twice. A bare CREATE TABLE or ADD CONSTRAINT would fail the second time, on the
  // maintainer's live shop database, with the earlier statements already applied in that
  // transaction.
  const bareCreate = /^\s*CREATE\s+(TABLE|INDEX|UNIQUE INDEX|TYPE|SCHEMA)\s+(?!IF NOT EXISTS)/im;
  const bareAddConstraint = /^\s*ADD\s+CONSTRAINT\s/im;

  for (const file of migrationFiles) {
    const sql = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    // Lines guarded by a preceding DROP ... IF EXISTS, or sitting inside a
    // `IF NOT EXISTS (SELECT 1 FROM pg_constraint ...)` block, are re-runnable by construction.
    const statements = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    const guardedConstraint = /IF NOT EXISTS \(\s*SELECT 1 FROM pg_constraint/i.test(statements);
    const guardedObject = /DROP (TRIGGER|INDEX|CONSTRAINT|FUNCTION) IF EXISTS/i.test(statements);

    if (bareCreate.test(statements)) {
      assert.ok(guardedObject, `${file} has a CREATE that is neither IF NOT EXISTS nor preceded by DROP IF EXISTS`);
    }
    if (bareAddConstraint.test(statements)) {
      assert.ok(
        guardedConstraint || guardedObject,
        `${file} adds a constraint without guarding against it already existing`,
      );
    }
  }
});
