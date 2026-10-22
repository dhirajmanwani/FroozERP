-- Combos & Offers: the `combos` and `combo_items` master tables, and the combo fields on a sale line.
--
-- ## What this carries
--
-- A combo is company-wide master data, like a product: a name, a kind (COMBO_OFFER, THE_CUTTING,
-- JUICE, GIFTING -- which POS tab shows it) and a type. A FIXED combo lists its component products
-- with a quantity each and a selling price per combo; a CUSTOM combo has neither: the cashier adds
-- what the customer wants, and its price is worked out at the counter as the items at their sale
-- rates, raised by the combo's own `margin_percent`, plus its `extra_charge` (a making or basket
-- charge per combo). `margin_percent` is also what a FIXED combo's price suggestion is worked from;
-- the server stores it and never prices from it. The rules live in
-- backend/combos.js. No CHECK constraint on kind or type, deliberately, as migration 023 decided
-- for `products.pos_section`: the route decides the allowed values, so a new kind is not a second
-- migration.
--
-- A combo sold on a bill is ordinary sale lines (one per product per lot), tied together by eight
-- nullable `sale_items` columns: combo_line_key, combo_id (the combo's global id as billed -- not a
-- foreign key, because the line records what was sold and must survive the combo being changed or
-- switched off), combo_name, combo_kind, combo_type, combo_qty, combo_price, and line_index (cart
-- order, on every line of a bill).
--
-- ## Why this file exists
--
-- Every statement below is declared in `initializeDatabase()`, and the startup bootstrap is
-- switched off on a hosted deployment. Without this file none of it reaches the cloud:
-- `verifyDeclaredSchema` refuses to start the backend, and once it did, every desktop bill carrying
-- a combo would fail to sync and the reference bootstrap would answer 500 on the missing table --
-- the shape of gap 014, 015 and 018-023 were each written to close.
--
-- Additive only: no existing row is inserted, updated or deleted. IF NOT EXISTS throughout, so the
-- runner can replay it (it applies the whole list every time) and a locally bootstrapped database
-- that already has it is untouched. Forward-only. Never edit this file once it has been applied
-- anywhere.

-- Exactly the statements from the startup bootstrap, so the two paths cannot drift.
CREATE TABLE IF NOT EXISTS combos (
  id SERIAL PRIMARY KEY,
  global_id VARCHAR(80) UNIQUE,
  company_id INTEGER,
  name VARCHAR(120) NOT NULL,
  kind VARCHAR(20) NOT NULL,
  combo_type VARCHAR(10) NOT NULL,
  price NUMERIC(14, 2),
  extra_charge NUMERIC(14, 2) NOT NULL DEFAULT 0,
  margin_percent NUMERIC(6, 2),
  description TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  entity_version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  updated_by INTEGER,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS combos_company_name_key
  ON combos (COALESCE(company_id, 0), LOWER(name))
  WHERE active;
CREATE TABLE IF NOT EXISTS combo_items (
  id SERIAL PRIMARY KEY,
  combo_id INTEGER NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity NUMERIC(14, 3) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS combo_items_combo_idx
  ON combo_items (combo_id, sort_order);

ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS combo_line_key VARCHAR(80);
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS combo_id VARCHAR(80);
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS combo_name VARCHAR(120);
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS combo_kind VARCHAR(20);
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS combo_type VARCHAR(10);
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS combo_qty NUMERIC(14, 3);
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS combo_price NUMERIC(14, 2);
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS line_index INTEGER;
