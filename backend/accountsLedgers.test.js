"use strict";

/**
 * Accounts, ledgers, cash book, day book and balance sheet: the real routes against a real Postgres
 * (PGlite), plus the SQL of the one report too wide to seed.
 *
 * What was wrong before 4 Oct 2026, each pinned below:
 *   - a 'CREDIT' line in sale_payments (sale edits wrote them) was counted as money received, so a
 *     credit bill read as paid in Accounts, the ledgers and Pending Bills;
 *   - Pending Bills spent a customer's receipts on bills while Accounts spent them on the opening
 *     balance first;
 *   - a shop's receivables carried every customer's opening balance, at every shop;
 *   - the customer ledger put a bill on every customer it could match;
 *   - the balance-sheet cash came from its own SQL, which left out refunds and contra entries and
 *     dated a pending bill paid later by its arrival date, so it disagreed with its own drill-down;
 *   - the receivables drill-down showed cancelled bills as "Returns";
 *   - the Day Book showed a credit bill at zero;
 *   - the ledger report credited a cancelled bill's reversal while leaving the bill out, and summed
 *     cancelled payments and expenses;
 *   - a customer payment took its branch from the request body, and an edit moved it.
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

test("pending bills: receipts settle the opening balance before any bill", () => {
  const rows = [{ id: 1, customer_id: 5, customer_name: "Ravi", sale_date: "2026-09-01", total_amount: "1000", sale_paid: "0" }];
  const { invoices } = rules.buildCustomerPendingBills(rows, {
    receiptsByCustomer: new Map([["5", 150]]),
    openingBalanceByCustomer: new Map([["5", 100]]),
  });
  assert.equal(invoices[0].received_amount, 50, "100 of the 150 went to the opening balance");
  assert.equal(invoices[0].balance_amount, 950);
  const none = rules.buildCustomerPendingBills(rows, { receiptsByCustomer: new Map([["5", 150]]) });
  assert.equal(none.invoices[0].balance_amount, 850, "no opening balance: the bill takes it all");
  const short = rules.buildCustomerPendingBills(rows, {
    receiptsByCustomer: new Map([["5", 60]]),
    openingBalanceByCustomer: new Map([["5", 100]]),
  });
  assert.equal(short.invoices[0].received_amount, 0, "never negative");
});

// ---------------------------------------------------------------------------------------------
// Routes, against PGlite
// ---------------------------------------------------------------------------------------------

const app = loadServerApp();
const TEST_SIGNING_KEY = "route-auth-coverage-isolated-signing-key-000000";
const OWNER_ID = 7;
const DEVICE_ID = "FZDEV-ACCOUNTS";
const token = issueDeviceSession({ userId: OWNER_ID, deviceId: DEVICE_ID, companyId: 1, branchId: 1, role: "Owner", secret: TEST_SIGNING_KEY });
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

const SCHEMA = `
  CREATE TABLE branches (id INTEGER PRIMARY KEY, company_id INTEGER, active BOOLEAN DEFAULT TRUE);
  CREATE TABLE customers (
    id INTEGER PRIMARY KEY, customer_name TEXT, mobile_number TEXT, gst_number TEXT, system_account BOOLEAN DEFAULT FALSE,
    active BOOLEAN DEFAULT TRUE, opening_balance NUMERIC(14,2) DEFAULT 0, company_id INTEGER, created_at TIMESTAMP DEFAULT '2026-08-01'
  );
  CREATE TABLE products (id INTEGER PRIMARY KEY, product_name TEXT, unit TEXT, category TEXT);
  CREATE TABLE sales (
    id INTEGER PRIMARY KEY, invoice_no TEXT, customer_id INTEGER, customer_name TEXT, customer_mobile TEXT,
    sale_date DATE, due_date DATE, total_amount NUMERIC(14,2), total_cost NUMERIC(14,2), profit NUMERIC(14,2),
    sale_status TEXT DEFAULT 'COMPLETED', payment_mode TEXT, branch_id INTEGER, gross_amount NUMERIC(14,2),
    item_discount_amount NUMERIC(14,2), invoice_discount_amount NUMERIC(14,2), cancelled_at TIMESTAMP,
    cancellation_reason TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE sale_items (
    id INTEGER PRIMARY KEY, sale_id INTEGER, product_id INTEGER, quantity NUMERIC(14,3), selling_rate NUMERIC(14,2),
    amount NUMERIC(14,2), discount_amount NUMERIC(14,2), net_amount NUMERIC(14,2), cost_amount NUMERIC(14,2), profit NUMERIC(14,2)
  );
  CREATE TABLE inventory_batches (
    id INTEGER PRIMARY KEY, product_id INTEGER, branch_id INTEGER, remaining_qty NUMERIC(14,3), purchase_qty NUMERIC(14,3),
    purchase_rate NUMERIC(14,2), effective_cost_per_unit NUMERIC(14,4), batch_status TEXT, lot_name TEXT, lot_size TEXT,
    batch_no TEXT, stock_source TEXT, remarks TEXT, created_at TIMESTAMP DEFAULT '2026-08-01'
  );
  CREATE TABLE sale_batch_allocations (
    id INTEGER PRIMARY KEY, sale_item_id INTEGER, inventory_batch_id INTEGER, quantity NUMERIC(14,3),
    purchase_rate NUMERIC(14,2), cost_amount NUMERIC(14,2)
  );
  CREATE TABLE sale_payments (id SERIAL PRIMARY KEY, sale_id INTEGER, amount NUMERIC(14,2), payment_mode TEXT, status TEXT DEFAULT 'POSTED');
  CREATE TABLE customer_payments (
    id SERIAL PRIMARY KEY, customer_id INTEGER, payment_amount NUMERIC(14,2), payment_date DATE, payment_mode TEXT,
    reference_number TEXT, remarks TEXT, cancelled BOOLEAN DEFAULT FALSE, branch_id INTEGER, created_by INTEGER,
    edited_by INTEGER, edited_at TIMESTAMP, edit_reason TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE customer_payment_audit (
    id SERIAL PRIMARY KEY, customer_payment_id INTEGER, action TEXT, old_value JSONB, new_value JSONB, reason TEXT, edited_by INTEGER
  );
  CREATE TABLE sale_returns (
    id SERIAL PRIMARY KEY, return_no TEXT, sale_id INTEGER, customer_name TEXT, return_date DATE, refund_type TEXT,
    return_reason TEXT, total_return_amount NUMERIC(14,2), total_cost_amount NUMERIC(14,2), branch_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE suppliers (
    id INTEGER PRIMARY KEY, supplier_name TEXT, firm_name TEXT, mobile_number TEXT, city TEXT, gst_number TEXT,
    opening_balance NUMERIC(14,2) DEFAULT 0, active BOOLEAN DEFAULT TRUE, company_id INTEGER
  );
  CREATE TABLE purchases (
    id INTEGER PRIMARY KEY, supplier_id INTEGER, supplier_name TEXT, purchase_date DATE, payment_date DATE, payment_mode TEXT,
    paid_amount NUMERIC(14,2), purchase_status TEXT, purchase_bill_status TEXT, branch_id INTEGER, gross_amount NUMERIC(14,2),
    total_amount NUMERIC(14,2), net_payable NUMERIC(14,2), rebate_amount NUMERIC(14,2), mandi_tax_amount NUMERIC(14,2),
    freight_charges NUMERIC(14,2), labour_charges NUMERIC(14,2), other_charges NUMERIC(14,2), bill_number TEXT,
    payment_reference_number TEXT, remarks TEXT, purchase_type TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE purchase_items (id INTEGER PRIMARY KEY, purchase_id INTEGER, product_id INTEGER, quantity NUMERIC(14,3), lot_name TEXT);
  CREATE TABLE supplier_payments (
    id SERIAL PRIMARY KEY, supplier_id INTEGER, payment_date DATE, payment_amount NUMERIC(14,2), rebate_amount NUMERIC(14,2) DEFAULT 0,
    payment_mode TEXT, reference_number TEXT, remarks TEXT, cancelled BOOLEAN DEFAULT FALSE, branch_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE expenses (
    id SERIAL PRIMARY KEY, expense_date DATE, category TEXT, amount NUMERIC(14,2), payment_mode TEXT, reference_number TEXT,
    vendor_name TEXT, paid_to TEXT, remarks TEXT, branch_id INTEGER, active BOOLEAN DEFAULT TRUE, status TEXT DEFAULT 'ACTIVE',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE contra_entries (
    id SERIAL PRIMARY KEY, contra_date DATE, contra_type TEXT, amount NUMERIC(14,2), cash_account TEXT, bank_account TEXT,
    reference_number TEXT, remarks TEXT, branch_id INTEGER, cancelled BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE waste_entries (
    id SERIAL PRIMARY KEY, waste_date DATE, product_id INTEGER, quantity NUMERIC(14,3), cost_amount NUMERIC(14,2),
    remarks TEXT, waste_type TEXT, branch_id INTEGER
  );
  CREATE TABLE roles (id INTEGER PRIMARY KEY, role_name TEXT);
  CREATE TABLE users (id INTEGER PRIMARY KEY, role_id INTEGER, active BOOLEAN DEFAULT TRUE);

  INSERT INTO roles VALUES (1, 'Owner');
  INSERT INTO users VALUES (7, 1, TRUE);
  INSERT INTO branches VALUES (1, 1, TRUE), (2, 1, TRUE);
  INSERT INTO products VALUES (10, 'Apple', 'KG', 'Fruit');
  -- Ravi carries an opening balance of 100. Sita and Gita share a mobile number.
  INSERT INTO customers (id, customer_name, mobile_number, opening_balance) VALUES
    (5, 'Ravi', '9000000001', 100), (6, 'Sita', '9000000002', 0), (7, 'Gita', '9000000002', 0);
  -- Another company's customer and supplier: never on this company's sheet.
  INSERT INTO customers (id, customer_name, mobile_number, opening_balance, company_id) VALUES (8, 'Other Co', '9000000009', 999, 2);

  -- 200: a 1000 credit bill carrying a legacy 'CREDIT' payment line for the full amount.
  -- 201: a 500 MIXED bill: 300 cash, and a legacy 'CREDIT' line for the other 200.
  -- 202: a 400 cash bill, cancelled.
  -- 203: a 250 credit bill with no payment line, matched by a mobile number two customers share.
  INSERT INTO sales (id, invoice_no, customer_id, customer_name, customer_mobile, sale_date, total_amount, total_cost, profit,
    sale_status, payment_mode, branch_id, gross_amount, cancelled_at, cancellation_reason) VALUES
    (200, 'FZ-200', 5, 'Ravi', '9000000001', '2026-09-01', 1000, 600, 400, 'COMPLETED', 'CREDIT', 1, 1000, NULL, NULL),
    (201, 'FZ-201', 5, 'Ravi', '9000000001', '2026-09-02', 500, 300, 200, 'COMPLETED', 'MIXED', 1, 500, NULL, NULL),
    (202, 'FZ-202', 5, 'Ravi', '9000000001', '2026-09-03', 400, 200, 200, 'CANCELLED', 'CASH', 1, 400, '2026-09-03', 'Wrong bill'),
    (203, 'FZ-203', NULL, 'Walk-in', '9000000002', '2026-09-02', 250, 150, 100, 'COMPLETED', 'CREDIT', 1, 250, NULL, NULL);
  INSERT INTO sale_items VALUES (2000, 200, 10, 10, 100, 1000, 0, 1000, 600, 400);
  INSERT INTO sale_payments (sale_id, amount, payment_mode, status) VALUES
    (200, 1000, 'CREDIT', 'POSTED'), (201, 300, 'CASH', 'POSTED'), (201, 200, 'CREDIT', 'POSTED'), (202, 400, 'CASH', 'REVERSED');
  INSERT INTO customer_payments (customer_id, payment_amount, payment_date, payment_mode, cancelled, branch_id) VALUES
    (5, 150, '2026-09-05', 'CASH', FALSE, 1), (5, 70, '2026-09-05', 'CASH', TRUE, 1);
  -- A 30 credit note on bill 200, and a 20 cash refund on bill 201.
  INSERT INTO sale_returns (return_no, sale_id, customer_name, return_date, refund_type, return_reason, total_return_amount, total_cost_amount, branch_id) VALUES
    ('RET-1', 200, 'Ravi', '2026-09-06', 'CREDIT_NOTE', 'Spoilt', 30, 18, 1),
    ('RET-2', 201, 'Ravi', '2026-09-06', 'CASH_REFUND', 'Spoilt', 20, 12, 1);
  -- 50 cash into the bank on the 4th.
  INSERT INTO contra_entries (contra_date, contra_type, amount, branch_id) VALUES ('2026-09-04', 'CASH_TO_BANK', 50, 1);
  -- A pending bill that arrived on the 1st and was completed and paid 300 cash on the 10th.
  INSERT INTO suppliers (id, supplier_name, company_id, opening_balance) VALUES (40, 'Mandi Traders', 1, 0), (41, 'Elsewhere Ltd', 2, 500);
  INSERT INTO purchases (id, supplier_id, supplier_name, purchase_date, payment_date, payment_mode, paid_amount, purchase_status,
    purchase_bill_status, branch_id, gross_amount, total_amount, net_payable, rebate_amount, purchase_type) VALUES
    (300, 40, 'Mandi Traders', '2026-09-01', '2026-09-10', 'CASH', 300, 'ACTIVE', 'BILL_COMPLETED', 1, 300, 300, 300, 0, 'CASH');
`;

const PERMISSION_SQL = /FROM\s+users\s+u\s+JOIN\s+roles\s+r/i;
const OWNER_ROW = { id: OWNER_ID, full_name: "Rig Owner", username: "rig", branch_id: 1, role_name: "Owner", permissions: {}, can_edit_sales: true, can_cancel_sales: true };
const scopeAnswer = (sql) => {
  if (/SELECT session_revocation_version FROM users WHERE id = \$1 AND active IS DISTINCT FROM FALSE/i.test(sql.replace(/\s+/g, " "))) {
    return { rows: [{ session_revocation_version: 0 }], rowCount: 1 };
  }
  return undefined;
};

const withDatabase = async (run) => {
  const { PGlite } = require("@electric-sql/pglite");
  const db = new PGlite();
  await db.exec(SCHEMA);
  const query = async (text, values) => {
    const sql = String(typeof text === "object" && text ? text.text : text || "");
    const scoped = scopeAnswer(sql);
    if (scoped) return scoped;
    if (PERMISSION_SQL.test(sql)) return { rows: [OWNER_ROW], rowCount: 1 };
    const result = await db.query(sql, values || []);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  };
  setQueryResponder((sql, values) => query(sql, values));
  setConnectionResponder(() => ({ query, release: () => {} }));
  try {
    return await run({ db });
  } finally {
    clearQueryResponder();
    clearConnectionResponder();
    await db.close();
  }
};

const get = async (url) => {
  const response = await probe(app, "GET", url, headers);
  assert.equal(response.status, 200, `${url}: ${JSON.stringify(response.body)}`);
  return response.body;
};
const money = (value) => Number(value);

test("a 'CREDIT' payment line is not money received, anywhere a customer's balance is read", async () => {
  await withDatabase(async () => {
    // 100 opening + 1500 of bills - 300 cash - 150 receipt - 30 credit note. The cancelled bill,
    // the cancelled receipt, the cash refund and both 'CREDIT' lines count for nothing.
    const summary = await get("/customer-summary?customer_id=5");
    assert.equal(money(summary.customers[0].total_paid), 450);
    assert.equal(money(summary.customers[0].outstanding_balance), 1120);

    const ledger = await get("/customer-ledger?customer_id=5");
    assert.equal(ledger.ledger.at(-1).running_balance, 1120, "the ledger ends where the summary says");

    const accountLedger = await get("/accounts/ledger?account_key=CUSTOMER-5");
    assert.equal(accountLedger.ledger.at(-1).balance, 1120);
    assert.equal(accountLedger.ledger.find((row) => row.invoice_no === "FZ-200").credit, 0, "the credit bill was not paid");

    // Pending bills: the 150 receipt settles the 100 opening balance first, so bill 200 is
    // 1000 - 30 credit note - 50 = 920 open. With the 'CREDIT' line counted it read as paid.
    const pending = await get("/pending-bills/customer");
    const bill = pending.invoices.find((row) => String(row.id) === "200");
    assert.equal(bill.received_amount, 50);
    assert.equal(bill.returned_amount, 30);
    assert.equal(bill.balance_amount, 920);
  });
});

test("the customer ledger puts a bill on one customer, the one the balance uses", async () => {
  await withDatabase(async () => {
    const sita = await get("/customer-ledger?customer_id=6");
    const gita = await get("/customer-ledger?customer_id=7");
    assert.equal(sita.ledger.filter((row) => row.transaction_type === "Sale").length, 1);
    assert.equal(gita.ledger.filter((row) => row.transaction_type === "Sale").length, 0, "the shared mobile matched the lower id only");
    const gitaSummary = await get("/customer-summary?customer_id=7");
    assert.equal(money(gitaSummary.customers[0].outstanding_balance), 0);
  });
});

test("balance sheet: cash is the cash book's closing cash, and receivables carry no opening balance at a shop", async () => {
  await withDatabase(async () => {
    // As at the 8th: 300 cash sale + 150 receipt - 50 to bank - 20 refund. The purchase was paid on
    // the 10th, not the 1st it arrived.
    const sheet = await get("/reports/balance-sheet?date_to=2026-09-08");
    assert.equal(sheet.cash, 380);
    assert.equal(sheet.bank, 50);
    const drill = await get("/reports/balance-sheet/details/cash_in_hand?date_from=2026-09-01&date_to=2026-09-08");
    assert.equal(drill.closingBalance, sheet.cash, "headline and drill-down are one figure");
    const bankDrill = await get("/reports/balance-sheet/details/cash_at_bank?date_from=2026-09-01&date_to=2026-09-08");
    assert.equal(bankDrill.closingBalance, sheet.bank);

    const later = await get("/reports/balance-sheet?date_to=2026-09-10");
    assert.equal(later.cash, 80, "the purchase leaves the drawer on its payment date");
    const cashBook = await get("/reports/cash-book?date_from=2026-09-01&date_to=2026-09-10");
    const purchase = cashBook.rows.find((row) => row.source_type === "Purchase Payment");
    assert.equal(purchase.date, "2026-09-10");

    // Ravi 1500 - 300 - 150 - 30, Sita 250; Ravi's opening 100 belongs to no one shop.
    assert.equal(sheet.customerReceivable, 1270);
    const receivables = await get("/reports/balance-sheet/details/customer_receivables?date_from=2026-09-01&date_to=2026-09-08");
    const ravi = receivables.rows.find((row) => row.customer_name === "Ravi");
    assert.equal(money(ravi.returns), 30, "credit-note returns, not the cancelled 400 bill");
    assert.equal(money(ravi.opening_balance), 0, "the opening balance the shop figure did not count");
    assert.equal(money(ravi.balance), 1020);
    // Mandi Traders' 300 bill came on the 1st and was paid on the 10th, so on the 8th it is still
    // owed (it read as settled while the cash was still in the drawer). Elsewhere Ltd's 500 is
    // another company's supplier and is not this shop's payable.
    assert.equal(sheet.supplierPayable, 300, "owed until paid on the 10th; another company's supplier is not this shop's payable");
    assert.equal((await get("/reports/balance-sheet?date_to=2026-09-10")).supplierPayable, 0, "paid on the 10th");
    assert.ok(!receivables.rows.some((row) => row.customer_name === "Other Co"));
  });
});

test("a company with one active branch: the shop's receivables carry the opening balance, as Accounts does", async () => {
  await withDatabase(async ({ db }) => {
    await db.query("UPDATE branches SET active = FALSE WHERE id = 2");
    const sheet = await get("/reports/balance-sheet?date_to=2026-09-08");
    // 1270 + Ravi's 100. Other Co's 999 belongs to company 2.
    assert.equal(sheet.customerReceivable, 1370);
    const receivables = await get("/reports/balance-sheet/details/customer_receivables?date_from=2026-09-01&date_to=2026-09-08");
    const ravi = receivables.rows.find((row) => row.customer_name === "Ravi");
    assert.equal(money(ravi.opening_balance), 100);
    assert.equal(money(ravi.balance), 1120);
    const accounts = await get("/customer-summary?customer_id=5");
    assert.equal(money(accounts.customers[0].outstanding_balance), money(ravi.balance), "the sheet and Accounts agree");
  });
});

test("day book: a credit bill shows its value, and a 'CREDIT' line is not a receipt", async () => {
  await withDatabase(async () => {
    const book = await get("/reports/day-book?date_from=2026-09-01&date_to=2026-09-02");
    const sales = book.rows.filter((row) => row.voucher_type === "POS Sale");
    const line = (voucherNo, mode) => sales.filter((row) => row.voucher_no === voucherNo && row.payment_mode === mode);
    assert.equal(money(line("FZ-203", "CREDIT")[0].debit), 250, "a bill with no payment line is not zero");
    assert.equal(money(line("FZ-200", "CREDIT")[0].debit), 1000);
    assert.equal(money(line("FZ-201", "CASH")[0].credit), 300);
    assert.equal(money(line("FZ-201", "CREDIT")[0].debit), 200, "the unpaid part, not the whole bill");
    assert.equal(sales.length, 4);
  });
});

test("a customer payment is recorded at the signed-in branch, and an edit does not move it", async () => {
  await withDatabase(async ({ db }) => {
    const created = await probe(app, "POST", "/accounts/payments", headers, {
      account_key: "CUSTOMER-5", payment_action: "RECEIVE_CUSTOMER", amount: 10, payment_mode: "CASH", payment_date: "2026-09-07",
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.branch_id, 1, "the session's branch, not a NULL from a missing body field");

    // A payment taken at the other shop, corrected from this one.
    await db.query("UPDATE customer_payments SET branch_id = 2 WHERE id = $1", [created.body.id]);
    const edited = await probe(app, "PUT", `/accounts/payments/CUSTOMER-${created.body.id}`, headers, {
      account_key: "CUSTOMER-5", amount: 12, payment_mode: "CASH", payment_date: "2026-09-07", reason: "Typo",
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(money(edited.body.payment_amount), 12);
    assert.equal(edited.body.branch_id, 2, "it stays at the branch that took the money");
  });
});

// ---------------------------------------------------------------------------------------------
// The summary report: too wide to seed, so what its SQL says
// ---------------------------------------------------------------------------------------------

const summaryStatements = async () => {
  setQueryResponder((sql) => (PERMISSION_SQL.test(sql) ? { rows: [OWNER_ROW], rowCount: 1 } : undefined));
  try {
    startQueryRecording();
    await probe(app, "GET", "/reports/summary?date_from=2026-10-01&date_to=2026-10-03", headers);
    return stopQueryRecording().map((sql) => sql.replace(/\s+/g, " "));
  } finally {
    clearQueryResponder();
  }
};

test("ledger report: a cancelled document is left out with its reversal, and cancelled vouchers are not summed", async () => {
  const statements = await summaryStatements();
  const ledger = statements.find((sql) => /'Supplier Rebate' AS transaction_type/.test(sql));
  assert.ok(ledger, "the ledger statement ran");
  assert.doesNotMatch(ledger, /Cancellation' AS transaction_type/);
  assert.match(ledger, /sp\.branch_id = \$3 AND sp\.cancelled = FALSE/);
  assert.match(ledger, /cp\.branch_id = \$3 AND cp\.cancelled = FALSE/);
  assert.match(ledger, /e\.branch_id = \$3 AND e\.active IS DISTINCT FROM FALSE AND COALESCE\(e\.status, 'ACTIVE'\) <> 'CANCELLED'/);
  assert.match(ledger, /FROM sale_payments WHERE payment_mode IS DISTINCT FROM 'CREDIT' GROUP BY sale_id/);
});

test("sales history carries each bill's payments, so a MIXED bill can be split by mode", async () => {
  const statements = await summaryStatements();
  const history = statements.find((sql) => /AS items FROM sales s/.test(sql) && /AS payments/.test(sql));
  assert.ok(history, "the sales history statement carries payments");
  assert.match(history, /JSON_BUILD_OBJECT\('mode', sp\.payment_mode, 'amount', sp\.amount\)/);
  assert.match(history, /sp\.sale_id = s\.id AND sp\.payment_mode IS DISTINCT FROM 'CREDIT'/);
});

// ---------------------------------------------------------------------------------------------
// Supplier Ledger: balance brought forward (UI-10), as-at Balance Sheet (UI-9), low stock (UI-3)
// ---------------------------------------------------------------------------------------------

// Columns the wide ledger statement reads that the shared schema above does not carry.
const LEDGER_COLUMNS = `
  ALTER TABLE purchases ADD COLUMN payment_status TEXT;
  ALTER TABLE purchase_items ADD COLUMN purchase_rate NUMERIC(14,2);
  ALTER TABLE purchase_items ADD COLUMN basic_amount NUMERIC(14,2);
  CREATE TABLE sale_return_items (id SERIAL PRIMARY KEY, sale_return_id INTEGER, product_id INTEGER, return_quantity NUMERIC(14,3), selling_rate NUMERIC(14,2), return_amount NUMERIC(14,2));
`;

// Mandi Traders: opening balance 1000. Bill 300 (300, came 1 Sep, paid 10 Sep, from the shared seed);
// bill 301 (2 Sep, gross 1100 with a 100 bill rebate, so 1000 net, 200 paid at the mandi); bill 302
// still pending, so not yet owed; a 150 payment with 50 rebate on 4 Sep; a cancelled 999 payment.
const SUPPLIER_LEDGER_SEED = `
  UPDATE suppliers SET opening_balance = 1000 WHERE id = 40;
  INSERT INTO purchases (id, supplier_id, supplier_name, purchase_date, payment_date, payment_mode, paid_amount, purchase_status,
    purchase_bill_status, branch_id, gross_amount, total_amount, net_payable, rebate_amount, bill_number, purchase_type) VALUES
    (301, 40, 'Mandi Traders', '2026-09-02', '2026-09-02', 'CASH', 200, 'ACTIVE', 'BILL_COMPLETED', 1, 1100, 1000, 1000, 100, 'MT-301', 'CREDIT'),
    (302, 40, 'Mandi Traders', '2026-09-03', NULL, NULL, 0, 'ACTIVE', 'BILL_PENDING', 1, 500, 500, 500, 0, 'MT-302', 'CREDIT');
  INSERT INTO supplier_payments (supplier_id, payment_date, payment_amount, rebate_amount, payment_mode, cancelled, branch_id) VALUES
    (40, '2026-09-04', 150, 50, 'CASH', FALSE, 1), (40, '2026-09-04', 999, 0, 'CASH', TRUE, 1);
`;

const supplierLedger = (report) => report.ledgerReport.filter((row) => row.account_key === "SUPPLIER-40");
const payable = (row) => money(row.credit) - money(row.debit);

test("supplier ledger: a period opens with the balance brought forward, and runs on to what Accounts says", async () => {
  await withDatabase(async ({ db }) => {
    await db.exec(LEDGER_COLUMNS + SUPPLIER_LEDGER_SEED);
    const accounts = await get("/supplier-summary?supplier_id=40");
    // 1000 + 300 + 1100 - 100 rebate - (300 + 200) paid - 150 - 50 rebate.
    assert.equal(money(accounts.suppliers[0].outstanding_balance), 1600);

    // "Today" (the 12th): nothing happened, and the ledger still says 1600 is owed.
    const today = await get("/reports/summary?date_from=2026-09-12&date_to=2026-09-12");
    assert.deepEqual(supplierLedger(today), []);
    const [broughtForward] = today.ledgerOpeningBalances.filter((row) => row.account_key === "SUPPLIER-40");
    assert.equal(broughtForward.opening_balance, 1600);
    assert.equal(broughtForward.credit, 1600, "owed to the supplier: a credit balance");
    assert.equal(broughtForward.date, "2026-09-12");
    assert.equal(broughtForward.voucher_no, "B/F");
    assert.ok(!today.ledgerOpeningBalances.some((row) => row.party_name === "Elsewhere Ltd"), "another company's supplier");

    // From the 5th: 1900 brought forward, then the 300 paid on the 10th.
    const late = await get("/reports/summary?date_from=2026-09-05&date_to=2026-09-12");
    const lateOpening = late.ledgerOpeningBalances.find((row) => row.account_key === "SUPPLIER-40");
    assert.equal(lateOpening.opening_balance, 1900);
    const lateRows = supplierLedger(late);
    assert.deepEqual(lateRows.map((row) => [row.transaction_type, String(row.date).slice(0, 10), money(row.debit)]), [["Supplier Payment", "2026-09-10", 300]]);
    assert.equal(lateOpening.opening_balance + lateRows.reduce((sum, row) => sum + payable(row), 0), 1600);

    // The whole month: the supplier's own opening balance is brought forward, and every row runs to 1600.
    const month = await get("/reports/summary?date_from=2026-09-01&date_to=2026-09-30");
    assert.equal(month.ledgerOpeningBalances.find((row) => row.account_key === "SUPPLIER-40").opening_balance, 1000);
    const rows = supplierLedger(month);
    assert.equal(1000 + rows.reduce((sum, row) => sum + payable(row), 0), 1600);
    const bill = rows.find((row) => row.transaction_type === "Supplier Purchase" && row.voucher_no === "MT-301");
    assert.equal(money(bill.credit), 1100, "the gross bill; its rebate is the separate debit, taken once");
    assert.equal(rows.filter((row) => row.transaction_type === "Supplier Rebate").map((row) => money(row.debit)).join(), "100");
    assert.ok(rows.some((row) => row.transaction_type === "Supplier Payment" && money(row.debit) === 200 && String(row.date).startsWith("2026-09-02")), "paid at the mandi");
    assert.ok(!rows.some((row) => row.voucher_no === "MT-302"), "a pending bill is not owed yet");
    assert.ok(!rows.some((row) => money(row.debit) === 999), "a cancelled payment");
    assert.equal(month.ledgerOpeningBalances.filter((row) => row.account_key === "SUPPLIER-40").length, 1);
    assert.ok(!month.ledgerReport.some((row) => row.transaction_type === "Opening Balance"), "the Day Book reads ledgerReport: no b/f rows in it");

    const sheet = await get("/reports/balance-sheet?date_to=2026-09-12");
    assert.equal(sheet.supplierPayable, 1600, "the balance sheet's payable is where the ledger ends");
  });
});

test("supplier ledger: a failed opening-balance query is null, not an empty list", () => {
  const route = require("node:fs").readFileSync(require("node:path").join(__dirname, "server.js"), "utf8");
  const summary = route.slice(route.indexOf('app.get("/reports/summary"'), route.indexOf("ledgerOpeningBalances,\n"));
  assert.match(summary, /getSupplierLedgerOpeningBalances\(\{ dateFrom, branchId: req\.auth\.branchId \}\)\.catch\(\(error\) => \{[\s\S]*?return null;/);
});

test("balance sheet: as at one date; a range or 'today' control does not move it", async (t) => {
  await withDatabase(async () => {
    const asAt = await get("/reports/balance-sheet?date_to=2026-09-08&range=today&date_from=2026-09-08");
    assert.equal(asAt.asAtDate, "2026-09-08");
    assert.equal(asAt.dateFrom, undefined, "an as-at sheet has no range start");
    const named = await get("/reports/balance-sheet?as_at=2026-09-08&range=month");
    assert.equal(named.cash, asAt.cash);
    assert.equal(named.asAtDate, "2026-09-08");
    const bad = await probe(app, "GET", "/reports/balance-sheet?as_at=08-09-2026", headers);
    assert.equal(bad.status, 400);

    const summary = await get("/reports/summary?date_from=2026-09-01&date_to=2026-09-08");
    assert.equal(summary.balanceSheet.asAtDate, "2026-09-08");
    assert.equal(summary.balanceSheet.unavailable, false);
    assert.equal(summary.balanceSheet.cash, asAt.cash);

    // With no date it is as at today in India: 23:00 UTC on the 24th is the 25th.
    t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-24T23:00:00Z") });
    const signed = issueDeviceSession({ userId: OWNER_ID, deviceId: DEVICE_ID, companyId: 1, branchId: 1, role: "Owner", secret: TEST_SIGNING_KEY });
    const undated = await probe(app, "GET", "/reports/balance-sheet", { authorization: `Bearer ${signed}` });
    assert.equal(undated.status, 200, JSON.stringify(undated.body));
    assert.equal(undated.body.asAtDate, "2026-10-25");
    const todayRange = await probe(app, "GET", "/reports/summary?range=today", { authorization: `Bearer ${signed}` });
    assert.equal(todayRange.body.dateFrom, "2026-10-25");
    assert.equal(todayRange.body.balanceSheet.asAtDate, "2026-10-25");
  });
});

test("dashboard low stock is Products' 'Low': stock at or below the product's own minimum, none set is not low", async () => {
  const { pathToFileURL } = require("node:url");
  const { isLowStock } = await import(pathToFileURL(require("node:path").join(__dirname, "..", "frontend", "src", "local", "productMaster.js")).href);
  const { DASHBOARD_LOW_STOCK_SQL } = require("./server");
  await withDatabase(async ({ db }) => {
    await db.exec(`
      ALTER TABLE products ADD COLUMN minimum_stock NUMERIC(14,3);
      ALTER TABLE products ADD COLUMN active BOOLEAN DEFAULT TRUE;
      UPDATE products SET minimum_stock = 0 WHERE id = 10;
      INSERT INTO products (id, product_name, unit, minimum_stock, active) VALUES
        (11, 'Mango', 'KG', 0, TRUE),    -- no stock at all, minimum 0: low (Products shows "0.000 Kg Low")
        (12, 'Banana', 'KG', NULL, TRUE), -- 4 kg, no minimum set: not low (was low under a default of 5)
        (13, 'Grapes', 'KG', 5, TRUE),    -- 3 kg against 5: low
        (14, 'Kiwi', 'KG', 2, TRUE),      -- 10 kg against 2: not low
        (15, 'Plum', 'KG', 5, FALSE);     -- inactive
      INSERT INTO inventory_batches (id, product_id, branch_id, remaining_qty, batch_status) VALUES
        (1, 10, 1, 8, 'ACTIVE'), (2, 12, 1, 4, 'ACTIVE'), (3, 13, 1, 3, 'ACTIVE'), (4, 14, 1, 10, 'ACTIVE'),
        (5, 11, 2, 50, 'ACTIVE'), (6, 13, 1, 40, 'CANCELLED');
    `);
    const dashboard = (await db.query(DASHBOARD_LOW_STOCK_SQL, [1])).rows.map((row) => row.product_name).sort();
    assert.deepEqual(dashboard, ["Grapes", "Mango"]);

    // The same products through Products' own rule, given what GET /products sends for this branch.
    const products = (await db.query(`
      SELECT p.product_name, p.minimum_stock, p.active,
        COALESCE((SELECT SUM(remaining_qty) FROM inventory_batches ib WHERE ib.product_id = p.id AND ib.branch_id = 1
          AND COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED'), 0) AS current_stock
      FROM products p
    `)).rows;
    const productsLow = products.filter((row) => row.active !== false && isLowStock(row)).map((row) => row.product_name).sort();
    assert.deepEqual(dashboard, productsLow);
  });
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "server.js"), "utf8");
  assert.equal(source.match(/\$\{DASHBOARD_LOW_STOCK_SQL\}/g).length, 2, "the tile's count and the list read one statement");
  assert.doesNotMatch(source, /COALESCE\(p\.minimum_stock, 5\)/);
});
