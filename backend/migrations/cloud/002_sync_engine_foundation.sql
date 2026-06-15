CREATE TABLE IF NOT EXISTS sync_processed_operations (
  operation_id VARCHAR(180) PRIMARY KEY,
  device_id VARCHAR(160) NOT NULL,
  entity_type VARCHAR(80) NOT NULL,
  entity_id VARCHAR(180) NOT NULL,
  result_status VARCHAR(40) NOT NULL,
  result_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS sync_processed_device_idx
  ON sync_processed_operations (device_id, processed_at);

CREATE TABLE IF NOT EXISTS sync_change_log (
  change_id BIGSERIAL PRIMARY KEY,
  branch_id INTEGER NOT NULL DEFAULT 1 REFERENCES branches(id),
  entity_type VARCHAR(80) NOT NULL,
  entity_id VARCHAR(180) NOT NULL,
  operation_type VARCHAR(30) NOT NULL,
  entity_version INTEGER NOT NULL DEFAULT 1,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS sync_change_log_cursor_idx
  ON sync_change_log (branch_id, change_id);

CREATE INDEX IF NOT EXISTS sync_change_log_entity_idx
  ON sync_change_log (entity_type, entity_id);

CREATE TABLE IF NOT EXISTS sync_test_entities (
  id VARCHAR(180) PRIMARY KEY,
  branch_id INTEGER NOT NULL DEFAULT 1 REFERENCES branches(id),
  device_id VARCHAR(160),
  value TEXT NOT NULL,
  entity_version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sync_conflict_log (
  id BIGSERIAL PRIMARY KEY,
  operation_id VARCHAR(180),
  device_id VARCHAR(160),
  branch_id INTEGER,
  entity_type VARCHAR(80) NOT NULL,
  entity_id VARCHAR(180) NOT NULL,
  local_version INTEGER,
  server_version INTEGER,
  local_payload JSONB,
  server_payload JSONB,
  reason TEXT NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'open',
  detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sync_pos_sale_staging (
  invoice_global_id VARCHAR(180) PRIMARY KEY,
  offline_invoice_ref VARCHAR(180) UNIQUE NOT NULL,
  branch_id INTEGER NOT NULL DEFAULT 1 REFERENCES branches(id),
  device_id VARCHAR(160) NOT NULL,
  created_by INTEGER REFERENCES users(id),
  payload JSONB NOT NULL,
  result_status VARCHAR(40) NOT NULL DEFAULT 'accepted_for_review',
  entity_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE authorized_devices ADD COLUMN IF NOT EXISTS platform VARCHAR(80) DEFAULT 'Browser';
ALTER TABLE authorized_devices ADD COLUMN IF NOT EXISTS app_version VARCHAR(40) DEFAULT '1.0.0';
ALTER TABLE authorized_devices ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMP;
ALTER TABLE authorized_devices ADD COLUMN IF NOT EXISTS sync_status VARCHAR(40) DEFAULT 'IDLE';

ALTER TABLE product_categories ADD COLUMN IF NOT EXISTS global_id VARCHAR(180);
ALTER TABLE product_categories ADD COLUMN IF NOT EXISTS entity_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE product_categories ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
UPDATE product_categories SET global_id = 'category-' || id WHERE global_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS product_categories_global_id_unique_idx
  ON product_categories (global_id);

ALTER TABLE products ADD COLUMN IF NOT EXISTS global_id VARCHAR(180);
ALTER TABLE products ADD COLUMN IF NOT EXISTS entity_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE products ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
UPDATE products SET global_id = 'product-' || id WHERE global_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS products_global_id_unique_idx
  ON products (global_id);

ALTER TABLE sales ADD COLUMN IF NOT EXISTS global_id VARCHAR(180);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS offline_invoice_ref VARCHAR(180);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS source_device_id VARCHAR(160);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS entity_version INTEGER NOT NULL DEFAULT 1;
