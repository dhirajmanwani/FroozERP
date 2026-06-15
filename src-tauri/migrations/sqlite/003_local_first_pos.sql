CREATE TABLE IF NOT EXISTS local_pos_invoices (
  id TEXT PRIMARY KEY,
  offline_invoice_ref TEXT NOT NULL UNIQUE,
  branch_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  user_id TEXT,
  customer_id TEXT,
  customer_name TEXT,
  customer_mobile TEXT,
  bill_date TEXT NOT NULL,
  bill_datetime TEXT NOT NULL,
  payment_mode TEXT NOT NULL,
  gross_total REAL NOT NULL DEFAULT 0,
  item_discount_total REAL NOT NULL DEFAULT 0,
  bill_discount_total REAL NOT NULL DEFAULT 0,
  tax_total REAL NOT NULL DEFAULT 0,
  net_total REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'COMPLETED',
  sync_status TEXT NOT NULL DEFAULT 'pending',
  server_invoice_no TEXT,
  server_sale_id TEXT,
  entity_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  synced_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_local_pos_invoices_status
  ON local_pos_invoices(sync_status, created_at);

CREATE TABLE IF NOT EXISTS local_pos_invoice_items (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES local_pos_invoices(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  product_name TEXT,
  lot_id TEXT NOT NULL,
  lot_name TEXT,
  lot_size TEXT,
  quantity REAL NOT NULL CHECK (quantity > 0),
  unit TEXT,
  rate REAL NOT NULL CHECK (rate >= 0),
  discount REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  stock_movement_id TEXT NOT NULL,
  entity_version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_local_pos_items_invoice
  ON local_pos_invoice_items(invoice_id);

CREATE TABLE IF NOT EXISTS local_stock_movements (
  id TEXT PRIMARY KEY,
  invoice_id TEXT REFERENCES local_pos_invoices(id) ON DELETE CASCADE,
  item_id TEXT REFERENCES local_pos_invoice_items(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  lot_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  movement_type TEXT NOT NULL,
  quantity REAL NOT NULL CHECK (quantity > 0),
  quantity_delta REAL NOT NULL,
  movement_time TEXT NOT NULL DEFAULT (datetime('now')),
  sync_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_local_stock_movements_lot
  ON local_stock_movements(lot_id, created_at);

CREATE TABLE IF NOT EXISTS local_payment_postings (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES local_pos_invoices(id) ON DELETE CASCADE,
  posting_type TEXT NOT NULL,
  payment_mode TEXT NOT NULL,
  account_id TEXT,
  customer_id TEXT,
  amount REAL NOT NULL CHECK (amount > 0),
  branch_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  posting_time TEXT NOT NULL DEFAULT (datetime('now')),
  sync_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_local_payment_postings_invoice
  ON local_payment_postings(invoice_id);
