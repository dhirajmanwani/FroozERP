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
const toDateKey = (value) =>
  value instanceof Date ? value.toLocaleDateString("en-CA") : String(value).slice(0, 10);
const RATE_MANAGER_ROLES = new Set(["Owner", "Admin"]);

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

    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS basic_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS mandi_tax_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS other_charges NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS rebate_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS net_payable NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS effective_cost_per_unit NUMERIC(14, 4) DEFAULT 0;
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS freight_charges NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS labour_charges NUMERIC(14, 2) DEFAULT 0;

    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS effective_cost_per_unit NUMERIC(14, 4);
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
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(14, 2) DEFAULT 0;

    CREATE UNIQUE INDEX IF NOT EXISTS sales_invoice_no_unique_idx
      ON sales (invoice_no)
      WHERE invoice_no IS NOT NULL;

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
  `);
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
    if (!await requireRateManager(req.query.user_id)) {
      return res.status(403).json({ message: "Only Owner or Admin can manage settings" });
    }
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
    const desiredMargin = parseNonNegativeNumber(req.query.desired_margin) ?? 25;
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
            THEN ROUND(latest.effective_cost_per_unit * (1 + $1 / 100.0), 0)
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
    return res.json(result.rows);
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

app.get("/supplier-ledger", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        id,
        purchase_date,
        supplier_name,
        gross_amount,
        mandi_tax_amount,
        rebate_amount,
        net_payable,
        paid_amount,
        balance_amount,
        payment_status,
        payment_timing
      FROM purchases
      ORDER BY purchase_date DESC, id DESC
      `
    );
    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Supplier Ledger" });
  }
});

app.post("/purchase", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      supplier_name,
      product_id,
      quantity,
      purchase_rate,
      freight_charges,
      labour_charges,
      other_charges,
      paid_amount,
      rebate_rule_id,
      payment_date,
      branch_id,
      created_by,
    } = req.body;
    const parsedProductId = parsePositiveInteger(product_id);
    const parsedQuantity = parsePositiveNumber(quantity);
    const parsedPurchaseRate = parsePositiveNumber(purchase_rate);
    const parsedFreightCharges = parseNonNegativeNumber(freight_charges);
    const parsedLabourCharges = parseNonNegativeNumber(labour_charges);
    const parsedOtherCharges = parseNonNegativeNumber(other_charges);
    const parsedPaidAmount = parseNonNegativeNumber(paid_amount);
    const parsedRebateRuleId = parsePositiveInteger(rebate_rule_id);
    const parsedBranchId = parsePositiveInteger(branch_id);
    const parsedCreatedBy = parsePositiveInteger(created_by) || 1;

    if (
      !supplier_name?.trim() ||
      !parsedProductId ||
      !parsedQuantity ||
      !parsedPurchaseRate ||
      parsedFreightCharges === null ||
      parsedLabourCharges === null ||
      parsedOtherCharges === null ||
      parsedPaidAmount === null ||
      !parsedRebateRuleId ||
      !parsedBranchId
    ) {
      return res.status(400).json({ message: "Enter valid purchase details" });
    }

    await client.query("BEGIN");
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
        supplier_name, total_amount, branch_id, created_by, basic_amount,
        mandi_tax_percent, mandi_tax_amount, other_charges, gross_amount,
        rebate_percent, rebate_amount, net_payable, paid_amount, balance_amount,
        payment_timing, effective_cost_per_unit, freight_charges, labour_charges,
        rebate_rule_id, payment_due_days, payment_status, payment_date
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
      RETURNING *
      `,
      [
        supplier_name.trim(), netPayable, parsedBranchId, parsedCreatedBy, basicAmount,
        mandiTaxPercent, mandiTaxAmount, parsedOtherCharges, grossAmount,
        rebatePercent, rebateAmount, netPayable, parsedPaidAmount, balanceAmount,
        rebateRule.rule_name, effectiveCostPerUnit, parsedFreightCharges, parsedLabourCharges,
        rebateRule.id, rebateRule.pay_within_days, paymentStatus, payment_date || null,
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
        supplier_name, branch_id, mandi_tax_amount, freight_charges, labour_charges,
        other_charges, gross_amount, rebate_amount, net_payable, payment_timing, balance_amount
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      `,
      [
        parsedProductId,
        batchNo,
        parsedQuantity,
        parsedQuantity,
        parsedPurchaseRate,
        effectiveCostPerUnit,
        supplier_name.trim(),
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
    if (parsedInvoiceDiscount > subtotalAfterItemDiscounts) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Invoice discount cannot exceed the cart subtotal" });
    }

    const taxAmount = 0;
    const totalAmount = roundCurrency(subtotalAfterItemDiscounts - parsedInvoiceDiscount + taxAmount);
    const profit = roundCurrency(totalAmount - totalCost);
    const requestedPayments = Array.isArray(payments) && payments.length > 0
      ? payments
      : [{ mode: "CASH", amount: totalAmount }];
    const allowedPaymentModes = new Set(["CASH", "UPI", "CARD"]);
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
    const paymentMode = parsedPayments.length > 1 ? "MIXED" : parsedPayments[0].mode;

    const saleResult = await client.query(
      `
      INSERT INTO sales (
        total_amount, total_cost, profit, branch_id, created_by,
        customer_name, customer_mobile, customer_notes, payment_mode,
        gross_amount, item_discount_amount, invoice_discount_amount, tax_amount
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *
      `,
      [
        totalAmount, totalCost, profit, parsedBranchId, parsedCreatedBy,
        customerName, customerMobile, customerNotes, paymentMode,
        grossAmount, itemDiscountAmount, parsedInvoiceDiscount, taxAmount,
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
        : roundCurrency(parsedInvoiceDiscount * (item.netAmount / subtotalAfterItemDiscounts));
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

    await client.query("COMMIT");
    return res.status(201).json({
      success: true,
      message: "Invoice Saved",
      sale: {
        ...sale,
        invoice_no: invoiceNo,
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
        s.gross_amount,
        s.item_discount_amount,
        s.invoice_discount_amount,
        s.tax_amount,
        s.total_amount AS amount,
        s.total_cost AS cost_amount,
        s.profit,
        COUNT(si.id)::INTEGER AS item_count,
        STRING_AGG(p.product_name || ' x ' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM si.quantity::TEXT)), ', ' ORDER BY si.id) AS item_summary
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      JOIN products p ON p.id = si.product_id
      GROUP BY s.id
      ORDER BY s.created_at DESC, s.id DESC
    `);

    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Sales History" });
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
