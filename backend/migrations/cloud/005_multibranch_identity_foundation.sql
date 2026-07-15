-- Phase 4B.2 multi-branch/cloud identity foundation.
-- Apply only after a verified PostgreSQL backup. This migration is additive only:
-- no table drops, no data deletes, and no business totals recalculation.

ALTER TABLE branches ADD COLUMN IF NOT EXISTS company_id INTEGER;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS sub_branch_id INTEGER;

ALTER TABLE users ADD COLUMN IF NOT EXISTS company_id INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS sub_branch_id INTEGER;

ALTER TABLE authorized_devices ADD COLUMN IF NOT EXISTS company_id INTEGER;
ALTER TABLE authorized_devices ADD COLUMN IF NOT EXISTS sub_branch_id INTEGER;
ALTER TABLE authorized_devices ADD COLUMN IF NOT EXISTS source_device_id VARCHAR(160);

ALTER TABLE sync_processed_operations ADD COLUMN IF NOT EXISTS company_id INTEGER;
ALTER TABLE sync_processed_operations ADD COLUMN IF NOT EXISTS branch_id INTEGER;
ALTER TABLE sync_processed_operations ADD COLUMN IF NOT EXISTS sub_branch_id INTEGER;
ALTER TABLE sync_processed_operations ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER;
ALTER TABLE sync_processed_operations ADD COLUMN IF NOT EXISTS updated_by_user_id INTEGER;
ALTER TABLE sync_processed_operations ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(220);
ALTER TABLE sync_processed_operations ADD COLUMN IF NOT EXISTS conflict_status VARCHAR(40) NOT NULL DEFAULT 'none';
ALTER TABLE sync_processed_operations ADD COLUMN IF NOT EXISTS sync_status VARCHAR(40) NOT NULL DEFAULT 'processed';
ALTER TABLE sync_processed_operations ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMP;
ALTER TABLE sync_processed_operations ADD COLUMN IF NOT EXISTS source_device_id VARCHAR(160);

CREATE UNIQUE INDEX IF NOT EXISTS sync_processed_idempotency_key_unique_idx
  ON sync_processed_operations (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE sync_change_log ADD COLUMN IF NOT EXISTS company_id INTEGER;
ALTER TABLE sync_change_log ADD COLUMN IF NOT EXISTS sub_branch_id INTEGER;
ALTER TABLE sync_change_log ADD COLUMN IF NOT EXISTS device_id VARCHAR(160);
ALTER TABLE sync_change_log ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER;
ALTER TABLE sync_change_log ADD COLUMN IF NOT EXISTS updated_by_user_id INTEGER;
ALTER TABLE sync_change_log ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(220);
ALTER TABLE sync_change_log ADD COLUMN IF NOT EXISTS conflict_status VARCHAR(40) NOT NULL DEFAULT 'none';
ALTER TABLE sync_change_log ADD COLUMN IF NOT EXISTS sync_status VARCHAR(40) NOT NULL DEFAULT 'pending';
ALTER TABLE sync_change_log ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMP;
ALTER TABLE sync_change_log ADD COLUMN IF NOT EXISTS source_device_id VARCHAR(160);

CREATE INDEX IF NOT EXISTS sync_change_log_company_branch_idx
  ON sync_change_log (company_id, branch_id, change_id);

ALTER TABLE sync_conflict_log ADD COLUMN IF NOT EXISTS company_id INTEGER;
ALTER TABLE sync_conflict_log ADD COLUMN IF NOT EXISTS sub_branch_id INTEGER;
ALTER TABLE sync_conflict_log ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER;
ALTER TABLE sync_conflict_log ADD COLUMN IF NOT EXISTS updated_by_user_id INTEGER;
ALTER TABLE sync_conflict_log ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(220);
ALTER TABLE sync_conflict_log ADD COLUMN IF NOT EXISTS conflict_status VARCHAR(40) NOT NULL DEFAULT 'open';
ALTER TABLE sync_conflict_log ADD COLUMN IF NOT EXISTS sync_status VARCHAR(40) NOT NULL DEFAULT 'conflict';
ALTER TABLE sync_conflict_log ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMP;
ALTER TABLE sync_conflict_log ADD COLUMN IF NOT EXISTS source_device_id VARCHAR(160);

ALTER TABLE sync_pos_sale_staging ADD COLUMN IF NOT EXISTS company_id INTEGER;
ALTER TABLE sync_pos_sale_staging ADD COLUMN IF NOT EXISTS sub_branch_id INTEGER;
ALTER TABLE sync_pos_sale_staging ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER;
ALTER TABLE sync_pos_sale_staging ADD COLUMN IF NOT EXISTS updated_by_user_id INTEGER;
ALTER TABLE sync_pos_sale_staging ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(220);
ALTER TABLE sync_pos_sale_staging ADD COLUMN IF NOT EXISTS conflict_status VARCHAR(40) NOT NULL DEFAULT 'none';
ALTER TABLE sync_pos_sale_staging ADD COLUMN IF NOT EXISTS sync_status VARCHAR(40) NOT NULL DEFAULT 'pending';
ALTER TABLE sync_pos_sale_staging ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMP;
ALTER TABLE sync_pos_sale_staging ADD COLUMN IF NOT EXISTS source_device_id VARCHAR(160);

CREATE UNIQUE INDEX IF NOT EXISTS sync_pos_sale_staging_idempotency_key_unique_idx
  ON sync_pos_sale_staging (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
