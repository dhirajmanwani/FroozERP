"use strict";

/**
 * The PowerShell backup/restore commands must not go back to reporting success after failing.
 *
 * Three defects in these scripts were reproduced against a real PostgreSQL 16 before this suite was
 * written. Restoring a good dump into a database the backend had already started against -- the
 * normal case, since server.js bootstraps its schema with CREATE TABLE IF NOT EXISTS -- gave:
 *
 *     users=2  products=3  sales=2        restored
 *     inventory_batches=0  sale_items=0   silently empty
 *
 * Every invoice, not one line item, no stock. pg_restore exited 1 and restore-postgres.ps1 printed
 * its success object anyway, because $ErrorActionPreference = "Stop" does not apply to native
 * executables. verify-row-counts.ps1 would not have been believed either way: its per-table
 * try/catch has the same blind spot, so a psql that cannot connect produced `[int]$null` -> 0 and
 * reported every table as `{ rowCount = 0; status = "ok" }`.
 *
 * These are source assertions, not behaviour tests, and the distinction matters. The gates run on
 * Linux with no PowerShell, so nothing here executes these scripts; the behaviour was verified by
 * hand (both restore refusals, the all-or-nothing rollback, a truncated dump, a dead connection,
 * and a round trip that catches both row-count drift and content drift). What this suite defends is
 * narrower and worth defending: that the specific flags and checks which make that behaviour
 * possible are still present, so removing one fails a gate instead of quietly restoring the bug.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const CLOUD_DIR = path.join(__dirname, "..", "scripts", "cloud");
const read = (name) => fs.readFileSync(path.join(CLOUD_DIR, name), "utf8");

/** Commands that run pg_dump, pg_restore, psql, createdb or dropdb. */
const NATIVE_PG_COMMANDS = [
  "backup-postgres.ps1",
  "restore-postgres.ps1",
  "verify-row-counts.ps1",
  "verify-restore-roundtrip.ps1",
];

test("every command checks the exit status of the pg tools it runs", () => {
  // The bug this prevents is the whole reason the suite exists: a native command that fails is not
  // a PowerShell error, so without an explicit check the script carries on and reports success.
  for (const name of NATIVE_PG_COMMANDS) {
    assert.match(
      read(name),
      /\$LASTEXITCODE\s*-ne\s*0/,
      `${name} must test $LASTEXITCODE — $ErrorActionPreference does not catch a failing pg_dump/pg_restore/psql`,
    );
  }
});

test("restore is all-or-nothing", () => {
  const source = read("restore-postgres.ps1");
  assert.match(
    source,
    /--single-transaction/,
    "restore-postgres.ps1 must restore inside one transaction, or a failure leaves a half-restored shop",
  );
  assert.match(
    source,
    /--exit-on-error/,
    "restore-postgres.ps1 must stop at the first error — without it pg_restore continues past the failures that empty the child tables",
  );
});

test("restore refuses a target that already holds tables", () => {
  const source = read("restore-postgres.ps1");
  assert.match(
    source,
    /relkind\s*=\s*'r'/,
    "restore-postgres.ps1 must count existing tables in the target before restoring",
  );
  assert.match(
    source,
    /AllowNonEmptyTarget/,
    "overriding the empty-target check must be an explicit, named decision",
  );
});

test("a dump is read back before it is called a backup", () => {
  // A custom-format dump truncated half-way still exists and still has a non-zero length, which is
  // all the old script checked.
  assert.match(
    read("backup-postgres.ps1"),
    /pg_restore --list/,
    "backup-postgres.ps1 must read the finished dump back, not just check that the file is non-empty",
  );
  assert.match(
    read("backup-postgres.ps1"),
    /\.partial/,
    "backup-postgres.ps1 must write to a .partial name and rename only once the dump is whole",
  );
});

test("row counts come from the catalogue, not a hand-written list", () => {
  const source = read("verify-row-counts.ps1");
  assert.match(
    source,
    /pg_class/,
    "verify-row-counts.ps1 must read its table list from the database — the old 17-name list covered a fifth of the schema",
  );
  // The named tables below were all outside that list. Each one is business data whose loss the old
  // verification had nothing to say about.
  for (const table of ["sale_batch_allocations", "customer_ledger", "supplier_payments"]) {
    assert.ok(
      !new RegExp(`"${table}"`).test(source),
      `${table} must not be hardcoded — the list is read from the database now`,
    );
  }
});

test("a count that could not be read is never reported as zero", () => {
  const source = read("verify-row-counts.ps1");
  assert.match(
    source,
    /TryParse/,
    "verify-row-counts.ps1 must parse counts explicitly — [int] on an empty string is 0, which reads as an honest empty table",
  );
  assert.ok(
    !/\[int\]\$parts\[1\]/.test(source),
    "casting the raw field to [int] is what turned a failed psql into 'rowCount = 0, status = ok'",
  );
});

test("the round trip refuses to run anywhere but a local, disposable database", () => {
  const source = read("verify-restore-roundtrip.ps1");
  assert.match(
    source,
    /createdb/,
    "the round trip restores into a scratch database of its own",
  );
  assert.match(
    source,
    /Refusing to run against/,
    "the round trip creates and drops databases, so it must refuse a non-local host outright",
  );
});

test("the round trip compares contents, not only row counts", () => {
  const source = read("verify-restore-roundtrip.ps1");
  assert.match(
    source,
    /--data-only/,
    "row counts agree on a restore that put the right number of wrong rows back",
  );
  assert.match(
    source,
    /\\\\restrict/,
    "PostgreSQL 17+ writes a random \\restrict token into every dump; without filtering it two identical databases compare as different",
  );
});
