-- Company-scoped supplier references required for offline purchase entry.
-- Financial, banking, ledger, payment, and operational transaction data is excluded.

CREATE TABLE IF NOT EXISTS local_supplier_references (
  id TEXT PRIMARY KEY,
  cloud_id TEXT NOT NULL UNIQUE,
  company_id TEXT NOT NULL,
  supplier_name TEXT NOT NULL,
  firm_name TEXT,
  supplier_type TEXT NOT NULL DEFAULT 'LOCAL_SUPPLIER',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  sync_status TEXT NOT NULL DEFAULT 'synced',
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_local_supplier_references_company_active
  ON local_supplier_references(company_id, active, supplier_name);
