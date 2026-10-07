"use strict";

/**
 * Sale returns: the arithmetic in `saleReturns.js`, then the real routes against a real Postgres
 * (PGlite) holding one credit bill.
 *
 * What was wrong before 3 Oct 2026, each pinned below:
 *   - a second partial return put its stock back on the first batch again (allocations were walked
 *     from the start every time) and costed the return at that batch's rate;
 *   - 0.3 - 0.1 left 0.19999..., so returning the remaining 0.2 was refused;
 *   - the refund ignored the bill discount and Mandi Tax, and `||` fell through on a legitimate 0;
 *   - cancelling a bill with a return put the returned stock back a second time, editing it hit a
 *     foreign key, and the offline (sync) versions of both did the same;
 *   - return_date defaulted to the server's UTC day and took any string;
 *   - a credit-note return never reduced what the customer owed;
 *   - the P&L mixed branches and ignored returns; the daily summary's cash/UPI and net profit too.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const rules = require("./saleReturns");
const {
  loadServerApp,
  probe,
  setQueryResponder,
  clearQueryResponder,
  setConnectionResponder,
  clearConnectionResponder,
  startQueryRecording,
  stopQueryRecording,
} = require("./routeAuthCoverage");
const { issueDeviceSession } = require("./deviceSession");

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

test("quantities compare in whole thousandths: 0.3 sold, 0.1 returned leaves exactly 0.2", () => {
  assert.equal(0.3 - 0.1 >= 0.2, false, "the float bug this guards against");
  assert.equal(rules.returnableThousandths("0.300", "0.100"), 200);
  assert.equal(rules.returnableQuantity("0.300", "0.100"), 0.2);
  assert.equal(rules.normalizeReturnQuantity("0.2").thousandths, 200);
  assert.equal(rules.returnableThousandths(1, 2), 0, "never negative");
  assert.equal(rules.normalizeReturnQuantity("0.0004"), null, "rounds to zero thousandths");
  assert.equal(rules.normalizeReturnQuantity("-1"), null);
  assert.equal(rules.normalizeReturnQuantity("abc"), null);
  assert.equal(rules.normalizeReturnQuantity("1.2345").quantity, 1.235, "3 decimals");
});

const ALLOCATIONS = [
  { id: 1, inventory_batch_id: 501, quantity: "1.000", purchase_rate: "100.00" },
  { id: 2, inventory_batch_id: 502, quantity: "2.000", purchase_rate: "120.00" },
];

test("a return consumes allocations in id order, after what earlier returns already took", () => {
  const first = rules.planReturnRestoration({ allocations: ALLOCATIONS, alreadyReturnedQuantity: 0, returnQuantity: 1.5 });
  assert.deepEqual(first.lines.map((line) => [line.inventory_batch_id, line.quantity, line.cost_amount]), [[501, 1, 100], [502, 0.5, 60]]);
  assert.equal(first.costAmount, 160);
  assert.equal(first.unmappedThousandths, 0);

  const second = rules.planReturnRestoration({ allocations: ALLOCATIONS, alreadyReturnedQuantity: "1.500", returnQuantity: 1 });
  assert.deepEqual(second.lines.map((line) => [line.inventory_batch_id, line.quantity]), [[502, 1]], "batch 501 is already full");
  assert.equal(second.costAmount, 120, "costed at the batch it actually lands on");

  const tooMuch = rules.planReturnRestoration({ allocations: ALLOCATIONS, alreadyReturnedQuantity: 2.5, returnQuantity: 1 });
  assert.equal(tooMuch.unmappedThousandths, 500, "the caller must refuse, not restore half");

  const remaining = rules.remainingAllocations(ALLOCATIONS, "1.5");
  assert.deepEqual(remaining.map((row) => row.remaining_quantity), [0, 1.5]);
});

const SALE = { invoice_discount_amount: "100.00", tax_amount: "9.00", mandi_tax_basis: "NET_AFTER_ALL_DISCOUNTS", other_charges_amount: "50.00" };
const LINES = [
  { id: 1000, quantity: "3.000", amount: "600.00", discount_amount: "0.00", net_amount: "600.00" },
  { id: 1001, quantity: "0.300", amount: "400.00", discount_amount: "0.00", net_amount: "400.00" },
];

test("the refund is what the customer paid for the line: bill discount and Mandi Tax shared in", () => {
  // 600 - 100 * 0.6 + 9 * 0.6 = 545.40 for 3 kg.
  assert.equal(rules.refundPerUnit({ line: LINES[0], saleLines: LINES, sale: SALE }), 181.8);
  assert.equal(rules.refundAmountFor(181.8, 1.5), 272.7);
  // 400 - 40 + 3.6 = 363.60 for 0.3 kg.
  assert.equal(rules.refundPerUnit({ line: LINES[1], saleLines: LINES, sale: SALE }), 1212);
  // Other charges are a service already rendered; only shared in when asked for.
  assert.equal(rules.linePaidAmount({ line: LINES[0], saleLines: LINES, sale: SALE, includeOtherCharges: true }), 575.4);
  // Whole-bill check: both lines refunded in full is the bill less its other charges.
  const whole = rules.refundAmountFor(181.8, 3) + rules.refundAmountFor(1212, 0.3);
  assert.equal(Math.round(whole * 100) / 100, 959 - 50);
});

test("a net_amount of 0 is a real 0, and a missing one falls back to amount less discount", () => {
  const free = { id: 1, quantity: "1", amount: "50", discount_amount: "50", net_amount: "0" };
  assert.equal(rules.refundPerUnit({ line: free, saleLines: [free], sale: {} }), 0);
  const legacy = { id: 2, quantity: "2", amount: "100", discount_amount: "10", net_amount: null };
  assert.equal(rules.refundPerUnit({ line: legacy, saleLines: [legacy], sale: {} }), 45);
  assert.equal(rules.refundPerUnit({ line: { quantity: 0 }, saleLines: [], sale: {} }), null, "never a silent 0");
});

test("Mandi Tax on a gross basis is shared by the lines' gross amounts", () => {
  const lines = [
    { id: 1, quantity: "1", amount: "100", discount_amount: "50", net_amount: "50" },
    { id: 2, quantity: "1", amount: "100", discount_amount: "0", net_amount: "100" },
  ];
  const sale = { invoice_discount_amount: 0, tax_amount: 2, mandi_tax_basis: "GROSS_BEFORE_DISCOUNTS" };
  assert.equal(rules.refundPerUnit({ line: lines[0], saleLines: lines, sale }), 51);
});

test("a repeated sale_item_id is found", () => {
  assert.equal(rules.findDuplicateSaleItemId([{ sale_item_id: 1 }, { sale_item_id: 2 }]), null);
  assert.equal(rules.findDuplicateSaleItemId([{ sale_item_id: 1 }, { sale_item_id: "1" }]), "1");
});

test("return date: today in India by default, a real past-or-today date otherwise", () => {
  // 20:00 UTC on 2 Oct is 01:30 on 3 Oct in India.
  assert.equal(rules.indiaBusinessDateKey(new Date("2026-10-02T20:00:00Z")), "2026-10-03");
  assert.equal(rules.indiaBusinessDateKey(new Date("2026-10-02T18:29:59Z")), "2026-10-02");
  const today = "2026-10-03";
  assert.deepEqual(rules.resolveReturnDate(undefined, { today }), { date: today });
  assert.deepEqual(rules.resolveReturnDate("", { today }), { date: today });
  assert.deepEqual(rules.resolveReturnDate("2026-10-02", { today }), { date: "2026-10-02" });
  assert.ok(rules.resolveReturnDate("2026-10-04", { today }).error, "future");
  assert.ok(rules.resolveReturnDate("2026-02-30", { today }).error, "not a real day");
  assert.ok(rules.resolveReturnDate("03-10-2026", { today }).error);
  assert.ok(rules.resolveReturnDate(20261003, { today }).error);
  assert.ok(rules.resolveReturnDate("2026-09-30", { today, saleDate: "2026-10-01" }).error, "before the bill");
});

test("pending bills: a credit-note return settles its own bill first, the excess the next bill", () => {
  const rows = [
    { id: 1, customer_id: 5, customer_name: "Ravi", sale_date: "2026-09-01", total_amount: "100", sale_paid: "0" },
    { id: 2, customer_id: 5, customer_name: "Ravi", sale_date: "2026-09-02", total_amount: "200", sale_paid: "0" },
  ];
  const { summary, invoices } = rules.buildCustomerPendingBills(rows, {
    receiptsByCustomer: new Map([["5", 50]]),
    returnCredits: [
      { sale_id: 2, customer_id: 5, credit_amount: "250" }, // more than bill 2 is open for
      { sale_id: 99, customer_id: 5, credit_amount: "10" }, // a credit note on a cash bill
    ],
  });
  assert.deepEqual(invoices.map((row) => [row.received_amount, row.returned_amount, row.balance_amount]), [[50, 50, 0], [0, 200, 0]]);
  assert.deepEqual(summary, [], "nothing open");
  const partly = rules.buildCustomerPendingBills(rows, { receiptsByCustomer: new Map(), returnCredits: [{ sale_id: 2, customer_id: 5, credit_amount: "20" }] });
  assert.equal(partly.summary[0].balance, 280);
  assert.equal(partly.summary[0].amount_returned, 20);
});

// ---------------------------------------------------------------------------------------------
// Routes, against PGlite
// ---------------------------------------------------------------------------------------------

const app = loadServerApp();
const { restoreSaleInventory, processSyncOperation } = require("./server");

const TEST_SIGNING_KEY = "route-auth-coverage-isolated-signing-key-000000";
const OWNER_ID = 7;
const token = issueDeviceSession({ userId: OWNER_ID, deviceId: "FZDEV-SALE-RETURNS", companyId: 1, branchId: 1, role: "Owner", secret: TEST_SIGNING_KEY });
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

const SCHEMA = `
  CREATE TABLE branches (id INTEGER PRIMARY KEY, company_id INTEGER, active BOOLEAN DEFAULT TRUE);
  CREATE TABLE customers (
    id INTEGER PRIMARY KEY, customer_name TEXT, mobile_number TEXT, gst_number TEXT, system_account BOOLEAN DEFAULT FALSE,
    active BOOLEAN DEFAULT TRUE, opening_balance NUMERIC(14,2) DEFAULT 0, company_id INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE products (id INTEGER PRIMARY KEY, product_name TEXT, unit TEXT);
  CREATE TABLE sales (
    id INTEGER PRIMARY KEY, invoice_no TEXT, customer_id INTEGER, customer_name TEXT, customer_mobile TEXT,
    sale_date DATE, due_date DATE, total_amount NUMERIC(14,2), total_cost NUMERIC(14,2), profit NUMERIC(14,2),
    sale_status TEXT DEFAULT 'COMPLETED', payment_mode TEXT, branch_id INTEGER, company_id INTEGER,
    operational_location_id INTEGER, gross_amount NUMERIC(14,2), item_discount_amount NUMERIC(14,2),
    invoice_discount_amount NUMERIC(14,2), tax_amount NUMERIC(14,2), mandi_tax_basis TEXT,
    other_charges_amount NUMERIC(14,2), global_id TEXT, offline_invoice_ref TEXT, entity_version INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE sale_items (
    id INTEGER PRIMARY KEY, sale_id INTEGER REFERENCES sales(id), product_id INTEGER, quantity NUMERIC(14,3),
    selling_rate NUMERIC(14,2), amount NUMERIC(14,2), discount_amount NUMERIC(14,2), net_amount NUMERIC(14,2),
    cost_amount NUMERIC(14,2), profit NUMERIC(14,2)
  );
  CREATE TABLE inventory_batches (
    id INTEGER PRIMARY KEY, remaining_qty NUMERIC(14,3), returned_qty NUMERIC(14,3), batch_status TEXT, lot_name TEXT, lot_size TEXT
  );
  CREATE TABLE sale_batch_allocations (
    id INTEGER PRIMARY KEY, sale_item_id INTEGER REFERENCES sale_items(id), inventory_batch_id INTEGER,
    quantity NUMERIC(14,3), purchase_rate NUMERIC(14,2), cost_amount NUMERIC(14,2)
  );
  CREATE TABLE sale_payments (id SERIAL PRIMARY KEY, sale_id INTEGER, amount NUMERIC(14,2), payment_mode TEXT);
  CREATE TABLE customer_payments (
    id SERIAL PRIMARY KEY, customer_id INTEGER, payment_amount NUMERIC(14,2), payment_date DATE, payment_mode TEXT,
    reference_number TEXT, remarks TEXT, cancelled BOOLEAN DEFAULT FALSE, branch_id INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE sale_returns (
    id SERIAL PRIMARY KEY, return_no TEXT UNIQUE, sale_id INTEGER NOT NULL REFERENCES sales(id), customer_name TEXT,
    customer_mobile TEXT, return_date DATE NOT NULL, refund_type TEXT NOT NULL, return_reason TEXT NOT NULL,
    total_return_amount NUMERIC(14,2) NOT NULL DEFAULT 0, total_cost_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    branch_id INTEGER, counter_id INTEGER, created_by INTEGER, company_id INTEGER, operational_location_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE sale_return_items (
    id SERIAL PRIMARY KEY, sale_return_id INTEGER NOT NULL REFERENCES sale_returns(id), sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
    product_id INTEGER NOT NULL, return_quantity NUMERIC(14,3) NOT NULL CHECK (return_quantity > 0),
    selling_rate NUMERIC(14,2), return_amount NUMERIC(14,2), cost_amount NUMERIC(14,2)
  );
  CREATE TABLE stock_transactions (
    id SERIAL PRIMARY KEY, product_id INTEGER, quantity NUMERIC(14,3), transaction_type TEXT, remarks TEXT,
    user_id INTEGER, branch_id INTEGER, company_id INTEGER, operational_location_id INTEGER
  );

  CREATE TABLE roles (id INTEGER PRIMARY KEY, role_name TEXT);
  CREATE TABLE users (id INTEGER PRIMARY KEY, role_id INTEGER, active BOOLEAN DEFAULT TRUE);
  CREATE TABLE sale_change_approvals (
    id TEXT PRIMARY KEY, status VARCHAR(20) NOT NULL, action VARCHAR(20) NOT NULL, sale_ref VARCHAR(180) NOT NULL,
    requester_id INTEGER NOT NULL, approver_id INTEGER, company_id INTEGER, branch_id INTEGER, device_id VARCHAR(160),
    reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TIMESTAMPTZ,
    consumed_at TIMESTAMPTZ, consumed_sale_id INTEGER
  );

  INSERT INTO roles VALUES (1, 'Owner'), (3, 'Cashier');
  INSERT INTO users VALUES (7, 1, TRUE), (9, 3, TRUE);
  INSERT INTO branches VALUES (1, 1, TRUE);
  INSERT INTO customers (id, customer_name, mobile_number) VALUES (5, 'Ravi', '9000000001');
  INSERT INTO products VALUES (10, 'Apple', 'KG'), (11, 'Banana', 'KG');
  -- 1000 of fruit, 100 bill discount, 9 Mandi Tax (1% of 900), 50 delivery: 959 on credit.
  INSERT INTO sales (id, invoice_no, customer_id, customer_name, customer_mobile, sale_date, total_amount, total_cost, profit,
    payment_mode, branch_id, company_id, operational_location_id, gross_amount, item_discount_amount,
    invoice_discount_amount, tax_amount, mandi_tax_basis, other_charges_amount, global_id)
  VALUES (100, 'FZ-1', 5, 'Ravi', '9000000001', '2026-01-10', 959, 400, 509, 'CREDIT', 1, 1, 1, 1000, 0, 100, 9,
    'NET_AFTER_ALL_DISCOUNTS', 50, 'sale-g-100');
  INSERT INTO sale_items VALUES
    (1000, 100, 10, 3.000, 200, 600, 0, 600, 340, 205),
    (1001, 100, 11, 0.300, 1333.33, 400, 0, 400, 150, 214);
  INSERT INTO inventory_batches VALUES (501, 0, 0, 'ACTIVE', 'L1', NULL), (502, 0, 0, 'ACTIVE', 'L2', NULL), (503, 0, 0, 'ACTIVE', 'L3', NULL);
  INSERT INTO sale_batch_allocations VALUES
    (1, 1000, 501, 1.000, 100, 100),
    (2, 1000, 502, 2.000, 120, 240),
    (3, 1001, 503, 0.300, 500, 150);
  -- A cash bill made on the shop's OTHER counter (location 2), from before bills carried a company.
  INSERT INTO sales (id, invoice_no, customer_name, sale_date, total_amount, total_cost, profit, payment_mode, branch_id,
    company_id, operational_location_id, gross_amount, item_discount_amount, invoice_discount_amount, tax_amount, global_id)
  VALUES (101, 'FZ-2', 'Walk-in Customer', '2026-01-11', 100, 50, 50, 'CASH', 1, NULL, 2, 100, 0, 0, 0, 'sale-g-101');
  INSERT INTO sale_items VALUES (1010, 101, 10, 1.000, 100, 100, 0, 100, 50, 50);
  INSERT INTO inventory_batches VALUES (504, 0, 0, 'ACTIVE', 'L4', NULL);
  INSERT INTO sale_batch_allocations VALUES (4, 1010, 504, 1.000, 50, 50);
`;

const PERMISSION_SQL = /FROM\s+users\s+u\s+JOIN\s+roles\s+r/i;
const DEVICE_ID = "FZDEV-SALE-RETURNS";

/** The device assignment and session-freshness rows `v3WriteAdapter` reads before the handler. */
const scopeAnswer = (sql) => {
  if (/FROM authorized_devices d/i.test(sql)) {
    return {
      rows: [{
        device_id: DEVICE_ID, device_status: "APPROVED", company_id: 1, branch_id: 1, operational_location_id: 1,
        assignment_generation: 1, fixed_operational: true, intended_usage: "POS", device_permissions: {},
        device_assignment_active: true, location_active: true, branch_active: true, role_id: 1, is_default: true,
        staff_permissions: {}, staff_assignment_active: true, role_name: "Owner",
      }],
      rowCount: 1,
    };
  }
  if (/SELECT session_revocation_version FROM users WHERE id = \$1 AND active IS DISTINCT FROM FALSE/i.test(sql.replace(/\s+/g, " "))) {
    return { rows: [{ session_revocation_version: 0 }], rowCount: 1 };
  }
  return undefined;
};
const OWNER_ROW = { id: OWNER_ID, full_name: "Rig Owner", username: "rig", branch_id: 1, role_name: "Owner", permissions: {}, can_edit_sales: true, can_cancel_sales: true };
const CASHIER_ROW = { id: 9, full_name: "Rig Cashier", username: "cash", branch_id: 1, role_name: "Cashier", permissions: { billing: true }, can_edit_sales: false, can_cancel_sales: false };
// Who the database says the signed-in user is. Roles are re-read from the database, never the token.
let actorRow = OWNER_ROW;
const NOT_IN_RIG = /sync_processed_operations|sync_conflict_log|sync_change_log|sale_audit_trail/i;

const withDatabase = async (run) => {
  const { PGlite } = require("@electric-sql/pglite");
  const db = new PGlite();
  await db.exec(SCHEMA);
  const statements = [];
  const query = async (text, values) => {
    const sql = String(typeof text === "object" && text ? text.text : text || "");
    statements.push(sql.replace(/\s+/g, " ").trim());
    const scoped = scopeAnswer(sql);
    if (scoped) return scoped;
    if (PERMISSION_SQL.test(sql)) return { rows: [actorRow], rowCount: 1 };
    if (NOT_IN_RIG.test(sql)) return { rows: [], rowCount: 0 };
    const result = await db.query(sql, values || []);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  };
  setQueryResponder((sql, values) => query(sql, values));
  setConnectionResponder(() => ({ query, release: () => {} }));
  try {
    return await run({ db, query, statements });
  } finally {
    clearQueryResponder();
    clearConnectionResponder();
    await db.close();
  }
};

const one = async (db, sql, values = []) => (await db.query(sql, values)).rows[0];
const qty = (value) => Number(value);
let operationNumber = 0;
const nextKey = () => `sale-return-test-${++operationNumber}`;
/** The v3 route: the bare /sale-returns is a retired legacy write that answers 426. */
const postReturn = (body) => probe(app, "POST", "/api/v3/sale-returns", headers, {
  sale_id: 100, refund_type: "CREDIT_NOTE", return_reason: "Spoilt", idempotency_key: nextKey(), ...body,
});

test("two partial returns land on the right batches, and the remaining 0.2 of 0.3 is accepted", async () => {
  await withDatabase(async ({ db }) => {
    const options = await probe(app, "GET", "/sale-returns/options/100", headers);
    assert.equal(options.status, 200, JSON.stringify(options.body));
    const apple = options.body.items.find((item) => String(item.sale_item_id) === "1000");
    assert.equal(apple.refund_per_unit, 181.8, "preview price per unit");
    assert.equal(apple.returnable_quantity, 3);

    let response = await postReturn({ items: [{ sale_item_id: 1000, return_quantity: 1.5 }] });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(qty(response.body.total_return_amount), 272.7, "what the preview said: 181.8 x 1.5");
    assert.equal(qty(response.body.total_cost_amount), 160);
    assert.equal(String(response.body.return_date instanceof Date ? response.body.return_date.toISOString() : response.body.return_date).slice(0, 10), rules.indiaBusinessDateKey());

    response = await postReturn({ items: [{ sale_item_id: 1000, return_quantity: 1 }] });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(qty(response.body.total_cost_amount), 120, "costed at batch 502, where it went");
    assert.equal(qty((await one(db, "SELECT remaining_qty FROM inventory_batches WHERE id = 501")).remaining_qty), 1, "batch 501 not over-filled");
    assert.equal(qty((await one(db, "SELECT remaining_qty FROM inventory_batches WHERE id = 502")).remaining_qty), 1.5);

    response = await postReturn({ refund_type: "CASH_REFUND", items: [{ sale_item_id: 1001, return_quantity: 0.1 }] });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    response = await postReturn({ refund_type: "CASH_REFUND", items: [{ sale_item_id: 1001, return_quantity: 0.2 }] });
    assert.equal(response.status, 201, `the remaining 0.2 is returnable: ${JSON.stringify(response.body)}`);
    assert.equal(qty(response.body.total_return_amount), 242.4);
    response = await postReturn({ refund_type: "CASH_REFUND", items: [{ sale_item_id: 1001, return_quantity: 0.001 }] });
    assert.equal(response.status, 400, "nothing left");

    // Money: the two credit notes (272.70 + 181.80) come off what Ravi owes; the cash refunds do not.
    const summary = await probe(app, "GET", "/customer-summary?customer_id=5", headers);
    assert.equal(summary.status, 200, JSON.stringify(summary.body));
    assert.equal(qty(summary.body.customers[0].outstanding_balance), 504.5);
    assert.equal(qty(summary.body.customers[0].total_return_credit), 454.5);

    const ledger = await probe(app, "GET", "/customer-ledger?customer_id=5", headers);
    assert.equal(ledger.status, 200, JSON.stringify(ledger.body));
    assert.equal(ledger.body.ledger.at(-1).running_balance, 504.5, "the ledger ends where the summary says");
    assert.equal(ledger.body.ledger.filter((row) => row.transaction_type === "Sale Return").length, 2, "cash refunds are not credits");

    const pending = await probe(app, "GET", "/pending-bills/customer", headers);
    assert.equal(pending.status, 200, JSON.stringify(pending.body));
    assert.equal(pending.body.invoices[0].balance_amount, 504.5);
    assert.equal(pending.body.invoices[0].returned_amount, 454.5);

    const accountLedger = await probe(app, "GET", "/accounts/ledger?account_key=CUSTOMER-5", headers);
    assert.equal(accountLedger.status, 200, JSON.stringify(accountLedger.body));
    assert.equal(accountLedger.body.ledger.at(-1).balance, 504.5);
  });
});

test("a return request is refused cleanly: repeated line, malformed or future date", async () => {
  await withDatabase(async ({ db }) => {
    let response = await postReturn({ items: [{ sale_item_id: 1000, return_quantity: 1 }, { sale_item_id: 1000, return_quantity: 1 }] });
    assert.equal(response.status, 400);
    response = await postReturn({ return_date: "2026-13-01", items: [{ sale_item_id: 1000, return_quantity: 1 }] });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.match(response.body.message, /YYYY-MM-DD/);
    response = await postReturn({ return_date: "2999-01-01", items: [{ sale_item_id: 1000, return_quantity: 1 }] });
    assert.equal(response.status, 400);
    response = await postReturn({ return_date: "2026-01-09", items: [{ sale_item_id: 1000, return_quantity: 1 }] });
    assert.equal(response.status, 400, "before the bill");
    assert.equal(Number((await one(db, "SELECT COUNT(*) AS n FROM sale_returns")).n), 0, "nothing written");
  });
});

test("a bill with a return cannot be cancelled or edited, online or from a counter's outbox", async () => {
  await withDatabase(async ({ db, query, statements }) => {
    const created = await postReturn({ items: [{ sale_item_id: 1000, return_quantity: 1 }] });
    assert.equal(created.status, 201);

    const cancel = await probe(app, "POST", "/api/v3/sales/100/cancel", headers, { reason: "Wrong bill", idempotency_key: nextKey() });
    assert.equal(cancel.status, 409, JSON.stringify(cancel.body));
    assert.deepEqual(cancel.body, { ...rules.SALE_HAS_RETURNS });
    const edit = await probe(app, "PUT", "/api/v3/sales/100", headers, { reason: "Fix rate", items: [], idempotency_key: nextKey() });
    assert.equal(edit.status, 409, JSON.stringify(edit.body));
    assert.equal(edit.body.code, "SALE_HAS_RETURNS");

    const context = { companyId: 1, branchId: 1, operationalLocationId: 1, deviceId: "dev-1", assignmentGeneration: 1, user: { id: OWNER_ID } };
    statements.length = 0;
    // A push batch is one transaction, and each operation runs in a savepoint inside it.
    await query("BEGIN");
    for (const operation_type of ["SALE_CANCEL", "SALE_EDIT"]) {
      const ack = await processSyncOperation({ query }, {
        operation_id: `op-${operation_type}`,
        entity_type: "pos_sale",
        entity_id: "sale-g-100",
        operation_type,
        version: 2,
        // other_charges named, so an edit is not refused first for being silent about the delivery.
        payload: { reason: "Counter change", other_charges: [], invoice: { invoice_global_id: "sale-g-100" } },
      }, context);
      assert.equal(ack.status, "conflict", operation_type);
      assert.equal(ack.error_code, "SALE_HAS_RETURNS", operation_type);
      assert.equal(ack.message, rules.SALE_HAS_RETURNS.message);
    }
    await query("COMMIT");
    assert.deepEqual(
      statements.filter((sql) => /^(UPDATE|DELETE)\b/i.test(sql)),
      [],
      "nothing was reversed or deleted",
    );
    assert.equal((await one(db, "SELECT sale_status FROM sales WHERE id = 100")).sale_status, "COMPLETED");
    assert.equal(qty((await one(db, "SELECT remaining_qty FROM inventory_batches WHERE id = 501")).remaining_qty), 1);
  });
});

test("restoreSaleInventory never puts returned stock back a second time", async () => {
  await withDatabase(async ({ db, query }) => {
    const created = await postReturn({ items: [{ sale_item_id: 1000, return_quantity: 1.5 }] });
    assert.equal(created.status, 201);
    await restoreSaleInventory({ query }, 100, OWNER_ID, "Test reversal", "IN");
    const batches = (await db.query("SELECT id, remaining_qty FROM inventory_batches WHERE id IN (501, 502, 503) ORDER BY id")).rows.map((row) => [row.id, qty(row.remaining_qty)]);
    // Sold 1 + 2 (+0.3); 1.5 already back (1 on 501, 0.5 on 502). The reversal adds only what is still out.
    assert.deepEqual(batches, [[501, 1], [502, 2], [503, 0.3]]);
  });
});

// ---------------------------------------------------------------------------------------------
// Reports: what the SQL says
// ---------------------------------------------------------------------------------------------

const reportStatements = async () => {
  setQueryResponder((sql) => (PERMISSION_SQL.test(sql) ? { rows: [OWNER_ROW], rowCount: 1 } : undefined));
  try {
    startQueryRecording();
    await probe(app, "GET", "/reports/summary?date_from=2026-10-01&date_to=2026-10-03", headers);
    return stopQueryRecording().map((sql) => sql.replace(/\s+/g, " "));
  } finally {
    clearQueryResponder();
  }
};

test("P&L: one branch, sales and cost net of returns", async () => {
  const statements = await reportStatements();
  const pl = statements.find((sql) => /AS sales_revenue/.test(sql) && /AS supplier_rebate_received/.test(sql));
  assert.ok(pl, "the P&L statement ran");
  const subqueries = pl.split("(SELECT SUM(").slice(1).map((segment) => segment.slice(0, segment.indexOf("), 0)")));
  assert.ok(subqueries.length >= 12, `found ${subqueries.length}`);
  for (const subquery of subqueries) assert.match(subquery, /branch_id = \$3/, subquery);
  assert.match(pl, /- COALESCE\(\(SELECT SUM\(total_return_amount\) FROM sale_returns WHERE return_date BETWEEN \$1 AND \$2 AND branch_id = \$3\), 0\) AS sales_revenue/);
  assert.match(pl, /- COALESCE\(\(SELECT SUM\(total_cost_amount\) FROM sale_returns WHERE return_date BETWEEN \$1 AND \$2 AND branch_id = \$3\), 0\) AS purchase_cost/);
});

test("daily summary: cash and UPI net of refunds, net profit net of the return margin", async () => {
  const statements = await reportStatements();
  const daily = statements.find((sql) => /returns_by_day AS/.test(sql));
  assert.ok(daily);
  assert.match(daily, /sales_payments_by_day\.cash_sales, 0\) - COALESCE\(returns_by_day\.cash_refunds, 0\) AS cash_sales/);
  assert.match(daily, /sales_payments_by_day\.upi_sales, 0\) - COALESCE\(returns_by_day\.upi_refunds, 0\) AS upi_sales/);
  assert.match(daily, /COALESCE\(sales_by_day\.profit, 0\) - COALESCE\(returns_by_day\.return_margin, 0\)/);
});

test("ledger report: only a credit note or future adjustment credits the customer", async () => {
  const statements = await reportStatements();
  const ledger = statements.find((sql) => /'Sale Return' AS voucher_type/.test(sql));
  assert.ok(ledger);
  assert.match(ledger, /CASE WHEN sr\.refund_type IN \('CREDIT_NOTE', 'FUTURE_ADJUSTMENT'\) THEN sr\.total_return_amount ELSE 0 END AS credit/);
});

test("a bill made on the shop's other counter, with no company recorded, can be returned", async () => {
  await withDatabase(async ({ db }) => {
    const response = await postReturn({ sale_id: 101, refund_type: "CASH_REFUND", items: [{ sale_item_id: 1010, return_quantity: 0.5 }] });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(qty((await one(db, "SELECT remaining_qty FROM inventory_batches WHERE id = 504")).remaining_qty), 0.5);
    const movement = await one(db, "SELECT branch_id, operational_location_id FROM stock_transactions ORDER BY id DESC LIMIT 1");
    assert.equal(movement.operational_location_id, 2, "the stock movement belongs to the bill's own counter");
    const saved = await one(db, "SELECT branch_id FROM sale_returns WHERE id = $1", [response.body.id]);
    assert.equal(saved.branch_id, 1);
  });
});

test("a missing or cancelled bill is named as such, not as an unpicked invoice", async () => {
  await withDatabase(async ({ db }) => {
    let response = await postReturn({ sale_id: 999, items: [{ sale_item_id: 1000, return_quantity: 1 }] });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, "SALE_RETURN_INVOICE_NOT_FOUND");
    await db.query("UPDATE sales SET sale_status = 'CANCELLED' WHERE id = 101");
    response = await postReturn({ sale_id: 101, items: [{ sale_item_id: 1010, return_quantity: 1 }] });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, "SALE_RETURN_INVOICE_CANCELLED");
  });
});

test("a Cashier's return needs an Owner or Admin approval for that bill, and spends it once", async () => {
  actorRow = CASHIER_ROW;
  try {
    await withDatabase(async ({ db }) => {
      const body = { sale_id: 101, refund_type: "CASH_REFUND", items: [{ sale_item_id: 1010, return_quantity: 0.25 }] };
      let response = await postReturn(body);
      assert.equal(response.status, 403, JSON.stringify(response.body));
      assert.equal(response.body.code, "SALE_CHANGE_APPROVAL_REQUIRED");
      assert.equal((await one(db, "SELECT COUNT(*)::INTEGER AS n FROM sale_returns")).n, 0, "nothing written");

      const insert = (id, action, saleRef) => db.query(
        `INSERT INTO sale_change_approvals (id, status, action, sale_ref, requester_id, approver_id, company_id, branch_id, device_id, reason, expires_at)
         VALUES ($1, 'ISSUED', $2, $3, 9, 7, 1, 1, $4, 'Soft fruit', CURRENT_TIMESTAMP + INTERVAL '1 day')`,
        [id, action, saleRef, DEVICE_ID]
      );
      await insert("appr-cancel", "cancel", "101");
      await insert("appr-other-bill", "return", "100");
      await insert("appr-ok", "return", "101");

      response = await postReturn({ ...body, approval_id: "appr-cancel" });
      assert.equal(response.status, 403, "a cancel approval is not a return approval");
      assert.equal(response.body.detail, "APPROVAL_WRONG_ACTION");
      response = await postReturn({ ...body, approval_id: "appr-other-bill" });
      assert.equal(response.status, 403, "another bill's approval does not move");
      assert.equal(response.body.detail, "APPROVAL_WRONG_SALE");

      response = await postReturn({ ...body, approval_id: "appr-ok" });
      assert.equal(response.status, 201, JSON.stringify(response.body));
      const approval = await one(db, "SELECT status, consumed_sale_id FROM sale_change_approvals WHERE id = 'appr-ok'");
      assert.equal(approval.status, "CONSUMED");
      assert.equal(approval.consumed_sale_id, 101);

      response = await postReturn({ ...body, approval_id: "appr-ok" });
      assert.equal(response.status, 403, "an approval is single-use");
      assert.equal(response.body.detail, "APPROVAL_ALREADY_USED");
    });
  } finally {
    actorRow = OWNER_ROW;
  }
});

// --- A bill-change approval: 15 minutes online, 7 days through a counter's outbox -------------
//
// 7 Oct 2026. Online, a cancel/edit approval lives 15 minutes. A counter that took one online and
// then lost its connection has already cancelled the bill on its own database, so the sync push
// accepts it up to 7 days after the server granted it -- judged from the row's server-written
// `created_at` against the server clock, never a time the device sends. Real Postgres underneath.

const insertAgedApproval = (db, { id, ageSql, device, branch = 1, action = "cancel", saleRef = "100" }) => db.query(
  `INSERT INTO sale_change_approvals (id, status, action, sale_ref, requester_id, approver_id, company_id, branch_id, device_id, reason, created_at, expires_at)
   VALUES ($1, 'ISSUED', $2, $3, 9, 7, 1, $4, $5, 'Customer changed mind',
           CURRENT_TIMESTAMP - ${ageSql}::interval, CURRENT_TIMESTAMP - ${ageSql}::interval + INTERVAL '15 minutes')`,
  [id, action, saleRef, branch, device]
);

const SYNC_CANCEL_SCHEMA = `
  ALTER TABLE sale_payments ADD COLUMN IF NOT EXISTS status TEXT;
  ALTER TABLE sales ADD COLUMN IF NOT EXISTS cancelled_by INTEGER;
  ALTER TABLE sales ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
  ALTER TABLE sales ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
  CREATE TABLE IF NOT EXISTS customer_ledger (
    id SERIAL PRIMARY KEY, sale_id INTEGER, customer_id INTEGER, customer_name TEXT, customer_mobile TEXT,
    transaction_type TEXT, debit_amount NUMERIC(14,2), credit_amount NUMERIC(14,2), balance_delta NUMERIC(14,2),
    remarks TEXT, created_by INTEGER, transaction_date DATE, company_id INTEGER, branch_id INTEGER,
    operational_location_id INTEGER
  );
`;

/** The rig answers sync_change_log with no rows; an accepted change needs the row it returns. */
const withChangeLog = (query) => async (text, values) => {
  const sql = String(typeof text === "object" && text ? text.text : text || "");
  if (/INSERT INTO sync_change_log/i.test(sql)) return { rows: [{ change_id: "1", created_at: new Date() }], rowCount: 1 };
  return query(text, values);
};

const CANCELLING_CASHIER = { ...CASHIER_ROW, can_cancel_sales: true, can_edit_sales: true };

const syncCancel = (query, approvalId, operationId) => processSyncOperation({ query: withChangeLog(query) }, {
  operation_id: operationId,
  entity_type: "pos_sale",
  entity_id: "sale-g-100",
  operation_type: "SALE_CANCEL",
  version: 3,
  payload: { reason: "Customer changed mind", invoice: { invoice_global_id: "sale-g-100" }, approval_id: approvalId },
}, { ...syncEditContext(), user: { id: 9 } });

test("a cancel approval 30 minutes old: refused online, accepted from the counter's outbox", async () => {
  actorRow = CANCELLING_CASHIER;
  try {
    await withDatabase(async ({ db, query }) => {
      // What a cancellation writes that the return tests never needed.
      await db.exec(SYNC_CANCEL_SCHEMA);
      await insertAgedApproval(db, { id: "aged-online", ageSql: "'30 minutes'", device: DEVICE_ID });
      const online = await probe(app, "POST", "/api/v3/sales/100/cancel", headers, {
        reason: "Customer changed mind", approval_id: "aged-online", idempotency_key: nextKey(),
      });
      assert.equal(online.status, 403, JSON.stringify(online.body));
      assert.equal(online.body.detail, "APPROVAL_EXPIRED", "online keeps the 15-minute life");
      assert.equal((await one(db, "SELECT status FROM sale_change_approvals WHERE id = 'aged-online'")).status, "ISSUED");
      assert.equal((await one(db, "SELECT sale_status FROM sales WHERE id = 100")).sale_status, "COMPLETED");

      await insertAgedApproval(db, { id: "aged-sync", ageSql: "'30 minutes'", device: "dev-1" });
      await query("BEGIN");
      const ack = await syncCancel(query, "aged-sync", "op-aged-sync");
      await query("COMMIT");
      assert.equal(ack.status, "accepted", JSON.stringify(ack));
      const spent = await one(db, "SELECT status, consumed_sale_id FROM sale_change_approvals WHERE id = 'aged-sync'");
      assert.equal(spent.status, "CONSUMED", "still single use");
      assert.equal(spent.consumed_sale_id, 100);
      assert.equal((await one(db, "SELECT sale_status FROM sales WHERE id = 100")).sale_status, "CANCELLED");
    });
  } finally {
    actorRow = OWNER_ROW;
  }
});

test("through the outbox: past 7 days from the grant, or another shop's approval, is still refused", async () => {
  actorRow = CANCELLING_CASHIER;
  try {
    await withDatabase(async ({ db, query }) => {
      await db.exec(SYNC_CANCEL_SCHEMA);
      await insertAgedApproval(db, { id: "stale-sync", ageSql: "'8 days'", device: "dev-1" });
      await insertAgedApproval(db, { id: "other-shop", ageSql: "'1 minute'", device: "dev-1", branch: 2 });
      await insertAgedApproval(db, { id: "edit-not-cancel", ageSql: "'1 minute'", device: "dev-1", action: "edit" });
      await query("BEGIN");
      for (const [id, why] of [["stale-sync", "8 days"], ["other-shop", "branch 2"], ["edit-not-cancel", "wrong action"]]) {
        const ack = await syncCancel(query, id, `op-${id}`);
        assert.notEqual(ack.status, "accepted", why);
        assert.equal(ack.error_code, "AUTHORIZATION_ERROR", `${why}: ${JSON.stringify(ack)}`);
      }
      await query("COMMIT");
      assert.equal((await one(db, "SELECT sale_status FROM sales WHERE id = 100")).sale_status, "COMPLETED");
      assert.equal(Number((await one(db, "SELECT COUNT(*) AS n FROM sale_change_approvals WHERE status = 'CONSUMED'")).n), 0);
    });
  } finally {
    actorRow = OWNER_ROW;
  }
});

// --- Sync push: one operation's refusal leaves nothing behind -------------------------------
//
// A push batch is one transaction. An offline edit restores the bill's stock and deletes its items,
// allocations and payments before `buildSalePayload` judges the new lines; when that refused the
// edit, the half-done work committed with the rest of the batch while the counter was told
// "rejected" -- a bill with no items and its fruit back on the shelf. Each operation now runs in a
// savepoint and anything short of `accepted` is rolled back to it. Judged by a real Postgres.

const syncEditContext = () => ({ companyId: 1, branchId: 1, operationalLocationId: 1, deviceId: "dev-1", assignmentGeneration: 1, user: { id: OWNER_ID } });

test("a sync edit refused after the bill was taken apart leaves the bill, its lots and its stock untouched", async () => {
  await withDatabase(async ({ db, query, statements }) => {
    await db.exec("CREATE TABLE sale_charges (id SERIAL PRIMARY KEY, sale_id INTEGER)");
    statements.length = 0;
    await query("BEGIN");
    const ack = await processSyncOperation({ query }, {
      operation_id: "op-edit-refused",
      entity_type: "pos_sale",
      entity_id: "sale-g-100",
      operation_type: "SALE_EDIT",
      version: 2,
      payload: {
        reason: "Counter change",
        other_charges: [],
        // A customer the server does not have: refused inside buildSalePayload, i.e. after the
        // reversal and the deletes.
        invoice: { invoice_global_id: "sale-g-100", customer_id: 999 },
        items: [{ product_id: 10, inventory_batch_id: 501, quantity: 1, selling_rate: 200 }],
      },
    }, syncEditContext());
    await query("COMMIT");
    assert.equal(ack.status, "rejected", JSON.stringify(ack));
    assert.equal(ack.error_code, "VALIDATION_ERROR");

    // The edit really did take the bill apart before it was refused...
    assert.ok(statements.some((sql) => /^DELETE FROM sale_items WHERE sale_id = \$1$/.test(sql)), "the deletes ran");
    const savepointAt = statements.indexOf("SAVEPOINT sync_operation");
    const rollbackAt = statements.indexOf("ROLLBACK TO SAVEPOINT sync_operation");
    assert.ok(savepointAt >= 0 && rollbackAt > savepointAt, "the operation was rolled back to its own savepoint");
    // ...and none of it survived.
    assert.equal(Number((await one(db, "SELECT COUNT(*) AS n FROM sale_items WHERE sale_id = 100")).n), 2);
    assert.equal(Number((await one(db, "SELECT COUNT(*) AS n FROM sale_batch_allocations WHERE sale_item_id IN (1000, 1001)")).n), 3);
    const lots = (await db.query("SELECT id, remaining_qty FROM inventory_batches WHERE id IN (501, 502, 503) ORDER BY id")).rows.map((row) => [row.id, qty(row.remaining_qty)]);
    assert.deepEqual(lots, [[501, 0], [502, 0], [503, 0]], "no stock was put back for a bill that still stands");
    assert.equal(Number((await one(db, "SELECT COUNT(*) AS n FROM stock_transactions")).n), 0);
    assert.equal((await one(db, "SELECT sale_status FROM sales WHERE id = 100")).sale_status, "COMPLETED");
  });
});

test("an offline edit that arrives before its bill is answered but not stored, so the next push judges it again", async () => {
  await withDatabase(async ({ query, statements }) => {
    statements.length = 0;
    await query("BEGIN");
    const ack = await processSyncOperation({ query }, {
      operation_id: "op-edit-early",
      entity_type: "pos_sale",
      entity_id: "sale-g-not-yet",
      operation_type: "SALE_EDIT",
      version: 2,
      payload: { reason: "Counter change", other_charges: [], invoice: { invoice_global_id: "sale-g-not-yet" } },
    }, syncEditContext());
    await query("COMMIT");
    assert.equal(ack.status, "rejected");
    assert.equal(ack.error_code, "DEPENDENCY_MISSING");
    assert.equal(statements.filter((sql) => /^INSERT INTO sync_processed_operations/.test(sql)).length, 0, "a stored refusal is replayed forever");
  });
});

test("an offline edit refused for a real reason is still stored as final", async () => {
  await withDatabase(async ({ db, query, statements }) => {
    await db.exec("CREATE TABLE sale_charges (id SERIAL PRIMARY KEY, sale_id INTEGER)");
    statements.length = 0;
    await query("BEGIN");
    const ack = await processSyncOperation({ query }, {
      operation_id: "op-edit-no-reason",
      entity_type: "pos_sale",
      entity_id: "sale-g-100",
      operation_type: "SALE_EDIT",
      version: 2,
      payload: { other_charges: [], invoice: { invoice_global_id: "sale-g-100" } },
    }, syncEditContext());
    await query("COMMIT");
    assert.equal(ack.error_code, "VALIDATION_ERROR");
    assert.equal(statements.filter((sql) => /^INSERT INTO sync_processed_operations/.test(sql)).length, 1);
  });
});
