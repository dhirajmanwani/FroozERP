CREATE TABLE IF NOT EXISTS local_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_outbox (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  branch_id TEXT,
  device_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING'
);

CREATE INDEX IF NOT EXISTS idx_sync_outbox_status_created
  ON sync_outbox(status, created_at);

CREATE TABLE IF NOT EXISTS sync_state (
  device_id TEXT PRIMARY KEY,
  last_server_cursor TEXT,
  last_successful_sync_at TEXT,
  current_sync_status TEXT NOT NULL DEFAULT 'IDLE',
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_conflicts (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  local_payload TEXT NOT NULL,
  server_payload TEXT NOT NULL,
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolution_status TEXT NOT NULL DEFAULT 'OPEN',
  resolved_by TEXT,
  resolution_notes TEXT,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS local_categories (
  id TEXT PRIMARY KEY,
  cloud_id TEXT UNIQUE,
  branch_id TEXT,
  counter_id TEXT,
  device_id TEXT,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  version INTEGER NOT NULL DEFAULT 1,
  sync_status TEXT NOT NULL DEFAULT 'SYNCED',
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS local_products (
  id TEXT PRIMARY KEY,
  cloud_id TEXT UNIQUE,
  branch_id TEXT,
  counter_id TEXT,
  device_id TEXT,
  product_name TEXT NOT NULL,
  category_id TEXT,
  category_name TEXT,
  unit TEXT,
  barcode TEXT,
  sale_rate REAL,
  minimum_stock REAL,
  active INTEGER NOT NULL DEFAULT 1,
  remarks TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  version INTEGER NOT NULL DEFAULT 1,
  sync_status TEXT NOT NULL DEFAULT 'SYNCED',
  deleted_at TEXT,
  FOREIGN KEY (category_id) REFERENCES local_categories(id)
);

CREATE INDEX IF NOT EXISTS idx_local_products_name
  ON local_products(product_name);

CREATE TABLE IF NOT EXISTS local_inventory_lots (
  id TEXT PRIMARY KEY,
  cloud_id TEXT UNIQUE,
  branch_id TEXT,
  counter_id TEXT,
  device_id TEXT,
  product_id TEXT NOT NULL,
  product_name TEXT,
  supplier_id TEXT,
  supplier_name TEXT,
  lot_no TEXT,
  size_grade TEXT,
  opening_date TEXT,
  opening_qty REAL NOT NULL DEFAULT 0,
  purchased_qty REAL NOT NULL DEFAULT 0,
  sold_qty REAL NOT NULL DEFAULT 0,
  returned_qty REAL NOT NULL DEFAULT 0,
  waste_qty REAL NOT NULL DEFAULT 0,
  adjusted_qty REAL NOT NULL DEFAULT 0,
  transfer_in_qty REAL NOT NULL DEFAULT 0,
  transfer_out_qty REAL NOT NULL DEFAULT 0,
  balance_qty REAL NOT NULL DEFAULT 0,
  cost_rate REAL NOT NULL DEFAULT 0,
  sale_rate REAL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  remarks TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  version INTEGER NOT NULL DEFAULT 1,
  sync_status TEXT NOT NULL DEFAULT 'SYNCED',
  deleted_at TEXT,
  FOREIGN KEY (product_id) REFERENCES local_products(id)
);

CREATE INDEX IF NOT EXISTS idx_local_lots_product_status
  ON local_inventory_lots(product_id, status, balance_qty);

CREATE TABLE IF NOT EXISTS local_customers (
  id TEXT PRIMARY KEY,
  cloud_id TEXT UNIQUE,
  branch_id TEXT,
  counter_id TEXT,
  device_id TEXT,
  account_name TEXT NOT NULL,
  mobile_number TEXT,
  account_type TEXT NOT NULL DEFAULT 'Customer',
  active INTEGER NOT NULL DEFAULT 1,
  system_account INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  version INTEGER NOT NULL DEFAULT 1,
  sync_status TEXT NOT NULL DEFAULT 'SYNCED',
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS local_settings (
  id TEXT PRIMARY KEY,
  cloud_id TEXT UNIQUE,
  branch_id TEXT,
  counter_id TEXT,
  device_id TEXT,
  setting_key TEXT NOT NULL,
  setting_value TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  version INTEGER NOT NULL DEFAULT 1,
  sync_status TEXT NOT NULL DEFAULT 'SYNCED',
  deleted_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_local_settings_key_branch
  ON local_settings(setting_key, COALESCE(branch_id, 'MAIN'));
