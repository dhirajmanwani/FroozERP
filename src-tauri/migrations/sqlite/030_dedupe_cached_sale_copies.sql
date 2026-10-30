-- Remove the second copy of a bill that the sign-in cache stored beside the real one.
--
-- ## What went wrong
--
-- A bill this counter made is stored under its own id and, once the cloud accepts it, carries the
-- cloud's sale id in `server_sale_id`. A bill pulled as a `pos_sale` change is stored under its
-- global id and carries `server_sale_id` too. The sign-in cache then copied GET /sales down, whose
-- rows carry no `global_id`, so each of those bills was inserted again as `cloud-sale-<id>` with the
-- same `server_sale_id`. Offline sales history and the LOCAL_ONLY reports listed and totalled every
-- synced bill twice. The cache no longer does this (see `cache_reference_snapshot_at`); this
-- migration removes the copies already stored.
--
-- ## Exactly what is deleted
--
-- A `local_pos_invoices` row C is a removable copy only when ALL of these hold:
--
--   1. C.id begins with `cloud-sale-` (the id only the sign-in cache mints for a list row);
--   2. C.server_sale_id is set; and
--   3. another row T has the same `server_sale_id` and an id that does NOT begin with
--      `cloud-sale-` - so the bill itself, under its own id, always survives. Two `cloud-sale-*`
--      rows that only twin each other are both left alone; and
--   4. C has no local work of its own: no `sync_outbox` row, no stock movement, no sale audit row,
--      no customer ledger entry. A copy somebody edited or cancelled on this counter is left in
--      place, because removing it would lose that work.
--
-- For each such copy, its own child rows (lines, payment postings, charges, packing) are deleted
-- first and then the copy itself. The sign-in cache writes none of those children for a list row,
-- so in practice only the invoice row goes; they are named here so nothing is left pointing at a
-- deleted bill. Nothing else in the database is touched. The cloud keeps every real bill.
--
-- ## Safety
--
-- Idempotent: once the copies are gone the predicate matches nothing, and a sale with no twin
-- never matches it. Forward-only and version-gated in apply_migration() like every migration here;
-- it runs inside that function's transaction. Never edit this file once it has been applied.

CREATE TEMP TABLE IF NOT EXISTS migration_030_copies (id TEXT PRIMARY KEY);
DELETE FROM migration_030_copies;

INSERT INTO migration_030_copies (id)
SELECT c.id
FROM local_pos_invoices c
WHERE c.id LIKE 'cloud-sale-%'
  AND c.server_sale_id IS NOT NULL
  AND TRIM(c.server_sale_id) <> ''
  AND EXISTS (
    SELECT 1 FROM local_pos_invoices t
    WHERE t.server_sale_id = c.server_sale_id
      AND t.id <> c.id
      AND t.id NOT LIKE 'cloud-sale-%'
  )
  AND NOT EXISTS (SELECT 1 FROM sync_outbox o WHERE o.entity_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM local_stock_movements m WHERE m.invoice_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM local_sale_audit_log a WHERE a.invoice_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM local_customer_ledger_entries l WHERE l.invoice_id = c.id);

DELETE FROM local_pos_invoice_items WHERE invoice_id IN (SELECT id FROM migration_030_copies);
DELETE FROM local_payment_postings WHERE invoice_id IN (SELECT id FROM migration_030_copies);
DELETE FROM local_sale_charges WHERE sale_id IN (SELECT id FROM migration_030_copies);
DELETE FROM local_pos_invoice_packing WHERE invoice_id IN (SELECT id FROM migration_030_copies);
DELETE FROM local_pos_invoices WHERE id IN (SELECT id FROM migration_030_copies);

DROP TABLE IF EXISTS migration_030_copies;
