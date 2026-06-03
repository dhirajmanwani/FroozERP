const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  user: process.env.DB_USER || "postgres",
  host: process.env.DB_HOST || "localhost",
  database: process.env.DB_NAME || "froozerp",
  password: process.env.DB_PASSWORD || "8386",
  port: Number(process.env.DB_PORT) || 5432,
});
const port = Number(process.env.PORT) || 5000;

const parsePositiveNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

const parsePositiveInteger = (value) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
};

const parseNonNegativeNumber = (value) => {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

const roundCurrency = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const roundUnitCost = (value) => Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;
const applySaleRateRounding = (value, rule) => {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return 0;
  switch (rule) {
    case "ROUND_UP_5":
      return Math.ceil(amount / 5) * 5;
    case "ROUND_UP_10":
      return Math.ceil(amount / 10) * 10;
    case "NO_ROUND":
      return roundCurrency(amount);
    case "NEAREST_RUPEE":
    default:
      return Math.round(amount);
  }
};
const toDateKey = (value) =>
  value instanceof Date ? value.toLocaleDateString("en-CA") : String(value).slice(0, 10);
const RATE_MANAGER_ROLES = new Set(["Owner", "Admin"]);
const SUPPLIER_TYPES = new Set(["LOCAL_SUPPLIER", "IMPORTED_SUPPLIER", "COMMISSION_AGENT", "TRANSPORT_VENDOR"]);
const SUPPLIER_PAYMENT_MODES = new Set(["CASH", "UPI", "BANK_TRANSFER", "CHEQUE"]);
const CUSTOMER_TYPES = new Set(["RETAIL", "WHOLESALE"]);
const ACCOUNT_TYPES = new Set(["CUSTOMER", "SUPPLIER", "TRANSPORT_VENDOR", "COMMISSION_AGENT", "STAFF", "OTHER"]);
const DISCOUNT_TYPES = new Set(["FLAT_AMOUNT", "PERCENTAGE"]);
const DISCOUNT_PAYMENT_MODES = new Set(["ALL", "CASH", "UPI", "CARD"]);
const ROUNDING_RULES = new Set(["NEAREST_RUPEE", "ROUND_UP_5", "ROUND_UP_10", "NO_ROUND"]);
const SALE_STATUSES = new Set(["COMPLETED", "EDITED", "CANCELLED"]);

const cleanText = (value) => (typeof value === "string" ? value.trim() : "");
const nullableText = (value) => cleanText(value) || null;
const normalizeSupplierType = (value) => String(value || "LOCAL_SUPPLIER").toUpperCase();
const normalizePaymentMode = (value) => String(value || "").trim().toUpperCase().replace(/\s+/g, "_");
const normalizeDiscountType = (value) => String(value || "FLAT_AMOUNT").toUpperCase();
const normalizeDiscountPaymentMode = (value) => String(value || "ALL").trim().toUpperCase();

const requireRateManager = async (userId, client = pool) => {
  const parsedUserId = parsePositiveInteger(userId);
  if (!parsedUserId) return null;
  const result = await client.query(
    `
    SELECT u.id, u.full_name, r.role_name
    FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE u.id = $1 AND u.active = TRUE
    `,
    [parsedUserId]
  );
  const user = result.rows[0];
  return user && RATE_MANAGER_ROLES.has(user.role_name) ? user : null;
};

const initializeDatabase = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sales (
      id SERIAL PRIMARY KEY,
      total_amount NUMERIC(14, 2) NOT NULL,
      total_cost NUMERIC(14, 2) NOT NULL,
      profit NUMERIC(14, 2) NOT NULL,
      branch_id INTEGER REFERENCES branches(id),
      created_by INTEGER REFERENCES users(id),
      sale_date DATE DEFAULT CURRENT_DATE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id SERIAL PRIMARY KEY,
      supplier_name VARCHAR(160) NOT NULL,
      firm_name VARCHAR(160),
      mobile_number VARCHAR(30),
      alternate_number VARCHAR(30),
      address TEXT,
      city VARCHAR(100),
      gst_number VARCHAR(60),
      bank_name VARCHAR(120),
      account_number VARCHAR(80),
      ifsc_code VARCHAR(30),
      upi_id VARCHAR(120),
      notes TEXT,
      opening_balance NUMERIC(14, 2) DEFAULT 0 CHECK (opening_balance >= 0),
      supplier_type VARCHAR(40) NOT NULL DEFAULT 'LOCAL_SUPPLIER',
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode VARCHAR(100);
    ALTER TABLE products ADD COLUMN IF NOT EXISTS origin_type VARCHAR(20) DEFAULT 'LOCAL';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS category VARCHAR(80) DEFAULT 'Fruit';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS selling_rate_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS selling_rate_updated_by INTEGER REFERENCES users(id);
    UPDATE products SET origin_type = 'LOCAL' WHERE origin_type IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS products_barcode_unique_idx
      ON products (barcode)
      WHERE barcode IS NOT NULL AND barcode <> '';

    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS basic_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS supplier_id INTEGER;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS mandi_tax_percent NUMERIC(6, 3) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS mandi_tax_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS other_charges NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS gross_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS rebate_percent NUMERIC(6, 3) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS rebate_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS net_payable NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS balance_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS payment_timing VARCHAR(30) DEFAULT 'LATER';
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS effective_cost_per_unit NUMERIC(14, 4) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS freight_charges NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS labour_charges NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS rebate_rule_id INTEGER;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS payment_due_days INTEGER DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) DEFAULT 'PENDING';
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS payment_date DATE;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS purchase_type VARCHAR(20) DEFAULT 'CREDIT';
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS payment_mode VARCHAR(30);
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS payment_reference_number VARCHAR(120);

    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS basic_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS mandi_tax_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS other_charges NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS rebate_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS net_payable NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS effective_cost_per_unit NUMERIC(14, 4) DEFAULT 0;
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS freight_charges NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS labour_charges NUMERIC(14, 2) DEFAULT 0;

    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS effective_cost_per_unit NUMERIC(14, 4);
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS supplier_id INTEGER;
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS mandi_tax_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS freight_charges NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS labour_charges NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS other_charges NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS gross_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS rebate_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS net_payable NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS payment_timing VARCHAR(120);
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS balance_amount NUMERIC(14, 2) DEFAULT 0;
    UPDATE inventory_batches SET effective_cost_per_unit = purchase_rate WHERE effective_cost_per_unit IS NULL;

    CREATE TABLE IF NOT EXISTS mandi_tax_rules (
      id SERIAL PRIMARY KEY,
      origin_type VARCHAR(20) NOT NULL UNIQUE,
      tax_percent NUMERIC(6, 3) NOT NULL CHECK (tax_percent >= 0),
      active BOOLEAN DEFAULT TRUE,
      updated_by INTEGER REFERENCES users(id),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS rebate_rules (
      id SERIAL PRIMARY KEY,
      rule_name VARCHAR(120) NOT NULL,
      pay_within_days INTEGER NOT NULL CHECK (pay_within_days >= 0),
      rebate_percent NUMERIC(6, 3) NOT NULL CHECK (rebate_percent >= 0),
      active BOOLEAN DEFAULT TRUE,
      updated_by INTEGER REFERENCES users(id),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sale_rate_history (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id),
      old_selling_rate NUMERIC(14, 2) NOT NULL,
      new_selling_rate NUMERIC(14, 2) NOT NULL,
      changed_by INTEGER NOT NULL REFERENCES users(id),
      reason TEXT,
      changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS business_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      business_name VARCHAR(180) NOT NULL DEFAULT 'FroozERP Retail',
      brand_name VARCHAR(180) NOT NULL DEFAULT 'FEEL THE FREAKIN'' FROOZ',
      company_name VARCHAR(180) NOT NULL DEFAULT 'SRT Company',
      address TEXT,
      phone_number VARCHAR(40),
      gst_number VARCHAR(80),
      logo_url TEXT,
      compact_logo_text VARCHAR(40) DEFAULT 'FTF',
      invoice_footer_text TEXT DEFAULT 'Thank you for shopping with FEEL THE FREAKIN'' FROOZ.',
      updated_by INTEGER REFERENCES users(id),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sale_rate_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      desired_margin_percent NUMERIC(6, 2) NOT NULL DEFAULT 25 CHECK (desired_margin_percent >= 0),
      rounding_rule VARCHAR(30) NOT NULL DEFAULT 'NEAREST_RUPEE',
      suggestion_enabled BOOLEAN DEFAULT TRUE,
      notes TEXT,
      updated_by INTEGER REFERENCES users(id),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sale_discount_rules (
      id SERIAL PRIMARY KEY,
      rule_name VARCHAR(140) NOT NULL,
      minimum_bill_amount NUMERIC(14, 2) NOT NULL CHECK (minimum_bill_amount >= 0),
      maximum_bill_amount NUMERIC(14, 2) CHECK (maximum_bill_amount IS NULL OR maximum_bill_amount >= 0),
      discount_type VARCHAR(30) NOT NULL,
      discount_value NUMERIC(14, 2) NOT NULL CHECK (discount_value >= 0),
      payment_mode VARCHAR(20) NOT NULL DEFAULT 'ALL',
      active BOOLEAN DEFAULT TRUE,
      updated_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS supplier_payments (
      id SERIAL PRIMARY KEY,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
      payment_amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (payment_amount >= 0),
      rebate_amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (rebate_amount >= 0),
      payment_mode VARCHAR(30) NOT NULL,
      reference_number VARCHAR(120),
      remarks TEXT,
      branch_id INTEGER REFERENCES branches(id),
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS cancelled BOOLEAN DEFAULT FALSE;
    ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS cancelled_by INTEGER REFERENCES users(id);
    ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP;
    ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
    ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS edited_by INTEGER REFERENCES users(id);
    ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP;
    ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS edit_reason TEXT;

    CREATE TABLE IF NOT EXISTS supplier_payment_audit (
      id SERIAL PRIMARY KEY,
      supplier_payment_id INTEGER NOT NULL REFERENCES supplier_payments(id),
      action VARCHAR(30) NOT NULL,
      old_value JSONB,
      new_value JSONB,
      reason TEXT NOT NULL,
      edited_by INTEGER REFERENCES users(id),
      edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      customer_name VARCHAR(160) NOT NULL,
      customer_type VARCHAR(20) NOT NULL DEFAULT 'RETAIL',
      mobile_number VARCHAR(20),
      address TEXT,
      gst_number VARCHAR(80),
      notes TEXT,
      opening_balance NUMERIC(14, 2) DEFAULT 0 CHECK (opening_balance >= 0),
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE customers ADD COLUMN IF NOT EXISTS firm_name VARCHAR(160);
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS alternate_number VARCHAR(30);
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS city VARCHAR(100);
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS bank_name VARCHAR(120);
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS account_number VARCHAR(80);
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS ifsc_code VARCHAR(30);
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS upi_id VARCHAR(120);

    CREATE TABLE IF NOT EXISTS accounts (
      id SERIAL PRIMARY KEY,
      account_name VARCHAR(160) NOT NULL,
      account_type VARCHAR(30) NOT NULL,
      firm_name VARCHAR(160),
      mobile_number VARCHAR(30),
      alternate_number VARCHAR(30),
      address TEXT,
      city VARCHAR(100),
      gst_number VARCHAR(80),
      bank_name VARCHAR(120),
      account_number VARCHAR(80),
      ifsc_code VARCHAR(30),
      upi_id VARCHAR(120),
      opening_balance NUMERIC(14, 2) DEFAULT 0 CHECK (opening_balance >= 0),
      active BOOLEAN DEFAULT TRUE,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS customer_payments (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
      payment_amount NUMERIC(14, 2) NOT NULL CHECK (payment_amount > 0),
      payment_mode VARCHAR(20) NOT NULL,
      reference_number VARCHAR(120),
      remarks TEXT,
      branch_id INTEGER REFERENCES branches(id),
      created_by INTEGER REFERENCES users(id),
      cancelled BOOLEAN DEFAULT FALSE,
      cancelled_by INTEGER REFERENCES users(id),
      cancelled_at TIMESTAMP,
      cancellation_reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
      category VARCHAR(120) NOT NULL,
      amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
      payment_mode VARCHAR(30) NOT NULL DEFAULT 'CASH',
      reference_number VARCHAR(120),
      vendor_name VARCHAR(160),
      remarks TEXT,
      branch_id INTEGER REFERENCES branches(id),
      created_by INTEGER REFERENCES users(id),
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    INSERT INTO business_settings (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO sale_rate_settings (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO mandi_tax_rules (origin_type, tax_percent)
    VALUES ('LOCAL', 2), ('IMPORTED', 4)
    ON CONFLICT (origin_type) DO NOTHING;

    INSERT INTO rebate_rules (rule_name, pay_within_days, rebate_percent)
    SELECT seed.rule_name, seed.pay_within_days, seed.rebate_percent
    FROM (VALUES
      ('Same Day', 0, 3::NUMERIC),
      ('Within 3 Days', 3, 2::NUMERIC),
      ('Within 7 Days', 7, 1::NUMERIC),
      ('Later', 15, 0::NUMERIC)
    ) AS seed(rule_name, pay_within_days, rebate_percent)
    WHERE NOT EXISTS (SELECT 1 FROM rebate_rules);

    ALTER TABLE sales ADD COLUMN IF NOT EXISTS invoice_no VARCHAR(40);
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_name VARCHAR(120);
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_mobile VARCHAR(20);
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_notes TEXT;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_mode VARCHAR(20) DEFAULT 'CASH';
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS gross_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS item_discount_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS invoice_discount_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS discount_rule_id INTEGER;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS discount_rule_name VARCHAR(140);
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS discount_rule_type VARCHAR(30);
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS discount_rule_value NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS discount_rule_payment_mode VARCHAR(20);
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS sale_status VARCHAR(20) DEFAULT 'COMPLETED';
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS edited_by INTEGER REFERENCES users(id);
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS edit_reason TEXT;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS cancelled_by INTEGER REFERENCES users(id);
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
    UPDATE sales SET sale_status = 'COMPLETED' WHERE sale_status IS NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS sales_invoice_no_unique_idx
      ON sales (invoice_no)
      WHERE invoice_no IS NOT NULL;

    CREATE TABLE IF NOT EXISTS sale_audit_trail (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER NOT NULL REFERENCES sales(id),
      action VARCHAR(30) NOT NULL,
      field_name VARCHAR(80),
      old_value JSONB,
      new_value JSONB,
      reason TEXT NOT NULL,
      edited_by INTEGER REFERENCES users(id),
      edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sale_items (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity NUMERIC(14, 3) NOT NULL CHECK (quantity > 0),
      selling_rate NUMERIC(14, 2) NOT NULL CHECK (selling_rate >= 0),
      amount NUMERIC(14, 2) NOT NULL,
      cost_amount NUMERIC(14, 2) NOT NULL,
      profit NUMERIC(14, 2) NOT NULL
    );

    ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS net_amount NUMERIC(14, 2);

    CREATE TABLE IF NOT EXISTS sale_payments (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      payment_mode VARCHAR(20) NOT NULL,
      amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0)
    );

    CREATE TABLE IF NOT EXISTS customer_ledger (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER REFERENCES sales(id),
      customer_name VARCHAR(120),
      customer_mobile VARCHAR(20),
      transaction_type VARCHAR(30) NOT NULL,
      debit_amount NUMERIC(14, 2) DEFAULT 0 CHECK (debit_amount >= 0),
      credit_amount NUMERIC(14, 2) DEFAULT 0 CHECK (credit_amount >= 0),
      balance_delta NUMERIC(14, 2) NOT NULL DEFAULT 0,
      remarks TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sale_permission_settings (
      role_name VARCHAR(80) PRIMARY KEY,
      can_edit_sales BOOLEAN DEFAULT FALSE,
      can_cancel_sales BOOLEAN DEFAULT FALSE,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    INSERT INTO sale_permission_settings (role_name, can_edit_sales, can_cancel_sales)
    VALUES
      ('Owner', TRUE, TRUE),
      ('Admin', TRUE, TRUE),
      ('Cashier', FALSE, FALSE),
      ('Purchase Manager', FALSE, FALSE),
      ('Inventory Manager', FALSE, FALSE)
    ON CONFLICT (role_name) DO NOTHING;

    CREATE TABLE IF NOT EXISTS sale_batch_allocations (
      id SERIAL PRIMARY KEY,
      sale_item_id INTEGER NOT NULL REFERENCES sale_items(id) ON DELETE CASCADE,
      inventory_batch_id INTEGER NOT NULL REFERENCES inventory_batches(id),
      quantity NUMERIC(14, 3) NOT NULL CHECK (quantity > 0),
      purchase_rate NUMERIC(14, 2) NOT NULL,
      cost_amount NUMERIC(14, 2) NOT NULL
    );

    CREATE INDEX IF NOT EXISTS inventory_batches_fifo_idx
      ON inventory_batches (product_id, branch_id, purchase_date, created_at, id)
      WHERE remaining_qty > 0;

    CREATE INDEX IF NOT EXISTS sale_items_sale_id_idx
      ON sale_items (sale_id);

    CREATE INDEX IF NOT EXISTS sale_batch_allocations_sale_item_id_idx
      ON sale_batch_allocations (sale_item_id);

    CREATE INDEX IF NOT EXISTS sale_payments_sale_id_idx
      ON sale_payments (sale_id);

    CREATE INDEX IF NOT EXISTS sale_audit_trail_sale_id_idx
      ON sale_audit_trail (sale_id, edited_at DESC, id DESC);

    CREATE INDEX IF NOT EXISTS customer_ledger_mobile_idx
      ON customer_ledger (customer_mobile, created_at, id);

    CREATE INDEX IF NOT EXISTS suppliers_name_search_idx
      ON suppliers (LOWER(supplier_name), LOWER(COALESCE(firm_name, '')));

    CREATE INDEX IF NOT EXISTS purchases_supplier_id_idx
      ON purchases (supplier_id);

    CREATE INDEX IF NOT EXISTS supplier_payments_supplier_date_idx
      ON supplier_payments (supplier_id, payment_date, id);

    CREATE INDEX IF NOT EXISTS supplier_payment_audit_payment_idx
      ON supplier_payment_audit (supplier_payment_id, edited_at DESC, id DESC);

    CREATE INDEX IF NOT EXISTS customers_search_idx
      ON customers (LOWER(customer_name), LOWER(COALESCE(mobile_number, '')));

    CREATE INDEX IF NOT EXISTS accounts_search_idx
      ON accounts (LOWER(account_name), account_type, active);

    CREATE INDEX IF NOT EXISTS customer_payments_customer_date_idx
      ON customer_payments (customer_id, payment_date, id);

    CREATE INDEX IF NOT EXISTS expenses_date_idx
      ON expenses (expense_date DESC, id DESC);

    CREATE INDEX IF NOT EXISTS sale_discount_rules_match_idx
      ON sale_discount_rules (active, payment_mode, minimum_bill_amount, maximum_bill_amount);

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchases_supplier_id_fkey') THEN
        ALTER TABLE purchases
          ADD CONSTRAINT purchases_supplier_id_fkey
          FOREIGN KEY (supplier_id) REFERENCES suppliers(id);
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_batches_supplier_id_fkey') THEN
        ALTER TABLE inventory_batches
          ADD CONSTRAINT inventory_batches_supplier_id_fkey
          FOREIGN KEY (supplier_id) REFERENCES suppliers(id);
      END IF;
    END $$;

    UPDATE sales
    SET gross_amount = total_amount
    WHERE gross_amount = 0
      AND item_discount_amount = 0
      AND invoice_discount_amount = 0;

    UPDATE sale_items
    SET net_amount = amount
    WHERE net_amount IS NULL;

    UPDATE purchases
    SET
      basic_amount = total_amount,
      gross_amount = total_amount,
      net_payable = total_amount,
      balance_amount = total_amount
    WHERE basic_amount = 0
      AND gross_amount = 0
      AND net_payable = 0;

    WITH legacy_suppliers AS (
      SELECT DISTINCT TRIM(supplier_name) AS supplier_name
      FROM purchases
      WHERE supplier_name IS NOT NULL
        AND TRIM(supplier_name) <> ''
    )
    INSERT INTO suppliers (supplier_name, firm_name, supplier_type, notes)
    SELECT
      supplier_name,
      supplier_name,
      'LOCAL_SUPPLIER',
      'Auto-created from legacy purchase records'
    FROM legacy_suppliers legacy
    WHERE NOT EXISTS (
      SELECT 1
      FROM suppliers existing
      WHERE LOWER(existing.supplier_name) = LOWER(legacy.supplier_name)
    );

    UPDATE purchases p
    SET supplier_id = matched.id
    FROM (
      SELECT MIN(id) AS id, LOWER(supplier_name) AS supplier_key
      FROM suppliers
      GROUP BY LOWER(supplier_name)
    ) matched
    WHERE p.supplier_id IS NULL
      AND p.supplier_name IS NOT NULL
      AND LOWER(TRIM(p.supplier_name)) = matched.supplier_key;

    UPDATE inventory_batches ib
    SET supplier_id = matched.id
    FROM (
      SELECT MIN(id) AS id, LOWER(supplier_name) AS supplier_key
      FROM suppliers
      GROUP BY LOWER(supplier_name)
    ) matched
    WHERE ib.supplier_id IS NULL
      AND ib.supplier_name IS NOT NULL
      AND LOWER(TRIM(ib.supplier_name)) = matched.supplier_key;
  `);
};

const getSupplierSummaryRows = async ({ active, search, supplierId } = {}) => {
  const filters = [];
  const values = [];
  if (supplierId) {
    values.push(supplierId);
    filters.push(`s.id = $${values.length}`);
  }
  if (typeof active === "boolean") {
    values.push(active);
    filters.push(`s.active = $${values.length}`);
  }
  if (search) {
    values.push(`%${search.toLowerCase()}%`);
    filters.push(`(
      LOWER(s.supplier_name) LIKE $${values.length}
      OR LOWER(COALESCE(s.firm_name, '')) LIKE $${values.length}
      OR LOWER(COALESCE(s.mobile_number, '')) LIKE $${values.length}
      OR LOWER(COALESCE(s.city, '')) LIKE $${values.length}
      OR LOWER(COALESCE(s.gst_number, '')) LIKE $${values.length}
    )`);
  }
  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const result = await pool.query(
    `
    WITH purchase_summary AS (
      SELECT
        supplier_id,
        SUM(COALESCE(NULLIF(gross_amount, 0), total_amount, 0)) AS total_purchases,
        SUM(COALESCE(NULLIF(net_payable, 0), total_amount, 0)) AS net_purchase_cost,
        SUM(COALESCE(rebate_amount, 0)) AS purchase_rebate,
        SUM(COALESCE(paid_amount, 0)) AS purchase_paid
      FROM purchases
      WHERE supplier_id IS NOT NULL
      GROUP BY supplier_id
    ),
    payment_summary AS (
      SELECT
        supplier_id,
        SUM(payment_amount) AS total_paid,
        SUM(rebate_amount) AS payment_rebate
      FROM supplier_payments
      WHERE cancelled = FALSE
      GROUP BY supplier_id
    )
    SELECT
      s.*,
      COALESCE(ps.total_purchases, 0) AS total_purchases,
      COALESCE(ps.net_purchase_cost, 0) AS net_purchase_cost,
      COALESCE(ps.purchase_rebate, 0) AS purchase_rebate_received,
      COALESCE(ps.purchase_paid, 0) + COALESCE(pay.total_paid, 0) AS total_paid,
      COALESCE(pay.payment_rebate, 0) AS payment_rebate_received,
      COALESCE(ps.purchase_rebate, 0) + COALESCE(pay.payment_rebate, 0) AS total_rebate_received,
      ROUND((
        COALESCE(s.opening_balance, 0)
        + COALESCE(ps.total_purchases, 0)
        - COALESCE(ps.purchase_rebate, 0)
        - COALESCE(ps.purchase_paid, 0)
        - COALESCE(pay.total_paid, 0)
        - COALESCE(pay.payment_rebate, 0)
      )::NUMERIC, 2) AS outstanding_balance
    FROM suppliers s
    LEFT JOIN purchase_summary ps ON ps.supplier_id = s.id
    LEFT JOIN payment_summary pay ON pay.supplier_id = s.id
    ${whereClause}
    ORDER BY s.active DESC, s.supplier_name
    `,
    values
  );
  return result.rows;
};

const buildSupplierSummaryPayload = (rows) => {
  const totals = rows.reduce((summary, supplier) => ({
    totalPurchases: summary.totalPurchases + Number(supplier.total_purchases || 0),
    totalPaid: summary.totalPaid + Number(supplier.total_paid || 0),
    totalRebateReceived: summary.totalRebateReceived + Number(supplier.total_rebate_received || 0),
    outstandingBalance: summary.outstandingBalance + Number(supplier.outstanding_balance || 0),
  }), {
    totalPurchases: 0,
    totalPaid: 0,
    totalRebateReceived: 0,
    outstandingBalance: 0,
  });

  return {
    totalPurchases: roundCurrency(totals.totalPurchases),
    totalPaid: roundCurrency(totals.totalPaid),
    totalRebateReceived: roundCurrency(totals.totalRebateReceived),
    outstandingBalance: roundCurrency(totals.outstandingBalance),
    suppliers: rows,
  };
};

const readSupplierPayload = (body) => {
  const supplierType = normalizeSupplierType(body.supplier_type);
  return {
    supplier_name: cleanText(body.supplier_name),
    firm_name: nullableText(body.firm_name),
    mobile_number: nullableText(body.mobile_number),
    alternate_number: nullableText(body.alternate_number),
    address: nullableText(body.address),
    city: nullableText(body.city),
    gst_number: nullableText(body.gst_number),
    bank_name: nullableText(body.bank_name),
    account_number: nullableText(body.account_number),
    ifsc_code: nullableText(body.ifsc_code),
    upi_id: nullableText(body.upi_id),
    notes: nullableText(body.notes),
    opening_balance: parseNonNegativeNumber(body.opening_balance),
    supplier_type: supplierType,
    active: body.active === undefined ? true : body.active === true || body.active === "true",
  };
};

const normalizeCustomerType = (value) => String(value || "RETAIL").trim().toUpperCase();
const normalizeAccountType = (value) => String(value || "OTHER").trim().toUpperCase();

const supplierTypeFromAccountType = (accountType) => ({
  SUPPLIER: "LOCAL_SUPPLIER",
  TRANSPORT_VENDOR: "TRANSPORT_VENDOR",
  COMMISSION_AGENT: "COMMISSION_AGENT",
}[accountType] || "LOCAL_SUPPLIER");

const accountTypeFromSupplierType = (supplierType) => ({
  TRANSPORT_VENDOR: "TRANSPORT_VENDOR",
  COMMISSION_AGENT: "COMMISSION_AGENT",
}[supplierType] || "SUPPLIER");

const readCustomerPayload = (body) => {
  const customerType = normalizeCustomerType(body.customer_type);
  return {
    customer_name: cleanText(body.customer_name),
    customer_type: customerType,
    firm_name: nullableText(body.firm_name),
    mobile_number: nullableText(body.mobile_number),
    alternate_number: nullableText(body.alternate_number),
    address: nullableText(body.address),
    city: nullableText(body.city),
    gst_number: nullableText(body.gst_number),
    bank_name: nullableText(body.bank_name),
    account_number: nullableText(body.account_number),
    ifsc_code: nullableText(body.ifsc_code),
    upi_id: nullableText(body.upi_id),
    notes: nullableText(body.notes),
    opening_balance: parseNonNegativeNumber(body.opening_balance),
    active: body.active === undefined ? true : body.active === true || body.active === "true",
  };
};

const readAccountPayload = (body) => {
  const accountType = normalizeAccountType(body.account_type);
  return {
    account_name: cleanText(body.account_name),
    account_type: accountType,
    firm_name: nullableText(body.firm_name),
    mobile_number: nullableText(body.mobile_number),
    alternate_number: nullableText(body.alternate_number),
    address: nullableText(body.address),
    city: nullableText(body.city),
    gst_number: nullableText(body.gst_number),
    bank_name: nullableText(body.bank_name),
    account_number: nullableText(body.account_number),
    ifsc_code: nullableText(body.ifsc_code),
    upi_id: nullableText(body.upi_id),
    opening_balance: parseNonNegativeNumber(body.opening_balance),
    active: body.active === undefined ? true : body.active === true || body.active === "true",
    notes: nullableText(body.notes),
  };
};

const getCustomerSummaryRows = async ({ active, search, customerId } = {}) => {
  const filters = [];
  const values = [];
  if (customerId) {
    values.push(customerId);
    filters.push(`c.id = $${values.length}`);
  }
  if (typeof active === "boolean") {
    values.push(active);
    filters.push(`c.active = $${values.length}`);
  }
  if (search) {
    values.push(`%${search.toLowerCase()}%`);
    filters.push(`(
      LOWER(c.customer_name) LIKE $${values.length}
      OR LOWER(COALESCE(c.mobile_number, '')) LIKE $${values.length}
      OR LOWER(COALESCE(c.gst_number, '')) LIKE $${values.length}
    )`);
  }
  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const result = await pool.query(
    `
    WITH sale_summary AS (
      SELECT
        matched.customer_id,
        SUM(CASE WHEN s.sale_status <> 'CANCELLED' THEN s.total_amount ELSE 0 END) AS total_sales,
        SUM(CASE WHEN s.sale_status <> 'CANCELLED' THEN COALESCE(pay.total_paid, 0) ELSE 0 END) AS sale_paid,
        SUM(CASE WHEN s.sale_status = 'CANCELLED' THEN s.total_amount ELSE 0 END) AS total_cancelled
      FROM sales s
      JOIN LATERAL (
        SELECT c.id AS customer_id
        FROM customers c
        WHERE
          (s.customer_mobile IS NOT NULL AND c.mobile_number = s.customer_mobile)
          OR (
            s.customer_mobile IS NULL
            AND s.customer_name IS NOT NULL
            AND LOWER(c.customer_name) = LOWER(s.customer_name)
          )
        ORDER BY CASE WHEN c.mobile_number = s.customer_mobile THEN 0 ELSE 1 END, c.id
        LIMIT 1
      ) matched ON TRUE
      LEFT JOIN (
        SELECT sale_id, SUM(amount) AS total_paid
        FROM sale_payments
        GROUP BY sale_id
      ) pay ON pay.sale_id = s.id
      GROUP BY matched.customer_id
    ),
    customer_payment_summary AS (
      SELECT customer_id, SUM(payment_amount) AS total_customer_paid
      FROM customer_payments
      WHERE cancelled = FALSE
      GROUP BY customer_id
    )
    SELECT
      c.*,
      COALESCE(ss.total_sales, 0) AS total_sales,
      COALESCE(ss.sale_paid, 0) + COALESCE(cps.total_customer_paid, 0) AS total_paid,
      COALESCE(ss.total_cancelled, 0) AS total_cancelled,
      ROUND((
        COALESCE(c.opening_balance, 0)
        + COALESCE(ss.total_sales, 0)
        - COALESCE(ss.sale_paid, 0)
        - COALESCE(cps.total_customer_paid, 0)
      )::NUMERIC, 2) AS outstanding_balance
    FROM customers c
    LEFT JOIN sale_summary ss ON ss.customer_id = c.id
    LEFT JOIN customer_payment_summary cps ON cps.customer_id = c.id
    ${whereClause}
    ORDER BY c.active DESC, c.customer_name
    `,
    values
  );
  return result.rows;
};

const buildCustomerSummaryPayload = (rows) => {
  const totals = rows.reduce((summary, customer) => ({
    totalSales: summary.totalSales + Number(customer.total_sales || 0),
    totalPaid: summary.totalPaid + Number(customer.total_paid || 0),
    outstandingBalance: summary.outstandingBalance + Number(customer.outstanding_balance || 0),
  }), { totalSales: 0, totalPaid: 0, outstandingBalance: 0 });
  return {
    totalSales: roundCurrency(totals.totalSales),
    totalPaid: roundCurrency(totals.totalPaid),
    outstandingBalance: roundCurrency(totals.outstandingBalance),
    customers: rows,
  };
};

const isDateInput = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));

const parseDashboardRange = (query = {}) => {
  if (isDateInput(query.date_from) && isDateInput(query.date_to) && query.date_from <= query.date_to) {
    return { dateFrom: query.date_from, dateTo: query.date_to, days: null };
  }
  const requestedDays = parsePositiveInteger(query.days);
  const days = [7, 15, 30].includes(requestedDays) ? requestedDays : 7;
  const endDate = new Date();
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - days + 1);
  return {
    dateFrom: toDateKey(startDate),
    dateTo: toDateKey(endDate),
    days,
  };
};

const getDashboardSummary = async () => {
  const [metricsResult, supplierRows, customerRows] = await Promise.all([
    pool.query(
      `
      SELECT
        COALESCE((SELECT SUM(total_amount) FROM sales WHERE sale_date = CURRENT_DATE AND sale_status <> 'CANCELLED'), 0) AS "todaySales",
        COALESCE((SELECT SUM(profit) FROM sales WHERE sale_date = CURRENT_DATE AND sale_status <> 'CANCELLED'), 0) AS "todayProfit",
        COALESCE((
          SELECT SUM(remaining_qty * COALESCE(effective_cost_per_unit, purchase_rate))
          FROM inventory_batches
        ), 0) AS "stockValue",
        COALESCE((
          SELECT COUNT(*)
          FROM (
            SELECT
              p.id,
              COALESCE(SUM(ib.remaining_qty), 0) AS current_stock,
              COALESCE(p.minimum_stock, 5) AS minimum_stock
            FROM products p
            LEFT JOIN inventory_batches ib ON ib.product_id = p.id
            WHERE p.active IS DISTINCT FROM FALSE
            GROUP BY p.id, p.minimum_stock
          ) stock
          WHERE stock.current_stock <= stock.minimum_stock
        ), 0) AS "lowStockItems",
        COALESCE((SELECT COUNT(*) FROM sales WHERE sale_date = CURRENT_DATE AND sale_status <> 'CANCELLED'), 0) AS "transactions",
        COALESCE((SELECT SUM(amount) FROM expenses WHERE expense_date = CURRENT_DATE AND active IS DISTINCT FROM FALSE), 0) AS "todayExpenses",
        COALESCE((SELECT SUM(rebate_amount) FROM purchases), 0)
          + COALESCE((SELECT SUM(rebate_amount) FROM supplier_payments WHERE cancelled = FALSE), 0) AS "totalRebateReceived",
        COALESCE((SELECT SUM(payment_amount) FROM supplier_payments WHERE payment_date = CURRENT_DATE AND cancelled = FALSE), 0)
          + COALESCE((SELECT SUM(paid_amount) FROM purchases WHERE COALESCE(payment_date, purchase_date) = CURRENT_DATE), 0) AS "todaySupplierPayments",
        COALESCE((SELECT COUNT(*) FROM suppliers), 0) AS supplier_count,
        COALESCE((SELECT COUNT(*) FROM suppliers WHERE active = TRUE), 0) AS active_supplier_count
      `
    ),
    getSupplierSummaryRows(),
    getCustomerSummaryRows(),
  ]);
  const metrics = metricsResult.rows[0] || {};
  const supplierSummary = buildSupplierSummaryPayload(supplierRows);
  const customerSummary = buildCustomerSummaryPayload(customerRows);
  return {
    todaySales: Number(metrics.todaySales || 0),
    todayProfit: Number(metrics.todayProfit || 0),
    stockValue: Number(metrics.stockValue || 0),
    lowStockItems: Number(metrics.lowStockItems || 0),
    transactions: Number(metrics.transactions || 0),
    supplierOutstanding: Number(supplierSummary.outstandingBalance || 0),
    customerOutstanding: Number(customerSummary.outstandingBalance || 0),
    todayExpenses: Number(metrics.todayExpenses || 0),
    totalRebateReceived: Number(metrics.totalRebateReceived || 0),
    todaySupplierPayments: Number(metrics.todaySupplierPayments || 0),
    total_supplier_outstanding: Number(supplierSummary.outstandingBalance || 0),
    total_rebate_received: Number(metrics.totalRebateReceived || 0),
    todays_supplier_payments: Number(metrics.todaySupplierPayments || 0),
    supplier_count: Number(metrics.supplier_count || 0),
    active_supplier_count: Number(metrics.active_supplier_count || 0),
  };
};

const getDashboardSalesTrend = async (dateFrom, dateTo) => {
  const result = await pool.query(
    `
    WITH days AS (
      SELECT generate_series($1::date, $2::date, INTERVAL '1 day')::date AS day
    ),
    sales_by_day AS (
      SELECT sale_date::date AS day, SUM(total_amount) AS sales
      FROM sales
      WHERE sale_status <> 'CANCELLED'
        AND sale_date BETWEEN $1 AND $2
      GROUP BY sale_date
    )
    SELECT TO_CHAR(days.day, 'YYYY-MM-DD') AS date, COALESCE(sales_by_day.sales, 0) AS sales
    FROM days
    LEFT JOIN sales_by_day ON sales_by_day.day = days.day
    ORDER BY days.day
    `,
    [dateFrom, dateTo]
  );
  return result.rows.map((row) => ({ date: row.date, sales: Number(row.sales || 0) }));
};

const getDashboardProfitTrend = async (dateFrom, dateTo) => {
  const result = await pool.query(
    `
    WITH days AS (
      SELECT generate_series($1::date, $2::date, INTERVAL '1 day')::date AS day
    ),
    profit_by_day AS (
      SELECT sale_date::date AS day, SUM(profit) AS gross_profit
      FROM sales
      WHERE sale_status <> 'CANCELLED'
        AND sale_date BETWEEN $1 AND $2
      GROUP BY sale_date
    )
    SELECT TO_CHAR(days.day, 'YYYY-MM-DD') AS date, COALESCE(profit_by_day.gross_profit, 0) AS "grossProfit"
    FROM days
    LEFT JOIN profit_by_day ON profit_by_day.day = days.day
    ORDER BY days.day
    `,
    [dateFrom, dateTo]
  );
  return result.rows.map((row) => ({ date: row.date, grossProfit: Number(row.grossProfit || 0) }));
};

const getDashboardExpenseTrend = async (dateFrom, dateTo) => {
  const result = await pool.query(
    `
    WITH days AS (
      SELECT generate_series($1::date, $2::date, INTERVAL '1 day')::date AS day
    ),
    expense_by_day AS (
      SELECT expense_date::date AS day, SUM(amount) AS expenses
      FROM expenses
      WHERE active IS DISTINCT FROM FALSE
        AND expense_date BETWEEN $1 AND $2
      GROUP BY expense_date
    )
    SELECT TO_CHAR(days.day, 'YYYY-MM-DD') AS date, COALESCE(expense_by_day.expenses, 0) AS expenses
    FROM days
    LEFT JOIN expense_by_day ON expense_by_day.day = days.day
    ORDER BY days.day
    `,
    [dateFrom, dateTo]
  );
  return result.rows.map((row) => ({ date: row.date, expenses: Number(row.expenses || 0) }));
};

const getDashboardPurchaseSalesComparison = async (dateFrom, dateTo) => {
  const result = await pool.query(
    `
    WITH days AS (
      SELECT generate_series($1::date, $2::date, INTERVAL '1 day')::date AS day
    ),
    sales_by_day AS (
      SELECT sale_date::date AS day, SUM(total_amount) AS sales
      FROM sales
      WHERE sale_status <> 'CANCELLED'
        AND sale_date BETWEEN $1 AND $2
      GROUP BY sale_date
    ),
    purchases_by_day AS (
      SELECT purchase_date::date AS day, SUM(COALESCE(NULLIF(net_payable, 0), total_amount, 0)) AS purchases
      FROM purchases
      WHERE purchase_date BETWEEN $1 AND $2
      GROUP BY purchase_date
    )
    SELECT
      TO_CHAR(days.day, 'YYYY-MM-DD') AS date,
      COALESCE(purchases_by_day.purchases, 0) AS purchases,
      COALESCE(sales_by_day.sales, 0) AS sales
    FROM days
    LEFT JOIN purchases_by_day ON purchases_by_day.day = days.day
    LEFT JOIN sales_by_day ON sales_by_day.day = days.day
    ORDER BY days.day
    `,
    [dateFrom, dateTo]
  );
  return result.rows.map((row) => ({
    date: row.date,
    purchases: Number(row.purchases || 0),
    sales: Number(row.sales || 0),
  }));
};

const getDashboardTopSellingProducts = async (dateFrom, dateTo) => {
  const result = await pool.query(
    `
    SELECT
      p.id AS product_id,
      p.product_name,
      p.unit,
      SUM(si.quantity) AS quantity_sold,
      SUM(COALESCE(si.net_amount, si.amount, 0)) AS revenue
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    JOIN products p ON p.id = si.product_id
    WHERE s.sale_status <> 'CANCELLED'
      AND s.sale_date BETWEEN $1 AND $2
    GROUP BY p.id, p.product_name, p.unit
    ORDER BY quantity_sold DESC, revenue DESC, p.product_name
    LIMIT 8
    `,
    [dateFrom, dateTo]
  );
  return result.rows.map((row) => ({
    product_id: row.product_id,
    product_name: row.product_name,
    unit: row.unit,
    quantity_sold: Number(row.quantity_sold || 0),
    revenue: Number(row.revenue || 0),
  }));
};

const getDashboardLowStockItems = async () => {
  const result = await pool.query(
    `
    SELECT *
    FROM (
      SELECT
        p.id AS product_id,
        p.product_name,
        p.unit,
        COALESCE(p.minimum_stock, 5) AS minimum_stock,
        COALESCE(SUM(ib.remaining_qty), 0) AS current_stock
      FROM products p
      LEFT JOIN inventory_batches ib ON ib.product_id = p.id
      WHERE p.active IS DISTINCT FROM FALSE
      GROUP BY p.id, p.product_name, p.unit, p.minimum_stock
    ) stock
    WHERE stock.current_stock <= stock.minimum_stock
    ORDER BY (stock.current_stock - stock.minimum_stock), stock.product_name
    LIMIT 10
    `
  );
  return result.rows.map((row) => ({
    product_id: row.product_id,
    product_name: row.product_name,
    unit: row.unit,
    minimum_stock: Number(row.minimum_stock || 0),
    current_stock: Number(row.current_stock || 0),
  }));
};

const buildDashboardInsights = ({ summary, salesTrend, expenseTrend, topSellingProducts }) => {
  const insights = [];
  const lastSales = salesTrend.at(-1)?.sales || 0;
  const previousSales = salesTrend.at(-2)?.sales || 0;
  const salesDiff = roundCurrency(lastSales - previousSales);
  if (previousSales > 0) {
    const percentage = Math.round((salesDiff / previousSales) * 100);
    insights.push(`Sales ${salesDiff >= 0 ? "increased" : "decreased"} ${Math.abs(percentage)}% vs previous day.`);
  } else if (lastSales > 0) {
    insights.push(`Sales started at ${roundCurrency(lastSales).toLocaleString("en-IN")} INR for the latest day.`);
  } else {
    insights.push("No sales recorded for the selected period.");
  }

  const lastExpenses = expenseTrend.at(-1)?.expenses || 0;
  const previousExpenses = expenseTrend.at(-2)?.expenses || 0;
  const expenseDiff = roundCurrency(lastExpenses - previousExpenses);
  if (expenseDiff !== 0) {
    insights.push(`Expenses ${expenseDiff >= 0 ? "increased" : "reduced"} by ${roundCurrency(Math.abs(expenseDiff)).toLocaleString("en-IN")} INR vs previous day.`);
  } else {
    insights.push("Expenses are unchanged vs previous day.");
  }

  if (topSellingProducts.length) {
    insights.push(`Top selling product: ${topSellingProducts[0].product_name}.`);
  } else {
    insights.push("No top product yet because no items were sold in this period.");
  }

  insights.push(`Supplier outstanding is ${roundCurrency(summary.supplierOutstanding || 0).toLocaleString("en-IN")} INR.`);
  return insights;
};

const getDashboardAnalyticsPayload = async (query = {}) => {
  const range = parseDashboardRange(query);
  const [
    summary,
    salesTrend,
    profitTrend,
    expenseTrend,
    purchaseSalesComparison,
    topSellingProducts,
    lowStockItems,
  ] = await Promise.all([
    getDashboardSummary(),
    getDashboardSalesTrend(range.dateFrom, range.dateTo),
    getDashboardProfitTrend(range.dateFrom, range.dateTo),
    getDashboardExpenseTrend(range.dateFrom, range.dateTo),
    getDashboardPurchaseSalesComparison(range.dateFrom, range.dateTo),
    getDashboardTopSellingProducts(range.dateFrom, range.dateTo),
    getDashboardLowStockItems(),
  ]);
  const expensesByDate = new Map(expenseTrend.map((row) => [row.date, row.expenses]));
  const netProfitTrend = profitTrend.map((row) => {
    const expenses = Number(expensesByDate.get(row.date) || 0);
    return {
      date: row.date,
      grossProfit: row.grossProfit,
      expenses,
      netProfit: roundCurrency(Number(row.grossProfit || 0) - expenses),
    };
  });
  return {
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
    days: range.days,
    summary,
    salesTrend,
    profitTrend,
    expenseTrend,
    netProfitTrend,
    purchaseSalesComparison,
    topSellingProducts,
    lowStockItems,
    insights: buildDashboardInsights({ summary, salesTrend, expenseTrend, topSellingProducts }),
  };
};

const getSettingsBundle = async (userId) => {
  const [businessResult, saleRateResult, mandiResult, rebateResult, discountResult, manager] = await Promise.all([
    pool.query("SELECT * FROM business_settings WHERE id = 1"),
    pool.query("SELECT * FROM sale_rate_settings WHERE id = 1"),
    pool.query("SELECT * FROM mandi_tax_rules ORDER BY origin_type"),
    pool.query("SELECT * FROM rebate_rules ORDER BY pay_within_days, id"),
    pool.query("SELECT * FROM sale_discount_rules ORDER BY minimum_bill_amount, maximum_bill_amount NULLS LAST, id"),
    userId ? requireRateManager(userId) : Promise.resolve(null),
  ]);
  return {
    businessSettings: businessResult.rows[0] || {},
    saleRateSettings: saleRateResult.rows[0] || {},
    mandiTaxRules: mandiResult.rows,
    rebateRules: rebateResult.rows,
    discountRules: discountResult.rows,
    roles: [
      { role: "Owner", permissions: ["Business settings", "Selling rates", "Discount rules", "Mandi tax rules", "Rebate rules"] },
      { role: "Admin", permissions: ["Business settings", "Selling rates", "Discount rules", "Mandi tax rules", "Rebate rules"] },
      { role: "Cashier", permissions: ["POS billing", "Sales history view"] },
      { role: "Purchase Manager", permissions: ["Purchase Entry", "Supplier accounts"] },
      { role: "Inventory Manager", permissions: ["Inventory batches", "Stock review"] },
    ],
    backupSettings: {
      exportReady: true,
      importReady: false,
      lastBackupAt: null,
      note: "Backup export/import structure is reserved for a future production backup workflow.",
    },
    canManageSettings: Boolean(manager),
  };
};

const readDiscountRulePayload = (body) => {
  const minimumBillAmount = parseNonNegativeNumber(body.minimum_bill_amount);
  const maximumBillAmount = body.maximum_bill_amount === "" || body.maximum_bill_amount === null || body.maximum_bill_amount === undefined
    ? null
    : parseNonNegativeNumber(body.maximum_bill_amount);
  const discountType = normalizeDiscountType(body.discount_type);
  const paymentMode = normalizeDiscountPaymentMode(body.payment_mode);
  return {
    rule_name: cleanText(body.rule_name),
    minimum_bill_amount: minimumBillAmount,
    maximum_bill_amount: maximumBillAmount,
    discount_type: discountType,
    discount_value: parseNonNegativeNumber(body.discount_value),
    payment_mode: paymentMode,
    active: body.active !== false,
  };
};

const hasInvalidDiscountMaximum = (body, rule) =>
  rule.maximum_bill_amount === null &&
  body.maximum_bill_amount !== "" &&
  body.maximum_bill_amount !== null &&
  body.maximum_bill_amount !== undefined;

const calculateInvoiceDiscount = (rule, subtotal) => {
  if (!rule) return 0;
  const value = Number(rule.discount_value || 0);
  const amount = rule.discount_type === "PERCENTAGE"
    ? roundCurrency(subtotal * value / 100)
    : roundCurrency(value);
  return Math.min(amount, subtotal);
};

const getMatchingDiscountRule = async (client, subtotal, paymentMode) => {
  const result = await client.query(
    `
    SELECT *
    FROM sale_discount_rules
    WHERE active = TRUE
      AND minimum_bill_amount <= $1
      AND (maximum_bill_amount IS NULL OR maximum_bill_amount >= $1)
      AND (payment_mode = 'ALL' OR payment_mode = $2)
    ORDER BY
      CASE WHEN payment_mode = $2 THEN 0 ELSE 1 END,
      minimum_bill_amount DESC,
      discount_value DESC,
      id DESC
    LIMIT 1
    `,
    [subtotal, paymentMode]
  );
  return result.rows[0] || null;
};

const getSalePermissionUser = async (userId, action, client = pool) => {
  const parsedUserId = parsePositiveInteger(userId);
  if (!parsedUserId || !["edit", "cancel"].includes(action)) return null;
  const result = await client.query(
    `
    SELECT
      u.id,
      u.full_name,
      r.role_name,
      COALESCE(sp.can_edit_sales, r.role_name = 'Owner') AS can_edit_sales,
      COALESCE(sp.can_cancel_sales, r.role_name = 'Owner') AS can_cancel_sales
    FROM users u
    JOIN roles r ON r.id = u.role_id
    LEFT JOIN sale_permission_settings sp ON sp.role_name = r.role_name
    WHERE u.id = $1 AND u.active = TRUE
    `,
    [parsedUserId]
  );
  const user = result.rows[0];
  if (!user) return null;
  if (user.role_name === "Owner") return user;
  if (action === "edit" && user.can_edit_sales) return user;
  if (action === "cancel" && user.can_cancel_sales) return user;
  return null;
};

const getSaleSnapshot = async (client, saleId) => {
  const saleResult = await client.query("SELECT * FROM sales WHERE id = $1", [saleId]);
  const itemsResult = await client.query("SELECT * FROM sale_items WHERE sale_id = $1 ORDER BY id", [saleId]);
  const paymentsResult = await client.query("SELECT * FROM sale_payments WHERE sale_id = $1 ORDER BY id", [saleId]);
  const allocationsResult = await client.query(
    `
    SELECT sba.*, si.product_id
    FROM sale_batch_allocations sba
    JOIN sale_items si ON si.id = sba.sale_item_id
    WHERE si.sale_id = $1
    ORDER BY sba.id
    `,
    [saleId]
  );
  return {
    sale: saleResult.rows[0] || null,
    items: itemsResult.rows,
    payments: paymentsResult.rows,
    allocations: allocationsResult.rows,
  };
};

const restoreSaleInventory = async (client, saleId, userId, reason, transactionType = "IN") => {
  const allocationsResult = await client.query(
    `
    SELECT sba.inventory_batch_id, sba.quantity, si.product_id, s.invoice_no, s.branch_id
    FROM sale_batch_allocations sba
    JOIN sale_items si ON si.id = sba.sale_item_id
    JOIN sales s ON s.id = si.sale_id
    WHERE si.sale_id = $1
    ORDER BY sba.id
    FOR UPDATE
    `,
    [saleId]
  );
  for (const allocation of allocationsResult.rows) {
    await client.query(
      "UPDATE inventory_batches SET remaining_qty = remaining_qty + $1 WHERE id = $2",
      [allocation.quantity, allocation.inventory_batch_id]
    );
    await client.query(
      `
      INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        allocation.product_id,
        allocation.quantity,
        transactionType,
        `${reason} ${allocation.invoice_no || `#${saleId}`}`,
        userId,
        allocation.branch_id,
      ]
    );
  }
};

const insertCustomerLedgerEntry = async (client, sale, transactionType, amount, userId, remarks) => {
  const ledgerAmount = roundCurrency(Math.abs(Number(amount || 0)));
  if (!ledgerAmount && !sale.customer_mobile && !sale.customer_name) return;
  const isCredit = ["SALE_EDIT_CREDIT", "SALE_CANCELLED"].includes(transactionType);
  await client.query(
    `
    INSERT INTO customer_ledger (
      sale_id, customer_name, customer_mobile, transaction_type,
      debit_amount, credit_amount, balance_delta, remarks, created_by
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `,
    [
      sale.id,
      sale.customer_name || null,
      sale.customer_mobile || null,
      transactionType,
      isCredit ? 0 : ledgerAmount,
      isCredit ? ledgerAmount : 0,
      isCredit ? -ledgerAmount : ledgerAmount,
      remarks,
      userId,
    ]
  );
};

const buildSalePayload = async (client, { items, branchId, createdBy, customer, invoiceDiscount, payments, allowRateOverride }) => {
  const parsedItems = (Array.isArray(items) ? items : []).map((item) => ({
    productId: parsePositiveInteger(item.product_id),
    quantity: parsePositiveNumber(item.quantity),
    discountAmount: parseNonNegativeNumber(item.discount_amount),
    requestedRate: parsePositiveNumber(item.selling_rate),
  }));
  const customerName = customer?.name?.trim() || null;
  const customerMobile = customer?.mobile?.trim() || null;
  const customerNotes = customer?.notes?.trim() || null;

  if (
    !branchId ||
    parsedItems.length === 0 ||
    parsedItems.some((item) => !item.productId || !item.quantity || item.discountAmount === null)
  ) {
    return { error: { status: 400, message: "Add valid products and quantities before checkout" } };
  }
  if (new Set(parsedItems.map((item) => item.productId)).size !== parsedItems.length) {
    return { error: { status: 400, message: "Combine duplicate products into one cart item" } };
  }
  if (customerMobile && !/^\d{10,15}$/.test(customerMobile)) {
    return { error: { status: 400, message: "Enter a valid customer mobile number" } };
  }

  const productIds = parsedItems.map((item) => item.productId);
  const productResult = await client.query(
    "SELECT id, product_name, selling_rate, unit FROM products WHERE id = ANY($1::int[]) AND active = TRUE ORDER BY id FOR SHARE",
    [productIds]
  );
  if (productResult.rows.length !== parsedItems.length) {
    return { error: { status: 404, message: "One or more products could not be found" } };
  }

  const productsById = new Map(productResult.rows.map((product) => [product.id, product]));
  const invoiceItems = [];
  let grossAmount = 0;
  let itemDiscountAmount = 0;
  let totalCost = 0;
  for (const requestedItem of parsedItems) {
    const product = productsById.get(requestedItem.productId);
    const sellingRate = allowRateOverride && requestedItem.requestedRate
      ? requestedItem.requestedRate
      : Number(product.selling_rate);
    if (!Number.isFinite(sellingRate) || sellingRate <= 0) {
      return { error: { status: 400, message: `${product.product_name} does not have a valid selling rate` } };
    }
    if (!allowRateOverride && requestedItem.requestedRate && Number(requestedItem.requestedRate) !== Number(product.selling_rate)) {
      return { error: { status: 403, message: "Only Owner can change selling rate on an edited invoice" } };
    }

    const itemGross = roundCurrency(requestedItem.quantity * sellingRate);
    if (requestedItem.discountAmount > itemGross) {
      return { error: { status: 400, message: `Discount cannot exceed the value of ${product.product_name}` } };
    }

    const batchesResult = await client.query(
      `
      SELECT id, remaining_qty, COALESCE(effective_cost_per_unit, purchase_rate) AS purchase_rate
      FROM inventory_batches
      WHERE product_id = $1
        AND branch_id = $2
        AND remaining_qty > 0
      ORDER BY purchase_date, created_at, id
      FOR UPDATE
      `,
      [requestedItem.productId, branchId]
    );
    const availableStock = batchesResult.rows.reduce((total, batch) => total + Number(batch.remaining_qty), 0);
    if (availableStock < requestedItem.quantity) {
      return {
        error: {
          status: 409,
          message: `Insufficient stock for ${product.product_name}. Available quantity: ${availableStock}`,
          product_id: requestedItem.productId,
          available_stock: availableStock,
        },
      };
    }

    let quantityToDeduct = requestedItem.quantity;
    let itemCost = 0;
    const allocations = [];
    for (const batch of batchesResult.rows) {
      if (quantityToDeduct <= 0) break;
      const deductedQuantity = Math.min(quantityToDeduct, Number(batch.remaining_qty));
      const costAmount = roundCurrency(deductedQuantity * Number(batch.purchase_rate));
      await client.query("UPDATE inventory_batches SET remaining_qty = remaining_qty - $1 WHERE id = $2", [deductedQuantity, batch.id]);
      allocations.push({
        inventoryBatchId: batch.id,
        quantity: deductedQuantity,
        purchaseRate: Number(batch.purchase_rate),
        costAmount,
      });
      quantityToDeduct -= deductedQuantity;
      itemCost += costAmount;
    }

    invoiceItems.push({
      ...requestedItem,
      product,
      sellingRate,
      grossAmount: itemGross,
      netAmount: roundCurrency(itemGross - requestedItem.discountAmount),
      costAmount: roundCurrency(itemCost),
      allocations,
    });
    grossAmount += itemGross;
    itemDiscountAmount += requestedItem.discountAmount;
    totalCost += itemCost;
  }

  grossAmount = roundCurrency(grossAmount);
  itemDiscountAmount = roundCurrency(itemDiscountAmount);
  totalCost = roundCurrency(totalCost);
  const subtotalAfterItemDiscounts = roundCurrency(grossAmount - itemDiscountAmount);
  const requestedPaymentsInput = Array.isArray(payments) && payments.length > 0 ? payments : null;
  const allowedPaymentModes = new Set(["CASH", "UPI", "CARD"]);
  const paymentModes = requestedPaymentsInput
    ? requestedPaymentsInput.map((payment) => String(payment.mode || "").toUpperCase())
    : ["CASH"];
  if (paymentModes.some((mode) => !allowedPaymentModes.has(mode))) {
    return { error: { status: 400, message: "Select a valid payment mode" } };
  }
  const paymentMode = paymentModes.length > 1 ? "MIXED" : paymentModes[0];
  const discountRule = await getMatchingDiscountRule(client, subtotalAfterItemDiscounts, paymentMode);
  const parsedInvoiceDiscount = parseNonNegativeNumber(invoiceDiscount);
  if (parsedInvoiceDiscount === null) return { error: { status: 400, message: "Enter a valid invoice discount" } };
  const invoiceDiscountAmount = discountRule
    ? calculateInvoiceDiscount(discountRule, subtotalAfterItemDiscounts)
    : parsedInvoiceDiscount;
  if (invoiceDiscountAmount > subtotalAfterItemDiscounts) {
    return { error: { status: 400, message: "Invoice discount cannot exceed the cart subtotal" } };
  }

  const taxAmount = 0;
  const totalAmount = roundCurrency(subtotalAfterItemDiscounts - invoiceDiscountAmount + taxAmount);
  const profit = roundCurrency(totalAmount - totalCost);
  const requestedPayments = requestedPaymentsInput || [{ mode: "CASH", amount: totalAmount }];
  const parsedPayments = requestedPayments.map((payment) => ({
    mode: String(payment.mode || "").toUpperCase(),
    amount: parsePositiveNumber(payment.amount),
  }));
  const paidAmount = roundCurrency(parsedPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0));
  if (
    parsedPayments.some((payment) => !allowedPaymentModes.has(payment.mode) || !payment.amount) ||
    Math.abs(paidAmount - totalAmount) > 0.01
  ) {
    return { error: { status: 400, message: "Payment amounts must match the invoice total" } };
  }

  return {
    invoiceItems,
    payments: parsedPayments,
    customerName,
    customerMobile,
    customerNotes,
    paymentMode,
    grossAmount,
    itemDiscountAmount,
    invoiceDiscountAmount,
    taxAmount,
    totalAmount,
    totalCost,
    profit,
    discountRule,
    createdBy,
    branchId,
  };
};

app.get("/purchase-rules", async (req, res) => {
  try {
    const [mandiResult, rebateResult] = await Promise.all([
      pool.query("SELECT * FROM mandi_tax_rules WHERE active = TRUE ORDER BY origin_type"),
      pool.query("SELECT * FROM rebate_rules WHERE active = TRUE ORDER BY pay_within_days, id"),
    ]);
    return res.json({ mandiTaxRules: mandiResult.rows, rebateRules: rebateResult.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Purchase Rules" });
  }
});

app.get("/settings/purchase-rules", async (req, res) => {
  try {
    const [mandiResult, rebateResult] = await Promise.all([
      pool.query("SELECT * FROM mandi_tax_rules ORDER BY origin_type"),
      pool.query("SELECT * FROM rebate_rules ORDER BY pay_within_days, id"),
    ]);
    return res.json({ mandiTaxRules: mandiResult.rows, rebateRules: rebateResult.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Settings" });
  }
});

app.get("/settings", async (req, res) => {
  try {
    return res.json(await getSettingsBundle(req.query.user_id));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Settings" });
  }
});

app.put("/settings/business", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage business settings" });
    const result = await pool.query(
      `
      UPDATE business_settings
      SET
        business_name = $1,
        brand_name = $2,
        company_name = $3,
        address = $4,
        phone_number = $5,
        gst_number = $6,
        logo_url = $7,
        compact_logo_text = $8,
        invoice_footer_text = $9,
        updated_by = $10,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
      RETURNING *
      `,
      [
        cleanText(req.body.business_name) || "FroozERP Retail",
        cleanText(req.body.brand_name) || "FEEL THE FREAKIN' FROOZ",
        cleanText(req.body.company_name) || "SRT Company",
        nullableText(req.body.address),
        nullableText(req.body.phone_number),
        nullableText(req.body.gst_number),
        nullableText(req.body.logo_url),
        nullableText(req.body.compact_logo_text) || "FTF",
        nullableText(req.body.invoice_footer_text) || "Thank you for shopping with FEEL THE FREAKIN' FROOZ.",
        manager.id,
      ]
    );
    return res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating Business Settings" });
  }
});

app.put("/settings/sale-rate", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    const desiredMargin = parseNonNegativeNumber(req.body.desired_margin_percent);
    const roundingRule = String(req.body.rounding_rule || "NEAREST_RUPEE").toUpperCase();
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage sale rate settings" });
    if (desiredMargin === null || !ROUNDING_RULES.has(roundingRule)) {
      return res.status(400).json({ message: "Enter valid sale rate settings" });
    }
    const result = await pool.query(
      `
      UPDATE sale_rate_settings
      SET desired_margin_percent = $1, rounding_rule = $2, suggestion_enabled = $3,
          notes = $4, updated_by = $5, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
      RETURNING *
      `,
      [desiredMargin, roundingRule, req.body.suggestion_enabled !== false, nullableText(req.body.notes), manager.id]
    );
    return res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating Sale Rate Settings" });
  }
});

app.get("/settings/discount-rules", async (req, res) => {
  try {
    const includeInactive = req.query.include_inactive === "true";
    const result = await pool.query(
      `
      SELECT *
      FROM sale_discount_rules
      ${includeInactive ? "" : "WHERE active = TRUE"}
      ORDER BY minimum_bill_amount, maximum_bill_amount NULLS LAST, id
      `
    );
    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Discount Rules" });
  }
});

app.post("/settings/discount-rules", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    const rule = readDiscountRulePayload(req.body);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage discount rules" });
    if (
      !rule.rule_name ||
      rule.minimum_bill_amount === null ||
      hasInvalidDiscountMaximum(req.body, rule) ||
      rule.discount_value === null ||
      !DISCOUNT_TYPES.has(rule.discount_type) ||
      !DISCOUNT_PAYMENT_MODES.has(rule.payment_mode) ||
      (rule.maximum_bill_amount !== null && rule.maximum_bill_amount < rule.minimum_bill_amount)
    ) {
      return res.status(400).json({ message: "Enter valid discount rule details" });
    }
    const result = await pool.query(
      `
      INSERT INTO sale_discount_rules (
        rule_name, minimum_bill_amount, maximum_bill_amount, discount_type,
        discount_value, payment_mode, active, updated_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
      `,
      [
        rule.rule_name, rule.minimum_bill_amount, rule.maximum_bill_amount, rule.discount_type,
        rule.discount_value, rule.payment_mode, rule.active, manager.id,
      ]
    );
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Adding Discount Rule" });
  }
});

app.put("/settings/discount-rules/:id", async (req, res) => {
  try {
    const ruleId = parsePositiveInteger(req.params.id);
    const manager = await requireRateManager(req.body.updated_by);
    const rule = readDiscountRulePayload(req.body);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage discount rules" });
    if (
      !ruleId ||
      !rule.rule_name ||
      rule.minimum_bill_amount === null ||
      hasInvalidDiscountMaximum(req.body, rule) ||
      rule.discount_value === null ||
      !DISCOUNT_TYPES.has(rule.discount_type) ||
      !DISCOUNT_PAYMENT_MODES.has(rule.payment_mode) ||
      (rule.maximum_bill_amount !== null && rule.maximum_bill_amount < rule.minimum_bill_amount)
    ) {
      return res.status(400).json({ message: "Enter valid discount rule details" });
    }
    const result = await pool.query(
      `
      UPDATE sale_discount_rules
      SET
        rule_name = $1,
        minimum_bill_amount = $2,
        maximum_bill_amount = $3,
        discount_type = $4,
        discount_value = $5,
        payment_mode = $6,
        active = $7,
        updated_by = $8,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $9
      RETURNING *
      `,
      [
        rule.rule_name, rule.minimum_bill_amount, rule.maximum_bill_amount, rule.discount_type,
        rule.discount_value, rule.payment_mode, rule.active, manager.id, ruleId,
      ]
    );
    return result.rows[0] ? res.json(result.rows[0]) : res.status(404).json({ message: "Discount rule not found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating Discount Rule" });
  }
});

app.delete("/settings/discount-rules/:id", async (req, res) => {
  try {
    const ruleId = parsePositiveInteger(req.params.id);
    const manager = await requireRateManager(req.body.updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage discount rules" });
    if (!ruleId) return res.status(400).json({ message: "Invalid discount rule" });
    const result = await pool.query("DELETE FROM sale_discount_rules WHERE id = $1 RETURNING id", [ruleId]);
    return result.rows[0] ? res.json({ success: true }) : res.status(404).json({ message: "Discount rule not found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Deleting Discount Rule" });
  }
});

app.post("/settings/mandi-tax-rules", async (req, res) => {
  try {
    const taxPercent = parseNonNegativeNumber(req.body.tax_percent);
    const originType = String(req.body.origin_type || "").toUpperCase();
    const manager = await requireRateManager(req.body.updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage settings" });
    if (!originType || taxPercent === null) return res.status(400).json({ message: "Enter valid mandi tax rule details" });
    const result = await pool.query(
      `
      INSERT INTO mandi_tax_rules (origin_type, tax_percent, active, updated_by)
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [originType, taxPercent, req.body.active !== false, manager.id]
    );
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    if (error.code === "23505") return res.status(409).json({ message: "Mandi tax rule already exists for this origin type" });
    return res.status(500).json({ message: "Error Adding Mandi Tax Rule" });
  }
});

app.put("/settings/mandi-tax-rules/:id", async (req, res) => {
  try {
    const ruleId = parsePositiveInteger(req.params.id);
    const taxPercent = parseNonNegativeNumber(req.body.tax_percent);
    const manager = await requireRateManager(req.body.updated_by);
    if (!ruleId || taxPercent === null || !manager) {
      return res.status(manager ? 400 : 403).json({ message: manager ? "Enter a valid mandi tax rate" : "Only Owner or Admin can manage settings" });
    }
    const result = await pool.query(
      `
      UPDATE mandi_tax_rules
      SET tax_percent = $1, active = $2, updated_by = $3, updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
      RETURNING *
      `,
      [taxPercent, req.body.active !== false, manager.id, ruleId]
    );
    return result.rows[0] ? res.json(result.rows[0]) : res.status(404).json({ message: "Mandi tax rule not found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating Mandi Tax Rule" });
  }
});

app.delete("/settings/mandi-tax-rules/:id", async (req, res) => {
  try {
    const ruleId = parsePositiveInteger(req.params.id);
    const manager = await requireRateManager(req.body.updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage settings" });
    if (!ruleId) return res.status(400).json({ message: "Invalid mandi tax rule" });
    const result = await pool.query("DELETE FROM mandi_tax_rules WHERE id = $1 RETURNING id", [ruleId]);
    return result.rows[0] ? res.json({ success: true }) : res.status(404).json({ message: "Mandi tax rule not found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Deleting Mandi Tax Rule" });
  }
});

app.post("/settings/rebate-rules", async (req, res) => {
  try {
    const { rule_name, pay_within_days, rebate_percent, active, updated_by } = req.body;
    const parsedDays = parseNonNegativeNumber(pay_within_days);
    const parsedPercent = parseNonNegativeNumber(rebate_percent);
    const manager = await requireRateManager(updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage settings" });
    if (!rule_name?.trim() || !Number.isInteger(parsedDays) || parsedPercent === null) {
      return res.status(400).json({ message: "Enter valid rebate rule details" });
    }
    const result = await pool.query(
      `
      INSERT INTO rebate_rules (rule_name, pay_within_days, rebate_percent, active, updated_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [rule_name.trim(), parsedDays, parsedPercent, active !== false, manager.id]
    );
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Adding Rebate Rule" });
  }
});

app.put("/settings/rebate-rules/:id", async (req, res) => {
  try {
    const ruleId = parsePositiveInteger(req.params.id);
    const { rule_name, pay_within_days, rebate_percent, active, updated_by } = req.body;
    const parsedDays = parseNonNegativeNumber(pay_within_days);
    const parsedPercent = parseNonNegativeNumber(rebate_percent);
    const manager = await requireRateManager(updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage settings" });
    if (!ruleId || !rule_name?.trim() || !Number.isInteger(parsedDays) || parsedPercent === null) {
      return res.status(400).json({ message: "Enter valid rebate rule details" });
    }
    const result = await pool.query(
      `
      UPDATE rebate_rules
      SET rule_name = $1, pay_within_days = $2, rebate_percent = $3, active = $4, updated_by = $5, updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
      RETURNING *
      `,
      [rule_name.trim(), parsedDays, parsedPercent, active !== false, manager.id, ruleId]
    );
    return result.rows[0] ? res.json(result.rows[0]) : res.status(404).json({ message: "Rebate rule not found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating Rebate Rule" });
  }
});

app.delete("/settings/rebate-rules/:id", async (req, res) => {
  try {
    const ruleId = parsePositiveInteger(req.params.id);
    const manager = await requireRateManager(req.body.updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage settings" });
    if (!ruleId) return res.status(400).json({ message: "Invalid rebate rule" });
    const result = await pool.query("DELETE FROM rebate_rules WHERE id = $1 RETURNING id", [ruleId]);
    return result.rows[0] ? res.json({ success: true }) : res.status(404).json({ message: "Rebate rule not found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Deleting Rebate Rule" });
  }
});

app.get("/", (req, res) => {
  res.send("FroozERP Backend Running");
});

app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    const result = await pool.query(
      `
      SELECT
        u.id,
        u.full_name,
        u.username,
        u.password_hash,
        u.branch_id,
        r.role_name,
        b.branch_name
      FROM users u
      JOIN roles r ON u.role_id = r.id
      JOIN branches b ON u.branch_id = b.id
      WHERE u.username = $1
        AND u.active = TRUE
      `,
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ message: "User not found" });
    }

    const user = result.rows[0];
    if (user.password_hash !== password) {
      return res.status(401).json({ message: "Invalid password" });
    }

    return res.json({
      id: user.id,
      full_name: user.full_name,
      username: user.username,
      role: user.role_name,
      branch_id: user.branch_id,
      branch: user.branch_name,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Login Error" });
  }
});

app.get("/products", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM products ORDER BY product_name");
    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Database Error" });
  }
});

app.post("/products", async (req, res) => {
  try {
    const { product_name, selling_rate, unit, barcode, origin_type, category, minimum_stock, active, created_by } = req.body;
    const parsedSellingRate = parsePositiveNumber(selling_rate);
    const parsedMinimumStock = parseNonNegativeNumber(minimum_stock);
    const parsedOriginType = String(origin_type || "LOCAL").toUpperCase();
    const rateManager = await requireRateManager(created_by);

    if (!rateManager) return res.status(403).json({ message: "Only Owner or Admin can create owner-approved selling rates" });
    if (!product_name?.trim() || !unit?.trim() || !parsedSellingRate || parsedMinimumStock === null || !["LOCAL", "IMPORTED"].includes(parsedOriginType)) {
      return res.status(400).json({ message: "Enter valid product details" });
    }

    const result = await pool.query(
      `
      INSERT INTO products (
        product_name, selling_rate, unit, barcode, origin_type, category,
        minimum_stock, active, selling_rate_updated_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
      `,
      [
        product_name.trim(), parsedSellingRate, unit.trim(), barcode?.trim() || null, parsedOriginType,
        category?.trim() || "Fruit", parsedMinimumStock, active !== false, rateManager.id,
      ]
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    if (error.code === "23505") {
      return res.status(409).json({ message: "Barcode is already assigned to another product" });
    }
    return res.status(500).json({ message: "Error Adding Product" });
  }
});

app.put("/products/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const productId = parsePositiveInteger(req.params.id);
    const { product_name, selling_rate, unit, barcode, origin_type, category, minimum_stock, active, updated_by, rate_change_reason } = req.body;
    const parsedSellingRate = parsePositiveNumber(selling_rate);
    const parsedMinimumStock = parseNonNegativeNumber(minimum_stock);
    const parsedOriginType = String(origin_type || "").toUpperCase();

    if (!productId || !product_name?.trim() || !unit?.trim() || !parsedSellingRate || parsedMinimumStock === null || !["LOCAL", "IMPORTED"].includes(parsedOriginType)) {
      return res.status(400).json({ message: "Enter valid product details" });
    }

    await client.query("BEGIN");
    const currentResult = await client.query("SELECT * FROM products WHERE id = $1 FOR UPDATE", [productId]);
    if (currentResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Product not found" });
    }
    const current = currentResult.rows[0];
    const sellingRateChanged = Number(current.selling_rate) !== parsedSellingRate;
    const rateManager = sellingRateChanged ? await requireRateManager(updated_by, client) : null;
    if (sellingRateChanged && !rateManager) {
      await client.query("ROLLBACK");
      return res.status(403).json({ message: "Only Owner or Admin can change selling rates" });
    }

    const result = await client.query(
      `
      UPDATE products
      SET
        product_name = $1, selling_rate = $2, unit = $3, barcode = $4,
        origin_type = $5, category = $6, minimum_stock = $7, active = $8,
        selling_rate_updated_at = CASE WHEN selling_rate <> $2 THEN CURRENT_TIMESTAMP ELSE selling_rate_updated_at END,
        selling_rate_updated_by = CASE WHEN selling_rate <> $2 THEN $9 ELSE selling_rate_updated_by END
      WHERE id = $10
      RETURNING *
      `,
      [
        product_name.trim(), parsedSellingRate, unit.trim(), barcode?.trim() || null,
        parsedOriginType, category?.trim() || "Fruit", parsedMinimumStock, active !== false,
        rateManager?.id || null, productId,
      ]
    );

    if (sellingRateChanged) {
      await client.query(
        `
        INSERT INTO sale_rate_history (product_id, old_selling_rate, new_selling_rate, changed_by, reason)
        VALUES ($1, $2, $3, $4, $5)
        `,
        [productId, current.selling_rate, parsedSellingRate, rateManager.id, rate_change_reason?.trim() || "Product Master update"]
      );
    }
    await client.query("COMMIT");
    return res.json(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    if (error.code === "23505") {
      return res.status(409).json({ message: "Barcode is already assigned to another product" });
    }
    return res.status(500).json({ message: "Error Updating Product" });
  } finally {
    client.release();
  }
});

app.get("/inventory", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        ib.id,
        ib.product_id,
        p.product_name,
        p.barcode,
        ib.batch_no,
        ib.purchase_qty,
        ib.remaining_qty,
        ib.purchase_rate,
        ib.effective_cost_per_unit,
        ib.mandi_tax_amount,
        ib.freight_charges,
        ib.labour_charges,
        ib.other_charges,
        ib.gross_amount,
        ib.rebate_amount,
        ib.net_payable,
        ib.payment_timing,
        ib.balance_amount,
        ib.supplier_id,
        ib.supplier_name,
        ib.purchase_date
      FROM inventory_batches ib
      JOIN products p ON p.id = ib.product_id
      ORDER BY ib.purchase_date, ib.created_at, ib.id
    `);

    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Inventory Error" });
  }
});

app.get("/stock", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        p.id,
        p.product_name,
        p.barcode,
        p.unit,
        COALESCE(SUM(ib.remaining_qty), 0) AS current_stock
      FROM products p
      LEFT JOIN inventory_batches ib ON ib.product_id = p.id
      GROUP BY p.id, p.product_name, p.unit
      ORDER BY p.product_name
    `);

    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Stock" });
  }
});

app.get("/sale-rates", async (req, res) => {
  try {
    if (!await requireRateManager(req.query.user_id)) {
      return res.status(403).json({ message: "Only Owner or Admin can manage selling rates" });
    }
    const settingsResult = await pool.query("SELECT * FROM sale_rate_settings WHERE id = 1");
    const saleRateSettings = settingsResult.rows[0] || {};
    const desiredMargin = parseNonNegativeNumber(req.query.desired_margin) ?? Number(saleRateSettings.desired_margin_percent || 25);
    const roundingRule = ROUNDING_RULES.has(saleRateSettings.rounding_rule)
      ? saleRateSettings.rounding_rule
      : "NEAREST_RUPEE";
    const result = await pool.query(
      `
      SELECT
        p.id,
        p.product_name,
        p.category,
        p.origin_type,
        p.unit,
        p.selling_rate,
        p.selling_rate_updated_at,
        u.full_name AS updated_by_name,
        COALESCE(stock.current_stock, 0) AS current_stock,
        COALESCE(latest.effective_cost_per_unit, 0) AS latest_effective_cost,
        CASE
          WHEN COALESCE(latest.effective_cost_per_unit, 0) > 0
            THEN latest.effective_cost_per_unit * (1 + $1 / 100.0)
          ELSE p.selling_rate
        END AS suggested_selling_rate
      FROM products p
      LEFT JOIN users u ON u.id = p.selling_rate_updated_by
      LEFT JOIN LATERAL (
        SELECT ib.effective_cost_per_unit
        FROM inventory_batches ib
        WHERE ib.product_id = p.id
        ORDER BY ib.purchase_date DESC, ib.created_at DESC, ib.id DESC
        LIMIT 1
      ) latest ON TRUE
      LEFT JOIN LATERAL (
        SELECT SUM(ib.remaining_qty) AS current_stock
        FROM inventory_batches ib
        WHERE ib.product_id = p.id
      ) stock ON TRUE
      WHERE p.active = TRUE
      ORDER BY p.product_name
      `,
      [desiredMargin]
    );
    return res.json(result.rows.map((row) => ({
      ...row,
      suggested_selling_rate: applySaleRateRounding(row.suggested_selling_rate, roundingRule),
    })));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Sale Rates" });
  }
});

app.post("/sale-rates/bulk", async (req, res) => {
  const client = await pool.connect();
  try {
    const manager = await requireRateManager(req.body.changed_by, client);
    const updates = Array.isArray(req.body.updates) ? req.body.updates : [];
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage selling rates" });
    if (updates.length === 0) return res.status(400).json({ message: "Add at least one selling rate update" });

    await client.query("BEGIN");
    const saved = [];
    for (const update of updates) {
      const productId = parsePositiveInteger(update.product_id);
      const newRate = parsePositiveNumber(update.new_selling_rate);
      if (!productId || !newRate) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Enter valid selling rates" });
      }
      const currentResult = await client.query("SELECT id, selling_rate FROM products WHERE id = $1 AND active = TRUE FOR UPDATE", [productId]);
      if (currentResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Product not found" });
      }
      const oldRate = Number(currentResult.rows[0].selling_rate);
      if (oldRate === newRate) continue;
      const productResult = await client.query(
        `
        UPDATE products
        SET selling_rate = $1, selling_rate_updated_at = CURRENT_TIMESTAMP, selling_rate_updated_by = $2
        WHERE id = $3
        RETURNING *
        `,
        [newRate, manager.id, productId]
      );
      await client.query(
        `
        INSERT INTO sale_rate_history (product_id, old_selling_rate, new_selling_rate, changed_by, reason)
        VALUES ($1, $2, $3, $4, $5)
        `,
        [productId, oldRate, newRate, manager.id, update.reason?.trim() || "Daily sale rate update"]
      );
      saved.push(productResult.rows[0]);
    }
    await client.query("COMMIT");
    return res.json({ success: true, updated_count: saved.length, products: saved });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Updating Sale Rates" });
  } finally {
    client.release();
  }
});

app.get("/sale-rate-history", async (req, res) => {
  try {
    if (!await requireRateManager(req.query.user_id)) {
      return res.status(403).json({ message: "Only Owner or Admin can view selling rate history" });
    }
    const result = await pool.query(
      `
      SELECT h.*, p.product_name, u.full_name AS changed_by_name
      FROM sale_rate_history h
      JOIN products p ON p.id = h.product_id
      JOIN users u ON u.id = h.changed_by
      ORDER BY h.changed_at DESC, h.id DESC
      LIMIT 100
      `
    );
    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Sale Rate History" });
  }
});

const loadUnifiedAccounts = async () => {
  const [customerRows, supplierRows, genericRows] = await Promise.all([
    getCustomerSummaryRows(),
    getSupplierSummaryRows(),
    pool.query("SELECT * FROM accounts ORDER BY active DESC, account_name"),
  ]);
  return [
    ...customerRows.map((account) => ({
      ...account,
      account_key: `CUSTOMER-${account.id}`,
      source: "CUSTOMER",
      source_id: account.id,
      account_type: "CUSTOMER",
      account_name: account.customer_name,
      mobile_number: account.mobile_number,
      outstanding_balance: Number(account.outstanding_balance || 0),
      receivable_balance: Number(account.outstanding_balance || 0),
      payable_balance: 0,
    })),
    ...supplierRows.map((account) => ({
      ...account,
      account_key: `SUPPLIER-${account.id}`,
      source: "SUPPLIER",
      source_id: account.id,
      account_type: accountTypeFromSupplierType(account.supplier_type),
      account_name: account.supplier_name,
      mobile_number: account.mobile_number,
      outstanding_balance: Number(account.outstanding_balance || 0),
      receivable_balance: 0,
      payable_balance: Number(account.outstanding_balance || 0),
    })),
    ...genericRows.rows.map((account) => ({
      ...account,
      account_key: `ACCOUNT-${account.id}`,
      source: "ACCOUNT",
      source_id: account.id,
      outstanding_balance: Number(account.opening_balance || 0),
      receivable_balance: 0,
      payable_balance: Number(account.opening_balance || 0),
    })),
  ].sort((left, right) => Number(right.active === true) - Number(left.active === true) || left.account_name.localeCompare(right.account_name));
};

app.get("/accounts", async (req, res) => {
  try {
    const search = cleanText(req.query.search).toLowerCase();
    const accountType = req.query.account_type ? normalizeAccountType(req.query.account_type) : "";
    const rows = await loadUnifiedAccounts();
    return res.json(rows.filter((account) =>
      (!accountType || account.account_type === accountType) &&
      (!search || account.account_name.toLowerCase().includes(search) || String(account.mobile_number || "").includes(search))
    ));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Accounts" });
  }
});

app.post("/accounts", async (req, res) => {
  try {
    const account = readAccountPayload(req.body);
    if (!account.account_name || !ACCOUNT_TYPES.has(account.account_type) || account.opening_balance === null) {
      return res.status(400).json({ message: "Enter valid account details" });
    }
    if (account.account_type === "CUSTOMER") {
      const result = await pool.query(
        `
        INSERT INTO customers (
          customer_name, customer_type, firm_name, mobile_number, alternate_number, address,
          city, gst_number, bank_name, account_number, ifsc_code, upi_id, notes,
          opening_balance, active
        )
        VALUES ($1, 'RETAIL', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING id
        `,
        [
          account.account_name, account.firm_name, account.mobile_number, account.alternate_number,
          account.address, account.city, account.gst_number, account.bank_name, account.account_number,
          account.ifsc_code, account.upi_id, account.notes, account.opening_balance, account.active,
        ]
      );
      return res.status(201).json({ success: true, account_key: `CUSTOMER-${result.rows[0].id}` });
    }
    if (["SUPPLIER", "TRANSPORT_VENDOR", "COMMISSION_AGENT"].includes(account.account_type)) {
      const result = await pool.query(
        `
        INSERT INTO suppliers (
          supplier_name, firm_name, mobile_number, alternate_number, address, city,
          gst_number, bank_name, account_number, ifsc_code, upi_id, notes,
          opening_balance, supplier_type, active
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING id
        `,
        [
          account.account_name, account.firm_name, account.mobile_number, account.alternate_number,
          account.address, account.city, account.gst_number, account.bank_name, account.account_number,
          account.ifsc_code, account.upi_id, account.notes, account.opening_balance,
          supplierTypeFromAccountType(account.account_type), account.active,
        ]
      );
      return res.status(201).json({ success: true, account_key: `SUPPLIER-${result.rows[0].id}` });
    }
    const result = await pool.query(
      `
      INSERT INTO accounts (
        account_name, account_type, firm_name, mobile_number, alternate_number, address, city,
        gst_number, bank_name, account_number, ifsc_code, upi_id, opening_balance, active, notes
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING id
      `,
      [
        account.account_name, account.account_type, account.firm_name, account.mobile_number,
        account.alternate_number, account.address, account.city, account.gst_number,
        account.bank_name, account.account_number, account.ifsc_code, account.upi_id,
        account.opening_balance, account.active, account.notes,
      ]
    );
    return res.status(201).json({ success: true, account_key: `ACCOUNT-${result.rows[0].id}` });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Saving Account" });
  }
});

app.put("/accounts/:accountKey", async (req, res) => {
  try {
    const [source, idValue] = String(req.params.accountKey || "").split("-");
    const sourceId = parsePositiveInteger(Number(idValue));
    const account = readAccountPayload(req.body);
    if (!sourceId || !account.account_name || !ACCOUNT_TYPES.has(account.account_type) || account.opening_balance === null) {
      return res.status(400).json({ message: "Enter valid account details" });
    }
    if (source === "CUSTOMER") {
      const result = await pool.query(
        `
        UPDATE customers
        SET customer_name = $1, firm_name = $2, mobile_number = $3, alternate_number = $4,
            address = $5, city = $6, gst_number = $7, bank_name = $8, account_number = $9,
            ifsc_code = $10, upi_id = $11, opening_balance = $12, active = $13,
            notes = $14, updated_at = CURRENT_TIMESTAMP
        WHERE id = $15
        RETURNING id
        `,
        [
          account.account_name, account.firm_name, account.mobile_number, account.alternate_number,
          account.address, account.city, account.gst_number, account.bank_name, account.account_number,
          account.ifsc_code, account.upi_id, account.opening_balance, account.active, account.notes, sourceId,
        ]
      );
      return result.rows[0] ? res.json({ success: true }) : res.status(404).json({ message: "Account not found" });
    }
    if (source === "SUPPLIER") {
      const result = await pool.query(
        `
        UPDATE suppliers
        SET supplier_name = $1, firm_name = $2, mobile_number = $3, alternate_number = $4,
            address = $5, city = $6, gst_number = $7, bank_name = $8, account_number = $9,
            ifsc_code = $10, upi_id = $11, opening_balance = $12, supplier_type = $13,
            active = $14, notes = $15, updated_at = CURRENT_TIMESTAMP
        WHERE id = $16
        RETURNING id
        `,
        [
          account.account_name, account.firm_name, account.mobile_number, account.alternate_number,
          account.address, account.city, account.gst_number, account.bank_name, account.account_number,
          account.ifsc_code, account.upi_id, account.opening_balance,
          supplierTypeFromAccountType(account.account_type), account.active, account.notes, sourceId,
        ]
      );
      return result.rows[0] ? res.json({ success: true }) : res.status(404).json({ message: "Account not found" });
    }
    if (source === "ACCOUNT") {
      const result = await pool.query(
        `
        UPDATE accounts
        SET account_name = $1, account_type = $2, firm_name = $3, mobile_number = $4,
            alternate_number = $5, address = $6, city = $7, gst_number = $8,
            bank_name = $9, account_number = $10, ifsc_code = $11, upi_id = $12,
            opening_balance = $13, active = $14, notes = $15, updated_at = CURRENT_TIMESTAMP
        WHERE id = $16
        RETURNING id
        `,
        [
          account.account_name, account.account_type, account.firm_name, account.mobile_number,
          account.alternate_number, account.address, account.city, account.gst_number,
          account.bank_name, account.account_number, account.ifsc_code, account.upi_id,
          account.opening_balance, account.active, account.notes, sourceId,
        ]
      );
      return result.rows[0] ? res.json({ success: true }) : res.status(404).json({ message: "Account not found" });
    }
    return res.status(400).json({ message: "Invalid account" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating Account" });
  }
});

app.get("/accounts/outstanding", async (req, res) => {
  try {
    const accounts = await loadUnifiedAccounts();
    const customerOutstanding = accounts.filter((account) => account.account_type === "CUSTOMER");
    const supplierOutstanding = accounts.filter((account) => ["SUPPLIER", "TRANSPORT_VENDOR", "COMMISSION_AGENT"].includes(account.account_type));
    return res.json({
      customerOutstanding,
      supplierOutstanding,
      totalReceivable: roundCurrency(customerOutstanding.reduce((sum, account) => sum + Number(account.receivable_balance || 0), 0)),
      totalPayable: roundCurrency(supplierOutstanding.reduce((sum, account) => sum + Number(account.payable_balance || 0), 0)),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Account Outstanding" });
  }
});

app.get("/accounts/ledger", async (req, res) => {
  try {
    const accountKey = String(req.query.account_key || "");
    const [source, idValue] = accountKey.split("-");
    const sourceId = parsePositiveInteger(Number(idValue));
    if (!sourceId || !["CUSTOMER", "SUPPLIER", "ACCOUNT"].includes(source)) {
      return res.json({ account: null, ledger: [] });
    }
    if (source === "CUSTOMER") {
      const customers = await getCustomerSummaryRows({ customerId: sourceId });
      if (customers.length === 0) return res.json({ account: null, ledger: [] });
      const ledgerResult = await pool.query(
        `
        SELECT *
        FROM (
          SELECT s.sale_date AS date, 'Sale' AS transaction_type,
            s.total_amount AS debit,
            COALESCE(pay.total_paid, 0) AS credit,
            s.total_amount - COALESCE(pay.total_paid, 0) AS delta,
            COALESCE(s.invoice_no, 'Sale #' || s.id) AS remarks,
            s.created_at
          FROM sales s
          LEFT JOIN (
            SELECT sale_id, SUM(amount) AS total_paid
            FROM sale_payments
            GROUP BY sale_id
          ) pay ON pay.sale_id = s.id
          WHERE s.sale_status <> 'CANCELLED'
            AND (
              (s.customer_mobile IS NOT NULL AND s.customer_mobile = $2)
              OR (s.customer_mobile IS NULL AND s.customer_name IS NOT NULL AND LOWER(s.customer_name) = LOWER($3))
            )
          UNION ALL
          SELECT cp.payment_date AS date, 'Customer Payment' AS transaction_type,
            0 AS debit,
            cp.payment_amount AS credit,
            -cp.payment_amount AS delta,
            COALESCE(cp.remarks, cp.reference_number, 'Customer payment') AS remarks,
            cp.created_at
          FROM customer_payments cp
          WHERE cp.customer_id = $1 AND cp.cancelled = FALSE
        ) entries
        ORDER BY date, created_at
        `,
        [sourceId, customers[0].mobile_number || "", customers[0].customer_name]
      );
      let balance = Number(customers[0].opening_balance || 0);
      const ledger = [];
      if (balance > 0) {
        ledger.push({ date: toDateKey(customers[0].created_at), transaction_type: "Opening Balance", debit: balance, credit: 0, balance, remarks: "Opening customer receivable balance" });
      }
      for (const row of ledgerResult.rows) {
        balance = roundCurrency(balance + Number(row.delta || 0));
        ledger.push({
          date: toDateKey(row.date),
          transaction_type: row.transaction_type,
          debit: Number(row.debit || 0),
          credit: Number(row.credit || 0),
          balance,
          remarks: row.remarks || "",
        });
      }
      return res.json({ account: customers[0], ledger });
    }
    if (source === "SUPPLIER") {
      const supplierPayload = await pool.query("SELECT * FROM suppliers WHERE id = $1", [sourceId]);
      if (supplierPayload.rows.length === 0) return res.json({ account: null, ledger: [] });
      const ledgerPayload = await (async () => {
        const suppliers = await getSupplierSummaryRows({ supplierId: sourceId });
        const ledgerResult = await pool.query(
          `
          SELECT *
          FROM (
            SELECT p.purchase_date AS date, 'Purchase' AS transaction_type,
              COALESCE(NULLIF(p.gross_amount, 0), p.total_amount, 0) AS debit,
              COALESCE(p.rebate_amount, 0) + COALESCE(p.paid_amount, 0) AS credit,
              COALESCE(NULLIF(p.gross_amount, 0), p.total_amount, 0) - COALESCE(p.rebate_amount, 0) - COALESCE(p.paid_amount, 0) AS delta,
              p.supplier_name AS account_name,
              COALESCE(p.payment_timing, '') AS remarks,
              p.created_at
            FROM purchases p
            WHERE p.supplier_id = $1
            UNION ALL
            SELECT sp.payment_date AS date,
              CASE WHEN sp.rebate_amount > 0 AND sp.payment_amount = 0 THEN 'Rebate' ELSE 'Supplier Payment' END AS transaction_type,
              0 AS debit,
              sp.payment_amount + sp.rebate_amount AS credit,
              -(sp.payment_amount + sp.rebate_amount) AS delta,
              s.supplier_name AS account_name,
              COALESCE(sp.remarks, sp.reference_number, '') AS remarks,
              sp.created_at
            FROM supplier_payments sp
            JOIN suppliers s ON s.id = sp.supplier_id
            WHERE sp.supplier_id = $1 AND sp.cancelled = FALSE
          ) entries
          ORDER BY date, created_at
          `,
          [sourceId]
        );
        let balance = Number(suppliers[0]?.opening_balance || 0);
        const ledger = [];
        if (balance > 0) {
          ledger.push({ date: toDateKey(suppliers[0].created_at), transaction_type: "Opening Balance", debit: balance, credit: 0, balance, remarks: "Opening supplier payable balance" });
        }
        for (const row of ledgerResult.rows) {
          balance = roundCurrency(balance + Number(row.delta || 0));
          ledger.push({
            date: toDateKey(row.date),
            transaction_type: row.transaction_type,
            debit: Number(row.debit || 0),
            credit: Number(row.credit || 0),
            balance,
            remarks: row.remarks || "",
          });
        }
        return { account: suppliers[0] || supplierPayload.rows[0], ledger };
      })();
      return res.json(ledgerPayload);
    }
    const accountResult = await pool.query("SELECT * FROM accounts WHERE id = $1", [sourceId]);
    const account = accountResult.rows[0];
    if (!account) return res.json({ account: null, ledger: [] });
    const opening = Number(account.opening_balance || 0);
    return res.json({
      account,
      ledger: opening > 0 ? [{
        date: toDateKey(account.created_at),
        transaction_type: "Opening Balance",
        debit: opening,
        credit: 0,
        balance: opening,
        remarks: "Opening account balance",
      }] : [],
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Account Ledger" });
  }
});

app.post("/accounts/payments", async (req, res) => {
  try {
    const accountKey = String(req.body.account_key || "");
    const [source, idValue] = accountKey.split("-");
    const sourceId = parsePositiveInteger(Number(idValue));
    const action = String(req.body.payment_action || "").toUpperCase();
    const amount = parseNonNegativeNumber(req.body.amount);
    const paymentMode = normalizePaymentMode(req.body.payment_mode || "CASH");
    if (!sourceId || amount === null || amount <= 0 || !SUPPLIER_PAYMENT_MODES.has(paymentMode)) {
      return res.status(400).json({ message: "Enter valid account payment details" });
    }
    if (action === "RECEIVE_CUSTOMER" && source === "CUSTOMER") {
      const result = await pool.query(
        `
        INSERT INTO customer_payments (
          customer_id, payment_date, payment_amount, payment_mode, reference_number,
          remarks, branch_id, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
        `,
        [
          sourceId, req.body.payment_date || toDateKey(new Date()), amount, paymentMode,
          nullableText(req.body.reference_number), nullableText(req.body.remarks),
          parsePositiveInteger(req.body.branch_id), parsePositiveInteger(req.body.created_by) || 1,
        ]
      );
      return res.status(201).json(result.rows[0]);
    }
    if (["PAY_SUPPLIER", "SUPPLIER_REBATE"].includes(action) && source === "SUPPLIER") {
      const result = await pool.query(
        `
        INSERT INTO supplier_payments (
          supplier_id, payment_date, payment_amount, rebate_amount, payment_mode,
          reference_number, remarks, branch_id, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
        `,
        [
          sourceId, req.body.payment_date || toDateKey(new Date()),
          action === "PAY_SUPPLIER" ? amount : 0,
          action === "SUPPLIER_REBATE" ? amount : 0,
          paymentMode, nullableText(req.body.reference_number), nullableText(req.body.remarks),
          parsePositiveInteger(req.body.branch_id), parsePositiveInteger(req.body.created_by) || 1,
        ]
      );
      return res.status(201).json(result.rows[0]);
    }
    return res.status(400).json({ message: "Selected account type does not match payment action" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Saving Account Payment" });
  }
});

app.get("/suppliers", async (req, res) => {
  try {
    const active = req.query.active === undefined ? undefined : String(req.query.active) === "true";
    const rows = await getSupplierSummaryRows({
      active,
      search: cleanText(req.query.search),
    });
    return res.json(rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Suppliers" });
  }
});

app.post("/suppliers", async (req, res) => {
  try {
    const supplier = readSupplierPayload(req.body);
    if (!supplier.supplier_name || supplier.opening_balance === null || !SUPPLIER_TYPES.has(supplier.supplier_type)) {
      return res.status(400).json({ message: "Enter valid supplier account details" });
    }

    const result = await pool.query(
      `
      INSERT INTO suppliers (
        supplier_name, firm_name, mobile_number, alternate_number, address, city,
        gst_number, bank_name, account_number, ifsc_code, upi_id, notes,
        opening_balance, supplier_type, active
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *
      `,
      [
        supplier.supplier_name, supplier.firm_name, supplier.mobile_number, supplier.alternate_number,
        supplier.address, supplier.city, supplier.gst_number, supplier.bank_name, supplier.account_number,
        supplier.ifsc_code, supplier.upi_id, supplier.notes, supplier.opening_balance, supplier.supplier_type,
        supplier.active,
      ]
    );
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Saving Supplier" });
  }
});

app.get("/suppliers/:id", async (req, res) => {
  try {
    const supplierId = parsePositiveInteger(req.params.id);
    if (!supplierId) return res.status(400).json({ message: "Invalid supplier" });
    const rows = await getSupplierSummaryRows({ supplierId });
    return rows[0] ? res.json(rows[0]) : res.status(404).json({ message: "Supplier not found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Supplier" });
  }
});

app.put("/suppliers/:id", async (req, res) => {
  try {
    const supplierId = parsePositiveInteger(req.params.id);
    const supplier = readSupplierPayload(req.body);
    if (!supplierId || !supplier.supplier_name || supplier.opening_balance === null || !SUPPLIER_TYPES.has(supplier.supplier_type)) {
      return res.status(400).json({ message: "Enter valid supplier account details" });
    }

    const result = await pool.query(
      `
      UPDATE suppliers
      SET
        supplier_name = $1,
        firm_name = $2,
        mobile_number = $3,
        alternate_number = $4,
        address = $5,
        city = $6,
        gst_number = $7,
        bank_name = $8,
        account_number = $9,
        ifsc_code = $10,
        upi_id = $11,
        notes = $12,
        opening_balance = $13,
        supplier_type = $14,
        active = $15,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $16
      RETURNING *
      `,
      [
        supplier.supplier_name, supplier.firm_name, supplier.mobile_number, supplier.alternate_number,
        supplier.address, supplier.city, supplier.gst_number, supplier.bank_name, supplier.account_number,
        supplier.ifsc_code, supplier.upi_id, supplier.notes, supplier.opening_balance, supplier.supplier_type,
        supplier.active, supplierId,
      ]
    );
    return result.rows[0] ? res.json(result.rows[0]) : res.status(404).json({ message: "Supplier not found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating Supplier" });
  }
});

app.delete("/suppliers/:id", async (req, res) => {
  try {
    const supplierId = parsePositiveInteger(req.params.id);
    if (!supplierId) return res.status(400).json({ message: "Invalid supplier" });
    const result = await pool.query(
      "UPDATE suppliers SET active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *",
      [supplierId]
    );
    return result.rows[0]
      ? res.json({ success: true, supplier: result.rows[0], message: "Supplier marked inactive" })
      : res.status(404).json({ message: "Supplier not found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating Supplier Status" });
  }
});

app.get("/supplier-summary", async (req, res) => {
  try {
    const supplierId = req.query.supplier_id ? parsePositiveInteger(req.query.supplier_id) : null;
    if (req.query.supplier_id && !supplierId) return res.status(400).json({ message: "Invalid supplier" });
    const rows = await getSupplierSummaryRows({ supplierId });
    return res.json(buildSupplierSummaryPayload(rows));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Supplier Summary" });
  }
});

app.get("/customers", async (req, res) => {
  try {
    const active = req.query.active === undefined ? undefined : String(req.query.active) === "true";
    const rows = await getCustomerSummaryRows({ active, search: cleanText(req.query.search) });
    return res.json(rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Customers" });
  }
});

app.post("/customers", async (req, res) => {
  try {
    const customer = readCustomerPayload(req.body);
    if (!customer.customer_name || !CUSTOMER_TYPES.has(customer.customer_type) || customer.opening_balance === null) {
      return res.status(400).json({ message: "Enter valid customer details" });
    }
    const result = await pool.query(
      `
      INSERT INTO customers (
        customer_name, customer_type, firm_name, mobile_number, alternate_number, address,
        city, gst_number, bank_name, account_number, ifsc_code, upi_id, notes,
        opening_balance, active
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *
      `,
      [
        customer.customer_name, customer.customer_type, customer.firm_name, customer.mobile_number,
        customer.alternate_number, customer.address, customer.city, customer.gst_number,
        customer.bank_name, customer.account_number, customer.ifsc_code, customer.upi_id,
        customer.notes, customer.opening_balance, customer.active,
      ]
    );
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Saving Customer" });
  }
});

app.put("/customers/:id", async (req, res) => {
  try {
    const customerId = parsePositiveInteger(req.params.id);
    const customer = readCustomerPayload(req.body);
    if (!customerId || !customer.customer_name || !CUSTOMER_TYPES.has(customer.customer_type) || customer.opening_balance === null) {
      return res.status(400).json({ message: "Enter valid customer details" });
    }
    const result = await pool.query(
      `
      UPDATE customers
      SET customer_name = $1, customer_type = $2, firm_name = $3, mobile_number = $4,
          alternate_number = $5, address = $6, city = $7, gst_number = $8,
          bank_name = $9, account_number = $10, ifsc_code = $11, upi_id = $12,
          notes = $13, opening_balance = $14, active = $15,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $16
      RETURNING *
      `,
      [
        customer.customer_name, customer.customer_type, customer.firm_name, customer.mobile_number,
        customer.alternate_number, customer.address, customer.city, customer.gst_number,
        customer.bank_name, customer.account_number, customer.ifsc_code, customer.upi_id,
        customer.notes, customer.opening_balance, customer.active, customerId,
      ]
    );
    return result.rows[0] ? res.json(result.rows[0]) : res.status(404).json({ message: "Customer not found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating Customer" });
  }
});

app.get("/customer-summary", async (req, res) => {
  try {
    const customerId = req.query.customer_id ? parsePositiveInteger(req.query.customer_id) : null;
    if (req.query.customer_id && !customerId) return res.status(400).json({ message: "Invalid customer" });
    const rows = await getCustomerSummaryRows({ customerId });
    return res.json(buildCustomerSummaryPayload(rows));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Customer Summary" });
  }
});

app.post("/customer-payments", async (req, res) => {
  try {
    const customerId = parsePositiveInteger(req.body.customer_id);
    const paymentAmount = parsePositiveNumber(req.body.payment_amount);
    const paymentMode = String(req.body.payment_mode || "CASH").trim().toUpperCase();
    const paymentDate = req.body.payment_date || toDateKey(new Date());
    if (!customerId || !paymentAmount || !["CASH", "UPI", "CARD", "BANK_TRANSFER"].includes(paymentMode)) {
      return res.status(400).json({ message: "Enter valid customer payment details" });
    }
    const customerResult = await pool.query("SELECT id FROM customers WHERE id = $1 AND active = TRUE", [customerId]);
    if (customerResult.rows.length === 0) return res.status(400).json({ message: "Select an active customer" });
    const result = await pool.query(
      `
      INSERT INTO customer_payments (
        customer_id, payment_date, payment_amount, payment_mode, reference_number,
        remarks, branch_id, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
      `,
      [
        customerId, paymentDate, paymentAmount, paymentMode, nullableText(req.body.reference_number),
        nullableText(req.body.remarks), parsePositiveInteger(req.body.branch_id), parsePositiveInteger(req.body.created_by) || 1,
      ]
    );
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Saving Customer Payment" });
  }
});

app.get("/customer-ledger", async (req, res) => {
  try {
    const customerId = req.query.customer_id ? parsePositiveInteger(req.query.customer_id) : null;
    if (req.query.customer_id && !customerId) return res.status(400).json({ message: "Invalid customer" });
    const customers = await getCustomerSummaryRows({ customerId });
    if (customerId && customers.length === 0) return res.status(404).json({ message: "Customer not found" });
    if (customers.length === 0) return res.json({ customers: [], ledger: [] });
    const ids = customers.map((customer) => customer.id);
    const [salesResult, paymentResult] = await Promise.all([
      pool.query(
        `
        SELECT s.*, c.id AS customer_id, COALESCE(pay.total_paid, 0) AS total_paid
        FROM sales s
        JOIN customers c ON (
          (s.customer_mobile IS NOT NULL AND c.mobile_number = s.customer_mobile)
          OR (s.customer_mobile IS NULL AND s.customer_name IS NOT NULL AND LOWER(c.customer_name) = LOWER(s.customer_name))
        )
        LEFT JOIN (
          SELECT sale_id, SUM(amount) AS total_paid FROM sale_payments GROUP BY sale_id
        ) pay ON pay.sale_id = s.id
        WHERE c.id = ANY($1::INT[])
        ORDER BY s.sale_date, s.created_at, s.id
        `,
        [ids]
      ),
      pool.query(
        `
        SELECT cp.*, c.customer_name
        FROM customer_payments cp
        JOIN customers c ON c.id = cp.customer_id
        WHERE cp.customer_id = ANY($1::INT[])
          AND cp.cancelled = FALSE
        ORDER BY cp.payment_date, cp.created_at, cp.id
        `,
        [ids]
      ),
    ]);
    const ledgersByCustomer = new Map(ids.map((id) => [id, []]));
    const pushEvent = (event) => {
      if (!ledgersByCustomer.has(event.customer_id)) ledgersByCustomer.set(event.customer_id, []);
      ledgersByCustomer.get(event.customer_id).push(event);
    };
    for (const customer of customers) {
      if (Number(customer.opening_balance || 0) > 0) {
        pushEvent({
          customer_id: customer.id,
          customer_name: customer.customer_name,
          transaction_date: toDateKey(customer.created_at),
          sort_key: `O-${customer.id}`,
          transaction_type: "Opening Balance",
          debit_amount: Number(customer.opening_balance),
          credit_amount: 0,
          balance_delta: Number(customer.opening_balance),
          remarks: "Opening customer receivable balance",
        });
      }
    }
    for (const sale of salesResult.rows) {
      if (sale.sale_status !== "CANCELLED") {
        pushEvent({
          customer_id: sale.customer_id,
          customer_name: sale.customer_name,
          transaction_date: toDateKey(sale.sale_date),
          sort_key: `S-${String(sale.id).padStart(8, "0")}-0`,
          transaction_type: "Sale",
          debit_amount: Number(sale.total_amount || 0),
          credit_amount: 0,
          balance_delta: Number(sale.total_amount || 0),
          remarks: sale.invoice_no || `Sale #${sale.id}`,
        });
        if (Number(sale.total_paid || 0) > 0) {
          pushEvent({
            customer_id: sale.customer_id,
            customer_name: sale.customer_name,
            transaction_date: toDateKey(sale.sale_date),
            sort_key: `S-${String(sale.id).padStart(8, "0")}-1`,
            transaction_type: "Sale Payment",
            debit_amount: 0,
            credit_amount: Number(sale.total_paid || 0),
            balance_delta: -Number(sale.total_paid || 0),
            remarks: `Payment for ${sale.invoice_no || `Sale #${sale.id}`}`,
          });
        }
      }
    }
    for (const payment of paymentResult.rows) {
      pushEvent({
        customer_id: payment.customer_id,
        customer_name: payment.customer_name,
        transaction_date: toDateKey(payment.payment_date),
        sort_key: `CP-${String(payment.id).padStart(8, "0")}`,
        transaction_type: "Customer Payment",
        debit_amount: 0,
        credit_amount: Number(payment.payment_amount || 0),
        balance_delta: -Number(payment.payment_amount || 0),
        remarks: payment.remarks || payment.reference_number || "Customer payment",
      });
    }
    const ledger = [];
    for (const customer of customers) {
      let runningBalance = 0;
      const rows = (ledgersByCustomer.get(customer.id) || []).sort((left, right) =>
        left.transaction_date.localeCompare(right.transaction_date) || left.sort_key.localeCompare(right.sort_key)
      );
      for (const row of rows) {
        runningBalance = roundCurrency(runningBalance + Number(row.balance_delta || 0));
        ledger.push({ ...row, running_balance: runningBalance });
      }
    }
    return res.json({ customers, ledger });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Customer Ledger" });
  }
});

app.get("/dashboard-metrics", async (req, res) => {
  try {
    return res.json(await getDashboardSummary());
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Dashboard Metrics" });
  }
});

app.get("/dashboard-analytics", async (req, res) => {
  try {
    return res.json(await getDashboardAnalyticsPayload(req.query));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Dashboard Analytics" });
  }
});

app.get("/dashboard-sales-trend", async (req, res) => {
  try {
    const { dateFrom, dateTo, days } = parseDashboardRange(req.query);
    return res.json({ dateFrom, dateTo, days, data: await getDashboardSalesTrend(dateFrom, dateTo) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Sales Trend" });
  }
});

app.get("/dashboard-profit-trend", async (req, res) => {
  try {
    const { dateFrom, dateTo, days } = parseDashboardRange(req.query);
    return res.json({ dateFrom, dateTo, days, data: await getDashboardProfitTrend(dateFrom, dateTo) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Profit Trend" });
  }
});

app.get("/dashboard-expense-trend", async (req, res) => {
  try {
    const { dateFrom, dateTo, days } = parseDashboardRange(req.query);
    return res.json({ dateFrom, dateTo, days, data: await getDashboardExpenseTrend(dateFrom, dateTo) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Expense Trend" });
  }
});

app.get("/reports/summary", async (req, res) => {
  try {
    const dateFrom = req.query.date_from || "1900-01-01";
    const dateTo = req.query.date_to || "2999-12-31";
    const [salesResult, purchaseResult, supplierRows, customerRows, discountResult] = await Promise.all([
      pool.query(
        `
        SELECT
          sale_date,
          COUNT(*)::INTEGER AS transaction_count,
          SUM(total_amount) AS total_sales,
          SUM(total_cost) AS total_cost,
          SUM(profit) AS total_profit
        FROM sales
        WHERE sale_status <> 'CANCELLED'
          AND sale_date BETWEEN $1 AND $2
        GROUP BY sale_date
        ORDER BY sale_date DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          purchase_date,
          COUNT(*)::INTEGER AS purchase_count,
          SUM(COALESCE(NULLIF(gross_amount, 0), total_amount, 0)) AS gross_purchase,
          SUM(COALESCE(rebate_amount, 0)) AS rebate_received,
          SUM(COALESCE(NULLIF(net_payable, 0), total_amount, 0)) AS net_purchase,
          SUM(COALESCE(paid_amount, 0)) AS paid_amount,
          SUM(COALESCE(balance_amount, 0)) AS balance_amount
        FROM purchases
        WHERE purchase_date BETWEEN $1 AND $2
        GROUP BY purchase_date
        ORDER BY purchase_date DESC
        `,
        [dateFrom, dateTo]
      ),
      getSupplierSummaryRows(),
      getCustomerSummaryRows(),
      pool.query(
        `
        SELECT
          sale_date,
          payment_mode,
          COUNT(*)::INTEGER AS invoice_count,
          SUM(COALESCE(item_discount_amount, 0) + COALESCE(invoice_discount_amount, 0)) AS total_discount,
          SUM(COALESCE(invoice_discount_amount, 0)) AS bill_discount,
          SUM(COALESCE(item_discount_amount, 0)) AS item_discount
        FROM sales
        WHERE sale_status <> 'CANCELLED'
          AND sale_date BETWEEN $1 AND $2
        GROUP BY sale_date, payment_mode
        ORDER BY sale_date DESC, payment_mode
        `,
        [dateFrom, dateTo]
      ),
    ]);
    return res.json({
      salesReport: salesResult.rows,
      purchaseReport: purchaseResult.rows,
      supplierOutstandingReport: supplierRows,
      customerOutstandingReport: customerRows,
      discountReport: discountResult.rows,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Reports" });
  }
});

app.get("/expenses", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT e.*, u.full_name AS created_by_name
      FROM expenses e
      LEFT JOIN users u ON u.id = e.created_by
      ORDER BY e.expense_date DESC, e.created_at DESC, e.id DESC
      `
    );
    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Expenses" });
  }
});

app.post("/expenses", async (req, res) => {
  try {
    const amount = parsePositiveNumber(req.body.amount);
    const category = cleanText(req.body.category);
    const paymentMode = normalizePaymentMode(req.body.payment_mode || "CASH");
    if (!category || !amount || !SUPPLIER_PAYMENT_MODES.has(paymentMode)) {
      return res.status(400).json({ message: "Enter valid expense details" });
    }
    const result = await pool.query(
      `
      INSERT INTO expenses (
        expense_date, category, amount, payment_mode, reference_number,
        vendor_name, remarks, branch_id, created_by, active
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
      `,
      [
        req.body.expense_date || toDateKey(new Date()), category, amount, paymentMode,
        nullableText(req.body.reference_number), nullableText(req.body.vendor_name),
        nullableText(req.body.remarks), parsePositiveInteger(req.body.branch_id),
        parsePositiveInteger(req.body.created_by) || 1, req.body.active !== false,
      ]
    );
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Saving Expense" });
  }
});

app.put("/expenses/:id", async (req, res) => {
  try {
    const expenseId = parsePositiveInteger(req.params.id);
    const amount = parsePositiveNumber(req.body.amount);
    const category = cleanText(req.body.category);
    const paymentMode = normalizePaymentMode(req.body.payment_mode || "CASH");
    if (!expenseId || !category || !amount || !SUPPLIER_PAYMENT_MODES.has(paymentMode)) {
      return res.status(400).json({ message: "Enter valid expense details" });
    }
    const result = await pool.query(
      `
      UPDATE expenses
      SET expense_date = $1, category = $2, amount = $3, payment_mode = $4,
          reference_number = $5, vendor_name = $6, remarks = $7,
          branch_id = $8, active = $9, updated_at = CURRENT_TIMESTAMP
      WHERE id = $10
      RETURNING *
      `,
      [
        req.body.expense_date || toDateKey(new Date()), category, amount, paymentMode,
        nullableText(req.body.reference_number), nullableText(req.body.vendor_name),
        nullableText(req.body.remarks), parsePositiveInteger(req.body.branch_id),
        req.body.active !== false, expenseId,
      ]
    );
    return result.rows[0] ? res.json(result.rows[0]) : res.status(404).json({ message: "Expense not found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating Expense" });
  }
});

app.get("/supplier-payments", async (req, res) => {
  try {
    const supplierId = req.query.supplier_id ? parsePositiveInteger(req.query.supplier_id) : null;
    if (req.query.supplier_id && !supplierId) return res.status(400).json({ message: "Invalid supplier" });
    const values = supplierId ? [supplierId] : [];
    const result = await pool.query(
      `
      SELECT sp.*, s.supplier_name, s.firm_name
      FROM supplier_payments sp
      JOIN suppliers s ON s.id = sp.supplier_id
      ${supplierId ? "WHERE sp.supplier_id = $1" : ""}
      ORDER BY sp.payment_date DESC, sp.created_at DESC, sp.id DESC
      `,
      values
    );
    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Supplier Payments" });
  }
});

app.post("/supplier-payments", async (req, res) => {
  try {
    const supplierId = parsePositiveInteger(req.body.supplier_id);
    const paymentAmount = parseNonNegativeNumber(req.body.payment_amount);
    const rebateAmount = parseNonNegativeNumber(req.body.rebate_received ?? req.body.rebate_amount);
    const paymentMode = normalizePaymentMode(req.body.payment_mode);
    const branchId = parsePositiveInteger(req.body.branch_id);
    const createdBy = parsePositiveInteger(req.body.created_by) || 1;
    const paymentDate = req.body.payment_date || toDateKey(new Date());

    if (
      !supplierId ||
      paymentAmount === null ||
      rebateAmount === null ||
      paymentAmount + rebateAmount <= 0 ||
      !SUPPLIER_PAYMENT_MODES.has(paymentMode)
    ) {
      return res.status(400).json({ message: "Enter valid supplier payment details" });
    }

    const supplierResult = await pool.query("SELECT id FROM suppliers WHERE id = $1 AND active = TRUE", [supplierId]);
    if (supplierResult.rows.length === 0) {
      return res.status(400).json({ message: "Select an active supplier account" });
    }

    const result = await pool.query(
      `
      INSERT INTO supplier_payments (
        supplier_id, payment_date, payment_amount, rebate_amount, payment_mode,
        reference_number, remarks, branch_id, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
      `,
      [
        supplierId, paymentDate, paymentAmount, rebateAmount, paymentMode,
        nullableText(req.body.reference_number), nullableText(req.body.remarks), branchId, createdBy,
      ]
    );
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Saving Supplier Payment" });
  }
});

app.put("/supplier-payments/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const paymentId = parsePositiveInteger(req.params.id);
    const supplierId = parsePositiveInteger(req.body.supplier_id);
    const paymentAmount = parseNonNegativeNumber(req.body.payment_amount);
    const rebateAmount = parseNonNegativeNumber(req.body.rebate_received ?? req.body.rebate_amount);
    const paymentMode = normalizePaymentMode(req.body.payment_mode);
    const editedBy = parsePositiveInteger(req.body.edited_by) || parsePositiveInteger(req.body.created_by) || 1;
    const reason = cleanText(req.body.reason);
    const paymentDate = req.body.payment_date || toDateKey(new Date());
    if (!paymentId || !supplierId || paymentAmount === null || rebateAmount === null || paymentAmount + rebateAmount <= 0 || !SUPPLIER_PAYMENT_MODES.has(paymentMode) || !reason) {
      return res.status(400).json({ message: "Enter valid supplier payment edit details and reason" });
    }
    await client.query("BEGIN");
    const oldResult = await client.query("SELECT * FROM supplier_payments WHERE id = $1 FOR UPDATE", [paymentId]);
    const oldPayment = oldResult.rows[0];
    if (!oldPayment) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Supplier payment not found" });
    }
    if (oldPayment.cancelled) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Cancelled supplier payments cannot be edited" });
    }
    const supplierResult = await client.query("SELECT id FROM suppliers WHERE id = $1 AND active = TRUE", [supplierId]);
    if (supplierResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Select an active supplier account" });
    }
    const result = await client.query(
      `
      UPDATE supplier_payments
      SET supplier_id = $1, payment_date = $2, payment_amount = $3, rebate_amount = $4,
          payment_mode = $5, reference_number = $6, remarks = $7, branch_id = $8,
          edited_by = $9, edited_at = CURRENT_TIMESTAMP, edit_reason = $10
      WHERE id = $11
      RETURNING *
      `,
      [
        supplierId, paymentDate, paymentAmount, rebateAmount, paymentMode,
        nullableText(req.body.reference_number), nullableText(req.body.remarks),
        parsePositiveInteger(req.body.branch_id), editedBy, reason, paymentId,
      ]
    );
    await client.query(
      `
      INSERT INTO supplier_payment_audit (supplier_payment_id, action, old_value, new_value, reason, edited_by)
      VALUES ($1, 'EDIT', $2::jsonb, $3::jsonb, $4, $5)
      `,
      [paymentId, JSON.stringify(oldPayment), JSON.stringify(result.rows[0]), reason, editedBy]
    );
    await client.query("COMMIT");
    return res.json(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Updating Supplier Payment" });
  } finally {
    client.release();
  }
});

app.post("/supplier-payments/:id/cancel", async (req, res) => {
  const client = await pool.connect();
  try {
    const paymentId = parsePositiveInteger(req.params.id);
    const cancelledBy = parsePositiveInteger(req.body.cancelled_by) || 1;
    const reason = cleanText(req.body.reason);
    if (!paymentId || !reason) return res.status(400).json({ message: "Cancellation reason is required" });
    await client.query("BEGIN");
    const oldResult = await client.query("SELECT * FROM supplier_payments WHERE id = $1 FOR UPDATE", [paymentId]);
    const oldPayment = oldResult.rows[0];
    if (!oldPayment) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Supplier payment not found" });
    }
    if (oldPayment.cancelled) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Supplier payment is already cancelled" });
    }
    const result = await client.query(
      `
      UPDATE supplier_payments
      SET cancelled = TRUE, cancelled_by = $1, cancelled_at = CURRENT_TIMESTAMP, cancellation_reason = $2
      WHERE id = $3
      RETURNING *
      `,
      [cancelledBy, reason, paymentId]
    );
    await client.query(
      `
      INSERT INTO supplier_payment_audit (supplier_payment_id, action, old_value, new_value, reason, edited_by)
      VALUES ($1, 'CANCEL', $2::jsonb, $3::jsonb, $4, $5)
      `,
      [paymentId, JSON.stringify(oldPayment), JSON.stringify(result.rows[0]), reason, cancelledBy]
    );
    await client.query("COMMIT");
    return res.json({ success: true, payment: result.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Cancelling Supplier Payment" });
  } finally {
    client.release();
  }
});

app.get("/supplier-ledger", async (req, res) => {
  try {
    const supplierId = req.query.supplier_id ? parsePositiveInteger(req.query.supplier_id) : null;
    if (req.query.supplier_id && !supplierId) return res.status(400).json({ message: "Invalid supplier" });

    const suppliers = await getSupplierSummaryRows({ supplierId });
    if (supplierId && suppliers.length === 0) return res.status(404).json({ message: "Supplier not found" });
    if (suppliers.length === 0) return res.json({ suppliers: [], ledger: [] });

    const supplierIds = suppliers.map((supplier) => supplier.id);
    const [purchaseResult, paymentResult] = await Promise.all([
      pool.query(
        `
        SELECT
          p.id,
          p.supplier_id,
          p.supplier_name,
          p.purchase_date,
          p.created_at,
          COALESCE(NULLIF(p.gross_amount, 0), p.total_amount, 0) AS gross_amount,
          COALESCE(p.rebate_amount, 0) AS rebate_amount,
          COALESCE(NULLIF(p.net_payable, 0), p.total_amount, 0) AS net_payable,
          COALESCE(p.paid_amount, 0) AS paid_amount,
          p.payment_date,
          p.payment_status,
          p.payment_timing,
          STRING_AGG(pr.product_name || ' x ' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM pi.quantity::TEXT)), ', ' ORDER BY pi.id) AS item_summary
        FROM purchases p
        LEFT JOIN purchase_items pi ON pi.purchase_id = p.id
        LEFT JOIN products pr ON pr.id = pi.product_id
        WHERE p.supplier_id = ANY($1::INT[])
        GROUP BY p.id
        ORDER BY p.purchase_date, p.created_at, p.id
        `,
        [supplierIds]
      ),
      pool.query(
        `
        SELECT sp.*, s.supplier_name
        FROM supplier_payments sp
        JOIN suppliers s ON s.id = sp.supplier_id
        WHERE sp.supplier_id = ANY($1::INT[])
          AND sp.cancelled = FALSE
        ORDER BY sp.payment_date, sp.created_at, sp.id
        `,
        [supplierIds]
      ),
    ]);

    const ledgersBySupplier = new Map(supplierIds.map((id) => [id, []]));
    const pushEvent = (event) => {
      if (!ledgersBySupplier.has(event.supplier_id)) ledgersBySupplier.set(event.supplier_id, []);
      ledgersBySupplier.get(event.supplier_id).push(event);
    };

    for (const supplier of suppliers) {
      if (Number(supplier.opening_balance) > 0) {
        pushEvent({
          supplier_id: supplier.id,
          supplier_name: supplier.supplier_name,
          transaction_date: toDateKey(supplier.created_at),
          sort_date: toDateKey(supplier.created_at),
          sort_key: `0000-${supplier.id}`,
          transaction_type: "Opening Balance",
          purchase_amount: 0,
          payment_amount: 0,
          rebate_amount: 0,
          balance_delta: Number(supplier.opening_balance),
          remarks: "Opening supplier payable balance",
        });
      }
    }

    for (const purchase of purchaseResult.rows) {
      const grossAmount = Number(purchase.gross_amount || 0);
      const rebateAmount = Number(purchase.rebate_amount || 0);
      const paidAmount = Number(purchase.paid_amount || 0);
      pushEvent({
        supplier_id: purchase.supplier_id,
        supplier_name: purchase.supplier_name,
        transaction_date: toDateKey(purchase.purchase_date),
        sort_date: toDateKey(purchase.purchase_date),
        sort_key: `P-${String(purchase.id).padStart(8, "0")}-0`,
        transaction_type: "Purchase",
        purchase_id: purchase.id,
        purchase_amount: grossAmount,
        payment_amount: 0,
        rebate_amount: rebateAmount,
        balance_delta: roundCurrency(grossAmount - rebateAmount),
        remarks: `${purchase.item_summary || "Purchase"}${purchase.payment_timing ? ` - ${purchase.payment_timing}` : ""}`,
      });
      if (paidAmount > 0) {
        const paidDate = purchase.payment_date || purchase.purchase_date;
        pushEvent({
          supplier_id: purchase.supplier_id,
          supplier_name: purchase.supplier_name,
          transaction_date: toDateKey(paidDate),
          sort_date: toDateKey(paidDate),
          sort_key: `P-${String(purchase.id).padStart(8, "0")}-1`,
          transaction_type: "Payment",
          purchase_id: purchase.id,
          purchase_amount: 0,
          payment_amount: paidAmount,
          rebate_amount: 0,
          balance_delta: -paidAmount,
          remarks: `Paid during purchase #${purchase.id}`,
        });
      }
    }

    for (const payment of paymentResult.rows) {
      const paymentAmount = Number(payment.payment_amount || 0);
      const rebateAmount = Number(payment.rebate_amount || 0);
      if (paymentAmount > 0) {
        pushEvent({
          supplier_id: payment.supplier_id,
          supplier_name: payment.supplier_name,
          transaction_date: toDateKey(payment.payment_date),
          sort_date: toDateKey(payment.payment_date),
          sort_key: `SP-${String(payment.id).padStart(8, "0")}-0`,
          transaction_type: "Payment",
          supplier_payment_id: payment.id,
          purchase_amount: 0,
          payment_amount: paymentAmount,
          rebate_amount: 0,
          balance_delta: -paymentAmount,
          remarks: payment.remarks || payment.reference_number || "Supplier payment",
        });
      }
      if (rebateAmount > 0) {
        pushEvent({
          supplier_id: payment.supplier_id,
          supplier_name: payment.supplier_name,
          transaction_date: toDateKey(payment.payment_date),
          sort_date: toDateKey(payment.payment_date),
          sort_key: `SP-${String(payment.id).padStart(8, "0")}-1`,
          transaction_type: "Rebate",
          supplier_payment_id: payment.id,
          purchase_amount: 0,
          payment_amount: 0,
          rebate_amount: rebateAmount,
          balance_delta: -rebateAmount,
          remarks: payment.remarks || payment.reference_number || "Rebate received",
        });
      }
    }

    const ledger = [];
    for (const supplier of suppliers) {
      let runningBalance = 0;
      const rows = (ledgersBySupplier.get(supplier.id) || []).sort((left, right) =>
        left.sort_date.localeCompare(right.sort_date) || left.sort_key.localeCompare(right.sort_key)
      );
      for (const row of rows) {
        runningBalance = roundCurrency(runningBalance + Number(row.balance_delta || 0));
        ledger.push({
          ...row,
          running_balance: runningBalance,
        });
      }
    }

    return res.json({ suppliers, ledger });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Supplier Ledger" });
  }
});

app.post("/purchase", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      supplier_id,
      product_id,
      quantity,
      purchase_rate,
      freight_charges,
      labour_charges,
      other_charges,
      paid_amount,
      rebate_rule_id,
      payment_date,
      purchase_type,
      payment_mode,
      payment_reference_number,
      branch_id,
      created_by,
    } = req.body;
    const parsedSupplierId = parsePositiveInteger(supplier_id);
    const parsedProductId = parsePositiveInteger(product_id);
    const parsedQuantity = parsePositiveNumber(quantity);
    const parsedPurchaseRate = parsePositiveNumber(purchase_rate);
    const parsedFreightCharges = parseNonNegativeNumber(freight_charges);
    const parsedLabourCharges = parseNonNegativeNumber(labour_charges);
    const parsedOtherCharges = parseNonNegativeNumber(other_charges);
    const purchaseType = String(purchase_type || "CREDIT").trim().toUpperCase();
    const parsedPaidAmountInput = parseNonNegativeNumber(paid_amount);
    const purchasePaymentMode = normalizePaymentMode(payment_mode);
    const parsedRebateRuleId = parsePositiveInteger(rebate_rule_id);
    const parsedBranchId = parsePositiveInteger(branch_id);
    const parsedCreatedBy = parsePositiveInteger(created_by) || 1;

    if (!parsedSupplierId) {
      return res.status(400).json({ message: "Add New Supplier" });
    }

    if (
      !parsedProductId ||
      !parsedQuantity ||
      !parsedPurchaseRate ||
      parsedFreightCharges === null ||
      parsedLabourCharges === null ||
      parsedOtherCharges === null ||
      parsedPaidAmountInput === null ||
      !parsedRebateRuleId ||
      !parsedBranchId ||
      !["CASH", "CREDIT"].includes(purchaseType)
    ) {
      return res.status(400).json({ message: "Enter valid purchase details" });
    }
    if (purchaseType === "CASH" && (!SUPPLIER_PAYMENT_MODES.has(purchasePaymentMode) || parsedPaidAmountInput <= 0)) {
      return res.status(400).json({ message: "Cash purchase requires payment mode and paid amount" });
    }

    await client.query("BEGIN");
    const supplierResult = await client.query(
      "SELECT id, supplier_name FROM suppliers WHERE id = $1 AND active = TRUE FOR SHARE",
      [parsedSupplierId]
    );
    if (supplierResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Add New Supplier" });
    }
    const supplier = supplierResult.rows[0];

    const productResult = await client.query(
      "SELECT id, product_name, origin_type FROM products WHERE id = $1 AND active = TRUE FOR SHARE",
      [parsedProductId]
    );
    if (productResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Product not found" });
    }

    const product = productResult.rows[0];
    const originType = product.origin_type || "LOCAL";
    const [mandiResult, rebateResult] = await Promise.all([
      client.query("SELECT * FROM mandi_tax_rules WHERE origin_type = $1 AND active = TRUE", [originType]),
      client.query("SELECT * FROM rebate_rules WHERE id = $1 AND active = TRUE", [parsedRebateRuleId]),
    ]);
    if (mandiResult.rows.length === 0 || rebateResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Select active mandi tax and rebate rules" });
    }
    const mandiTaxPercent = Number(mandiResult.rows[0].tax_percent);
    const rebateRule = rebateResult.rows[0];
    const rebatePercent = Number(rebateRule.rebate_percent);
    const basicAmount = roundCurrency(parsedQuantity * parsedPurchaseRate);
    const mandiTaxAmount = roundCurrency(basicAmount * mandiTaxPercent / 100);
    const grossAmount = roundCurrency(basicAmount + mandiTaxAmount + parsedFreightCharges + parsedLabourCharges + parsedOtherCharges);
    const rebateAmount = roundCurrency(grossAmount * rebatePercent / 100);
    const netPayable = roundCurrency(grossAmount - rebateAmount);
    const parsedPaidAmount = purchaseType === "CREDIT" ? 0 : parsedPaidAmountInput;
    if (parsedPaidAmount > netPayable) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Paid amount cannot exceed net payable amount" });
    }
    const balanceAmount = roundCurrency(netPayable - parsedPaidAmount);
    const effectiveCostPerUnit = roundUnitCost(netPayable / parsedQuantity);
    const paymentStatus = balanceAmount === 0 ? "PAID" : parsedPaidAmount > 0 ? "PARTIAL" : "PENDING";

    const purchaseResult = await client.query(
      `
      INSERT INTO purchases (
        supplier_id, supplier_name, total_amount, branch_id, created_by, basic_amount,
        mandi_tax_percent, mandi_tax_amount, other_charges, gross_amount,
        rebate_percent, rebate_amount, net_payable, paid_amount, balance_amount,
        payment_timing, effective_cost_per_unit, freight_charges, labour_charges,
        rebate_rule_id, payment_due_days, payment_status, payment_date,
        purchase_type, payment_mode, payment_reference_number
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
      RETURNING *
      `,
      [
        supplier.id, supplier.supplier_name, netPayable, parsedBranchId, parsedCreatedBy, basicAmount,
        mandiTaxPercent, mandiTaxAmount, parsedOtherCharges, grossAmount,
        rebatePercent, rebateAmount, netPayable, parsedPaidAmount, balanceAmount,
        rebateRule.rule_name, effectiveCostPerUnit, parsedFreightCharges, parsedLabourCharges,
        rebateRule.id, rebateRule.pay_within_days, paymentStatus, purchaseType === "CREDIT" ? null : payment_date || null,
        purchaseType, purchaseType === "CASH" ? purchasePaymentMode : null, purchaseType === "CASH" ? nullableText(payment_reference_number) : null,
      ]
    );
    const purchase = purchaseResult.rows[0];

    await client.query(
      `
      INSERT INTO purchase_items (
        purchase_id, product_id, quantity, purchase_rate, amount, basic_amount,
        mandi_tax_amount, other_charges, rebate_amount, net_payable, effective_cost_per_unit,
        freight_charges, labour_charges
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      `,
      [
        purchase.id, parsedProductId, parsedQuantity, parsedPurchaseRate, netPayable, basicAmount,
        mandiTaxAmount, parsedOtherCharges, rebateAmount, netPayable, effectiveCostPerUnit,
        parsedFreightCharges, parsedLabourCharges,
      ]
    );

    const batchNo = `BATCH-${Date.now()}-${purchase.id}`;
    await client.query(
      `
      INSERT INTO inventory_batches (
        product_id, batch_no, purchase_qty, remaining_qty, purchase_rate, effective_cost_per_unit,
        supplier_id, supplier_name, branch_id, mandi_tax_amount, freight_charges, labour_charges,
        other_charges, gross_amount, rebate_amount, net_payable, payment_timing, balance_amount
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      `,
      [
        parsedProductId,
        batchNo,
        parsedQuantity,
        parsedQuantity,
        parsedPurchaseRate,
        effectiveCostPerUnit,
        supplier.id,
        supplier.supplier_name,
        parsedBranchId,
        mandiTaxAmount,
        parsedFreightCharges,
        parsedLabourCharges,
        parsedOtherCharges,
        grossAmount,
        rebateAmount,
        netPayable,
        rebateRule.rule_name,
        balanceAmount,
      ]
    );

    await client.query(
      `
      INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id)
      VALUES ($1, $2, 'IN', $3, $4, $5)
      `,
      [parsedProductId, parsedQuantity, `Purchase #${purchase.id}`, parsedCreatedBy, parsedBranchId]
    );

    await client.query("COMMIT");
    return res.status(201).json({
      success: true,
      message: "Purchase Saved",
      purchase_id: purchase.id,
      purchase: {
        ...purchase,
        supplier_name: supplier.supplier_name,
        product_name: product.product_name,
        origin_type: originType,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Purchase Error" });
  } finally {
    client.release();
  }
});

app.post("/sales", async (req, res) => {
  const client = await pool.connect();

  try {
    const { product_id, quantity, branch_id, created_by, customer, invoice_discount, payments } = req.body;
    const parsedBranchId = parsePositiveInteger(branch_id);
    const parsedCreatedBy = parsePositiveInteger(created_by) || 1;
    const parsedInvoiceDiscount = parseNonNegativeNumber(invoice_discount);
    const requestedItems = Array.isArray(req.body.items)
      ? req.body.items
      : [{ product_id, quantity, discount_amount: 0 }];
    const parsedItems = requestedItems.map((item) => ({
      productId: parsePositiveInteger(item.product_id),
      quantity: parsePositiveNumber(item.quantity),
      discountAmount: parseNonNegativeNumber(item.discount_amount),
    }));
    const customerName = customer?.name?.trim() || null;
    const customerMobile = customer?.mobile?.trim() || null;
    const customerNotes = customer?.notes?.trim() || null;

    if (
      !parsedBranchId ||
      parsedInvoiceDiscount === null ||
      parsedItems.length === 0 ||
      parsedItems.some((item) => !item.productId || !item.quantity || item.discountAmount === null)
    ) {
      return res.status(400).json({ message: "Add valid products and quantities before checkout" });
    }
    if (new Set(parsedItems.map((item) => item.productId)).size !== parsedItems.length) {
      return res.status(400).json({ message: "Combine duplicate products into one cart item" });
    }
    if (customerMobile && !/^\d{10,15}$/.test(customerMobile)) {
      return res.status(400).json({ message: "Enter a valid customer mobile number" });
    }

    await client.query("BEGIN");

    const productIds = parsedItems.map((item) => item.productId);
    const productResult = await client.query(
      "SELECT id, product_name, selling_rate, unit FROM products WHERE id = ANY($1::int[]) AND active = TRUE ORDER BY id FOR SHARE",
      [productIds]
    );
    if (productResult.rows.length !== parsedItems.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "One or more products could not be found" });
    }

    const productsById = new Map(productResult.rows.map((product) => [product.id, product]));
    const invoiceItems = [];
    let grossAmount = 0;
    let itemDiscountAmount = 0;
    let totalCost = 0;
    for (const requestedItem of parsedItems) {
      const product = productsById.get(requestedItem.productId);
      const sellingRate = Number(product.selling_rate);
      if (!Number.isFinite(sellingRate) || sellingRate <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: `${product.product_name} does not have a valid selling rate` });
      }

      const itemGross = roundCurrency(requestedItem.quantity * sellingRate);
      if (requestedItem.discountAmount > itemGross) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: `Discount cannot exceed the value of ${product.product_name}` });
      }

      const batchesResult = await client.query(
        `
        SELECT id, remaining_qty, COALESCE(effective_cost_per_unit, purchase_rate) AS purchase_rate
        FROM inventory_batches
        WHERE product_id = $1
          AND branch_id = $2
          AND remaining_qty > 0
        ORDER BY purchase_date, created_at, id
        FOR UPDATE
        `,
        [requestedItem.productId, parsedBranchId]
      );

      const availableStock = batchesResult.rows.reduce(
        (total, batch) => total + Number(batch.remaining_qty),
        0
      );
      if (availableStock < requestedItem.quantity) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          message: `Insufficient stock for ${product.product_name}. Available quantity: ${availableStock}`,
          product_id: requestedItem.productId,
          available_stock: availableStock,
        });
      }

      let quantityToDeduct = requestedItem.quantity;
      let itemCost = 0;
      const allocations = [];
      for (const batch of batchesResult.rows) {
        if (quantityToDeduct <= 0) break;

        const deductedQuantity = Math.min(quantityToDeduct, Number(batch.remaining_qty));
        const costAmount = roundCurrency(deductedQuantity * Number(batch.purchase_rate));
        await client.query(
          "UPDATE inventory_batches SET remaining_qty = remaining_qty - $1 WHERE id = $2",
          [deductedQuantity, batch.id]
        );
        allocations.push({
          inventoryBatchId: batch.id,
          quantity: deductedQuantity,
          purchaseRate: Number(batch.purchase_rate),
          costAmount,
        });
        quantityToDeduct -= deductedQuantity;
        itemCost += costAmount;
      }

      invoiceItems.push({
        ...requestedItem,
        product,
        sellingRate,
        grossAmount: itemGross,
        netAmount: roundCurrency(itemGross - requestedItem.discountAmount),
        costAmount: roundCurrency(itemCost),
        allocations,
      });
      grossAmount += itemGross;
      itemDiscountAmount += requestedItem.discountAmount;
      totalCost += itemCost;
    }

    grossAmount = roundCurrency(grossAmount);
    itemDiscountAmount = roundCurrency(itemDiscountAmount);
    totalCost = roundCurrency(totalCost);
    const subtotalAfterItemDiscounts = roundCurrency(grossAmount - itemDiscountAmount);

    const requestedPaymentsInput = Array.isArray(payments) && payments.length > 0 ? payments : null;
    const allowedPaymentModes = new Set(["CASH", "UPI", "CARD"]);
    const paymentModes = requestedPaymentsInput
      ? requestedPaymentsInput.map((payment) => String(payment.mode || "").toUpperCase())
      : ["CASH"];
    if (paymentModes.some((mode) => !allowedPaymentModes.has(mode))) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Select a valid payment mode" });
    }
    const paymentMode = paymentModes.length > 1 ? "MIXED" : paymentModes[0];
    const discountRule = await getMatchingDiscountRule(client, subtotalAfterItemDiscounts, paymentMode);
    const automaticInvoiceDiscount = calculateInvoiceDiscount(discountRule, subtotalAfterItemDiscounts);
    const invoiceDiscountAmount = discountRule ? automaticInvoiceDiscount : parsedInvoiceDiscount;

    if (invoiceDiscountAmount > subtotalAfterItemDiscounts) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Invoice discount cannot exceed the cart subtotal" });
    }

    const taxAmount = 0;
    const totalAmount = roundCurrency(subtotalAfterItemDiscounts - invoiceDiscountAmount + taxAmount);
    const profit = roundCurrency(totalAmount - totalCost);
    const requestedPayments = requestedPaymentsInput || [{ mode: "CASH", amount: totalAmount }];
    const parsedPayments = requestedPayments.map((payment) => ({
      mode: String(payment.mode || "").toUpperCase(),
      amount: parsePositiveNumber(payment.amount),
    }));
    const paidAmount = roundCurrency(parsedPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0));
    if (
      parsedPayments.some((payment) => !allowedPaymentModes.has(payment.mode) || !payment.amount) ||
      Math.abs(paidAmount - totalAmount) > 0.01
    ) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Payment amounts must match the invoice total" });
    }

    const saleResult = await client.query(
      `
      INSERT INTO sales (
        total_amount, total_cost, profit, branch_id, created_by,
        customer_name, customer_mobile, customer_notes, payment_mode,
        gross_amount, item_discount_amount, invoice_discount_amount, tax_amount,
        discount_rule_id, discount_rule_name, discount_rule_type, discount_rule_value,
        discount_rule_payment_mode
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      RETURNING *
      `,
      [
        totalAmount, totalCost, profit, parsedBranchId, parsedCreatedBy,
        customerName, customerMobile, customerNotes, paymentMode,
        grossAmount, itemDiscountAmount, invoiceDiscountAmount, taxAmount,
        discountRule?.id || null,
        discountRule?.rule_name || null,
        discountRule?.discount_type || null,
        discountRule?.discount_value || 0,
        discountRule?.payment_mode || null,
      ]
    );
    const sale = saleResult.rows[0];
    const invoiceNo = `FZ-${toDateKey(sale.sale_date).replaceAll("-", "")}-${String(sale.id).padStart(6, "0")}`;
    await client.query(
      "UPDATE sales SET invoice_no = $1 WHERE id = $2",
      [invoiceNo, sale.id]
    );

    for (const item of invoiceItems) {
      const invoiceDiscountShare = subtotalAfterItemDiscounts === 0
        ? 0
        : roundCurrency(invoiceDiscountAmount * (item.netAmount / subtotalAfterItemDiscounts));
      const itemProfit = roundCurrency(item.netAmount - invoiceDiscountShare - item.costAmount);
      const saleItemResult = await client.query(
        `
        INSERT INTO sale_items (
          sale_id, product_id, quantity, selling_rate, amount, discount_amount, net_amount, cost_amount, profit
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id
        `,
        [
          sale.id, item.productId, item.quantity, item.sellingRate, item.grossAmount,
          item.discountAmount, item.netAmount, item.costAmount, itemProfit,
        ]
      );
      const saleItemId = saleItemResult.rows[0].id;

      for (const allocation of item.allocations) {
        await client.query(
          `
          INSERT INTO sale_batch_allocations (
            sale_item_id, inventory_batch_id, quantity, purchase_rate, cost_amount
          )
          VALUES ($1, $2, $3, $4, $5)
          `,
          [
            saleItemId,
            allocation.inventoryBatchId,
            allocation.quantity,
            allocation.purchaseRate,
            allocation.costAmount,
          ]
        );
      }

      await client.query(
        `
        INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id)
        VALUES ($1, $2, 'OUT', $3, $4, $5)
        `,
        [item.productId, item.quantity, `Invoice ${invoiceNo}`, parsedCreatedBy, parsedBranchId]
      );
    }

    for (const payment of parsedPayments) {
      await client.query(
        "INSERT INTO sale_payments (sale_id, payment_mode, amount) VALUES ($1, $2, $3)",
        [sale.id, payment.mode, payment.amount]
      );
    }

    await insertCustomerLedgerEntry(
      client,
      { ...sale, customer_name: customerName, customer_mobile: customerMobile },
      "SALE",
      totalAmount,
      parsedCreatedBy,
      `Invoice ${invoiceNo}`
    );

    await client.query("COMMIT");
    return res.status(201).json({
      success: true,
      message: "Invoice Saved",
      sale: {
        ...sale,
        invoice_no: invoiceNo,
        discount_rule: discountRule,
        items: invoiceItems.map((item) => ({
          product_id: item.productId,
          product_name: item.product.product_name,
          unit: item.product.unit,
          quantity: item.quantity,
          selling_rate: item.sellingRate,
          amount: item.grossAmount,
          discount_amount: item.discountAmount,
          net_amount: item.netAmount,
        })),
        payments: parsedPayments,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Sale Error" });
  } finally {
    client.release();
  }
});

app.get("/sales", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        s.id,
        s.invoice_no,
        s.sale_date,
        s.created_at,
        s.customer_name,
        s.customer_mobile,
        s.payment_mode,
        s.sale_status,
        s.cancelled_at,
        s.cancellation_reason,
        s.edited_at,
        s.edit_reason,
        s.gross_amount,
        s.item_discount_amount,
        s.invoice_discount_amount,
        s.discount_rule_id,
        s.discount_rule_name,
        s.discount_rule_type,
        s.discount_rule_value,
        s.discount_rule_payment_mode,
        s.tax_amount,
        s.total_amount AS amount,
        s.total_cost AS cost_amount,
        s.profit,
        COUNT(si.id)::INTEGER AS item_count,
        COALESCE(
          STRING_AGG(p.product_name || ' x ' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM si.quantity::TEXT)), ', ' ORDER BY si.id),
          'No active items'
        ) AS item_summary
      FROM sales s
      LEFT JOIN sale_items si ON si.sale_id = s.id
      LEFT JOIN products p ON p.id = si.product_id
      GROUP BY s.id
      ORDER BY s.created_at DESC, s.id DESC
    `);

    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Sales History" });
  }
});

app.get("/sales-report/changes", async (req, res) => {
  try {
    const [editedResult, cancelledResult, totalsResult] = await Promise.all([
      pool.query(
        `
        SELECT
          s.id, s.invoice_no, s.sale_date, s.total_amount, s.edited_at, s.edit_reason,
          u.full_name AS edited_by_name, s.customer_name, s.customer_mobile
        FROM sales s
        LEFT JOIN users u ON u.id = s.edited_by
        WHERE s.sale_status = 'EDITED'
        ORDER BY s.edited_at DESC NULLS LAST, s.id DESC
        `
      ),
      pool.query(
        `
        SELECT
          s.id, s.invoice_no, s.sale_date, s.total_amount, s.cancelled_at, s.cancellation_reason,
          u.full_name AS cancelled_by_name, s.customer_name, s.customer_mobile
        FROM sales s
        LEFT JOIN users u ON u.id = s.cancelled_by
        WHERE s.sale_status = 'CANCELLED'
        ORDER BY s.cancelled_at DESC NULLS LAST, s.id DESC
        `
      ),
      pool.query("SELECT COALESCE(SUM(total_amount), 0) AS total_cancelled_amount FROM sales WHERE sale_status = 'CANCELLED'"),
    ]);
    return res.json({
      editedBills: editedResult.rows,
      cancelledBills: cancelledResult.rows,
      totalCancelledAmount: Number(totalsResult.rows[0]?.total_cancelled_amount || 0),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Sale Change Report" });
  }
});

app.get("/sales/:id/audit", async (req, res) => {
  try {
    const saleId = parsePositiveInteger(req.params.id);
    if (!saleId) return res.status(400).json({ message: "Invalid invoice" });
    const result = await pool.query(
      `
      SELECT sat.*, u.full_name AS edited_by_name
      FROM sale_audit_trail sat
      LEFT JOIN users u ON u.id = sat.edited_by
      WHERE sat.sale_id = $1
      ORDER BY sat.edited_at DESC, sat.id DESC
      `,
      [saleId]
    );
    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Sale Change History" });
  }
});

app.put("/sales/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const saleId = parsePositiveInteger(req.params.id);
    const reason = cleanText(req.body.reason);
    const editor = await getSalePermissionUser(req.body.edited_by, "edit", client);
    if (!saleId) return res.status(400).json({ message: "Invalid invoice" });
    if (!reason) return res.status(400).json({ message: "Edit reason is required" });
    if (!editor) return res.status(403).json({ message: "You do not have permission to edit completed sales" });

    await client.query("BEGIN");
    const saleLockResult = await client.query("SELECT * FROM sales WHERE id = $1 FOR UPDATE", [saleId]);
    const currentSale = saleLockResult.rows[0];
    if (!currentSale) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Invoice not found" });
    }
    if (currentSale.sale_status === "CANCELLED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Cancelled invoices cannot be edited" });
    }

    const oldSnapshot = await getSaleSnapshot(client, saleId);
    await restoreSaleInventory(client, saleId, editor.id, "Edit reversal for invoice", "IN");
    await client.query("DELETE FROM sale_batch_allocations WHERE sale_item_id IN (SELECT id FROM sale_items WHERE sale_id = $1)", [saleId]);
    await client.query("DELETE FROM sale_items WHERE sale_id = $1", [saleId]);
    await client.query("DELETE FROM sale_payments WHERE sale_id = $1", [saleId]);

    const salePayload = await buildSalePayload(client, {
      items: req.body.items,
      branchId: parsePositiveInteger(req.body.branch_id) || currentSale.branch_id,
      createdBy: editor.id,
      customer: req.body.customer,
      invoiceDiscount: req.body.invoice_discount,
      payments: req.body.payments,
      allowRateOverride: editor.role_name === "Owner",
    });
    if (salePayload.error) {
      await client.query("ROLLBACK");
      return res.status(salePayload.error.status).json(salePayload.error);
    }

    const updateResult = await client.query(
      `
      UPDATE sales
      SET
        total_amount = $1,
        total_cost = $2,
        profit = $3,
        branch_id = $4,
        customer_name = $5,
        customer_mobile = $6,
        customer_notes = $7,
        payment_mode = $8,
        gross_amount = $9,
        item_discount_amount = $10,
        invoice_discount_amount = $11,
        tax_amount = $12,
        discount_rule_id = $13,
        discount_rule_name = $14,
        discount_rule_type = $15,
        discount_rule_value = $16,
        discount_rule_payment_mode = $17,
        sale_status = 'EDITED',
        edited_by = $18,
        edited_at = CURRENT_TIMESTAMP,
        edit_reason = $19
      WHERE id = $20
      RETURNING *
      `,
      [
        salePayload.totalAmount, salePayload.totalCost, salePayload.profit, salePayload.branchId,
        salePayload.customerName, salePayload.customerMobile, salePayload.customerNotes, salePayload.paymentMode,
        salePayload.grossAmount, salePayload.itemDiscountAmount, salePayload.invoiceDiscountAmount, salePayload.taxAmount,
        salePayload.discountRule?.id || null, salePayload.discountRule?.rule_name || null,
        salePayload.discountRule?.discount_type || null, salePayload.discountRule?.discount_value || 0,
        salePayload.discountRule?.payment_mode || null, editor.id, reason, saleId,
      ]
    );
    const updatedSale = updateResult.rows[0];

    for (const item of salePayload.invoiceItems) {
      const invoiceDiscountShare = salePayload.grossAmount - salePayload.itemDiscountAmount === 0
        ? 0
        : roundCurrency(salePayload.invoiceDiscountAmount * (item.netAmount / (salePayload.grossAmount - salePayload.itemDiscountAmount)));
      const itemProfit = roundCurrency(item.netAmount - invoiceDiscountShare - item.costAmount);
      const saleItemResult = await client.query(
        `
        INSERT INTO sale_items (
          sale_id, product_id, quantity, selling_rate, amount, discount_amount, net_amount, cost_amount, profit
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id
        `,
        [
          saleId, item.productId, item.quantity, item.sellingRate, item.grossAmount,
          item.discountAmount, item.netAmount, item.costAmount, itemProfit,
        ]
      );
      const saleItemId = saleItemResult.rows[0].id;
      for (const allocation of item.allocations) {
        await client.query(
          `
          INSERT INTO sale_batch_allocations (
            sale_item_id, inventory_batch_id, quantity, purchase_rate, cost_amount
          )
          VALUES ($1, $2, $3, $4, $5)
          `,
          [saleItemId, allocation.inventoryBatchId, allocation.quantity, allocation.purchaseRate, allocation.costAmount]
        );
      }
      await client.query(
        `
        INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id)
        VALUES ($1, $2, 'OUT', $3, $4, $5)
        `,
        [item.productId, item.quantity, `Edited invoice ${updatedSale.invoice_no}`, editor.id, salePayload.branchId]
      );
    }

    for (const payment of salePayload.payments) {
      await client.query("INSERT INTO sale_payments (sale_id, payment_mode, amount) VALUES ($1, $2, $3)", [saleId, payment.mode, payment.amount]);
    }

    await client.query(
      `
      INSERT INTO sale_audit_trail (sale_id, action, field_name, old_value, new_value, reason, edited_by)
      VALUES ($1, 'EDIT', 'invoice', $2::jsonb, $3::jsonb, $4, $5)
      `,
      [saleId, JSON.stringify(oldSnapshot), JSON.stringify(await getSaleSnapshot(client, saleId)), reason, editor.id]
    );

    const delta = roundCurrency(salePayload.totalAmount - Number(currentSale.total_amount || 0));
    if (delta !== 0 || salePayload.customerMobile || salePayload.customerName) {
      await insertCustomerLedgerEntry(
        client,
        updatedSale,
        delta >= 0 ? "SALE_EDIT_DEBIT" : "SALE_EDIT_CREDIT",
        delta,
        editor.id,
        `Invoice ${updatedSale.invoice_no} edited: ${reason}`
      );
    }

    await client.query("COMMIT");
    return res.json({ success: true, message: "Invoice Updated", sale: updatedSale });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Sale Edit Error" });
  } finally {
    client.release();
  }
});

app.post("/sales/:id/cancel", async (req, res) => {
  const client = await pool.connect();
  try {
    const saleId = parsePositiveInteger(req.params.id);
    const reason = cleanText(req.body.reason);
    const canceller = await getSalePermissionUser(req.body.cancelled_by, "cancel", client);
    if (!saleId) return res.status(400).json({ message: "Invalid invoice" });
    if (!reason) return res.status(400).json({ message: "Cancellation reason is required" });
    if (!canceller) return res.status(403).json({ message: "You do not have permission to cancel completed sales" });

    await client.query("BEGIN");
    const saleLockResult = await client.query("SELECT * FROM sales WHERE id = $1 FOR UPDATE", [saleId]);
    const currentSale = saleLockResult.rows[0];
    if (!currentSale) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Invoice not found" });
    }
    if (currentSale.sale_status === "CANCELLED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Invoice is already cancelled" });
    }
    const oldSnapshot = await getSaleSnapshot(client, saleId);
    await restoreSaleInventory(client, saleId, canceller.id, "Cancellation reversal for invoice", "IN");
    await client.query("DELETE FROM sale_batch_allocations WHERE sale_item_id IN (SELECT id FROM sale_items WHERE sale_id = $1)", [saleId]);
    const updateResult = await client.query(
      `
      UPDATE sales
      SET sale_status = 'CANCELLED',
          cancelled_by = $1,
          cancelled_at = CURRENT_TIMESTAMP,
          cancellation_reason = $2
      WHERE id = $3
      RETURNING *
      `,
      [canceller.id, reason, saleId]
    );
    const cancelledSale = updateResult.rows[0];
    await client.query(
      `
      INSERT INTO sale_audit_trail (sale_id, action, field_name, old_value, new_value, reason, edited_by)
      VALUES ($1, 'CANCEL', 'invoice', $2::jsonb, $3::jsonb, $4, $5)
      `,
      [saleId, JSON.stringify(oldSnapshot), JSON.stringify(await getSaleSnapshot(client, saleId)), reason, canceller.id]
    );
    await insertCustomerLedgerEntry(
      client,
      cancelledSale,
      "SALE_CANCELLED",
      Number(currentSale.total_amount || 0),
      canceller.id,
      `Invoice ${cancelledSale.invoice_no} cancelled: ${reason}`
    );
    await client.query("COMMIT");
    return res.json({ success: true, message: "Invoice Cancelled", sale: cancelledSale });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Sale Cancellation Error" });
  } finally {
    client.release();
  }
});

app.get("/sales/:id", async (req, res) => {
  try {
    const saleId = parsePositiveInteger(req.params.id);
    if (!saleId) return res.status(400).json({ message: "Invalid invoice" });

    const saleResult = await pool.query(
      `
      SELECT s.*, b.branch_name, u.full_name AS created_by_name
      FROM sales s
      LEFT JOIN branches b ON b.id = s.branch_id
      LEFT JOIN users u ON u.id = s.created_by
      WHERE s.id = $1
      `,
      [saleId]
    );
    if (saleResult.rows.length === 0) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    const [itemsResult, paymentsResult] = await Promise.all([
      pool.query(
        `
        SELECT
          si.id, si.product_id, p.product_name, p.unit, si.quantity, si.selling_rate,
          si.amount, si.discount_amount, COALESCE(si.net_amount, si.amount) AS net_amount,
          si.cost_amount, si.profit
        FROM sale_items si
        JOIN products p ON p.id = si.product_id
        WHERE si.sale_id = $1
        ORDER BY si.id
        `,
        [saleId]
      ),
      pool.query(
        "SELECT payment_mode AS mode, amount FROM sale_payments WHERE sale_id = $1 ORDER BY id",
        [saleId]
      ),
    ]);

    return res.json({
      ...saleResult.rows[0],
      items: itemsResult.rows,
      payments: paymentsResult.rows,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Invoice" });
  }
});

initializeDatabase()
  .then(() => {
    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });
  })
  .catch((error) => {
    console.error("Database initialization failed", error);
    process.exit(1);
  });
