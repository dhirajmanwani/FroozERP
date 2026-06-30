-- Phase 4C.0 local cloud sync metadata foundation.
-- Migration plan only. It is intentionally not included by local_db.rs.
-- Apply only through the controlled SQLite migration runner after a verified local backup.
-- Create-only: no existing local or business rows are altered, reset, or deleted.

CREATE TABLE IF NOT EXISTS cloud_sync_entity_metadata (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  company_id TEXT,
  branch_id TEXT,
  sub_branch_id TEXT,
  device_id TEXT,
  idempotency_key TEXT NOT NULL,
  conflict_status TEXT NOT NULL DEFAULT 'none',
  created_by_device_id TEXT,
  updated_by_device_id TEXT,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (entity_type, entity_id),
  UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_cloud_sync_entity_metadata_scope
  ON cloud_sync_entity_metadata(company_id, branch_id, sub_branch_id, entity_type);

CREATE INDEX IF NOT EXISTS idx_cloud_sync_entity_metadata_status
  ON cloud_sync_entity_metadata(sync_status, conflict_status, updated_at);
