"use strict";

/**
 * A backup that fails must leave a trace where somebody will see it.
 *
 * The hosted backend failed its scheduled backup every night with
 * `EACCES: permission denied, mkdir '/backups'`, and nothing in the product said so. Two separate
 * reasons, both fixed here and both worth holding still:
 *
 *   1. `ensureDirectory(backupDirectory)` was the first statement of `createDatabaseBackup`,
 *      before the `backup_logs` row was written. A backup that could not start therefore left no
 *      row at all, and Settings > Backup -- which reads that table -- kept showing the last
 *      success as though nothing had happened since.
 *   2. The scheduler's only reaction was `console.error`, in a container log nobody reads.
 *
 * The path bug itself is `backend/backupLocation.test.js`. This file is about whether anybody
 * finds out.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SERVER = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

const backupFunction = () => {
  const start = SERVER.indexOf("const createDatabaseBackup = async (");
  assert.notEqual(start, -1, "createDatabaseBackup is gone");
  const end = SERVER.indexOf("\nconst cleanupOldBackups", start);
  assert.notEqual(end, -1, "could not find the end of createDatabaseBackup");
  return SERVER.slice(start, end);
};

test("the backup log row is written before anything can fail", () => {
  const body = backupFunction();
  const insertAt = body.indexOf("INSERT INTO backup_logs");
  const ensureAt = body.indexOf("await ensureDirectory(backupDirectory)");
  assert.notEqual(insertAt, -1, "the RUNNING row must still be written");
  assert.notEqual(ensureAt, -1, "the backup directory must still be created");
  assert.ok(
    insertAt < ensureAt,
    "creating the directory before the log row is how a nightly failure left no trace for weeks",
  );
});

test("a directory that cannot be created is recorded as FAILED, not thrown away", () => {
  const body = backupFunction();
  const tryAt = body.indexOf("  try {");
  const ensureAt = body.indexOf("await ensureDirectory(backupDirectory)");
  assert.ok(tryAt !== -1 && ensureAt > tryAt, "the directory creation must sit inside the try");
  assert.match(body, /status = 'FAILED'/, "the failure path must still write FAILED");
  assert.match(body, /error_message = \$1/, "and must record why");
});

test("the backup directory is resolved by the tested rule, not rebuilt inline", () => {
  assert.match(SERVER, /resolveBackupLocation\(\{ dirname: __dirname/);
  assert.doesNotMatch(
    SERVER,
    /BACKUP_DIR \|\| path\.join\(__dirname, "\.\.", "backups"\)/,
    'the inline expression resolved to "/backups" in the container and must not come back',
  );
});

test("a deployment where backups mean nothing says so at startup and in the settings payload", () => {
  assert.match(SERVER, /console\.warn\(`\[backup\] \$\{backupLocation\.warning\}`\)/, "startup must say it");
  assert.match(SERVER, /backupDurable: backupLocation\.durable/, "the app must be able to say it too");
  assert.match(SERVER, /backupLocationWarning: backupLocation\.warning/);
});
