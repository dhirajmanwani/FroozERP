-- Phase 4C.0 cloud sync metadata foundation.
-- Migration plan only. Do not apply automatically.
-- Apply only after a verified PostgreSQL backup and a module-by-module rollout review.
-- Create-only: no business tables or rows are altered, updated, reset, or deleted.

CREATE TABLE IF NOT EXISTS cloud_sync_entity_metadata (
  entity_type VARCHAR(80) NOT NULL,
  entity_id VARCHAR(180) NOT NULL,
  company_id INTEGER,
  branch_id INTEGER,
  sub_branch_id INTEGER,
  device_id VARCHAR(160),
  idempotency_key VARCHAR(220) NOT NULL,
  conflict_status VARCHAR(40) NOT NULL DEFAULT 'none',
  created_by_device_id VARCHAR(160),
  updated_by_device_id VARCHAR(160),
  sync_status VARCHAR(40) NOT NULL DEFAULT 'pending',
  synced_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (entity_type, entity_id),
  UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS cloud_sync_entity_metadata_scope_idx
  ON cloud_sync_entity_metadata(company_id, branch_id, sub_branch_id, entity_type);

CREATE INDEX IF NOT EXISTS cloud_sync_entity_metadata_status_idx
  ON cloud_sync_entity_metadata(sync_status, conflict_status, updated_at);
