-- Phase 4B.2 local SQLite identity foundation.
-- Apply only through the controlled local migration runner after a local DB backup.
-- Additive only: no drops, deletes, resets, or business recalculation.

ALTER TABLE sync_outbox ADD COLUMN company_id TEXT;
ALTER TABLE sync_outbox ADD COLUMN sub_branch_id TEXT;
ALTER TABLE sync_outbox ADD COLUMN created_by_user_id TEXT;
ALTER TABLE sync_outbox ADD COLUMN updated_by_user_id TEXT;
ALTER TABLE sync_outbox ADD COLUMN idempotency_key TEXT;
ALTER TABLE sync_outbox ADD COLUMN conflict_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE sync_outbox ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE sync_outbox ADD COLUMN last_synced_at TEXT;
ALTER TABLE sync_outbox ADD COLUMN source_device_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_outbox_idempotency_key
  ON sync_outbox(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE sync_state ADD COLUMN company_id TEXT;
ALTER TABLE sync_state ADD COLUMN branch_id TEXT NOT NULL DEFAULT '1';
ALTER TABLE sync_state ADD COLUMN sub_branch_id TEXT;
ALTER TABLE sync_state ADD COLUMN source_device_id TEXT;

ALTER TABLE sync_conflicts ADD COLUMN company_id TEXT;
ALTER TABLE sync_conflicts ADD COLUMN branch_id TEXT NOT NULL DEFAULT '1';
ALTER TABLE sync_conflicts ADD COLUMN sub_branch_id TEXT;
ALTER TABLE sync_conflicts ADD COLUMN device_id TEXT;
ALTER TABLE sync_conflicts ADD COLUMN user_id TEXT;
ALTER TABLE sync_conflicts ADD COLUMN operation_id TEXT;
ALTER TABLE sync_conflicts ADD COLUMN idempotency_key TEXT;
ALTER TABLE sync_conflicts ADD COLUMN conflict_status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE sync_conflicts ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'conflict';
ALTER TABLE sync_conflicts ADD COLUMN last_synced_at TEXT;
ALTER TABLE sync_conflicts ADD COLUMN source_device_id TEXT;

ALTER TABLE local_device_identity ADD COLUMN company_id TEXT;
ALTER TABLE local_device_identity ADD COLUMN sub_branch_id TEXT;
ALTER TABLE local_device_identity ADD COLUMN user_id TEXT;
ALTER TABLE local_device_identity ADD COLUMN role TEXT;
ALTER TABLE local_device_identity ADD COLUMN source_device_id TEXT;

ALTER TABLE local_pos_invoices ADD COLUMN company_id TEXT;
ALTER TABLE local_pos_invoices ADD COLUMN sub_branch_id TEXT;
ALTER TABLE local_pos_invoices ADD COLUMN created_by_user_id TEXT;
ALTER TABLE local_pos_invoices ADD COLUMN updated_by_user_id TEXT;
ALTER TABLE local_pos_invoices ADD COLUMN idempotency_key TEXT;
ALTER TABLE local_pos_invoices ADD COLUMN conflict_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE local_pos_invoices ADD COLUMN last_synced_at TEXT;
ALTER TABLE local_pos_invoices ADD COLUMN source_device_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_local_pos_invoices_idempotency_key
  ON local_pos_invoices(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE local_stock_movements ADD COLUMN company_id TEXT;
ALTER TABLE local_stock_movements ADD COLUMN sub_branch_id TEXT;
ALTER TABLE local_stock_movements ADD COLUMN created_by_user_id TEXT;
ALTER TABLE local_stock_movements ADD COLUMN updated_by_user_id TEXT;
ALTER TABLE local_stock_movements ADD COLUMN idempotency_key TEXT;
ALTER TABLE local_stock_movements ADD COLUMN conflict_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE local_stock_movements ADD COLUMN last_synced_at TEXT;
ALTER TABLE local_stock_movements ADD COLUMN source_device_id TEXT;
