-- Frooz Pack: the packing-material master (Type > Design > Size), its per-branch stock, packing
-- purchases, stock movements, the packing a FIXED combo uses, and the packing each bill used.
--
-- ## What this carries
--
-- packing_types / packing_designs / packing_sizes are company-wide master data, owner-editable,
-- like combos. A size is a stock item: `size_name` is one of PETITE, CLASSIC, GRAND, ROYAL (decided
-- in backend/froozPack.js, not by a CHECK, as 023 and 024 decided for their kinds), `capacity` is
-- free text ("1 kg"), `unit_cost` is the last purchase rate.
--
-- packing_stock is the count on hand per branch and size. It has no `>= 0` check on purpose: a
-- sale never stops for packing, so a count can go negative until the owner adjusts it.
--
-- packing_purchases / packing_purchase_lines record a purchase; `expense_id` is the `expenses`
-- row ('Packing Material') the purchase wrote in the same transaction. packing_movements is the
-- signed history (PURCHASE, SALE, SALE_CANCEL, ADJUST); its partial unique index is what makes a
-- bill's packing decrement and its cancellation each happen once. combo_packing is the packing a
-- FIXED combo uses per combo. sale_packing_usage is the packing a bill used, as billed.
--
-- No foreign key to `sales` or `expenses`: `sale_id` and `expense_id` are plain integers, so a
-- database without those tables (the combos test harness) can still hold this file, and a bill's
-- packing record survives anything done to the bill.
--
-- ## Why this file exists
--
-- Every statement below is declared in `initializeDatabase()`, and the startup bootstrap is
-- switched off on a hosted deployment. Without this file none of it reaches the cloud:
-- `verifyDeclaredSchema` refuses to start the backend, and once it did every combo read (which now
-- carries its packing) would answer 500 on the missing tables.
--
-- Additive only: no existing row is inserted, updated or deleted. IF NOT EXISTS throughout, so the
-- runner can replay it (it applies the whole list every time). Forward-only. Never edit this file
-- once it has been applied anywhere. Requires 024 (combo_packing references combos).

-- Exactly the statements from the startup bootstrap, so the two paths cannot drift.
CREATE TABLE IF NOT EXISTS packing_types (
  id SERIAL PRIMARY KEY,
  global_id VARCHAR(80) UNIQUE,
  company_id INTEGER,
  name VARCHAR(80) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  entity_version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  updated_by INTEGER,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS packing_types_company_name_key
  ON packing_types (COALESCE(company_id, 0), LOWER(name))
  WHERE active;
CREATE TABLE IF NOT EXISTS packing_designs (
  id SERIAL PRIMARY KEY,
  global_id VARCHAR(80) UNIQUE,
  type_id INTEGER NOT NULL REFERENCES packing_types(id),
  name VARCHAR(80) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  updated_by INTEGER,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS packing_designs_type_name_key
  ON packing_designs (type_id, LOWER(name))
  WHERE active;
CREATE TABLE IF NOT EXISTS packing_sizes (
  id SERIAL PRIMARY KEY,
  global_id VARCHAR(80) UNIQUE,
  design_id INTEGER NOT NULL REFERENCES packing_designs(id),
  size_name VARCHAR(20) NOT NULL,
  capacity VARCHAR(40),
  unit_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  updated_by INTEGER,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS packing_sizes_design_size_key
  ON packing_sizes (design_id, size_name, LOWER(COALESCE(capacity, '')))
  WHERE active;
CREATE TABLE IF NOT EXISTS packing_stock (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  branch_id INTEGER NOT NULL,
  size_id INTEGER NOT NULL REFERENCES packing_sizes(id),
  qty_on_hand NUMERIC(14, 3) NOT NULL DEFAULT 0,
  entity_version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMP DEFAULT now(),
  UNIQUE (branch_id, size_id)
);
CREATE TABLE IF NOT EXISTS packing_purchases (
  id SERIAL PRIMARY KEY,
  global_id VARCHAR(80) UNIQUE,
  company_id INTEGER,
  branch_id INTEGER NOT NULL,
  supplier_name VARCHAR(160),
  payment_mode VARCHAR(30),
  purchase_date DATE,
  reference_number VARCHAR(80),
  remarks TEXT,
  amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  expense_id INTEGER,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS packing_purchases_expense_idx
  ON packing_purchases (expense_id);
CREATE TABLE IF NOT EXISTS packing_purchase_lines (
  id SERIAL PRIMARY KEY,
  purchase_id INTEGER NOT NULL REFERENCES packing_purchases(id) ON DELETE CASCADE,
  size_id INTEGER NOT NULL REFERENCES packing_sizes(id),
  quantity NUMERIC(14, 3) NOT NULL CHECK (quantity > 0),
  rate NUMERIC(14, 2) NOT NULL CHECK (rate >= 0),
  amount NUMERIC(14, 2) NOT NULL
);
CREATE TABLE IF NOT EXISTS packing_movements (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER,
  branch_id INTEGER NOT NULL,
  size_id INTEGER NOT NULL,
  movement_type VARCHAR(20) NOT NULL,
  quantity NUMERIC(14, 3) NOT NULL,
  sale_id INTEGER,
  purchase_id INTEGER,
  reason TEXT,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_packing_movements_sale
  ON packing_movements (sale_id, size_id, movement_type)
  WHERE sale_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS packing_movements_branch_size_idx
  ON packing_movements (branch_id, size_id, created_at);
CREATE TABLE IF NOT EXISTS combo_packing (
  id SERIAL PRIMARY KEY,
  combo_id INTEGER NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
  size_id INTEGER NOT NULL REFERENCES packing_sizes(id),
  quantity NUMERIC(14, 3) NOT NULL CHECK (quantity > 0),
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS combo_packing_combo_idx
  ON combo_packing (combo_id, sort_order);
CREATE TABLE IF NOT EXISTS sale_packing_usage (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER NOT NULL,
  combo_line_key VARCHAR(80),
  combo_id VARCHAR(80),
  source VARCHAR(10),
  size_id INTEGER,
  size_global_id VARCHAR(80),
  type_name VARCHAR(80),
  design_name VARCHAR(80),
  size_name VARCHAR(20),
  capacity VARCHAR(40),
  quantity NUMERIC(14, 3) NOT NULL,
  unit_cost NUMERIC(14, 2)
);
CREATE INDEX IF NOT EXISTS sale_packing_usage_sale_idx
  ON sale_packing_usage (sale_id);
