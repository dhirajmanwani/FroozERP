ALTER TABLE local_pos_invoices ADD COLUMN edit_reason TEXT;
ALTER TABLE local_pos_invoices ADD COLUMN cancellation_reason TEXT;
ALTER TABLE local_pos_invoices ADD COLUMN cancelled_by TEXT;
ALTER TABLE local_pos_invoices ADD COLUMN cancelled_at TEXT;
ALTER TABLE local_pos_invoices ADD COLUMN base_version INTEGER DEFAULT 1;

CREATE TABLE IF NOT EXISTS local_sale_audit_log (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  action TEXT NOT NULL,
  user_id TEXT,
  device_id TEXT,
  reason TEXT,
  old_value TEXT,
  new_value TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_local_sale_audit_invoice
  ON local_sale_audit_log(invoice_id, created_at DESC);

CREATE TABLE IF NOT EXISTS local_customer_ledger_entries (
  id TEXT PRIMARY KEY,
  invoice_id TEXT,
  customer_id TEXT,
  branch_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  transaction_type TEXT NOT NULL,
  debit_amount REAL NOT NULL DEFAULT 0,
  credit_amount REAL NOT NULL DEFAULT 0,
  balance_delta REAL NOT NULL DEFAULT 0,
  remarks TEXT,
  transaction_time TEXT NOT NULL DEFAULT (datetime('now')),
  sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_local_customer_ledger_customer
  ON local_customer_ledger_entries(customer_id, transaction_time);
