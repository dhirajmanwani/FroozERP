-- Local operational-location shadow schema. Additive only.
-- No ownership backfill is performed by this migration.

CREATE TABLE IF NOT EXISTS local_operational_locations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  location_code TEXT NOT NULL,
  location_name TEXT NOT NULL,
  location_type TEXT NOT NULL DEFAULT 'STORE',
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  assignment_generation INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  UNIQUE (company_id, branch_id, location_code)
);

CREATE TABLE IF NOT EXISTS local_operational_location_products (
  operational_location_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  pos_available INTEGER NOT NULL DEFAULT 1 CHECK (pos_available IN (0, 1)),
  selling_rate REAL,
  reorder_level REAL NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (operational_location_id, product_id),
  FOREIGN KEY (operational_location_id) REFERENCES local_operational_locations(id)
);

CREATE TABLE IF NOT EXISTS local_device_assignment (
  device_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  operational_location_id TEXT NOT NULL,
  intended_usage TEXT NOT NULL,
  fixed_operational INTEGER NOT NULL DEFAULT 1 CHECK (fixed_operational IN (0, 1)),
  permission_set_json TEXT NOT NULL DEFAULT '{}',
  assignment_generation INTEGER NOT NULL CHECK (assignment_generation > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  server_confirmed_at TEXT NOT NULL,
  FOREIGN KEY (operational_location_id) REFERENCES local_operational_locations(id)
);

CREATE TABLE IF NOT EXISTS local_staff_location_assignments (
  user_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  operational_location_id TEXT NOT NULL,
  role TEXT,
  permission_set_json TEXT NOT NULL DEFAULT '{}',
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, operational_location_id),
  FOREIGN KEY (operational_location_id) REFERENCES local_operational_locations(id)
);

ALTER TABLE local_inventory_lots ADD COLUMN company_id TEXT;
ALTER TABLE local_inventory_lots ADD COLUMN operational_location_id TEXT;
ALTER TABLE local_products ADD COLUMN company_id TEXT;
ALTER TABLE local_products ADD COLUMN operational_location_id TEXT;
ALTER TABLE local_pos_invoices ADD COLUMN operational_location_id TEXT;
ALTER TABLE local_payment_postings ADD COLUMN company_id TEXT;
ALTER TABLE local_payment_postings ADD COLUMN operational_location_id TEXT;
ALTER TABLE local_stock_movements ADD COLUMN operational_location_id TEXT;
ALTER TABLE local_customer_ledger_entries ADD COLUMN company_id TEXT;
ALTER TABLE local_customer_ledger_entries ADD COLUMN operational_location_id TEXT;
ALTER TABLE sync_outbox ADD COLUMN operational_location_id TEXT;
ALTER TABLE sync_outbox ADD COLUMN assignment_generation INTEGER;
ALTER TABLE sync_inbox ADD COLUMN operational_location_id TEXT;
ALTER TABLE sync_inbox ADD COLUMN assignment_generation INTEGER;
ALTER TABLE sync_conflicts ADD COLUMN operational_location_id TEXT;
ALTER TABLE sync_conflicts ADD COLUMN assignment_generation INTEGER;
ALTER TABLE sync_state ADD COLUMN operational_location_id TEXT;
ALTER TABLE sync_state ADD COLUMN assignment_generation INTEGER;
ALTER TABLE sync_runtime_config ADD COLUMN operational_location_id TEXT;
ALTER TABLE sync_runtime_config ADD COLUMN assignment_generation INTEGER;

CREATE INDEX IF NOT EXISTS idx_local_inventory_lots_location_product
  ON local_inventory_lots(company_id, branch_id, operational_location_id, product_id, balance_qty);
CREATE INDEX IF NOT EXISTS idx_sync_outbox_location_status
  ON sync_outbox(company_id, branch_id, operational_location_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_sync_inbox_location
  ON sync_inbox(company_id, branch_id, operational_location_id, received_at);
