ALTER TABLE local_pos_invoices ADD COLUMN taxable_amount REAL NOT NULL DEFAULT 0;
ALTER TABLE local_pos_invoices ADD COLUMN mandi_tax_rate REAL NOT NULL DEFAULT 0;
ALTER TABLE local_pos_invoices ADD COLUMN mandi_tax_basis TEXT;
ALTER TABLE local_pos_invoices ADD COLUMN tax_config_snapshot TEXT;
