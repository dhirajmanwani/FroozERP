-- Phase 4B.3 central cloud/device runtime foundation.
-- Apply only after a verified PostgreSQL backup.
-- Create-only migration: no business rows are updated or deleted.

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY,
  company_name VARCHAR(180) NOT NULL,
  company_code VARCHAR(80) UNIQUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sync_device_configuration (
  device_id VARCHAR(160) PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id),
  branch_id INTEGER REFERENCES branches(id),
  sub_branch_id INTEGER,
  user_id INTEGER REFERENCES users(id),
  role VARCHAR(80),
  device_name VARCHAR(180) NOT NULL,
  device_type VARCHAR(80) NOT NULL,
  app_mode VARCHAR(60) NOT NULL DEFAULT 'LOCAL_SINGLE_DEVICE',
  cloud_api_url TEXT,
  branch_lan_api_url TEXT,
  custom_api_url TEXT,
  registration_status VARCHAR(40) NOT NULL DEFAULT 'PENDING',
  last_sync_at TIMESTAMP,
  sync_status VARCHAR(40) NOT NULL DEFAULT 'IDLE',
  pending_queue_count INTEGER NOT NULL DEFAULT 0,
  failed_queue_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS sync_device_configuration_company_branch_idx
  ON sync_device_configuration(company_id, branch_id, registration_status);

CREATE TABLE IF NOT EXISTS sync_inbox_operations (
  operation_id VARCHAR(180) PRIMARY KEY,
  idempotency_key VARCHAR(220) NOT NULL UNIQUE,
  company_id INTEGER REFERENCES companies(id),
  branch_id INTEGER REFERENCES branches(id),
  sub_branch_id INTEGER,
  source_device_id VARCHAR(160) NOT NULL,
  user_id INTEGER REFERENCES users(id),
  role VARCHAR(80),
  entity_type VARCHAR(80) NOT NULL,
  entity_id VARCHAR(180) NOT NULL,
  operation_type VARCHAR(40) NOT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  sync_status VARCHAR(40) NOT NULL DEFAULT 'received',
  conflict_status VARCHAR(40) NOT NULL DEFAULT 'none',
  created_at TIMESTAMP NOT NULL,
  processed_at TIMESTAMP,
  failed_reason TEXT,
  received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS sync_inbox_operations_scope_idx
  ON sync_inbox_operations(company_id, branch_id, entity_type, entity_id);

CREATE INDEX IF NOT EXISTS sync_inbox_operations_status_idx
  ON sync_inbox_operations(sync_status, received_at);
