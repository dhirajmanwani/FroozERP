-- Protocol-v3 operational constraints (additive).
-- No data rows are inserted, updated, or deleted by this migration.

ALTER TABLE inventory_batches ALTER COLUMN purchase_rate DROP NOT NULL;
ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS global_id VARCHAR(180);
ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS effective_cost_per_unit NUMERIC(14, 4);
ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS supplier_id INTEGER REFERENCES suppliers(id);
ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS batch_status VARCHAR(20) DEFAULT 'ACTIVE';
ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS stock_source VARCHAR(40) DEFAULT 'PURCHASE';
ALTER TABLE products ALTER COLUMN selling_rate DROP NOT NULL;
ALTER TABLE inventory_transfer_items
  ADD COLUMN IF NOT EXISTS destination_lot_id INTEGER REFERENCES inventory_batches(id);

-- Historical products can legitimately share a display name. Stable IDs and
-- lot relationships are authoritative; name search must not merge identity.
DROP INDEX IF EXISTS products_category_name_lower_unique_idx;
CREATE INDEX IF NOT EXISTS products_company_name_search_idx
  ON products(company_id, LOWER(product_name));

CREATE UNIQUE INDEX IF NOT EXISTS goods_receipt_items_lot_global_id_idx
  ON goods_receipt_items(lot_global_id);

CREATE INDEX IF NOT EXISTS purchase_orders_location_status_idx
  ON purchase_orders(company_id, branch_id, operational_location_id, status, order_date);

CREATE INDEX IF NOT EXISTS goods_receipts_location_time_idx
  ON goods_receipts(company_id, branch_id, operational_location_id, received_at);

CREATE INDEX IF NOT EXISTS supplier_bills_location_date_idx
  ON supplier_bills(company_id, branch_id, operational_location_id, bill_date);

CREATE INDEX IF NOT EXISTS inventory_transfers_source_status_idx
  ON inventory_transfers(company_id, source_operational_location_id, status, created_at);

CREATE INDEX IF NOT EXISTS inventory_transfers_destination_status_idx
  ON inventory_transfers(company_id, destination_operational_location_id, status, created_at);

CREATE INDEX IF NOT EXISTS staff_location_assignments_scope_idx
  ON staff_location_assignments(user_id, company_id, operational_location_id)
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS device_assignments_scope_idx
  ON device_assignments(device_id, company_id, operational_location_id)
  WHERE active = TRUE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'purchase_orders_status_v3_check'
  ) THEN
    ALTER TABLE purchase_orders
      ADD CONSTRAINT purchase_orders_status_v3_check
      CHECK (status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'))
      NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_transfers_status_v3_check'
  ) THEN
    ALTER TABLE inventory_transfers
      ADD CONSTRAINT inventory_transfers_status_v3_check
      CHECK (status IN (
        'DRAFT', 'APPROVAL_PENDING', 'APPROVED_RESERVED', 'DISPATCHED_IN_TRANSIT',
        'PARTIALLY_RECEIVED', 'RECEIVED', 'DISCREPANCY_RESOLUTION',
        'RETURN_IN_TRANSIT', 'CLOSED', 'REJECTED', 'CANCELLED'
      )) NOT VALID;
  END IF;
END $$;
