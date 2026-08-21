-- Provisional cost status on locally cached inventory lots.
--
-- WHY THIS EXISTS. The cloud tracks whether a lot's cost is real or a placeholder:
-- `inventory_batches.purchase_bill_status` is BILL_PENDING until the supplier's bill is
-- completed, and the API derives costStatus PROVISIONAL | FINAL from it. The SQLite sync arm for
-- `inventory_lot` dropped that field entirely and took the cost as
-- `effective_cost_per_unit ?? purchase_rate ?? 0.0`, so a lot awaiting its bill and a lot that
-- genuinely cost nothing arrived as the same row.
--
-- The consequence is a number the owner reads every day. `dashboardSnapshot.js` multiplies
-- cost_rate straight into stock value, so a pending-bill lot contributes 0 while presenting as
-- ordinary priced stock. Measured on the 2026-08-15 device snapshot: 7 ACTIVE lots holding
-- 215.550 units -- 18.2% of the 1183.550 units on hand -- contributed Rs 0 to a Rs 282,275.00
-- valuation, and 41.45 units had already been sold from them costed at zero and booked as 100%
-- margin.
--
-- This is the "errors must never render as zero" failure in CLAUDE.md. The total is not
-- wrong-looking; it is quietly incomplete, which is worse, because nothing prompts anyone to
-- check it.
--
-- WHY A COLUMN AND NOT A DERIVED FLAG. The obvious shortcut is the `PENDING-` prefix on
-- batch_no. It is wrong. Lot numbers are minted `PENDING-${Date.now()}-${purchase.id}` and the
-- bill-completion UPDATE never rewrites batch_no, so the prefix outlives the condition it
-- describes: of 49 prefixed lots on that snapshot, 39 already carried a real cost. Any filter
-- on the prefix would be wrong about roughly 80% of them.
--
-- Idempotent across restarts by version-gating in apply_migration(), which skips a version
-- already recorded APPLIED in local_schema_migrations. SQLite has no ADD COLUMN IF NOT EXISTS,
-- so this file is not safe to run twice on its own -- the gate is what makes it idempotent, as
-- for every other ALTER-bearing migration here.

-- NULL means "this device has never been told" -- the state of every row cached before this
-- migration, and the reason presentation code must treat unknown as its own case rather than
-- assuming FINAL. Assuming FINAL would silently restore the exact bug this migration exists to
-- end; assuming PROVISIONAL would flag every historic lot as unpriced. Backfilling a guess was
-- rejected for the same reason: there is no evidence on the device to guess from, and a written
-- guess is indistinguishable from a fact afterwards.
ALTER TABLE local_inventory_lots ADD COLUMN purchase_bill_status TEXT;

-- The dashboard's question is "which lots on hand are still unpriced", asked on every snapshot
-- build, so it gets an index rather than a scan over every lot the device has ever seen.
-- Partial: a completed or unknown lot is never an answer, and soft-deleted rows are never stock.
CREATE INDEX IF NOT EXISTS idx_local_inventory_lots_bill_pending
  ON local_inventory_lots (product_id)
  WHERE purchase_bill_status = 'BILL_PENDING'
    AND deleted_at IS NULL;
