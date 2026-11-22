"use strict";

/**
 * Delivery settings: the rules in `deliverySettings.js`, cloud migration 027, and
 * GET/PUT /api/v3/delivery-settings against a real Postgres (PGlite) built from 027 itself.
 *
 * Pinned (Delivery module contract, 22 Nov 2026):
 *   - the settings shape; overdue 5..600; usual_paise whole paise >= 0 (0 kept); paid_by and
 *     provider from their sets; templates booked/picked_up/delivered <= 1000; areas <= 200.
 *   - GET: `branch` (own row), `copied` (another branch of the SAME company: templates and
 *     defaults, pickup/pin/areas blank, nothing written), `none` (settings null).
 *   - PUT: Owner/Admin only (403 for a Cashier, decided from the database row, not the token's
 *     role claim); scope from the session, never from the body.
 *   - 027 is registered after 026, is in initializeDatabase() word for word, and replays cleanly.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const settingsModule = require("./deliverySettings");
const {
  loadServerApp,
  probe,
  setQueryResponder,
  clearQueryResponder,
  setConnectionResponder,
  clearConnectionResponder,
} = require("./routeAuthCoverage");
const { issueDeviceSession } = require("./deviceSession");

const { sanitizeDeliverySettings, readDeliverySettings, copyForNewBranch, CODES, SOURCES } = settingsModule;

const MIGRATION = fs.readFileSync(path.join(__dirname, "migrations", "cloud", "027_deliveries.sql"), "utf8");
const SERVER_SOURCE = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

const validSettings = (overrides = {}) => ({
  pickup_address: "  Frooz, 5 Station Road ",
  pickup_pin: "26.2389,73.0243",
  default_paid_by: "customer",
  default_provider: "uber",
  overdue_minutes: 30,
  areas: [
    { id: "area-1", name: " Ratanada ", usual_paise: 4000 },
    { id: "area-2", name: "Sardarpura", usual_paise: 0 },
    { id: "area-3", name: "Paota", usual_paise: null },
  ],
  templates: { booked: "Hi {name}, booked!", picked_up: "On the way: {tracking_link}", delivered: "Delivered. Thanks!" },
  ...overrides,
});

// ---------------------------------------------------------------------------------------------
// The sanitiser
// ---------------------------------------------------------------------------------------------

test("sanitise: a full settings object is trimmed and kept, zero paise stays zero", () => {
  const result = sanitizeDeliverySettings({ ...validSettings(), stray: "dropped" });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.value, {
    pickup_address: "Frooz, 5 Station Road",
    pickup_pin: "26.2389,73.0243",
    default_paid_by: "customer",
    default_provider: "uber",
    overdue_minutes: 30,
    areas: [
      { id: "area-1", name: "Ratanada", usual_paise: 4000 },
      { id: "area-2", name: "Sardarpura", usual_paise: 0 },
      { id: "area-3", name: "Paota", usual_paise: null },
    ],
    templates: { booked: "Hi {name}, booked!", picked_up: "On the way: {tracking_link}", delivered: "Delivered. Thanks!" },
  });
});

test("sanitise: missing keys take the defaults; a missing area id is generated, a numeric one kept as text", () => {
  const result = sanitizeDeliverySettings({ areas: [{ name: "Paota" }, { id: 7, name: "Shastri Nagar" }] }, { newId: () => "generated-1" });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.value, {
    pickup_address: "",
    pickup_pin: "",
    default_paid_by: "shop",
    default_provider: "rapido",
    overdue_minutes: 45,
    areas: [
      { id: "generated-1", name: "Paota", usual_paise: null },
      { id: "7", name: "Shastri Nagar", usual_paise: null },
    ],
    templates: { booked: "", picked_up: "", delivered: "" },
  });
});

test("sanitise: every broken rule is refused, by name", () => {
  const cases = [
    [null, /settings must be an object/],
    [[], /settings must be an object/],
    [validSettings({ pickup_address: "x".repeat(501) }), /Pickup address is longer than 500/],
    [validSettings({ pickup_pin: 5 }), /Pickup pin must be text/],
    [validSettings({ default_paid_by: "nobody" }), /Default paid by must be one of shop, customer/],
    [validSettings({ default_provider: "porter" }), /Default provider must be one of/],
    [validSettings({ overdue_minutes: 4 }), /Overdue minutes must be a whole number from 5 to 600/],
    [validSettings({ overdue_minutes: 601 }), /Overdue minutes/],
    [validSettings({ overdue_minutes: 30.5 }), /Overdue minutes/],
    [validSettings({ areas: "Ratanada" }), /Areas must be a list/],
    [validSettings({ areas: Array.from({ length: 201 }, (_, i) => ({ id: `a${i}`, name: `A${i}` })) }), /No more than 200 areas/],
    [validSettings({ areas: [{ id: "a", name: " " }] }), /Area 1 needs a name/],
    [validSettings({ areas: [{ id: "a", name: "x".repeat(81) }] }), /Area 1 name is longer than 80/],
    [validSettings({ areas: [{ id: "a", name: "A", usual_paise: -1 }] }), /Area 1 usual charge must be whole paise/],
    [validSettings({ areas: [{ id: "a", name: "A", usual_paise: 12.5 }] }), /Area 1 usual charge/],
    [validSettings({ areas: [{ id: "a", name: "A" }, { id: "a", name: "B" }] }), /Area 2 repeats id a/],
    [validSettings({ areas: ["Ratanada"] }), /Area 1 is not an area/],
    [validSettings({ templates: "hi" }), /Templates must be an object/],
    [validSettings({ templates: { booked: "x".repeat(1001) } }), /booked template is longer than 1000/],
    [validSettings({ templates: { picked_up: 3 } }), /picked up template must be text/],
  ];
  for (const [input, expected] of cases) {
    const result = sanitizeDeliverySettings(input);
    assert.equal(result.ok, false, `expected a refusal for ${expected}`);
    assert.equal(result.value, null);
    assert.ok(result.errors.some((error) => expected.test(error)), `${expected} not in ${JSON.stringify(result.errors)}`);
  }
  // The limits themselves are allowed.
  assert.equal(sanitizeDeliverySettings(validSettings({ overdue_minutes: 5 })).ok, true);
  assert.equal(sanitizeDeliverySettings(validSettings({ overdue_minutes: "600" })).ok, true);
  assert.equal(sanitizeDeliverySettings(validSettings({ templates: { booked: "x".repeat(1000) } })).ok, true);
});

test("copy for a new branch keeps templates and defaults, blanks pickup, pin and areas", () => {
  const copy = copyForNewBranch(sanitizeDeliverySettings(validSettings()).value);
  assert.equal(copy.pickup_address, "");
  assert.equal(copy.pickup_pin, "");
  assert.deepEqual(copy.areas, []);
  assert.equal(copy.templates.booked, "Hi {name}, booked!");
  assert.equal(copy.default_provider, "uber");
  assert.equal(copy.overdue_minutes, 30);
});

// ---------------------------------------------------------------------------------------------
// Schema: cloud migration 027
// ---------------------------------------------------------------------------------------------

const statementsOf = (sql) => sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").replace(/\s+/g, " ").trim();

test("schema: 027 is registered after 026 and is in the bootstrap word for word", () => {
  const files = require("../scripts/run-cloud-migrations").migrationFiles;
  assert.ok(files.indexOf("backend/migrations/cloud/027_deliveries.sql") > files.indexOf("backend/migrations/cloud/026_packing_purchase_client_ref.sql"));
  assert.ok(statementsOf(SERVER_SOURCE).includes(statementsOf(MIGRATION)), "initializeDatabase() carries 027 word for word");
  assert.doesNotMatch(statementsOf(MIGRATION), /\b(INSERT|DELETE|UPDATE)\s+(INTO\s+)?[a-z_]+\s/i, "027 changes no rows");
  assert.match(statementsOf(MIGRATION), /ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS deliveries JSONB;/);
  assert.doesNotMatch(statementsOf(MIGRATION), /\bTIMESTAMP\b(?!TZ)/, "TIMESTAMPTZ from the start, so 008 never retypes them");
});

const BASE_SCHEMA = `
  CREATE TABLE branches (id INTEGER PRIMARY KEY, company_id INTEGER, active BOOLEAN DEFAULT TRUE, branch_name VARCHAR(120));
  CREATE TABLE customer_orders (id BIGSERIAL PRIMARY KEY, global_id VARCHAR(180) NOT NULL UNIQUE, entity_version INTEGER NOT NULL DEFAULT 1);
  INSERT INTO branches (id, company_id, active, branch_name)
    VALUES (1, 1, TRUE, 'Main Branch'), (2, 1, TRUE, 'Ratanada'), (3, 2, TRUE, 'Another Company Shop'), (4, 1, TRUE, 'New Shop');
`;

const openDatabase = async () => {
  const { PGlite } = require("@electric-sql/pglite");
  const db = new PGlite();
  await db.exec(BASE_SCHEMA);
  await db.exec(MIGRATION);
  await db.exec(MIGRATION);
  return db;
};

test("schema: 027 applies twice; the column and the table are there", async () => {
  const db = await openDatabase();
  try {
    const column = (await db.query(
      "SELECT data_type FROM information_schema.columns WHERE table_name = 'customer_orders' AND column_name = 'deliveries'"
    )).rows[0];
    assert.equal(column.data_type, "jsonb");
    const columns = (await db.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'delivery_settings' ORDER BY ordinal_position"
    )).rows.map((row) => `${row.column_name}:${row.data_type}`);
    assert.deepEqual(columns, [
      "id:integer", "company_id:integer", "branch_id:integer", "settings:jsonb", "updated_by:integer",
      "created_at:timestamp with time zone", "updated_at:timestamp with time zone",
    ]);
  } finally {
    await db.close();
  }
});

test("the order upsert's COALESCE keeps stored deliveries when a push carries none", async () => {
  // The SQL shape the handler uses, run for real: NULL from an old app version keeps them, an
  // array (even empty) replaces them.
  const db = await openDatabase();
  try {
    const upsert = (version, deliveries) => db.query(
      `INSERT INTO customer_orders (global_id, entity_version, deliveries) VALUES ('ORD-1', $1, $2::jsonb)
       ON CONFLICT (global_id) DO UPDATE SET
         entity_version = EXCLUDED.entity_version,
         deliveries = COALESCE(EXCLUDED.deliveries, customer_orders.deliveries)
       WHERE customer_orders.entity_version < EXCLUDED.entity_version
       RETURNING deliveries`,
      [version, deliveries === null ? null : JSON.stringify(deliveries)]
    );
    assert.deepEqual((await upsert(1, [{ id: "d-1", attempt_no: 1 }])).rows[0].deliveries, [{ id: "d-1", attempt_no: 1 }]);
    assert.deepEqual((await upsert(2, null)).rows[0].deliveries, [{ id: "d-1", attempt_no: 1 }], "an old app's push keeps them");
    assert.deepEqual((await upsert(3, [])).rows[0].deliveries, [], "an empty list is the sender's truth");
  } finally {
    await db.close();
  }
});

test("read: branch, copied from the same company only, or none", async () => {
  const db = await openDatabase();
  try {
    assert.deepEqual(await readDeliverySettings(db, { companyId: 1, branchId: 2 }), {
      branch_id: 2, settings: null, updated_at: null, source: SOURCES.NONE,
    });
    // Company 2's settings never reach company 1.
    await db.query("INSERT INTO delivery_settings (company_id, branch_id, settings) VALUES (2, 3, $1::jsonb)", [
      JSON.stringify(sanitizeDeliverySettings(validSettings({ templates: { booked: "other company" } })).value),
    ]);
    assert.equal((await readDeliverySettings(db, { companyId: 1, branchId: 2 })).source, SOURCES.NONE);

    await db.query("INSERT INTO delivery_settings (company_id, branch_id, settings) VALUES (1, 1, $1::jsonb)", [
      JSON.stringify(sanitizeDeliverySettings(validSettings()).value),
    ]);
    const copied = await readDeliverySettings(db, { companyId: 1, branchId: 2 });
    assert.equal(copied.source, SOURCES.COPIED);
    assert.equal(copied.branch_id, 2);
    assert.equal(copied.updated_at, null);
    assert.equal(copied.settings.templates.booked, "Hi {name}, booked!");
    assert.equal(copied.settings.pickup_address, "");
    assert.deepEqual(copied.settings.areas, []);
    assert.equal(Number((await db.query("SELECT COUNT(*) AS n FROM delivery_settings")).rows[0].n), 2, "reading a copy writes nothing");

    const own = await readDeliverySettings(db, { companyId: 1, branchId: 1 });
    assert.equal(own.source, SOURCES.BRANCH);
    assert.equal(own.settings.pickup_address, "Frooz, 5 Station Road");
    assert.equal(own.settings.areas.length, 3);
    assert.match(own.updated_at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------------------------
// Routes, against PGlite holding migration 027
// ---------------------------------------------------------------------------------------------

const app = loadServerApp();
const TEST_SIGNING_KEY = "route-auth-coverage-isolated-signing-key-000000";
const USER_ID = 7;
const DEVICE_ID = "FZDEV-DELIVERY";
const headersFor = ({ branchId = 1, companyId = 1, role = "Owner" } = {}) => ({
  authorization: `Bearer ${issueDeviceSession({ userId: USER_ID, deviceId: DEVICE_ID, companyId, branchId, role, secret: TEST_SIGNING_KEY })}`,
  "content-type": "application/json",
});

const normalise = (sql) => String(typeof sql === "object" && sql ? sql.text : sql || "").replace(/\s+/g, " ").trim();
const rows = (list) => ({ rows: list, rowCount: list.length });
const USER_SQL = /FROM users u JOIN roles r/;

const deviceScope = (sql, state) => {
  if (/FROM authorized_devices d/i.test(sql)) {
    return rows([{
      device_id: DEVICE_ID, device_status: "APPROVED", company_id: state.companyId, branch_id: state.branchId,
      operational_location_id: 10, assignment_generation: 1, fixed_operational: true, intended_usage: "POS",
      device_permissions: {}, device_assignment_active: true, location_active: true, branch_active: true,
      role_id: 1, is_default: true, staff_permissions: {}, staff_assignment_active: true, role_name: state.tokenRole,
    }]);
  }
  if (/SELECT session_revocation_version FROM users/i.test(sql)) return rows([{ session_revocation_version: 0 }]);
  return undefined;
};

/**
 * `dbRole` is what the users/roles row says; `tokenRole` what the session claims. The PUT gate must
 * follow the database row.
 */
const withRoutes = async (run, { dbRole = "Owner", tokenRole = dbRole, companyId = 1, branchId = 1 } = {}) => {
  const db = await openDatabase();
  const statements = [];
  const state = { dbRole, tokenRole, companyId, branchId };
  const query = async (text, values) => {
    const sql = normalise(text);
    statements.push({ sql, values: values || [] });
    const scoped = deviceScope(sql, state);
    if (scoped) return scoped;
    if (USER_SQL.test(sql)) return rows([{ id: USER_ID, full_name: "Rig", username: "rig", branch_id: branchId, role_name: state.dbRole, permissions: {} }]);
    const result = await db.query(typeof text === "object" && text ? text.text : text, values || []);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  };
  setQueryResponder((sql, values) => query(sql, values));
  setConnectionResponder(() => ({ query, release: () => {} }));
  try {
    return await run({ db, statements, headers: headersFor({ branchId, companyId, role: tokenRole }) });
  } finally {
    clearQueryResponder();
    clearConnectionResponder();
    await db.close();
  }
};

test("routes: the Owner saves this branch's settings; GET reads them back as source branch", async () => {
  await withRoutes(async ({ db, headers }) => {
    const before = await probe(app, "GET", "/api/v3/delivery-settings", headers);
    assert.equal(before.status, 200, before.text);
    assert.deepEqual(before.body, { branch_id: 1, settings: null, updated_at: null, source: "none" });

    // A body naming another branch or company is refused before the handler runs (the app-wide
    // device-session substitution guard), and nothing is written.
    const substituted = await probe(app, "PUT", "/api/v3/delivery-settings", headers, { settings: validSettings(), branch_id: 2, company_id: 2 });
    assert.equal(substituted.status, 403, substituted.text);
    assert.equal(Number((await db.query("SELECT COUNT(*) AS n FROM delivery_settings")).rows[0].n), 0);

    const saved = await probe(app, "PUT", "/api/v3/delivery-settings", headers, { settings: validSettings() });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.body.source, "branch");
    assert.equal(saved.body.branch_id, 1);
    assert.equal(saved.body.settings.pickup_address, "Frooz, 5 Station Road");
    assert.equal(saved.body.settings.areas[1].usual_paise, 0);
    assert.match(saved.body.updated_at, /^\d{4}-\d{2}-\d{2}T/);

    const stored = (await db.query("SELECT company_id, branch_id, updated_by, settings FROM delivery_settings")).rows;
    assert.equal(stored.length, 1);
    assert.deepEqual([stored[0].company_id, stored[0].branch_id, stored[0].updated_by], [1, 1, USER_ID]);

    const after = await probe(app, "GET", "/api/v3/delivery-settings", headers);
    assert.equal(after.status, 200, after.text);
    assert.equal(after.body.source, "branch");
    assert.deepEqual(after.body.settings, saved.body.settings);

    // A second save replaces, it does not add a row.
    const again = await probe(app, "PUT", "/api/v3/delivery-settings", headers, { settings: validSettings({ overdue_minutes: 60 }) });
    assert.equal(again.status, 200, again.text);
    assert.equal(again.body.settings.overdue_minutes, 60);
    assert.equal(Number((await db.query("SELECT COUNT(*) AS n FROM delivery_settings")).rows[0].n), 1);
  });
});

test("routes: an Admin may save; a Cashier is refused 403 and nothing is written", async () => {
  await withRoutes(async ({ headers }) => {
    const saved = await probe(app, "PUT", "/api/v3/delivery-settings", headers, { settings: validSettings() });
    assert.equal(saved.status, 200, saved.text);
  }, { dbRole: "Admin" });

  await withRoutes(async ({ db, headers }) => {
    const refused = await probe(app, "PUT", "/api/v3/delivery-settings", headers, { settings: validSettings() });
    assert.equal(refused.status, 403, refused.text);
    assert.equal(refused.body.code, CODES.PERMISSION_REQUIRED);
    assert.equal(Number((await db.query("SELECT COUNT(*) AS n FROM delivery_settings")).rows[0].n), 0);
    // But a Cashier may read: the counter needs the templates.
    const read = await probe(app, "GET", "/api/v3/delivery-settings", headers);
    assert.equal(read.status, 200, read.text);
  }, { dbRole: "Cashier" });

  // The token claiming Owner does not make a Cashier an Owner: the gate reads the database row.
  await withRoutes(async ({ db, headers }) => {
    const refused = await probe(app, "PUT", "/api/v3/delivery-settings", headers, { settings: validSettings() });
    assert.equal(refused.status, 403, refused.text);
    assert.equal(Number((await db.query("SELECT COUNT(*) AS n FROM delivery_settings")).rows[0].n), 0);
  }, { dbRole: "Cashier", tokenRole: "Owner" });
});

test("routes: invalid settings are 400 with the reasons, and nothing is written", async () => {
  await withRoutes(async ({ db, headers }) => {
    const refused = await probe(app, "PUT", "/api/v3/delivery-settings", headers, { settings: validSettings({ overdue_minutes: 1, default_provider: "porter" }) });
    assert.equal(refused.status, 400, refused.text);
    assert.equal(refused.body.code, CODES.INVALID);
    assert.equal(refused.body.errors.length, 2);
    const missing = await probe(app, "PUT", "/api/v3/delivery-settings", headers, {});
    assert.equal(missing.status, 400, missing.text);
    assert.equal(Number((await db.query("SELECT COUNT(*) AS n FROM delivery_settings")).rows[0].n), 0);
  });
});

test("routes: a new branch of the company is offered the main branch's templates as a copy", async () => {
  await withRoutes(async ({ db }) => {
    await db.query("INSERT INTO delivery_settings (company_id, branch_id, settings) VALUES (1, 1, $1::jsonb)", [
      JSON.stringify(sanitizeDeliverySettings(validSettings()).value),
    ]);
    const read = await probe(app, "GET", "/api/v3/delivery-settings", headersFor({ branchId: 4 }));
    assert.equal(read.status, 200, read.text);
    assert.equal(read.body.source, "copied");
    assert.equal(read.body.branch_id, 4);
    assert.equal(read.body.settings.templates.delivered, "Delivered. Thanks!");
    assert.equal(read.body.settings.pickup_pin, "");
    assert.deepEqual(read.body.settings.areas, []);
  }, { branchId: 4 });
});

test("routes: both delivery-settings routes demand a session", async () => {
  for (const method of ["GET", "PUT"]) {
    const response = await probe(app, method, "/api/v3/delivery-settings", { "content-type": "application/json" }, { settings: validSettings() });
    assert.equal(response.status, 401, `${method}: ${response.text}`);
  }
});
