#!/usr/bin/env node
/**
 * Put a backup back.
 *
 * This is the other half of `scripts/cloud/backup-cloud.mjs`, and it is not symmetrical with it.
 * Taking a copy is safe and can be done at any time for any reason. Putting one back replaces a
 * shop's books with an older version of themselves, and if it is pointed at the wrong database it
 * destroys one shop's data with another's. So this command is built to refuse.
 *
 * ## What it refuses, and why each one
 *
 *   * **It does nothing unless told twice.** Without `--apply` it reads the file, reads the target,
 *     prints exactly what would change, and stops. The dry run is the default because the wrong
 *     restore is not recoverable and the right one can wait a minute.
 *   * **It will not act on a file it cannot vouch for.** Same check as `--verify`: a missing
 *     closing summary means the backup run stopped halfway, and half a shop restored over a whole
 *     one is worse than no restore at all.
 *   * **It makes you name the database you are about to overwrite.** `--confirm-host` must match
 *     the host in the connection string. The expensive mistake here is not restoring; it is
 *     restoring into the right-looking wrong database, and a matching host typed by hand is the
 *     one check a tired person cannot pass by accident.
 *   * **It will not restore into a schema that does not fit.** The backup carries data, not table
 *     definitions. A missing table or column is named and the command stops, rather than restoring
 *     what happens to fit and leaving the rest silently absent.
 *   * **It will not empty a table the backup does not carry.** The truncate names its tables and
 *     does not cascade. A table outside the backup that points into it is named, with its row
 *     count, and the command stops until somebody names it in `--and-empty`. This one was a bug
 *     first: `TRUNCATE ... CASCADE` emptied such tables silently, on the same run that printed
 *     "left exactly as they are" about them.
 *   * **All of it, or none of it.** One transaction. A restore that stops halfway leaves a shop
 *     that is neither the old one nor the new one, and nobody can tell which rows are which.
 *
 * ## Usage
 *
 *     $env:DATABASE_PUBLIC_URL = "..."
 *     node scripts/cloud/restore-cloud.mjs --file "D:\FroozERP-Backups\froozerp-cloud-....jsonl.gz"
 *     node scripts/cloud/restore-cloud.mjs --file "..." --confirm-host <host> --apply
 *     node scripts/cloud/restore-cloud.mjs --file "..." --confirm-host <host> --and-empty <t1,t2> --apply
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import readline from "node:readline";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const pg = require("../../backend/node_modules/pg");
const { Client } = pg;

// Read dates, times and numerics as the database's own text, exactly as the backup does. Without
// this a comparison between "what is in the file" and "what is in the table" is a comparison
// between a string and a JavaScript Date, and every row looks different.
for (const oid of [1082, 1114, 1184, 1083, 1266]) pg.types.setTypeParser(oid, (value) => value);

const FORMAT = "frooz-backup/1";
const BATCH = 500;

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : "";
};
const has = (name) => argv.includes(`--${name}`);

const fail = (message) => {
  console.error(`\n${message}\n`);
  process.exit(1);
};

// ---------------------------------------------------------------------------------------------
// Read the backup
// ---------------------------------------------------------------------------------------------

const readBackup = async (file) => {
  if (!fs.existsSync(file)) fail(`No such backup file: ${file}`);
  const tables = new Map();   // name -> { columns, rows }
  let header = null;
  let summary = null;

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
      fail(`This backup file is damaged: a line in it is not readable.\n${file}`);
    }
    if (record.kind === "header") header = record;
    else if (record.kind === "summary") summary = record;
    else if (record.kind === "table") tables.set(record.name, { columns: record.columns || [], rows: [] });
    else if (record.kind === "row") {
      const table = tables.get(record.table);
      if (!table) fail(`This backup has rows for "${record.table}" before the table itself. It is not readable.`);
      table.rows.push(record.data);
    }
  }

  if (!header) fail(`This file has no header, so it is not a FroozERP backup.\n${file}`);
  if (header.format !== FORMAT) fail(`Unknown backup format ${header.format}. This tool reads ${FORMAT}.`);
  if (!summary) {
    fail(
      "This backup is INCOMPLETE — it has no closing summary, which means the run that wrote it\n"
      + "stopped before it finished. Restoring half a shop over a whole one is worse than not\n"
      + `restoring at all, so this file is refused.\n${file}`,
    );
  }
  for (const [name, expected] of Object.entries(summary.tables || {})) {
    const actual = tables.get(name)?.rows.length || 0;
    if (actual !== expected) {
      fail(`This backup does not match its own summary: ${name} has ${actual} rows, summary says ${expected}.`);
    }
  }
  return { header, summary, tables };
};

// ---------------------------------------------------------------------------------------------
// Order tables so a child is never inserted before its parent
// ---------------------------------------------------------------------------------------------

/**
 * One `TRUNCATE` over all of them at once sorts itself out, but inserts do not: `sale_items`
 * before `sales` fails on the foreign key, and the file lists tables alphabetically, which is not
 * an insert order.
 *
 * Deferring the constraints instead would need them declared DEFERRABLE (they are not) or
 * superuser (we are not), so the order is computed from the real foreign keys.
 */
export const orderByDependency = (names, foreignKeys) => {
  const remaining = new Set(names);
  const parentsOf = new Map(names.map((name) => [name, new Set()]));
  for (const { child, parent } of foreignKeys) {
    // A self-reference cannot be solved by ordering tables, only by ordering rows. It is left for
    // the caller to report rather than silently producing an order that cannot work.
    if (child === parent) continue;
    if (remaining.has(child) && remaining.has(parent)) parentsOf.get(child).add(parent);
  }

  const ordered = [];
  const placed = new Set();
  while (remaining.size) {
    const ready = [...remaining].filter((name) => [...parentsOf.get(name)].every((parent) => placed.has(parent)));
    if (!ready.length) {
      // A cycle. Report the tables involved rather than guessing; guessing here means a restore
      // that fails halfway through, which is the one outcome this command must not produce.
      return { ordered: null, cycle: [...remaining].sort() };
    }
    ready.sort();
    for (const name of ready) {
      ordered.push(name);
      placed.add(name);
      remaining.delete(name);
    }
  }
  return { ordered, cycle: null };
};

// ---------------------------------------------------------------------------------------------
// What gets emptied, and what stands in the way
// ---------------------------------------------------------------------------------------------

/**
 * Which tables this restore must empty, and which tables make that impossible without a decision.
 *
 * ## The bug this replaces
 *
 * This used to be one statement: `TRUNCATE <tables in the backup> CASCADE`. CASCADE does not mean
 * "sort the foreign keys out among these tables"; it means "and also empty every other table that
 * references them". So a table the backup had never heard of was emptied without a word -- on the
 * same run, and a few lines below, the command printed:
 *
 *     Not in this backup, and left exactly as they are:
 *       loyalty_points (2)
 *
 * Reproduced on a real PostgreSQL 16 on 2026-09-18: that line printed, `--apply` ran, and
 * `loyalty_points` went from 2 rows to 0. The closing line said "Restored 5 rows into 2 tables"
 * and never mentioned the third. The test that was meant to cover this only asserted that the
 * sentence appears in the source, which is why it passed throughout.
 *
 * And it is not a corner: the reason to restore is usually that something went wrong *after* the
 * backup was taken, which is exactly when the target has tables the backup does not.
 *
 * ## What happens instead
 *
 * The truncate names its tables and does not cascade. A table outside the backup that points into
 * it is reported by name and row count, and the command stops -- same posture as `--confirm-host`
 * and the foreign-key cycle: where the answer costs a shop its data, a person picks it, not a
 * default. Naming it in `--and-empty` is the way to say yes, and then it is emptied on purpose.
 *
 * @param {object} options
 * @param {string[]} options.fileTables   Tables the backup carries.
 * @param {string[]} options.liveTables   Tables the target database actually has.
 * @param {{child: string, parent: string}[]} options.foreignKeys  Real FKs in the public schema.
 * @param {string[]} [options.alsoEmpty]  Tables the operator named on `--and-empty`.
 */
export const planTruncate = ({ fileTables, liveTables, foreignKeys, alsoEmpty = [] }) => {
  const inBackup = new Set(fileTables);
  const live = new Set(liveTables);
  const opted = new Set(alsoEmpty.filter((name) => live.has(name) && !inBackup.has(name)));
  // Everything that will be emptied. A table named in --and-empty counts, which is what lets a
  // chain resolve: empty the child on purpose and whatever points at *it* is the next question.
  const emptied = new Set([...inBackup, ...opted]);

  const blocked = new Map();
  for (const { child, parent } of foreignKeys) {
    if (child === parent) continue;          // rows, not tables -- reported separately
    if (!live.has(child) || emptied.has(child)) continue;
    if (!emptied.has(parent)) continue;
    if (!blocked.has(child)) blocked.set(child, new Set());
    blocked.get(child).add(parent);
  }

  return {
    tables: [...fileTables].sort(),
    alsoEmpty: [...opted].sort(),
    unknown: alsoEmpty.filter((name) => !live.has(name)).sort(),
    blocked: [...blocked.entries()]
      .map(([child, parents]) => ({ child, parents: [...parents].sort() }))
      .sort((a, b) => a.child.localeCompare(b.child)),
  };
};

// ---------------------------------------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------------------------------------

/**
 * JSON gives back objects and arrays; PostgreSQL wants different things for different columns.
 *
 * The driver turns a JS array into a PostgreSQL array literal, which is right for an `ARRAY`
 * column and wrong for a `jsonb` column holding `[1,2]` — so json and jsonb are stringified here
 * rather than left to a guess. `bytea` comes out of JSON as `{type:"Buffer",data:[...]}` and has
 * to become a Buffer again or it is restored as the text of that object.
 */
export const coerce = (value, dataType) => {
  if (value === null || value === undefined) return null;
  const type = String(dataType || "").toLowerCase();
  if (type === "json" || type === "jsonb") return JSON.stringify(value);
  if (type === "bytea" && value && value.type === "Buffer" && Array.isArray(value.data)) {
    return Buffer.from(value.data);
  }
  return value;
};

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

const main = async () => {
  const file = flag("file");
  if (!file) {
    fail(
      "Which backup should be restored?\n\n"
      + '  node scripts/cloud/restore-cloud.mjs --file "D:\\FroozERP-Backups\\froozerp-cloud-....jsonl.gz"\n\n'
      + "Without --apply this only reads and reports; nothing is written.",
    );
  }
  const apply = has("apply");
  const confirmHost = flag("confirm-host");
  // Tables outside the backup that the operator accepts will be emptied. Typed out by name, for
  // the same reason --confirm-host is typed out by name: this is the flag that loses data.
  const andEmpty = (flag("and-empty") || "").split(",").map((name) => name.trim()).filter(Boolean);

  // The file is judged before the database is asked for. Whether a backup is whole is knowable
  // without credentials, and somebody checking a file they were handed should not have to produce
  // a connection string to be told it is damaged.
  const backup = await readBackup(path.resolve(file));
  const fileTables = [...backup.tables.keys()].sort();

  const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!connectionString) fail("DATABASE_PUBLIC_URL or DATABASE_URL is required.");
  const targetHost = (() => {
    try { return new URL(connectionString).host; } catch { return "unknown"; }
  })();

  const client = new Client({
    connectionString,
    ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const live = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    const liveTables = new Set(live.rows.map((row) => row.table_name));
    const liveColumns = new Map();
    for (const row of (await client.query(`
      SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public'
    `)).rows) {
      if (!liveColumns.has(row.table_name)) liveColumns.set(row.table_name, new Map());
      liveColumns.get(row.table_name).set(row.column_name, row.data_type);
    }

    // --- does the schema fit? ------------------------------------------------------------
    const missingTables = fileTables.filter((name) => !liveTables.has(name));
    const missingColumns = [];
    for (const name of fileTables) {
      if (!liveTables.has(name)) continue;
      const present = liveColumns.get(name) || new Map();
      for (const column of backup.tables.get(name).columns) {
        if (!present.has(column.column_name)) missingColumns.push(`${name}.${column.column_name}`);
      }
    }

    console.log(`\nBackup : ${path.basename(file)}`);
    console.log(`  taken at : ${backup.header.generated_at}`);
    console.log(`  taken from: ${backup.header.database_host}`);
    console.log(`Target : ${targetHost}`);
    if (backup.header.database_host !== targetHost) {
      console.log(`  NOTE: this backup was taken from a different host than the one being restored into.`);
    }

    if (missingTables.length || missingColumns.length) {
      fail(
        "This database does not have room for this backup, so nothing was attempted.\n\n"
        + (missingTables.length ? `  missing tables (${missingTables.length}): ${missingTables.join(", ")}\n` : "")
        + (missingColumns.length ? `  missing columns (${missingColumns.length}): ${missingColumns.join(", ")}\n` : "")
        + "\nA backup carries data, not table definitions. Bring the schema up to date first\n"
        + "(node scripts/run-cloud-migrations.js --apply), then restore.",
      );
    }

    // --- what would change ---------------------------------------------------------------
    console.log(`\n${"TABLE".padEnd(38)}${"IN TARGET".padStart(11)}${"IN BACKUP".padStart(11)}`);
    let targetTotal = 0;
    let fileTotal = 0;
    for (const name of fileTables) {
      const current = Number((await client.query(`SELECT COUNT(*)::INTEGER AS count FROM "${name}"`)).rows[0].count);
      const incoming = backup.tables.get(name).rows.length;
      targetTotal += current;
      fileTotal += incoming;
      const mark = current === incoming ? " " : "*";
      console.log(`${mark}${name.padEnd(37)}${String(current).padStart(11)}${String(incoming).padStart(11)}`);
    }
    console.log(`${"".padEnd(38)}${String(targetTotal).padStart(11)}${String(fileTotal).padStart(11)}`);

    // --- what will be emptied, and what refuses to be -------------------------------------
    const foreignKeys = (await client.query(`
      SELECT child.relname AS child, parent.relname AS parent
      FROM pg_constraint c
      JOIN pg_class child ON child.oid = c.conrelid
      JOIN pg_class parent ON parent.oid = c.confrelid
      JOIN pg_namespace n ON n.oid = child.relnamespace
      WHERE c.contype = 'f' AND n.nspname = 'public'
    `)).rows;

    const plan = planTruncate({
      fileTables,
      liveTables: [...liveTables],
      foreignKeys,
      alsoEmpty: andEmpty,
    });
    if (plan.unknown.length) {
      fail(`--and-empty names tables this database does not have: ${plan.unknown.join(", ")}`);
    }

    const countOf = async (name) => Number(
      (await client.query(`SELECT COUNT(*)::INTEGER AS count FROM "${name}"`)).rows[0].count,
    );

    // A table outside the backup that points into it cannot be left alone and cannot be emptied
    // without being asked about. This is where CASCADE used to answer for the operator.
    if (plan.blocked.length) {
      const described = [];
      for (const { child, parents } of plan.blocked) {
        described.push(`  ${child} (${await countOf(child)} rows) -> ${parents.join(", ")}`);
      }
      fail(
        "These tables are not in the backup, but they point at tables that are. They cannot be\n"
        + "left as they are, and they will not be emptied unless you say so. Nothing was written.\n\n"
        + `${described.join("\n")}\n\n`
        + "This usually means the backup predates a migration that added them. Either restore into\n"
        + "a database that matches the backup, or name them to be emptied as well:\n\n"
        + `  --and-empty ${plan.blocked.map((entry) => entry.child).join(",")}`,
      );
    }

    if (plan.alsoEmpty.length) {
      const described = [];
      for (const name of plan.alsoEmpty) described.push(`  ${name} (${await countOf(name)} rows)`);
      console.log(
        `\nEMPTIED because you named them in --and-empty, and not refilled by this backup:\n${described.join("\n")}`,
      );
    }

    // Tables the target has that this restore does not touch at all. Now that the truncate names
    // its tables and does not cascade, this line is true.
    const emptied = new Set([...fileTables, ...plan.alsoEmpty]);
    const populatedUntouched = [];
    for (const name of [...liveTables].filter((name) => !emptied.has(name)).sort()) {
      const count = await countOf(name);
      if (count > 0) populatedUntouched.push(`${name} (${count})`);
    }
    if (populatedUntouched.length) {
      console.log(
        `\nNot in this backup, and left exactly as they are:\n  ${populatedUntouched.join("\n  ")}`,
      );
    }

    // --- ordering ------------------------------------------------------------------------
    const selfReferencing = foreignKeys
      .filter((row) => row.child === row.parent && backup.tables.has(row.child))
      .map((row) => row.child);
    const { ordered, cycle } = orderByDependency(fileTables, foreignKeys);
    if (!ordered) {
      fail(
        "These tables reference each other in a loop, so there is no order in which their rows\n"
        + `can be inserted one table at a time:\n  ${cycle.join(", ")}\n\n`
        + "This needs a person. Nothing was written.",
      );
    }

    if (!apply) {
      console.log(
        "\nDRY RUN — nothing was written.\n\n"
        + "To restore, run again with the host named and --apply:\n\n"
        + `  node scripts/cloud/restore-cloud.mjs --file "${file}" --confirm-host ${targetHost} --apply`
        + `${plan.alsoEmpty.length ? ` --and-empty ${plan.alsoEmpty.join(",")}` : ""}\n\n`
        + `This will REPLACE every row of the ${fileTables.length} tables listed above with the rows in\n`
        + (plan.alsoEmpty.length
          ? `the backup, and EMPTY ${plan.alsoEmpty.join(", ")} without refilling them.\n`
          : "the backup.\n")
        + "It cannot be undone. Take a fresh backup of the target first:\n\n"
        + '  node scripts/cloud/backup-cloud.mjs --out "<somewhere>"\n',
      );
      return;
    }

    if (confirmHost === null) {
      fail(
        "--apply needs --confirm-host as well.\n\n"
        + `This would replace every row in ${fileTables.length} tables on:\n\n    ${targetHost}\n\n`
        + "Type that host back to show it is the database you mean:\n\n"
        + `  --confirm-host ${targetHost} --apply`,
      );
    }
    if (confirmHost !== targetHost) {
      fail(
        "The host you confirmed is not the host this command is connected to, so nothing was done.\n\n"
        + `  you confirmed : ${confirmHost || "(empty)"}\n`
        + `  connected to  : ${targetHost}\n\n`
        + "Check DATABASE_PUBLIC_URL before trying again. Restoring into the wrong database is the\n"
        + "one mistake here that destroys two shops instead of one.",
      );
    }

    // --- do it ---------------------------------------------------------------------------
    console.log(`\nRestoring into ${targetHost} ...`);
    await client.query("BEGIN");
    // One statement, so the foreign keys *between* these tables do not have to be ordered away --
    // and no CASCADE, so a foreign key from outside this list is an error rather than a silent
    // extra truncation. The tables that would have been caught by CASCADE were checked above and
    // either named in --and-empty or refused.
    const truncating = [...fileTables, ...plan.alsoEmpty];
    await client.query(`TRUNCATE ${truncating.map((name) => `"${name}"`).join(", ")}`);

    let written = 0;
    for (const name of ordered) {
      const { columns, rows } = backup.tables.get(name);
      if (!rows.length) continue;
      const columnNames = columns.map((column) => column.column_name);
      const typeByName = new Map(columns.map((column) => [column.column_name, column.data_type]));
      const quoted = columnNames.map((column) => `"${column}"`).join(", ");

      for (let start = 0; start < rows.length; start += BATCH) {
        const slice = rows.slice(start, start + BATCH);
        const values = [];
        const placeholders = slice.map((row, rowIndex) => {
          const cells = columnNames.map((column, columnIndex) => {
            values.push(coerce(row[column], typeByName.get(column)));
            return `$${rowIndex * columnNames.length + columnIndex + 1}`;
          });
          return `(${cells.join(", ")})`;
        });
        await client.query(`INSERT INTO "${name}" (${quoted}) VALUES ${placeholders.join(", ")}`, values);
      }
      written += rows.length;
      console.log(`  ${name}: ${rows.length}`);
    }

    // Every SERIAL is now behind the ids that were just inserted, and the shop's next bill would
    // collide on the primary key. This is the step whose absence only shows up at the counter.
    const sequences = (await client.query(`
      SELECT table_name, column_name, pg_get_serial_sequence(quote_ident(table_name), column_name) AS sequence
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND pg_get_serial_sequence(quote_ident(table_name), column_name) IS NOT NULL
    `)).rows.filter((row) => backup.tables.has(row.table_name));
    for (const row of sequences) {
      await client.query(
        `SELECT setval($1, GREATEST(COALESCE((SELECT MAX("${row.column_name}") FROM "${row.table_name}"), 0), 1),
                        (SELECT MAX("${row.column_name}") FROM "${row.table_name}") IS NOT NULL)`,
        [row.sequence],
      );
    }

    await client.query("COMMIT");
    console.log(`\nRestored ${written} rows into ${fileTables.length} tables, and reset ${sequences.length} id counters.`);
    if (plan.alsoEmpty.length) {
      // Said again, after the fact, because a table that lost every row and got none back is the
      // thing somebody will want to find in the scrollback tomorrow.
      console.log(`Emptied and not refilled, as named in --and-empty: ${plan.alsoEmpty.join(", ")}.`);
    }
    if (selfReferencing.length) {
      console.log(
        `\nNOTE: these tables reference themselves, so their rows were inserted in the order the\n`
        + `backup holds them: ${selfReferencing.join(", ")}. If any row here points at a row that\n`
        + `comes after it, the restore above would have failed rather than written half of it.`,
      );
    }
    console.log("\nRun a backup of this database now, so there is a copy of what it holds after the restore.\n");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    await client.end().catch(() => null);
    fail(`Restore failed. Nothing was changed — the whole restore is one transaction.\n\n  ${error.message || error}`);
  } finally {
    // In a `finally`, because the dry run returns from inside the try. Without it the connection
    // stayed open, nothing was left to do, and the command simply never exited -- which looks
    // exactly like a restore that has hung partway through, on the one command where that is the
    // most frightening thing it could look like.
    await client.end().catch(() => null);
  }
};

// Only when run as a command. The pure pieces above are imported by backend/restoreCloudCommand.test.js.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => fail(error?.stack || String(error)));
}
