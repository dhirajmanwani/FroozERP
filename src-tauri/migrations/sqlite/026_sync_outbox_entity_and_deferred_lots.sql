-- Lookups by the entity an outbox operation is about, and cloud lot figures held back while a
-- local sale is still on its way.
--
-- `idx_sync_outbox_entity`: the lot-hold predicate in local_db.rs asks, for every lot touched by a
-- pull or a sign-in cache, whether any sale on it still has an operation in flight - a join from
-- `local_stock_movements.invoice_id` to `sync_outbox.entity_id`. Without an index that is a scan
-- of the whole outbox per lot, and the outbox only grows.
--
-- `local_deferred_lot_quantities`: when a pull (or the sign-in cache) has to skip a lot's cloud
-- quantities because a local sale on that lot is still `pending`/`syncing`, the newest skipped cloud
-- figure is kept here, keyed by the surviving local lot id. A push whose acknowledgement was lost
-- has already reached the cloud figure, so once the blocking operations settle that figure is the
-- right one - unless a newer cloud change for the lot was applied first, which deletes the row.
-- Persisted so a restart between the skip and the settle does not lose it. Deleted once applied.
--
-- Idempotent (IF NOT EXISTS throughout) and additionally version-gated by apply_migration().
-- Forward-only: never edit this file once it has been applied anywhere.

CREATE INDEX IF NOT EXISTS idx_sync_outbox_entity ON sync_outbox(entity_id);

CREATE TABLE IF NOT EXISTS local_deferred_lot_quantities (
  lot_id TEXT PRIMARY KEY,
  change_seq INTEGER,
  change_version INTEGER,
  quantities_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
