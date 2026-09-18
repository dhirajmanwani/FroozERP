"use strict";

/**
 * `scripts/cloud/restore-cloud.mjs` — the refusals, which are the whole command.
 *
 * Taking a backup is safe and can be done for any reason. Putting one back replaces a shop's books
 * with an older version of themselves, and pointed at the wrong database it destroys one shop's
 * data with another's. So what is pinned here is mostly what the command declines to do.
 *
 * The round trip itself was proven on 2026-09-18 against a real PostgreSQL: a scratch shop with
 * foreign keys, SERIAL ids, NUMERIC rates, JSONB, NULLs, an embedded newline, a DATE and a table
 * named `order` was backed up, truncated with RESTART IDENTITY, restored, and came back identical
 * — and the next INSERT got id 4 rather than colliding on 1. That needs a database, so it is
 * recorded here rather than run here; these tests hold the properties that made it work.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "..", "scripts", "cloud", "restore-cloud.mjs");
const SOURCE = fs.readFileSync(SCRIPT, "utf8");

const run = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], {
  encoding: "utf8",
  env: { ...process.env, DATABASE_PUBLIC_URL: "", DATABASE_URL: "", ...env },
});

const writeBackup = (lines) => {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "frooz-restore-test-")),
    "froozerp-cloud-20260918-000000.jsonl.gz",
  );
  fs.writeFileSync(file, zlib.gzipSync(lines.map((line) => JSON.stringify(line)).join("\n") + "\n"));
  return file;
};

const header = { kind: "header", format: "frooz-backup/1", generated_at: "2026-09-18T00:00:00.000Z", database_host: "example.railway.app", tables: ["products"] };

test("it asks which file, and says a dry run writes nothing", () => {
  const result = run([]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Which backup should be restored/);
  assert.match(result.stderr, /nothing is written/);
});

test("an incomplete backup is refused before the database is even opened", () => {
  // No connection string is set in these tests, so reaching the database would fail with a
  // different message. Getting the "incomplete" refusal proves the file is judged first.
  const file = writeBackup([header, { kind: "table", name: "products", columns: [] }, { kind: "row", table: "products", data: { id: 1 } }]);
  const result = run(["--file", file]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /INCOMPLETE/);
  assert.match(result.stderr, /worse than not\nrestoring at all/);
});

test("a backup that disagrees with its own summary is refused", () => {
  const file = writeBackup([
    header,
    { kind: "table", name: "products", columns: [] },
    { kind: "row", table: "products", data: { id: 1 } },
    { kind: "summary", tables: { products: 7 }, rows_total: 7 },
  ]);
  const result = run(["--file", file]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /products has 1 rows, summary says 7/);
});

test("rows before their table are treated as an unreadable file, not skipped", () => {
  const file = writeBackup([header, { kind: "row", table: "products", data: { id: 1 } }]);
  const result = run(["--file", file]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /before the table itself/);
});

test("a good file still refuses when there is no database to talk to", () => {
  const file = writeBackup([
    header,
    { kind: "table", name: "products", columns: [] },
    { kind: "summary", tables: { products: 0 }, rows_total: 0 },
  ]);
  const result = run(["--file", file]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DATABASE_PUBLIC_URL or DATABASE_URL is required/);
});

// --------------------------------------------------------------------------------------------
// The properties that make the round trip work
// --------------------------------------------------------------------------------------------

test("nothing is written without --apply", () => {
  assert.match(SOURCE, /const apply = has\("apply"\)/);
  assert.match(SOURCE, /if \(!apply\) \{/);
  assert.match(SOURCE, /DRY RUN — nothing was written/);
  // The dry run must come before any TRUNCATE in the file, or the guard is decoration.
  assert.ok(
    SOURCE.indexOf("DRY RUN") < SOURCE.indexOf("await client.query(`TRUNCATE"),
    "the dry-run exit must be reached before anything destructive",
  );
});

test("--apply alone is not enough: the host has to be named back", () => {
  // The expensive mistake is not restoring, it is restoring into the right-looking wrong
  // database. A host typed by hand is the one check a tired person cannot pass by accident.
  assert.match(SOURCE, /if \(confirmHost === null\)/);
  assert.match(SOURCE, /if \(confirmHost !== targetHost\)/);
  assert.match(SOURCE, /destroys two shops instead of one/);
});

test("a schema that does not fit stops the command, and names what is missing", () => {
  assert.match(SOURCE, /missingTables/);
  assert.match(SOURCE, /missingColumns/);
  assert.match(SOURCE, /does not have room for this backup/);
  assert.match(SOURCE, /run-cloud-migrations/, "the refusal must name the way out");
});

test("the whole restore is one transaction", () => {
  const applyPart = SOURCE.slice(SOURCE.indexOf("Restoring into"));
  assert.match(applyPart, /await client\.query\("BEGIN"\)/);
  assert.match(applyPart, /await client\.query\("COMMIT"\)/);
  assert.match(SOURCE, /ROLLBACK/);
  assert.match(SOURCE, /Nothing was changed — the whole restore is one transaction/);
});

test("children are never inserted before their parents", () => {
  // sale_items before sales fails on the foreign key, and the file lists tables alphabetically,
  // which is not an insert order. Deferring instead would need DEFERRABLE constraints or
  // superuser, and this command has neither.
  assert.match(SOURCE, /orderByDependency/);
  assert.match(SOURCE, /contype = 'f'/, "the order comes from the real foreign keys");
  assert.match(SOURCE, /cycle/, "a loop must be reported, not guessed at");
});

test("the id counters are reset, or the shop's next bill collides", () => {
  assert.match(SOURCE, /pg_get_serial_sequence/);
  assert.match(SOURCE, /setval\(\$1/);
  assert.match(SOURCE, /only shows up at the counter/);
});

test("json, jsonb and bytea are put back as themselves", () => {
  // The driver turns a JS array into a PostgreSQL array literal, which is right for an ARRAY
  // column and wrong for a jsonb column holding [1,2].
  assert.match(SOURCE, /if \(type === "json" \|\| type === "jsonb"\) return JSON\.stringify\(value\)/);
  assert.match(SOURCE, /Buffer\.from\(value\.data\)/);
});

test("dates are read back as text on this side too", () => {
  // Otherwise "what is in the file" and "what is in the table" are a string and a Date, and every
  // row looks changed.
  assert.match(SOURCE, /setTypeParser\(oid, \(value\) => value\)/);
});

test("the connection is closed on every path, including the dry run", () => {
  // It was not, and the dry run simply never exited — which looks exactly like a restore hung
  // partway through, on the one command where that is the most frightening thing it could look
  // like.
  assert.match(SOURCE, /\} finally \{[\s\S]{0,400}await client\.end\(\)/);
});

test("tables the backup does not contain are reported, not quietly emptied", () => {
  assert.match(SOURCE, /Not in this backup, and left exactly as they are/);
});
