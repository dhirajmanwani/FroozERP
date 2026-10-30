"use strict";

/**
 * Frooz Pack: the rules in `froozPack.js`, its routes against a real Postgres (PGlite) built from
 * cloud migrations 024 and 025 themselves, and the bill paths (recordSalePackingUsage,
 * restoreSalePacking) against the same database.
 *
 * Pinned here (scratchpad CONTRACT.md, 22 Oct 2026):
 *   - Type > Design > Size, names trimmed and unique among active siblings (409
 *     PACKING_NAME_TAKEN), size_name one of PETITE/CLASSIC/GRAND/ROYAL (400
 *     PACKING_SIZE_NAME_INVALID), a duplicate active (design, size_name, capacity) is 409.
 *   - a purchase raises the session branch's counts, sets each size's unit cost to the line rate,
 *     writes ONE 'Packing Material' expense for the total, stores its id, and publishes
 *     packing_stock and packing_type. That expense cannot be cancelled (409 PACKING_PURCHASE_EXPENSE).
 *   - a bill's packing_usage takes packing out of the counts (negative allowed), once; malformed
 *     rows are skipped and audited, never thrown; a cancel puts it back once.
 *   - GET /api/v3/packing is the company's tree with the session branch's counts.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pack = require("./froozPack");
const {
  loadServerApp,
  probe,
  setQueryResponder,
  clearQueryResponder,
  setConnectionResponder,
  clearConnectionResponder,
} = require("./routeAuthCoverage");
const { issueDeviceSession } = require("./deviceSession");

const { CODES } = pack;

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

test("validate: names are trimmed and required, 1..80 letters", () => {
  assert.deepEqual(pack.validateTypeInput({ name: "  Gift   Box " }).value, { name: "Gift Box", active: null, sort_order: null });
  assert.equal(pack.validateTypeInput({ name: " " }).code, CODES.NAME_REQUIRED);
  assert.equal(pack.validateTypeInput({ name: "x".repeat(81) }).code, CODES.NAME_REQUIRED);
  assert.equal(pack.validateTypeInput({ name: "x".repeat(80) }).ok, true);
  assert.equal(pack.validateTypeInput({ name: "Box", active: false, sort_order: 3 }).value.active, false);
  assert.equal(pack.validateDesignInput({ name: "Window" }).code, CODES.PARENT_INVALID, "a new design needs its type");
  assert.equal(pack.validateDesignInput({ name: "Window" }, { updating: true }).ok, true, "an update may keep its type");
  assert.deepEqual(pack.validateDesignInput({ type_id: "packing-type-3", name: "Window" }).value.type_ref, { ref: "packing-type-3", intId: null });
  assert.deepEqual(pack.validateDesignInput({ type_id: 3, name: "Window" }).value.type_ref, { ref: "3", intId: 3 });
  assert.equal(pack.validateDesignInput({ type_id: "003", name: "W" }).value.type_ref.intId, null, "ids are opaque: '003' is not 3");
});

test("validate: a size is one of the four names, with free capacity and a unit cost of zero or more", () => {
  const size = pack.validateSizeInput({ design_id: 1, size_name: "grand", capacity: " 1  kg ", unit_cost: "12.505" });
  assert.equal(size.ok, true);
  assert.equal(size.value.size_name, "GRAND");
  assert.equal(size.value.capacity, "1 kg");
  assert.equal(size.value.unit_cost, 12.51);
  assert.equal(pack.validateSizeInput({ design_id: 1, size_name: "MEDIUM" }).code, CODES.SIZE_NAME_INVALID);
  assert.equal(pack.validateSizeInput({ design_id: 1, size_name: "" }).code, CODES.SIZE_NAME_INVALID);
  assert.equal(pack.validateSizeInput({ design_id: 1, size_name: "PETITE", unit_cost: -1 }).code, CODES.INPUT_INVALID);
  assert.equal(pack.validateSizeInput({ design_id: 1, size_name: "PETITE", capacity: "x".repeat(41) }).code, CODES.INPUT_INVALID);
  assert.equal(pack.validateSizeInput({ design_id: 1, size_name: "ROYAL" }).value.unit_cost, null, "absent: 0 on create, kept on update");
  assert.deepEqual(pack.PACKING_SIZE_NAMES, ["PETITE", "CLASSIC", "GRAND", "ROYAL"]);
});

test("validate: a purchase needs a mode, a date, lines above zero and a total above zero", () => {
  const good = pack.validatePurchaseInput({
    supplier_name: " Box Co ", payment_mode: "upi",
    lines: [{ size_id: "packing-size-1", quantity: "10", rate: "2.255" }, { size_id: 2, quantity: 0.5, rate: 0 }],
  }, { today: "2026-10-22" });
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.equal(good.value.purchase_date, "2026-10-22", "defaults to today");
  assert.equal(good.value.payment_mode, "UPI");
  assert.equal(good.value.supplier_name, "Box Co");
  assert.deepEqual(good.value.lines.map((line) => [line.size_ref.ref, line.quantity, line.rate, line.amount]), [
    ["packing-size-1", 10, 2.26, 22.6],
    ["2", 0.5, 0, 0],
  ]);
  assert.equal(good.value.amount, 22.6);
  const base = { payment_mode: "CASH", lines: [{ size_id: 1, quantity: 1, rate: 5 }] };
  const refusals = [
    { ...base, payment_mode: "CREDIT" },
    { ...base, purchase_date: "2026-02-30" },
    { ...base, purchase_date: "22/10/2026" },
    { ...base, lines: [] },
    { ...base, lines: [{ size_id: 1, quantity: 0, rate: 5 }] },
    { ...base, lines: [{ size_id: 1, quantity: 1, rate: -5 }] },
    { ...base, lines: [{ quantity: 1, rate: 5 }] },
    { ...base, lines: [{ size_id: 1, quantity: 1, rate: 5 }, { size_id: "1", quantity: 1, rate: 5 }] },
    { ...base, lines: [{ size_id: 1, quantity: 1, rate: 0 }] },
  ];
  for (const body of refusals) {
    const result = pack.validatePurchaseInput(body, { today: "2026-10-22" });
    assert.equal(result.ok, false, JSON.stringify(body));
    assert.equal(result.code, CODES.PURCHASE_INVALID, JSON.stringify(body));
  }
});

test("validate: an adjustment is signed, not zero, and needs a reason", () => {
  assert.deepEqual(pack.validateAdjustmentInput({ size_id: 4, quantity: "-2.5", reason: " damaged " }).value, {
    size_ref: { ref: "4", intId: 4 }, quantity: -2.5, reason: "damaged",
  });
  assert.equal(pack.validateAdjustmentInput({ size_id: 4, quantity: 0, reason: "x" }).code, CODES.ADJUSTMENT_INVALID);
  assert.equal(pack.validateAdjustmentInput({ size_id: 4, quantity: 1 }).code, CODES.ADJUSTMENT_INVALID);
  assert.equal(pack.validateAdjustmentInput({ quantity: 1, reason: "x" }).code, CODES.ADJUSTMENT_INVALID);
});

test("validate: a bill's packing usage is read leniently -- bad rows are set aside, never thrown", () => {
  const { rows, skipped } = pack.readSalePackingUsage([
    { combo_line_key: "k1", combo_id: "combo-3", source: "FIXED", packing_size_id: "packing-size-1", quantity: 2.0004, unit_cost: "12.5", size_name: "grand" },
    { packing_size_id: "", quantity: 1 },
    { packing_size_id: "packing-size-2", quantity: -1 },
    { packing_size_id: "packing-size-2", quantity: "lots" },
    null,
    "box",
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantity, 2);
  assert.equal(rows[0].unit_cost, 12.5);
  assert.equal(rows[0].size_name, "GRAND");
  assert.deepEqual(skipped.map((entry) => entry.reason), ["SIZE_MISSING", "QUANTITY_INVALID", "QUANTITY_INVALID", "NOT_AN_OBJECT", "NOT_AN_OBJECT"]);
  assert.deepEqual(pack.readSalePackingUsage(undefined), { rows: [], skipped: [] });
  assert.deepEqual(pack.readSalePackingUsage({ a: 1 }).skipped.map((entry) => entry.reason), ["NOT_A_LIST"]);
});

// ---------------------------------------------------------------------------------------------
// Schema: cloud migration 025
// ---------------------------------------------------------------------------------------------

const COMBO_MIGRATION = fs.readFileSync(path.join(__dirname, "migrations", "cloud", "024_combos.sql"), "utf8");
const MIGRATION = fs.readFileSync(path.join(__dirname, "migrations", "cloud", "025_frooz_pack.sql"), "utf8");
const SERVER_SOURCE = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const CLIENT_REF_MIGRATION = fs.readFileSync(path.join(__dirname, "migrations", "cloud", "026_packing_purchase_client_ref.sql"), "utf8");

test("schema: 026 is registered after 025 and is in the bootstrap word for word", () => {
  const files = require("../scripts/run-cloud-migrations").migrationFiles;
  assert.ok(files.indexOf("backend/migrations/cloud/026_packing_purchase_client_ref.sql") > files.indexOf("backend/migrations/cloud/025_frooz_pack.sql"));
  const statementsOf = (sql) => sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").replace(/\s+/g, " ").trim();
  assert.ok(statementsOf(SERVER_SOURCE).includes(statementsOf(CLIENT_REF_MIGRATION)), "initializeDatabase() carries 026 word for word");
  assert.doesNotMatch(statementsOf(CLIENT_REF_MIGRATION), /\b(INSERT|DELETE|UPDATE)\s+(INTO\s+)?[a-z_]+\s/i, "026 changes no rows");
});

test("schema: 025 is registered after 024, identical to the bootstrap, and has no foreign key to sales or expenses", () => {
  const files = require("../scripts/run-cloud-migrations").migrationFiles;
  assert.ok(files.indexOf("backend/migrations/cloud/025_frooz_pack.sql") > files.indexOf("backend/migrations/cloud/024_combos.sql"));
  const statementsOf = (sql) => sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").replace(/\s+/g, " ").trim();
  assert.ok(statementsOf(SERVER_SOURCE).includes(statementsOf(MIGRATION)), "initializeDatabase() carries 025 word for word");
  assert.doesNotMatch(MIGRATION, /REFERENCES\s+(sales|expenses)\b/);
  assert.doesNotMatch(statementsOf(MIGRATION), /CHECK \(qty_on_hand/, "a count may go negative: sales never stop for packing");
});

// ---------------------------------------------------------------------------------------------
// Routes, against PGlite holding migrations 024 and 025 (each applied twice)
// ---------------------------------------------------------------------------------------------

const app = loadServerApp();
const TEST_SIGNING_KEY = "route-auth-coverage-isolated-signing-key-000000";
const OWNER_ID = 7;
const DEVICE_ID = "FZDEV-PACK";
const tokenFor = ({ branchId = 1, companyId = 1, role = "Owner" } = {}) => issueDeviceSession({
  userId: OWNER_ID, deviceId: DEVICE_ID, companyId, branchId, role, secret: TEST_SIGNING_KEY,
});
const headersFor = (options) => ({ authorization: `Bearer ${tokenFor(options)}`, "content-type": "application/json" });
const headers = headersFor();

const normalise = (sql) => String(typeof sql === "object" && sql ? sql.text : sql || "").replace(/\s+/g, " ").trim();
const rows = (list) => ({ rows: list, rowCount: list.length });
const writes = (statements) => statements.filter(({ sql }) => /^(INSERT|UPDATE|DELETE)\b/i.test(sql));
const USER_SQL = /FROM users u JOIN roles r/;

const deviceScope = (sql, state) => {
  if (/FROM authorized_devices d/i.test(sql)) {
    return rows([{
      device_id: DEVICE_ID, device_status: "APPROVED", company_id: state.companyId, branch_id: state.branchId,
      operational_location_id: 10, assignment_generation: 1, fixed_operational: true, intended_usage: "POS",
      device_permissions: {}, device_assignment_active: true, location_active: true, branch_active: true,
      role_id: 1, is_default: true, staff_permissions: {}, staff_assignment_active: true, role_name: state.role,
    }]);
  }
  if (/SELECT session_revocation_version FROM users/i.test(sql)) return rows([{ session_revocation_version: 0 }]);
  return undefined;
};

const SCHEMA = `
  CREATE TABLE products (
    id INTEGER PRIMARY KEY, global_id VARCHAR(80), product_name TEXT, unit TEXT, active BOOLEAN DEFAULT TRUE,
    deleted_at TIMESTAMP, company_id INTEGER
  );
  CREATE TABLE sale_items (id SERIAL PRIMARY KEY, sale_id INTEGER);
  CREATE TABLE sales (id INTEGER PRIMARY KEY, branch_id INTEGER, invoice_no TEXT);
  CREATE TABLE branches (id INTEGER PRIMARY KEY, company_id INTEGER, active BOOLEAN DEFAULT TRUE);
  CREATE TABLE sync_change_log (
    change_id BIGSERIAL PRIMARY KEY, company_id INTEGER, branch_id INTEGER, operational_location_id INTEGER,
    assignment_generation INTEGER, entity_type TEXT, entity_id TEXT, operation_type TEXT, entity_version INTEGER,
    payload JSONB, created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE expenses (
    id SERIAL PRIMARY KEY, expense_date DATE NOT NULL DEFAULT CURRENT_DATE, category VARCHAR(120) NOT NULL,
    amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0), payment_mode VARCHAR(30) NOT NULL DEFAULT 'CASH',
    reference_number VARCHAR(120), vendor_name VARCHAR(160), remarks TEXT, branch_id INTEGER, created_by INTEGER,
    active BOOLEAN DEFAULT TRUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(20) DEFAULT 'ACTIVE', paid_to VARCHAR(160), cancelled_by INTEGER, cancelled_at TIMESTAMP,
    cancellation_reason TEXT
  );
  CREATE TABLE expense_audit_trail (
    id SERIAL PRIMARY KEY, expense_id INTEGER, action TEXT, old_value JSONB, new_value JSONB, reason TEXT, changed_by INTEGER
  );
  CREATE TABLE sale_audit_trail (
    id SERIAL PRIMARY KEY, sale_id INTEGER, action TEXT, field_name TEXT, old_value JSONB, new_value JSONB,
    reason TEXT, edited_by INTEGER, approved_by INTEGER
  );
  INSERT INTO branches VALUES (1, 1, TRUE), (2, 1, TRUE), (3, 2, TRUE);
`;

/** The same change rows `logSyncChange` / `logMasterDataSyncChange` write, for the direct-call tests. */
const directDeps = () => {
  const log = async (client, { branchId, entityType, entityId, operationType = "UPSERT", version = 1, payload = {} }) => {
    const result = await client.query(
      `INSERT INTO sync_change_log (company_id, branch_id, entity_type, entity_id, operation_type, entity_version, payload)
       VALUES ((SELECT company_id FROM branches WHERE id = $1), $1, $2, $3, $4, $5, $6::jsonb) RETURNING change_id`,
      [branchId, entityType, String(entityId), operationType, version, JSON.stringify(payload)]
    );
    return result.rows[0];
  };
  return { logSyncChange: log, logMasterDataSyncChange: log, anchorBranchId: async () => 1, today: () => "2026-10-22" };
};

const openDatabase = async () => {
  const { PGlite } = require("@electric-sql/pglite");
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(COMBO_MIGRATION);
  await db.exec(MIGRATION);
  await db.exec(CLIENT_REF_MIGRATION);
  await db.exec(COMBO_MIGRATION);
  await db.exec(MIGRATION);
  await db.exec(CLIENT_REF_MIGRATION);
  return db;
};

const withPack = async (run, { role = "Owner", companyId = 1, branchId = 1 } = {}) => {
  const db = await openDatabase();
  const statements = [];
  const state = { role, companyId, branchId };
  const query = async (text, values) => {
    const sql = normalise(text);
    statements.push({ sql, values: values || [] });
    const scoped = deviceScope(sql, state);
    if (scoped) return scoped;
    if (USER_SQL.test(sql)) return rows([{ id: OWNER_ID, full_name: "Rig", username: "rig", branch_id: 1, role_name: state.role, permissions: {} }]);
    const result = await db.query(typeof text === "object" && text ? text.text : text, values || []);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  };
  setQueryResponder((sql, values) => query(sql, values));
  setConnectionResponder(() => ({ query, release: () => {} }));
  try {
    return await run({ db, statements, state });
  } finally {
    clearQueryResponder();
    clearConnectionResponder();
    await db.close();
  }
};

const call = (method, url, body, extraHeaders = headers) => probe(app, method, url, extraHeaders, body);
const count = async (db, sql) => Number((await db.query(sql)).rows[0].n);

/** Gift Box > Window Box > Grand 1 kg and Petite, through the routes. */
const buildTree = async () => {
  const type = await call("POST", "/api/v3/packing/types", { name: " Gift Box " });
  assert.equal(type.status, 201, JSON.stringify(type.body));
  const design = await call("POST", "/api/v3/packing/designs", { type_id: type.body.type.global_id, name: "Window Box" });
  assert.equal(design.status, 201, JSON.stringify(design.body));
  const grand = await call("POST", "/api/v3/packing/sizes", { design_id: design.body.design.global_id, size_name: "grand", capacity: "1 kg", unit_cost: 10 });
  assert.equal(grand.status, 201, JSON.stringify(grand.body));
  const petite = await call("POST", "/api/v3/packing/sizes", { design_id: design.body.design.id, size_name: "PETITE" });
  assert.equal(petite.status, 201, JSON.stringify(petite.body));
  return { type: type.body.type, design: design.body.design, grand: grand.body.size, petite: petite.body.size };
};

test("schema: 025 applies twice on top of 024 and every table is there", async () => {
  const db = await openDatabase();
  try {
    const tables = (await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'packing_%' OR table_name IN ('combo_packing', 'sale_packing_usage') ORDER BY table_name"
    )).rows.map((row) => row.table_name);
    assert.deepEqual(tables, [
      "combo_packing", "packing_designs", "packing_movements", "packing_purchase_lines", "packing_purchases",
      "packing_sizes", "packing_stock", "packing_types", "sale_packing_usage",
    ]);
  } finally {
    await db.close();
  }
});

test("routes: the Owner builds Type > Design > Size; global ids, numeric ids and the tree read back", async () => {
  await withPack(async ({ db }) => {
    const { type, design, grand, petite } = await buildTree();
    assert.equal(type.global_id, `packing-type-${type.id}`);
    assert.equal(type.name, "Gift Box");
    assert.equal(design.global_id, `packing-design-${design.id}`);
    assert.deepEqual([grand.global_id, grand.size_name, grand.capacity, grand.unit_cost, grand.qty_on_hand], [`packing-size-${grand.id}`, "GRAND", "1 kg", 10, 0]);
    assert.equal(petite.unit_cost, 0, "an absent unit cost is 0 on create");

    const listed = await call("GET", "/api/v3/packing");
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.types.length, 1);
    assert.deepEqual(listed.body.types[0].designs[0].sizes.map((size) => size.size_name), ["PETITE", "GRAND"], "the four sizes in their order");

    // Every write republished the whole type, with a rising version, to both branches of company 1.
    const changes = (await db.query("SELECT branch_id, entity_id, entity_version, payload FROM sync_change_log WHERE entity_type = 'packing_type' AND branch_id = 1 ORDER BY change_id")).rows;
    assert.deepEqual(changes.map((row) => row.entity_version), [1, 2, 3, 4]);
    assert.ok(changes.every((row) => row.entity_id === type.global_id));
    const last = changes.at(-1).payload;
    assert.deepEqual(Object.keys(last).sort(), ["active", "company_id", "designs", "entity_version", "global_id", "name", "sort_order"]);
    assert.deepEqual(last.designs[0].sizes.map((size) => Object.keys(size).sort()), [
      ["active", "capacity", "global_id", "size_name", "sort_order", "unit_cost"],
      ["active", "capacity", "global_id", "size_name", "sort_order", "unit_cost"],
    ]);
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM sync_change_log WHERE entity_type = 'packing_type' AND branch_id = 2"), 4);
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM sync_change_log WHERE branch_id = 3"), 0, "not company 2's branch");

    // PUT by numeric id and by global id; an absent unit cost on update keeps it.
    const renamed = await call("PUT", `/api/v3/packing/types/${type.id}`, { name: "Gift Boxes", sort_order: 2 });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.type.name, "Gift Boxes");
    assert.equal(renamed.body.type.sort_order, 2);
    const resized = await call("PUT", `/api/v3/packing/sizes/${grand.global_id}`, { size_name: "GRAND", capacity: "1.5 kg" });
    assert.equal(resized.status, 200, JSON.stringify(resized.body));
    assert.equal(resized.body.size.capacity, "1.5 kg");
    assert.equal(resized.body.size.unit_cost, 10);
    const off = await call("PUT", `/api/v3/packing/designs/${design.global_id}`, { name: "Window Box", active: false });
    assert.equal(off.body.design.active, false);
    assert.equal((await call("PUT", "/api/v3/packing/sizes/packing-size-999", { size_name: "GRAND" })).status, 404);
  });
});

test("routes: duplicates among active siblings are 409, a bad size name is 400, and refusals write nothing", async () => {
  await withPack(async ({ statements, db }) => {
    const { type, design } = await buildTree();
    const cases = [
      ["POST", "/api/v3/packing/types", { name: "gift box" }, 409, CODES.NAME_TAKEN],
      ["POST", "/api/v3/packing/designs", { type_id: type.id, name: "WINDOW BOX" }, 409, CODES.NAME_TAKEN],
      ["POST", "/api/v3/packing/sizes", { design_id: design.id, size_name: "GRAND", capacity: "1 KG" }, 409, CODES.SIZE_TAKEN],
      ["POST", "/api/v3/packing/sizes", { design_id: design.id, size_name: "JUMBO" }, 400, CODES.SIZE_NAME_INVALID],
      ["POST", "/api/v3/packing/sizes", { design_id: "packing-design-999", size_name: "GRAND" }, 400, CODES.PARENT_INVALID],
      ["POST", "/api/v3/packing/designs", { type_id: 999, name: "X" }, 400, CODES.PARENT_INVALID],
      ["POST", "/api/v3/packing/types", { name: "" }, 400, CODES.NAME_REQUIRED],
    ];
    for (const [method, url, body, status, code] of cases) {
      statements.length = 0;
      const response = await call(method, url, body);
      assert.equal(response.status, status, `${url} ${JSON.stringify(body)}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.code, code);
      assert.deepEqual(writes(statements), [], `${url} wrote nothing`);
    }
    // A different capacity is a different size; a switched-off type frees its name.
    assert.equal((await call("POST", "/api/v3/packing/sizes", { design_id: design.id, size_name: "GRAND", capacity: "2 kg" })).status, 201);
    assert.equal((await call("PUT", `/api/v3/packing/types/${type.id}`, { name: "Gift Box", active: false })).status, 200);
    assert.equal((await call("POST", "/api/v3/packing/types", { name: "Gift Box" })).status, 201);
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM packing_types"), 2);
  });
});

test("routes: a purchase raises counts, sets unit costs, writes one 'Packing Material' expense and publishes", async () => {
  await withPack(async ({ db }) => {
    const { type, grand, petite } = await buildTree();
    await db.query("DELETE FROM sync_change_log");
    const response = await call("POST", "/api/v3/packing/purchases", {
      supplier_name: "Box Co", payment_mode: "UPI", purchase_date: "2026-10-20", reference_number: "INV-9",
      lines: [{ size_id: grand.global_id, quantity: 50, rate: 12.5 }, { size_id: petite.id, quantity: "20", rate: "3.255" }],
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const { purchase, expense_id: expenseId } = response.body;
    assert.equal(purchase.global_id, `packing-purchase-${purchase.id}`);
    assert.equal(purchase.amount, 690.2, "50 x 12.50 + 20 x 3.26");
    assert.equal(purchase.expense_id, expenseId);
    assert.deepEqual(purchase.lines.map((line) => [line.size_id, line.quantity, line.rate, line.amount]), [
      [grand.global_id, 50, 12.5, 625],
      [petite.global_id, 20, 3.26, 65.2],
    ]);

    const expenses = (await db.query("SELECT id, category, amount, payment_mode, vendor_name, branch_id, created_by, TO_CHAR(expense_date, 'YYYY-MM-DD') AS day, status FROM expenses")).rows;
    assert.equal(expenses.length, 1, "one expense for the whole purchase");
    assert.deepEqual(
      [expenses[0].id, expenses[0].category, Number(expenses[0].amount), expenses[0].payment_mode, expenses[0].vendor_name, expenses[0].branch_id, expenses[0].created_by, expenses[0].day, expenses[0].status],
      [expenseId, "Packing Material", 690.2, "UPI", "Box Co", 1, OWNER_ID, "2026-10-20", "ACTIVE"],
    );
    assert.equal((await db.query("SELECT expense_id FROM packing_purchases")).rows[0].expense_id, expenseId);
    const stock = (await db.query("SELECT size_id, branch_id, qty_on_hand FROM packing_stock ORDER BY size_id")).rows;
    assert.deepEqual(stock.map((row) => [row.size_id, row.branch_id, Number(row.qty_on_hand)]), [[grand.id, 1, 50], [petite.id, 1, 20]]);
    const costs = (await db.query("SELECT id, unit_cost FROM packing_sizes ORDER BY id")).rows;
    assert.deepEqual(costs.map((row) => Number(row.unit_cost)), [12.5, 3.26], "unit cost = the last purchase rate");
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM packing_movements WHERE movement_type = 'PURCHASE'"), 2);

    const changes = (await db.query("SELECT branch_id, entity_type, entity_id, payload FROM sync_change_log ORDER BY change_id")).rows;
    const stockChanges = changes.filter((row) => row.entity_type === "packing_stock");
    assert.deepEqual(stockChanges.map((row) => [row.branch_id, row.entity_id]), [
      [1, `packing-stock-1-${grand.global_id}`],
      [1, `packing-stock-1-${petite.global_id}`],
    ], "one change per count, logged with its branch");
    assert.deepEqual(stockChanges[0].payload, {
      global_id: `packing-stock-1-${grand.global_id}`, branch_id: 1, size_global_id: grand.global_id, qty_on_hand: 50,
      entity_version: 1, updated_at: stockChanges[0].payload.updated_at,
    });
    const typeChanges = changes.filter((row) => row.entity_type === "packing_type");
    assert.deepEqual(typeChanges.map((row) => [row.branch_id, row.entity_id]), [[1, type.global_id], [2, type.global_id]]);
    assert.equal(typeChanges[0].payload.designs[0].sizes.find((size) => size.global_id === grand.global_id).unit_cost, 12.5);

    // The counts show in the tree, for this branch only.
    const tree = (await call("GET", "/api/v3/packing")).body;
    assert.equal(tree.types[0].designs[0].sizes.find((size) => size.id === grand.id).qty_on_hand, 50);
    const branchTwo = (await call("GET", "/api/v3/packing", undefined, headersFor({ branchId: 2 }))).body;
    assert.equal(branchTwo.types[0].designs[0].sizes.find((size) => size.id === grand.id).qty_on_hand, 0, "branch 2 bought nothing");
  });
});

test("routes: a purchase refuses unknown, switched-off and other companies' sizes, and writes nothing", async () => {
  await withPack(async ({ db, statements }) => {
    const { grand } = await buildTree();
    await db.exec(`
      INSERT INTO packing_types (id, global_id, company_id, name) VALUES (90, 'packing-type-90', 2, 'Theirs');
      INSERT INTO packing_designs (id, global_id, type_id, name) VALUES (90, 'packing-design-90', 90, 'Theirs');
      INSERT INTO packing_sizes (id, global_id, design_id, size_name) VALUES (90, 'packing-size-90', 90, 'GRAND');
    `);
    await call("PUT", `/api/v3/packing/sizes/${grand.id}`, { size_name: "GRAND", capacity: "1 kg", active: false });
    for (const sizeId of ["packing-size-999", "packing-size-90", grand.global_id]) {
      statements.length = 0;
      const response = await call("POST", "/api/v3/packing/purchases", { payment_mode: "CASH", lines: [{ size_id: sizeId, quantity: 1, rate: 1 }] });
      assert.equal(response.status, 400, `${sizeId}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.code, CODES.PURCHASE_INVALID);
      assert.deepEqual(writes(statements), []);
    }
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM expenses"), 0);
  });
});

test("routes: the expense a packing purchase wrote cannot be cancelled or edited from Expenses; others still can", async () => {
  await withPack(async ({ db }) => {
    const { grand } = await buildTree();
    const bought = await call("POST", "/api/v3/packing/purchases", { payment_mode: "CASH", lines: [{ size_id: grand.id, quantity: 2, rate: 5 }] });
    assert.equal(bought.status, 201, JSON.stringify(bought.body));
    const refused = await call("POST", `/expenses/${bought.body.expense_id}/cancel`, { reason: "oops" });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.deepEqual(refused.body, { code: "PACKING_PURCHASE_EXPENSE", message: "This expense belongs to a Frooz Pack purchase." });
    assert.equal((await db.query("SELECT status FROM expenses WHERE id = $1", [bought.body.expense_id])).rows[0].status, "ACTIVE");
    const edited = await call("PUT", `/expenses/${bought.body.expense_id}`, { category: "Packing Material", amount: 999, payment_mode: "CASH" });
    assert.equal(edited.status, 409, JSON.stringify(edited.body));
    assert.equal(edited.body.code, "PACKING_PURCHASE_EXPENSE");
    assert.equal(Number((await db.query("SELECT amount FROM expenses WHERE id = $1", [bought.body.expense_id])).rows[0].amount), 10);

    const other = (await db.query("INSERT INTO expenses (category, amount, branch_id) VALUES ('Rent', 100, 1) RETURNING id")).rows[0].id;
    const cancelled = await call("POST", `/expenses/${other}/cancel`, { reason: "duplicate" });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  });
});

test("routes: an adjustment moves the count by a signed amount, can go below zero, and needs a reason", async () => {
  await withPack(async ({ db }) => {
    const { petite } = await buildTree();
    const down = await call("POST", "/api/v3/packing/adjustments", { size_id: petite.global_id, quantity: -3, reason: "Crushed in transit" });
    assert.equal(down.status, 201, JSON.stringify(down.body));
    assert.equal(down.body.stock.qty_on_hand, -3);
    assert.equal(down.body.stock.global_id, `packing-stock-1-${petite.global_id}`);
    const up = await call("POST", "/api/v3/packing/adjustments", { size_id: petite.id, quantity: 10, reason: "Counted" });
    assert.equal(up.body.stock.qty_on_hand, 7);
    assert.equal(up.body.stock.entity_version, 2);
    assert.equal((await call("POST", "/api/v3/packing/adjustments", { size_id: petite.id, quantity: 1 })).body.code, CODES.ADJUSTMENT_INVALID);
    const history = await call("GET", `/api/v3/packing/movements?size_id=${petite.global_id}&limit=10`);
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.deepEqual(history.body.movements.map((row) => [row.movement_type, row.quantity, row.reason]), [
      ["ADJUST", 10, "Counted"],
      ["ADJUST", -3, "Crushed in transit"],
    ]);
    assert.deepEqual((await call("GET", "/api/v3/packing/movements", undefined, headersFor({ branchId: 2 }))).body.movements, [], "another branch's history is its own");
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM expenses"), 0, "an adjustment is not an expense");
  });
});

test("routes: the tree is the session company's only", async () => {
  await withPack(async ({ db }) => {
    await buildTree();
    await db.exec("INSERT INTO packing_types (id, global_id, company_id, name) VALUES (90, 'packing-type-90', 2, 'Theirs')");
    const ours = (await call("GET", "/api/v3/packing")).body.types.map((type) => type.name);
    assert.deepEqual(ours, ["Gift Box"]);
    // A company-2 type cannot be renamed or built under from company 1.
    assert.equal((await call("PUT", "/api/v3/packing/types/packing-type-90", { name: "Mine" })).status, 404);
    assert.equal((await call("POST", "/api/v3/packing/designs", { type_id: 90, name: "Mine" })).status, 400);
  });
});

test("routes: a Cashier reads the tree but writes nothing; no session reads nothing", async () => {
  await withPack(async ({ statements }) => {
    for (const [method, url] of [
      ["POST", "/api/v3/packing/types"], ["PUT", "/api/v3/packing/types/1"], ["POST", "/api/v3/packing/designs"],
      ["PUT", "/api/v3/packing/designs/1"], ["POST", "/api/v3/packing/sizes"], ["PUT", "/api/v3/packing/sizes/1"],
      ["POST", "/api/v3/packing/purchases"], ["POST", "/api/v3/packing/adjustments"],
      ["DELETE", "/api/v3/packing/types/1"], ["DELETE", "/api/v3/packing/designs/1"], ["DELETE", "/api/v3/packing/sizes/1"],
    ]) {
      const response = await call(method, url, { name: "X" }, headersFor({ role: "Cashier" }));
      assert.equal(response.status, 403, `${method} ${url}`);
      assert.equal(response.body.code, CODES.PERMISSION_REQUIRED);
    }
    assert.deepEqual(writes(statements), []);
    // The permission check reads the session's user, never one named in the body.
    for (const statement of statements.filter(({ sql }) => USER_SQL.test(sql))) assert.deepEqual(statement.values, [OWNER_ID]);
    assert.equal((await call("GET", "/api/v3/packing", undefined, headersFor({ role: "Cashier" }))).status, 200);
  }, { role: "Cashier" });
  const anonymous = { "content-type": "application/json" };
  assert.equal((await probe(app, "GET", "/api/v3/packing", anonymous)).status, 401);
  assert.equal((await probe(app, "POST", "/api/v3/packing/purchases", anonymous, {})).status, 401);
});

// ---------------------------------------------------------------------------------------------
// Delete: only packing nothing has touched
// ---------------------------------------------------------------------------------------------

test("routes: unused packing can be deleted; the tree marks what is in use; devices hear it", async () => {
  await withPack(async ({ db }) => {
    const { type, design, grand, petite } = await buildTree();
    const fresh = (await call("GET", "/api/v3/packing")).body.types[0];
    assert.deepEqual([fresh.in_use, fresh.designs[0].in_use, fresh.designs[0].sizes.map((size) => size.in_use)], [false, false, [false, false]]);
    // The sync payload never carries in_use: it is the owner's screen's, not the counter's.
    const lastPayload = (await db.query("SELECT payload FROM sync_change_log WHERE entity_type = 'packing_type' ORDER BY change_id DESC LIMIT 1")).rows[0].payload;
    assert.equal("in_use" in lastPayload, false);

    // A size: gone, and the type republished without it to both branches.
    await db.query("DELETE FROM sync_change_log");
    const goneSize = await call("DELETE", `/api/v3/packing/sizes/${petite.global_id}`);
    assert.equal(goneSize.status, 200, JSON.stringify(goneSize.body));
    assert.deepEqual(goneSize.body.type.designs[0].sizes.map((size) => size.id), [grand.id]);
    assert.equal(await count(db, `SELECT COUNT(*) AS n FROM packing_sizes WHERE id = ${petite.id}`), 0);
    const republished = (await db.query("SELECT branch_id, operation_type, payload FROM sync_change_log WHERE entity_type = 'packing_type' ORDER BY change_id")).rows;
    assert.deepEqual(republished.map((row) => [row.branch_id, row.operation_type]), [[1, "UPSERT"], [2, "UPSERT"]]);
    assert.deepEqual(republished[0].payload.designs[0].sizes.map((size) => size.global_id), [grand.global_id]);

    // A whole type: its design and sizes go with it; devices get one DELETE change per branch.
    await db.query("DELETE FROM sync_change_log");
    const goneType = await call("DELETE", `/api/v3/packing/types/${type.id}`);
    assert.equal(goneType.status, 200, JSON.stringify(goneType.body));
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM packing_types"), 0);
    assert.equal(await count(db, `SELECT COUNT(*) AS n FROM packing_designs WHERE id = ${design.id}`), 0);
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM packing_sizes"), 0);
    const deletes = (await db.query("SELECT branch_id, entity_type, entity_id, operation_type, payload FROM sync_change_log ORDER BY change_id")).rows;
    assert.deepEqual(deletes.map((row) => [row.branch_id, row.entity_type, row.entity_id, row.operation_type]), [
      [1, "packing_type", type.global_id, "DELETE"],
      [2, "packing_type", type.global_id, "DELETE"],
    ]);
    assert.equal(deletes[0].payload.deleted, true);
    assert.equal((await call("DELETE", `/api/v3/packing/types/${type.id}`)).status, 404, "a second delete finds nothing");
  });
});

test("routes: packing that was bought, counted or put in a combo cannot be deleted, and nothing is written", async () => {
  await withPack(async ({ db, statements }) => {
    const { type, design, grand, petite } = await buildTree();
    const bought = await call("POST", "/api/v3/packing/purchases", {
      payment_mode: "CASH", purchase_date: "2026-10-20", lines: [{ size_id: grand.id, quantity: 5, rate: 10 }],
    });
    assert.equal(bought.status, 201, JSON.stringify(bought.body));
    const counted = await call("POST", "/api/v3/packing/adjustments", { size_id: petite.id, quantity: 2, reason: "Found in store" });
    assert.equal(counted.status, 201, JSON.stringify(counted.body));

    const tree = (await call("GET", "/api/v3/packing")).body.types[0];
    assert.deepEqual([tree.in_use, tree.designs[0].in_use, tree.designs[0].sizes.map((size) => size.in_use)], [true, true, [true, true]]);

    const before = statements.length;
    const refusals = [
      [`/api/v3/packing/sizes/${grand.global_id}`, "it has been bought"],
      [`/api/v3/packing/sizes/${petite.id}`, "its count has been changed"],
      [`/api/v3/packing/designs/${design.global_id}`, "it has been bought"],
      [`/api/v3/packing/types/${type.global_id}`, "it has been bought"],
    ];
    for (const [url, reason] of refusals) {
      const response = await call("DELETE", url);
      assert.equal(response.status, 409, `${url} ${JSON.stringify(response.body)}`);
      assert.equal(response.body.code, CODES.IN_USE);
      assert.match(response.body.message, new RegExp(reason));
      assert.match(response.body.message, /Untick "In use"/);
    }
    assert.deepEqual(writes(statements.slice(before)), [], "a refused delete writes nothing");
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM packing_sizes"), 2);

    // A size only a combo names is in use too.
    const lone = await call("POST", "/api/v3/packing/sizes", { design_id: design.id, size_name: "ROYAL" });
    assert.equal(lone.status, 201, JSON.stringify(lone.body));
    const combo = (await db.query("INSERT INTO combos (company_id, name, kind, combo_type, price) VALUES (1, 'Gift Hamper', 'GIFTING', 'FIXED', 500) RETURNING id")).rows[0];
    await db.query("INSERT INTO combo_packing (combo_id, size_id, quantity) VALUES ($1, $2, 1)", [combo.id, lone.body.size.id]);
    const inCombo = await call("DELETE", `/api/v3/packing/sizes/${lone.body.size.id}`);
    assert.equal(inCombo.status, 409);
    assert.match(inCombo.body.message, /a combo uses it/);
  });
});

// ---------------------------------------------------------------------------------------------
// New packing in one go (POST /api/v3/packing/setup) and Quick start (POST /api/v3/packing/quick-start)
// ---------------------------------------------------------------------------------------------

test("validate setup: a type alone, or a design with at least one size; sizes read as POST /sizes reads them", () => {
  const full = pack.validateSetupInput({
    type: { name: " Gift  Box " },
    design: { name: "Window Box" },
    sizes: [{ size_name: "grand", capacity: " 1  kg ", unit_cost: "12.505" }, { size_name: "PETITE" }],
  });
  assert.equal(full.ok, true, JSON.stringify(full));
  assert.deepEqual(full.value.type, { name: "Gift Box" });
  assert.deepEqual(full.value.sizes, [
    { size_name: "GRAND", capacity: "1 kg", unit_cost: 12.51 },
    { size_name: "PETITE", capacity: null, unit_cost: null },
  ]);
  assert.equal(pack.validateSetupInput({ type: { name: "Basket" } }).ok, true, "a new type alone is fine");
  assert.deepEqual(pack.validateSetupInput({ type: { id: "packing-type-3", name: "ignored" }, design: { id: 4 }, sizes: [{ size_name: "ROYAL" }] }).value.design, { ref: { ref: "4", intId: 4 } });
  const refusals = [
    [{}, CODES.PARENT_INVALID],
    [{ type: { name: "  " } }, CODES.PARENT_INVALID],
    [{ type: "Gift Box" }, CODES.INPUT_INVALID],
    [{ type: { id: 3 } }, CODES.INPUT_INVALID],
    [{ type: { name: "Box" }, design: { name: "Window" } }, CODES.INPUT_INVALID],
    [{ type: { name: "Box" }, design: { name: "Window" }, sizes: [] }, CODES.INPUT_INVALID],
    [{ type: { name: "Box" }, sizes: [{ size_name: "GRAND" }] }, CODES.PARENT_INVALID],
    [{ type: { name: "Box" }, design: { id: 4 }, sizes: [{ size_name: "GRAND" }] }, CODES.PARENT_INVALID],
    [{ type: { name: "Box" }, design: { name: "W" }, sizes: [{ size_name: "JUMBO" }] }, CODES.SIZE_NAME_INVALID],
    [{ type: { name: "Box" }, design: { name: "W" }, sizes: [{ size_name: "GRAND", unit_cost: -1 }] }, CODES.INPUT_INVALID],
    [{ type: { name: "Box" }, design: { name: "W" }, sizes: [{ size_name: "GRAND", capacity: "1 kg" }, { size_name: "grand", capacity: "1 KG" }] }, CODES.INPUT_INVALID],
    [{ type: { name: "Box" }, design: { name: "W" }, sizes: "GRAND" }, CODES.INPUT_INVALID],
    [{ type: { name: "x".repeat(81) } }, CODES.NAME_REQUIRED],
  ];
  for (const [body, code] of refusals) {
    const result = pack.validateSetupInput(body);
    assert.equal(result.ok, false, JSON.stringify(body));
    assert.equal(result.code, code, JSON.stringify(body));
  }
  // The same size name with another capacity is another size.
  assert.equal(pack.validateSetupInput({ type: { name: "Box" }, design: { name: "W" }, sizes: [{ size_name: "GRAND", capacity: "1 kg" }, { size_name: "GRAND", capacity: "2 kg" }] }).ok, true);
});

test("routes: setup makes a new type, design and sizes in one transaction and publishes the type once", async () => {
  await withPack(async ({ db }) => {
    const made = await call("POST", "/api/v3/packing/setup", {
      type: { name: "Gift Box" },
      design: { name: "Window Box" },
      sizes: [{ size_name: "GRAND", capacity: "1 kg", unit_cost: 12 }, { size_name: "PETITE" }],
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const { type, design, sizes } = made.body;
    assert.equal(made.body.success, true);
    assert.equal(type.global_id, `packing-type-${type.id}`);
    assert.equal(type.name, "Gift Box");
    assert.equal(design.global_id, `packing-design-${design.id}`);
    assert.deepEqual(type.designs.map((entry) => entry.id), [design.id], "the type comes back in the GET tree shape");
    assert.deepEqual(sizes.map((size) => [size.global_id, size.size_name, size.capacity, size.unit_cost, size.qty_on_hand, size.active]), [
      [`packing-size-${sizes[0].id}`, "GRAND", "1 kg", 12, 0, true],
      [`packing-size-${sizes[1].id}`, "PETITE", null, 0, 0, true],
    ], "in the order they were sent");
    const changes = (await db.query("SELECT branch_id, entity_id, entity_version, payload FROM sync_change_log WHERE entity_type = 'packing_type' ORDER BY change_id")).rows;
    assert.deepEqual(changes.map((row) => [row.branch_id, row.entity_id, row.entity_version]), [[1, type.global_id, 1], [2, type.global_id, 1]], "one publish, heard by both branches");
    assert.equal(changes[0].payload.designs[0].sizes.length, 2);
    const listed = (await call("GET", "/api/v3/packing")).body.types;
    assert.deepEqual(listed[0].designs[0].sizes.map((size) => size.size_name), ["PETITE", "GRAND"]);

    // Under the existing type: a new design. Under the existing design: one more size.
    const second = await call("POST", "/api/v3/packing/setup", { type: { id: type.global_id }, design: { name: "Kraft" }, sizes: [{ size_name: "ROYAL", capacity: "2 kg" }] });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal(second.body.type.id, type.id);
    assert.equal(second.body.design.name, "Kraft");
    const third = await call("POST", "/api/v3/packing/setup", { type: { id: type.id }, design: { id: design.global_id }, sizes: [{ size_name: "GRAND", capacity: "2 kg" }] });
    assert.equal(third.status, 201, JSON.stringify(third.body));
    assert.equal(third.body.design.id, design.id);
    assert.deepEqual(third.body.sizes.map((size) => [size.size_name, size.capacity]), [["GRAND", "2 kg"]]);
    const versions = (await db.query("SELECT entity_version FROM sync_change_log WHERE entity_type = 'packing_type' AND branch_id = 1 ORDER BY change_id")).rows;
    assert.deepEqual(versions.map((row) => row.entity_version), [1, 2, 3], "a write under an existing type raises its version");

    // A type alone.
    const alone = await call("POST", "/api/v3/packing/setup", { type: { name: "Basket" } });
    assert.equal(alone.status, 201, JSON.stringify(alone.body));
    assert.deepEqual([alone.body.type.name, alone.body.design, alone.body.sizes], ["Basket", null, []]);
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM packing_sizes"), 4);
  });
});

test("routes: setup refuses taken names, a size already there, other companies' and switched-off parents -- and writes nothing", async () => {
  await withPack(async ({ db, statements }) => {
    const { type, design } = await buildTree();
    await db.exec(`
      INSERT INTO packing_types (id, global_id, company_id, name) VALUES (90, 'packing-type-90', 2, 'Theirs');
      INSERT INTO packing_designs (id, global_id, type_id, name) VALUES (90, 'packing-design-90', 90, 'Theirs');
      INSERT INTO packing_types (id, global_id, company_id, name, active) VALUES (91, 'packing-type-91', 1, 'Old Basket', FALSE);
      INSERT INTO packing_types (id, global_id, company_id, name) VALUES (92, 'packing-type-92', 1, 'Bottle');
      INSERT INTO packing_designs (id, global_id, type_id, name) VALUES (92, 'packing-design-92', 92, 'Round');
    `);
    const grand = [{ size_name: "GRAND", capacity: "1 KG" }];
    const cases = [
      [{ type: { name: "gift box" }, design: { name: "X" }, sizes: [{ size_name: "PETITE" }] }, 409, CODES.NAME_TAKEN, /Gift Box/],
      [{ type: { id: type.id }, design: { name: "window box" }, sizes: [{ size_name: "ROYAL" }] }, 409, CODES.NAME_TAKEN, /Window Box/],
      [{ type: { id: type.id }, design: { id: design.id }, sizes: [{ size_name: "ROYAL" }, ...grand] }, 409, CODES.SIZE_TAKEN, /Window Box already has Grand · 1 KG/],
      [{ type: { id: "packing-type-90" }, design: { name: "Mine" }, sizes: [{ size_name: "ROYAL" }] }, 400, CODES.PARENT_INVALID, /not found/],
      [{ type: { id: type.id }, design: { id: "packing-design-90" }, sizes: [{ size_name: "ROYAL" }] }, 400, CODES.PARENT_INVALID, /not found under Gift Box/],
      [{ type: { id: type.id }, design: { id: "packing-design-92" }, sizes: [{ size_name: "ROYAL" }] }, 400, CODES.PARENT_INVALID, /not found under Gift Box/],
      [{ type: { id: 91 }, design: { name: "New" }, sizes: [{ size_name: "ROYAL" }] }, 400, CODES.PARENT_INVALID, /switched off/],
      [{ type: { id: type.id }, design: { name: "New" }, sizes: [{ size_name: "ROYAL" }, { size_name: "MEDIUM" }] }, 400, CODES.SIZE_NAME_INVALID, /Petite/],
    ];
    for (const [body, status, code, message] of cases) {
      statements.length = 0;
      const response = await call("POST", "/api/v3/packing/setup", body);
      assert.equal(response.status, status, `${JSON.stringify(body)}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.code, code, JSON.stringify(body));
      assert.match(response.body.message, message);
      assert.deepEqual(writes(statements), [], `${JSON.stringify(body)} wrote nothing`);
    }
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM packing_types WHERE company_id = 1"), 3);
    // A switched-off size frees its name and capacity, as with POST /sizes.
    await call("PUT", `/api/v3/packing/sizes/packing-size-${(await db.query("SELECT id FROM packing_sizes WHERE size_name = 'GRAND'")).rows[0].id}`, { size_name: "GRAND", capacity: "1 kg", active: false });
    assert.equal((await call("POST", "/api/v3/packing/setup", { type: { id: type.id }, design: { id: design.id }, sizes: grand })).status, 201);
  });
});

test("routes: quick start makes Gift Box, Basket, Bottle and Bowl once, skipping names the shop already has", async () => {
  await withPack(async ({ db }) => {
    await db.exec("INSERT INTO packing_types (id, global_id, company_id, name, active) VALUES (91, 'packing-type-91', 1, 'basket', FALSE)");
    await db.exec("INSERT INTO packing_types (id, global_id, company_id, name) VALUES (90, 'packing-type-90', 2, 'Bowl')");
    const first = await call("POST", "/api/v3/packing/quick-start", {});
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.deepEqual(first.body.created.map((type) => type.name), ["Gift Box", "Bottle", "Bowl"], "another company's Bowl is not ours");
    assert.deepEqual(first.body.skipped, ["Basket"], "a switched-off Basket is the owner's choice, kept");
    assert.ok(first.body.created.every((type) => type.global_id === `packing-type-${type.id}` && type.designs.length === 0));
    const published = (await db.query("SELECT entity_id, entity_version FROM sync_change_log WHERE entity_type = 'packing_type' AND branch_id = 1 ORDER BY change_id")).rows;
    assert.deepEqual(published.map((row) => row.entity_id), first.body.created.map((type) => type.global_id));
    assert.ok(published.every((row) => row.entity_version === 1));

    const again = await call("POST", "/api/v3/packing/quick-start", {});
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual(again.body.created, []);
    assert.deepEqual(again.body.skipped, ["Gift Box", "Basket", "Bottle", "Bowl"]);
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM packing_types WHERE company_id = 1"), 4);
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM sync_change_log WHERE entity_type = 'packing_type' AND branch_id = 1"), 3, "a second press publishes nothing");
  });
});

test("routes: a Cashier cannot run setup or quick start", async () => {
  await withPack(async ({ statements }) => {
    for (const url of ["/api/v3/packing/setup", "/api/v3/packing/quick-start"]) {
      const response = await call("POST", url, { type: { name: "X" } }, headersFor({ role: "Cashier" }));
      assert.equal(response.status, 403, url);
      assert.equal(response.body.code, CODES.PERMISSION_REQUIRED);
    }
    assert.deepEqual(writes(statements), []);
  }, { role: "Cashier" });
  assert.equal((await probe(app, "POST", "/api/v3/packing/setup", { "content-type": "application/json" }, {})).status, 401);
});

// ---------------------------------------------------------------------------------------------
// Bills: recordSalePackingUsage and restoreSalePacking, called as the sale paths call them
// ---------------------------------------------------------------------------------------------

const withBillDb = async (run) => {
  const db = await openDatabase();
  try {
    await db.exec(`
      INSERT INTO packing_types (id, global_id, company_id, name) VALUES (1, 'packing-type-1', 1, 'Gift Box'), (2, 'packing-type-2', 2, 'Theirs');
      INSERT INTO packing_designs (id, global_id, type_id, name) VALUES (1, 'packing-design-1', 1, 'Window Box'), (2, 'packing-design-2', 2, 'Theirs');
      INSERT INTO packing_sizes (id, global_id, design_id, size_name, capacity, unit_cost) VALUES
        (1, 'packing-size-1', 1, 'GRAND', '1 kg', 12.50), (2, 'packing-size-2', 1, 'PETITE', NULL, 4.00),
        (3, 'packing-size-3', 2, 'GRAND', NULL, 9.00);
      INSERT INTO packing_stock (company_id, branch_id, size_id, qty_on_hand) VALUES (1, 2, 1, 1);
    `);
    const client = { query: (sql, values) => db.query(sql, values || []) };
    return await run({ db, client });
  } finally {
    await db.close();
  }
};

const USAGE = [
  { combo_line_key: "k1", combo_id: "combo-3", source: "FIXED", packing_size_id: "packing-size-1", type_name: "Gift Box", design_name: "Window Box", size_name: "GRAND", capacity: "1 kg", quantity: 2, unit_cost: 12.5 },
  { combo_line_key: "k2", combo_id: "combo-4", source: "CUSTOM", packing_size_id: "packing-size-1", quantity: 1, unit_cost: 12.5 },
  { combo_line_key: "k2", combo_id: "combo-4", source: "CUSTOM", packing_size_id: "packing-size-2", quantity: 1 },
];
const bill = { saleId: 5151, companyId: 1, branchId: 2, actorId: OWNER_ID };
const qtyOf = async (db, sizeId, branchId = 2) => {
  const row = (await db.query("SELECT qty_on_hand FROM packing_stock WHERE size_id = $1 AND branch_id = $2", [sizeId, branchId])).rows[0];
  return row ? Number(row.qty_on_hand) : null;
};

test("sale: a bill's packing is recorded as billed and taken out of its branch's counts, below zero if need be", async () => {
  await withBillDb(async ({ db, client }) => {
    await db.query("BEGIN");
    const outcome = await pack.recordSalePackingUsage(client, { ...bill, usage: USAGE }, directDeps());
    await db.query("COMMIT");
    assert.deepEqual(outcome, { recorded: 3, unknown: 0, skipped: 0 });
    assert.equal(await qtyOf(db, 1), -2, "1 on hand, 3 used: the bill went through and the count is -2");
    assert.equal(await qtyOf(db, 2), -1);
    const usage = (await db.query("SELECT combo_line_key, source, size_id, size_global_id, size_name, quantity, unit_cost FROM sale_packing_usage ORDER BY id")).rows;
    assert.deepEqual(usage.map((row) => [row.combo_line_key, row.source, row.size_id, row.size_global_id, row.size_name, Number(row.quantity)]), [
      ["k1", "FIXED", 1, "packing-size-1", "GRAND", 2],
      ["k2", "CUSTOM", 1, "packing-size-1", "GRAND", 1],
      ["k2", "CUSTOM", 2, "packing-size-2", "PETITE", 1],
    ]);
    const movements = (await db.query("SELECT size_id, branch_id, movement_type, quantity, sale_id FROM packing_movements ORDER BY size_id")).rows;
    assert.deepEqual(movements.map((row) => [row.size_id, row.branch_id, row.movement_type, Number(row.quantity), row.sale_id]), [
      [1, 2, "SALE", -3, 5151],
      [2, 2, "SALE", -1, 5151],
    ], "one SALE movement per size, aggregated");
    const changes = (await db.query("SELECT branch_id, entity_type, entity_id, payload FROM sync_change_log ORDER BY change_id")).rows;
    assert.deepEqual(changes.map((row) => [row.branch_id, row.entity_type, row.entity_id, row.payload.qty_on_hand]), [
      [2, "packing_stock", "packing-stock-2-packing-size-1", -2],
      [2, "packing_stock", "packing-stock-2-packing-size-2", -1],
    ]);

    // A replay of the same bill takes nothing twice.
    await db.query("BEGIN");
    const replay = await pack.recordSalePackingUsage(client, { ...bill, usage: USAGE }, directDeps());
    await db.query("COMMIT");
    assert.equal(replay.duplicate, true);
    assert.equal(await qtyOf(db, 1), -2);
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM sale_packing_usage"), 3);
  });
});

test("sale: unreadable rows and unknown sizes are skipped and audited, never thrown", async () => {
  await withBillDb(async ({ db, client }) => {
    await db.query("BEGIN");
    const outcome = await pack.recordSalePackingUsage(client, {
      ...bill,
      usage: [
        { packing_size_id: "packing-size-2", quantity: 1, source: "FIXED" },
        { packing_size_id: "packing-size-3", quantity: 1 },
        { packing_size_id: "packing-size-404", quantity: 1 },
        { packing_size_id: "packing-size-2", quantity: 0 },
        { quantity: 1 },
        "junk",
      ],
    }, directDeps());
    await db.query("COMMIT");
    assert.deepEqual(outcome, { recorded: 3, unknown: 2, skipped: 3 });
    assert.equal(await qtyOf(db, 2), -1, "the readable row still counted");
    assert.equal(await qtyOf(db, 3), null, "another company's size moves no count");
    const unknown = (await db.query("SELECT size_global_id FROM sale_packing_usage WHERE size_id IS NULL ORDER BY id")).rows;
    assert.deepEqual(unknown.map((row) => row.size_global_id), ["packing-size-3", "packing-size-404"], "kept as billed with size_id NULL");
    const [audit] = (await db.query("SELECT sale_id, action, field_name, new_value, edited_by FROM sale_audit_trail")).rows;
    assert.equal(audit.sale_id, 5151);
    assert.equal(audit.action, CODES.USAGE_SKIPPED);
    assert.equal(audit.field_name, "packing");
    assert.deepEqual(audit.new_value.skipped.map((entry) => entry.reason), ["QUANTITY_INVALID", "SIZE_MISSING", "NOT_AN_OBJECT"]);
    assert.equal(audit.new_value.unknown_sizes.length, 2);
    assert.equal(audit.edited_by, OWNER_ID);

    // Not a list at all: still no throw.
    await db.query("BEGIN");
    const odd = await pack.recordSalePackingUsage(client, { ...bill, saleId: 5152, usage: { box: 1 } }, directDeps());
    await db.query("COMMIT");
    assert.deepEqual(odd, { recorded: 0, unknown: 0, skipped: 1 });
  });
});

test("sale: a bill without packing costs no query, and a database failure is contained so the bill stands", async () => {
  const statements = [];
  const spy = { query: async (sql) => { statements.push(sql); return { rows: [] }; } };
  assert.deepEqual(await pack.recordSalePackingUsage(spy, { ...bill, usage: undefined }, directDeps()), { recorded: 0, unknown: 0, skipped: 0 });
  assert.deepEqual(await pack.recordSalePackingUsage(spy, { ...bill, usage: [] }, directDeps()), { recorded: 0, unknown: 0, skipped: 0 });
  assert.deepEqual(statements, [], "existing sale suites script their statements by position");

  await withBillDb(async ({ db, client }) => {
    await db.exec("DROP TABLE sale_packing_usage");
    await db.query("BEGIN");
    await db.query("INSERT INTO expenses (category, amount) VALUES ('Bill stand-in', 1)");
    const warn = console.warn;
    console.warn = () => {};
    try {
      const outcome = await pack.recordSalePackingUsage(client, { ...bill, usage: USAGE }, directDeps());
      assert.equal(outcome, null);
    } finally {
      console.warn = warn;
    }
    // The surrounding transaction is still usable and commits the bill's own writes.
    await db.query("COMMIT");
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM expenses"), 1);
    assert.equal(await qtyOf(db, 1), 1, "no packing moved");
  });
});

test("sale cancel: the packing goes back once, however often the cancel is replayed", async () => {
  await withBillDb(async ({ db, client }) => {
    await db.query("BEGIN");
    await pack.recordSalePackingUsage(client, { ...bill, usage: USAGE }, directDeps());
    await db.query("COMMIT");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await db.query("BEGIN");
      const outcome = await pack.restoreSalePacking(client, { saleId: bill.saleId, companyId: 1, actorId: OWNER_ID }, directDeps());
      await db.query("COMMIT");
      assert.deepEqual(outcome, { restored: attempt === 0 ? 2 : 0 });
    }
    assert.equal(await qtyOf(db, 1), 1, "back to what was on hand");
    assert.equal(await qtyOf(db, 2), 0);
    const cancels = (await db.query("SELECT size_id, quantity FROM packing_movements WHERE movement_type = 'SALE_CANCEL' ORDER BY size_id")).rows;
    assert.deepEqual(cancels.map((row) => [row.size_id, Number(row.quantity)]), [[1, 3], [2, 1]]);
    const published = (await db.query("SELECT entity_id, payload FROM sync_change_log WHERE entity_type = 'packing_stock' ORDER BY change_id")).rows;
    assert.equal(published.at(-1).payload.qty_on_hand, 0);
    // A bill that used no packing restores nothing.
    await db.query("BEGIN");
    assert.deepEqual(await pack.restoreSalePacking(client, { saleId: 9999, companyId: 1, actorId: OWNER_ID }, directDeps()), { restored: 0 });
    await db.query("COMMIT");
  });
});

test("server: the sale and cancel paths call the packing hooks where the contract puts them", () => {
  const afterFindings = SERVER_SOURCE.indexOf("await froozPack.recordSalePackingUsage(client, {");
  const findings = SERVER_SOURCE.indexOf("await recordComboFindings(client, {");
  assert.ok(findings > 0 && afterFindings > findings, "usage is recorded right after the combo findings");
  assert.match(SERVER_SOURCE.slice(afterFindings, afterFindings + 300), /usage: payload\.packing_usage/);
  for (const reversal of ['"Offline cancellation reversal for invoice", "IN");\n  // Frooz Pack', '"Cancellation reversal for invoice", "IN");\n    // Frooz Pack']) {
    const at = SERVER_SOURCE.indexOf(reversal);
    assert.ok(at > 0, reversal);
    assert.match(SERVER_SOURCE.slice(at, at + 400), /froozPack\.restoreSalePacking\(client/);
  }
  // Not inside restoreSaleInventory, which the edit paths use too.
  const restoreInventory = SERVER_SOURCE.indexOf("const restoreSaleInventory = async");
  const body = SERVER_SOURCE.slice(restoreInventory, SERVER_SOURCE.indexOf("\n};\n", restoreInventory));
  assert.doesNotMatch(body, /froozPack/);
});

// ---------------------------------------------------------------------------------------------
// A purchase is saved once per client_ref (026), and dated by the shop's day (BE-4, BE-8)
// ---------------------------------------------------------------------------------------------

test("schema: 026 adds client_ref with its partial unique index and makes the timestamps TIMESTAMPTZ", async () => {
  const db = await openDatabase();
  try {
    const columns = (await db.query(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE (table_name IN ('combos', 'packing_types', 'packing_designs', 'packing_sizes', 'packing_stock', 'packing_purchases', 'packing_movements')
              AND column_name IN ('created_at', 'updated_at'))
          OR (table_name = 'packing_purchases' AND column_name = 'client_ref')
       ORDER BY table_name, column_name`
    )).rows;
    assert.equal(columns.length, 12);
    for (const column of columns) {
      const expected = column.column_name === "client_ref" ? "character varying" : "timestamp with time zone";
      assert.equal(column.data_type, expected, `${column.table_name}.${column.column_name}`);
    }
    const indexes = (await db.query("SELECT indexname FROM pg_indexes WHERE indexname = ANY($1::TEXT[]) ORDER BY indexname", [[
      "packing_purchases_client_ref_key", "sale_items_combo_id_idx", "sale_packing_usage_combo_idx",
      "sale_packing_usage_size_global_idx", "sale_packing_usage_size_idx",
    ]])).rows.map((row) => row.indexname);
    assert.equal(indexes.length, 5, JSON.stringify(indexes));
  } finally {
    await db.close();
  }
});

test("routes: a purchase retried with the same client_ref is answered with the first, never saved twice", async () => {
  await withPack(async ({ db }) => {
    const { grand } = await buildTree();
    const body = {
      supplier_name: "Box Co", payment_mode: "CASH", purchase_date: "2026-10-20", client_ref: "pack-form-3f2a9c",
      lines: [{ size_id: grand.global_id, quantity: 10, rate: 12 }],
    };
    const first = await call("POST", "/api/v3/packing/purchases", body);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const again = await call("POST", "/api/v3/packing/purchases", body);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.purchase.global_id, first.body.purchase.global_id);
    assert.equal(again.body.expense_id, first.body.expense_id);
    assert.deepEqual(again.body.purchase.lines, first.body.purchase.lines);
    assert.equal(again.body.purchase.amount, first.body.purchase.amount);
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM packing_purchases"), 1);
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM expenses"), 1, "one expense");
    assert.equal(Number((await db.query("SELECT qty_on_hand FROM packing_stock")).rows[0].qty_on_hand), 10, "the count raised once");

    // The same form edited after the lost answer is refused, not reported as saved, and writes nothing.
    const edited = await call("POST", "/api/v3/packing/purchases", { ...body, lines: [{ size_id: grand.global_id, quantity: 12, rate: 12 }] });
    assert.equal(edited.status, 409, JSON.stringify(edited.body));
    assert.equal(edited.body.code, CODES.PURCHASE_ALREADY_SAVED);
    assert.match(edited.body.message, /already saved once, for ₹120\.00/);
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM packing_purchases"), 1);
    assert.equal(Number((await db.query("SELECT qty_on_hand FROM packing_stock")).rows[0].qty_on_hand), 10, "the edit raised nothing");

    // A different form is a different purchase, and no client_ref behaves as it always did.
    assert.equal((await call("POST", "/api/v3/packing/purchases", { ...body, client_ref: "pack-form-other" })).status, 201);
    const { client_ref: _dropped, ...withoutRef } = body;
    assert.equal((await call("POST", "/api/v3/packing/purchases", withoutRef)).status, 201);
    assert.equal((await call("POST", "/api/v3/packing/purchases", withoutRef)).status, 201);
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM packing_purchases"), 4);

    // An unreadable ref is refused before anything is written.
    const bad = await call("POST", "/api/v3/packing/purchases", { ...body, client_ref: "has spaces; and quotes'" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, CODES.PURCHASE_INVALID);
  });
});

test("validate: a purchase date after today is refused, today and earlier are kept", () => {
  const base = { payment_mode: "CASH", lines: [{ size_id: 1, quantity: 1, rate: 5 }] };
  const future = pack.validatePurchaseInput({ ...base, purchase_date: "2026-10-23" }, { today: "2026-10-22" });
  assert.equal(future.code, CODES.PURCHASE_INVALID);
  assert.match(future.message, /cannot be in the future/);
  assert.equal(pack.validatePurchaseInput({ ...base, purchase_date: "2026-10-22" }, { today: "2026-10-22" }).ok, true);
  assert.equal(pack.validatePurchaseInput({ ...base, purchase_date: "2025-01-01" }, { today: "2026-10-22" }).ok, true);
});

test("routes: a purchase saved at 05:00 IST with no date is booked to that India day, not the UTC one", async (t) => {
  // 23:30 UTC on the 24th is 05:00 IST on the 25th: mandi buying hours.
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-24T23:30:00Z") });
  await withPack(async ({ db }) => {
    const { grand } = await buildTree();
    const saved = await call("POST", "/api/v3/packing/purchases", { payment_mode: "CASH", lines: [{ size_id: grand.id, quantity: 1, rate: 5 }] });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.equal(saved.body.purchase.purchase_date, "2026-10-25");
    assert.equal((await db.query("SELECT TO_CHAR(expense_date, 'YYYY-MM-DD') AS day FROM expenses")).rows[0].day, "2026-10-25");
    const future = await call("POST", "/api/v3/packing/purchases", { payment_mode: "CASH", purchase_date: "2026-10-26", lines: [{ size_id: grand.id, quantity: 1, rate: 5 }] });
    assert.equal(future.status, 400);
    assert.equal(future.body.code, CODES.PURCHASE_INVALID);
  });
});

test("routes: a bill's packing movement names the bill by its invoice number", async () => {
  // "Bill 4512" (or a desktop bill's uuid) where every other screen says the invoice number (BO-18).
  await withPack(async ({ db }) => {
    const { grand } = await buildTree();
    await db.exec(`
      INSERT INTO sales VALUES (4512, 1, 'INV-77'), (4513, 2, 'INV-OTHER-BRANCH');
      INSERT INTO packing_movements (company_id, branch_id, size_id, movement_type, quantity, sale_id)
        VALUES (1, 1, ${grand.id}, 'SALE', -1, 4512), (1, 1, ${grand.id}, 'SALE', -1, 4513);
    `);
    const history = await call("GET", "/api/v3/packing/movements");
    assert.equal(history.status, 200, JSON.stringify(history.body));
    const bySale = Object.fromEntries(history.body.movements.map((row) => [row.sale_id, row.invoice_no]));
    assert.equal(bySale[4512], "INV-77");
    assert.equal(bySale[4513], null, "a bill of another branch is not looked up across branches");
  });
});
