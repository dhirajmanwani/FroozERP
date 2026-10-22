-- Combos & Offers: the owner's combos, juices, cut-fruit plates and gift baskets, and the sale
-- lines they were billed as.
--
-- ## The master
--
-- `local_combos` / `local_combo_items` mirror the cloud's `combos` / `combo_items`. A combo is
-- keyed by its cloud `global_id` (`combo-<id>`), never by a bare number: identifiers are opaque
-- strings and `"004"` and `4` are different combos.
--
--   * `kind` and `combo_type` carry NO CHECK constraint, on purpose. The cloud route decides which
--     values are allowed (COMBO_OFFER | THE_CUTTING | JUICE | GIFTING, FIXED | CUSTOM); a newer
--     server adding a kind must not turn every pull of that combo into a refused row on an older
--     counter. The frontend decides what an unknown value means — the same reasoning as
--     `local_products.pos_section` (migration 027).
--   * `price` is NULLABLE with NO DEFAULT. A CUSTOM combo has no price (the POS works it out from
--     its items plus `extra_charge`), and a FIXED combo whose price never arrived must reach the POS
--     as "not priced", not as free. 0 is refused only by the cloud route (FIXED needs a price > 0);
--     storage refuses only negatives.
--   * `local_combo_items.product_global_id` deliberately has NO FOREIGN KEY to `local_products`.
--     The reference-snapshot refresh deletes products that no lot points at, foreign keys are
--     enforced on that connection, and a key here would make that delete — and with it every
--     snapshot refresh — fail. A component whose product is not on this counter is a refusal the
--     POS shows ("<product> is not on sale"), never a reason for the cache to stop working. The
--     product's name is kept on the row so the refusal can name it.
--
-- ## The sale lines
--
-- A combo is billed as ordinary sale lines — one per component product and lot — so stock,
-- sync and reports keep working unchanged. The eight columns below tie those lines together.
-- All are nullable: every bill that predates this migration, and every loose line after it, has
-- none of them. `line_index` is the cart order (0-based, every line of the bill); the lines used
-- to be read back `ORDER BY id`, and ids are random UUIDs.
--
-- Idempotent across restarts by version-gating in apply_migration(), which skips any version
-- already recorded APPLIED in local_schema_migrations. SQLite has no ADD COLUMN IF NOT EXISTS, so
-- this file is not safe to execute twice on its own — the gate is what makes it idempotent, as
-- for every other ALTER-bearing migration in this directory. Forward-only: never edit this file
-- once it has been applied anywhere. ADD COLUMN with no default is an O(1) catalogue change.

CREATE TABLE IF NOT EXISTS local_combos (
  id TEXT PRIMARY KEY,
  cloud_id TEXT,
  company_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  combo_type TEXT NOT NULL,
  price REAL CHECK (price IS NULL OR price >= 0),
  -- A CUSTOM combo's own charge per combo (making, basket), added to the sum of its items to give
  -- the combo's one price on the bill. 0 when there is none, and always 0 on a FIXED combo — the
  -- cloud column is NOT NULL DEFAULT 0, so here 0 genuinely means "no extra charge".
  extra_charge REAL NOT NULL DEFAULT 0 CHECK (extra_charge >= 0),
  -- The combo's own margin, in percent. FIXED: what the owner's price suggestion is built on.
  -- CUSTOM: the extra % on top of the fruits' sale rates. NULLABLE on purpose: NULL means "not
  -- set" and the POS falls back (Sale Rate settings' margin for FIXED, 0% for CUSTOM); it is never
  -- stored as 0, because 0 is a real margin the owner may choose. Same bounds as the cloud
  -- (0 to 1000); the upsert refuses anything else before it gets here.
  margin_percent REAL CHECK (margin_percent IS NULL OR (margin_percent >= 0 AND margin_percent <= 1000)),
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  version INTEGER NOT NULL DEFAULT 1,
  sync_status TEXT NOT NULL DEFAULT 'synced',
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS local_combo_items (
  id TEXT PRIMARY KEY,
  combo_id TEXT NOT NULL REFERENCES local_combos(id) ON DELETE CASCADE,
  product_global_id TEXT NOT NULL,
  product_name TEXT,
  unit TEXT,
  quantity REAL NOT NULL CHECK (quantity > 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- "What goes into this combo, in the owner's order" — read for every combo tile on the POS.
CREATE INDEX IF NOT EXISTS idx_local_combo_items_combo
  ON local_combo_items (combo_id, sort_order);

ALTER TABLE local_pos_invoice_items ADD COLUMN combo_line_key TEXT;
ALTER TABLE local_pos_invoice_items ADD COLUMN combo_id TEXT;
ALTER TABLE local_pos_invoice_items ADD COLUMN combo_name TEXT;
ALTER TABLE local_pos_invoice_items ADD COLUMN combo_kind TEXT;
ALTER TABLE local_pos_invoice_items ADD COLUMN combo_type TEXT;
ALTER TABLE local_pos_invoice_items ADD COLUMN combo_qty REAL;
ALTER TABLE local_pos_invoice_items ADD COLUMN combo_price REAL;
ALTER TABLE local_pos_invoice_items ADD COLUMN line_index INTEGER;

-- "Does this bill have combo lines" — asked before every local edit, which refuses them.
CREATE INDEX IF NOT EXISTS idx_local_pos_items_combo
  ON local_pos_invoice_items (invoice_id, combo_line_key)
  WHERE combo_line_key IS NOT NULL;
