"use strict";

/**
 * `scripts/cloud/go-live-reset.mjs` and its plan, `scripts/cloud/goLiveResetPlan.mjs`.
 *
 * The reset empties tables on the shop's cloud database, once, on the day it goes live. What
 * matters is not that it usually works but that it can only do what the owner decided: keep the
 * masters, clear the test transactions. So this suite pins the decision rather than the code:
 *
 *   - every table the backend declares is in exactly one bucket, so a new table cannot slip into
 *     the reset unexamined (the command also refuses one at run time, but here it costs one file);
 *   - masters, settings, devices and the replay guard are KEEP;
 *   - the SQL never cascades and never restarts a sequence;
 *   - no kept table has a foreign key into a cleared one;
 *   - every sync entity type the backend logs is known to be a master or a transaction type;
 *   - the command refuses before connecting when the connection is ambiguous.
 *
 * No database is needed: the plan is pure, and every spawned run is refused before it connects.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const { bootstrapSql, declaredTables, withoutComments } = require("./schemaContract");

const ROOT = path.join(__dirname, "..");
const PLAN_PATH = path.join(ROOT, "scripts", "cloud", "goLiveResetPlan.mjs");
const SCRIPT_PATH = path.join(ROOT, "scripts", "cloud", "go-live-reset.mjs");
const MIGRATIONS = path.join(__dirname, "migrations", "cloud");

const SERVER = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const BOOTSTRAP = bootstrapSql(SERVER);
const AI_SCHEMA = fs.readFileSync(path.join(__dirname, "aiBusinessAssistantSchema.js"), "utf8");
const migrationSql = fs.readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith(".sql"))
  .map((name) => ({ name, sql: withoutComments(fs.readFileSync(path.join(MIGRATIONS, name), "utf8")) }));

const loadPlan = () => import(pathToFileURL(PLAN_PATH).href);
const loadScript = () => import(pathToFileURL(SCRIPT_PATH).href);

const bucketsOf = (plan, table) => [
  ["KEEP", plan.KEEP], ["CLEAR", plan.CLEAR], ["OWNER_DECIDES", plan.OWNER_DECIDES], ["PRUNE", plan.PRUNE],
].filter(([, bucket]) => Object.hasOwn(bucket, table)).map(([name]) => name);

const migrationTables = () => [...new Set(migrationSql.flatMap(({ sql }) =>
  [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/gi)].map(([, name]) => name.toLowerCase())))];

test("every table the backend schema declares is classified exactly once", async () => {
  const plan = await loadPlan();
  const declared = [...new Set(declaredTables(BOOTSTRAP))];
  assert.ok(declared.length >= 100, `expected the bootstrap's tables to be found, got ${declared.length}`);
  for (const table of declared) {
    const buckets = bucketsOf(plan, table);
    assert.equal(buckets.length, 1, `${table} is in ${buckets.length ? buckets.join(" and ") : "no bucket"}; it must be in exactly one`);
  }
});

test("every table a cloud migration creates is classified, or deliberately left out", async () => {
  // The migration-only tables (companies, the v3 purchase/transfer protocol, device assignments)
  // exist on the cloud and nowhere in initializeDatabase(), so the bootstrap scan above cannot see
  // them.
  const plan = await loadPlan();
  const tables = migrationTables();
  assert.ok(tables.includes("companies") && tables.includes("inventory_transfers"), "migration tables were not found");
  for (const table of tables) {
    const buckets = bucketsOf(plan, table);
    if (Object.hasOwn(plan.UNCLASSIFIED_BY_DESIGN, table)) {
      assert.deepEqual(buckets, [], `${table} is declared unclassified by design and must not also be in a bucket`);
      continue;
    }
    assert.equal(buckets.length, 1, `${table} is in ${buckets.length ? buckets.join(" and ") : "no bucket"}`);
  }
});

test("the classification names no table the schema does not declare", async () => {
  // A misspelt name in CLEAR would be a refusal at run time; here it is a failing line.
  const plan = await loadPlan();
  const declared = new Set([...declaredTables(BOOTSTRAP), ...migrationTables()]);
  const named = [plan.KEEP, plan.CLEAR, plan.OWNER_DECIDES, plan.PRUNE].flatMap(Object.keys);
  assert.deepEqual(named.filter((table) => !declared.has(table)), []);
});

test("no table is in both keep and clear, or in any two buckets", async () => {
  const plan = await loadPlan();
  const seen = new Map();
  for (const [name, bucket] of Object.entries({ KEEP: plan.KEEP, CLEAR: plan.CLEAR, OWNER_DECIDES: plan.OWNER_DECIDES, PRUNE: plan.PRUNE })) {
    for (const table of Object.keys(bucket)) {
      assert.ok(!seen.has(table), `${table} is in both ${seen.get(table)} and ${name}`);
      seen.set(table, name);
    }
  }
});

test("masters, settings, devices and licences are KEEP", async () => {
  const plan = await loadPlan();
  const required = [
    "users", "roles", "role_permission_settings", "sale_permission_settings",
    "products", "product_categories", "product_photos",
    "companies", "branches", "counters", "operational_locations", "operational_location_products",
    "staff_location_assignments",
    "customers", "suppliers", "accounts",
    "authorized_devices", "device_assignments", "activation_codes", "activation_licences",
    "business_settings", "pos_settings", "payment_settings", "sale_rate_settings", "device_control_settings",
    "sale_discount_rules", "combos", "combo_items", "combo_packing",
    "packing_types", "packing_designs", "packing_sizes", "charge_types", "charge_rate_slabs", "rebate_rules",
  ];
  for (const table of required) assert.ok(Object.hasOwn(plan.KEEP, table), `${table} must be KEEP`);

  // Every *_settings table, including any added later.
  const declared = new Set([...declaredTables(BOOTSTRAP), ...migrationTables()]);
  for (const table of declared) {
    if (/_settings$/.test(table)) assert.ok(Object.hasOwn(plan.KEEP, table), `${table} is a settings table and must be KEEP`);
  }
});

test("the replay guard is kept and the change log is pruned, never truncated", async () => {
  const plan = await loadPlan();
  assert.ok(Object.hasOwn(plan.KEEP, "sync_processed_operations"), "sync_processed_operations is the replay guard");
  assert.ok(Object.hasOwn(plan.PRUNE, "sync_change_log"));
  assert.ok(!Object.hasOwn(plan.CLEAR, "sync_change_log"), "truncating sync_change_log would lose master history and invite a restart");
  assert.throws(() => plan.buildTruncateSql(["sync_change_log"]), /PRUNE/);
});

test("the transactions are CLEAR", async () => {
  const plan = await loadPlan();
  for (const table of [
    "sales", "sale_items", "sale_payments", "purchases", "purchase_items", "inventory_batches",
    "stock_transactions", "customer_ledger", "customer_payments", "supplier_payments", "sale_returns",
    "waste_entries", "customer_orders", "expenses", "inventory_transfers", "packing_purchases",
    "packing_movements", "packing_stock", "purchase_orders", "goods_receipts", "supplier_bills",
  ]) assert.ok(Object.hasOwn(plan.CLEAR, table), `${table} must be CLEAR`);
});

test("the SQL never cascades and never restarts a sequence", async () => {
  const plan = await loadPlan();
  const sql = plan.buildTruncateSql(Object.keys(plan.CLEAR));
  assert.match(sql, /^TRUNCATE TABLE /);
  assert.match(sql, / CONTINUE IDENTITY$/);
  assert.doesNotMatch(sql, /CASCADE/i);
  assert.doesNotMatch(sql, /RESTART/i);
  for (const table of Object.keys(plan.CLEAR)) assert.ok(sql.includes(`"${table}"`), `${table} missing from the truncate`);

  const prune = plan.buildPruneSql();
  assert.match(prune.text, /^DELETE FROM sync_change_log WHERE entity_type = ANY\(\$1::TEXT\[\]\)$/);
  assert.deepEqual(prune.values[0], [...plan.SYNC_TRANSACTION_ENTITY_TYPES]);
  assert.match(plan.buildProductAuditLotEventSql(), /^DELETE FROM product_audit_trail WHERE /);

  // The truncate builder refuses anything that is not cleared or owner-approved.
  assert.throws(() => plan.buildTruncateSql(["products"]), /KEEP/);
  assert.throws(() => plan.buildTruncateSql(["not_a_table"]), /unclassified/);
  assert.throws(() => plan.buildTruncateSql([]), /nothing/);
});

test("neither file can cascade, restart, or set a sequence anywhere in its code", () => {
  for (const file of [PLAN_PATH, SCRIPT_PATH]) {
    const code = withoutComments(fs.readFileSync(file, "utf8")).replace(/^\s*\*.*$/gm, "");
    for (const forbidden of [/\bCASCADE\b/, /RESTART\s+IDENTITY/i, /\bsetval\b/i, /ALTER\s+SEQUENCE/i, /DROP\s+/i]) {
      assert.doesNotMatch(code, forbidden, `${path.basename(file)} must not contain ${forbidden}`);
    }
  }
});

/**
 * Foreign keys declared by the schema, as `{ from, to }`. Read statement by statement from the
 * bootstrap, the FROST schema and every migration: a `CREATE TABLE x (... REFERENCES y ...)` or an
 * `ALTER TABLE x ... REFERENCES y`.
 */
const declaredForeignKeys = () => {
  const sources = [BOOTSTRAP, withoutComments(AI_SCHEMA), ...migrationSql.map(({ sql }) => sql)];
  const edges = [];
  for (const source of sources) {
    for (const statement of source.split(";")) {
      const owner = statement.match(/(?:CREATE TABLE(?:\s+IF NOT EXISTS)?|ALTER TABLE(?:\s+IF EXISTS)?(?:\s+ONLY)?)\s+([A-Za-z_][A-Za-z0-9_]*)/i);
      if (!owner) continue;
      for (const [, target] of statement.matchAll(/REFERENCES\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
        edges.push({ from: owner[1].toLowerCase(), to: target.toLowerCase() });
      }
    }
  }
  return edges;
};

test("no kept table has a foreign key into a cleared one", async () => {
  // TRUNCATE without a cascade refuses the whole statement if one exists, so this is not a safety
  // check -- the database is. It is a go-live check: such a key would make the reset unrunnable on
  // the day, and here it fails in `npm test` instead.
  const plan = await loadPlan();
  const edges = declaredForeignKeys();
  assert.ok(edges.length >= 50, `expected the schema's foreign keys to be found, got ${edges.length}`);
  assert.ok(edges.some(({ from, to }) => from === "sale_items" && to === "sales"), "sale_items -> sales was not found");
  assert.deepEqual(plan.blockingForeignKeys({ foreignKeys: edges, truncate: Object.keys(plan.CLEAR) }), []);
});

/** Every sync entity type the backend can write into sync_change_log. */
const loggedEntityTypes = () => {
  const found = new Set();
  const jsFiles = fs.readdirSync(__dirname).filter((name) => name.endsWith(".js") && !name.endsWith(".test.js"));
  for (const name of jsFiles) {
    const source = fs.readFileSync(path.join(__dirname, name), "utf8");
    // `entityType: "pos_sale"` and `entityType: changed ? "sale_rate" : "product"`. The AI alert
    // helpers use the same key for a linked entity, which is not a sync type; their values
    // ("customer", "purchase", "product") are all known types anyway, so including them only
    // makes this stricter.
    for (const [, expression] of source.matchAll(/entityType:\s*([^,\n}]+)/g)) {
      for (const [, literal] of expression.matchAll(/"([a-z_]+)"/g)) found.add(literal);
    }
    for (const block of source.match(/INSERT INTO sync_change_log[\s\S]{0,600}/g) || []) {
      for (const [, literal] of block.matchAll(/'([a-z_]+)',\s*\$\d+,\s*'(?:UPSERT|DELETE)'/g)) found.add(literal);
    }
  }
  for (const { sql } of migrationSql) {
    for (const block of sql.match(/INSERT INTO sync_change_log[\s\S]{0,900}/g) || []) {
      for (const [, literal] of block.matchAll(/'([a-z_]+)',\s*[a-z_.]+,\s*operation_value/g)) found.add(literal);
    }
  }
  return found;
};

test("every sync entity type the backend logs is classified as master or transaction", async () => {
  const plan = await loadPlan();
  const found = loggedEntityTypes();
  for (const expected of ["pos_sale", "inventory_lot", "location_product", "supplier", "packing_stock", "product"]) {
    assert.ok(found.has(expected), `the scan did not find '${expected}', so it is not reading what it should`);
  }
  const transaction = new Set(plan.SYNC_TRANSACTION_ENTITY_TYPES);
  const master = new Set(plan.SYNC_MASTER_ENTITY_TYPES);
  for (const type of transaction) assert.ok(!master.has(type), `${type} is both master and transaction`);
  const unknown = [...found].filter((type) => !transaction.has(type) && !master.has(type));
  assert.deepEqual(unknown, [], `unclassified sync entity types: ${unknown.join(", ")}`);
});

test("the plan refuses an unknown table, an unknown entity type, and a non-owner --also-clear", async () => {
  const plan = await loadPlan();
  const everything = [plan.KEEP, plan.CLEAR, plan.OWNER_DECIDES, plan.PRUNE].flatMap(Object.keys);

  const clean = plan.planReset({ liveTables: everything, entityTypes: ["pos_sale", "product"] });
  assert.deepEqual(clean.refusals, []);
  assert.deepEqual(clean.truncate.sort(), Object.keys(plan.CLEAR).sort());

  const newTable = plan.planReset({ liveTables: [...everything, "loyalty_points"] });
  assert.match(newTable.refusals.join("\n"), /loyalty_points is not classified/);

  const metadata = plan.planReset({ liveTables: [...everything, "cloud_sync_entity_metadata"] });
  assert.match(metadata.refusals.join("\n"), /cloud_sync_entity_metadata exists and is deliberately unclassified/);

  const newType = plan.planReset({ liveTables: everything, entityTypes: ["gift_card"] });
  assert.match(newType.refusals.join("\n"), /entity type 'gift_card'/);

  for (const name of ["products", "sales", "sync_change_log", "nonsense"]) {
    const result = plan.planReset({ liveTables: everything, alsoClear: [name] });
    assert.equal(result.refusals.length, 1, `--also-clear ${name} must be refused`);
  }
  const owner = plan.planReset({ liveTables: everything, alsoClear: ["auth_audit_log", plan.PRODUCT_AUDIT_LOT_EVENT] });
  assert.deepEqual(owner.refusals, []);
  assert.ok(owner.truncate.includes("auth_audit_log"));
  assert.equal(owner.pruneProductAuditLotEvents, true);
  assert.ok(!owner.truncate.includes("product_audit_trail"));
});

test("cached figures on kept tables are all accounted for, and none is reset by UPDATE on a cleared table", async () => {
  const plan = await loadPlan();
  assert.ok(plan.CACHED_COLUMNS.some((entry) => entry.column.startsWith("packing_stock.qty_on_hand")));
  assert.ok(plan.CACHED_COLUMNS.some((entry) => entry.column.includes("opening_balance")));
  for (const entry of plan.CACHED_COLUMNS) {
    assert.ok(entry.decision && entry.decision.length > 20, `${entry.column} needs a stated decision`);
    if (entry.reset) assert.match(entry.reset, /^UPDATE /, `${entry.column}: a reset must be an UPDATE`);
  }
});

// ---------------------------------------------------------------------------------------------
// The command itself: refusals that happen before any connection
// ---------------------------------------------------------------------------------------------

// Port 1 on loopback: nothing listens, so if a refusal ever stopped happening first, the run would
// fail on connect rather than reach a database.
const NOWHERE = "postgres://postgres@127.0.0.1:1/golive_test";

const run = (args, env) => spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
  encoding: "utf8",
  env: { ...process.env, DATABASE_URL: "", DATABASE_PUBLIC_URL: "", ...env },
});

test("it reads only DATABASE_URL and refuses when DATABASE_PUBLIC_URL differs", () => {
  const differs = run([], { DATABASE_URL: NOWHERE, DATABASE_PUBLIC_URL: "postgres://u@db.example:5432/railway" });
  assert.equal(differs.status, 1);
  assert.match(differs.stderr, /refused before connecting/);
  assert.match(differs.stderr, /DATABASE_PUBLIC_URL and DATABASE_URL are both set/);
  assert.match(differs.stderr, /Remove-Item Env:DATABASE_PUBLIC_URL/);
  assert.doesNotMatch(differs.stderr, /ECONNREFUSED/);

  const onlyPublic = run([], { DATABASE_PUBLIC_URL: NOWHERE });
  assert.equal(onlyPublic.status, 1);
  assert.match(onlyPublic.stderr, /DATABASE_URL is not set, but DATABASE_PUBLIC_URL is/);

  const neither = run([], {});
  assert.equal(neither.status, 1);
  assert.match(neither.stderr, /DATABASE_URL is not set/);
});

test("--apply without --confirm is refused before connecting", () => {
  const result = run(["--apply"], { DATABASE_URL: NOWHERE });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--apply needs --confirm <database-name>/);
  assert.doesNotMatch(result.stderr, /ECONNREFUSED/);
});

test("unknown options are refused", () => {
  const result = run(["--cascade"], { DATABASE_URL: NOWHERE });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown option --cascade/);
});

test("the pure pieces of the command", async () => {
  const script = await loadScript();
  assert.deepEqual(script.parseArgs(["--apply", "--confirm", "railway"]).errors, []);
  assert.equal(script.parseArgs(["--apply", "--confirm", "railway"]).confirm, "railway");
  assert.deepEqual(script.parseArgs(["--also-clear", "auth_audit_log, backup_logs"]).alsoClear, ["auth_audit_log", "backup_logs"]);
  assert.match(script.parseArgs(["--apply", "--confirm"]).errors.join(";"), /--confirm needs/);

  assert.deepEqual(script.resolveConnection({ DATABASE_URL: "postgres://a@h/x" }), { connectionString: "postgres://a@h/x" });
  assert.deepEqual(
    script.resolveConnection({ DATABASE_URL: "postgres://a@h/x", DATABASE_PUBLIC_URL: "postgres://a@h/x" }),
    { connectionString: "postgres://a@h/x" },
    "the same string under both names is not ambiguous",
  );
  assert.ok(script.resolveConnection({ DATABASE_URL: "postgres://a@h/x", DATABASE_PUBLIC_URL: "postgres://a@h/y" }).error);

  const target = script.describeTarget("postgres://user:secret@db.example:6543/railway");
  assert.deepEqual([target.host, target.port, target.database], ["db.example", "6543", "railway"]);
  assert.doesNotMatch(target.label, /secret/, "the password must never be printed");

  assert.equal(script.clientConfig("postgres://p@127.0.0.1:55432/x").ssl, false);
  assert.deepEqual(script.clientConfig("postgres://p@db.example/x").ssl, { rejectUnauthorized: false });
});

test("the runbook exists and covers the order that matters", () => {
  const doc = fs.readFileSync(path.join(ROOT, "docs", "production", "GO_LIVE_RESET.md"), "utf8");
  for (const needle of [
    "backup-cloud.mjs", "go-live-reset.mjs", "--confirm", "froozerp-local.sqlite3", "device-anchor.json",
  ]) assert.ok(doc.includes(needle), `GO_LIVE_RESET.md must mention ${needle}`);
  assert.ok(doc.indexOf("backup-cloud.mjs") < doc.indexOf("--apply"), "the backup must come before the apply");
});
