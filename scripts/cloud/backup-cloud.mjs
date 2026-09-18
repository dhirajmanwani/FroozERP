#!/usr/bin/env node
/**
 * Take the shop's cloud database down onto a machine you can hold.
 *
 * ## Why this exists
 *
 * The hosted backend has a scheduled backup. It writes into the container, which Railway replaces
 * on every deploy and from which nobody can download anything, so it was never a backup of this
 * shop's data -- and for as long as it had been deployed it had been failing every night anyway
 * (`EACCES: permission denied, mkdir '/backups'`), silently. `backend/backupLocation.js` stopped
 * that claiming to be safety. This is the thing that actually is some.
 *
 * The point is the location. A copy that lives on the same service as the original is not a
 * backup; it is a second way to lose the same thing at the same time. This command is run from a
 * machine in the shop and writes to that machine, or to whatever drive is plugged into it.
 *
 * ## What it is not
 *
 * `scripts/multibranch/export-production-snapshot-readonly.js` reads a handful of tables so a
 * person can look at them. It is for inspection and it is not a backup: it takes what somebody
 * once needed, and a backup has to take everything, including the tables nobody has thought about
 * since. This takes every base table in the schema, whatever they are.
 *
 * It also does not restore. Writing a restore into a live shop is a different and much more
 * dangerous command, and it is the next piece of work, not this one. Until it exists, this file
 * is a copy you can read, verify and hand to somebody -- say that, and do not say more.
 *
 * ## Usage
 *
 *     $env:DATABASE_PUBLIC_URL = "..."            # never pasted into chat
 *     node scripts/cloud/backup-cloud.mjs --out "D:\FroozERP-Backups"
 *     node scripts/cloud/backup-cloud.mjs --verify "D:\FroozERP-Backups\froozerp-cloud-....jsonl.gz"
 *
 *     --out <folder>     where to write. Required unless --verify.
 *     --verify <file>    re-read a backup and report what is in it. Reads no database.
 *     --keep <n>         delete older backups in that folder, keeping the newest n.
 *                        Off by default: deleting backups is not something a backup command
 *                        should do because nobody said not to.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import readline from "node:readline";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pg = require("../../backend/node_modules/pg");
const { Client } = pg;

// Dates and times are kept as the database's own text, not parsed into JavaScript Date objects.
//
// A backup is the one place where fidelity beats convenience. The driver turns a DATE into a Date
// at local midnight, and JSON then renders it as a timestamp -- `2026-09-18` comes back as
// `2026-09-18T00:00:00.000Z`, and on a machine in a negative offset it comes back as the 17th. A
// backup that moves every delivery date by a day restores a shop that never existed, and nothing
// about the file would look wrong.
//
// The same reasoning as the licence dates in backend/server.js, which are sent `to_char`ed for
// exactly this reason. Here it is done once, for every column of these types, because a backup
// does not get to know which columns matter.
for (const oid of [
  1082, // date
  1114, // timestamp without time zone
  1184, // timestamp with time zone
  1083, // time
  1266, // time with time zone
]) {
  pg.types.setTypeParser(oid, (value) => value);
}

const FORMAT = "frooz-backup/1";
const FILE_PREFIX = "froozerp-cloud-";
const FILE_SUFFIX = ".jsonl.gz";

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : "";
};

const fail = (message) => {
  console.error(`\n${message}\n`);
  process.exit(1);
};

// -------------------------------------------------------------------------------------------
// Verify: read a file back and say what is in it. No database, no network.
// -------------------------------------------------------------------------------------------

const verify = async (file) => {
  if (!fs.existsSync(file)) fail(`No such backup file: ${file}`);
  const counted = new Map();
  let header = null;
  let summary = null;
  let rows = 0;

  const lines = readline.createInterface({
    input: fs.createReadStream(file).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      fail(`This file is damaged: a line in it is not readable.\n${file}`);
    }
    if (record.kind === "header") header = record;
    else if (record.kind === "summary") summary = record;
    else if (record.kind === "row") {
      rows += 1;
      counted.set(record.table, (counted.get(record.table) || 0) + 1);
    }
  }

  if (!header) fail(`This file has no header, so it is not a FroozERP backup.\n${file}`);
  if (header.format !== FORMAT) fail(`Unknown backup format ${header.format}. This tool writes ${FORMAT}.`);

  // The summary is written last, on purpose. Its absence is the only reliable sign of a backup
  // that stopped halfway -- a truncated gzip can still decompress cleanly up to the cut.
  if (!summary) {
    fail(
      `This backup is INCOMPLETE. It has no closing summary, which means the run that wrote it\n`
      + `stopped before it finished. Do not rely on this file.\n${file}`,
    );
  }

  const mismatches = [];
  for (const [table, expected] of Object.entries(summary.tables || {})) {
    const actual = counted.get(table) || 0;
    if (actual !== expected) mismatches.push(`${table}: file has ${actual}, summary says ${expected}`);
  }
  if (mismatches.length) {
    fail(`This backup does not match its own summary:\n  ${mismatches.join("\n  ")}\n${file}`);
  }

  const size = fs.statSync(file).size;
  console.log(`\nBackup verified: ${path.basename(file)}`);
  console.log(`  taken at   : ${header.generated_at}`);
  console.log(`  host       : ${header.database_host}`);
  console.log(`  tables     : ${Object.keys(summary.tables || {}).length}`);
  console.log(`  rows       : ${rows}`);
  console.log(`  size on disk: ${(size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`\nRESULT: complete and readable.\n`);
};

// -------------------------------------------------------------------------------------------
// Backup
// -------------------------------------------------------------------------------------------

const timestamp = () => {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
};

const prune = (folder, keep) => {
  const files = fs.readdirSync(folder)
    .filter((name) => name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX))
    .sort();
  const doomed = files.slice(0, Math.max(files.length - keep, 0));
  for (const name of doomed) {
    fs.unlinkSync(path.join(folder, name));
    console.log(`  removed old backup: ${name}`);
  }
  return doomed.length;
};

const backup = async ({ outDir, keep }) => {
  const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!connectionString) fail("DATABASE_PUBLIC_URL or DATABASE_URL is required.");

  fs.mkdirSync(outDir, { recursive: true });
  const partial = path.join(outDir, `${FILE_PREFIX}${timestamp()}${FILE_SUFFIX}.partial`);
  const finished = partial.replace(/\.partial$/, "");

  const client = new Client({
    connectionString,
    ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: false },
  });
  await client.connect();

  const gzip = zlib.createGzip();
  const out = fs.createWriteStream(partial);
  gzip.pipe(out);
  const write = (record) => new Promise((resolve, reject) => {
    gzip.write(`${JSON.stringify(record)}\n`, (error) => (error ? reject(error) : resolve()));
  });

  const tables = {};
  try {
    // One consistent point in time for every table. Without this the tables are read at different
    // moments and a bill can exist in `sales` while its items are missing from `sale_items` --
    // a backup that restores into a shop that never existed.
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '600s'");

    const host = (() => {
      try { return new URL(connectionString).host; } catch { return "unknown"; }
    })();

    const tableList = (await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `)).rows.map((row) => row.table_name);

    await write({
      kind: "header",
      format: FORMAT,
      generated_at: new Date().toISOString(),
      database_host: host,           // host only: a connection string carries the password
      taken_by: os.hostname(),
      table_count: tableList.length,
      tables: tableList,
    });

    for (const table of tableList) {
      const columns = (await client.query(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
        [table],
      )).rows;
      await write({ kind: "table", name: table, columns });

      // Quoted, because a table may be named after a reserved word and this list is not curated.
      const rows = (await client.query(`SELECT * FROM "${table}"`)).rows;
      for (const row of rows) await write({ kind: "row", table, data: row });
      tables[table] = rows.length;
      console.log(`  ${table}: ${rows.length}`);
    }

    await client.query("COMMIT");

    // Last line, and the thing `--verify` looks for. A file without it was interrupted.
    await write({
      kind: "summary",
      completed_at: new Date().toISOString(),
      tables,
      rows_total: Object.values(tables).reduce((sum, count) => sum + count, 0),
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    await client.end().catch(() => null);
    gzip.destroy();
    out.destroy();
    // The half-written file keeps its `.partial` name and is deleted, so an interrupted run can
    // never be mistaken for a backup.
    fs.rmSync(partial, { force: true });
    fail(`Backup failed, and nothing was kept:\n  ${error.message || error}`);
  }

  await new Promise((resolve, reject) => {
    out.on("finish", resolve);
    out.on("error", reject);
    gzip.end();
  });
  await client.end().catch(() => null);

  // Named only once it is whole.
  fs.renameSync(partial, finished);

  const rowsTotal = Object.values(tables).reduce((sum, count) => sum + count, 0);
  const size = fs.statSync(finished).size;
  console.log(`\nWritten: ${finished}`);
  console.log(`  ${Object.keys(tables).length} tables, ${rowsTotal} rows, ${(size / 1024 / 1024).toFixed(2)} MB`);

  if (keep !== null) {
    console.log(`\nKeeping the newest ${keep} backups in this folder:`);
    const removed = prune(outDir, keep);
    if (!removed) console.log("  nothing old enough to remove");
  }

  // Reading it back is the only proof that what was written can be read. A backup nobody has
  // ever opened is a belief, not a backup.
  await verify(finished);
};

const main = async () => {
  const verifyPath = flag("verify");
  if (verifyPath) return verify(path.resolve(verifyPath));
  if (verifyPath === "") fail("--verify needs the path of a backup file.");

  const outDir = flag("out");
  if (!outDir) {
    fail(
      "Where should the backup go?\n\n"
      + '  node scripts/cloud/backup-cloud.mjs --out "D:\\FroozERP-Backups"\n\n'
      + "Pick a folder on this machine or on a drive plugged into it. A copy kept on the same\n"
      + "service as the original is not a backup.",
    );
  }
  const keepRaw = flag("keep");
  const keep = keepRaw === null ? null : Number(keepRaw);
  if (keep !== null && (!Number.isInteger(keep) || keep < 1)) {
    fail("--keep needs a whole number of backups to keep, 1 or more.");
  }
  return backup({ outDir: path.resolve(outDir), keep });
};

main().catch((error) => fail(error?.stack || String(error)));
