-- 026 (24 Oct 2026): a packing purchase is saved once; combo and Frooz Pack timestamps are
-- TIMESTAMPTZ on purpose; the "in use" checks have indexes.
--
-- packing_purchases.client_ref is the purchase form's idempotency key. A save whose answer was lost
-- (a timeout after COMMIT) used to be saved again on retry: a second purchase, a second 'Packing
-- Material' expense and the count raised twice. `recordPackingPurchase` now answers a repeat of a
-- stored client_ref with the first purchase; the unique index is the backstop behind its lock.
-- NULL (every purchase saved before this, and any client that sends none) is never a conflict.
--
-- The timestamps: 024 and 025 created plain TIMESTAMP `created_at` / `updated_at`, and 008 retypes
-- every such column to TIMESTAMPTZ on each replay of the runner, so the cloud changed type on the
-- second `--apply` (under an ACCESS EXCLUSIVE lock) and a locally bootstrapped database never did.
-- This converts them once, deliberately, the way 008 would (the stored wall time is UTC), and only
-- where the column is still TIMESTAMP, so a replay or an already-converted database does nothing.
--
-- The indexes: `GET /api/v3/combos`, combo delete and the Frooz Pack tree each ask whether
-- anything ever billed a combo or a size; without these that is a sequential scan of sale_items.
--
-- Every statement below is also in `initializeDatabase()`, word for word, because the startup
-- bootstrap is switched off on a hosted deployment. Additive and idempotent; no row is inserted,
-- updated or deleted. Forward-only. Never edit this file once it has been applied anywhere.
-- Requires 024 and 025.
ALTER TABLE packing_purchases ADD COLUMN IF NOT EXISTS client_ref VARCHAR(80);
CREATE UNIQUE INDEX IF NOT EXISTS packing_purchases_client_ref_key
  ON packing_purchases (company_id, client_ref)
  WHERE client_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS sale_items_combo_id_idx
  ON sale_items (combo_id)
  WHERE combo_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sale_packing_usage_size_idx
  ON sale_packing_usage (size_id);
CREATE INDEX IF NOT EXISTS sale_packing_usage_size_global_idx
  ON sale_packing_usage (size_global_id);
CREATE INDEX IF NOT EXISTS sale_packing_usage_combo_idx
  ON sale_packing_usage (combo_id)
  WHERE combo_id IS NOT NULL;
DO $$
DECLARE
  target RECORD;
BEGIN
  FOR target IN
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND data_type = 'timestamp without time zone'
      AND (table_name, column_name) IN (
        ('combos', 'created_at'), ('combos', 'updated_at'),
        ('packing_types', 'created_at'), ('packing_types', 'updated_at'),
        ('packing_designs', 'created_at'), ('packing_designs', 'updated_at'),
        ('packing_sizes', 'created_at'), ('packing_sizes', 'updated_at'),
        ('packing_stock', 'updated_at'),
        ('packing_purchases', 'created_at'),
        ('packing_movements', 'created_at')
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN %I TYPE TIMESTAMPTZ USING %I AT TIME ZONE ''UTC''',
      target.table_name,
      target.column_name,
      target.column_name
    );
  END LOOP;
END $$;
