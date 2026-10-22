-- Frooz Pack: the packing material the shop buys (boxes, bags, bottles), counted per branch, and
-- the packing each combo uses or each bill consumed.
--
-- ## The catalogue
--
-- `local_packing_types` / `local_packing_designs` / `local_packing_sizes` mirror the cloud's
-- Type -> Design -> Size tree. Every row is keyed by its cloud `global_id`
-- (`packing-type-<id>`, `packing-design-<id>`, `packing-size-<id>`), never by a bare number:
-- identifiers are opaque strings and `"004"` and `4` are different entities.
--
--   * The tree travels whole on one `packing_type` sync change, so a type change replaces its
--     designs and sizes wholesale inside the pull arm. There are NO foreign keys between the three
--     tables, on purpose: the replace is a delete-and-insert, and a key would make the order of
--     those statements matter for nothing.
--   * `size_name` carries NO CHECK constraint. The cloud route owns the list
--     (PETITE | CLASSIC | GRAND | ROYAL); a newer server adding a size must not turn every pull of
--     that type into a refused row on an older counter — the same reasoning as `local_combos.kind`
--     (migration 028).
--   * Inactive rows are kept with active = 0: the POS decides what to show.
--
-- ## The count
--
-- `local_packing_stock` holds the cloud's own count per (branch, size), exactly as the
-- `packing_stock` sync change last said it. The device keeps the rows of every branch it hears
-- about; the reference snapshot shows only its own branch. There is NO `qty_on_hand >= 0` check:
-- a sale never stops for packing, so the cloud's count can legitimately go negative.
--
-- The count the counter SHOWS is derived, never stored: the cloud's figure less what this
-- counter's own not-yet-delivered bills consumed (`local_pos_invoice_packing`). Storing a
-- decremented figure here would be overwritten by the next pull and lose the sale, or double-count
-- it once the cloud's own decrement arrived.
--
-- ## Combo packing and bill packing
--
-- `local_combo_packing` is a FIXED combo's packing, written by the `combo` pull arm from the
-- payload's `packing` array (absent key: the stored rows stay; `[]`: they are cleared).
-- `size_id` deliberately has NO FOREIGN KEY to `local_packing_sizes`, for the same reason
-- `local_combo_items.product_global_id` has none: a combo naming a size this counter has not heard
-- of yet is something the POS shows, never a reason for the pull to fail. The names are kept on
-- the row so it can still be described.
--
-- `local_pos_invoice_packing` is the packing a local bill consumed, as billed. It rides to the
-- cloud inside the sale payload (`packing_usage`), not as an outbox row of its own.
--
-- Idempotent on its own (CREATE ... IF NOT EXISTS only, no ALTER) and version-gated in
-- apply_migration() as every migration is. Forward-only: never edit this file once it has been
-- applied anywhere.

CREATE TABLE IF NOT EXISTS local_packing_types (
  id TEXT PRIMARY KEY,
  company_id TEXT,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS local_packing_designs (
  id TEXT PRIMARY KEY,
  type_id TEXT NOT NULL,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_local_packing_designs_type
  ON local_packing_designs (type_id, sort_order);

CREATE TABLE IF NOT EXISTS local_packing_sizes (
  id TEXT PRIMARY KEY,
  design_id TEXT NOT NULL,
  size_name TEXT NOT NULL,
  capacity TEXT,
  unit_cost REAL NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_local_packing_sizes_design
  ON local_packing_sizes (design_id, sort_order);

CREATE TABLE IF NOT EXISTS local_packing_stock (
  branch_id TEXT NOT NULL,
  size_id TEXT NOT NULL,
  qty_on_hand REAL NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (branch_id, size_id)
);

CREATE TABLE IF NOT EXISTS local_combo_packing (
  combo_id TEXT NOT NULL REFERENCES local_combos(id) ON DELETE CASCADE,
  size_id TEXT NOT NULL,
  quantity REAL NOT NULL CHECK (quantity > 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  type_name TEXT,
  design_name TEXT,
  size_name TEXT,
  capacity TEXT,
  unit_cost REAL
);

CREATE INDEX IF NOT EXISTS idx_local_combo_packing_combo
  ON local_combo_packing (combo_id, sort_order);

CREATE TABLE IF NOT EXISTS local_pos_invoice_packing (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES local_pos_invoices(id) ON DELETE CASCADE,
  combo_line_key TEXT,
  combo_id TEXT,
  source TEXT,
  size_id TEXT NOT NULL,
  type_name TEXT,
  design_name TEXT,
  size_name TEXT,
  capacity TEXT,
  quantity REAL NOT NULL CHECK (quantity > 0),
  unit_cost REAL
);

-- "How much of this size have this counter's undelivered bills used" — read for every size on
-- every snapshot.
CREATE INDEX IF NOT EXISTS idx_local_pos_invoice_packing_size
  ON local_pos_invoice_packing (size_id, invoice_id);
