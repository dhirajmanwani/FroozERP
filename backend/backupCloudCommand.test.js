"use strict";

/**
 * `scripts/cloud/backup-cloud.mjs` — what it refuses, and what it can prove about a file.
 *
 * This is the shop's only copy of its own data that lives anywhere other than the service holding
 * the original, so the property that matters is not "it usually works". It is that a file this
 * command calls a backup is complete, and that a file it cannot vouch for is refused loudly rather
 * than counted.
 *
 * No database is needed for any of it: the verifier reads a file, so the tests write files.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const SCRIPT = path.join(__dirname, "..", "scripts", "cloud", "backup-cloud.mjs");
const SOURCE = fs.readFileSync(SCRIPT, "utf8");

const run = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], {
  encoding: "utf8",
  // A deliberately empty database environment: nothing here may ever reach a real database.
  env: { ...process.env, DATABASE_PUBLIC_URL: "", DATABASE_URL: "", ...env },
});

const writeBackup = (lines) => {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "frooz-backup-test-")),
    "froozerp-cloud-20260918-000000.jsonl.gz",
  );
  fs.writeFileSync(file, zlib.gzipSync(lines.map((line) => JSON.stringify(line)).join("\n") + "\n"));
  return file;
};

const header = { kind: "header", format: "frooz-backup/1", generated_at: "2026-09-18T00:00:00.000Z", database_host: "example.railway.app", tables: ["products"] };
const productRow = (id) => ({ kind: "row", table: "products", data: { id, product_name: `p${id}` } });

test("a complete backup verifies, and says what is in it", () => {
  const file = writeBackup([
    header,
    { kind: "table", name: "products", columns: [{ column_name: "id" }] },
    productRow(1),
    productRow(2),
    { kind: "summary", completed_at: "2026-09-18T00:00:01.000Z", tables: { products: 2 }, rows_total: 2 },
  ]);
  const result = run(["--verify", file]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /complete and readable/);
  assert.match(result.stdout, /rows       : 2/);
});

test("a backup with no closing summary is refused as incomplete", () => {
  // The whole reason the summary is written last. A gzip truncated mid-run still decompresses
  // cleanly up to the cut, so "it opened" proves nothing; the missing last line is the only
  // reliable evidence that the run stopped early.
  const file = writeBackup([header, { kind: "table", name: "products", columns: [] }, productRow(1)]);
  const result = run(["--verify", file]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /INCOMPLETE/);
  assert.match(result.stderr, /Do not rely on this file/);
});

test("a backup that disagrees with its own summary is refused, and names the table", () => {
  const file = writeBackup([
    header,
    { kind: "table", name: "products", columns: [] },
    productRow(1),
    { kind: "summary", completed_at: "x", tables: { products: 9 }, rows_total: 9 },
  ]);
  const result = run(["--verify", file]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /products: file has 1, summary says 9/);
});

test("a damaged file is refused rather than partly counted", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frooz-backup-test-"));
  const file = path.join(dir, "froozerp-cloud-20260918-000000.jsonl.gz");
  fs.writeFileSync(file, zlib.gzipSync(`${JSON.stringify(header)}\n{"kind":"row" this is not json\n`));
  const result = run(["--verify", file]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /damaged/);
});

test("a file that is not a FroozERP backup is not treated as one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frooz-backup-test-"));
  const file = path.join(dir, "random.jsonl.gz");
  fs.writeFileSync(file, zlib.gzipSync(`${JSON.stringify({ kind: "row", table: "x", data: {} })}\n`));
  const result = run(["--verify", file]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no header/);
});

test("it will not guess where to write, and says why the folder matters", () => {
  const result = run([]);
  assert.match(result.stderr, /Where should the backup go/);
  assert.match(
    result.stderr,
    /not a backup/,
    "the refusal should say why a folder on this machine is the point, not just demand an argument",
  );
});

test("--keep refuses a value that would delete everything", () => {
  for (const value of ["0", "-1", "2.5", "all"]) {
    const result = run(["--out", os.tmpdir(), "--keep", value]);
    assert.notEqual(result.status, 0, `--keep ${value} was accepted`);
    assert.match(result.stderr, /whole number/);
  }
});

test("retention is off unless asked for", () => {
  // A backup command that deletes backups because nobody said not to is a backup command that
  // loses backups.
  assert.match(SOURCE, /const keep = keepRaw === null \? null : Number\(keepRaw\)/);
  assert.match(SOURCE, /if \(keep !== null\)/, "pruning must be conditional on --keep being given");
});

test("only files this command wrote are ever deleted", () => {
  const prune = SOURCE.slice(SOURCE.indexOf("const prune ="), SOURCE.indexOf("const backup ="));
  assert.match(prune, /startsWith\(FILE_PREFIX\)/);
  assert.match(prune, /endsWith\(FILE_SUFFIX\)/);
});

test("every table is taken, not a chosen list", () => {
  // The existing snapshot command reads the tables somebody once needed. A backup has to take the
  // ones nobody has thought about since, which is most of them by the time it matters.
  assert.match(SOURCE, /FROM information_schema\.tables/);
  assert.match(SOURCE, /table_type = 'BASE TABLE'/);
});

test("the read is one consistent point in time, and cannot write", () => {
  // Without a single snapshot, a bill can be read from `sales` while its items are missing from
  // `sale_items`, and the backup restores into a shop that never existed.
  assert.match(SOURCE, /BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/);
});

test("an interrupted run leaves nothing that could be mistaken for a backup", () => {
  assert.match(SOURCE, /\.partial/, "the file is written under a partial name");
  assert.match(SOURCE, /fs\.renameSync\(partial, finished\)/, "and renamed only when whole");
  assert.match(SOURCE, /fs\.rmSync\(partial, \{ force: true \}\)/, "and removed on failure");
});

test("the written file is read back before the command claims success", () => {
  const backupFn = SOURCE.slice(SOURCE.indexOf("const backup ="), SOURCE.indexOf("const main ="));
  // `partial`, not `finished`: the read-back is a gate in front of the rename, not a report after
  // it. The ordering this depends on is asserted on its own further down.
  assert.match(backupFn, /await verify\(partial, /, "a backup nobody has opened is a belief, not a backup");
});

test("the connection string never reaches the file or the screen", () => {
  // It carries the password. The host alone says which database a backup came from, and that is
  // all a person needs when they are looking at a folder of files months later.
  assert.match(SOURCE, /database_host: host/);
  assert.match(SOURCE, /new URL\(connectionString\)\.host/, "only the host is taken from it");

  // The value itself must never be printed or written. The env var NAMES appear all over this
  // file, correctly, so the check is on the variable holding the value.
  const printed = [...SOURCE.matchAll(/console\.(?:log|error|warn)\([^\n]*connectionString[^\n]*/g)];
  assert.deepEqual(printed.map((match) => match[0]), [], "the connection string is never printed");
  const written = [...SOURCE.matchAll(/write\(\{[\s\S]{0,400}?connectionString/g)];
  assert.deepEqual(written.map(() => "written"), [], "the connection string is never written into the backup");
});

test("calendar days come back as calendar days, and times keep their precision", () => {
  // Proven against a real PostgreSQL on 2026-09-18: without these parsers a DATE of 2026-09-18
  // was written as "2026-09-18T00:00:00.000Z", which on a machine in a negative offset reads back
  // as the 17th. A backup that moves every delivery date by a day restores a shop that never
  // existed, and nothing about the file would look wrong.
  //
  // The same failure the licence dates hit in backend/server.js, where the fix was to_char. Here
  // it is the driver's parsers, because a backup does not get to know which columns matter.
  const oids = [...SOURCE.matchAll(/^\s*(\d{4}), \/\/ (.+)$/gm)].map((match) => Number(match[1]));
  for (const oid of [1082, 1114, 1184, 1083, 1266]) {
    assert.ok(oids.includes(oid), `type ${oid} is still parsed into a JavaScript Date`);
  }
  assert.match(SOURCE, /pg\.types\.setTypeParser\(oid, \(value\) => value\)/, "they must be kept as the database's own text");
});

// -------------------------------------------------------------------------------------------
// Behaviour, not source text. The bugs below were both live while this file was green, because
// every test in it asserted that the source says something rather than that the command does it.
// -------------------------------------------------------------------------------------------

const importScript = () => import(pathToFileURL(SCRIPT).href);

test("a destination that cannot be written to fails the caller, and does not kill the process", async () => {
  // `gzip.pipe(out)` does not forward the destination's errors and nothing listened for them, so
  // a drive that filled up or was pulled out arrived as an unhandled 'error' event and took the
  // process down where it stood -- skipping the catch that rolls back, closes the connection and
  // deletes the half-written `.partial`.
  //
  // A directory stands in for the unwritable destination because it errors the same way on both
  // Windows and Linux: the stream fails on open instead of on write, through the same handler.
  const { createBackupWriter } = await importScript();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "frooz-backup-writer-"));

  const writer = createBackupWriter(directory);
  await assert.rejects(
    async () => {
      for (let index = 0; index < 50; index += 1) await writer.write({ kind: "row", table: "t", data: { index } });
      await writer.finish();
    },
    (error) => typeof error.code === "string",
    "the failure has to arrive as a rejection the command can catch",
  );
  writer.destroy();

  // The point of the test: we are still here to make the assertion.
  assert.ok(true, "the process survived a destination that could not be written to");
});

test("a destination that runs out of space fails the caller too", { skip: !fs.existsSync("/dev/full") }, async () => {
  // The real shape of the bug -- ENOSPC part-way through, after the stream opened fine. /dev/full
  // accepts an open and fails every write, which is what a full USB stick does.
  const { createBackupWriter } = await importScript();
  const writer = createBackupWriter("/dev/full");
  await assert.rejects(
    async () => {
      for (let index = 0; index < 20000; index += 1) {
        await writer.write({ kind: "row", table: "t", data: { index, pad: "x".repeat(200) } });
      }
      await writer.finish();
    },
    (error) => error.code === "ENOSPC",
  );
  writer.destroy();
  assert.ok(true, "the process survived a full destination");
});

test("a backup is read back before it is named, and before --keep deletes anything", () => {
  // Order, and the order is the whole point: verify used to run last, so the file was given its
  // final name while still unproven and --keep could delete a good backup to make room for a bad
  // one. A check that runs after the irreversible steps is a report, not a gate.
  const body = SOURCE.slice(SOURCE.indexOf("const backup = async ("));
  const verifyAt = body.indexOf("await verify(partial");
  const renameAt = body.indexOf("fs.renameSync(partial, finished)");
  const pruneAt = body.indexOf("prune(outDir, keep)");
  assert.ok(verifyAt > 0 && renameAt > 0 && pruneAt > 0, "all three steps still exist");
  assert.ok(verifyAt < renameAt, "the file is read back before it is given its real name");
  assert.ok(verifyAt < pruneAt, "nothing old is deleted before the new backup has been read back");
});
