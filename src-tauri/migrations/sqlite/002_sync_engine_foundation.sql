ALTER TABLE sync_outbox ADD COLUMN operation_id TEXT;
ALTER TABLE sync_outbox ADD COLUMN payload_json TEXT;
ALTER TABLE sync_outbox ADD COLUMN user_id TEXT;
ALTER TABLE sync_outbox ADD COLUMN entity_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sync_outbox ADD COLUMN last_attempt_at TEXT;
ALTER TABLE sync_outbox ADD COLUMN synced_at TEXT;
ALTER TABLE sync_outbox ADD COLUMN server_ack TEXT;

UPDATE sync_outbox
SET operation_id = COALESCE(operation_id, id),
    payload_json = COALESCE(payload_json, payload),
    entity_version = COALESCE(entity_version, version, 1),
    status = LOWER(status)
WHERE operation_id IS NULL OR payload_json IS NULL OR status <> LOWER(status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_outbox_operation_id
  ON sync_outbox(operation_id);

CREATE INDEX IF NOT EXISTS idx_sync_outbox_phase2_status_created
  ON sync_outbox(status, created_at);

ALTER TABLE sync_state ADD COLUMN last_pull_cursor TEXT;
ALTER TABLE sync_state ADD COLUMN last_push_at TEXT;
ALTER TABLE sync_state ADD COLUMN last_pull_at TEXT;
ALTER TABLE sync_state ADD COLUMN failed_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_state ADD COLUMN conflict_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE sync_conflicts ADD COLUMN local_version INTEGER;
ALTER TABLE sync_conflicts ADD COLUMN server_version INTEGER;
ALTER TABLE sync_conflicts ADD COLUMN reason TEXT;
ALTER TABLE sync_conflicts ADD COLUMN status TEXT NOT NULL DEFAULT 'open';

CREATE TABLE IF NOT EXISTS local_device_identity (
  device_id TEXT PRIMARY KEY,
  device_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  app_version TEXT NOT NULL,
  branch_id TEXT NOT NULL DEFAULT '1',
  registration_status TEXT NOT NULL DEFAULT 'pending',
  last_seen_at TEXT,
  last_sync_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS local_sync_test_entities (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL DEFAULT '1',
  device_id TEXT,
  value TEXT NOT NULL,
  server_version INTEGER NOT NULL DEFAULT 0,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS local_pos_sale_drafts (
  id TEXT PRIMARY KEY,
  offline_invoice_ref TEXT NOT NULL UNIQUE,
  branch_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  created_by TEXT,
  payload_json TEXT NOT NULL,
  server_version INTEGER NOT NULL DEFAULT 0,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
