"use strict";

/**
 * Which lots `buildSalePayload` may draw from, judged by a real Postgres (PGlite).
 *
 * Found 1 Oct 2026 rehearsing the move to Render + Neon, and present on Railway since 27 Sep: a
 * desktop bill for 1 kg from a lot holding 7 kg came back from sync as "Selected lot does not have
 * enough stock" and sat in the counter's outbox as a conflict. Outside enforce mode a desktop sync
 * knows the company but not the operational location, and the lot query required both together, so
 * it compared `operational_location_id = NULL`, matched nothing, and counted 0 stock. The sync
 * pre-check a few lines earlier applied each one only when known, and passed.
 *
 * A regex over the SQL cannot see `= NULL`; only a database can, so the lot query runs in PGlite.
 * Everything else the function asks goes to a scripted responder.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadServerApp } = require("./routeAuthCoverage");

loadServerApp();
const { buildSalePayload } = require("./server");

const PRODUCT_ID = 10;
const LOT_ID = 16;

const withLotDatabase = async (run) => {
  const { PGlite } = require("@electric-sql/pglite");
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE inventory_batches (
        id INTEGER PRIMARY KEY, product_id INTEGER, branch_id INTEGER, company_id INTEGER,
        operational_location_id INTEGER, remaining_qty NUMERIC(14,3), effective_cost_per_unit NUMERIC(14,2),
        purchase_rate NUMERIC(14,2), purchase_bill_status TEXT, temporary_sale_rate NUMERIC(14,2),
        lot_name TEXT, lot_size NUMERIC, batch_status TEXT, purchase_date DATE, created_at TIMESTAMP
      );
      INSERT INTO inventory_batches VALUES
        (${LOT_ID}, ${PRODUCT_ID}, 1, 1, 1, 7, 60, 60, 'BILL_COMPLETED', 0, 'LOT-16', 10, 'ACTIVE', '2026-09-20', '2026-09-20');
    `);
    const lotQueries = [];
    const client = {
      release: () => {},
      query: async (text, values) => {
        const sql = String(typeof text === "object" && text ? text.text : text || "");
        if (/^\s*SELECT[\s\S]*FROM inventory_batches/i.test(sql)) {
          lotQueries.push(values);
          return db.query(sql, values);
        }
        if (/FROM customers WHERE id = \$1/i.test(sql)) return { rows: [{ id: 5, customer_name: "Walk-in", active: true }] };
        if (/FROM products WHERE id = ANY/i.test(sql)) {
          return { rows: [{ id: PRODUCT_ID, product_name: "Apple", selling_rate: "100.00", unit: "KG" }] };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    return await run(client, lotQueries);
  } finally {
    await db.close();
  }
};

const desktopBill = (client, scope) => buildSalePayload(client, {
  items: [{ product_id: PRODUCT_ID, inventory_batch_id: LOT_ID, quantity: 1, discount_amount: 0, selling_rate: 100 }],
  branchId: 1,
  createdBy: 7,
  customer: { account_id: 5 },
  invoiceDiscount: 0,
  payments: [{ mode: "CASH", amount: 100 }],
  allowRateOverride: true,
  invoiceDiscountMode: "AS_BILLED",
  billDate: "2026-10-01",
  ...scope,
});

test("a desktop sync that knows the company but not the location draws from the company's lot", async () => {
  await withLotDatabase(async (client, lotQueries) => {
    const result = await desktopBill(client, { companyId: 1, operationalLocationId: null });
    assert.equal(result.error, undefined, JSON.stringify(result.error));
    assert.equal(result.invoiceItems[0].quantity, 1);
    assert.equal(lotQueries.length, 1, "the lot query ran against the database");
  });
});

test("a full v3 scope still finds its own lot", async () => {
  await withLotDatabase(async (client) => {
    const result = await desktopBill(client, { companyId: 1, operationalLocationId: 1 });
    assert.equal(result.error, undefined, JSON.stringify(result.error));
  });
});

test("no scope at all (single-shop install) still finds the lot", async () => {
  await withLotDatabase(async (client) => {
    const result = await desktopBill(client, { companyId: null, operationalLocationId: null });
    assert.equal(result.error, undefined, JSON.stringify(result.error));
  });
});

test("another company's caller cannot draw from the lot", async () => {
  await withLotDatabase(async (client) => {
    const result = await desktopBill(client, { companyId: 2, operationalLocationId: null });
    assert.equal(result.error?.status, 409);
    assert.equal(result.error?.available_stock, 0);
  });
});

test("another location of the same company cannot draw from the lot", async () => {
  await withLotDatabase(async (client) => {
    const result = await desktopBill(client, { companyId: 1, operationalLocationId: 2 });
    assert.equal(result.error?.status, 409);
    assert.equal(result.error?.available_stock, 0);
  });
});

// ---------------------------------------------------------------------------------------------
// A held-back new bill is judged again; everything else keeps its stored answer
// ---------------------------------------------------------------------------------------------

const { processSyncOperation } = require("./server");

const storedRow = (overrides = {}) => ({
  operation_id: "op-27sep",
  result_status: "conflict",
  result_payload: { error_code: "CONFLICT", message: "Selected lot does not have enough stock." },
  processed_at: "2026-09-27T03:01:40Z",
  ...overrides,
});

const replayClient = (row) => {
  const statements = [];
  return {
    statements,
    query: async (text, values) => {
      const sql = String(typeof text === "object" && text ? text.text : text || "").replace(/\s+/g, " ").trim();
      statements.push({ sql, values: values || [] });
      if (/FROM sync_processed_operations WHERE operation_id = \$1/i.test(sql)) return { rows: row ? [row] : [] };
      return { rows: [], rowCount: 0 };
    },
  };
};

const syncContext = { companyId: 1, branchId: 1, operationalLocationId: null, deviceId: "dev-1", user: { id: 7 } };
const saleOperation = (overrides = {}) => ({
  operation_id: "op-27sep",
  entity_type: "pos_sale",
  entity_id: "local-invoice-1",
  operation_type: "UPSERT",
  payload: { items: [] },
  ...overrides,
});

test("a stored conflict on a new bill is judged again, and the new outcome replaces it", async () => {
  const client = replayClient(storedRow());
  const ack = await processSyncOperation(client, saleOperation(), syncContext);
  assert.notEqual(ack.message, "Selected lot does not have enough stock.", "the stored refusal was returned without re-running");
  const store = client.statements.find(({ sql }) => /INSERT INTO sync_processed_operations/i.test(sql));
  assert.ok(store, "the new outcome is stored");
  assert.match(store.sql, /DO UPDATE SET/i);
  assert.match(store.sql, /WHERE sync_processed_operations\.result_status = 'conflict'/i, "only a stored conflict can be replaced");
});

test("a stored conflict on an edit or a cancel keeps its stored answer", async () => {
  for (const operation_type of ["SALE_EDIT", "SALE_CANCEL"]) {
    const client = replayClient(storedRow());
    const ack = await processSyncOperation(client, saleOperation({ operation_type }), syncContext);
    assert.equal(ack.status, "conflict");
    assert.equal(ack.message, "Selected lot does not have enough stock.");
    assert.equal(client.statements.length, 1, `${operation_type}: nothing ran after the replay lookup`);
  }
});

test("an accepted bill is never judged again", async () => {
  const client = replayClient(storedRow({ result_status: "accepted", result_payload: { message: "POS sale synced" } }));
  const ack = await processSyncOperation(client, saleOperation(), syncContext);
  assert.equal(ack.status, "accepted");
  assert.equal(client.statements.length, 1);
});

test("a first-time bill stores its outcome without overwriting anything", async () => {
  const client = replayClient(null);
  await processSyncOperation(client, saleOperation(), syncContext);
  const store = client.statements.find(({ sql }) => /INSERT INTO sync_processed_operations/i.test(sql));
  assert.match(store.sql, /ON CONFLICT \(operation_id\) DO NOTHING/i);
});
