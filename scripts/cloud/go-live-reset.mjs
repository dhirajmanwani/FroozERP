#!/usr/bin/env node
/**
 * Clear the test transactions out of the cloud database before the shop goes live, keeping every
 * master.
 *
 * ## What it does
 *
 * The owner decided on 30 Oct 2026: keep products, parties, staff, devices, licences, settings and
 * every other master; clear sales, purchases, lots, payments, returns, waste, orders, expenses,
 * transfers and packing transactions. `goLiveResetPlan.mjs`, next to this file, is that decision
 * table by table. This command prints it against the real database and, when told to twice,
 * carries it out.
 *
 * ## What it refuses, and why each one
 *
 *   * **Nothing changes without `--apply --confirm <database>`.** The dry run is the default. The
 *     confirm value must equal the name of the database the connection actually reached, read
 *     back with `current_database()`, not taken from the connection string.
 *   * **It reads one variable: `DATABASE_URL`.** The migration runner prefers DATABASE_PUBLIC_URL
 *     over DATABASE_URL, and that preference has already sent a command to the wrong database.
 *     Here, if DATABASE_PUBLIC_URL is also set and differs, it stops and says which to clear.
 *   * **An unclassified table stops `--apply`.** A table the plan does not name is a question
 *     nobody has answered yet; the command will not answer it by guessing.
 *   * **An unknown sync entity type stops `--apply`,** for the same reason.
 *   * **A foreign key from a kept table into a cleared one stops `--apply`.** TRUNCATE without a
 *     cascade would refuse it anyway; this says so in a sentence first.
 *   * **A TRUNCATE trigger on a cleared table stops `--apply`.** None exists today. The lot
 *     triggers of migration 011 are row-level DELETE/UPDATE/INSERT triggers, which TRUNCATE does
 *     not fire -- so no DELETE row is published for each lot, and no lot trigger can raise.
 *   * **All of it or none of it.** One transaction. Before COMMIT it checks that every cleared
 *     table is empty, that no transaction row is left in sync_change_log, and that no sequence in
 *     the schema moved. Any failure rolls the whole thing back.
 *
 * ## Usage
 *
 *     $env:DATABASE_URL = "..."                       # never pasted into chat
 *     node scripts/cloud/go-live-reset.mjs            # dry run
 *     node scripts/cloud/go-live-reset.mjs --apply --confirm <database-name>
 *     node scripts/cloud/go-live-reset.mjs --apply --confirm <database-name> --also-clear auth_audit_log,product_audit_trail:lot-events
 *
 *     --also-clear <a,b>  also empty these owner-decides tables (default: keep them all).
 *                         `product_audit_trail:lot-events` deletes only the inventory-lot rows
 *                         of product_audit_trail and keeps product edit history.
 *
 * The owner's runbook is docs/production/GO_LIVE_RESET.md. Every counter must be off before this
 * runs, and every device's local database set aside before it reconnects.
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  CACHED_COLUMNS,
  OWNER_DECIDES,
  PRODUCT_AUDIT_LOT_ACTIONS_SQL,
  PRODUCT_AUDIT_LOT_EVENT,
  SYNC_MASTER_ENTITY_TYPES,
  SYNC_TRANSACTION_ENTITY_TYPES,
  blockingForeignKeys,
  buildProductAuditLotEventSql,
  buildPruneSql,
  buildTruncateSql,
  planReset,
} from "./goLiveResetPlan.mjs";

const require = createRequire(import.meta.url);
const { Client } = require("../../backend/node_modules/pg");

// ---------------------------------------------------------------------------------------------
// Pure pieces (imported by backend/goLiveReset.test.js)
// ---------------------------------------------------------------------------------------------

/** `{ apply, confirm, alsoClear, errors }` from argv. */
export const parseArgs = (argv) => {
  const errors = [];
  const valueOf = (name) => {
    const index = argv.indexOf(`--${name}`);
    if (index === -1) return null;
    const value = argv[index + 1];
    return value && !value.startsWith("--") ? value : "";
  };
  const known = new Set(["--apply", "--confirm", "--also-clear"]);
  argv.forEach((token, index) => {
    if (!token.startsWith("--")) {
      const previous = argv[index - 1];
      if (previous !== "--confirm" && previous !== "--also-clear") errors.push(`unexpected argument '${token}'`);
    } else if (!known.has(token)) {
      errors.push(`unknown option ${token}`);
    }
  });
  const apply = argv.includes("--apply");
  const confirm = valueOf("confirm");
  if (confirm === "") errors.push("--confirm needs the database name");
  const alsoClearRaw = valueOf("also-clear");
  if (alsoClearRaw === "") errors.push("--also-clear needs a comma-separated list");
  const alsoClear = alsoClearRaw ? alsoClearRaw.split(",").map((name) => name.trim()).filter(Boolean) : [];
  if (apply && confirm === null) {
    errors.push("--apply needs --confirm <database-name>: the name of the database you mean to reset");
  }
  return { apply, confirm, alsoClear, errors };
};

/**
 * The connection string, from `DATABASE_URL` alone.
 *
 * Not the `DATABASE_PUBLIC_URL || DATABASE_URL` every other ops command uses, on purpose: that
 * preference is how the migration runner reached the wrong database. A reset that empties tables
 * gets one name to read and a refusal when a second, different one is lying around in the shell.
 */
export const resolveConnection = (env) => {
  const url = String(env.DATABASE_URL ?? "").trim();
  const publicUrl = String(env.DATABASE_PUBLIC_URL ?? "").trim();
  if (!url) {
    return {
      error: publicUrl
        ? "DATABASE_URL is not set, but DATABASE_PUBLIC_URL is. This command reads only DATABASE_URL.\n"
          + "Set DATABASE_URL to the connection string of the database you mean to reset, and clear\n"
          + "DATABASE_PUBLIC_URL:   Remove-Item Env:DATABASE_PUBLIC_URL"
        : "DATABASE_URL is not set. Set it to the connection string of the database you mean to reset.\n"
          + "(This command reads only DATABASE_URL, never DATABASE_PUBLIC_URL.)",
    };
  }
  if (publicUrl && publicUrl !== url) {
    return {
      error: "DATABASE_PUBLIC_URL and DATABASE_URL are both set and point at different places.\n"
        + "This command reads only DATABASE_URL, and will not run while a second, different database\n"
        + "name is sitting in the shell -- that mismatch is how a command once reached the wrong database.\n\n"
        + `  DATABASE_URL        -> ${describeTarget(url).label}\n`
        + `  DATABASE_PUBLIC_URL -> ${describeTarget(publicUrl).label}\n\n`
        + "If DATABASE_URL is the one you mean, clear the other:   Remove-Item Env:DATABASE_PUBLIC_URL\n"
        + "If DATABASE_PUBLIC_URL is the one you mean, copy it:    $env:DATABASE_URL = $env:DATABASE_PUBLIC_URL\n"
        + "                                        and then clear: Remove-Item Env:DATABASE_PUBLIC_URL",
    };
  }
  return { connectionString: url };
};

/** Host and database named by a connection string. Never the password. */
export const describeTarget = (connectionString) => {
  try {
    const url = new URL(connectionString);
    const host = url.hostname || "(socket)";
    const port = url.port || "5432";
    const database = decodeURIComponent(url.pathname.replace(/^\//, "")) || "(default)";
    return { host, port, database, label: `${host}:${port}/${database}` };
  } catch {
    return { host: "unknown", port: "", database: "unknown", label: "(unparseable connection string)" };
  }
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** TLS off for loopback (the rehearsal database has none), as backup-cloud.mjs does otherwise. */
export const clientConfig = (connectionString) => {
  const { host } = describeTarget(connectionString);
  if (LOOPBACK.has(host)) return { connectionString, ssl: false };
  if (/[?&]sslmode=/.test(connectionString)) return { connectionString };
  return { connectionString, ssl: { rejectUnauthorized: false } };
};

// ---------------------------------------------------------------------------------------------
// Reading the database
// ---------------------------------------------------------------------------------------------

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

const readState = async (client) => {
  const liveTables = (await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  )).rows.map((row) => row.table_name);

  const counts = {};
  for (const table of liveTables) {
    counts[table] = Number((await client.query(`SELECT COUNT(*)::BIGINT AS n FROM public.${quoteIdent(table)}`)).rows[0].n);
  }

  const entityTypeCounts = {};
  if (liveTables.includes("sync_change_log")) {
    for (const row of (await client.query(
      "SELECT entity_type, COUNT(*)::BIGINT AS n FROM sync_change_log GROUP BY entity_type ORDER BY entity_type",
    )).rows) entityTypeCounts[row.entity_type] = Number(row.n);
  }

  const foreignKeys = (await client.query(
    `SELECT src.relname AS "from", dst.relname AS "to"
     FROM pg_constraint c
     JOIN pg_class src ON src.oid = c.conrelid
     JOIN pg_class dst ON dst.oid = c.confrelid
     JOIN pg_namespace ns ON ns.oid = src.relnamespace
     WHERE c.contype = 'f' AND ns.nspname = 'public'`,
  )).rows;

  // tgtype bit 5 (32) = fires on TRUNCATE.
  const truncateTriggers = (await client.query(
    `SELECT c.relname AS table_name, t.tgname
     FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE NOT t.tgisinternal AND ns.nspname = 'public' AND (t.tgtype & 32) <> 0`,
  )).rows;

  const sequences = {};
  for (const row of (await client.query(
    "SELECT sequencename, last_value FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename",
  )).rows) sequences[row.sequencename] = row.last_value === null ? null : String(row.last_value);

  let productAuditLotEvents = 0;
  if (liveTables.includes("product_audit_trail")) {
    productAuditLotEvents = Number((await client.query(
      `SELECT COUNT(*)::BIGINT AS n FROM product_audit_trail WHERE ${PRODUCT_AUDIT_LOT_ACTIONS_SQL}`,
    )).rows[0].n);
  }

  return { liveTables, counts, entityTypeCounts, foreignKeys, truncateTriggers, sequences, productAuditLotEvents };
};

/** Everything that must stop `--apply`, given a plan and the state it came from. */
const allRefusals = (plan, state) => {
  const refusals = [...plan.refusals];
  for (const edge of blockingForeignKeys({ foreignKeys: state.foreignKeys, truncate: plan.truncate })) {
    refusals.push(`foreign key ${edge}: a table that is kept points into one that would be emptied`);
  }
  const doomed = new Set(plan.truncate);
  for (const trigger of state.truncateTriggers) {
    if (doomed.has(trigger.table_name)) {
      refusals.push(`table ${trigger.table_name} has a TRUNCATE trigger (${trigger.tgname}); this reset was not designed for it`);
    }
  }
  return refusals;
};

// ---------------------------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------------------------

const line = (text = "") => console.log(text);
const pad = (text, width) => String(text).padEnd(width);
const num = (value) => String(value).padStart(8);

const printBanner = ({ target, server, mode }) => {
  const rule = "=".repeat(78);
  line();
  line(rule);
  line(`  DATABASE : ${server.database}`);
  line(`  HOST     : ${target.host}:${target.port}${server.address ? `   (server address ${server.address})` : ""}`);
  line(`  MODE     : ${mode}`);
  line(rule);
};

const printTables = (title, tables, counts, note) => {
  const total = tables.reduce((sum, table) => sum + (counts[table] || 0), 0);
  line();
  line(`${title} -- ${tables.length} tables, ${total} rows${note ? `  (${note})` : ""}`);
  for (const table of tables) line(`  ${pad(table, 34)}${num(counts[table] || 0)}`);
};

const printPlan = (plan, state) => {
  const { counts, entityTypeCounts } = state;
  printTables("KEEP", plan.keep, counts, "not touched");
  printTables("CLEAR", plan.clear, counts, "TRUNCATE ... CONTINUE IDENTITY");
  printTables(
    "OWNER-DECIDES",
    plan.ownerDecides,
    counts,
    plan.ownerTruncate.length || plan.pruneProductAuditLotEvents ? "kept unless listed below" : "all kept; name any in --also-clear to empty it",
  );
  if (plan.ownerTruncate.length) line(`  --also-clear will empty: ${plan.ownerTruncate.join(", ")}`);
  line(`  product_audit_trail rows that are inventory-lot events: ${state.productAuditLotEvents}`
    + (plan.pruneProductAuditLotEvents ? "  -> will be deleted" : `  (kept; --also-clear ${PRODUCT_AUDIT_LOT_EVENT} deletes only these)`));

  line();
  line("sync_change_log (PRUNE) -- rows by entity type");
  const transaction = new Set(SYNC_TRANSACTION_ENTITY_TYPES);
  const master = new Set(SYNC_MASTER_ENTITY_TYPES);
  let doomedChanges = 0;
  for (const [type, count] of Object.entries(entityTypeCounts)) {
    const verdict = transaction.has(type) ? "DELETE" : master.has(type) ? "keep" : "UNKNOWN";
    if (verdict === "DELETE") doomedChanges += count;
    line(`  ${pad(type, 34)}${num(count)}   ${verdict}`);
  }
  if (!Object.keys(entityTypeCounts).length) line("  (empty)");
  line(`  -> ${doomedChanges} rows deleted, change_id sequence untouched`);

  line();
  line("Cached figures on kept tables");
  for (const entry of CACHED_COLUMNS) {
    line(`  ${entry.column}`);
    line(`      ${entry.decision}`);
  }

  if (plan.unclassified.length) {
    line();
    line(`UNCLASSIFIED -- ${plan.unclassified.length} tables`);
    for (const table of plan.unclassified) line(`  ${pad(table, 34)}${num(counts[table] || 0)}`);
  }
  if (plan.missingClear.length) {
    line();
    line(`Not present here (nothing to clear): ${plan.missingClear.join(", ")}`);
  }

  const clearRows = plan.truncate.reduce((sum, table) => sum + (counts[table] || 0), 0);
  line();
  line(`Would remove ${clearRows} rows from ${plan.truncate.length} tables and ${doomedChanges} sync_change_log rows.`);
};

const printRefusals = (refusals, heading) => {
  if (!refusals.length) return;
  line();
  line(heading);
  for (const reason of refusals) line(`  - ${reason}`);
};

const fail = (message) => {
  console.error(`\n${message}\n`);
  process.exit(1);
};

// ---------------------------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------------------------

const applyReset = async (client, { alsoClear }) => {
  // REPEATABLE READ so the before/after counts are one consistent picture: a sign-in logged by the
  // live backend mid-reset must not read as "a kept table changed". TRUNCATE empties the whole
  // table regardless of snapshot, so nothing committed by anybody else survives it.
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  try {
    // Fail rather than queue behind a running backend request for minutes.
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SET LOCAL statement_timeout = '600s'");
    // Before the first query, so the snapshot is taken after it: nothing can add a change row
    // between what this transaction sees and what it deletes. LOCK does not fix the snapshot; the
    // first SELECT inside readState does. Every FroozERP database has this table.
    await client.query("LOCK TABLE sync_change_log IN SHARE ROW EXCLUSIVE MODE");

    // Re-read inside the transaction: the plan that runs is the plan for the database as it is now.
    const state = await readState(client);
    const plan = planReset({
      liveTables: state.liveTables,
      entityTypes: Object.keys(state.entityTypeCounts),
      alsoClear,
    });
    const refusals = allRefusals(plan, state);
    if (refusals.length) throw new Error(`refused inside the transaction:\n  - ${refusals.join("\n  - ")}`);

    await client.query(buildTruncateSql(plan.truncate));

    let pruned = 0;
    if (state.liveTables.includes("sync_change_log")) {
      const prune = buildPruneSql();
      pruned = (await client.query(prune.text, prune.values)).rowCount;
    }
    let lotEvents = 0;
    if (plan.pruneProductAuditLotEvents) {
      lotEvents = (await client.query(buildProductAuditLotEventSql())).rowCount;
    }
    for (const entry of CACHED_COLUMNS) {
      if (entry.reset) await client.query(entry.reset);
    }

    // Proof before COMMIT.
    const after = await readState(client);
    const notEmpty = plan.truncate.filter((table) => after.counts[table] !== 0);
    if (notEmpty.length) throw new Error(`still has rows after the truncate: ${notEmpty.join(", ")}`);
    const leftover = SYNC_TRANSACTION_ENTITY_TYPES.filter((type) => after.entityTypeCounts[type]);
    if (leftover.length) throw new Error(`sync_change_log still has transaction rows: ${leftover.join(", ")}`);
    const moved = Object.keys(state.sequences).filter((name) => after.sequences[name] !== state.sequences[name]);
    if (moved.length) throw new Error(`a sequence moved during the reset, which it must never do: ${moved.join(", ")}`);
    const keptChanged = [
      ...plan.keep,
      ...plan.ownerDecides.filter((table) => !plan.ownerTruncate.includes(table)
        && !(plan.pruneProductAuditLotEvents && table === "product_audit_trail")),
    ]
      .filter((table) => after.counts[table] !== state.counts[table]);
    if (keptChanged.length) throw new Error(`a kept table changed row count: ${keptChanged.join(", ")}`);

    await client.query("COMMIT");
    return { before: state, after, plan, pruned, lotEvents };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw new Error(`rolled back, nothing changed: ${error?.message || error}`);
  }
};

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.errors.length) fail(`go-live reset: ${args.errors.join("; ")}\nNothing was done.`);

  const resolved = resolveConnection(process.env);
  if (resolved.error) fail(`go-live reset refused before connecting.\n\n${resolved.error}`);

  const target = describeTarget(resolved.connectionString);
  const client = new Client(clientConfig(resolved.connectionString));
  await client.connect();

  try {
    const serverRow = (await client.query(
      "SELECT current_database() AS database, host(inet_server_addr()) AS address",
    )).rows[0];
    const server = { database: serverRow.database, address: serverRow.address };

    printBanner({ target, server, mode: args.apply ? "APPLY (one transaction)" : "dry run (read only)" });

    if (args.apply && args.confirm !== server.database) {
      fail(
        `--confirm ${args.confirm} does not match the database this connection reached: ${server.database}\n`
        + "Nothing was done. Check DATABASE_URL, then confirm with the name printed above.",
      );
    }

    if (!args.apply) {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const state = await readState(client);
      await client.query("ROLLBACK");
      const plan = planReset({
        liveTables: state.liveTables,
        entityTypes: Object.keys(state.entityTypeCounts),
        alsoClear: args.alsoClear,
      });
      printPlan(plan, state);
      const refusals = allRefusals(plan, state);
      printRefusals(refusals, "--apply WOULD BE REFUSED:");
      if (!refusals.length) {
        line();
        line(`To apply: node scripts/cloud/go-live-reset.mjs --apply --confirm ${server.database}`
          + (args.alsoClear.length ? ` --also-clear ${args.alsoClear.join(",")}` : ""));
      }
      line();
      line("go-live reset dry run: nothing changed");
      return;
    }

    // Dry-run view first, so the person applying sees what is about to go.
    const preview = await readState(client);
    const previewPlan = planReset({
      liveTables: preview.liveTables,
      entityTypes: Object.keys(preview.entityTypeCounts),
      alsoClear: args.alsoClear,
    });
    printPlan(previewPlan, preview);
    const refusals = allRefusals(previewPlan, preview);
    if (refusals.length) {
      printRefusals(refusals, "REFUSED:");
      fail("go-live reset refused: nothing changed");
    }

    const result = await applyReset(client, { alsoClear: args.alsoClear });

    line();
    line("AFTER -- rows per table (before -> after)");
    for (const table of result.after.liveTables) {
      const before = result.before.counts[table] || 0;
      const after = result.after.counts[table] || 0;
      line(`  ${pad(table, 34)}${num(before)} -> ${String(after).padStart(6)}${before !== after ? "   changed" : ""}`);
    }
    line();
    line(`sync_change_log rows deleted: ${result.pruned}`);
    if (result.plan.pruneProductAuditLotEvents) line(`product_audit_trail lot-event rows deleted: ${result.lotEvents}`);
    line("Sequences: unchanged (checked before COMMIT).");
    const owner = Object.keys(OWNER_DECIDES).filter((t) => result.after.liveTables.includes(t) && !result.plan.ownerTruncate.includes(t));
    if (owner.length) line(`Owner-decides tables kept: ${owner.join(", ")}`);
    line();
    line("go-live reset committed");
  } finally {
    await client.end().catch(() => null);
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => fail(`go-live reset failed: ${error?.message || error}`));
}
