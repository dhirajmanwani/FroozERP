const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool, types } = require("pg");

types.setTypeParser(1082, (value) => value);

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
const hashPassword = (password) =>
  crypto.createHash("sha256").update(String(password || ""), "utf8").digest("hex");
const passwordMatches = (password, storedHash) => {
  const stored = cleanText(storedHash);
  if (!stored) return false;
  return stored === hashPassword(password) || stored === String(password || "");
};
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
const toBusinessDateKey = (value) => {
  const text = cleanText(value);
  if (!text) return toDateKey(new Date());
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  return toDateKey(new Date(text));
};
const RATE_MANAGER_ROLES = new Set(["Owner", "Admin"]);
const SUPPLIER_TYPES = new Set(["LOCAL_SUPPLIER", "IMPORTED_SUPPLIER", "COMMISSION_AGENT", "TRANSPORT_VENDOR"]);
const SUPPLIER_PAYMENT_MODES = new Set(["CASH", "UPI", "BANK_TRANSFER", "CHEQUE"]);
const CUSTOMER_TYPES = new Set(["RETAIL", "WHOLESALE"]);
const ACCOUNT_TYPES = new Set(["CUSTOMER", "SUPPLIER", "TRANSPORT_VENDOR", "COMMISSION_AGENT", "STAFF", "OTHER"]);
const DISCOUNT_TYPES = new Set(["FLAT_AMOUNT", "PERCENTAGE"]);
const DISCOUNT_PAYMENT_MODES = new Set(["ALL", "CASH", "UPI", "CARD"]);
const ROUNDING_RULES = new Set(["NEAREST_RUPEE", "ROUND_UP_5", "ROUND_UP_10", "NO_ROUND"]);
const SALE_STATUSES = new Set(["COMPLETED", "EDITED", "CANCELLED"]);
const REFUND_TYPES = new Set(["CASH_REFUND", "UPI_REFUND", "CREDIT_NOTE", "FUTURE_ADJUSTMENT"]);
const WASTE_TYPES = new Set(["DAAGI", "SAMPLING", "PERSONAL_USE", "OTHER"]);
const PURCHASE_BILL_STATUSES = new Set(["BILL_PENDING", "BILL_COMPLETED"]);
const PRODUCT_UNITS = new Set(["KG", "BOX", "PIECE", "DOZEN"]);
const PERMISSION_KEYS = [
  "settings",
  "discounts",
  "mandi_tax",
  "rebate_rules",
  "supplier_payments",
  "customer_payments",
  "sale_edit",
  "invoice_cancellation",
  "reports",
  "purchases",
  "supplier_accounts",
  "inventory",
  "waste_management",
  "billing",
  "manual_pos_rate_override",
  "pos_date_override",
  "sale_date_edit",
];

const cleanText = (value) => (typeof value === "string" ? value.trim() : "");
const nullableText = (value) => cleanText(value) || null;
const normalizeSupplierType = (value) => String(value || "LOCAL_SUPPLIER").toUpperCase();
const normalizePaymentMode = (value) => String(value || "").trim().toUpperCase().replace(/\s+/g, "_");
const normalizeDiscountType = (value) => String(value || "FLAT_AMOUNT").toUpperCase();
const normalizeDiscountPaymentMode = (value) => String(value || "ALL").trim().toUpperCase();
const normalizeRefundType = (value) => String(value || "CASH_REFUND").trim().toUpperCase();
const normalizeWasteType = (value) => String(value || "DAAGI").trim().toUpperCase();
const normalizeProductUnit = (value) => {
  const unit = String(value || "").trim().toUpperCase();
  return PRODUCT_UNITS.has(unit) ? unit : unit;
};

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

const getPermissionUser = async (userId, permissionKey, defaultRoles = [], client = pool) => {
  const parsedUserId = parsePositiveInteger(userId);
  if (!parsedUserId || !PERMISSION_KEYS.includes(permissionKey)) return null;
  const result = await client.query(
    `
    SELECT
      u.id,
      u.full_name,
      r.role_name,
      COALESCE(rps.permissions, '{}'::jsonb) AS permissions
    FROM users u
    JOIN roles r ON r.id = u.role_id
    LEFT JOIN role_permission_settings rps ON rps.role_name = r.role_name
    WHERE u.id = $1 AND u.active = TRUE
    `,
    [parsedUserId]
  );
  const user = result.rows[0];
  if (!user) return null;
  if (user.role_name === "Owner") return user;
  const storedPermission = user.permissions?.[permissionKey];
  if (storedPermission === true || (storedPermission === undefined && defaultRoles.includes(user.role_name))) {
    return user;
  }
  return null;
};

const initializeDatabase = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS branches (
      id SERIAL PRIMARY KEY,
      branch_name VARCHAR(120) NOT NULL DEFAULT 'Main Branch',
      location VARCHAR(160),
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE branches ADD COLUMN IF NOT EXISTS location VARCHAR(160);
    ALTER TABLE branches ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE;
    ALTER TABLE branches ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

    CREATE TABLE IF NOT EXISTS roles (
      id SERIAL PRIMARY KEY,
      role_name VARCHAR(80) UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      full_name VARCHAR(140) NOT NULL,
      username VARCHAR(80) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role_id INTEGER REFERENCES roles(id),
      branch_id INTEGER REFERENCES branches(id),
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile_number VARCHAR(30);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(140);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS joining_date DATE DEFAULT CURRENT_DATE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS notes TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_unique_idx
      ON users (LOWER(username));

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

    CREATE TABLE IF NOT EXISTS product_categories (
      id SERIAL PRIMARY KEY,
      category_name VARCHAR(120) NOT NULL,
      active BOOLEAN DEFAULT TRUE,
      remarks TEXT,
      created_by INTEGER REFERENCES users(id),
      updated_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS product_categories_name_lower_unique_idx
      ON product_categories (LOWER(category_name));

    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      product_name VARCHAR(160) NOT NULL,
      selling_rate NUMERIC(14, 2) NOT NULL,
      unit VARCHAR(30) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE products ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES product_categories(id);
    ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode VARCHAR(100);
    ALTER TABLE products ADD COLUMN IF NOT EXISTS origin_type VARCHAR(20) DEFAULT 'LOCAL';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS category VARCHAR(80) DEFAULT 'Fruit';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS remarks TEXT;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS archived_duplicate_of INTEGER;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS archive_reason TEXT;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS selling_rate_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS selling_rate_updated_by INTEGER REFERENCES users(id);
    UPDATE products SET origin_type = 'LOCAL' WHERE origin_type IS NULL;
    CREATE INDEX IF NOT EXISTS products_name_search_lower_idx
      ON products (LOWER(product_name));
    CREATE TABLE IF NOT EXISTS product_duplicate_archive_log (
      id SERIAL PRIMARY KEY,
      duplicate_product_id INTEGER NOT NULL REFERENCES products(id),
      kept_product_id INTEGER NOT NULL REFERENCES products(id),
      category_key TEXT NOT NULL,
      product_name_key TEXT NOT NULL,
      archive_reason TEXT NOT NULL,
      archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (duplicate_product_id)
    );
    WITH ranked_products AS (
      SELECT
        id,
        LOWER(COALESCE(NULLIF(TRIM(category), ''), 'Fruit')) AS category_key,
        LOWER(TRIM(product_name)) AS product_name_key,
        FIRST_VALUE(id) OVER (
          PARTITION BY LOWER(COALESCE(NULLIF(TRIM(category), ''), 'Fruit')), LOWER(TRIM(product_name))
          ORDER BY CASE WHEN active IS DISTINCT FROM FALSE THEN 0 ELSE 1 END, COALESCE(created_at, '1970-01-01'::timestamp), id
        ) AS kept_product_id,
        COUNT(*) OVER (
          PARTITION BY LOWER(COALESCE(NULLIF(TRIM(category), ''), 'Fruit')), LOWER(TRIM(product_name))
        ) AS duplicate_count
      FROM products
      WHERE product_name IS NOT NULL AND TRIM(product_name) <> ''
    ),
    archived_products AS (
      UPDATE products p
      SET active = FALSE,
          archived_duplicate_of = ranked_products.kept_product_id,
          archived_at = COALESCE(p.archived_at, CURRENT_TIMESTAMP),
          archive_reason = COALESCE(p.archive_reason, 'Archived duplicate product during startup migration'),
          remarks = CONCAT_WS(E'\n', NULLIF(p.remarks, ''), 'Archived duplicate product. Kept product ID: ' || ranked_products.kept_product_id)
      FROM ranked_products
      WHERE p.id = ranked_products.id
        AND ranked_products.duplicate_count > 1
        AND ranked_products.id <> ranked_products.kept_product_id
      RETURNING
        p.id AS duplicate_product_id,
        ranked_products.kept_product_id,
        ranked_products.category_key,
        ranked_products.product_name_key
    )
    INSERT INTO product_duplicate_archive_log (
      duplicate_product_id, kept_product_id, category_key, product_name_key, archive_reason
    )
    SELECT
      duplicate_product_id,
      kept_product_id,
      category_key,
      product_name_key,
      'Archived duplicate product during startup migration'
    FROM archived_products
    ON CONFLICT (duplicate_product_id) DO NOTHING;
    DROP INDEX IF EXISTS products_category_name_lower_unique_idx;
    CREATE UNIQUE INDEX products_category_name_lower_unique_idx
      ON products (LOWER(COALESCE(category, 'Fruit')), LOWER(product_name))
      WHERE active IS DISTINCT FROM FALSE;
    CREATE UNIQUE INDEX IF NOT EXISTS products_barcode_unique_idx
      ON products (barcode)
      WHERE barcode IS NOT NULL AND barcode <> '';
    INSERT INTO product_categories (category_name, active)
    SELECT DISTINCT COALESCE(NULLIF(TRIM(category), ''), 'Fruit'), TRUE
    FROM products
    ON CONFLICT DO NOTHING;
    UPDATE products p
    SET category_id = pc.id,
        category = pc.category_name
    FROM product_categories pc
    WHERE p.category_id IS NULL
      AND LOWER(pc.category_name) = LOWER(COALESCE(NULLIF(TRIM(p.category), ''), 'Fruit'));

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
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS purchase_status VARCHAR(20) DEFAULT 'ACTIVE';
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS remarks TEXT;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS edited_by INTEGER REFERENCES users(id);
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS edit_reason TEXT;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS cancelled_by INTEGER REFERENCES users(id);
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS purchase_bill_status VARCHAR(30) DEFAULT 'BILL_COMPLETED';
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS temporary_sale_rate NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS expected_purchase_rate NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS bill_number VARCHAR(120);
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS bill_date DATE;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS lot_name VARCHAR(120);
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS lot_size VARCHAR(120);
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS stock_source VARCHAR(40) DEFAULT 'PURCHASE';
    UPDATE purchases SET purchase_status = 'ACTIVE' WHERE purchase_status IS NULL;

    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS basic_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS mandi_tax_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS other_charges NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS rebate_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS net_payable NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS effective_cost_per_unit NUMERIC(14, 4) DEFAULT 0;
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS freight_charges NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS labour_charges NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS lot_name VARCHAR(120);
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS lot_size VARCHAR(120);

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
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS purchase_id INTEGER;
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS batch_status VARCHAR(20) DEFAULT 'ACTIVE';
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS purchase_bill_status VARCHAR(30) DEFAULT 'BILL_COMPLETED';
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS temporary_sale_rate NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS lot_name VARCHAR(120);
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS lot_size VARCHAR(120);
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS stock_source VARCHAR(40) DEFAULT 'PURCHASE';
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS remarks TEXT;
    UPDATE inventory_batches SET batch_status = 'ACTIVE' WHERE batch_status IS NULL;
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

    CREATE TABLE IF NOT EXISTS product_audit_trail (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id),
      action VARCHAR(30) NOT NULL,
      old_value JSONB,
      new_value JSONB,
      reason TEXT NOT NULL,
      edited_by INTEGER REFERENCES users(id),
      edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO product_audit_trail (product_id, action, old_value, new_value, reason, edited_by)
    SELECT
      log.duplicate_product_id,
      'ARCHIVE_DUPLICATE',
      JSONB_BUILD_OBJECT(
        'duplicate_product_id', log.duplicate_product_id,
        'category_key', log.category_key,
        'product_name_key', log.product_name_key
      ),
      JSONB_BUILD_OBJECT(
        'active', FALSE,
        'archived_duplicate_of', log.kept_product_id,
        'archived_at', log.archived_at
      ),
      log.archive_reason,
      NULL
    FROM product_duplicate_archive_log log
    WHERE NOT EXISTS (
      SELECT 1
      FROM product_audit_trail audit
      WHERE audit.product_id = log.duplicate_product_id
        AND audit.action = 'ARCHIVE_DUPLICATE'
    );

    CREATE TABLE IF NOT EXISTS product_category_audit_trail (
      id SERIAL PRIMARY KEY,
      category_id INTEGER REFERENCES product_categories(id),
      action VARCHAR(30) NOT NULL,
      old_value JSONB,
      new_value JSONB,
      reason TEXT NOT NULL,
      edited_by INTEGER REFERENCES users(id),
      edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS purchase_audit_trail (
      id SERIAL PRIMARY KEY,
      purchase_id INTEGER NOT NULL REFERENCES purchases(id),
      action VARCHAR(30) NOT NULL,
      old_value JSONB,
      new_value JSONB,
      reason TEXT NOT NULL,
      edited_by INTEGER REFERENCES users(id),
      edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
      default_printer_type VARCHAR(20) DEFAULT 'THERMAL',
      receipt_width VARCHAR(10) DEFAULT '80MM',
      auto_print_after_billing BOOLEAN DEFAULT FALSE,
      updated_by INTEGER REFERENCES users(id),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS default_printer_type VARCHAR(20) DEFAULT 'THERMAL';
    ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS receipt_width VARCHAR(10) DEFAULT '80MM';
    ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS auto_print_after_billing BOOLEAN DEFAULT FALSE;
    ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS default_invoice_print VARCHAR(30) DEFAULT 'THERMAL_RECEIPT';
    ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS default_report_print VARCHAR(30) DEFAULT 'A4_REPORT';
    ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS show_print_preview_before_print BOOLEAN DEFAULT TRUE;
    ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS show_item_discount_column_pos BOOLEAN DEFAULT TRUE;
    ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS show_item_discount_column_receipt BOOLEAN DEFAULT TRUE;
    ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS show_bill_discount_row_receipt BOOLEAN DEFAULT TRUE;
    ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS hide_zero_discount_rows BOOLEAN DEFAULT TRUE;

    CREATE TABLE IF NOT EXISTS sale_rate_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      desired_margin_percent NUMERIC(6, 2) NOT NULL DEFAULT 25 CHECK (desired_margin_percent >= 0),
      rounding_rule VARCHAR(30) NOT NULL DEFAULT 'NEAREST_RUPEE',
      suggestion_enabled BOOLEAN DEFAULT TRUE,
      notes TEXT,
      updated_by INTEGER REFERENCES users(id),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE sale_rate_settings ADD COLUMN IF NOT EXISTS bill_level_slab_discount_enabled BOOLEAN DEFAULT TRUE;

    CREATE TABLE IF NOT EXISTS pos_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      enable_weighing_scale BOOLEAN DEFAULT FALSE,
      scale_connection_type VARCHAR(30) DEFAULT 'MANUAL_FALLBACK',
      scale_com_port VARCHAR(40),
      scale_baud_rate INTEGER DEFAULT 9600,
      scale_auto_read BOOLEAN DEFAULT FALSE,
      updated_by INTEGER REFERENCES users(id),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS payment_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      business_upi_id VARCHAR(160),
      upi_payee_name VARCHAR(180),
      enable_upi_qr_on_invoice BOOLEAN DEFAULT FALSE,
      show_upi_qr_on_all_bills BOOLEAN DEFAULT FALSE,
      qr_display_size VARCHAR(20) DEFAULT 'MEDIUM',
      updated_by INTEGER REFERENCES users(id),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS show_upi_qr_on_all_bills BOOLEAN DEFAULT FALSE;
    ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS qr_display_size VARCHAR(20) DEFAULT 'MEDIUM';

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
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS system_account BOOLEAN DEFAULT FALSE;
    INSERT INTO customers (
      customer_name, customer_type, mobile_number, notes, opening_balance, active, system_account
    )
    SELECT 'Walk-in Customer', 'RETAIL', NULL, 'System account for POS bills without a saved customer.', 0, TRUE, TRUE
    WHERE NOT EXISTS (
      SELECT 1 FROM customers WHERE system_account = TRUE OR LOWER(customer_name) = LOWER('Walk-in Customer')
    );
    UPDATE customers
    SET customer_name = 'Walk-in Customer',
        customer_type = 'RETAIL',
        active = TRUE,
        system_account = TRUE,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = (
      SELECT id
      FROM customers
      WHERE system_account = TRUE OR LOWER(customer_name) = LOWER('Walk-in Customer')
      ORDER BY system_account DESC, id
      LIMIT 1
    );
    CREATE INDEX IF NOT EXISTS customers_name_mobile_search_lower_idx
      ON customers (LOWER(customer_name), COALESCE(mobile_number, ''));

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
    CREATE INDEX IF NOT EXISTS accounts_name_mobile_search_lower_idx
      ON accounts (LOWER(account_name), COALESCE(mobile_number, ''));

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

    ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS edited_by INTEGER REFERENCES users(id);
    ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP;
    ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS edit_reason TEXT;

    CREATE TABLE IF NOT EXISTS customer_payment_audit (
      id SERIAL PRIMARY KEY,
      customer_payment_id INTEGER NOT NULL REFERENCES customer_payments(id),
      action VARCHAR(30) NOT NULL,
      old_value JSONB,
      new_value JSONB,
      reason TEXT NOT NULL,
      edited_by INTEGER REFERENCES users(id),
      edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sale_returns (
      id SERIAL PRIMARY KEY,
      return_no VARCHAR(40) UNIQUE,
      sale_id INTEGER NOT NULL REFERENCES sales(id),
      customer_name VARCHAR(120),
      customer_mobile VARCHAR(20),
      return_date DATE NOT NULL DEFAULT CURRENT_DATE,
      refund_type VARCHAR(30) NOT NULL,
      return_reason TEXT NOT NULL,
      total_return_amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (total_return_amount >= 0),
      total_cost_amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (total_cost_amount >= 0),
      branch_id INTEGER REFERENCES branches(id),
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sale_return_items (
      id SERIAL PRIMARY KEY,
      sale_return_id INTEGER NOT NULL REFERENCES sale_returns(id) ON DELETE CASCADE,
      sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      return_quantity NUMERIC(14, 3) NOT NULL CHECK (return_quantity > 0),
      selling_rate NUMERIC(14, 2) NOT NULL DEFAULT 0,
      return_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
      cost_amount NUMERIC(14, 2) NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS waste_entries (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id),
      waste_date DATE NOT NULL DEFAULT CURRENT_DATE,
      quantity NUMERIC(14, 3) NOT NULL CHECK (quantity > 0),
      waste_type VARCHAR(30) NOT NULL,
      remarks TEXT,
      cost_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
      branch_id INTEGER REFERENCES branches(id),
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS role_permission_settings (
      role_name VARCHAR(80) PRIMARY KEY,
      permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_by INTEGER REFERENCES users(id),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS update_center (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      current_version VARCHAR(40) NOT NULL DEFAULT '1.0.0',
      release_date DATE NOT NULL DEFAULT CURRENT_DATE,
      changelog TEXT NOT NULL DEFAULT 'Initial local FroozERP release channel prepared.',
      update_status VARCHAR(40) NOT NULL DEFAULT 'READY_FOR_FUTURE_UPDATES',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sync_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      sync_enabled BOOLEAN DEFAULT FALSE,
      sync_status VARCHAR(40) NOT NULL DEFAULT 'OFFLINE_READY',
      last_sync_at TIMESTAMP,
      pending_count INTEGER NOT NULL DEFAULT 0 CHECK (pending_count >= 0),
      device_id VARCHAR(120) DEFAULT 'LOCAL-STORE',
      notes TEXT DEFAULT 'Cloud sync architecture prepared. Online sync delivery is not enabled yet.',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE sync_settings ADD COLUMN IF NOT EXISTS device_display_name VARCHAR(160) DEFAULT 'Main Counter Device';

    CREATE TABLE IF NOT EXISTS sync_queue (
      id SERIAL PRIMARY KEY,
      entity_type VARCHAR(80) NOT NULL,
      entity_id INTEGER,
      operation VARCHAR(30) NOT NULL,
      payload JSONB,
      sync_status VARCHAR(40) NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      synced_at TIMESTAMP,
      error_message TEXT
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

    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'ACTIVE';
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS paid_to VARCHAR(160);
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS edited_by INTEGER REFERENCES users(id);
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP;
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS edit_reason TEXT;
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS cancelled_by INTEGER REFERENCES users(id);
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP;
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
    UPDATE expenses SET status = CASE WHEN active IS DISTINCT FROM FALSE THEN 'ACTIVE' ELSE 'CANCELLED' END WHERE status IS NULL;
    UPDATE expenses SET paid_to = vendor_name WHERE paid_to IS NULL AND vendor_name IS NOT NULL;

    CREATE TABLE IF NOT EXISTS expense_audit_trail (
      id SERIAL PRIMARY KEY,
      expense_id INTEGER NOT NULL REFERENCES expenses(id),
      action VARCHAR(30) NOT NULL,
      old_value JSONB,
      new_value JSONB,
      reason TEXT NOT NULL,
      changed_by INTEGER REFERENCES users(id),
      changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    INSERT INTO business_settings (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO sale_rate_settings (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO pos_settings (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO payment_settings (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO update_center (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO sync_settings (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO role_permission_settings (role_name, permissions)
    VALUES
      ('Owner', '{"settings":true,"discounts":true,"mandi_tax":true,"rebate_rules":true,"supplier_payments":true,"customer_payments":true,"sale_edit":true,"invoice_cancellation":true,"reports":true,"purchases":true,"supplier_accounts":true,"inventory":true,"waste_management":true,"billing":true}'::jsonb),
      ('Admin', '{"settings":true,"discounts":true,"mandi_tax":true,"rebate_rules":true,"supplier_payments":true,"customer_payments":true,"sale_edit":true,"invoice_cancellation":true,"reports":true,"purchases":true,"supplier_accounts":true,"inventory":true,"waste_management":true,"billing":true}'::jsonb),
      ('Cashier', '{"billing":true,"customer_payments":true,"settings":false,"invoice_cancellation":false,"sale_edit":false,"discounts":false,"mandi_tax":false,"rebate_rules":false,"supplier_payments":false,"reports":false,"purchases":false,"supplier_accounts":false,"inventory":false,"waste_management":false}'::jsonb),
      ('Purchase Manager', '{"purchases":true,"supplier_payments":true,"supplier_accounts":true,"reports":true,"settings":false,"discounts":false,"mandi_tax":false,"rebate_rules":false,"customer_payments":false,"sale_edit":false,"invoice_cancellation":false,"inventory":false,"waste_management":false,"billing":false}'::jsonb),
      ('Inventory Manager', '{"inventory":true,"waste_management":true,"reports":true,"settings":false,"discounts":false,"mandi_tax":false,"rebate_rules":false,"supplier_payments":false,"customer_payments":false,"sale_edit":false,"invoice_cancellation":false,"purchases":false,"supplier_accounts":false,"billing":false}'::jsonb)
    ON CONFLICT (role_name) DO NOTHING;

    UPDATE role_permission_settings
    SET permissions = permissions || '{"manual_pos_rate_override":true,"pos_date_override":true}'::jsonb
    WHERE role_name IN ('Owner', 'Admin');

    UPDATE role_permission_settings
    SET permissions = permissions || '{"sale_date_edit":true}'::jsonb
    WHERE role_name IN ('Owner', 'Admin');

    UPDATE role_permission_settings
    SET permissions = permissions || '{"manual_pos_rate_override":false}'::jsonb
    WHERE role_name IN ('Cashier', 'Purchase Manager', 'Inventory Manager')
      AND NOT (permissions ? 'manual_pos_rate_override');

    UPDATE role_permission_settings
    SET permissions = permissions || '{"pos_date_override":false}'::jsonb
    WHERE role_name IN ('Cashier', 'Purchase Manager', 'Inventory Manager')
      AND NOT (permissions ? 'pos_date_override');

    UPDATE role_permission_settings
    SET permissions = permissions || '{"sale_date_edit":false}'::jsonb
    WHERE role_name IN ('Cashier', 'Purchase Manager', 'Inventory Manager')
      AND NOT (permissions ? 'sale_date_edit');

    INSERT INTO branches (id, branch_name, location)
    VALUES (1, 'Main Branch', 'Primary Store')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO roles (role_name)
    VALUES ('Owner'), ('Admin'), ('Cashier'), ('Purchase Manager'), ('Inventory Manager')
    ON CONFLICT (role_name) DO NOTHING;

    INSERT INTO users (full_name, username, password_hash, role_id, branch_id, active)
    SELECT 'Owner', 'owner', '${hashPassword("owner123")}', r.id, 1, TRUE
    FROM roles r
    WHERE r.role_name = 'Owner'
      AND NOT EXISTS (SELECT 1 FROM users);

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
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id);
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
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS profit_status VARCHAR(30) DEFAULT 'FINAL';
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS transaction_date DATE;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS bill_datetime TIMESTAMP;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS backdated_bill BOOLEAN DEFAULT FALSE;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS backdate_reason TEXT;
    UPDATE sales SET transaction_date = sale_date WHERE transaction_date IS NULL;
    UPDATE sales SET bill_datetime = COALESCE(sale_date::timestamp, created_at) WHERE bill_datetime IS NULL;
    UPDATE sales
    SET customer_id = (
      SELECT id FROM customers WHERE system_account = TRUE ORDER BY id LIMIT 1
    )
    WHERE customer_id IS NULL
      AND (
        customer_name IS NULL
        OR LOWER(COALESCE(customer_name, '')) LIKE '%walk-in%'
      );
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
    ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS cost_status VARCHAR(30) DEFAULT 'FINAL';
    ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS default_selling_rate NUMERIC(14, 2);
    ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS manual_rate_override BOOLEAN DEFAULT FALSE;
    UPDATE sale_items SET default_selling_rate = selling_rate WHERE default_selling_rate IS NULL;

    CREATE TABLE IF NOT EXISTS pos_rate_override_audit (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      sale_item_id INTEGER REFERENCES sale_items(id) ON DELETE SET NULL,
      product_id INTEGER NOT NULL REFERENCES products(id),
      product_name VARCHAR(160) NOT NULL,
      default_rate NUMERIC(14, 2) NOT NULL,
      manual_rate NUMERIC(14, 2) NOT NULL,
      changed_by INTEGER REFERENCES users(id),
      changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      invoice_no VARCHAR(40),
      reason TEXT
    );

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
    ALTER TABLE customer_ledger ADD COLUMN IF NOT EXISTS transaction_date DATE;

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

    CREATE INDEX IF NOT EXISTS suppliers_name_firm_search_lower_idx
      ON suppliers (LOWER(supplier_name), LOWER(COALESCE(firm_name, '')));

    CREATE INDEX IF NOT EXISTS purchases_supplier_id_idx
      ON purchases (supplier_id);

    CREATE INDEX IF NOT EXISTS purchase_audit_purchase_idx
      ON purchase_audit_trail (purchase_id, edited_at DESC, id DESC);

    CREATE INDEX IF NOT EXISTS product_audit_product_idx
      ON product_audit_trail (product_id, edited_at DESC, id DESC);

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

    CREATE INDEX IF NOT EXISTS sale_returns_sale_date_idx
      ON sale_returns (sale_id, return_date DESC, id DESC);

    CREATE INDEX IF NOT EXISTS sale_return_items_product_idx
      ON sale_return_items (product_id, sale_item_id);

    CREATE INDEX IF NOT EXISTS waste_entries_date_product_idx
      ON waste_entries (waste_date DESC, product_id, id DESC);

    CREATE INDEX IF NOT EXISTS sync_queue_status_idx
      ON sync_queue (sync_status, created_at);

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

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_batches_purchase_id_fkey') THEN
        ALTER TABLE inventory_batches
          ADD CONSTRAINT inventory_batches_purchase_id_fkey
          FOREIGN KEY (purchase_id) REFERENCES purchases(id);
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

    UPDATE inventory_batches ib
    SET purchase_id = matched.id
    FROM purchases matched
    WHERE ib.purchase_id IS NULL
      AND ib.batch_no LIKE ('%-' || matched.id::TEXT);
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
        AND COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED'
        AND COALESCE(purchase_bill_status, 'BILL_COMPLETED') = 'BILL_COMPLETED'
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
          s.customer_id = c.id
          OR (s.customer_id IS NULL AND s.customer_mobile IS NOT NULL AND c.mobile_number = s.customer_mobile)
          OR (
            s.customer_id IS NULL
            AND c.system_account = TRUE
            AND (
              s.customer_name IS NULL
              OR LOWER(COALESCE(s.customer_name, '')) LIKE '%walk-in%'
            )
          )
          OR (
            s.customer_id IS NULL
            AND c.system_account IS DISTINCT FROM TRUE
            AND s.customer_mobile IS NULL
            AND s.customer_name IS NOT NULL
            AND LOWER(c.customer_name) = LOWER(s.customer_name)
          )
        ORDER BY CASE WHEN s.customer_id = c.id THEN 0 WHEN c.mobile_number = s.customer_mobile THEN 1 ELSE 2 END, c.id
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

const getWalkInCustomer = async (client = pool) => {
  const result = await client.query(
    `
    SELECT *
    FROM customers
    WHERE system_account = TRUE OR LOWER(customer_name) = LOWER('Walk-in Customer')
    ORDER BY system_account DESC, id
    LIMIT 1
    `
  );
  return result.rows[0] || null;
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
          WHERE COALESCE(batch_status, 'ACTIVE') <> 'CANCELLED'
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
              AND COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED'
            WHERE p.active IS DISTINCT FROM FALSE
            GROUP BY p.id, p.minimum_stock
          ) stock
          WHERE stock.current_stock <= stock.minimum_stock
        ), 0) AS "lowStockItems",
        COALESCE((SELECT COUNT(*) FROM sales WHERE sale_date = CURRENT_DATE AND sale_status <> 'CANCELLED'), 0) AS "transactions",
        COALESCE((SELECT SUM(amount) FROM expenses WHERE expense_date = CURRENT_DATE AND active IS DISTINCT FROM FALSE), 0) AS "todayExpenses",
        COALESCE((SELECT SUM(total_return_amount) FROM sale_returns WHERE return_date = CURRENT_DATE), 0) AS "todayReturns",
        COALESCE((SELECT SUM(total_return_amount) FROM sale_returns WHERE return_date >= DATE_TRUNC('month', CURRENT_DATE)::date), 0) AS "monthlyReturns",
        COALESCE((SELECT SUM(cost_amount) FROM waste_entries WHERE waste_date = CURRENT_DATE), 0) AS "todayWaste",
        COALESCE((SELECT SUM(cost_amount) FROM waste_entries WHERE waste_date >= DATE_TRUNC('month', CURRENT_DATE)::date), 0) AS "monthlyWaste",
        COALESCE((SELECT SUM(quantity) FROM waste_entries WHERE waste_date >= DATE_TRUNC('month', CURRENT_DATE)::date), 0) AS "monthlyWasteQuantity",
        COALESCE((SELECT SUM(rebate_amount) FROM purchases WHERE COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED' AND COALESCE(purchase_bill_status, 'BILL_COMPLETED') = 'BILL_COMPLETED'), 0)
          + COALESCE((SELECT SUM(rebate_amount) FROM supplier_payments WHERE cancelled = FALSE), 0) AS "totalRebateReceived",
        COALESCE((SELECT SUM(payment_amount) FROM supplier_payments WHERE payment_date = CURRENT_DATE AND cancelled = FALSE), 0)
          + COALESCE((SELECT SUM(paid_amount) FROM purchases WHERE COALESCE(payment_date, purchase_date) = CURRENT_DATE AND COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED' AND COALESCE(purchase_bill_status, 'BILL_COMPLETED') = 'BILL_COMPLETED'), 0) AS "todaySupplierPayments",
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
    todayReturns: Number(metrics.todayReturns || 0),
    monthlyReturns: Number(metrics.monthlyReturns || 0),
    todayWaste: Number(metrics.todayWaste || 0),
    monthlyWaste: Number(metrics.monthlyWaste || 0),
    monthlyWasteQuantity: Number(metrics.monthlyWasteQuantity || 0),
    wastePercentage: Number(metrics.stockValue || 0) > 0
      ? roundCurrency((Number(metrics.monthlyWaste || 0) / (Number(metrics.stockValue || 0) + Number(metrics.monthlyWaste || 0))) * 100)
      : 0,
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
        AND COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED'
        AND COALESCE(purchase_bill_status, 'BILL_COMPLETED') = 'BILL_COMPLETED'
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
        AND COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED'
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
  const [businessResult, saleRateResult, mandiResult, rebateResult, discountResult, roleResult, updateResult, syncResult, syncQueueResult, posResult, paymentResult, manager] = await Promise.all([
    pool.query("SELECT * FROM business_settings WHERE id = 1"),
    pool.query("SELECT * FROM sale_rate_settings WHERE id = 1"),
    pool.query("SELECT * FROM mandi_tax_rules ORDER BY origin_type"),
    pool.query("SELECT * FROM rebate_rules ORDER BY pay_within_days, id"),
    pool.query("SELECT * FROM sale_discount_rules ORDER BY minimum_bill_amount, maximum_bill_amount NULLS LAST, id"),
    pool.query("SELECT * FROM role_permission_settings ORDER BY CASE role_name WHEN 'Owner' THEN 1 WHEN 'Admin' THEN 2 WHEN 'Cashier' THEN 3 WHEN 'Purchase Manager' THEN 4 WHEN 'Inventory Manager' THEN 5 ELSE 6 END"),
    pool.query("SELECT * FROM update_center WHERE id = 1"),
    pool.query("SELECT * FROM sync_settings WHERE id = 1"),
    pool.query("SELECT COUNT(*)::INTEGER AS pending_count FROM sync_queue WHERE sync_status = 'PENDING'"),
    pool.query("SELECT * FROM pos_settings WHERE id = 1"),
    pool.query("SELECT * FROM payment_settings WHERE id = 1"),
    userId ? requireRateManager(userId) : Promise.resolve(null),
  ]);
  const usersResult = manager ? await pool.query(
    `
    SELECT
      u.id, u.full_name, u.username, u.mobile_number, u.email, u.active,
      u.joining_date, u.notes, u.last_login_at, u.created_at, u.updated_at,
      r.role_name AS role, b.branch_name AS branch
    FROM users u
    LEFT JOIN roles r ON r.id = u.role_id
    LEFT JOIN branches b ON b.id = u.branch_id
    ORDER BY u.active DESC, u.full_name
    `
  ) : { rows: [] };
  const syncSettings = syncResult.rows[0] || {};
  return {
    businessSettings: businessResult.rows[0] || {},
    saleRateSettings: saleRateResult.rows[0] || {},
    posSettings: posResult.rows[0] || {},
    paymentSettings: paymentResult.rows[0] || {},
    mandiTaxRules: mandiResult.rows,
    rebateRules: rebateResult.rows,
    discountRules: discountResult.rows,
    roles: roleResult.rows,
    users: usersResult.rows,
    updateCenter: updateResult.rows[0] || {},
    syncSettings: {
      ...syncSettings,
      pending_count: Number(syncQueueResult.rows[0]?.pending_count || syncSettings.pending_count || 0),
    },
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
  const settingsResult = await client.query("SELECT bill_level_slab_discount_enabled FROM sale_rate_settings WHERE id = 1");
  if (settingsResult.rows[0]?.bill_level_slab_discount_enabled === false) return null;
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
      debit_amount, credit_amount, balance_delta, remarks, created_by, transaction_date
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
      sale.sale_date || sale.transaction_date || toDateKey(new Date()),
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
  const selectedCustomerId = parsePositiveInteger(customer?.account_id || customer?.customer_id);
  const typedCustomerName = customer?.name?.trim() || null;
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

  let customerAccount;
  if (selectedCustomerId) {
    const customerResult = await client.query("SELECT * FROM customers WHERE id = $1 AND active = TRUE FOR SHARE", [selectedCustomerId]);
    if (customerResult.rows.length === 0) {
      return { error: { status: 400, message: "Selected customer account is not active" } };
    }
    customerAccount = customerResult.rows[0];
  } else {
    customerAccount = await getWalkInCustomer(client);
    if (!customerAccount) {
      return { error: { status: 500, message: "Walk-in Customer account is not configured" } };
    }
  }
  const customerId = customerAccount.id;
  const customerName = typedCustomerName || customerAccount.customer_name || "Walk-in Customer";

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
        AND COALESCE(batch_status, 'ACTIVE') <> 'CANCELLED'
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
  const discountRule = await getMatchingDiscountRule(client, grossAmount, paymentMode);
  const parsedInvoiceDiscount = parseNonNegativeNumber(invoiceDiscount);
  if (parsedInvoiceDiscount === null) return { error: { status: 400, message: "Enter a valid invoice discount" } };
  const invoiceDiscountAmount = discountRule
    ? Math.min(calculateInvoiceDiscount(discountRule, grossAmount), subtotalAfterItemDiscounts)
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
    customerId,
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

app.get("/settings/role-permissions", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM role_permission_settings ORDER BY role_name");
    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Role Permissions" });
  }
});

app.put("/settings/role-permissions/:roleName", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage role permissions" });
    const roleName = cleanText(req.params.roleName);
    const permissions = req.body.permissions && typeof req.body.permissions === "object" ? req.body.permissions : {};
    const normalized = PERMISSION_KEYS.reduce((payload, key) => ({ ...payload, [key]: Boolean(permissions[key]) }), {});
    const result = await pool.query(
      `
      INSERT INTO role_permission_settings (role_name, permissions, updated_by, updated_at)
      VALUES ($1, $2::jsonb, $3, CURRENT_TIMESTAMP)
      ON CONFLICT (role_name)
      DO UPDATE SET permissions = EXCLUDED.permissions, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP
      RETURNING *
      `,
      [roleName, JSON.stringify(normalized), manager.id]
    );
    await pool.query(
      `
      INSERT INTO sale_permission_settings (role_name, can_edit_sales, can_cancel_sales, updated_at)
      VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
      ON CONFLICT (role_name)
      DO UPDATE SET can_edit_sales = EXCLUDED.can_edit_sales, can_cancel_sales = EXCLUDED.can_cancel_sales, updated_at = CURRENT_TIMESTAMP
      `,
      [roleName, Boolean(normalized.sale_edit), Boolean(normalized.invoice_cancellation)]
    );
    return res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating Role Permissions" });
  }
});

app.get("/settings/update-center", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM update_center WHERE id = 1");
    return res.json(result.rows[0] || {});
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Update Center" });
  }
});

app.put("/settings/update-center", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage update settings" });
    const result = await pool.query(
      `
      UPDATE update_center
      SET current_version = $1, release_date = $2, changelog = $3, update_status = $4, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
      RETURNING *
      `,
      [
        cleanText(req.body.current_version) || "1.0.0",
        req.body.release_date || toDateKey(new Date()),
        cleanText(req.body.changelog) || "Future update channel prepared.",
        cleanText(req.body.update_status) || "READY_FOR_FUTURE_UPDATES",
      ]
    );
    return res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating Update Center" });
  }
});

app.get("/settings/sync-status", async (req, res) => {
  try {
    const [settingsResult, queueResult] = await Promise.all([
      pool.query("SELECT * FROM sync_settings WHERE id = 1"),
      pool.query("SELECT sync_status, COUNT(*)::INTEGER AS count FROM sync_queue GROUP BY sync_status"),
    ]);
    const pending = queueResult.rows.find((row) => row.sync_status === "PENDING")?.count || 0;
    return res.json({
      ...(settingsResult.rows[0] || {}),
      pending_count: Number(pending),
      queue: queueResult.rows,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Sync Status" });
  }
});

app.put("/settings/sync-status", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage sync settings" });
    const result = await pool.query(
      `
      UPDATE sync_settings
      SET device_display_name = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
      RETURNING *
      `,
      [cleanText(req.body.device_display_name) || "Main Counter Device"]
    );
    return res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating Sync Settings" });
  }
});

app.put("/settings/pos", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage POS settings" });
    const connectionType = cleanText(req.body.scale_connection_type).toUpperCase();
    const allowedConnections = new Set(["USB", "SERIAL", "BLUETOOTH", "MANUAL_FALLBACK"]);
    const baudRate = parsePositiveInteger(req.body.scale_baud_rate) || 9600;
    const result = await pool.query(
      `
      UPDATE pos_settings
      SET enable_weighing_scale = $1,
          scale_connection_type = $2,
          scale_com_port = $3,
          scale_baud_rate = $4,
          scale_auto_read = $5,
          updated_by = $6,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
      RETURNING *
      `,
      [
        req.body.enable_weighing_scale === true,
        allowedConnections.has(connectionType) ? connectionType : "MANUAL_FALLBACK",
        nullableText(req.body.scale_com_port),
        baudRate,
        req.body.scale_auto_read === true,
        manager.id,
      ]
    );
    return res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating POS Settings" });
  }
});

app.put("/settings/payment", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage payment settings" });
    const result = await pool.query(
      `
      UPDATE payment_settings
      SET business_upi_id = $1,
          upi_payee_name = $2,
          enable_upi_qr_on_invoice = $3,
          show_upi_qr_on_all_bills = $4,
          qr_display_size = $5,
          updated_by = $6,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
      RETURNING *
      `,
      [
        nullableText(req.body.business_upi_id),
        nullableText(req.body.upi_payee_name),
        req.body.enable_upi_qr_on_invoice === true,
        req.body.show_upi_qr_on_all_bills === true,
        ["SMALL", "MEDIUM", "LARGE"].includes(cleanText(req.body.qr_display_size).toUpperCase()) ? cleanText(req.body.qr_display_size).toUpperCase() : "MEDIUM",
        manager.id,
      ]
    );
    return res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating Payment Settings" });
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
        default_printer_type = $10,
        receipt_width = $11,
        auto_print_after_billing = $12,
        show_item_discount_column_pos = $13,
        show_item_discount_column_receipt = $14,
        show_bill_discount_row_receipt = $15,
        hide_zero_discount_rows = $16,
        default_invoice_print = $17,
        default_report_print = $18,
        show_print_preview_before_print = $19,
        updated_by = $20,
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
        cleanText(req.body.default_printer_type).toUpperCase() === "A4" ? "A4" : "THERMAL",
        cleanText(req.body.receipt_width).toUpperCase() === "58MM" ? "58MM" : "80MM",
        req.body.auto_print_after_billing === true,
        req.body.show_item_discount_column_pos !== false,
        req.body.show_item_discount_column_receipt !== false,
        req.body.show_bill_discount_row_receipt !== false,
        req.body.hide_zero_discount_rows !== false,
        cleanText(req.body.default_invoice_print).toUpperCase() === "A4_INVOICE" ? "A4_INVOICE" : "THERMAL_RECEIPT",
        "A4_REPORT",
        req.body.show_print_preview_before_print !== false,
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
          bill_level_slab_discount_enabled = $4,
          notes = $5, updated_by = $6, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
      RETURNING *
      `,
      [desiredMargin, roundingRule, req.body.suggestion_enabled !== false, req.body.bill_level_slab_discount_enabled !== false, nullableText(req.body.notes), manager.id]
    );
    return res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating Sale Rate Settings" });
  }
});

const readUserPayload = (body) => ({
  full_name: cleanText(body.full_name),
  username: cleanText(body.username),
  mobile_number: nullableText(body.mobile_number),
  email: nullableText(body.email),
  role: cleanText(body.role || "Cashier"),
  active: body.active !== false,
  joining_date: body.joining_date || toDateKey(new Date()),
  notes: nullableText(body.notes),
});

const findDuplicateUser = async ({ username, mobile_number, email, userId = null }) => {
  const result = await pool.query(
    `
    SELECT id, username, mobile_number, email
    FROM users
    WHERE ($1::INT IS NULL OR id <> $1)
      AND (
        LOWER(username) = LOWER($2)
        OR ($3::TEXT IS NOT NULL AND mobile_number IS NOT NULL AND mobile_number = $3)
        OR ($4::TEXT IS NOT NULL AND email IS NOT NULL AND LOWER(email) = LOWER($4))
      )
    LIMIT 1
    `,
    [userId, username, mobile_number, email]
  );
  const duplicate = result.rows[0];
  if (!duplicate) return "";
  if (duplicate.username?.toLowerCase() === username.toLowerCase()) return "This username already exists.";
  if (mobile_number && duplicate.mobile_number === mobile_number) return "This mobile number already exists.";
  if (email && duplicate.email?.toLowerCase() === email.toLowerCase()) return "This email already exists.";
  return "This user already exists.";
};

const getRoleIdByName = async (roleName, client = pool) => {
  const result = await client.query("SELECT id FROM roles WHERE role_name = $1", [roleName]);
  return result.rows[0]?.id || null;
};

const getUserTransactionCount = async (userId) => {
  const result = await pool.query(
    `
    SELECT
      COALESCE((SELECT COUNT(*) FROM sales WHERE created_by = $1), 0)
      + COALESCE((SELECT COUNT(*) FROM purchases WHERE created_by = $1), 0)
      + COALESCE((SELECT COUNT(*) FROM supplier_payments WHERE created_by = $1), 0)
      + COALESCE((SELECT COUNT(*) FROM customer_payments WHERE created_by = $1), 0)
      + COALESCE((SELECT COUNT(*) FROM expenses WHERE created_by = $1), 0)
      + COALESCE((SELECT COUNT(*) FROM sale_returns WHERE created_by = $1), 0)
      + COALESCE((SELECT COUNT(*) FROM waste_entries WHERE created_by = $1), 0) AS transaction_count
    `,
    [userId]
  );
  return Number(result.rows[0]?.transaction_count || 0);
};

app.get("/users", async (req, res) => {
  try {
    const manager = await requireRateManager(req.query.updated_by || req.query.user_id);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can view users" });
    const result = await pool.query(
      `
      SELECT
        u.id, u.full_name, u.username, u.mobile_number, u.email, u.active,
        u.joining_date, u.notes, u.last_login_at, u.created_at, u.updated_at,
        r.role_name AS role, b.branch_name AS branch
      FROM users u
      LEFT JOIN roles r ON r.id = u.role_id
      LEFT JOIN branches b ON b.id = u.branch_id
      ORDER BY u.active DESC, u.full_name
      `
    );
    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Users" });
  }
});

app.post("/users", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can add users" });
    const payload = readUserPayload(req.body);
    const password = String(req.body.password || "");
    const confirmPassword = String(req.body.confirm_password || "");
    const roleId = await getRoleIdByName(payload.role);
    if (!payload.full_name || !payload.username || !roleId || password.length < 4 || password !== confirmPassword) {
      return res.status(400).json({ message: "Enter valid user details and matching password" });
    }
    const duplicateMessage = await findDuplicateUser(payload);
    if (duplicateMessage) return res.status(409).json({ message: duplicateMessage });
    const result = await pool.query(
      `
      INSERT INTO users (
        full_name, username, password_hash, role_id, branch_id, active,
        mobile_number, email, joining_date, notes, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
      RETURNING id, full_name, username, mobile_number, email, active, joining_date, notes, created_at, updated_at
      `,
      [
        payload.full_name, payload.username, hashPassword(password), roleId,
        parsePositiveInteger(req.body.branch_id) || manager.branch_id || 1,
        payload.active, payload.mobile_number, payload.email, payload.joining_date, payload.notes,
      ]
    );
    return res.status(201).json({ ...result.rows[0], role: payload.role });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Saving User" });
  }
});

app.put("/users/:id", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    const userId = parsePositiveInteger(req.params.id);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can edit users" });
    if (!userId) return res.status(400).json({ message: "Invalid user" });
    const payload = readUserPayload(req.body);
    const roleId = await getRoleIdByName(payload.role);
    if (!payload.full_name || !payload.username || !roleId) {
      return res.status(400).json({ message: "Enter valid user details" });
    }
    const duplicateMessage = await findDuplicateUser({ ...payload, userId });
    if (duplicateMessage) return res.status(409).json({ message: duplicateMessage });
    const result = await pool.query(
      `
      UPDATE users
      SET full_name = $1, username = $2, role_id = $3, active = $4,
          mobile_number = $5, email = $6, joining_date = $7, notes = $8,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $9
      RETURNING id, full_name, username, mobile_number, email, active, joining_date, notes, last_login_at, created_at, updated_at
      `,
      [payload.full_name, payload.username, roleId, payload.active, payload.mobile_number, payload.email, payload.joining_date, payload.notes, userId]
    );
    return result.rows[0] ? res.json({ ...result.rows[0], role: payload.role }) : res.status(404).json({ message: "User not found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating User" });
  }
});

app.put("/users/:id/password", async (req, res) => {
  try {
    const userId = parsePositiveInteger(req.params.id);
    const actorId = parsePositiveInteger(req.body.updated_by);
    const manager = await requireRateManager(actorId);
    const password = String(req.body.password || "");
    const confirmPassword = String(req.body.confirm_password || "");
    if (!userId || (!manager && actorId !== userId)) return res.status(403).json({ message: "Not allowed to change this password" });
    if (password.length < 4 || password !== confirmPassword) return res.status(400).json({ message: "Enter matching password with at least 4 characters" });
    const result = await pool.query(
      "UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id",
      [hashPassword(password), userId]
    );
    return result.rows[0] ? res.json({ success: true }) : res.status(404).json({ message: "User not found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating Password" });
  }
});

app.post("/users/:id/deactivate", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    const userId = parsePositiveInteger(req.params.id);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can deactivate users" });
    if (!userId || userId === manager.id) return res.status(400).json({ message: "Invalid user deactivation request" });
    const result = await pool.query("UPDATE users SET active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id", [userId]);
    return result.rows[0] ? res.json({ success: true }) : res.status(404).json({ message: "User not found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Deactivating User" });
  }
});

app.post("/users/:id/reactivate", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    const userId = parsePositiveInteger(req.params.id);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can reactivate users" });
    const result = await pool.query("UPDATE users SET active = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id", [userId]);
    return result.rows[0] ? res.json({ success: true }) : res.status(404).json({ message: "User not found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Reactivating User" });
  }
});

app.delete("/users/:id", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    const userId = parsePositiveInteger(req.params.id);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can delete users" });
    if (!userId || userId === manager.id) return res.status(400).json({ message: "Invalid user delete request" });
    const transactionCount = await getUserTransactionCount(userId);
    if (transactionCount > 0) {
      await pool.query("UPDATE users SET active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [userId]);
      return res.json({ success: true, deactivated: true, message: "User has transaction history and was deactivated instead of deleted." });
    }
    const result = await pool.query("DELETE FROM users WHERE id = $1 RETURNING id", [userId]);
    return result.rows[0] ? res.json({ success: true, deleted: true }) : res.status(404).json({ message: "User not found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Deleting User" });
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
        u.mobile_number,
        u.email,
        u.joining_date,
        u.notes,
        u.last_login_at,
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
    if (!passwordMatches(password, user.password_hash)) {
      return res.status(401).json({ message: "Invalid password" });
    }
    const hashed = hashPassword(password);
    await pool.query(
      "UPDATE users SET password_hash = $1, last_login_at = CURRENT_TIMESTAMP WHERE id = $2",
      [hashed, user.id]
    );

    return res.json({
      id: user.id,
      full_name: user.full_name,
      username: user.username,
      role: user.role_name,
      branch_id: user.branch_id,
      branch: user.branch_name,
      mobile_number: user.mobile_number,
      email: user.email,
      joining_date: user.joining_date,
      notes: user.notes,
      last_login_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Login Error" });
  }
});

app.get("/product-categories", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        pc.*,
        COUNT(p.id)::INTEGER AS item_count,
        COALESCE(SUM(CASE WHEN p.active IS DISTINCT FROM FALSE THEN 1 ELSE 0 END), 0)::INTEGER AS active_item_count
      FROM product_categories pc
      LEFT JOIN products p ON p.category_id = pc.id
      GROUP BY pc.id
      ORDER BY pc.active DESC, pc.category_name
      `
    );
    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Database Error" });
  }
});

app.post("/product-categories", async (req, res) => {
  const client = await pool.connect();
  try {
    const manager = await requireRateManager(req.body.created_by || req.body.updated_by, client);
    const categoryName = cleanText(req.body.category_name);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage categories" });
    if (!categoryName) return res.status(400).json({ message: "Please enter category name." });
    await client.query("BEGIN");
    const duplicate = await findCategoryByName(client, categoryName);
    if (duplicate) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "Category already exists." });
    }
    const result = await client.query(
      `
      INSERT INTO product_categories (category_name, active, remarks, created_by, updated_by)
      VALUES ($1, $2, $3, $4, $4)
      RETURNING *
      `,
      [categoryName, req.body.active !== false, nullableText(req.body.remarks), manager.id]
    );
    await client.query(
      `
      INSERT INTO product_category_audit_trail (category_id, action, old_value, new_value, reason, edited_by)
      VALUES ($1, 'CREATE', NULL, $2::jsonb, $3, $4)
      `,
      [result.rows[0].id, JSON.stringify(result.rows[0]), cleanText(req.body.reason) || "Category created", manager.id]
    );
    await client.query("COMMIT");
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    if (error.code === "23505") return res.status(409).json({ message: "Category already exists." });
    return res.status(500).json({ message: "Error Saving Category" });
  } finally {
    client.release();
  }
});

app.put("/product-categories/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const categoryId = parsePositiveInteger(req.params.id);
    const manager = await requireRateManager(req.body.updated_by, client);
    const categoryName = cleanText(req.body.category_name);
    const reason = cleanText(req.body.reason) || "Category updated";
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage categories" });
    if (!categoryId || !categoryName) return res.status(400).json({ message: "Please enter category name." });
    await client.query("BEGIN");
    const currentResult = await client.query("SELECT * FROM product_categories WHERE id = $1 FOR UPDATE", [categoryId]);
    const current = currentResult.rows[0];
    if (!current) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Category not found" });
    }
    const duplicate = await client.query("SELECT id FROM product_categories WHERE LOWER(category_name) = LOWER($1) AND id <> $2 LIMIT 1", [categoryName, categoryId]);
    if (duplicate.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "Category already exists." });
    }
    const result = await client.query(
      `
      UPDATE product_categories
      SET category_name = $1, active = $2, remarks = $3, updated_by = $4, updated_at = CURRENT_TIMESTAMP
      WHERE id = $5
      RETURNING *
      `,
      [categoryName, req.body.active !== false, nullableText(req.body.remarks), manager.id, categoryId]
    );
    await client.query("UPDATE products SET category = $1 WHERE category_id = $2", [categoryName, categoryId]);
    await client.query(
      `
      INSERT INTO product_category_audit_trail (category_id, action, old_value, new_value, reason, edited_by)
      VALUES ($1, 'EDIT', $2::jsonb, $3::jsonb, $4, $5)
      `,
      [categoryId, JSON.stringify(current), JSON.stringify(result.rows[0]), reason, manager.id]
    );
    await client.query("COMMIT");
    return res.json(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    if (error.code === "23505") return res.status(409).json({ message: "Category already exists." });
    return res.status(500).json({ message: "Error Updating Category" });
  } finally {
    client.release();
  }
});

app.delete("/product-categories/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const categoryId = parsePositiveInteger(req.params.id);
    const manager = await requireRateManager(req.body?.updated_by || req.query.updated_by, client);
    const reason = cleanText(req.body?.reason || req.query.reason) || "Category removed";
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage categories" });
    if (!categoryId) return res.status(400).json({ message: "Invalid category" });
    await client.query("BEGIN");
    const currentResult = await client.query("SELECT * FROM product_categories WHERE id = $1 FOR UPDATE", [categoryId]);
    const current = currentResult.rows[0];
    if (!current) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Category not found" });
    }
    const usageResult = await client.query("SELECT COUNT(*)::INTEGER AS usage_count FROM products WHERE category_id = $1", [categoryId]);
    if (Number(usageResult.rows[0].usage_count || 0) > 0) {
      const result = await client.query("UPDATE product_categories SET active = FALSE, updated_by = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *", [manager.id, categoryId]);
      await client.query(
        `
        INSERT INTO product_category_audit_trail (category_id, action, old_value, new_value, reason, edited_by)
        VALUES ($1, 'DEACTIVATE', $2::jsonb, $3::jsonb, $4, $5)
        `,
        [categoryId, JSON.stringify(current), JSON.stringify(result.rows[0]), "This category has items or transactions. It can only be deactivated.", manager.id]
      );
      await client.query("COMMIT");
      return res.status(409).json({ message: "This category has items or transactions. It can only be deactivated.", category: result.rows[0] });
    }
    await client.query("DELETE FROM product_categories WHERE id = $1", [categoryId]);
    await client.query(
      `
      INSERT INTO product_category_audit_trail (category_id, action, old_value, new_value, reason, edited_by)
      VALUES ($1, 'DELETE', $2::jsonb, NULL, $3, $4)
      `,
      [null, JSON.stringify(current), reason, manager.id]
    );
    await client.query("COMMIT");
    return res.json({ success: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Removing Category" });
  } finally {
    client.release();
  }
});

app.get("/product-duplicate-archive-log", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        log.*,
        archived.product_name AS archived_product_name,
        archived.category AS archived_category,
        kept.product_name AS kept_product_name,
        kept.category AS kept_category
      FROM product_duplicate_archive_log log
      LEFT JOIN products archived ON archived.id = log.duplicate_product_id
      LEFT JOIN products kept ON kept.id = log.kept_product_id
      ORDER BY log.archived_at DESC, log.id DESC
      LIMIT 50
      `
    );
    return res.json({
      count: result.rows.length,
      message: result.rows.length ? "Duplicate products were archived. Review product master." : "",
      rows: result.rows,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Product Duplicate Archive Log" });
  }
});

app.get("/products", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        p.*,
        pc.category_name,
        COALESCE(stock.current_stock, 0) AS current_stock,
        COALESCE(stock.lot_count, 0) AS lot_count
      FROM products p
      LEFT JOIN product_categories pc ON pc.id = p.category_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::INTEGER AS lot_count, SUM(remaining_qty) AS current_stock
        FROM inventory_batches ib
        WHERE ib.product_id = p.id
          AND COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED'
      ) stock ON TRUE
      ORDER BY COALESCE(pc.category_name, p.category, 'Fruit'), p.product_name
    `);
    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Database Error" });
  }
});

app.post("/products", async (req, res) => {
  const client = await pool.connect();
  try {
    const { product_name, selling_rate, unit, barcode, origin_type, category, category_id, minimum_stock, active, created_by, remarks, branch_id } = req.body;
    const parsedSellingRate = parsePositiveNumber(selling_rate);
    const parsedMinimumStock = parseNonNegativeNumber(minimum_stock);
    const parsedOriginType = String(origin_type || "LOCAL").toUpperCase();
    const parsedUnit = normalizeProductUnit(unit);
    const rateManager = await requireRateManager(created_by, client);

    if (!rateManager) return res.status(403).json({ message: "Only Owner or Admin can create owner-approved selling rates" });
    if (!product_name?.trim() || !parsedUnit || !parsedSellingRate || parsedMinimumStock === null || !["LOCAL", "IMPORTED"].includes(parsedOriginType)) {
      return res.status(400).json({ message: "Enter valid product details" });
    }
    await client.query("BEGIN");
    let selectedCategory = await getCategoryById(client, parsePositiveInteger(category_id));
    if (!selectedCategory) {
      selectedCategory = await findCategoryByName(client, category || "Fruit");
    }
    if (!selectedCategory) {
      const categoryResult = await client.query(
        "INSERT INTO product_categories (category_name, active, created_by, updated_by) VALUES ($1, TRUE, $2, $2) RETURNING *",
        [cleanText(category || "Fruit"), rateManager.id]
      );
      selectedCategory = categoryResult.rows[0];
    }
    if (selectedCategory.active === false) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Selected category is inactive." });
    }
    const duplicateResult = await client.query(
      "SELECT id FROM products WHERE LOWER(product_name) = LOWER($1) AND active IS DISTINCT FROM FALSE LIMIT 1",
      [product_name.trim()]
    );
    if (duplicateResult.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "This product already exists." });
    }

    const result = await client.query(
      `
      INSERT INTO products (
        product_name, selling_rate, unit, barcode, origin_type, category, category_id,
        minimum_stock, active, remarks, selling_rate_updated_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
      `,
      [
        product_name.trim(), parsedSellingRate, parsedUnit, barcode?.trim() || null, parsedOriginType,
        selectedCategory.category_name, selectedCategory.id, parsedMinimumStock, active !== false,
        nullableText(remarks), rateManager.id,
      ]
    );
    const product = result.rows[0];
    await client.query(
      `
      INSERT INTO product_audit_trail (product_id, action, old_value, new_value, reason, edited_by)
      VALUES ($1, 'CREATE', NULL, $2::jsonb, $3, $4)
      `,
      [product.id, JSON.stringify(product), "Product item created", rateManager.id]
    );
    const openingLots = Array.isArray(req.body.opening_stock_lots) ? req.body.opening_stock_lots : [];
    const createdLots = [];
    for (const lot of openingLots) {
      const lotResult = await insertOpeningStockLot(client, {
        product,
        lot,
        actorId: rateManager.id,
        branchId: parsePositiveInteger(branch_id) || 1,
      });
      if (lotResult.error) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: lotResult.error });
      }
      createdLots.push(lotResult.batch);
    }
    await client.query("COMMIT");
    return res.status(201).json({ ...product, opening_stock_lots: createdLots });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    if (error.code === "23505") {
      return res.status(409).json({ message: "This product already exists." });
    }
    return res.status(500).json({ message: "Error Adding Product" });
  } finally {
    client.release();
  }
});

app.put("/products/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const productId = parsePositiveInteger(req.params.id);
    const { product_name, selling_rate, unit, barcode, origin_type, category, category_id, minimum_stock, active, updated_by, rate_change_reason, remarks } = req.body;
    const parsedSellingRate = parsePositiveNumber(selling_rate);
    const parsedMinimumStock = parseNonNegativeNumber(minimum_stock);
    const parsedOriginType = String(origin_type || "").toUpperCase();
    const parsedUnit = normalizeProductUnit(unit);

    if (!productId || !product_name?.trim() || !parsedUnit || !parsedSellingRate || parsedMinimumStock === null || !["LOCAL", "IMPORTED"].includes(parsedOriginType)) {
      return res.status(400).json({ message: "Enter valid product details" });
    }

    await client.query("BEGIN");
    const currentResult = await client.query("SELECT * FROM products WHERE id = $1 FOR UPDATE", [productId]);
    if (currentResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Product not found" });
    }
    const current = currentResult.rows[0];
    let selectedCategory = await getCategoryById(client, parsePositiveInteger(category_id));
    if (!selectedCategory) {
      selectedCategory = await findCategoryByName(client, category || current.category || "Fruit");
    }
    if (!selectedCategory || selectedCategory.active === false) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Selected category is inactive or missing." });
    }
    const duplicateResult = await client.query(
      "SELECT id FROM products WHERE LOWER(product_name) = LOWER($1) AND id <> $2 AND active IS DISTINCT FROM FALSE LIMIT 1",
      [product_name.trim(), productId]
    );
    if (duplicateResult.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "This product already exists." });
    }
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
        origin_type = $5, category = $6, category_id = $7, minimum_stock = $8, active = $9,
        remarks = $10,
        selling_rate_updated_at = CASE WHEN selling_rate <> $2 THEN CURRENT_TIMESTAMP ELSE selling_rate_updated_at END,
        selling_rate_updated_by = CASE WHEN selling_rate <> $2 THEN $11 ELSE selling_rate_updated_by END
      WHERE id = $12
      RETURNING *
      `,
      [
        product_name.trim(), parsedSellingRate, parsedUnit, barcode?.trim() || null,
        parsedOriginType, selectedCategory.category_name, selectedCategory.id, parsedMinimumStock, active !== false,
        nullableText(remarks), rateManager?.id || null, productId,
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
    await client.query(
      `
      INSERT INTO product_audit_trail (product_id, action, old_value, new_value, reason, edited_by)
      VALUES ($1, 'EDIT', $2::jsonb, $3::jsonb, $4, $5)
      `,
      [productId, JSON.stringify(current), JSON.stringify(result.rows[0]), rate_change_reason?.trim() || "Product master update", parsePositiveInteger(updated_by) || rateManager?.id || null]
    );
    await client.query("COMMIT");
    return res.json(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    if (error.code === "23505") {
      return res.status(409).json({ message: "This product already exists." });
    }
    return res.status(500).json({ message: "Error Updating Product" });
  } finally {
    client.release();
  }
});

app.post("/products/:id/opening-stock", async (req, res) => {
  const client = await pool.connect();
  try {
    const productId = parsePositiveInteger(req.params.id);
    const manager = await requireRateManager(req.body.created_by || req.body.updated_by, client);
    const lots = Array.isArray(req.body.opening_stock_lots) ? req.body.opening_stock_lots : [req.body];
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can add opening stock" });
    if (!productId || lots.length === 0) return res.status(400).json({ message: "Please add opening stock lots." });
    await client.query("BEGIN");
    const productResult = await client.query("SELECT * FROM products WHERE id = $1 AND active IS DISTINCT FROM FALSE FOR UPDATE", [productId]);
    const product = productResult.rows[0];
    if (!product) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Product not found" });
    }
    const createdLots = [];
    for (const lot of lots) {
      const lotResult = await insertOpeningStockLot(client, {
        product,
        lot,
        actorId: manager.id,
        branchId: parsePositiveInteger(req.body.branch_id) || 1,
      });
      if (lotResult.error) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: lotResult.error });
      }
      createdLots.push(lotResult.batch);
    }
    await client.query("COMMIT");
    return res.status(201).json({ success: true, lots: createdLots });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Adding Opening Stock" });
  } finally {
    client.release();
  }
});

app.post("/products/:id/cancel", async (req, res) => {
  const client = await pool.connect();
  try {
    const productId = parsePositiveInteger(req.params.id);
    const userId = parsePositiveInteger(req.body.cancelled_by) || parsePositiveInteger(req.body.updated_by);
    const reason = cleanText(req.body.reason);
    const manager = await requireRateManager(userId, client);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can deactivate products" });
    if (!productId || !reason) return res.status(400).json({ message: "Reason is required" });
    await client.query("BEGIN");
    const productResult = await client.query("SELECT * FROM products WHERE id = $1 FOR UPDATE", [productId]);
    const product = productResult.rows[0];
    if (!product) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Product not found" });
    }
    const usageResult = await client.query(
      `
      SELECT
        COALESCE((SELECT COUNT(*) FROM purchase_items WHERE product_id = $1), 0)
        + COALESCE((SELECT COUNT(*) FROM sale_items WHERE product_id = $1), 0)
        + COALESCE((SELECT COUNT(*) FROM inventory_batches WHERE product_id = $1), 0)
        + COALESCE((SELECT COUNT(*) FROM sale_return_items WHERE product_id = $1), 0)
        + COALESCE((SELECT COUNT(*) FROM waste_entries WHERE product_id = $1), 0) AS usage_count
      `,
      [productId]
    );
    const result = await client.query("UPDATE products SET active = FALSE WHERE id = $1 RETURNING *", [productId]);
    await client.query(
      `
      INSERT INTO product_audit_trail (product_id, action, old_value, new_value, reason, edited_by)
      VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)
      `,
      [productId, Number(usageResult.rows[0].usage_count || 0) > 0 ? "DEACTIVATE" : "CANCEL", JSON.stringify(product), JSON.stringify(result.rows[0]), reason, manager.id]
    );
    await client.query("COMMIT");
    return res.json({ success: true, product: result.rows[0], had_transactions: Number(usageResult.rows[0].usage_count || 0) > 0 });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Cancelling Product" });
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
        p.category,
        p.category_id,
        p.unit,
        p.barcode,
        ib.batch_no,
        ib.lot_name,
        ib.lot_size,
        ib.stock_source,
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
        ib.remarks,
        ib.purchase_date
      FROM inventory_batches ib
      JOIN products p ON p.id = ib.product_id
      WHERE COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED'
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
        p.category,
        p.category_id,
        p.barcode,
        p.unit,
        COALESCE(SUM(ib.remaining_qty), 0) AS current_stock
      FROM products p
      LEFT JOIN inventory_batches ib ON ib.product_id = p.id
        AND COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED'
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
        COALESCE(stock.pending_bill_stock, 0) AS pending_bill_stock,
        COALESCE(stock.temporary_sale_rate, 0) AS temporary_sale_rate,
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
          AND COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED'
        ORDER BY ib.purchase_date DESC, ib.created_at DESC, ib.id DESC
        LIMIT 1
      ) latest ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          SUM(ib.remaining_qty) AS current_stock,
          SUM(CASE WHEN COALESCE(ib.purchase_bill_status, 'BILL_COMPLETED') = 'BILL_PENDING' THEN ib.remaining_qty ELSE 0 END) AS pending_bill_stock,
          MAX(CASE WHEN COALESCE(ib.purchase_bill_status, 'BILL_COMPLETED') = 'BILL_PENDING' THEN ib.temporary_sale_rate ELSE 0 END) AS temporary_sale_rate
        FROM inventory_batches ib
        WHERE ib.product_id = p.id
          AND COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED'
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

const getUnifiedPaymentRows = async ({ accountKey } = {}) => {
  const filters = [];
  const supplierFilters = [];
  const customerValues = [];
  const supplierValues = [];
  if (accountKey) {
    const [source, idValue] = String(accountKey).split("-");
    const sourceId = parsePositiveInteger(Number(idValue));
    if (source === "CUSTOMER" && sourceId) {
      customerValues.push(sourceId);
      filters.push(`cp.customer_id = $${customerValues.length}`);
      supplierFilters.push("FALSE");
    } else if (source === "SUPPLIER" && sourceId) {
      supplierValues.push(sourceId);
      supplierFilters.push(`sp.supplier_id = $${supplierValues.length}`);
      filters.push("FALSE");
    } else {
      filters.push("FALSE");
      supplierFilters.push("FALSE");
    }
  }
  const customerWhere = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const supplierWhere = supplierFilters.length ? `WHERE ${supplierFilters.join(" AND ")}` : "";
  const [customerResult, supplierResult] = await Promise.all([
    pool.query(
      `
      SELECT
        'CUSTOMER-' || cp.id AS payment_key,
        'CUSTOMER' AS payment_source,
        cp.id,
        'CUSTOMER-' || c.id AS account_key,
        c.customer_name AS account_name,
        c.customer_type AS account_type,
        cp.payment_date,
        cp.payment_amount,
        0::NUMERIC AS rebate_amount,
        cp.payment_mode,
        cp.reference_number,
        cp.remarks,
        cp.cancelled,
        cp.cancelled_at,
        cp.cancellation_reason,
        cp.edited_at,
        cp.edit_reason,
        cp.created_at
      FROM customer_payments cp
      JOIN customers c ON c.id = cp.customer_id
      ${customerWhere}
      ORDER BY cp.payment_date DESC, cp.created_at DESC, cp.id DESC
      LIMIT 250
      `,
      customerValues
    ),
    pool.query(
      `
      SELECT
        'SUPPLIER-' || sp.id AS payment_key,
        'SUPPLIER' AS payment_source,
        sp.id,
        'SUPPLIER-' || s.id AS account_key,
        s.supplier_name AS account_name,
        s.supplier_type AS account_type,
        sp.payment_date,
        sp.payment_amount,
        sp.rebate_amount,
        sp.payment_mode,
        sp.reference_number,
        sp.remarks,
        sp.cancelled,
        sp.cancelled_at,
        sp.cancellation_reason,
        sp.edited_at,
        sp.edit_reason,
        sp.created_at
      FROM supplier_payments sp
      JOIN suppliers s ON s.id = sp.supplier_id
      ${supplierWhere}
      ORDER BY sp.payment_date DESC, sp.created_at DESC, sp.id DESC
      LIMIT 250
      `,
      supplierValues
    ),
  ]);
  return [...customerResult.rows, ...supplierResult.rows]
    .sort((left, right) => new Date(right.created_at) - new Date(left.created_at))
    .slice(0, 250);
};

const getReportDateRange = (query = {}) => {
  const today = new Date();
  const end = new Date(today);
  const start = new Date(today);
  const range = String(query.range || "today").toLowerCase();
  if (isDateInput(query.date_from) && isDateInput(query.date_to) && query.date_from <= query.date_to) {
    return { dateFrom: query.date_from, dateTo: query.date_to, range: "custom" };
  }
  if (range === "yesterday") {
    start.setDate(today.getDate() - 1);
    end.setDate(today.getDate() - 1);
  } else if (range === "week") {
    const day = today.getDay() || 7;
    start.setDate(today.getDate() - day + 1);
  } else if (range === "month") {
    start.setDate(1);
  }
  return { dateFrom: toDateKey(start), dateTo: toDateKey(end), range };
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
      const duplicate = await pool.query(
        "SELECT id FROM customers WHERE LOWER(customer_name) = LOWER($1) AND COALESCE(mobile_number, '') = COALESCE($2, '') LIMIT 1",
        [account.account_name, account.mobile_number]
      );
      if (duplicate.rows.length) return res.status(409).json({ message: "This customer already exists." });
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
      const duplicate = await pool.query(
        `
        SELECT id
        FROM suppliers
        WHERE LOWER(supplier_name) = LOWER($1)
           OR ($2::TEXT IS NOT NULL AND LOWER(COALESCE(firm_name, '')) = LOWER($2))
        LIMIT 1
        `,
        [account.account_name, account.firm_name]
      );
      if (duplicate.rows.length) return res.status(409).json({ message: "This supplier already exists." });
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
    if (error.code === "23505") {
      return res.status(409).json({ message: "This customer/supplier already exists." });
    }
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
      const existingCustomer = await pool.query("SELECT id, system_account FROM customers WHERE id = $1", [sourceId]);
      if (existingCustomer.rows[0]?.system_account === true && (account.account_name !== "Walk-in Customer" || account.active !== true)) {
        return res.status(400).json({ message: "Walk-in Customer is a protected system account." });
      }
      const duplicate = await pool.query(
        "SELECT id FROM customers WHERE id <> $3 AND LOWER(customer_name) = LOWER($1) AND COALESCE(mobile_number, '') = COALESCE($2, '') LIMIT 1",
        [account.account_name, account.mobile_number, sourceId]
      );
      if (duplicate.rows.length) return res.status(409).json({ message: "This customer already exists." });
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
      const duplicate = await pool.query(
        `
        SELECT id
        FROM suppliers
        WHERE id <> $3
          AND (
            LOWER(supplier_name) = LOWER($1)
            OR ($2::TEXT IS NOT NULL AND LOWER(COALESCE(firm_name, '')) = LOWER($2))
          )
        LIMIT 1
        `,
        [account.account_name, account.firm_name, sourceId]
      );
      if (duplicate.rows.length) return res.status(409).json({ message: "This supplier already exists." });
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
    if (error.code === "23505") {
      return res.status(409).json({ message: "This customer/supplier already exists." });
    }
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
            COALESCE(s.invoice_no, 'Sale #' || s.id) AS invoice_no,
            s.total_amount AS sale_amount,
            s.payment_mode,
            s.total_amount AS debit,
            COALESCE(pay.total_paid, 0) AS credit,
            s.total_amount - COALESCE(pay.total_paid, 0) AS delta,
            COALESCE(s.customer_name, c.customer_name, 'Walk-in Customer') || ' - ' || COALESCE(s.invoice_no, 'Sale #' || s.id) AS remarks,
            s.created_at
          FROM sales s
          JOIN customers c ON c.id = $1
          LEFT JOIN (
            SELECT sale_id, SUM(amount) AS total_paid
            FROM sale_payments
            GROUP BY sale_id
          ) pay ON pay.sale_id = s.id
          WHERE s.sale_status <> 'CANCELLED'
            AND (
              s.customer_id = $1
              OR (s.customer_id IS NULL AND s.customer_mobile IS NOT NULL AND s.customer_mobile = $2)
              OR (s.customer_id IS NULL AND c.system_account = TRUE AND (s.customer_name IS NULL OR LOWER(COALESCE(s.customer_name, '')) LIKE '%walk-in%'))
              OR (s.customer_id IS NULL AND c.system_account IS DISTINCT FROM TRUE AND s.customer_mobile IS NULL AND s.customer_name IS NOT NULL AND LOWER(s.customer_name) = LOWER($3))
            )
          UNION ALL
          SELECT cp.payment_date AS date, 'Customer Payment' AS transaction_type,
            COALESCE(cp.reference_number, '') AS invoice_no,
            0::NUMERIC AS sale_amount,
            cp.payment_mode,
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
          invoice_no: row.invoice_no || "",
          transaction_type: row.transaction_type,
          sale_amount: Number(row.sale_amount || 0),
          payment_mode: row.payment_mode || "",
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
              AND COALESCE(p.purchase_status, 'ACTIVE') <> 'CANCELLED'
              AND COALESCE(p.purchase_bill_status, 'BILL_COMPLETED') = 'BILL_COMPLETED'
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

app.get("/accounts/payments", async (req, res) => {
  try {
    return res.json(await getUnifiedPaymentRows({ accountKey: req.query.account_key }));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Account Payments" });
  }
});

app.post("/accounts/payments", async (req, res) => {
  try {
    const accountKey = String(req.body.account_key || "");
    const [source, idValue] = accountKey.split("-");
    const sourceId = parsePositiveInteger(Number(idValue));
    const action = String(req.body.payment_action || "").toUpperCase();
    const amount = parseNonNegativeNumber(req.body.amount);
    const rebateAmount = parseNonNegativeNumber(req.body.rebate_amount);
    const paymentMode = normalizePaymentMode(req.body.payment_mode || "CASH");
    if (!sourceId || amount === null || !SUPPLIER_PAYMENT_MODES.has(paymentMode)) {
      return res.status(400).json({ message: "Enter valid account payment details" });
    }
    if (action === "RECEIVE_CUSTOMER" && source === "CUSTOMER") {
      if (amount <= 0) {
        return res.status(400).json({ message: "Customer payment amount must be greater than zero" });
      }
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
      const supplierPaymentAmount = action === "SUPPLIER_REBATE" ? 0 : amount;
      const supplierRebateAmount = action === "SUPPLIER_REBATE" ? amount : Number(rebateAmount || 0);
      if (supplierPaymentAmount + supplierRebateAmount <= 0) {
        return res.status(400).json({ message: "Enter payment amount or rebate amount" });
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
          sourceId, req.body.payment_date || toDateKey(new Date()),
          supplierPaymentAmount,
          supplierRebateAmount,
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

app.put("/accounts/payments/:paymentKey", async (req, res) => {
  const client = await pool.connect();
  try {
    const [source, idValue] = String(req.params.paymentKey || "").split("-");
    const paymentId = parsePositiveInteger(Number(idValue));
    const accountKey = String(req.body.account_key || "");
    const [accountSource, accountIdValue] = accountKey.split("-");
    const accountId = parsePositiveInteger(Number(accountIdValue));
    const paymentAmount = parseNonNegativeNumber(req.body.payment_amount ?? req.body.amount);
    const rebateAmount = parseNonNegativeNumber(req.body.rebate_amount);
    const paymentMode = normalizePaymentMode(req.body.payment_mode || "CASH");
    const editedBy = parsePositiveInteger(req.body.edited_by) || parsePositiveInteger(req.body.created_by) || 1;
    const reason = cleanText(req.body.reason);
    const paymentDate = req.body.payment_date || toDateKey(new Date());
    if (!paymentId || !accountId || !reason || paymentAmount === null || !SUPPLIER_PAYMENT_MODES.has(paymentMode)) {
      return res.status(400).json({ message: "Enter valid payment edit details and reason" });
    }
    await client.query("BEGIN");
    if (source === "CUSTOMER" && accountSource === "CUSTOMER") {
      if (paymentAmount <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Customer payment amount must be greater than zero" });
      }
      const oldResult = await client.query("SELECT * FROM customer_payments WHERE id = $1 FOR UPDATE", [paymentId]);
      const oldPayment = oldResult.rows[0];
      if (!oldPayment) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Customer payment not found" });
      }
      if (oldPayment.cancelled) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Cancelled customer payments cannot be edited" });
      }
      const result = await client.query(
        `
        UPDATE customer_payments
        SET customer_id = $1, payment_date = $2, payment_amount = $3, payment_mode = $4,
            reference_number = $5, remarks = $6, branch_id = $7,
            edited_by = $8, edited_at = CURRENT_TIMESTAMP, edit_reason = $9
        WHERE id = $10
        RETURNING *
        `,
        [
          accountId, paymentDate, paymentAmount, paymentMode, nullableText(req.body.reference_number),
          nullableText(req.body.remarks), parsePositiveInteger(req.body.branch_id), editedBy, reason, paymentId,
        ]
      );
      await client.query(
        `
        INSERT INTO customer_payment_audit (customer_payment_id, action, old_value, new_value, reason, edited_by)
        VALUES ($1, 'EDIT', $2::jsonb, $3::jsonb, $4, $5)
        `,
        [paymentId, JSON.stringify(oldPayment), JSON.stringify(result.rows[0]), reason, editedBy]
      );
      await client.query("COMMIT");
      return res.json(result.rows[0]);
    }
    if (source === "SUPPLIER" && accountSource === "SUPPLIER") {
      if (rebateAmount === null || paymentAmount + rebateAmount <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Supplier payment or rebate must be greater than zero" });
      }
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
          accountId, paymentDate, paymentAmount, rebateAmount, paymentMode, nullableText(req.body.reference_number),
          nullableText(req.body.remarks), parsePositiveInteger(req.body.branch_id), editedBy, reason, paymentId,
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
    }
    await client.query("ROLLBACK");
    return res.status(400).json({ message: "Payment type and account type do not match" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Updating Account Payment" });
  } finally {
    client.release();
  }
});

app.post("/accounts/payments/:paymentKey/cancel", async (req, res) => {
  const client = await pool.connect();
  try {
    const [source, idValue] = String(req.params.paymentKey || "").split("-");
    const paymentId = parsePositiveInteger(Number(idValue));
    const cancelledBy = parsePositiveInteger(req.body.cancelled_by) || 1;
    const reason = cleanText(req.body.reason);
    if (!paymentId || !reason) return res.status(400).json({ message: "Cancellation reason is required" });
    await client.query("BEGIN");
    if (source === "CUSTOMER") {
      const oldResult = await client.query("SELECT * FROM customer_payments WHERE id = $1 FOR UPDATE", [paymentId]);
      const oldPayment = oldResult.rows[0];
      if (!oldPayment) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Customer payment not found" });
      }
      if (oldPayment.cancelled) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Customer payment is already cancelled" });
      }
      const result = await client.query(
        `
        UPDATE customer_payments
        SET cancelled = TRUE, cancelled_by = $1, cancelled_at = CURRENT_TIMESTAMP, cancellation_reason = $2
        WHERE id = $3
        RETURNING *
        `,
        [cancelledBy, reason, paymentId]
      );
      await client.query(
        `
        INSERT INTO customer_payment_audit (customer_payment_id, action, old_value, new_value, reason, edited_by)
        VALUES ($1, 'CANCEL', $2::jsonb, $3::jsonb, $4, $5)
        `,
        [paymentId, JSON.stringify(oldPayment), JSON.stringify(result.rows[0]), reason, cancelledBy]
      );
      await client.query("COMMIT");
      return res.json({ success: true, payment: result.rows[0] });
    }
    if (source === "SUPPLIER") {
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
    }
    await client.query("ROLLBACK");
    return res.status(400).json({ message: "Invalid payment" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Cancelling Account Payment" });
  } finally {
    client.release();
  }
});

app.get("/accounts/payments/:paymentKey/audit", async (req, res) => {
  try {
    const [source, idValue] = String(req.params.paymentKey || "").split("-");
    const paymentId = parsePositiveInteger(Number(idValue));
    if (!paymentId) return res.json([]);
    if (source === "CUSTOMER") {
      const result = await pool.query(
        `
        SELECT cpa.*, u.full_name AS edited_by_name
        FROM customer_payment_audit cpa
        LEFT JOIN users u ON u.id = cpa.edited_by
        WHERE cpa.customer_payment_id = $1
        ORDER BY cpa.edited_at DESC, cpa.id DESC
        `,
        [paymentId]
      );
      return res.json(result.rows);
    }
    if (source === "SUPPLIER") {
      const result = await pool.query(
        `
        SELECT spa.*, u.full_name AS edited_by_name
        FROM supplier_payment_audit spa
        LEFT JOIN users u ON u.id = spa.edited_by
        WHERE spa.supplier_payment_id = $1
        ORDER BY spa.edited_at DESC, spa.id DESC
        `,
        [paymentId]
      );
      return res.json(result.rows);
    }
    return res.json([]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Payment Audit" });
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
    const duplicate = await pool.query(
      `
      SELECT id
      FROM suppliers
      WHERE LOWER(supplier_name) = LOWER($1)
         OR ($2::TEXT IS NOT NULL AND LOWER(COALESCE(firm_name, '')) = LOWER($2))
      LIMIT 1
      `,
      [supplier.supplier_name, supplier.firm_name]
    );
    if (duplicate.rows.length) return res.status(409).json({ message: "This supplier already exists." });

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
    if (error.code === "23505") return res.status(409).json({ message: "This supplier already exists." });
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
    const duplicate = await pool.query(
      `
      SELECT id
      FROM suppliers
      WHERE id <> $3
        AND (
          LOWER(supplier_name) = LOWER($1)
          OR ($2::TEXT IS NOT NULL AND LOWER(COALESCE(firm_name, '')) = LOWER($2))
        )
      LIMIT 1
      `,
      [supplier.supplier_name, supplier.firm_name, supplierId]
    );
    if (duplicate.rows.length) return res.status(409).json({ message: "This supplier already exists." });

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
    if (error.code === "23505") return res.status(409).json({ message: "This supplier already exists." });
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
    const duplicate = await pool.query(
      "SELECT id FROM customers WHERE LOWER(customer_name) = LOWER($1) AND COALESCE(mobile_number, '') = COALESCE($2, '') LIMIT 1",
      [customer.customer_name, customer.mobile_number]
    );
    if (duplicate.rows.length) return res.status(409).json({ message: "This customer already exists." });
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
    if (error.code === "23505") return res.status(409).json({ message: "This customer already exists." });
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
    const existingCustomer = await pool.query("SELECT id, system_account FROM customers WHERE id = $1", [customerId]);
    if (existingCustomer.rows[0]?.system_account === true && (customer.customer_name !== "Walk-in Customer" || customer.active !== true)) {
      return res.status(400).json({ message: "Walk-in Customer is a protected system account." });
    }
    const duplicate = await pool.query(
      "SELECT id FROM customers WHERE id <> $3 AND LOWER(customer_name) = LOWER($1) AND COALESCE(mobile_number, '') = COALESCE($2, '') LIMIT 1",
      [customer.customer_name, customer.mobile_number, customerId]
    );
    if (duplicate.rows.length) return res.status(409).json({ message: "This customer already exists." });
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
    if (error.code === "23505") return res.status(409).json({ message: "This customer already exists." });
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
          s.customer_id = c.id
          OR (s.customer_id IS NULL AND s.customer_mobile IS NOT NULL AND c.mobile_number = s.customer_mobile)
          OR (s.customer_id IS NULL AND c.system_account = TRUE AND (s.customer_name IS NULL OR LOWER(COALESCE(s.customer_name, '')) LIKE '%walk-in%'))
          OR (s.customer_id IS NULL AND c.system_account IS DISTINCT FROM TRUE AND s.customer_mobile IS NULL AND s.customer_name IS NOT NULL AND LOWER(c.customer_name) = LOWER(s.customer_name))
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
          invoice_no: sale.invoice_no || `Sale #${sale.id}`,
          sale_amount: Number(sale.total_amount || 0),
          payment_mode: sale.payment_mode || "",
          debit_amount: Number(sale.total_amount || 0),
          credit_amount: 0,
          balance_delta: Number(sale.total_amount || 0),
          remarks: `${sale.customer_name || "Walk-in Customer"} - ${sale.invoice_no || `Sale #${sale.id}`}`,
        });
        if (Number(sale.total_paid || 0) > 0) {
          pushEvent({
            customer_id: sale.customer_id,
            customer_name: sale.customer_name,
            transaction_date: toDateKey(sale.sale_date),
            sort_key: `S-${String(sale.id).padStart(8, "0")}-1`,
            transaction_type: "Sale Payment",
            invoice_no: sale.invoice_no || `Sale #${sale.id}`,
            sale_amount: 0,
            payment_mode: sale.payment_mode || "",
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
        invoice_no: payment.reference_number || "",
        sale_amount: 0,
        payment_mode: payment.payment_mode || "",
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
    const reportRange = getReportDateRange(req.query);
    const dateFrom = req.query.date_from || reportRange.dateFrom || "1900-01-01";
    const dateTo = req.query.date_to || reportRange.dateTo || "2999-12-31";
    const [
      salesResult,
      pendingPurchaseResult,
      stockWithoutBillResult,
      provisionalSalesResult,
      purchaseResult,
      purchaseHistoryResult,
      supplierRows,
      customerRows,
      discountResult,
      expenseResult,
      paymentResult,
      returnResult,
      returnReasonResult,
      wasteResult,
      wasteProductResult,
      stockResult,
      ledgerResult,
      dayToDayResult,
      salesProductResult,
      salesCustomerResult,
      salesHistoryResult,
      salesChangeResult,
      purchaseProductResult,
      purchaseSupplierResult,
      purchaseChangeResult,
      returnHistoryResult,
      stockMovementResult,
      balanceSheetResult,
      profitLossResult,
      paymentModeSummaryResult,
    ] = await Promise.all([
      pool.query(
        `
        SELECT
          sale_date,
          COUNT(*)::INTEGER AS transaction_count,
          SUM(total_amount) AS total_sales,
          SUM(total_cost) AS total_cost,
          SUM(profit) AS total_profit,
          COALESCE((
            SELECT SUM(sp.amount)
            FROM sale_payments sp
            JOIN sales sx ON sx.id = sp.sale_id
            WHERE sx.sale_status <> 'CANCELLED'
              AND sx.sale_date = s.sale_date
              AND sp.payment_mode = 'CASH'
          ), 0) AS cash_sales,
          COALESCE((
            SELECT SUM(sp.amount)
            FROM sale_payments sp
            JOIN sales sx ON sx.id = sp.sale_id
            WHERE sx.sale_status <> 'CANCELLED'
              AND sx.sale_date = s.sale_date
              AND sp.payment_mode = 'UPI'
          ), 0) AS upi_sales,
          COALESCE((
            SELECT SUM(sp.amount)
            FROM sale_payments sp
            JOIN sales sx ON sx.id = sp.sale_id
            WHERE sx.sale_status <> 'CANCELLED'
              AND sx.sale_date = s.sale_date
              AND sp.payment_mode IN ('CARD', 'BANK_TRANSFER')
          ), 0) AS bank_card_sales
        FROM sales s
        WHERE s.sale_status <> 'CANCELLED'
          AND s.sale_date BETWEEN $1 AND $2
        GROUP BY s.sale_date
        ORDER BY sale_date DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          p.id,
          p.purchase_date,
          p.supplier_name,
          p.temporary_sale_rate,
          p.expected_purchase_rate,
          p.remarks,
          pi.product_id,
          pr.product_name,
          pr.category,
          pr.unit,
          pi.quantity,
          COALESCE(pi.lot_name, p.lot_name, ib.lot_name) AS lot_name,
          COALESCE(pi.lot_size, p.lot_size, ib.lot_size) AS lot_size,
          ib.batch_no,
          ib.stock_source,
          ib.remaining_qty
        FROM purchases p
        LEFT JOIN purchase_items pi ON pi.purchase_id = p.id
        LEFT JOIN products pr ON pr.id = pi.product_id
        LEFT JOIN inventory_batches ib ON ib.purchase_id = p.id
        WHERE COALESCE(p.purchase_status, 'ACTIVE') <> 'CANCELLED'
          AND COALESCE(p.purchase_bill_status, 'BILL_COMPLETED') = 'BILL_PENDING'
          AND p.purchase_date BETWEEN $1 AND $2
        ORDER BY p.purchase_date DESC, p.id DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          ib.id,
          ib.batch_no,
          ib.purchase_id,
          ib.supplier_name,
          p.product_name,
          p.category,
          p.unit,
          ib.lot_name,
          ib.lot_size,
          ib.stock_source,
          ib.purchase_qty,
          ib.remaining_qty,
          ib.temporary_sale_rate,
          ib.purchase_rate AS expected_purchase_rate,
          ib.created_at::date AS arrival_date
        FROM inventory_batches ib
        JOIN products p ON p.id = ib.product_id
        WHERE COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED'
          AND COALESCE(ib.purchase_bill_status, 'BILL_COMPLETED') = 'BILL_PENDING'
          AND ib.created_at::date BETWEEN $1 AND $2
        ORDER BY ib.created_at DESC, ib.id DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          s.id,
          s.invoice_no,
          s.sale_date,
          COALESCE(s.customer_name, 'Walk-in Customer') AS customer_name,
          s.payment_mode,
          s.total_amount,
          s.total_cost,
          s.profit,
          s.profit_status,
          STRING_AGG(DISTINCT p.product_name, ', ' ORDER BY p.product_name) AS products
        FROM sales s
        JOIN sale_items si ON si.sale_id = s.id
        JOIN products p ON p.id = si.product_id
        WHERE s.sale_status <> 'CANCELLED'
          AND COALESCE(s.profit_status, 'FINAL') = 'PROVISIONAL'
          AND s.sale_date BETWEEN $1 AND $2
        GROUP BY s.id
        ORDER BY s.sale_date DESC, s.id DESC
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
          AND COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED'
          AND COALESCE(purchase_bill_status, 'BILL_COMPLETED') = 'BILL_COMPLETED'
        GROUP BY purchase_date
        ORDER BY purchase_date DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          p.id,
          p.purchase_date,
          p.supplier_id,
          p.supplier_name,
          p.purchase_status,
          p.purchase_bill_status,
          p.purchase_type,
          p.payment_mode,
          p.payment_reference_number,
          p.bill_number,
          p.bill_date,
          s.firm_name,
          p.temporary_sale_rate,
          p.expected_purchase_rate,
          p.gross_amount,
          p.mandi_tax_amount,
          p.freight_charges,
          p.labour_charges,
          p.other_charges,
          p.rebate_amount,
          p.rebate_rule_id,
          p.net_payable,
          p.paid_amount,
          p.balance_amount,
          p.remarks,
          pi.id AS item_id,
          pi.product_id,
          pi.quantity,
          pi.purchase_rate,
          COALESCE(pi.lot_name, p.lot_name, ib.lot_name) AS lot_name,
          COALESCE(pi.lot_size, p.lot_size, ib.lot_size) AS lot_size,
          pi.basic_amount AS item_basic_amount,
          pi.net_payable AS item_net_payable,
          pi.effective_cost_per_unit,
          pr.product_name,
          pr.category,
          pr.unit,
          pr.origin_type,
          ib.id AS inventory_batch_id,
          ib.batch_no,
          ib.stock_source,
          ib.purchase_qty AS batch_purchase_qty,
          ib.remaining_qty AS batch_remaining_qty,
          ib.batch_status
        FROM purchases p
        LEFT JOIN suppliers s ON s.id = p.supplier_id
        LEFT JOIN purchase_items pi ON pi.purchase_id = p.id
        LEFT JOIN products pr ON pr.id = pi.product_id
        LEFT JOIN inventory_batches ib ON ib.purchase_id = p.id
        WHERE p.purchase_date BETWEEN $1 AND $2
          AND (
            COALESCE(p.purchase_status, 'ACTIVE') = 'CANCELLED'
            OR COALESCE(p.purchase_bill_status, 'BILL_COMPLETED') = 'BILL_COMPLETED'
          )
        ORDER BY p.purchase_date DESC, p.supplier_name, p.id DESC
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
      pool.query(
        `
        SELECT
          e.id,
          e.expense_date,
          category,
          payment_mode,
          amount,
          COALESCE(e.paid_to, e.vendor_name, '') AS paid_to,
          e.vendor_name,
          e.reference_number,
          e.remarks,
          COALESCE(e.status, CASE WHEN e.active IS DISTINCT FROM FALSE THEN 'ACTIVE' ELSE 'CANCELLED' END) AS status,
          e.active,
          e.cancelled_at,
          e.cancellation_reason,
          e.edited_at,
          e.edit_reason,
          u.full_name AS created_by_name,
          eu.full_name AS edited_by_name,
          cu.full_name AS cancelled_by_name
        FROM expenses e
        LEFT JOIN users u ON u.id = e.created_by
        LEFT JOIN users eu ON eu.id = e.edited_by
        LEFT JOIN users cu ON cu.id = e.cancelled_by
        WHERE e.expense_date BETWEEN $1 AND $2
        ORDER BY e.expense_date DESC, e.created_at DESC, e.id DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT *
        FROM (
          SELECT
            cp.payment_date,
            'Customer Receipt' AS payment_type,
            c.customer_name AS party_name,
            cp.payment_amount,
            0::NUMERIC AS rebate_amount,
            cp.payment_mode,
            cp.reference_number,
            cp.remarks,
            cp.cancelled
          FROM customer_payments cp
          JOIN customers c ON c.id = cp.customer_id
          WHERE cp.payment_date BETWEEN $1 AND $2
          UNION ALL
          SELECT
            sp.payment_date,
            'Supplier Payment' AS payment_type,
            s.supplier_name AS party_name,
            sp.payment_amount,
            sp.rebate_amount,
            sp.payment_mode,
            sp.reference_number,
            sp.remarks,
            sp.cancelled
          FROM supplier_payments sp
          JOIN suppliers s ON s.id = sp.supplier_id
          WHERE sp.payment_date BETWEEN $1 AND $2
        ) payments
        ORDER BY payment_date DESC, party_name
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          sr.return_date,
          COUNT(*)::INTEGER AS return_count,
          SUM(sr.total_return_amount) AS return_value,
          SUM(item_summary.return_quantity) AS return_quantity
        FROM sale_returns sr
        LEFT JOIN (
          SELECT sale_return_id, SUM(return_quantity) AS return_quantity
          FROM sale_return_items
          GROUP BY sale_return_id
        ) item_summary ON item_summary.sale_return_id = sr.id
        WHERE sr.return_date BETWEEN $1 AND $2
        GROUP BY sr.return_date
        ORDER BY sr.return_date DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          return_reason,
          COUNT(*)::INTEGER AS return_count,
          SUM(total_return_amount) AS return_value
        FROM sale_returns
        WHERE return_date BETWEEN $1 AND $2
        GROUP BY return_reason
        ORDER BY return_count DESC, return_value DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          waste_date,
          waste_type,
          COUNT(*)::INTEGER AS entry_count,
          SUM(quantity) AS waste_quantity,
          SUM(cost_amount) AS waste_cost
        FROM waste_entries
        WHERE waste_date BETWEEN $1 AND $2
        GROUP BY waste_date, waste_type
        ORDER BY waste_date DESC, waste_type
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          p.product_name,
          p.unit,
          SUM(we.quantity) AS waste_quantity,
          SUM(we.cost_amount) AS waste_cost
        FROM waste_entries we
        JOIN products p ON p.id = we.product_id
        WHERE we.waste_date BETWEEN $1 AND $2
        GROUP BY p.product_name, p.unit
        ORDER BY waste_quantity DESC, waste_cost DESC
        LIMIT 20
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          p.id AS product_id,
          p.product_name,
          p.category,
          p.unit,
          p.minimum_stock,
          COALESCE(SUM(ib.remaining_qty), 0) AS current_stock,
          COALESCE(SUM(ib.remaining_qty * COALESCE(ib.effective_cost_per_unit, ib.purchase_rate)), 0) AS stock_value
        FROM products p
        LEFT JOIN inventory_batches ib ON ib.product_id = p.id
          AND COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED'
        WHERE p.active IS DISTINCT FROM FALSE
        GROUP BY p.id
        ORDER BY p.product_name
        `
      ),
      pool.query(
        `
        SELECT *
        FROM (
          SELECT p.purchase_date AS date, 'Supplier Purchase' AS transaction_type,
            p.supplier_name AS party_name,
            'SUPPLIER' AS account_type,
            'SUPPLIER-' || COALESCE(p.supplier_id, 0) AS account_key,
            'Purchase' AS voucher_type,
            COALESCE(p.bill_number, 'PUR-' || p.id) AS voucher_no,
            COALESCE(p.payment_mode, '') AS payment_mode,
            0::NUMERIC AS debit,
            COALESCE(NULLIF(p.net_payable, 0), NULLIF(p.gross_amount, 0), p.total_amount, 0) AS credit,
            COALESCE(p.payment_status, '') AS status,
            COALESCE(p.remarks, 'Purchase #' || p.id) AS remarks,
            COALESCE(
              STRING_AGG(pr.product_name || ' ' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM pi.quantity::TEXT)) || COALESCE(pr.unit, '') || ' @ ' || pi.purchase_rate || ' = ' || pi.basic_amount, E'\n' ORDER BY pi.id),
              COALESCE(p.remarks, 'Purchase #' || p.id)
            ) AS narration
          FROM purchases p
          LEFT JOIN purchase_items pi ON pi.purchase_id = p.id
          LEFT JOIN products pr ON pr.id = pi.product_id
          WHERE p.purchase_date BETWEEN $1 AND $2
            AND COALESCE(p.purchase_status, 'ACTIVE') <> 'CANCELLED'
          GROUP BY p.id
          UNION ALL
          SELECT p.purchase_date AS date, 'Supplier Rebate' AS transaction_type,
            p.supplier_name AS party_name,
            'SUPPLIER' AS account_type,
            'SUPPLIER-' || COALESCE(p.supplier_id, 0) AS account_key,
            'Rebate' AS voucher_type,
            COALESCE(p.bill_number, 'PUR-' || p.id) AS voucher_no,
            COALESCE(p.payment_mode, '') AS payment_mode,
            COALESCE(p.rebate_amount, 0) AS debit,
            0::NUMERIC AS credit,
            COALESCE(p.payment_status, '') AS status,
            COALESCE(p.remarks, 'Supplier rebate') AS remarks,
            'Rebate received against ' || COALESCE(p.bill_number, 'Purchase #' || p.id) AS narration
          FROM purchases p
          WHERE p.purchase_date BETWEEN $1 AND $2
            AND COALESCE(p.purchase_status, 'ACTIVE') <> 'CANCELLED'
            AND COALESCE(p.rebate_amount, 0) > 0
          UNION ALL
          SELECT p.cancelled_at::date AS date, 'Supplier Purchase Cancellation' AS transaction_type,
            p.supplier_name AS party_name,
            'SUPPLIER' AS account_type,
            'SUPPLIER-' || COALESCE(p.supplier_id, 0) AS account_key,
            'Purchase Cancellation' AS voucher_type,
            COALESCE(p.bill_number, 'PUR-' || p.id) AS voucher_no,
            COALESCE(p.payment_mode, '') AS payment_mode,
            COALESCE(NULLIF(p.net_payable, 0), NULLIF(p.gross_amount, 0), p.total_amount, 0) AS debit,
            0::NUMERIC AS credit,
            'CANCELLED' AS status,
            COALESCE(p.cancellation_reason, 'Purchase cancelled') AS remarks,
            COALESCE(p.cancellation_reason, 'Purchase cancelled') AS narration
          FROM purchases p
          WHERE p.cancelled_at::date BETWEEN $1 AND $2
            AND COALESCE(p.purchase_status, 'ACTIVE') = 'CANCELLED'
          UNION ALL
          SELECT sp.payment_date AS date, 'Supplier Payment' AS transaction_type,
            s.supplier_name AS party_name,
            'SUPPLIER' AS account_type,
            'SUPPLIER-' || s.id AS account_key,
            'Payment' AS voucher_type,
            COALESCE(sp.reference_number, 'SP-' || sp.id) AS voucher_no,
            sp.payment_mode,
            sp.payment_amount + sp.rebate_amount AS debit,
            0::NUMERIC AS credit,
            CASE WHEN sp.cancelled THEN 'CANCELLED' ELSE 'ACTIVE' END AS status,
            COALESCE(sp.remarks, sp.reference_number, 'Supplier payment') AS remarks,
            COALESCE(sp.remarks, 'Supplier payment') || CASE WHEN COALESCE(sp.rebate_amount, 0) > 0 THEN ' | Rebate ' || sp.rebate_amount ELSE '' END AS narration
          FROM supplier_payments sp
          JOIN suppliers s ON s.id = sp.supplier_id
          WHERE sp.payment_date BETWEEN $1 AND $2
          UNION ALL
          SELECT s.sale_date AS date, 'Customer Sale' AS transaction_type,
            COALESCE(s.customer_name, c.customer_name, 'Walk-in Customer') AS party_name,
            'CUSTOMER' AS account_type,
            'CUSTOMER-' || COALESCE(s.customer_id, c.id, 0) AS account_key,
            'Sale' AS voucher_type,
            COALESCE(s.invoice_no, 'SALE-' || s.id) AS voucher_no,
            s.payment_mode,
            s.total_amount AS debit,
            COALESCE(pay.total_paid, 0) AS credit,
            COALESCE(s.sale_status, 'COMPLETED') AS status,
            COALESCE(s.invoice_no, 'Sale #' || s.id) AS remarks,
            COALESCE(
              STRING_AGG(pr.product_name || ' ' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM si.quantity::TEXT)) || COALESCE(pr.unit, '') || ' @ ' || si.selling_rate || ' = ' || si.amount, E'\n' ORDER BY si.id),
              COALESCE(s.invoice_no, 'Sale #' || s.id)
            ) AS narration
          FROM sales s
          LEFT JOIN customers c ON c.id = s.customer_id
          LEFT JOIN (SELECT sale_id, SUM(amount) AS total_paid FROM sale_payments GROUP BY sale_id) pay ON pay.sale_id = s.id
          LEFT JOIN sale_items si ON si.sale_id = s.id
          LEFT JOIN products pr ON pr.id = si.product_id
          WHERE s.sale_date BETWEEN $1 AND $2
            AND s.sale_status <> 'CANCELLED'
          GROUP BY s.id, c.id, c.customer_name, pay.total_paid
          UNION ALL
          SELECT s.cancelled_at::date AS date, 'Customer Sale Cancellation' AS transaction_type,
            COALESCE(s.customer_name, c.customer_name, 'Walk-in Customer') AS party_name,
            'CUSTOMER' AS account_type,
            'CUSTOMER-' || COALESCE(s.customer_id, c.id, 0) AS account_key,
            'Sale Cancellation' AS voucher_type,
            COALESCE(s.invoice_no, 'SALE-' || s.id) AS voucher_no,
            s.payment_mode,
            0::NUMERIC AS debit,
            s.total_amount AS credit,
            'CANCELLED' AS status,
            COALESCE(s.cancellation_reason, 'Invoice cancelled') AS remarks,
            COALESCE(s.cancellation_reason, 'Invoice cancelled') AS narration
          FROM sales s
          LEFT JOIN customers c ON c.id = s.customer_id
          WHERE s.cancelled_at::date BETWEEN $1 AND $2
            AND s.sale_status = 'CANCELLED'
          UNION ALL
          SELECT cp.payment_date AS date, 'Customer Payment' AS transaction_type,
            c.customer_name AS party_name,
            'CUSTOMER' AS account_type,
            'CUSTOMER-' || c.id AS account_key,
            'Receipt' AS voucher_type,
            COALESCE(cp.reference_number, 'CP-' || cp.id) AS voucher_no,
            cp.payment_mode,
            0::NUMERIC AS debit,
            cp.payment_amount AS credit,
            CASE WHEN cp.cancelled THEN 'CANCELLED' ELSE 'ACTIVE' END AS status,
            COALESCE(cp.remarks, cp.reference_number, 'Customer payment') AS remarks,
            COALESCE(cp.remarks, 'Customer payment received') AS narration
          FROM customer_payments cp
          JOIN customers c ON c.id = cp.customer_id
          WHERE cp.payment_date BETWEEN $1 AND $2
          UNION ALL
          SELECT e.expense_date AS date, 'Expense' AS transaction_type,
            COALESCE(e.paid_to, e.vendor_name, e.category) AS party_name,
            'EXPENSE_VENDOR' AS account_type,
            'EXPENSE-' || e.id AS account_key,
            'Expense' AS voucher_type,
            COALESCE(e.reference_number, 'EXP-' || e.id) AS voucher_no,
            e.payment_mode,
            e.amount AS debit,
            0::NUMERIC AS credit,
            COALESCE(e.status, CASE WHEN e.active IS DISTINCT FROM FALSE THEN 'ACTIVE' ELSE 'CANCELLED' END) AS status,
            COALESCE(e.remarks, e.category) AS remarks,
            e.category || CASE WHEN COALESCE(e.paid_to, e.vendor_name, '') <> '' THEN ' paid to ' || COALESCE(e.paid_to, e.vendor_name) ELSE '' END AS narration
          FROM expenses e
          WHERE e.expense_date BETWEEN $1 AND $2
          UNION ALL
          SELECT sr.return_date AS date, 'Sale Return' AS transaction_type,
            COALESCE(sr.customer_name, 'Walk-in Customer') AS party_name,
            'CUSTOMER' AS account_type,
            'CUSTOMER-' || COALESCE(s.customer_id, 0) AS account_key,
            'Sale Return' AS voucher_type,
            COALESCE(sr.return_no, 'RET-' || sr.id) AS voucher_no,
            sr.refund_type AS payment_mode,
            0::NUMERIC AS debit,
            sr.total_return_amount AS credit,
            'ACTIVE' AS status,
            COALESCE(sr.return_reason, 'Sale return') AS remarks,
            COALESCE(
              STRING_AGG(pr.product_name || ' ' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM sri.return_quantity::TEXT)) || COALESCE(pr.unit, '') || ' @ ' || sri.selling_rate || ' = ' || sri.return_amount, E'\n' ORDER BY sri.id),
              COALESCE(sr.return_reason, 'Sale return')
            ) AS narration
          FROM sale_returns sr
          LEFT JOIN sales s ON s.id = sr.sale_id
          LEFT JOIN sale_return_items sri ON sri.sale_return_id = sr.id
          LEFT JOIN products pr ON pr.id = sri.product_id
          WHERE sr.return_date BETWEEN $1 AND $2
          GROUP BY sr.id, s.customer_id
          UNION ALL
          SELECT we.waste_date AS date, 'Waste' AS transaction_type,
            p.product_name AS party_name,
            'OTHER' AS account_type,
            'WASTE-' || we.id AS account_key,
            'Waste' AS voucher_type,
            'WST-' || we.id AS voucher_no,
            '' AS payment_mode,
            we.cost_amount AS debit,
            0::NUMERIC AS credit,
            'ACTIVE' AS status,
            COALESCE(we.remarks, we.waste_type) AS remarks,
            p.product_name || ' ' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM we.quantity::TEXT)) || COALESCE(p.unit, '') || ' wasted: ' || we.waste_type AS narration
          FROM waste_entries we
          JOIN products p ON p.id = we.product_id
          WHERE we.waste_date BETWEEN $1 AND $2
        ) ledger
        ORDER BY date DESC, transaction_type, party_name
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        WITH days AS (
          SELECT generate_series($1::date, $2::date, INTERVAL '1 day')::date AS day
        ),
        sales_by_day AS (
          SELECT sale_date::date AS day, SUM(total_amount) AS sales, SUM(profit) AS profit, COUNT(*) AS transactions
          FROM sales
          WHERE sale_status <> 'CANCELLED' AND sale_date BETWEEN $1 AND $2
          GROUP BY sale_date
        ),
        purchases_by_day AS (
          SELECT purchase_date::date AS day, SUM(COALESCE(NULLIF(net_payable, 0), total_amount, 0)) AS purchases
          FROM purchases
          WHERE COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED' AND purchase_date BETWEEN $1 AND $2
          GROUP BY purchase_date
        ),
        expenses_by_day AS (
          SELECT expense_date::date AS day, SUM(amount) AS expenses
          FROM expenses
          WHERE active IS DISTINCT FROM FALSE AND expense_date BETWEEN $1 AND $2
          GROUP BY expense_date
        ),
        sales_payments_by_day AS (
          SELECT s.sale_date::date AS day,
            SUM(CASE WHEN sp.payment_mode = 'CASH' THEN sp.amount ELSE 0 END) AS cash_sales,
            SUM(CASE WHEN sp.payment_mode = 'UPI' THEN sp.amount ELSE 0 END) AS upi_sales,
            SUM(CASE WHEN sp.payment_mode IN ('CARD', 'BANK_TRANSFER') THEN sp.amount ELSE 0 END) AS bank_card_sales
          FROM sale_payments sp
          JOIN sales s ON s.id = sp.sale_id
          WHERE s.sale_status <> 'CANCELLED' AND s.sale_date BETWEEN $1 AND $2
          GROUP BY s.sale_date
        ),
        customer_receipts_by_day AS (
          SELECT payment_date::date AS day,
            SUM(CASE WHEN payment_mode = 'CASH' THEN payment_amount ELSE 0 END) AS cash_receipts,
            SUM(CASE WHEN payment_mode = 'UPI' THEN payment_amount ELSE 0 END) AS upi_receipts,
            SUM(CASE WHEN payment_mode IN ('CARD', 'BANK_TRANSFER') THEN payment_amount ELSE 0 END) AS bank_card_receipts
          FROM customer_payments
          WHERE cancelled = FALSE AND payment_date BETWEEN $1 AND $2
          GROUP BY payment_date
        ),
        supplier_payments_by_day AS (
          SELECT payment_date::date AS day,
            SUM(CASE WHEN payment_mode = 'CASH' THEN payment_amount ELSE 0 END) AS cash_supplier_payments,
            SUM(CASE WHEN payment_mode = 'UPI' THEN payment_amount ELSE 0 END) AS upi_supplier_payments,
            SUM(CASE WHEN payment_mode IN ('BANK_TRANSFER', 'CHEQUE') THEN payment_amount ELSE 0 END) AS bank_supplier_payments
          FROM supplier_payments
          WHERE cancelled = FALSE AND payment_date BETWEEN $1 AND $2
          GROUP BY payment_date
        ),
        returns_by_day AS (
          SELECT return_date::date AS day, SUM(total_return_amount) AS returns
          FROM sale_returns
          WHERE return_date BETWEEN $1 AND $2
          GROUP BY return_date
        ),
        waste_by_day AS (
          SELECT waste_date::date AS day, SUM(cost_amount) AS waste
          FROM waste_entries
          WHERE waste_date BETWEEN $1 AND $2
          GROUP BY waste_date
        )
        SELECT
          TO_CHAR(days.day, 'YYYY-MM-DD') AS date,
          COALESCE(sales_by_day.sales, 0) AS sales,
          COALESCE(sales_by_day.profit, 0) AS profit,
          COALESCE(sales_by_day.transactions, 0)::INTEGER AS transactions,
          COALESCE(purchases_by_day.purchases, 0) AS purchases,
          COALESCE(expenses_by_day.expenses, 0) AS expenses,
          COALESCE(sales_payments_by_day.cash_sales, 0) AS cash_sales,
          COALESCE(sales_payments_by_day.upi_sales, 0) AS upi_sales,
          COALESCE(sales_payments_by_day.bank_card_sales, 0) AS bank_card_sales,
          COALESCE(customer_receipts_by_day.cash_receipts, 0) AS customer_cash_receipts,
          COALESCE(customer_receipts_by_day.upi_receipts, 0) AS customer_upi_receipts,
          COALESCE(customer_receipts_by_day.bank_card_receipts, 0) AS customer_bank_card_receipts,
          COALESCE(supplier_payments_by_day.cash_supplier_payments, 0) AS supplier_cash_payments,
          COALESCE(supplier_payments_by_day.upi_supplier_payments, 0) AS supplier_upi_payments,
          COALESCE(supplier_payments_by_day.bank_supplier_payments, 0) AS supplier_bank_payments,
          COALESCE(returns_by_day.returns, 0) AS returns,
          COALESCE(waste_by_day.waste, 0) AS waste,
          COALESCE(sales_by_day.profit, 0) - COALESCE(expenses_by_day.expenses, 0) - COALESCE(waste_by_day.waste, 0) AS net_profit
        FROM days
        LEFT JOIN sales_by_day ON sales_by_day.day = days.day
        LEFT JOIN purchases_by_day ON purchases_by_day.day = days.day
        LEFT JOIN expenses_by_day ON expenses_by_day.day = days.day
        LEFT JOIN sales_payments_by_day ON sales_payments_by_day.day = days.day
        LEFT JOIN customer_receipts_by_day ON customer_receipts_by_day.day = days.day
        LEFT JOIN supplier_payments_by_day ON supplier_payments_by_day.day = days.day
        LEFT JOIN returns_by_day ON returns_by_day.day = days.day
        LEFT JOIN waste_by_day ON waste_by_day.day = days.day
        ORDER BY days.day DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          p.product_name,
          p.unit,
          SUM(si.quantity) AS quantity_sold,
          SUM(si.net_amount) AS revenue,
          SUM(si.cost_amount) AS cost,
          SUM(si.profit) AS profit
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id
        JOIN products p ON p.id = si.product_id
        WHERE s.sale_status <> 'CANCELLED'
          AND s.sale_date BETWEEN $1 AND $2
        GROUP BY p.product_name, p.unit
        ORDER BY quantity_sold DESC, revenue DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          COALESCE(c.customer_name, NULLIF(s.customer_name, ''), 'Walk-in Customer') AS customer_name,
          COALESCE(c.mobile_number, s.customer_mobile, '') AS customer_mobile,
          COALESCE(s.customer_id, c.id) AS customer_id,
          COUNT(*)::INTEGER AS invoice_count,
          SUM(s.total_amount) AS total_sales,
          SUM(s.profit) AS total_profit
        FROM sales s
        LEFT JOIN customers c ON c.id = s.customer_id
        WHERE s.sale_status <> 'CANCELLED'
          AND s.sale_date BETWEEN $1 AND $2
        GROUP BY COALESCE(c.customer_name, NULLIF(s.customer_name, ''), 'Walk-in Customer'), COALESCE(c.mobile_number, s.customer_mobile, ''), COALESCE(s.customer_id, c.id)
        ORDER BY total_sales DESC, invoice_count DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          s.id,
          s.invoice_no,
          s.sale_date,
          s.created_at,
          s.sale_status,
          s.customer_id,
          COALESCE(s.customer_name, c.customer_name, 'Walk-in Customer') AS customer_name,
          s.customer_mobile,
          s.payment_mode,
          s.gross_amount,
          COALESCE(s.item_discount_amount, 0) AS item_discount_amount,
          COALESCE(s.invoice_discount_amount, 0) AS invoice_discount_amount,
          COALESCE(s.item_discount_amount, 0) + COALESCE(s.invoice_discount_amount, 0) AS discount_amount,
          s.total_amount,
          s.total_cost,
          s.profit,
          COALESCE(
            JSON_AGG(
              JSON_BUILD_OBJECT(
                'id', si.id,
                'product_id', si.product_id,
                'product_name', p.product_name,
                'unit', p.unit,
                'quantity', si.quantity,
                'selling_rate', si.selling_rate,
                'gross_amount', si.amount,
                'discount_amount', COALESCE(si.discount_amount, 0),
                'net_amount', COALESCE(si.net_amount, si.amount - COALESCE(si.discount_amount, 0)),
                'cost_amount', si.cost_amount,
                'profit', si.profit,
                'cost_status', si.cost_status,
                'default_selling_rate', si.default_selling_rate,
                'manual_rate_override', COALESCE(si.manual_rate_override, FALSE)
              )
              ORDER BY si.id
            ) FILTER (WHERE si.id IS NOT NULL),
            '[]'::json
          ) AS items
        FROM sales s
        LEFT JOIN customers c ON c.id = s.customer_id
        LEFT JOIN sale_items si ON si.sale_id = s.id
        LEFT JOIN products p ON p.id = si.product_id
        WHERE s.sale_date BETWEEN $1 AND $2
        GROUP BY
          s.id,
          s.invoice_no,
          s.sale_date,
          s.created_at,
          s.sale_status,
          s.customer_id,
          s.customer_name,
          c.customer_name,
          s.customer_mobile,
          s.payment_mode,
          s.gross_amount,
          s.item_discount_amount,
          s.invoice_discount_amount,
          s.total_amount,
          s.total_cost,
          s.profit
        ORDER BY s.sale_date DESC, s.created_at DESC, s.id DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          s.id,
          s.invoice_no,
          s.sale_date,
          s.sale_status,
          s.total_amount,
          s.cancelled_at,
          s.cancellation_reason,
          s.edit_reason,
          u.full_name AS changed_by_name,
          s.edited_at
        FROM sales s
        LEFT JOIN users u ON u.id = COALESCE(s.cancelled_by, s.edited_by)
        WHERE (s.sale_status IN ('EDITED', 'CANCELLED') OR s.edited_at IS NOT NULL OR s.cancelled_at IS NOT NULL)
          AND s.sale_date BETWEEN $1 AND $2
        ORDER BY COALESCE(s.cancelled_at, s.edited_at, s.created_at) DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          p.category,
          p.product_name,
          p.unit,
          SUM(pi.quantity) AS quantity_purchased,
          SUM(pi.net_payable) AS net_purchase,
          SUM(pi.mandi_tax_amount) AS mandi_tax,
          SUM(pi.rebate_amount) AS rebate
        FROM purchase_items pi
        JOIN purchases pur ON pur.id = pi.purchase_id
        JOIN products p ON p.id = pi.product_id
        WHERE COALESCE(pur.purchase_status, 'ACTIVE') <> 'CANCELLED'
          AND pur.purchase_date BETWEEN $1 AND $2
        GROUP BY p.category, p.product_name, p.unit
        ORDER BY quantity_purchased DESC, net_purchase DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          supplier_name,
          COUNT(*)::INTEGER AS purchase_count,
          SUM(COALESCE(NULLIF(gross_amount, 0), total_amount, 0)) AS gross_purchase,
          SUM(COALESCE(rebate_amount, 0)) AS rebate_received,
          SUM(COALESCE(NULLIF(net_payable, 0), total_amount, 0)) AS net_purchase,
          SUM(COALESCE(paid_amount, 0)) AS paid_amount,
          SUM(COALESCE(balance_amount, 0)) AS balance_amount
        FROM purchases
        WHERE COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED'
          AND purchase_date BETWEEN $1 AND $2
        GROUP BY supplier_name
        ORDER BY net_purchase DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          p.id,
          p.purchase_date,
          p.supplier_name,
          p.purchase_status,
          p.net_payable,
          p.cancelled_at,
          p.cancellation_reason,
          p.edited_at,
          p.edit_reason,
          u.full_name AS changed_by_name
        FROM purchases p
        LEFT JOIN users u ON u.id = COALESCE(p.cancelled_by, p.edited_by)
        WHERE (p.purchase_status IN ('EDITED', 'CANCELLED') OR p.edited_at IS NOT NULL OR p.cancelled_at IS NOT NULL)
          AND p.purchase_date BETWEEN $1 AND $2
        ORDER BY COALESCE(p.cancelled_at, p.edited_at, p.created_at) DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          sr.return_no,
          sr.return_date,
          s.invoice_no,
          COALESCE(sr.customer_name, 'Walk-in Customer') AS customer_name,
          sr.customer_mobile,
          sr.refund_type,
          sr.total_return_amount,
          sr.return_reason,
          STRING_AGG(p.product_name || ' x ' || sri.return_quantity, ', ' ORDER BY sri.id) AS items
        FROM sale_returns sr
        LEFT JOIN sales s ON s.id = sr.sale_id
        LEFT JOIN sale_return_items sri ON sri.sale_return_id = sr.id
        LEFT JOIN products p ON p.id = sri.product_id
        WHERE sr.return_date BETWEEN $1 AND $2
        GROUP BY sr.id, s.invoice_no
        ORDER BY sr.return_date DESC, sr.id DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          st.created_at::date AS movement_date,
          p.product_name,
          p.unit,
          st.transaction_type,
          SUM(st.quantity) AS quantity,
          COUNT(*)::INTEGER AS movement_count,
          STRING_AGG(DISTINCT COALESCE(st.remarks, ''), ', ') AS remarks
        FROM stock_transactions st
        JOIN products p ON p.id = st.product_id
        WHERE st.created_at::date BETWEEN $1 AND $2
        GROUP BY st.created_at::date, p.product_name, p.unit, st.transaction_type
        ORDER BY movement_date DESC, p.product_name, st.transaction_type
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          COALESCE((SELECT SUM(amount) FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id WHERE s.sale_status <> 'CANCELLED'), 0)
            + COALESCE((SELECT SUM(payment_amount) FROM customer_payments WHERE cancelled = FALSE), 0)
            - COALESCE((SELECT SUM(payment_amount) FROM supplier_payments WHERE cancelled = FALSE), 0)
            - COALESCE((SELECT SUM(amount) FROM expenses WHERE active IS DISTINCT FROM FALSE), 0) AS cash_bank,
          COALESCE((SELECT SUM(remaining_qty * COALESCE(effective_cost_per_unit, purchase_rate)) FROM inventory_batches WHERE COALESCE(batch_status, 'ACTIVE') <> 'CANCELLED'), 0) AS inventory_value,
          COALESCE((SELECT SUM(outstanding_balance) FROM (
            SELECT c.id, COALESCE(c.opening_balance, 0) + COALESCE(ss.total_sales, 0) - COALESCE(ss.sale_paid, 0) - COALESCE(cp.total_paid, 0) AS outstanding_balance
            FROM customers c
            LEFT JOIN (
              SELECT s.customer_mobile, s.customer_name, SUM(s.total_amount) AS total_sales, SUM(COALESCE(pay.total_paid, 0)) AS sale_paid
              FROM sales s
              LEFT JOIN (SELECT sale_id, SUM(amount) AS total_paid FROM sale_payments GROUP BY sale_id) pay ON pay.sale_id = s.id
              WHERE s.sale_status <> 'CANCELLED'
              GROUP BY s.customer_mobile, s.customer_name
            ) ss ON ss.customer_mobile = c.mobile_number OR LOWER(ss.customer_name) = LOWER(c.customer_name)
            LEFT JOIN (SELECT customer_id, SUM(payment_amount) AS total_paid FROM customer_payments WHERE cancelled = FALSE GROUP BY customer_id) cp ON cp.customer_id = c.id
          ) customer_balances), 0) AS customer_receivable,
          COALESCE((SELECT SUM(outstanding_balance) FROM (
            SELECT s.id, COALESCE(s.opening_balance, 0) + COALESCE(ps.total_purchases, 0) - COALESCE(ps.purchase_rebate, 0) - COALESCE(ps.purchase_paid, 0) - COALESCE(pay.total_paid, 0) - COALESCE(pay.payment_rebate, 0) AS outstanding_balance
            FROM suppliers s
            LEFT JOIN (
              SELECT supplier_id, SUM(COALESCE(NULLIF(gross_amount, 0), total_amount, 0)) AS total_purchases, SUM(COALESCE(rebate_amount, 0)) AS purchase_rebate, SUM(COALESCE(paid_amount, 0)) AS purchase_paid
              FROM purchases WHERE supplier_id IS NOT NULL AND COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED' GROUP BY supplier_id
            ) ps ON ps.supplier_id = s.id
            LEFT JOIN (
              SELECT supplier_id, SUM(payment_amount) AS total_paid, SUM(rebate_amount) AS payment_rebate
              FROM supplier_payments WHERE cancelled = FALSE GROUP BY supplier_id
            ) pay ON pay.supplier_id = s.id
          ) supplier_balances), 0) AS supplier_payable
        `
      ),
      pool.query(
        `
        SELECT
          COALESCE((SELECT SUM(total_amount) FROM sales WHERE sale_status <> 'CANCELLED' AND sale_date BETWEEN $1 AND $2), 0) AS sales_revenue,
          COALESCE((SELECT SUM(total_cost) FROM sales WHERE sale_status <> 'CANCELLED' AND sale_date BETWEEN $1 AND $2), 0) AS purchase_cost,
          COALESCE((SELECT SUM(mandi_tax_amount) FROM purchases WHERE purchase_date BETWEEN $1 AND $2 AND COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED'), 0) AS mandi_tax,
          COALESCE((SELECT SUM(freight_charges) FROM purchases WHERE purchase_date BETWEEN $1 AND $2 AND COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED'), 0) AS freight_charges,
          COALESCE((SELECT SUM(labour_charges) FROM purchases WHERE purchase_date BETWEEN $1 AND $2 AND COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED'), 0) AS labour_charges,
          COALESCE((SELECT SUM(other_charges) FROM purchases WHERE purchase_date BETWEEN $1 AND $2 AND COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED'), 0) AS other_purchase_charges,
          COALESCE((SELECT SUM(amount) FROM expenses WHERE active IS DISTINCT FROM FALSE AND COALESCE(status, 'ACTIVE') <> 'CANCELLED' AND expense_date BETWEEN $1 AND $2), 0) AS expenses,
          COALESCE((SELECT SUM(rebate_amount) FROM purchases WHERE purchase_date BETWEEN $1 AND $2 AND COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED'), 0)
            + COALESCE((SELECT SUM(rebate_amount) FROM supplier_payments WHERE cancelled = FALSE AND payment_date BETWEEN $1 AND $2), 0) AS supplier_rebate_received,
          COALESCE((
            SELECT JSON_AGG(JSON_BUILD_OBJECT('category', category, 'amount', total_amount) ORDER BY category)
            FROM (
              SELECT category, SUM(amount) AS total_amount
              FROM expenses
              WHERE active IS DISTINCT FROM FALSE
                AND COALESCE(status, 'ACTIVE') <> 'CANCELLED'
                AND expense_date BETWEEN $1 AND $2
              GROUP BY category
            ) expense_categories
          ), '[]'::json) AS expense_categories
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          transaction_date,
          source,
          payment_mode,
          COUNT(*)::INTEGER AS transaction_count,
          SUM(amount) AS total_amount
        FROM (
          SELECT s.sale_date AS transaction_date, 'Sales' AS source, sp.payment_mode, sp.amount
          FROM sale_payments sp
          JOIN sales s ON s.id = sp.sale_id
          WHERE s.sale_status <> 'CANCELLED' AND s.sale_date BETWEEN $1 AND $2
          UNION ALL
          SELECT cp.payment_date AS transaction_date, 'Customer Receipt' AS source, cp.payment_mode, cp.payment_amount AS amount
          FROM customer_payments cp
          WHERE cp.cancelled = FALSE AND cp.payment_date BETWEEN $1 AND $2
          UNION ALL
          SELECT sp.payment_date AS transaction_date, 'Supplier Payment' AS source, sp.payment_mode, sp.payment_amount AS amount
          FROM supplier_payments sp
          WHERE sp.cancelled = FALSE AND sp.payment_date BETWEEN $1 AND $2
          UNION ALL
          SELECT e.expense_date AS transaction_date, 'Expense' AS source, e.payment_mode, e.amount
          FROM expenses e
          WHERE e.active IS DISTINCT FROM FALSE AND e.expense_date BETWEEN $1 AND $2
        ) mode_rows
        GROUP BY transaction_date, source, payment_mode
        ORDER BY transaction_date DESC, source, payment_mode
        `,
        [dateFrom, dateTo]
      ),
    ]);
    const balanceSheet = balanceSheetResult.rows[0] || {};
    const profitLoss = profitLossResult.rows[0] || {};
    const customerReceivable = customerRows.reduce((sum, row) => sum + Number(row.outstanding_balance || 0), 0);
    const supplierPayable = supplierRows.reduce((sum, row) => sum + Number(row.outstanding_balance || 0), 0);
    const purchaseCost = Number(profitLoss.purchase_cost || 0);
    const mandiTax = Number(profitLoss.mandi_tax || 0);
    const freightCharges = Number(profitLoss.freight_charges || 0);
    const labourCharges = Number(profitLoss.labour_charges || 0);
    const otherPurchaseCharges = Number(profitLoss.other_purchase_charges || 0);
    const supplierRebateReceived = Number(profitLoss.supplier_rebate_received || 0);
    const costOfGoodsSold = purchaseCost + mandiTax + freightCharges + labourCharges + otherPurchaseCharges - supplierRebateReceived;
    const grossProfit = Number(profitLoss.sales_revenue || 0) - costOfGoodsSold;
    const netProfit = grossProfit - Number(profitLoss.expenses || 0);
    const assets = Number(balanceSheet.cash_bank || 0) + Number(balanceSheet.inventory_value || 0) + customerReceivable;
    const liabilities = supplierPayable;
    const ownerCapitalAdjustment = roundCurrency(assets - liabilities - netProfit);
    return res.json({
      dateFrom,
      dateTo,
      salesReport: salesResult.rows,
      purchaseReport: purchaseResult.rows,
      supplierOutstandingReport: supplierRows,
      customerOutstandingReport: customerRows,
      discountReport: discountResult.rows,
      expenseReport: expenseResult.rows,
      paymentReport: paymentResult.rows,
      paymentModeSummary: paymentModeSummaryResult.rows,
      returnReport: returnResult.rows,
      returnReasonReport: returnReasonResult.rows,
      wasteReport: wasteResult.rows,
      wasteProductReport: wasteProductResult.rows,
      mostWastedProducts: wasteProductResult.rows.slice(0, 5),
      stockReport: stockResult.rows,
      ledgerReport: ledgerResult.rows,
      dayToDayReport: ledgerResult.rows,
      salesProductReport: salesProductResult.rows,
      salesCustomerReport: salesCustomerResult.rows,
      salesHistoryReport: salesHistoryResult.rows,
      salesChangeReport: salesChangeResult.rows,
      purchaseHistoryReport: purchaseHistoryResult.rows,
      purchaseProductReport: purchaseProductResult.rows,
      purchaseSupplierReport: purchaseSupplierResult.rows,
      purchaseChangeReport: purchaseChangeResult.rows,
      pendingPurchaseBillsReport: pendingPurchaseResult.rows,
      stockWithoutBillReport: stockWithoutBillResult.rows,
      provisionalProfitSalesReport: provisionalSalesResult.rows,
      returnHistoryReport: returnHistoryResult.rows,
      stockMovementReport: stockMovementResult.rows,
      balanceSheet: {
        cash: roundCurrency(Number(balanceSheet.cash_bank || 0)),
        bank: 0,
        inventory: roundCurrency(Number(balanceSheet.inventory_value || 0)),
        customerReceivable: roundCurrency(customerReceivable),
        supplierPayable: roundCurrency(supplierPayable),
        netProfit: roundCurrency(netProfit),
        ownerCapital: ownerCapitalAdjustment,
        netPosition: roundCurrency(assets - liabilities),
        totalAssets: roundCurrency(assets),
        totalLiabilities: roundCurrency(liabilities + netProfit + ownerCapitalAdjustment),
      },
      profitLoss: {
        salesRevenue: roundCurrency(Number(profitLoss.sales_revenue || 0)),
        purchaseCost: roundCurrency(purchaseCost),
        mandiTax: roundCurrency(mandiTax),
        freightCharges: roundCurrency(freightCharges),
        labourCharges: roundCurrency(labourCharges),
        otherPurchaseCharges: roundCurrency(otherPurchaseCharges),
        supplierRebateReceived: roundCurrency(supplierRebateReceived),
        costOfGoodsSold: roundCurrency(costOfGoodsSold),
        expenses: roundCurrency(Number(profitLoss.expenses || 0)),
        expenseCategories: Array.isArray(profitLoss.expense_categories) ? profitLoss.expense_categories : [],
        cashSales: roundCurrency(paymentModeSummaryResult.rows.filter((row) => row.source === "Sales" && row.payment_mode === "CASH").reduce((sum, row) => sum + Number(row.total_amount || 0), 0)),
        upiSales: roundCurrency(paymentModeSummaryResult.rows.filter((row) => row.source === "Sales" && row.payment_mode === "UPI").reduce((sum, row) => sum + Number(row.total_amount || 0), 0)),
        bankCardSales: roundCurrency(paymentModeSummaryResult.rows.filter((row) => row.source === "Sales" && ["CARD", "BANK_TRANSFER"].includes(row.payment_mode)).reduce((sum, row) => sum + Number(row.total_amount || 0), 0)),
        grossProfit: roundCurrency(grossProfit),
        netProfit: roundCurrency(netProfit),
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Reports" });
  }
});

app.get("/expenses", async (req, res) => {
  try {
    const filters = [];
    const values = [];
    if (req.query.date_from) {
      values.push(req.query.date_from);
      filters.push(`e.expense_date >= $${values.length}`);
    }
    if (req.query.date_to) {
      values.push(req.query.date_to);
      filters.push(`e.expense_date <= $${values.length}`);
    }
    if (req.query.category) {
      values.push(cleanText(req.query.category));
      filters.push(`LOWER(e.category) = LOWER($${values.length})`);
    }
    if (req.query.payment_mode) {
      values.push(normalizePaymentMode(req.query.payment_mode));
      filters.push(`e.payment_mode = $${values.length}`);
    }
    if (req.query.status) {
      values.push(String(req.query.status).toUpperCase());
      filters.push(`COALESCE(e.status, CASE WHEN e.active IS DISTINCT FROM FALSE THEN 'ACTIVE' ELSE 'CANCELLED' END) = $${values.length}`);
    }
    if (req.query.search) {
      values.push(`%${cleanText(req.query.search).toLowerCase()}%`);
      filters.push(`(
        LOWER(e.category) LIKE $${values.length}
        OR LOWER(COALESCE(e.vendor_name, e.paid_to, '')) LIKE $${values.length}
        OR LOWER(COALESCE(e.reference_number, '')) LIKE $${values.length}
        OR LOWER(COALESCE(e.remarks, '')) LIKE $${values.length}
      )`);
    }
    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const result = await pool.query(
      `
      SELECT e.*, COALESCE(e.paid_to, e.vendor_name) AS paid_to, u.full_name AS created_by_name,
             eu.full_name AS edited_by_name, cu.full_name AS cancelled_by_name
      FROM expenses e
      LEFT JOIN users u ON u.id = e.created_by
      LEFT JOIN users eu ON eu.id = e.edited_by
      LEFT JOIN users cu ON cu.id = e.cancelled_by
      ${whereClause}
      ORDER BY e.expense_date DESC, e.created_at DESC, e.id DESC
      `,
      values
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
        vendor_name, paid_to, remarks, branch_id, created_by, active, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'ACTIVE')
      RETURNING *
      `,
      [
        req.body.expense_date || toDateKey(new Date()), category, amount, paymentMode,
        nullableText(req.body.reference_number), nullableText(req.body.vendor_name || req.body.paid_to),
        nullableText(req.body.paid_to || req.body.vendor_name),
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
  const client = await pool.connect();
  try {
    const expenseId = parsePositiveInteger(req.params.id);
    const amount = parsePositiveNumber(req.body.amount);
    const category = cleanText(req.body.category);
    const paymentMode = normalizePaymentMode(req.body.payment_mode || "CASH");
    if (!expenseId || !category || !amount || !SUPPLIER_PAYMENT_MODES.has(paymentMode)) {
      return res.status(400).json({ message: "Enter valid expense details" });
    }
    await client.query("BEGIN");
    const oldResult = await client.query("SELECT * FROM expenses WHERE id = $1 FOR UPDATE", [expenseId]);
    const oldExpense = oldResult.rows[0];
    if (!oldExpense) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Expense not found" });
    }
    if (oldExpense.status === "CANCELLED" || oldExpense.active === false) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Cancelled expenses cannot be edited" });
    }
    const editorId = parsePositiveInteger(req.body.edited_by) || parsePositiveInteger(req.body.created_by) || 1;
    const reason = cleanText(req.body.reason || req.body.edit_reason || "Expense updated");
    const result = await client.query(
      `
      UPDATE expenses
      SET expense_date = $1, category = $2, amount = $3, payment_mode = $4,
          reference_number = $5, vendor_name = $6, paid_to = $7, remarks = $8,
          branch_id = $9, active = TRUE, status = 'ACTIVE',
          edited_by = $10, edited_at = CURRENT_TIMESTAMP, edit_reason = $11,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $12
      RETURNING *
      `,
      [
        req.body.expense_date || toDateKey(new Date()), category, amount, paymentMode,
        nullableText(req.body.reference_number), nullableText(req.body.vendor_name || req.body.paid_to),
        nullableText(req.body.paid_to || req.body.vendor_name),
        nullableText(req.body.remarks), parsePositiveInteger(req.body.branch_id),
        editorId, reason, expenseId,
      ]
    );
    await client.query(
      `
      INSERT INTO expense_audit_trail (expense_id, action, old_value, new_value, reason, changed_by)
      VALUES ($1, 'EDIT', $2::jsonb, $3::jsonb, $4, $5)
      `,
      [expenseId, JSON.stringify(oldExpense), JSON.stringify(result.rows[0]), reason, editorId]
    );
    await client.query("COMMIT");
    return res.json(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Updating Expense" });
  } finally {
    client.release();
  }
});

app.post("/expenses/:id/cancel", async (req, res) => {
  const client = await pool.connect();
  try {
    const expenseId = parsePositiveInteger(req.params.id);
    const reason = cleanText(req.body.reason);
    const cancelledBy = parsePositiveInteger(req.body.cancelled_by) || 1;
    if (!expenseId || !reason) return res.status(400).json({ message: "Cancellation reason is required" });
    await client.query("BEGIN");
    const oldResult = await client.query("SELECT * FROM expenses WHERE id = $1 FOR UPDATE", [expenseId]);
    const oldExpense = oldResult.rows[0];
    if (!oldExpense) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Expense not found" });
    }
    if (oldExpense.status === "CANCELLED" || oldExpense.active === false) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Expense is already cancelled" });
    }
    const result = await client.query(
      `
      UPDATE expenses
      SET active = FALSE, status = 'CANCELLED',
          cancelled_by = $1, cancelled_at = CURRENT_TIMESTAMP, cancellation_reason = $2,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *
      `,
      [cancelledBy, reason, expenseId]
    );
    await client.query(
      `
      INSERT INTO expense_audit_trail (expense_id, action, old_value, new_value, reason, changed_by)
      VALUES ($1, 'CANCEL', $2::jsonb, $3::jsonb, $4, $5)
      `,
      [expenseId, JSON.stringify(oldExpense), JSON.stringify(result.rows[0]), reason, cancelledBy]
    );
    await client.query("COMMIT");
    return res.json({ success: true, expense: result.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Cancelling Expense" });
  } finally {
    client.release();
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
          AND COALESCE(p.purchase_status, 'ACTIVE') <> 'CANCELLED'
          AND COALESCE(p.purchase_bill_status, 'BILL_COMPLETED') = 'BILL_COMPLETED'
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

const readPurchaseEntryPayload = (body) => {
  const purchaseType = String(body.purchase_type || "CREDIT").trim().toUpperCase();
  const purchaseBillStatus = String(body.purchase_bill_status || "BILL_COMPLETED").trim().toUpperCase();
  return {
    supplierId: parsePositiveInteger(body.supplier_id),
    productId: parsePositiveInteger(body.product_id),
    quantity: parsePositiveNumber(body.quantity),
    purchaseRate: parsePositiveNumber(body.purchase_rate),
    expectedPurchaseRate: parseNonNegativeNumber(body.expected_purchase_rate),
    temporarySaleRate: parsePositiveNumber(body.temporary_sale_rate),
    freightCharges: parseNonNegativeNumber(body.freight_charges),
    labourCharges: parseNonNegativeNumber(body.labour_charges),
    otherCharges: parseNonNegativeNumber(body.other_charges),
    paidAmountInput: parseNonNegativeNumber(body.paid_amount),
    rebateRuleId: parsePositiveInteger(body.rebate_rule_id),
    paymentDate: isDateInput(body.payment_date) ? body.payment_date : null,
    purchaseType,
    purchaseBillStatus,
    paymentMode: normalizePaymentMode(body.payment_mode),
    paymentReferenceNumber: nullableText(body.payment_reference_number),
    purchaseDate: isDateInput(body.purchase_date || body.arrival_date) ? (body.purchase_date || body.arrival_date) : toDateKey(new Date()),
    billNumber: nullableText(body.bill_number),
    billDate: isDateInput(body.bill_date) ? body.bill_date : null,
    lotName: nullableText(body.lot_name || body.lot_number),
    lotSize: nullableText(body.lot_size || body.size_grade || body.size),
    branchId: parsePositiveInteger(body.branch_id),
    actorId: parsePositiveInteger(body.created_by || body.edited_by) || 1,
    remarks: nullableText(body.remarks),
  };
};

const validatePurchaseEntry = (entry) => {
  if (!entry.supplierId) return "Please select supplier";
  if (!PURCHASE_BILL_STATUSES.has(entry.purchaseBillStatus)) return "Select a valid purchase bill status";
  if (entry.purchaseBillStatus === "BILL_PENDING") {
    if (!entry.productId) return "Please select product";
    if (!entry.quantity) return "Please enter quantity";
    if (!entry.branchId) return "Please select branch";
    if (!entry.temporarySaleRate) return "Please enter temporary sale rate";
    if (entry.expectedPurchaseRate === null) return "Please enter expected purchase rate";
    return "";
  }
  if (!entry.productId) return "Please select product";
  if (!entry.quantity) return "Please enter quantity";
  if (!entry.purchaseRate) return "Please enter purchase rate";
  if (entry.freightCharges === null) return "Please enter freight charges";
  if (entry.labourCharges === null) return "Please enter labour charges";
  if (entry.otherCharges === null) return "Please enter other charges";
  if (entry.paidAmountInput === null) return "Please enter paid amount";
  if (!entry.rebateRuleId) return "Please select rebate rule";
  if (!entry.branchId) return "Please select branch";
  if (!["CASH", "CREDIT"].includes(entry.purchaseType)) return "Please select Cash or Credit purchase";
  if (entry.purchaseType === "CASH" && (!SUPPLIER_PAYMENT_MODES.has(entry.paymentMode) || entry.paidAmountInput <= 0)) {
    return "Cash purchase requires payment mode and paid amount";
  }
  return "";
};

const buildPurchaseFinancials = async (client, entry) => {
  const supplierResult = await client.query(
    "SELECT id, supplier_name FROM suppliers WHERE id = $1 AND active = TRUE FOR SHARE",
    [entry.supplierId]
  );
  if (supplierResult.rows.length === 0) return { error: "Add New Supplier" };

  const productResult = await client.query(
    "SELECT id, product_name, origin_type FROM products WHERE id = $1 AND active = TRUE FOR SHARE",
    [entry.productId]
  );
  if (productResult.rows.length === 0) return { error: "Product not found", status: 404 };

  const supplier = supplierResult.rows[0];
  const product = productResult.rows[0];
  const originType = product.origin_type || "LOCAL";
  const [mandiResult, rebateResult] = await Promise.all([
    client.query("SELECT * FROM mandi_tax_rules WHERE origin_type = $1 AND active = TRUE", [originType]),
    client.query("SELECT * FROM rebate_rules WHERE id = $1 AND active = TRUE", [entry.rebateRuleId]),
  ]);
  if (mandiResult.rows.length === 0 || rebateResult.rows.length === 0) {
    return { error: "Select active mandi tax and rebate rules" };
  }

  const mandiTaxPercent = Number(mandiResult.rows[0].tax_percent);
  const rebateRule = rebateResult.rows[0];
  const rebatePercent = Number(rebateRule.rebate_percent);
  const basicAmount = roundCurrency(entry.quantity * entry.purchaseRate);
  const mandiTaxAmount = roundCurrency(basicAmount * mandiTaxPercent / 100);
  const grossAmount = roundCurrency(basicAmount + mandiTaxAmount + entry.freightCharges + entry.labourCharges + entry.otherCharges);
  const rebateAmount = roundCurrency(grossAmount * rebatePercent / 100);
  const netPayable = roundCurrency(grossAmount - rebateAmount);
  const paidAmount = entry.purchaseType === "CREDIT" ? 0 : entry.paidAmountInput;
  if (paidAmount > netPayable) return { error: "Paid amount cannot exceed net payable amount" };
  const balanceAmount = roundCurrency(netPayable - paidAmount);
  const effectiveCostPerUnit = roundUnitCost(netPayable / entry.quantity);
  const paymentStatus = balanceAmount === 0 ? "PAID" : paidAmount > 0 ? "PARTIAL" : "PENDING";

  return {
    supplier,
    product,
    originType,
    rebateRule,
    financials: {
      mandiTaxPercent,
      rebatePercent,
      basicAmount,
      mandiTaxAmount,
      grossAmount,
      rebateAmount,
      netPayable,
      paidAmount,
      balanceAmount,
      effectiveCostPerUnit,
      paymentStatus,
    },
  };
};

const getCategoryById = async (client, categoryId) => {
  if (!categoryId) return null;
  const result = await client.query("SELECT * FROM product_categories WHERE id = $1 AND active = TRUE", [categoryId]);
  return result.rows[0] || null;
};

const findCategoryByName = async (client, categoryName) => {
  const name = cleanText(categoryName);
  if (!name) return null;
  const result = await client.query("SELECT * FROM product_categories WHERE LOWER(category_name) = LOWER($1)", [name]);
  return result.rows[0] || null;
};

const insertOpeningStockLot = async (client, { product, lot, actorId, branchId }) => {
  const quantity = parsePositiveNumber(lot.quantity);
  const purchaseRate = parsePositiveNumber(lot.purchase_rate || lot.opening_cost);
  const saleRate = parsePositiveNumber(lot.sale_rate) || Number(product.selling_rate || 0);
  const lotName = cleanText(lot.lot_name || lot.lot_number || "Opening Stock Lot");
  const lotSize = nullableText(lot.lot_size || lot.size_grade || lot.size);
  const openingDate = isDateInput(lot.opening_stock_date || lot.purchase_date) ? (lot.opening_stock_date || lot.purchase_date) : toDateKey(new Date());
  const supplierId = parsePositiveInteger(lot.supplier_id);
  const supplierName = nullableText(lot.supplier_name);
  const remarks = nullableText(lot.remarks) || "Opening stock";
  if (!quantity) return { error: "Please enter lot quantity." };
  if (!purchaseRate) return { error: "Please enter opening stock rate." };
  if (!lotName) return { error: "Please enter lot name / size." };

  const duplicateResult = await client.query(
    `
    SELECT id
    FROM inventory_batches
    WHERE product_id = $1
      AND LOWER(COALESCE(lot_name, '')) = LOWER($2)
      AND COALESCE(purchase_date, created_at::date) = $3
      AND COALESCE(supplier_id, 0) = COALESCE($4, 0)
      AND COALESCE(batch_status, 'ACTIVE') <> 'CANCELLED'
    LIMIT 1
    `,
    [product.id, lotName, openingDate, supplierId]
  );
  if (duplicateResult.rows.length > 0) return { error: "Duplicate lot name already exists for this item/date/supplier." };

  const batchNo = `OPEN-${Date.now()}-${product.id}-${Math.floor(Math.random() * 10000)}`;
  const netPayable = roundCurrency(quantity * purchaseRate);
  const batchResult = await client.query(
    `
    INSERT INTO inventory_batches (
      product_id, batch_no, purchase_qty, remaining_qty, purchase_rate, effective_cost_per_unit,
      supplier_id, supplier_name, branch_id, gross_amount, net_payable, balance_amount,
      batch_status, purchase_bill_status, temporary_sale_rate, lot_name, lot_size,
      stock_source, remarks, purchase_date
    )
    VALUES ($1, $2, $3, $3, $4, $4, $5, $6, $7, $8, $8, 0, 'ACTIVE', 'BILL_COMPLETED', $9, $10, $11, 'OPENING_STOCK', $12, $13)
    RETURNING *
    `,
    [
      product.id, batchNo, quantity, purchaseRate, supplierId, supplierName,
      branchId || 1, netPayable, saleRate, lotName, lotSize, remarks, openingDate,
    ]
  );
  await client.query(
    `
    INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id)
    VALUES ($1, $2, 'IN', $3, $4, $5)
    `,
    [product.id, quantity, `Opening stock ${lotName}`, actorId || null, branchId || 1]
  );
  if (saleRate > 0 && Number(product.selling_rate || 0) !== saleRate) {
    await client.query(
      "UPDATE products SET selling_rate = $1, selling_rate_updated_at = CURRENT_TIMESTAMP, selling_rate_updated_by = $2 WHERE id = $3",
      [saleRate, actorId || null, product.id]
    );
    await client.query(
      "INSERT INTO sale_rate_history (product_id, old_selling_rate, new_selling_rate, changed_by, reason) VALUES ($1, $2, $3, $4, $5)",
      [product.id, product.selling_rate || 0, saleRate, actorId || 1, `Opening stock sale rate for ${lotName}`]
    );
  }
  await client.query(
    `
    INSERT INTO product_audit_trail (product_id, action, old_value, new_value, reason, edited_by)
    VALUES ($1, 'OPENING_STOCK', NULL, $2::jsonb, $3, $4)
    `,
    [product.id, JSON.stringify(batchResult.rows[0]), remarks, actorId || null]
  );
  return { batch: batchResult.rows[0] };
};

const getPurchasePartiesForArrival = async (client, entry) => {
  const [supplierResult, productResult] = await Promise.all([
    client.query("SELECT id, supplier_name FROM suppliers WHERE id = $1 AND active = TRUE FOR SHARE", [entry.supplierId]),
    client.query("SELECT id, product_name, origin_type, selling_rate FROM products WHERE id = $1 AND active = TRUE FOR SHARE", [entry.productId]),
  ]);
  if (supplierResult.rows.length === 0) return { error: "Add New Supplier" };
  if (productResult.rows.length === 0) return { error: "Product not found", status: 404 };
  return { supplier: supplierResult.rows[0], product: productResult.rows[0] };
};

const recalculateSalesForBatch = async (client, batchId) => {
  const saleRows = await client.query(
    `
    SELECT DISTINCT si.sale_id
    FROM sale_batch_allocations sba
    JOIN sale_items si ON si.id = sba.sale_item_id
    WHERE sba.inventory_batch_id = $1
    `,
    [batchId]
  );
  for (const row of saleRows.rows) {
    const saleId = row.sale_id;
    await client.query(
      `
      WITH item_costs AS (
        SELECT
          si.id,
          COALESCE(SUM(sba.cost_amount), 0) AS cost_amount,
          BOOL_OR(COALESCE(ib.purchase_bill_status, 'BILL_COMPLETED') = 'BILL_PENDING') AS provisional
        FROM sale_items si
        LEFT JOIN sale_batch_allocations sba ON sba.sale_item_id = si.id
        LEFT JOIN inventory_batches ib ON ib.id = sba.inventory_batch_id
        WHERE si.sale_id = $1
        GROUP BY si.id
      ),
      sale_subtotal AS (
        SELECT sale_id, SUM(COALESCE(net_amount, amount)) AS subtotal
        FROM sale_items
        WHERE sale_id = $1
        GROUP BY sale_id
      )
      UPDATE sale_items si
      SET
        cost_amount = item_costs.cost_amount,
        cost_status = CASE WHEN item_costs.provisional THEN 'PROVISIONAL' ELSE 'FINAL' END,
        profit = ROUND((
          COALESCE(si.net_amount, si.amount)
          - CASE
              WHEN sale_subtotal.subtotal > 0
              THEN COALESCE(s.invoice_discount_amount, 0) * (COALESCE(si.net_amount, si.amount) / sale_subtotal.subtotal)
              ELSE 0
            END
          - item_costs.cost_amount
        )::NUMERIC, 2)
      FROM item_costs, sales s, sale_subtotal
      WHERE si.id = item_costs.id
        AND s.id = si.sale_id
        AND sale_subtotal.sale_id = si.sale_id
        AND si.sale_id = $1
      `,
      [saleId]
    );
    await client.query(
      `
      UPDATE sales s
      SET
        total_cost = COALESCE(costs.total_cost, 0),
        profit = ROUND((s.total_amount - COALESCE(costs.total_cost, 0))::NUMERIC, 2),
        profit_status = CASE WHEN COALESCE(costs.has_provisional, FALSE) THEN 'PROVISIONAL' ELSE 'FINAL' END
      FROM (
        SELECT
          sale_id,
          SUM(cost_amount) AS total_cost,
          BOOL_OR(cost_status = 'PROVISIONAL') AS has_provisional
        FROM sale_items
        WHERE sale_id = $1
        GROUP BY sale_id
      ) costs
      WHERE s.id = costs.sale_id
      `,
      [saleId]
    );
  }
};

app.get("/purchases", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        p.*,
        pi.product_id,
        pi.quantity,
        pi.purchase_rate,
        pi.lot_name AS item_lot_name,
        pi.lot_size AS item_lot_size,
        pr.product_name,
        pr.category,
        pr.category_id,
        pr.unit,
        ib.id AS inventory_batch_id,
        ib.batch_no,
        ib.lot_name,
        ib.lot_size,
        ib.stock_source,
        ib.purchase_qty AS batch_purchase_qty,
        ib.remaining_qty AS batch_remaining_qty,
        ib.batch_status
      FROM purchases p
      LEFT JOIN purchase_items pi ON pi.purchase_id = p.id
      LEFT JOIN products pr ON pr.id = pi.product_id
      LEFT JOIN inventory_batches ib ON ib.purchase_id = p.id
      ORDER BY p.purchase_date DESC, p.created_at DESC, p.id DESC
      LIMIT 250
      `
    );
    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Purchases" });
  }
});

app.post("/purchase", async (req, res) => {
  const client = await pool.connect();

  try {
    const entry = readPurchaseEntryPayload(req.body);
    const validationMessage = validatePurchaseEntry(entry);
    if (validationMessage) return res.status(400).json({ message: validationMessage });

    await client.query("BEGIN");
    if (entry.purchaseBillStatus === "BILL_PENDING") {
      const manager = await requireRateManager(entry.actorId, client);
      if (!manager) {
        await client.query("ROLLBACK");
        return res.status(403).json({ message: "Only Owner or Admin can set temporary sale rates for pending stock" });
      }
      const arrival = await getPurchasePartiesForArrival(client, entry);
      if (arrival.error) {
        await client.query("ROLLBACK");
        return res.status(arrival.status || 400).json({ message: arrival.error });
      }
      const provisionalCost = Number(entry.expectedPurchaseRate || 0);
      const provisionalAmount = roundCurrency(entry.quantity * provisionalCost);
      const purchaseResult = await client.query(
        `
        INSERT INTO purchases (
          supplier_id, supplier_name, total_amount, branch_id, created_by,
          basic_amount, gross_amount, net_payable, paid_amount, balance_amount,
          effective_cost_per_unit, purchase_type, payment_status, purchase_date,
          remarks, purchase_bill_status, temporary_sale_rate, expected_purchase_rate
        )
        VALUES ($1, $2, 0, $3, $4, 0, 0, 0, 0, 0, $5, 'PENDING_BILL', 'BILL_PENDING', $6, $7, 'BILL_PENDING', $8, $9)
        RETURNING *
        `,
        [
          arrival.supplier.id, arrival.supplier.supplier_name, entry.branchId, entry.actorId,
          provisionalCost, entry.purchaseDate, entry.remarks, entry.temporarySaleRate, provisionalCost,
        ]
      );
      const purchase = purchaseResult.rows[0];
      await client.query(
        `
        INSERT INTO purchase_items (
          purchase_id, product_id, quantity, purchase_rate, amount, basic_amount,
          net_payable, effective_cost_per_unit
        )
        VALUES ($1, $2, $3, $4, $5, 0, 0, $4)
        `,
        [purchase.id, entry.productId, entry.quantity, provisionalCost, provisionalAmount]
      );
      const batchNo = `PENDING-${Date.now()}-${purchase.id}`;
      await client.query(
        `
        INSERT INTO inventory_batches (
          product_id, batch_no, purchase_qty, remaining_qty, purchase_rate, effective_cost_per_unit,
          supplier_id, supplier_name, branch_id, gross_amount, net_payable, balance_amount,
          purchase_id, batch_status, purchase_bill_status, temporary_sale_rate
        )
        VALUES ($1, $2, $3, $3, $4, $4, $5, $6, $7, 0, 0, 0, $8, 'ACTIVE', 'BILL_PENDING', $9)
        `,
        [
          entry.productId, batchNo, entry.quantity, provisionalCost, arrival.supplier.id,
          arrival.supplier.supplier_name, entry.branchId, purchase.id, entry.temporarySaleRate,
        ]
      );
      await client.query(
        "UPDATE products SET selling_rate = $1, selling_rate_updated_at = CURRENT_TIMESTAMP, selling_rate_updated_by = $2 WHERE id = $3",
        [entry.temporarySaleRate, manager.id, entry.productId]
      );
      await client.query(
        "INSERT INTO sale_rate_history (product_id, old_selling_rate, new_selling_rate, changed_by, reason) VALUES ($1, $2, $3, $4, $5)",
        [entry.productId, arrival.product.selling_rate || 0, entry.temporarySaleRate, manager.id, `Temporary sale rate for pending purchase #${purchase.id}`]
      );
      await client.query(
        "INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id) VALUES ($1, $2, 'IN', $3, $4, $5)",
        [entry.productId, entry.quantity, `Stock arrival pending bill #${purchase.id}`, entry.actorId, entry.branchId]
      );
      await client.query("COMMIT");
      return res.status(201).json({
        success: true,
        message: "Stock Arrival Saved - Bill Pending",
        purchase_id: purchase.id,
        purchase: { ...purchase, product_name: arrival.product.product_name },
      });
    }

    const calculation = await buildPurchaseFinancials(client, entry);
    if (calculation.error) {
      await client.query("ROLLBACK");
      return res.status(calculation.status || 400).json({ message: calculation.error });
    }
    const { supplier, product, originType, rebateRule, financials } = calculation;

    const purchaseResult = await client.query(
      `
      INSERT INTO purchases (
        supplier_id, supplier_name, total_amount, branch_id, created_by, basic_amount,
        mandi_tax_percent, mandi_tax_amount, other_charges, gross_amount,
        rebate_percent, rebate_amount, net_payable, paid_amount, balance_amount,
        payment_timing, effective_cost_per_unit, freight_charges, labour_charges,
        rebate_rule_id, payment_due_days, payment_status, payment_date,
        purchase_type, payment_mode, payment_reference_number, remarks, purchase_bill_status, bill_number, bill_date
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, 'BILL_COMPLETED', $28, $29)
      RETURNING *
      `,
      [
        supplier.id, supplier.supplier_name, financials.netPayable, entry.branchId, entry.actorId, financials.basicAmount,
        financials.mandiTaxPercent, financials.mandiTaxAmount, entry.otherCharges, financials.grossAmount,
        financials.rebatePercent, financials.rebateAmount, financials.netPayable, financials.paidAmount, financials.balanceAmount,
        rebateRule.rule_name, financials.effectiveCostPerUnit, entry.freightCharges, entry.labourCharges,
        rebateRule.id, rebateRule.pay_within_days, financials.paymentStatus, entry.purchaseType === "CREDIT" ? null : entry.paymentDate,
        entry.purchaseType, entry.purchaseType === "CASH" ? entry.paymentMode : null, entry.purchaseType === "CASH" ? entry.paymentReferenceNumber : null,
        entry.remarks,
        entry.billNumber,
        entry.billDate,
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
        purchase.id, entry.productId, entry.quantity, entry.purchaseRate, financials.netPayable, financials.basicAmount,
        financials.mandiTaxAmount, entry.otherCharges, financials.rebateAmount, financials.netPayable, financials.effectiveCostPerUnit,
        entry.freightCharges, entry.labourCharges,
      ]
    );

    const batchNo = `BATCH-${Date.now()}-${purchase.id}`;
    await client.query(
      `
      INSERT INTO inventory_batches (
        product_id, batch_no, purchase_qty, remaining_qty, purchase_rate, effective_cost_per_unit,
        supplier_id, supplier_name, branch_id, mandi_tax_amount, freight_charges, labour_charges,
        other_charges, gross_amount, rebate_amount, net_payable, payment_timing, balance_amount,
        purchase_id, batch_status, purchase_bill_status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 'ACTIVE', 'BILL_COMPLETED')
      `,
      [
        entry.productId,
        batchNo,
        entry.quantity,
        entry.quantity,
        entry.purchaseRate,
        financials.effectiveCostPerUnit,
        supplier.id,
        supplier.supplier_name,
        entry.branchId,
        financials.mandiTaxAmount,
        entry.freightCharges,
        entry.labourCharges,
        entry.otherCharges,
        financials.grossAmount,
        financials.rebateAmount,
        financials.netPayable,
        rebateRule.rule_name,
        financials.balanceAmount,
        purchase.id,
      ]
    );

    await client.query(
      `
      INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id)
      VALUES ($1, $2, 'IN', $3, $4, $5)
      `,
      [entry.productId, entry.quantity, `Purchase #${purchase.id}`, entry.actorId, entry.branchId]
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

app.post("/purchase-bill", async (req, res) => {
  const client = await pool.connect();

  try {
    const baseEntry = readPurchaseEntryPayload(req.body);
    const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
    if (!baseEntry.supplierId) return res.status(400).json({ message: "Add New Supplier" });
    if (!baseEntry.branchId) return res.status(400).json({ message: "Select branch before saving purchase" });
    if (!PURCHASE_BILL_STATUSES.has(baseEntry.purchaseBillStatus)) {
      return res.status(400).json({ message: "Select a valid purchase bill status" });
    }
    if (rawItems.length === 0) return res.status(400).json({ message: "Add at least one purchase item" });
    if (baseEntry.purchaseBillStatus === "BILL_COMPLETED" && !["CASH", "CREDIT"].includes(baseEntry.purchaseType)) {
      return res.status(400).json({ message: "Select Cash or Credit purchase" });
    }
    if (baseEntry.purchaseBillStatus === "BILL_COMPLETED" && !baseEntry.rebateRuleId) {
      return res.status(400).json({ message: "Select active mandi tax and rebate rules" });
    }
    if (
      baseEntry.purchaseType === "CASH" &&
      baseEntry.purchaseBillStatus === "BILL_COMPLETED" &&
      (!SUPPLIER_PAYMENT_MODES.has(baseEntry.paymentMode) || !baseEntry.paidAmountInput)
    ) {
      return res.status(400).json({ message: "Cash purchase requires payment mode and paid amount" });
    }

    const entries = rawItems.map((item) => readPurchaseEntryPayload({
      ...req.body,
      product_id: item.product_id,
      quantity: item.quantity,
      purchase_rate: item.purchase_rate,
      expected_purchase_rate: item.expected_purchase_rate,
      temporary_sale_rate: item.temporary_sale_rate,
      lot_name: item.lot_name,
      lot_size: item.lot_size,
      remarks: cleanText(item.remarks) || baseEntry.remarks,
      paid_amount: 0,
      purchase_type: baseEntry.purchaseBillStatus === "BILL_COMPLETED" ? "CREDIT" : "PENDING_BILL",
    }));

    const validationMessages = entries.map(validatePurchaseEntry).filter(Boolean);
    if (validationMessages.length) return res.status(400).json({ message: validationMessages[0] });

    await client.query("BEGIN");
    if (baseEntry.purchaseBillStatus === "BILL_PENDING") {
      const manager = await requireRateManager(baseEntry.actorId, client);
      if (!manager) {
        await client.query("ROLLBACK");
        return res.status(403).json({ message: "Only Owner or Admin can set temporary sale rates for pending stock" });
      }

      const createdPurchases = [];
      for (const entry of entries) {
        const arrival = await getPurchasePartiesForArrival(client, entry);
        if (arrival.error) {
          await client.query("ROLLBACK");
          return res.status(arrival.status || 400).json({ message: arrival.error });
        }
        const provisionalCost = Number(entry.expectedPurchaseRate || 0);
        const provisionalAmount = roundCurrency(entry.quantity * provisionalCost);
        const purchaseResult = await client.query(
          `
          INSERT INTO purchases (
            supplier_id, supplier_name, total_amount, branch_id, created_by,
            basic_amount, gross_amount, net_payable, paid_amount, balance_amount,
            effective_cost_per_unit, purchase_type, payment_status, purchase_date,
            remarks, purchase_bill_status, temporary_sale_rate, expected_purchase_rate,
            bill_number, bill_date, lot_name, lot_size, stock_source
          )
          VALUES ($1, $2, 0, $3, $4, 0, 0, 0, 0, 0, $5, 'PENDING_BILL', 'BILL_PENDING', $6, $7, 'BILL_PENDING', $8, $9, $10, $11, $12, $13, 'PURCHASE')
          RETURNING *
          `,
          [
            arrival.supplier.id, arrival.supplier.supplier_name, entry.branchId, entry.actorId,
            provisionalCost, entry.purchaseDate, entry.remarks, entry.temporarySaleRate, provisionalCost,
            entry.billNumber, entry.billDate, entry.lotName, entry.lotSize,
          ]
        );
        const purchase = purchaseResult.rows[0];
        await client.query(
          `
          INSERT INTO purchase_items (
            purchase_id, product_id, quantity, purchase_rate, amount, basic_amount,
            net_payable, effective_cost_per_unit, lot_name, lot_size
          )
          VALUES ($1, $2, $3, $4, $5, 0, 0, $4, $6, $7)
          `,
          [purchase.id, entry.productId, entry.quantity, provisionalCost, provisionalAmount, entry.lotName, entry.lotSize]
        );
        const batchNo = `PENDING-${Date.now()}-${purchase.id}`;
        await client.query(
          `
          INSERT INTO inventory_batches (
            product_id, batch_no, purchase_qty, remaining_qty, purchase_rate, effective_cost_per_unit,
            supplier_id, supplier_name, branch_id, gross_amount, net_payable, balance_amount,
            purchase_id, batch_status, purchase_bill_status, temporary_sale_rate, lot_name, lot_size,
            stock_source, remarks, purchase_date
          )
          VALUES ($1, $2, $3, $3, $4, $4, $5, $6, $7, 0, 0, 0, $8, 'ACTIVE', 'BILL_PENDING', $9, $10, $11, 'PURCHASE', $12, $13)
          `,
          [
            entry.productId, batchNo, entry.quantity, provisionalCost, arrival.supplier.id,
            arrival.supplier.supplier_name, entry.branchId, purchase.id, entry.temporarySaleRate,
            entry.lotName, entry.lotSize, entry.remarks, entry.purchaseDate,
          ]
        );
        await client.query(
          "UPDATE products SET selling_rate = $1, selling_rate_updated_at = CURRENT_TIMESTAMP, selling_rate_updated_by = $2 WHERE id = $3",
          [entry.temporarySaleRate, manager.id, entry.productId]
        );
        await client.query(
          "INSERT INTO sale_rate_history (product_id, old_selling_rate, new_selling_rate, changed_by, reason) VALUES ($1, $2, $3, $4, $5)",
          [entry.productId, arrival.product.selling_rate || 0, entry.temporarySaleRate, manager.id, `Temporary sale rate for pending purchase #${purchase.id}`]
        );
        await client.query(
          "INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id) VALUES ($1, $2, 'IN', $3, $4, $5)",
          [entry.productId, entry.quantity, `Stock arrival pending bill #${purchase.id}`, entry.actorId, entry.branchId]
        );
        await client.query(
          "INSERT INTO purchase_audit_trail (purchase_id, action, old_value, new_value, reason, edited_by) VALUES ($1, 'ADDED_ITEM', NULL, $2::jsonb, $3, $4)",
          [purchase.id, JSON.stringify({ purchase, product_name: arrival.product.product_name }), "Purchase cart item added", manager.id]
        );
        createdPurchases.push({ ...purchase, product_name: arrival.product.product_name });
      }
      await client.query("COMMIT");
      return res.status(201).json({
        success: true,
        message: "Stock Arrival Saved - Bill Pending",
        purchase_ids: createdPurchases.map((purchase) => purchase.id),
        purchases: createdPurchases,
      });
    }

    const completedEntries = [];
    const itemBasicTotal = entries.reduce((sum, entry) => sum + Number(entry.quantity || 0) * Number(entry.purchaseRate || 0), 0);
    if (itemBasicTotal <= 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Completed purchase items require valid purchase rates" });
    }
    let usedFreight = 0;
    let usedLabour = 0;
    let usedOther = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const itemBasic = Number(entry.quantity || 0) * Number(entry.purchaseRate || 0);
      const isLast = index === entries.length - 1;
      const freight = isLast ? roundCurrency(baseEntry.freightCharges - usedFreight) : roundCurrency(baseEntry.freightCharges * itemBasic / itemBasicTotal);
      const labour = isLast ? roundCurrency(baseEntry.labourCharges - usedLabour) : roundCurrency(baseEntry.labourCharges * itemBasic / itemBasicTotal);
      const other = isLast ? roundCurrency(baseEntry.otherCharges - usedOther) : roundCurrency(baseEntry.otherCharges * itemBasic / itemBasicTotal);
      usedFreight = roundCurrency(usedFreight + freight);
      usedLabour = roundCurrency(usedLabour + labour);
      usedOther = roundCurrency(usedOther + other);
      const itemEntry = { ...entry, freightCharges: freight, labourCharges: labour, otherCharges: other, purchaseType: "CREDIT", paidAmountInput: 0 };
      const calculation = await buildPurchaseFinancials(client, itemEntry);
      if (calculation.error) {
        await client.query("ROLLBACK");
        return res.status(calculation.status || 400).json({ message: calculation.error });
      }
      completedEntries.push({ entry: itemEntry, ...calculation });
    }

    const netTotal = roundCurrency(completedEntries.reduce((sum, item) => sum + Number(item.financials.netPayable || 0), 0));
    if (baseEntry.purchaseType === "CASH" && baseEntry.paidAmountInput > netTotal) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Paid amount cannot exceed net payable amount" });
    }
    let usedPaid = 0;
    const createdPurchases = [];
    for (let index = 0; index < completedEntries.length; index += 1) {
      const item = completedEntries[index];
      const { entry, supplier, product, originType, rebateRule } = item;
      const isLast = index === completedEntries.length - 1;
      const paidAmount = baseEntry.purchaseType === "CASH"
        ? isLast
          ? roundCurrency(baseEntry.paidAmountInput - usedPaid)
          : roundCurrency(baseEntry.paidAmountInput * Number(item.financials.netPayable || 0) / netTotal)
        : 0;
      usedPaid = roundCurrency(usedPaid + paidAmount);
      const balanceAmount = roundCurrency(Number(item.financials.netPayable || 0) - paidAmount);
      const financials = {
        ...item.financials,
        paidAmount,
        balanceAmount,
        paymentStatus: balanceAmount === 0 ? "PAID" : paidAmount > 0 ? "PARTIAL" : "PENDING",
      };
      const purchaseResult = await client.query(
        `
        INSERT INTO purchases (
          supplier_id, supplier_name, total_amount, branch_id, created_by, basic_amount,
          mandi_tax_percent, mandi_tax_amount, other_charges, gross_amount,
          rebate_percent, rebate_amount, net_payable, paid_amount, balance_amount,
          payment_timing, effective_cost_per_unit, freight_charges, labour_charges,
          rebate_rule_id, payment_due_days, payment_status, payment_date,
          purchase_type, payment_mode, payment_reference_number, remarks, purchase_bill_status, bill_number, bill_date,
          lot_name, lot_size, stock_source
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, 'BILL_COMPLETED', $28, $29, $30, $31, 'PURCHASE')
        RETURNING *
        `,
        [
          supplier.id, supplier.supplier_name, financials.netPayable, entry.branchId, entry.actorId, financials.basicAmount,
          financials.mandiTaxPercent, financials.mandiTaxAmount, entry.otherCharges, financials.grossAmount,
          financials.rebatePercent, financials.rebateAmount, financials.netPayable, financials.paidAmount, financials.balanceAmount,
          rebateRule.rule_name, financials.effectiveCostPerUnit, entry.freightCharges, entry.labourCharges,
          rebateRule.id, rebateRule.pay_within_days, financials.paymentStatus, baseEntry.purchaseType === "CREDIT" ? null : baseEntry.paymentDate,
          baseEntry.purchaseType, baseEntry.purchaseType === "CASH" ? baseEntry.paymentMode : null, baseEntry.purchaseType === "CASH" ? baseEntry.paymentReferenceNumber : null,
          entry.remarks, entry.billNumber, entry.billDate, entry.lotName, entry.lotSize,
        ]
      );
      const purchase = purchaseResult.rows[0];
      await client.query(
        `
        INSERT INTO purchase_items (
          purchase_id, product_id, quantity, purchase_rate, amount, basic_amount,
          mandi_tax_amount, other_charges, rebate_amount, net_payable, effective_cost_per_unit,
          freight_charges, labour_charges, lot_name, lot_size
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        `,
        [
          purchase.id, entry.productId, entry.quantity, entry.purchaseRate, financials.netPayable, financials.basicAmount,
          financials.mandiTaxAmount, entry.otherCharges, financials.rebateAmount, financials.netPayable, financials.effectiveCostPerUnit,
          entry.freightCharges, entry.labourCharges, entry.lotName, entry.lotSize,
        ]
      );
      const batchNo = `BATCH-${Date.now()}-${purchase.id}`;
      await client.query(
        `
        INSERT INTO inventory_batches (
          product_id, batch_no, purchase_qty, remaining_qty, purchase_rate, effective_cost_per_unit,
          supplier_id, supplier_name, branch_id, mandi_tax_amount, freight_charges, labour_charges,
          other_charges, gross_amount, rebate_amount, net_payable, payment_timing, balance_amount,
          purchase_id, batch_status, purchase_bill_status, lot_name, lot_size, stock_source, remarks, purchase_date
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 'ACTIVE', 'BILL_COMPLETED', $20, $21, 'PURCHASE', $22, $23)
        `,
        [
          entry.productId, batchNo, entry.quantity, entry.quantity, entry.purchaseRate, financials.effectiveCostPerUnit,
          supplier.id, supplier.supplier_name, entry.branchId, financials.mandiTaxAmount, entry.freightCharges, entry.labourCharges,
          entry.otherCharges, financials.grossAmount, financials.rebateAmount, financials.netPayable, rebateRule.rule_name,
          financials.balanceAmount, purchase.id, entry.lotName, entry.lotSize, entry.remarks, entry.purchaseDate,
        ]
      );
      await client.query(
        "INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id) VALUES ($1, $2, 'IN', $3, $4, $5)",
        [entry.productId, entry.quantity, `Purchase #${purchase.id}`, entry.actorId, entry.branchId]
      );
      await client.query(
        "INSERT INTO purchase_audit_trail (purchase_id, action, old_value, new_value, reason, edited_by) VALUES ($1, 'ADDED_ITEM', NULL, $2::jsonb, $3, $4)",
        [purchase.id, JSON.stringify({ purchase, product_name: product.product_name, origin_type: originType }), "Purchase cart item added", entry.actorId]
      );
      createdPurchases.push({ ...purchase, product_name: product.product_name, origin_type: originType });
    }

    await client.query("COMMIT");
    return res.status(201).json({
      success: true,
      message: "Purchase Saved",
      purchase_ids: createdPurchases.map((purchase) => purchase.id),
      purchases: createdPurchases,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Purchase Bill Error" });
  } finally {
    client.release();
  }
});

app.put("/purchase/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const purchaseId = parsePositiveInteger(Number(req.params.id));
    const reason = cleanText(req.body.reason);
    const entry = readPurchaseEntryPayload(req.body);
    const validationMessage = validatePurchaseEntry(entry);
    if (!purchaseId) return res.status(400).json({ message: "Invalid purchase" });
    if (!reason) return res.status(400).json({ message: "Edit reason is required" });
    if (validationMessage) return res.status(400).json({ message: validationMessage });

    await client.query("BEGIN");
    const manager = await requireRateManager(req.body.edited_by || entry.actorId, client);
    if (!manager) {
      await client.query("ROLLBACK");
      return res.status(403).json({ message: "Only Owner or Admin can edit purchases" });
    }

    const oldPurchaseResult = await client.query("SELECT * FROM purchases WHERE id = $1 FOR UPDATE", [purchaseId]);
    const oldPurchase = oldPurchaseResult.rows[0];
    if (!oldPurchase) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Purchase not found" });
    }
    if (oldPurchase.purchase_status === "CANCELLED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Cancelled purchase cannot be edited" });
    }

    const oldItemResult = await client.query("SELECT * FROM purchase_items WHERE purchase_id = $1 ORDER BY id LIMIT 1 FOR UPDATE", [purchaseId]);
    const oldItem = oldItemResult.rows[0];
    if (!oldItem) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Purchase item not found" });
    }

    const batchResult = await client.query(
      `
      SELECT *
      FROM inventory_batches
      WHERE purchase_id = $1 OR (purchase_id IS NULL AND batch_no LIKE $2)
      ORDER BY purchase_id NULLS LAST, id
      LIMIT 1
      FOR UPDATE
      `,
      [purchaseId, `%-${purchaseId}`]
    );
    const batch = batchResult.rows[0];
    if (!batch) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Linked inventory batch not found" });
    }

    const oldQuantity = Number(batch.purchase_qty || oldItem.quantity || 0);
    const oldRemaining = Number(batch.remaining_qty || 0);
    const soldQuantity = roundUnitCost(oldQuantity - oldRemaining);
    const productChanged = Number(oldItem.product_id) !== Number(entry.productId);
    if (entry.purchaseBillStatus === "BILL_PENDING") {
      if (oldPurchase.purchase_bill_status !== "BILL_PENDING") {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Only pending bill arrivals can be edited as pending entries" });
      }
      const managerForRate = await requireRateManager(entry.actorId, client);
      if (!managerForRate) {
        await client.query("ROLLBACK");
        return res.status(403).json({ message: "Only Owner or Admin can update temporary sale rates" });
      }
      if (productChanged && soldQuantity > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({ message: "This purchase batch has already been sold. Product cannot be changed safely." });
      }
      if (entry.quantity < soldQuantity) {
        await client.query("ROLLBACK");
        return res.status(409).json({ message: `Quantity cannot be less than already sold quantity (${soldQuantity}).` });
      }
      const arrival = await getPurchasePartiesForArrival(client, entry);
      if (arrival.error) {
        await client.query("ROLLBACK");
        return res.status(arrival.status || 400).json({ message: arrival.error });
      }
      const nextRemainingForPending = productChanged ? entry.quantity : roundUnitCost(oldRemaining + (entry.quantity - oldQuantity));
      const provisionalCost = Number(entry.expectedPurchaseRate || 0);
      const oldSnapshot = { purchase: oldPurchase, item: oldItem, batch };
      const purchaseResult = await client.query(
        `
        UPDATE purchases
        SET supplier_id = $1, supplier_name = $2, branch_id = $3, purchase_date = $4,
            remarks = $5, temporary_sale_rate = $6, expected_purchase_rate = $7,
            effective_cost_per_unit = $7, edited_by = $8, edited_at = CURRENT_TIMESTAMP,
            edit_reason = $9, lot_name = $11, lot_size = $12
        WHERE id = $10
        RETURNING *
        `,
        [
          arrival.supplier.id, arrival.supplier.supplier_name, entry.branchId, entry.purchaseDate,
          entry.remarks, entry.temporarySaleRate, provisionalCost, manager.id, reason, purchaseId,
          entry.lotName, entry.lotSize,
        ]
      );
      await client.query(
        `
        UPDATE purchase_items
        SET product_id = $1, quantity = $2, purchase_rate = $3,
            amount = $4, effective_cost_per_unit = $3, lot_name = $6, lot_size = $7
        WHERE id = $5
        `,
        [entry.productId, entry.quantity, provisionalCost, roundCurrency(entry.quantity * provisionalCost), oldItem.id, entry.lotName, entry.lotSize]
      );
      const batchUpdateResult = await client.query(
        `
        UPDATE inventory_batches
        SET product_id = $1, purchase_qty = $2, remaining_qty = $3,
            purchase_rate = $4, effective_cost_per_unit = $4,
            supplier_id = $5, supplier_name = $6, branch_id = $7,
            purchase_bill_status = 'BILL_PENDING', temporary_sale_rate = $8,
            lot_name = $10, lot_size = $11, remarks = $12, purchase_date = $13
        WHERE id = $9
        RETURNING *
        `,
        [
          entry.productId, entry.quantity, nextRemainingForPending, provisionalCost,
          arrival.supplier.id, arrival.supplier.supplier_name, entry.branchId,
          entry.temporarySaleRate, batch.id, entry.lotName, entry.lotSize, entry.remarks, entry.purchaseDate,
        ]
      );
      await client.query(
        "UPDATE products SET selling_rate = $1, selling_rate_updated_at = CURRENT_TIMESTAMP, selling_rate_updated_by = $2 WHERE id = $3",
        [entry.temporarySaleRate, managerForRate.id, entry.productId]
      );
      if (productChanged) {
        await client.query(
          "INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id) VALUES ($1, $2, 'OUT', $3, $4, $5), ($6, $7, 'IN', $8, $4, $5)",
          [oldItem.product_id, oldRemaining, `Pending arrival #${purchaseId} product changed`, manager.id, entry.branchId, entry.productId, entry.quantity, `Pending arrival #${purchaseId} product changed`]
        );
      } else if (entry.quantity !== oldQuantity) {
        const delta = roundUnitCost(entry.quantity - oldQuantity);
        await client.query(
          "INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id) VALUES ($1, $2, $3, $4, $5, $6)",
          [entry.productId, Math.abs(delta), delta > 0 ? "IN" : "OUT", `Pending arrival #${purchaseId} edited`, manager.id, entry.branchId]
        );
      }
      const newSnapshot = { purchase: purchaseResult.rows[0], batch: batchUpdateResult.rows[0] };
      await client.query(
        "INSERT INTO purchase_audit_trail (purchase_id, action, old_value, new_value, reason, edited_by) VALUES ($1, 'EDIT_PENDING_ARRIVAL', $2::jsonb, $3::jsonb, $4, $5)",
        [purchaseId, JSON.stringify(oldSnapshot), JSON.stringify(newSnapshot), reason, manager.id]
      );
      await client.query("COMMIT");
      return res.json({ success: true, purchase: purchaseResult.rows[0] });
    }
    if (productChanged && soldQuantity > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "This purchase batch has already been sold. Product cannot be changed safely." });
    }
    if (entry.quantity < soldQuantity) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: `Quantity cannot be less than already sold quantity (${soldQuantity}).` });
    }
    const nextRemaining = productChanged ? entry.quantity : roundUnitCost(oldRemaining + (entry.quantity - oldQuantity));
    if (nextRemaining < 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "Inventory would become negative. Reduce sold stock first." });
    }

    const calculation = await buildPurchaseFinancials(client, entry);
    if (calculation.error) {
      await client.query("ROLLBACK");
      return res.status(calculation.status || 400).json({ message: calculation.error });
    }
    const { supplier, product, originType, rebateRule, financials } = calculation;
    const oldSnapshot = { purchase: oldPurchase, item: oldItem, batch };

    const purchaseResult = await client.query(
      `
      UPDATE purchases
      SET supplier_id = $1, supplier_name = $2, total_amount = $3, branch_id = $4,
          basic_amount = $5, mandi_tax_percent = $6, mandi_tax_amount = $7,
          other_charges = $8, gross_amount = $9, rebate_percent = $10,
          rebate_amount = $11, net_payable = $12, paid_amount = $13,
          balance_amount = $14, payment_timing = $15, effective_cost_per_unit = $16,
          freight_charges = $17, labour_charges = $18, rebate_rule_id = $19,
          payment_due_days = $20, payment_status = $21, payment_date = $22,
          purchase_type = $23, payment_mode = $24, payment_reference_number = $25,
          remarks = $26, purchase_status = 'EDITED', edited_by = $27,
          edited_at = CURRENT_TIMESTAMP, edit_reason = $28,
          purchase_bill_status = 'BILL_COMPLETED', bill_number = $29, bill_date = $30,
          lot_name = $32, lot_size = $33, stock_source = 'PURCHASE'
      WHERE id = $31
      RETURNING *
      `,
      [
        supplier.id, supplier.supplier_name, financials.netPayable, entry.branchId,
        financials.basicAmount, financials.mandiTaxPercent, financials.mandiTaxAmount,
        entry.otherCharges, financials.grossAmount, financials.rebatePercent,
        financials.rebateAmount, financials.netPayable, financials.paidAmount,
        financials.balanceAmount, rebateRule.rule_name, financials.effectiveCostPerUnit,
        entry.freightCharges, entry.labourCharges, rebateRule.id,
        rebateRule.pay_within_days, financials.paymentStatus,
        entry.purchaseType === "CREDIT" ? null : entry.paymentDate,
        entry.purchaseType, entry.purchaseType === "CASH" ? entry.paymentMode : null,
        entry.purchaseType === "CASH" ? entry.paymentReferenceNumber : null,
        entry.remarks, manager.id, reason, entry.billNumber, entry.billDate, purchaseId,
        entry.lotName, entry.lotSize,
      ]
    );

    await client.query(
      `
      UPDATE purchase_items
      SET product_id = $1, quantity = $2, purchase_rate = $3, amount = $4,
          basic_amount = $5, mandi_tax_amount = $6, other_charges = $7,
          rebate_amount = $8, net_payable = $9, effective_cost_per_unit = $10,
          freight_charges = $11, labour_charges = $12, lot_name = $14, lot_size = $15
      WHERE id = $13
      `,
      [
        entry.productId, entry.quantity, entry.purchaseRate, financials.netPayable,
        financials.basicAmount, financials.mandiTaxAmount, entry.otherCharges,
        financials.rebateAmount, financials.netPayable, financials.effectiveCostPerUnit,
        entry.freightCharges, entry.labourCharges, oldItem.id, entry.lotName, entry.lotSize,
      ]
    );

    const batchUpdateResult = await client.query(
      `
      UPDATE inventory_batches
      SET purchase_id = $1, product_id = $2, purchase_qty = $3, remaining_qty = $4,
          purchase_rate = $5, effective_cost_per_unit = $6, supplier_id = $7,
          supplier_name = $8, branch_id = $9, mandi_tax_amount = $10,
          freight_charges = $11, labour_charges = $12, other_charges = $13,
          gross_amount = $14, rebate_amount = $15, net_payable = $16,
          payment_timing = $17, balance_amount = $18, batch_status = 'ACTIVE',
          purchase_bill_status = 'BILL_COMPLETED', lot_name = $20, lot_size = $21,
          stock_source = 'PURCHASE', remarks = $22, purchase_date = $23
      WHERE id = $19
      RETURNING *
      `,
      [
        purchaseId, entry.productId, entry.quantity, nextRemaining, entry.purchaseRate,
        financials.effectiveCostPerUnit, supplier.id, supplier.supplier_name, entry.branchId,
        financials.mandiTaxAmount, entry.freightCharges, entry.labourCharges, entry.otherCharges,
        financials.grossAmount, financials.rebateAmount, financials.netPayable,
        rebateRule.rule_name, financials.balanceAmount, batch.id,
        entry.lotName, entry.lotSize, entry.remarks, entry.purchaseDate,
      ]
    );

    if (productChanged) {
      await client.query(
        "INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id) VALUES ($1, $2, 'OUT', $3, $4, $5), ($6, $7, 'IN', $8, $4, $5)",
        [oldItem.product_id, oldRemaining, `Purchase #${purchaseId} product changed`, manager.id, entry.branchId, entry.productId, entry.quantity, `Purchase #${purchaseId} product changed`]
      );
    } else if (entry.quantity !== oldQuantity) {
      const delta = roundUnitCost(entry.quantity - oldQuantity);
      await client.query(
        "INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id) VALUES ($1, $2, $3, $4, $5, $6)",
        [entry.productId, Math.abs(delta), delta > 0 ? "IN" : "OUT", `Purchase #${purchaseId} edited`, manager.id, entry.branchId]
      );
    }

    const newSnapshot = {
      purchase: purchaseResult.rows[0],
      item: { ...oldItem, product_id: entry.productId, quantity: entry.quantity, purchase_rate: entry.purchaseRate },
      batch: batchUpdateResult.rows[0],
      product_name: product.product_name,
      origin_type: originType,
    };
    await client.query(
      `
      INSERT INTO purchase_audit_trail (purchase_id, action, old_value, new_value, reason, edited_by)
      VALUES ($1, 'EDIT', $2::jsonb, $3::jsonb, $4, $5)
      `,
      [purchaseId, JSON.stringify(oldSnapshot), JSON.stringify(newSnapshot), reason, manager.id]
    );

    await client.query("COMMIT");
    return res.json({ success: true, purchase: newSnapshot.purchase });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Updating Purchase" });
  } finally {
    client.release();
  }
});

app.post("/purchase/:id/complete-bill", async (req, res) => {
  const client = await pool.connect();
  try {
    const purchaseId = parsePositiveInteger(Number(req.params.id));
    const entry = readPurchaseEntryPayload({ ...req.body, purchase_bill_status: "BILL_COMPLETED" });
    const validationMessage = validatePurchaseEntry(entry);
    if (!purchaseId) return res.status(400).json({ message: "Invalid purchase" });
    if (validationMessage) return res.status(400).json({ message: validationMessage });

    await client.query("BEGIN");
    const manager = await requireRateManager(req.body.edited_by || entry.actorId, client);
    if (!manager) {
      await client.query("ROLLBACK");
      return res.status(403).json({ message: "Only Owner or Admin can complete pending purchase bills" });
    }
    const oldPurchaseResult = await client.query("SELECT * FROM purchases WHERE id = $1 FOR UPDATE", [purchaseId]);
    const oldPurchase = oldPurchaseResult.rows[0];
    if (!oldPurchase) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Purchase not found" });
    }
    if (oldPurchase.purchase_status === "CANCELLED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Cancelled purchase cannot be completed" });
    }
    if (oldPurchase.purchase_bill_status !== "BILL_PENDING") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Only pending purchase bills can be completed" });
    }
    const oldItemResult = await client.query("SELECT * FROM purchase_items WHERE purchase_id = $1 ORDER BY id LIMIT 1 FOR UPDATE", [purchaseId]);
    const oldItem = oldItemResult.rows[0];
    const batchResult = await client.query("SELECT * FROM inventory_batches WHERE purchase_id = $1 ORDER BY id LIMIT 1 FOR UPDATE", [purchaseId]);
    const batch = batchResult.rows[0];
    if (!oldItem || !batch) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Linked pending inventory batch not found" });
    }
    const oldQuantity = Number(batch.purchase_qty || oldItem.quantity || 0);
    const oldRemaining = Number(batch.remaining_qty || 0);
    const soldQuantity = roundUnitCost(oldQuantity - oldRemaining);
    if (Number(oldItem.product_id) !== Number(entry.productId) && soldQuantity > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "This pending arrival has already been sold. Product cannot be changed while completing the bill." });
    }
    if (entry.quantity < soldQuantity) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: `Quantity cannot be less than already sold quantity (${soldQuantity}).` });
    }
    const nextRemaining = roundUnitCost(oldRemaining + (entry.quantity - oldQuantity));
    const calculation = await buildPurchaseFinancials(client, entry);
    if (calculation.error) {
      await client.query("ROLLBACK");
      return res.status(calculation.status || 400).json({ message: calculation.error });
    }
    const { supplier, rebateRule, financials } = calculation;
    const oldSnapshot = { purchase: oldPurchase, item: oldItem, batch };
    const purchaseResult = await client.query(
      `
      UPDATE purchases
      SET supplier_id = $1, supplier_name = $2, total_amount = $3, branch_id = $4,
          basic_amount = $5, mandi_tax_percent = $6, mandi_tax_amount = $7,
          other_charges = $8, gross_amount = $9, rebate_percent = $10,
          rebate_amount = $11, net_payable = $12, paid_amount = $13,
          balance_amount = $14, payment_timing = $15, effective_cost_per_unit = $16,
          freight_charges = $17, labour_charges = $18, rebate_rule_id = $19,
          payment_due_days = $20, payment_status = $21, payment_date = $22,
          purchase_type = $23, payment_mode = $24, payment_reference_number = $25,
          remarks = $26, purchase_status = 'ACTIVE', purchase_bill_status = 'BILL_COMPLETED',
          bill_number = $27, bill_date = $28, edited_by = $29,
          edited_at = CURRENT_TIMESTAMP, edit_reason = $30,
          lot_name = $32, lot_size = $33, stock_source = 'PURCHASE'
      WHERE id = $31
      RETURNING *
      `,
      [
        supplier.id, supplier.supplier_name, financials.netPayable, entry.branchId,
        financials.basicAmount, financials.mandiTaxPercent, financials.mandiTaxAmount,
        entry.otherCharges, financials.grossAmount, financials.rebatePercent,
        financials.rebateAmount, financials.netPayable, financials.paidAmount,
        financials.balanceAmount, rebateRule.rule_name, financials.effectiveCostPerUnit,
        entry.freightCharges, entry.labourCharges, rebateRule.id,
        rebateRule.pay_within_days, financials.paymentStatus,
        entry.purchaseType === "CREDIT" ? null : entry.paymentDate,
        entry.purchaseType, entry.purchaseType === "CASH" ? entry.paymentMode : null,
        entry.purchaseType === "CASH" ? entry.paymentReferenceNumber : null,
        entry.remarks, entry.billNumber, entry.billDate, manager.id,
        cleanText(req.body.reason) || "Pending purchase bill completed", purchaseId,
        entry.lotName, entry.lotSize,
      ]
    );
    await client.query(
      `
      UPDATE purchase_items
      SET product_id = $1, quantity = $2, purchase_rate = $3, amount = $4,
          basic_amount = $5, mandi_tax_amount = $6, other_charges = $7,
          rebate_amount = $8, net_payable = $9, effective_cost_per_unit = $10,
          freight_charges = $11, labour_charges = $12, lot_name = $14, lot_size = $15
      WHERE id = $13
      `,
      [
        entry.productId, entry.quantity, entry.purchaseRate, financials.netPayable,
        financials.basicAmount, financials.mandiTaxAmount, entry.otherCharges,
        financials.rebateAmount, financials.netPayable, financials.effectiveCostPerUnit,
        entry.freightCharges, entry.labourCharges, oldItem.id, entry.lotName, entry.lotSize,
      ]
    );
    const batchUpdateResult = await client.query(
      `
      UPDATE inventory_batches
      SET product_id = $1, purchase_qty = $2, remaining_qty = $3,
          purchase_rate = $4, effective_cost_per_unit = $5, supplier_id = $6,
          supplier_name = $7, branch_id = $8, mandi_tax_amount = $9,
          freight_charges = $10, labour_charges = $11, other_charges = $12,
          gross_amount = $13, rebate_amount = $14, net_payable = $15,
          payment_timing = $16, balance_amount = $17, purchase_bill_status = 'BILL_COMPLETED',
          temporary_sale_rate = 0, lot_name = $19, lot_size = $20,
          stock_source = 'PURCHASE', remarks = $21, purchase_date = $22
      WHERE id = $18
      RETURNING *
      `,
      [
        entry.productId, entry.quantity, nextRemaining, entry.purchaseRate, financials.effectiveCostPerUnit,
        supplier.id, supplier.supplier_name, entry.branchId, financials.mandiTaxAmount,
        entry.freightCharges, entry.labourCharges, entry.otherCharges, financials.grossAmount,
        financials.rebateAmount, financials.netPayable, rebateRule.rule_name, financials.balanceAmount, batch.id,
        entry.lotName, entry.lotSize, entry.remarks, entry.purchaseDate,
      ]
    );
    await client.query(
      "UPDATE sale_batch_allocations SET purchase_rate = $1, cost_amount = ROUND((quantity * $1)::NUMERIC, 2) WHERE inventory_batch_id = $2",
      [financials.effectiveCostPerUnit, batch.id]
    );
    await recalculateSalesForBatch(client, batch.id);
    if (entry.quantity !== oldQuantity) {
      const delta = roundUnitCost(entry.quantity - oldQuantity);
      await client.query(
        "INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id) VALUES ($1, $2, $3, $4, $5, $6)",
        [entry.productId, Math.abs(delta), delta > 0 ? "IN" : "OUT", `Pending bill #${purchaseId} completed quantity adjustment`, manager.id, entry.branchId]
      );
    }
    const newSnapshot = { purchase: purchaseResult.rows[0], batch: batchUpdateResult.rows[0] };
    await client.query(
      "INSERT INTO purchase_audit_trail (purchase_id, action, old_value, new_value, reason, edited_by) VALUES ($1, 'COMPLETE_BILL', $2::jsonb, $3::jsonb, $4, $5)",
      [purchaseId, JSON.stringify(oldSnapshot), JSON.stringify(newSnapshot), cleanText(req.body.reason) || "Pending purchase bill completed", manager.id]
    );
    await client.query("COMMIT");
    return res.json({ success: true, purchase: purchaseResult.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Completing Pending Purchase Bill" });
  } finally {
    client.release();
  }
});

app.post("/purchase/:id/cancel", async (req, res) => {
  const client = await pool.connect();
  try {
    const purchaseId = parsePositiveInteger(Number(req.params.id));
    const reason = cleanText(req.body.reason);
    const cancelledBy = parsePositiveInteger(req.body.cancelled_by);
    if (!purchaseId || !reason) return res.status(400).json({ message: "Cancellation reason is required" });

    await client.query("BEGIN");
    const manager = await requireRateManager(cancelledBy, client);
    if (!manager) {
      await client.query("ROLLBACK");
      return res.status(403).json({ message: "Only Owner or Admin can cancel purchases" });
    }
    const purchaseResult = await client.query("SELECT * FROM purchases WHERE id = $1 FOR UPDATE", [purchaseId]);
    const purchase = purchaseResult.rows[0];
    if (!purchase) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Purchase not found" });
    }
    if (purchase.purchase_status === "CANCELLED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Purchase is already cancelled" });
    }
    const itemResult = await client.query("SELECT * FROM purchase_items WHERE purchase_id = $1 ORDER BY id LIMIT 1 FOR UPDATE", [purchaseId]);
    const item = itemResult.rows[0];
    const batchResult = await client.query(
      `
      SELECT *
      FROM inventory_batches
      WHERE purchase_id = $1 OR (purchase_id IS NULL AND batch_no LIKE $2)
      ORDER BY purchase_id NULLS LAST, id
      LIMIT 1
      FOR UPDATE
      `,
      [purchaseId, `%-${purchaseId}`]
    );
    const batch = batchResult.rows[0];
    if (!item || !batch) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Linked purchase inventory not found" });
    }
    const purchaseQty = Number(batch.purchase_qty || item.quantity || 0);
    const remainingQty = Number(batch.remaining_qty || 0);
    const soldQuantity = roundUnitCost(purchaseQty - remainingQty);
    if (soldQuantity > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        message: purchase.purchase_bill_status === "BILL_PENDING"
          ? "Cannot cancel. Stock from this arrival has already been sold."
          : "This purchase cannot be cancelled because stock from this batch has already been sold.",
      });
    }
    const oldSnapshot = { purchase, item, batch };
    const updatedPurchase = await client.query(
      `
      UPDATE purchases
      SET purchase_status = 'CANCELLED', cancelled_by = $1, cancelled_at = CURRENT_TIMESTAMP,
          cancellation_reason = $2, balance_amount = 0, payment_status = 'CANCELLED'
      WHERE id = $3
      RETURNING *
      `,
      [manager.id, reason, purchaseId]
    );
    const updatedBatch = await client.query(
      `
      UPDATE inventory_batches
      SET remaining_qty = 0, batch_status = 'CANCELLED', purchase_id = $1
      WHERE id = $2
      RETURNING *
      `,
      [purchaseId, batch.id]
    );
    if (remainingQty > 0) {
      await client.query(
        "INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id) VALUES ($1, $2, 'OUT', $3, $4, $5)",
        [item.product_id, remainingQty, `Purchase #${purchaseId} cancelled`, manager.id, purchase.branch_id]
      );
    }
    const newSnapshot = { purchase: updatedPurchase.rows[0], item, batch: updatedBatch.rows[0] };
    await client.query(
      `
      INSERT INTO purchase_audit_trail (purchase_id, action, old_value, new_value, reason, edited_by)
      VALUES ($1, 'CANCEL', $2::jsonb, $3::jsonb, $4, $5)
      `,
      [purchaseId, JSON.stringify(oldSnapshot), JSON.stringify(newSnapshot), reason, manager.id]
    );
    await client.query("COMMIT");
    return res.json({ success: true, purchase: updatedPurchase.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Cancelling Purchase" });
  } finally {
    client.release();
  }
});

app.post("/sales", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      product_id,
      quantity,
      branch_id,
      created_by,
      customer,
      invoice_discount,
      payments,
      bill_datetime,
      bill_date,
      date_override_reason,
      backdate_reason,
    } = req.body;
    const parsedBranchId = parsePositiveInteger(branch_id);
    const parsedCreatedBy = parsePositiveInteger(created_by) || 1;
    const parsedInvoiceDiscount = parseNonNegativeNumber(invoice_discount);
    const rawBillDateTime = cleanText(bill_datetime || "");
    const rawBillDate = cleanText(bill_date || rawBillDateTime || "");
    const transactionDate = toBusinessDateKey(rawBillDate);
    const requestedBillDateTime = rawBillDateTime || `${transactionDate}T00:00`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(transactionDate)) {
      return res.status(400).json({ message: "Select a valid bill date" });
    }
    const todayDate = toDateKey(new Date());
    const isBackdatedBill = transactionDate < todayDate;
    const isFutureBill = transactionDate > todayDate;
    if (transactionDate !== todayDate) {
      const dateOverrideUser = await getPermissionUser(parsedCreatedBy, "pos_date_override", ["Owner", "Admin"], client);
      if (!dateOverrideUser) {
        return res.status(403).json({ message: "You do not have permission to change bill date" });
      }
      if (isBackdatedBill && req.body.backdate_confirmed !== true) {
        return res.status(409).json({
          message: `You are creating a backdated POS bill for ${transactionDate}. Continue?`,
          requires_backdate_confirmation: true,
          bill_date: transactionDate,
        });
      }
      if (isFutureBill) {
        if (!["Owner", "Admin"].includes(dateOverrideUser.role_name)) {
          return res.status(403).json({ message: "Only Owner/Admin can confirm a future bill date" });
        }
        if (req.body.future_date_confirmed !== true) {
          return res.status(409).json({
            message: `You are creating a future-dated POS bill for ${transactionDate}. Continue?`,
            requires_future_date_confirmation: true,
            bill_date: transactionDate,
          });
        }
      }
    }
    const requestedItems = Array.isArray(req.body.items)
      ? req.body.items
      : [{ product_id, quantity, discount_amount: 0 }];
    const parsedItems = requestedItems.map((item) => ({
      productId: parsePositiveInteger(item.product_id),
      quantity: parsePositiveNumber(item.quantity),
      discountAmount: parseNonNegativeNumber(item.discount_amount),
      hasRequestedRate: item.selling_rate !== undefined && item.selling_rate !== null && String(item.selling_rate).trim() !== "",
      requestedRate: item.selling_rate !== undefined && item.selling_rate !== null && String(item.selling_rate).trim() !== ""
        ? parseNonNegativeNumber(item.selling_rate)
        : null,
    }));
    const selectedCustomerId = parsePositiveInteger(customer?.account_id || customer?.customer_id);
    const typedCustomerName = customer?.name?.trim() || null;
    const customerMobile = customer?.mobile?.trim() || null;
    const customerNotes = customer?.notes?.trim() || null;

    if (
      !parsedBranchId ||
      parsedInvoiceDiscount === null ||
      parsedItems.length === 0 ||
      parsedItems.some((item) => !item.productId || !item.quantity || item.discountAmount === null || (item.hasRequestedRate && item.requestedRate === null))
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

    let customerAccount;
    if (selectedCustomerId) {
      const customerResult = await client.query("SELECT * FROM customers WHERE id = $1 AND active = TRUE FOR SHARE", [selectedCustomerId]);
      if (customerResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Selected customer account is not active" });
      }
      customerAccount = customerResult.rows[0];
    } else {
      customerAccount = await getWalkInCustomer(client);
      if (!customerAccount) {
        await client.query("ROLLBACK");
        return res.status(500).json({ message: "Walk-in Customer account is not configured" });
      }
    }
    const customerId = customerAccount.id;
    const customerName = typedCustomerName || customerAccount.customer_name || "Walk-in Customer";

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
    let rateOverrideUser = null;
    for (const requestedItem of parsedItems) {
      const product = productsById.get(requestedItem.productId);
      const defaultSellingRate = Number(product.selling_rate);
      const manualRateOverride = requestedItem.hasRequestedRate && roundCurrency(requestedItem.requestedRate) !== roundCurrency(defaultSellingRate);
      if (manualRateOverride && !rateOverrideUser) {
        rateOverrideUser = await getPermissionUser(parsedCreatedBy, "manual_pos_rate_override", ["Owner", "Admin"], client);
      }
      if (manualRateOverride && !rateOverrideUser) {
        await client.query("ROLLBACK");
        return res.status(403).json({ message: "You do not have permission to change sale rate" });
      }
      if (manualRateOverride && requestedItem.requestedRate === 0) {
        if (!["Owner", "Admin"].includes(rateOverrideUser.role_name) || req.body.zero_rate_confirmed !== true) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            message: "Zero sale rate requires Owner/Admin confirmation",
            requires_zero_rate_confirmation: true,
            product_name: product.product_name,
          });
        }
      }
      const sellingRate = manualRateOverride ? Number(requestedItem.requestedRate) : defaultSellingRate;
      if (!Number.isFinite(sellingRate) || sellingRate < 0 || (sellingRate === 0 && !(manualRateOverride && req.body.zero_rate_confirmed === true))) {
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
        SELECT
          id,
          remaining_qty,
          COALESCE(effective_cost_per_unit, purchase_rate) AS purchase_rate,
          COALESCE(purchase_bill_status, 'BILL_COMPLETED') AS purchase_bill_status
          FROM inventory_batches
          WHERE product_id = $1
            AND branch_id = $2
            AND remaining_qty > 0
            AND COALESCE(batch_status, 'ACTIVE') <> 'CANCELLED'
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
          costStatus: batch.purchase_bill_status === "BILL_PENDING" ? "PROVISIONAL" : "FINAL",
        });
        quantityToDeduct -= deductedQuantity;
        itemCost += costAmount;
      }

      const costPerUnit = requestedItem.quantity > 0 ? itemCost / requestedItem.quantity : 0;
      if (manualRateOverride && sellingRate < costPerUnit) {
        if (!["Owner", "Admin"].includes(rateOverrideUser.role_name)) {
          await client.query("ROLLBACK");
          return res.status(403).json({ message: "Only Owner/Admin can confirm below-cost sale" });
        }
        if (req.body.below_cost_confirmed !== true) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            message: `This rate is below cost for ${product.product_name}. Continue?`,
            requires_below_cost_confirmation: true,
            product_name: product.product_name,
            cost_per_unit: roundCurrency(costPerUnit),
            selling_rate: sellingRate,
          });
        }
      }

      invoiceItems.push({
        ...requestedItem,
        product,
        sellingRate,
        defaultSellingRate,
        manualRateOverride,
        grossAmount: itemGross,
        netAmount: roundCurrency(itemGross - requestedItem.discountAmount),
        costAmount: roundCurrency(itemCost),
        costStatus: allocations.some((allocation) => allocation.costStatus === "PROVISIONAL") ? "PROVISIONAL" : "FINAL",
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
    const discountRule = await getMatchingDiscountRule(client, grossAmount, paymentMode);
    const automaticInvoiceDiscount = Math.min(calculateInvoiceDiscount(discountRule, grossAmount), subtotalAfterItemDiscounts);
    const invoiceDiscountAmount = discountRule ? automaticInvoiceDiscount : parsedInvoiceDiscount;

    if (invoiceDiscountAmount > subtotalAfterItemDiscounts) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Invoice discount cannot exceed the cart subtotal" });
    }

    const taxAmount = 0;
    const totalAmount = roundCurrency(subtotalAfterItemDiscounts - invoiceDiscountAmount + taxAmount);
    const profit = roundCurrency(totalAmount - totalCost);
    const profitStatus = invoiceItems.some((item) => item.costStatus === "PROVISIONAL") ? "PROVISIONAL" : "FINAL";
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
        total_amount, total_cost, profit, branch_id, created_by, customer_id,
        customer_name, customer_mobile, customer_notes, payment_mode,
        gross_amount, item_discount_amount, invoice_discount_amount, tax_amount,
        discount_rule_id, discount_rule_name, discount_rule_type, discount_rule_value,
        discount_rule_payment_mode, profit_status, sale_date, transaction_date,
        bill_datetime, backdated_bill, backdate_reason
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
      RETURNING *
      `,
      [
        totalAmount, totalCost, profit, parsedBranchId, parsedCreatedBy, customerId,
        customerName, customerMobile, customerNotes, paymentMode,
        grossAmount, itemDiscountAmount, invoiceDiscountAmount, taxAmount,
        discountRule?.id || null,
        discountRule?.rule_name || null,
        discountRule?.discount_type || null,
        discountRule?.discount_value || 0,
        discountRule?.payment_mode || null,
        profitStatus,
        transactionDate,
        transactionDate,
        requestedBillDateTime,
        isBackdatedBill,
        cleanText(date_override_reason || backdate_reason) || (isBackdatedBill ? "Backdated POS bill created" : null),
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
          sale_id, product_id, quantity, selling_rate, amount, discount_amount, net_amount,
          cost_amount, profit, cost_status, default_selling_rate, manual_rate_override
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id
        `,
        [
          sale.id, item.productId, item.quantity, item.sellingRate, item.grossAmount,
          item.discountAmount, item.netAmount, item.costAmount, itemProfit, item.costStatus,
          item.defaultSellingRate, item.manualRateOverride,
        ]
      );
      const saleItemId = saleItemResult.rows[0].id;

      if (item.manualRateOverride) {
        await client.query(
          `
          INSERT INTO pos_rate_override_audit (
            sale_id, sale_item_id, product_id, product_name, default_rate,
            manual_rate, changed_by, invoice_no, reason
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `,
          [
            sale.id,
            saleItemId,
            item.productId,
            item.product.product_name,
            item.defaultSellingRate,
            item.sellingRate,
            parsedCreatedBy,
            invoiceNo,
            cleanText(item.rate_override_reason || req.body.rate_override_reason) || null,
          ]
        );
      }

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
          default_selling_rate: item.defaultSellingRate,
          manual_rate_override: item.manualRateOverride,
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
        s.customer_id,
        COALESCE(s.customer_name, c.customer_name, 'Walk-in Customer') AS customer_name,
        s.customer_mobile,
        s.payment_mode,
        s.profit_status,
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
        COALESCE(BOOL_OR(COALESCE(si.manual_rate_override, FALSE)), FALSE) AS manual_rate_override_applied,
        COALESCE(
          STRING_AGG(p.product_name || ' x ' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM si.quantity::TEXT)), ', ' ORDER BY si.id),
          'No active items'
        ) AS item_summary
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
      LEFT JOIN sale_items si ON si.sale_id = s.id
      LEFT JOIN products p ON p.id = si.product_id
      GROUP BY s.id, c.customer_name
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

app.get("/sale-returns", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        sr.*,
        s.invoice_no,
        u.full_name AS created_by_name,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'id', sri.id,
              'product_id', sri.product_id,
              'product_name', p.product_name,
              'unit', p.unit,
              'return_quantity', sri.return_quantity,
              'selling_rate', sri.selling_rate,
              'return_amount', sri.return_amount,
              'cost_amount', sri.cost_amount
            ) ORDER BY sri.id
          ) FILTER (WHERE sri.id IS NOT NULL),
          '[]'
        ) AS items
      FROM sale_returns sr
      JOIN sales s ON s.id = sr.sale_id
      LEFT JOIN sale_return_items sri ON sri.sale_return_id = sr.id
      LEFT JOIN products p ON p.id = sri.product_id
      LEFT JOIN users u ON u.id = sr.created_by
      GROUP BY sr.id, s.invoice_no, u.full_name
      ORDER BY sr.return_date DESC, sr.created_at DESC, sr.id DESC
      `
    );
    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Sale Returns" });
  }
});

app.get("/sale-returns/options/:saleId", async (req, res) => {
  try {
    const saleId = parsePositiveInteger(req.params.saleId);
    if (!saleId) return res.status(400).json({ message: "Invalid invoice" });
    const [saleResult, itemsResult] = await Promise.all([
      pool.query("SELECT id, invoice_no, customer_name, customer_mobile, sale_date, total_amount, sale_status FROM sales WHERE id = $1", [saleId]),
      pool.query(
        `
        SELECT
          si.id AS sale_item_id,
          si.product_id,
          p.product_name,
          p.unit,
          si.quantity AS sold_quantity,
          COALESCE(returned.returned_quantity, 0) AS returned_quantity,
          si.quantity - COALESCE(returned.returned_quantity, 0) AS returnable_quantity,
          si.selling_rate,
          COALESCE(si.net_amount, si.amount) AS net_amount,
          si.cost_amount
        FROM sale_items si
        JOIN products p ON p.id = si.product_id
        LEFT JOIN (
          SELECT sale_item_id, SUM(return_quantity) AS returned_quantity
          FROM sale_return_items
          GROUP BY sale_item_id
        ) returned ON returned.sale_item_id = si.id
        WHERE si.sale_id = $1
        ORDER BY si.id
        `,
        [saleId]
      ),
    ]);
    const sale = saleResult.rows[0];
    if (!sale) return res.status(404).json({ message: "Invoice not found" });
    return res.json({ sale, items: itemsResult.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Return Options" });
  }
});

app.post("/sale-returns", async (req, res) => {
  const client = await pool.connect();
  try {
    const saleId = parsePositiveInteger(req.body.sale_id);
    const refundType = normalizeRefundType(req.body.refund_type);
    const returnReason = cleanText(req.body.return_reason);
    const createdBy = parsePositiveInteger(req.body.created_by) || 1;
    const branchId = parsePositiveInteger(req.body.branch_id);
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!saleId || !REFUND_TYPES.has(refundType) || !returnReason || items.length === 0) {
      return res.status(400).json({ message: "Select invoice, products, refund type and return reason" });
    }
    await client.query("BEGIN");
    const saleResult = await client.query("SELECT * FROM sales WHERE id = $1 FOR SHARE", [saleId]);
    const sale = saleResult.rows[0];
    if (!sale || sale.sale_status === "CANCELLED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Select an active invoice for return" });
    }
    const returnNo = `RET-${Date.now()}`;
    const returnResult = await client.query(
      `
      INSERT INTO sale_returns (
        return_no, sale_id, customer_name, customer_mobile, return_date,
        refund_type, return_reason, total_return_amount, total_cost_amount,
        branch_id, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, $8, $9)
      RETURNING *
      `,
      [
        returnNo, saleId, nullableText(req.body.customer_name) || sale.customer_name,
        nullableText(req.body.customer_mobile) || sale.customer_mobile,
        req.body.return_date || toDateKey(new Date()), refundType, returnReason,
        branchId || sale.branch_id, createdBy,
      ]
    );
    const saleReturn = returnResult.rows[0];
    let totalReturnAmount = 0;
    let totalCostAmount = 0;
    for (const requested of items) {
      const saleItemId = parsePositiveInteger(requested.sale_item_id);
      const returnQuantity = parsePositiveNumber(requested.return_quantity);
      if (!saleItemId || !returnQuantity) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Enter valid return quantities" });
      }
      const itemResult = await client.query(
        `
        SELECT
          si.*,
          p.product_name,
          COALESCE(returned.returned_quantity, 0) AS returned_quantity
        FROM sale_items si
        JOIN products p ON p.id = si.product_id
        LEFT JOIN (
          SELECT sale_item_id, SUM(return_quantity) AS returned_quantity
          FROM sale_return_items
          GROUP BY sale_item_id
        ) returned ON returned.sale_item_id = si.id
        WHERE si.id = $1 AND si.sale_id = $2
        FOR SHARE
        `,
        [saleItemId, saleId]
      );
      const saleItem = itemResult.rows[0];
      const returnable = Number(saleItem?.quantity || 0) - Number(saleItem?.returned_quantity || 0);
      if (!saleItem || returnQuantity > returnable) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: `${saleItem?.product_name || "Item"} return quantity exceeds returnable quantity` });
      }
      const returnAmount = roundCurrency((Number(saleItem.net_amount || saleItem.amount || 0) / Number(saleItem.quantity)) * returnQuantity);
      let quantityToRestore = returnQuantity;
      let costAmount = 0;
      const allocations = await client.query(
        `
        SELECT *
        FROM sale_batch_allocations
        WHERE sale_item_id = $1
        ORDER BY id
        FOR SHARE
        `,
        [saleItemId]
      );
      for (const allocation of allocations.rows) {
        if (quantityToRestore <= 0) break;
        const restoreQuantity = Math.min(quantityToRestore, Number(allocation.quantity));
        await client.query("UPDATE inventory_batches SET remaining_qty = remaining_qty + $1 WHERE id = $2", [restoreQuantity, allocation.inventory_batch_id]);
        costAmount += roundCurrency(restoreQuantity * Number(allocation.purchase_rate));
        quantityToRestore -= restoreQuantity;
      }
      if (quantityToRestore > 0.0001) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Unable to map return quantity to original inventory batch" });
      }
      await client.query(
        `
        INSERT INTO sale_return_items (
          sale_return_id, sale_item_id, product_id, return_quantity,
          selling_rate, return_amount, cost_amount
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [saleReturn.id, saleItemId, saleItem.product_id, returnQuantity, saleItem.selling_rate, returnAmount, roundCurrency(costAmount)]
      );
      await client.query(
        `
        INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id)
        VALUES ($1, $2, 'IN', $3, $4, $5)
        `,
        [saleItem.product_id, returnQuantity, `Sale return ${returnNo}: ${returnReason}`, createdBy, branchId || sale.branch_id]
      );
      totalReturnAmount += returnAmount;
      totalCostAmount += costAmount;
    }
    const updateResult = await client.query(
      `
      UPDATE sale_returns
      SET total_return_amount = $1, total_cost_amount = $2
      WHERE id = $3
      RETURNING *
      `,
      [roundCurrency(totalReturnAmount), roundCurrency(totalCostAmount), saleReturn.id]
    );
    await client.query("COMMIT");
    return res.status(201).json(updateResult.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Saving Sale Return" });
  } finally {
    client.release();
  }
});

app.get("/waste-entries", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT we.*, p.product_name, p.unit, u.full_name AS created_by_name
      FROM waste_entries we
      JOIN products p ON p.id = we.product_id
      LEFT JOIN users u ON u.id = we.created_by
      ORDER BY we.waste_date DESC, we.created_at DESC, we.id DESC
      `
    );
    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Waste Entries" });
  }
});

app.post("/waste-entries", async (req, res) => {
  const client = await pool.connect();
  try {
    const productId = parsePositiveInteger(req.body.product_id);
    const quantity = parsePositiveNumber(req.body.quantity);
    const wasteType = normalizeWasteType(req.body.waste_type);
    const branchId = parsePositiveInteger(req.body.branch_id);
    const createdBy = parsePositiveInteger(req.body.created_by) || 1;
    if (!productId || !quantity || !branchId || !WASTE_TYPES.has(wasteType)) {
      return res.status(400).json({ message: "Enter valid waste details" });
    }
    await client.query("BEGIN");
    const batchesResult = await client.query(
      `
      SELECT id, remaining_qty, COALESCE(effective_cost_per_unit, purchase_rate) AS purchase_rate
      FROM inventory_batches
      WHERE product_id = $1
        AND branch_id = $2
        AND remaining_qty > 0
        AND COALESCE(batch_status, 'ACTIVE') <> 'CANCELLED'
      ORDER BY purchase_date, created_at, id
      FOR UPDATE
      `,
      [productId, branchId]
    );
    const availableStock = batchesResult.rows.reduce((sum, batch) => sum + Number(batch.remaining_qty), 0);
    if (availableStock < quantity) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: `Insufficient stock for waste entry. Available quantity: ${availableStock}` });
    }
    let quantityToDeduct = quantity;
    let costAmount = 0;
    for (const batch of batchesResult.rows) {
      if (quantityToDeduct <= 0) break;
      const deductedQuantity = Math.min(quantityToDeduct, Number(batch.remaining_qty));
      await client.query("UPDATE inventory_batches SET remaining_qty = remaining_qty - $1 WHERE id = $2", [deductedQuantity, batch.id]);
      costAmount += roundCurrency(deductedQuantity * Number(batch.purchase_rate));
      quantityToDeduct -= deductedQuantity;
    }
    const result = await client.query(
      `
      INSERT INTO waste_entries (
        product_id, waste_date, quantity, waste_type, remarks,
        cost_amount, branch_id, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
      `,
      [
        productId, req.body.waste_date || toDateKey(new Date()), quantity, wasteType,
        nullableText(req.body.remarks), roundCurrency(costAmount), branchId, createdBy,
      ]
    );
    await client.query(
      `
      INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id)
      VALUES ($1, $2, 'OUT', $3, $4, $5)
      `,
      [productId, quantity, `Waste entry ${wasteType}`, createdBy, branchId]
    );
    await client.query("COMMIT");
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Saving Waste Entry" });
  } finally {
    client.release();
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
    const requestedSaleDate = req.body.bill_date || req.body.sale_date
      ? toBusinessDateKey(req.body.bill_date || req.body.sale_date)
      : toDateKey(currentSale.sale_date);
    if (requestedSaleDate !== toDateKey(currentSale.sale_date)) {
      const dateEditor = await getPermissionUser(editor.id, "sale_date_edit", ["Owner", "Admin"], client);
      if (!dateEditor) {
        await client.query("ROLLBACK");
        return res.status(403).json({ message: "You do not have permission to edit bill date" });
      }
    }
    const editedInvoiceNo = `FZ-${requestedSaleDate.replaceAll("-", "")}-${String(saleId).padStart(6, "0")}`;

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
        customer_id = $5,
        customer_name = $6,
        customer_mobile = $7,
        customer_notes = $8,
        payment_mode = $9,
        gross_amount = $10,
        item_discount_amount = $11,
        invoice_discount_amount = $12,
        tax_amount = $13,
        discount_rule_id = $14,
        discount_rule_name = $15,
        discount_rule_type = $16,
        discount_rule_value = $17,
        discount_rule_payment_mode = $18,
        sale_date = $19,
        transaction_date = $19,
        bill_datetime = COALESCE($22::timestamp, bill_datetime),
        invoice_no = $24,
        sale_status = 'EDITED',
        edited_by = $20,
        edited_at = CURRENT_TIMESTAMP,
        edit_reason = $21
      WHERE id = $23
      RETURNING *
      `,
      [
        salePayload.totalAmount, salePayload.totalCost, salePayload.profit, salePayload.branchId,
        salePayload.customerId, salePayload.customerName, salePayload.customerMobile, salePayload.customerNotes, salePayload.paymentMode,
        salePayload.grossAmount, salePayload.itemDiscountAmount, salePayload.invoiceDiscountAmount, salePayload.taxAmount,
        salePayload.discountRule?.id || null, salePayload.discountRule?.rule_name || null,
        salePayload.discountRule?.discount_type || null, salePayload.discountRule?.discount_value || 0,
        salePayload.discountRule?.payment_mode || null,
        requestedSaleDate,
        editor.id,
        reason,
        req.body.bill_datetime || `${requestedSaleDate}T00:00`,
        saleId,
        editedInvoiceNo,
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
          si.cost_amount, si.profit, si.cost_status, si.default_selling_rate, si.manual_rate_override
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
