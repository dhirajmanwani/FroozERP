CREATE TABLE IF NOT EXISTS local_purchase_intents (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  provisional_reference TEXT NOT NULL UNIQUE,
  supplier_id TEXT NOT NULL,
  purchase_date TEXT NOT NULL,
  purchase_bill_status TEXT NOT NULL,
  purchase_type TEXT NOT NULL,
  intent_checksum TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'syncing', 'completed', 'failed', 'conflict')),
  server_purchase_ids_json TEXT,
  server_ack_json TEXT,
  last_error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS local_purchase_intent_lines (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  line_index INTEGER NOT NULL,
  provisional_purchase_id TEXT NOT NULL UNIQUE,
  provisional_lot_id TEXT NOT NULL UNIQUE,
  product_id TEXT NOT NULL,
  quantity REAL NOT NULL CHECK (quantity > 0),
  unit TEXT,
  purchase_rate REAL,
  expected_purchase_rate REAL,
  temporary_sale_rate REAL,
  lot_name TEXT,
  lot_size TEXT,
  payload_json TEXT NOT NULL,
  server_purchase_id TEXT,
  server_lot_id TEXT,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (intent_id) REFERENCES local_purchase_intents(id) ON DELETE RESTRICT,
  FOREIGN KEY (product_id) REFERENCES local_products(id) ON DELETE RESTRICT,
  UNIQUE (intent_id, line_index)
);

CREATE INDEX IF NOT EXISTS idx_local_purchase_intents_state_created
  ON local_purchase_intents(state, created_at);

CREATE INDEX IF NOT EXISTS idx_local_purchase_lines_intent
  ON local_purchase_intent_lines(intent_id, line_index);
