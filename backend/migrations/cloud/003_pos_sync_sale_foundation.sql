CREATE UNIQUE INDEX IF NOT EXISTS sales_global_id_unique_idx
  ON sales (global_id)
  WHERE global_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS sales_offline_invoice_ref_unique_idx
  ON sales (offline_invoice_ref)
  WHERE offline_invoice_ref IS NOT NULL;
