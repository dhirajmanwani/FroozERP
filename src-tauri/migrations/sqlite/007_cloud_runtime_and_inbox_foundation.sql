-- Phase 4B.3 local cloud/device runtime foundation.
-- Apply only through the controlled SQLite migration runner after a local DB backup.
-- Create-only migration: existing business and sync rows remain unchanged.

CREATE TABLE IF NOT EXISTS sync_devices (
  device_id TEXT PRIMARY KEY,
  company_id TEXT,
  branch_id TEXT,
  sub_branch_id TEXT,
  user_id TEXT,
  role TEXT,
  device_name TEXT NOT NULL,
  device_type TEXT NOT NULL,
  app_mode TEXT NOT NULL DEFAULT 'LOCAL_SINGLE_DEVICE',
  registration_status TEXT NOT NULL DEFAULT 'pending',
  last_seen_at TEXT,
  last_sync_at TEXT,
  sync_status TEXT NOT NULL DEFAULT 'IDLE',
  pending_queue_count INTEGER NOT NULL DEFAULT 0,
  failed_queue_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sync_devices_company_branch
  ON sync_devices(company_id, branch_id, registration_status);

CREATE TABLE IF NOT EXISTS sync_runtime_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  company_id TEXT,
  branch_id TEXT,
  sub_branch_id TEXT,
  device_id TEXT,
  user_id TEXT,
  role TEXT,
  app_mode TEXT NOT NULL DEFAULT 'LOCAL_SINGLE_DEVICE',
  cloud_api_url TEXT,
  branch_lan_api_url TEXT,
  custom_api_url TEXT,
  last_sync_at TEXT,
  sync_status TEXT NOT NULL DEFAULT 'IDLE',
  pending_queue_count INTEGER NOT NULL DEFAULT 0,
  failed_queue_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_inbox (
  operation_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  company_id TEXT,
  branch_id TEXT,
  sub_branch_id TEXT,
  source_device_id TEXT NOT NULL,
  user_id TEXT,
  role TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'received',
  conflict_status TEXT NOT NULL DEFAULT 'none',
  created_at TEXT NOT NULL,
  processed_at TEXT,
  failed_reason TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sync_inbox_scope
  ON sync_inbox(company_id, branch_id, entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_sync_inbox_status
  ON sync_inbox(sync_status, received_at);
