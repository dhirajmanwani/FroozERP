const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  user: "postgres",
  host: "localhost",
  database: "froozerp",
  password: "8386",
  port: 5432,
});

app.get("/", (req, res) => {
  res.send("FroozERP Backend Running");
});

app.get("/products", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM products ORDER BY id"
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).send("Database Error");
  }
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
        r.role_name,
        b.branch_name
      FROM users u
      JOIN roles r ON u.role_id = r.id
      JOIN branches b ON u.branch_id = b.id
      WHERE u.username = $1
      `,
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        message: "User not found"
      });
    }

    const user = result.rows[0];

    console.log("DB Password:", user.password_hash);
console.log("Entered Password:", password);

    if (user.password_hash !== password) {
      return res.status(401).json({
        message: "Invalid password"
      });
    }

    res.json({
      id: user.id,
      full_name: user.full_name,
      username: user.username,
      role: user.role_name,
      branch: user.branch_name
    });

  } catch (error) {
    console.error(error);
    res.status(500).send("Login Error");
  }
});

app.get("/products", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM products ORDER BY id"
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).send("Database Error");
  }
});

app.post("/products", async (req, res) => {
  try {
    const {
      product_name,
      selling_rate,
      purchase_rate,
      unit
    } = req.body;

    const result = await pool.query(
      `
      INSERT INTO products
      (product_name, selling_rate, purchase_rate, unit)
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [
        product_name,
        selling_rate,
        purchase_rate,
        unit
      ]
    );

    res.json(result.rows[0]);

  } catch (error) {
    console.error(error);
    res.status(500).send("Error Adding Product");
  }
});

app.listen(5000, () => {
  console.log("Server running on port 5000");
});