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

const parsePositiveNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

const parsePositiveInteger = (value) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
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
  `);
};

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
    const { product_name, selling_rate, purchase_rate, unit } = req.body;
    const parsedSellingRate = parsePositiveNumber(selling_rate);
    const parsedPurchaseRate = parsePositiveNumber(purchase_rate);

    if (!product_name?.trim() || !unit?.trim() || !parsedSellingRate || !parsedPurchaseRate) {
      return res.status(400).json({ message: "Enter valid product details" });
    }

    const result = await pool.query(
      `
      INSERT INTO products (product_name, selling_rate, purchase_rate, unit)
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [product_name.trim(), parsedSellingRate, parsedPurchaseRate, unit.trim()]
    );

    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Adding Product" });
  }
});

app.get("/inventory", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        ib.id,
        p.product_name,
        ib.batch_no,
        ib.purchase_qty,
        ib.remaining_qty,
        ib.purchase_rate,
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

app.post("/purchase", async (req, res) => {
  const client = await pool.connect();

  try {
    const { supplier_name, product_id, quantity, purchase_rate, branch_id, created_by } = req.body;
    const parsedProductId = parsePositiveInteger(product_id);
    const parsedQuantity = parsePositiveNumber(quantity);
    const parsedPurchaseRate = parsePositiveNumber(purchase_rate);
    const parsedBranchId = parsePositiveInteger(branch_id);
    const parsedCreatedBy = parsePositiveInteger(created_by) || 1;

    if (!supplier_name?.trim() || !parsedProductId || !parsedQuantity || !parsedPurchaseRate || !parsedBranchId) {
      return res.status(400).json({ message: "Enter valid purchase details" });
    }

    const totalAmount = parsedQuantity * parsedPurchaseRate;
    await client.query("BEGIN");

    const purchaseResult = await client.query(
      `
      INSERT INTO purchases (supplier_name, total_amount, branch_id, created_by)
      VALUES ($1, $2, $3, $4)
      RETURNING id
      `,
      [supplier_name.trim(), totalAmount, parsedBranchId, parsedCreatedBy]
    );
    const purchaseId = purchaseResult.rows[0].id;

    await client.query(
      `
      INSERT INTO purchase_items (purchase_id, product_id, quantity, purchase_rate, amount)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [purchaseId, parsedProductId, parsedQuantity, parsedPurchaseRate, totalAmount]
    );

    const batchNo = `BATCH-${Date.now()}-${purchaseId}`;
    await client.query(
      `
      INSERT INTO inventory_batches (
        product_id, batch_no, purchase_qty, remaining_qty, purchase_rate, supplier_name, branch_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        parsedProductId,
        batchNo,
        parsedQuantity,
        parsedQuantity,
        parsedPurchaseRate,
        supplier_name.trim(),
        parsedBranchId,
      ]
    );

    await client.query(
      `
      INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id)
      VALUES ($1, $2, 'IN', $3, $4, $5)
      `,
      [parsedProductId, parsedQuantity, `Purchase #${purchaseId}`, parsedCreatedBy, parsedBranchId]
    );

    await client.query("COMMIT");
    return res.status(201).json({ success: true, message: "Purchase Saved", purchase_id: purchaseId });
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
    const { product_id, quantity, branch_id, created_by } = req.body;
    const parsedProductId = parsePositiveInteger(product_id);
    const parsedQuantity = parsePositiveNumber(quantity);
    const parsedBranchId = parsePositiveInteger(branch_id);
    const parsedCreatedBy = parsePositiveInteger(created_by) || 1;

    if (!parsedProductId || !parsedQuantity || !parsedBranchId) {
      return res.status(400).json({ message: "Select a product and enter a valid quantity" });
    }

    await client.query("BEGIN");

    const productResult = await client.query(
      "SELECT id, product_name, selling_rate FROM products WHERE id = $1",
      [parsedProductId]
    );
    if (productResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Product not found" });
    }

    const product = productResult.rows[0];
    const sellingRate = Number(product.selling_rate);
    if (!Number.isFinite(sellingRate) || sellingRate <= 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Product does not have a valid selling rate" });
    }

    const batchesResult = await client.query(
      `
      SELECT id, remaining_qty, purchase_rate
      FROM inventory_batches
      WHERE product_id = $1
        AND branch_id = $2
        AND remaining_qty > 0
      ORDER BY purchase_date, created_at, id
      FOR UPDATE
      `,
      [parsedProductId, parsedBranchId]
    );

    const availableStock = batchesResult.rows.reduce(
      (total, batch) => total + Number(batch.remaining_qty),
      0
    );
    if (availableStock < parsedQuantity) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        message: `Insufficient stock. Available quantity: ${availableStock}`,
        available_stock: availableStock,
      });
    }

    let quantityToDeduct = parsedQuantity;
    let totalCost = 0;
    const allocations = [];

    for (const batch of batchesResult.rows) {
      if (quantityToDeduct <= 0) break;

      const deductedQuantity = Math.min(quantityToDeduct, Number(batch.remaining_qty));
      const costAmount = deductedQuantity * Number(batch.purchase_rate);

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
      totalCost += costAmount;
    }

    const totalAmount = parsedQuantity * sellingRate;
    const profit = totalAmount - totalCost;
    const saleResult = await client.query(
      `
      INSERT INTO sales (total_amount, total_cost, profit, branch_id, created_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, total_amount, total_cost, profit, sale_date, created_at
      `,
      [totalAmount, totalCost, profit, parsedBranchId, parsedCreatedBy]
    );
    const sale = saleResult.rows[0];

    const saleItemResult = await client.query(
      `
      INSERT INTO sale_items (sale_id, product_id, quantity, selling_rate, amount, cost_amount, profit)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
      `,
      [sale.id, parsedProductId, parsedQuantity, sellingRate, totalAmount, totalCost, profit]
    );
    const saleItemId = saleItemResult.rows[0].id;

    for (const allocation of allocations) {
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
      [parsedProductId, parsedQuantity, `Sale #${sale.id}`, parsedCreatedBy, parsedBranchId]
    );

    await client.query("COMMIT");
    return res.status(201).json({
      success: true,
      message: "Sale Saved",
      sale: {
        ...sale,
        product_name: product.product_name,
        quantity: parsedQuantity,
        selling_rate: sellingRate,
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
        s.sale_date,
        s.created_at,
        p.product_name,
        p.unit,
        si.quantity,
        si.selling_rate,
        si.amount,
        si.cost_amount,
        si.profit
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      JOIN products p ON p.id = si.product_id
      ORDER BY s.created_at DESC, s.id DESC
    `);

    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Sales History" });
  }
});

initializeDatabase()
  .then(() => {
    app.listen(5000, () => {
      console.log("Server running on port 5000");
    });
  })
  .catch((error) => {
    console.error("Database initialization failed", error);
    process.exit(1);
  });
