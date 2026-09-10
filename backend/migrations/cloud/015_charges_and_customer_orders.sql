-- Everything the hosted database is missing, measured rather than guessed.
--
-- `scripts/cloud/check-schema-drift.mjs` compared what `initializeDatabase()` declares against the
-- shop's cloud on 2026-09-09 and found exactly six differences: five tables and one column, all of
-- them from two features — Other Charges and Customer Orders. This migration is those six, and
-- nothing else.
--
-- ## Why they were missing
--
-- `runStartupSchemaBootstrap` is hard-off on a hosted deployment (server.js:208), and
-- `initializeDatabase()` is the only place these statements live, so on the cloud they had never
-- run. The startup check that follows looks for missing *tables* and nothing else — and it did not
-- catch these either, because it checks a short required list rather than everything declared. So
-- the server booted clean and each absence waited for whichever route read it first:
--
--     column u.failed_login_attempts does not exist  -> every cloud sign-in answered 500 (migration 014)
--     relation "charge_types" does not exist         -> the reference bootstrap answered 500, so no
--                                                       device could ever be filled from the cloud
--
-- The second is why a rebuilt machine sat empty for two days with a healthy cloud, an approved
-- device and a valid session: the one route that fills a new device read a table that was not there.
--
-- ## The statements are copied verbatim
--
-- Column for column, constraint for constraint, from `initializeDatabase()`. Two definitions of one
-- table drift, and the drift is invisible until a query written against one runs against the other.
-- If these ever need to change, change them in server.js and write a new migration; never edit this
-- file once it has been applied.
--
-- Order matters here in a way `IF NOT EXISTS` does not rescue: `charge_rate_slabs` and
-- `sale_charges` reference `charge_types`, and `customer_order_items` references
-- `customer_orders`. A referenced table has to exist first.
--
-- Indexes are included even though the drift checker cannot see them. They are part of these
-- tables' definitions, they are all `IF NOT EXISTS`, and a unique index that never arrives is a
-- constraint the shop does not have without anything ever saying so.
--
-- Forward-only. Never edit this file once it has been applied anywhere.

-- ---------------------------------------------------------------------------------------------
-- Other Charges
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS charge_types (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  charge_name VARCHAR(120) NOT NULL,
  charge_code VARCHAR(40),
  basis VARCHAR(10) NOT NULL DEFAULT 'FLAT' CHECK (basis IN ('FLAT', 'SLAB')),
  measure_unit VARCHAR(40),
  flat_rate NUMERIC(14, 2) CHECK (flat_rate IS NULL OR flat_rate >= 0),
  active BOOLEAN DEFAULT TRUE,
  updated_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- A retired charge has to leave its name free again: the history of what it charged lives on
-- sale_charges, not on this row. COALESCE because NULLs are distinct in a unique index, so an
-- install with no company id yet would otherwise have no uniqueness at all.
CREATE UNIQUE INDEX IF NOT EXISTS charge_types_company_name_key
  ON charge_types (COALESCE(company_id, 0), LOWER(charge_name))
  WHERE active IS NOT FALSE;

ALTER TABLE charge_types ADD COLUMN IF NOT EXISTS entity_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS charge_rate_slabs (
  id SERIAL PRIMARY KEY,
  charge_type_id INTEGER NOT NULL REFERENCES charge_types(id) ON DELETE CASCADE,
  upto_value NUMERIC(14, 3) NOT NULL CHECK (upto_value > 0),
  rate NUMERIC(14, 2) NOT NULL CHECK (rate >= 0),
  active BOOLEAN DEFAULT TRUE,
  updated_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS charge_rate_slabs_type_idx
  ON charge_rate_slabs (charge_type_id, upto_value);

CREATE TABLE IF NOT EXISTS sale_charges (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  charge_type_id INTEGER REFERENCES charge_types(id) ON DELETE SET NULL,
  charge_name VARCHAR(120) NOT NULL,
  measure_unit VARCHAR(40),
  measurement NUMERIC(14, 3),
  quantity NUMERIC(14, 3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  rate NUMERIC(14, 2) NOT NULL CHECK (rate >= 0),
  amount NUMERIC(14, 2) NOT NULL CHECK (amount >= 0),
  manual BOOLEAN NOT NULL DEFAULT FALSE,
  slab_upto NUMERIC(14, 3),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS sale_charges_sale_idx ON sale_charges (sale_id);

-- Charges never move Taxable Amount or Mandi Tax; only Net Payable. This column is that total, and
-- a bill written while it was missing simply has no charges on it — there is nothing to backfill.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS other_charges_amount NUMERIC(14, 2) DEFAULT 0;

-- ---------------------------------------------------------------------------------------------
-- Customer Orders
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS customer_orders (
  id BIGSERIAL PRIMARY KEY,
  global_id VARCHAR(180) NOT NULL UNIQUE,
  order_no VARCHAR(120),
  source VARCHAR(30) NOT NULL DEFAULT 'PHONE',
  company_id INTEGER,
  branch_id INTEGER NOT NULL DEFAULT 1 REFERENCES branches(id),
  operational_location_id INTEGER,
  assignment_generation INTEGER,
  customer_id VARCHAR(180),
  customer_name VARCHAR(220) NOT NULL,
  customer_mobile VARCHAR(40),
  delivery_address TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'RECEIVED',
  reserved_at TIMESTAMP,
  packed_at TIMESTAMP,
  sent_at TIMESTAMP,
  delivered_at TIMESTAMP,
  cancelled_at TIMESTAMP,
  cancellation_reason TEXT,
  carrier VARCHAR(160),
  carrier_reference VARCHAR(180),
  tracking_url TEXT,
  carrier_contact VARCHAR(120),
  sale_global_id VARCHAR(180),
  invoice_no VARCHAR(120),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  source_device_id VARCHAR(160),
  entity_version INTEGER NOT NULL DEFAULT 1,
  device_created_at TIMESTAMP,
  device_updated_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS customer_orders_scope_idx
  ON customer_orders (company_id, branch_id, status);

CREATE INDEX IF NOT EXISTS customer_orders_open_idx
  ON customer_orders (branch_id, reserved_at, created_at)
  WHERE status IN ('RECEIVED', 'PACKED') AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS customer_order_items (
  id BIGSERIAL PRIMARY KEY,
  order_global_id VARCHAR(180) NOT NULL REFERENCES customer_orders(global_id) ON DELETE CASCADE,
  global_id VARCHAR(180),
  line_index INTEGER NOT NULL,
  product_global_id VARCHAR(180) NOT NULL,
  product_name VARCHAR(220) NOT NULL,
  unit VARCHAR(40),
  quantity NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  agreed_rate NUMERIC(14,2),
  line_amount NUMERIC(14,2),
  inventory_lot_global_id VARCHAR(180),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (order_global_id, line_index)
);

CREATE INDEX IF NOT EXISTS customer_order_items_product_idx
  ON customer_order_items (product_global_id, order_global_id);
