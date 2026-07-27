-- Publish genuine inventory-lot mutations as location-scoped incremental changes.
-- This migration creates no historical change rows and changes no business data.

CREATE UNIQUE INDEX IF NOT EXISTS sync_change_log_publication_idempotency_idx
  ON sync_change_log(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION froozerp_prepare_inventory_lot_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.global_id := COALESCE(NULLIF(NEW.global_id, ''), 'inventory-lot-' || NEW.id::TEXT);
    NEW.entity_version := GREATEST(COALESCE(NEW.entity_version, 1), 1);
  ELSE
    NEW.entity_version := GREATEST(COALESCE(OLD.entity_version, 0) + 1, 1);
  END IF;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION froozerp_publish_inventory_lot_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  lot inventory_batches%ROWTYPE;
  product_global_id_value TEXT;
  product_name_value TEXT;
  operation_value TEXT;
  version_value INTEGER;
  source_device_value TEXT;
  source_user_value INTEGER;
  source_operation_value TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    lot := OLD;
  ELSE
    lot := NEW;
  END IF;
  IF lot.company_id IS NULL
     OR lot.branch_id IS NULL
     OR lot.operational_location_id IS NULL
     OR NULLIF(lot.global_id, '') IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM 1
  FROM operational_locations ol
  WHERE ol.id = lot.operational_location_id
    AND ol.company_id = lot.company_id
    AND ol.branch_id = lot.branch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory lot % has an invalid company/branch/location relationship', lot.global_id;
  END IF;

  SELECT p.global_id, p.product_name
    INTO product_global_id_value, product_name_value
  FROM products p
  WHERE p.id = lot.product_id
    AND p.company_id = lot.company_id;
  IF product_global_id_value IS NULL THEN
    RAISE EXCEPTION 'Scoped inventory lot % has no company product identity', lot.global_id;
  END IF;

  operation_value := CASE
    WHEN TG_OP = 'DELETE' OR lot.deleted_at IS NOT NULL THEN 'DELETE'
    ELSE 'UPSERT'
  END;
  version_value := CASE
    WHEN TG_OP = 'DELETE' THEN COALESCE(lot.entity_version, 1) + 1
    ELSE COALESCE(lot.entity_version, 1)
  END;
  source_device_value := NULLIF(CURRENT_SETTING('froozerp.device_id', TRUE), '');
  source_user_value := NULLIF(CURRENT_SETTING('froozerp.user_id', TRUE), '')::INTEGER;
  source_operation_value := NULLIF(CURRENT_SETTING('froozerp.operation_id', TRUE), '');

  INSERT INTO sync_change_log (
    company_id, branch_id, operational_location_id,
    entity_type, entity_id, operation_type, entity_version, payload,
    device_id, source_device_id, created_by_user_id, updated_by_user_id,
    idempotency_key, created_at
  )
  VALUES (
    lot.company_id, lot.branch_id, lot.operational_location_id,
    'inventory_lot', lot.global_id, operation_value, version_value,
    TO_JSONB(lot) || JSONB_BUILD_OBJECT(
      'product_global_id', product_global_id_value,
      'product_name', product_name_value,
      'source_operation_id', source_operation_value
    ),
    source_device_value, source_device_value, source_user_value, source_user_value,
    'inventory-lot:' || lot.global_id || ':v' || version_value::TEXT || ':' || LOWER(operation_value),
    CURRENT_TIMESTAMP
  )
  ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS froozerp_inventory_lot_prepare_sync ON inventory_batches;
CREATE TRIGGER froozerp_inventory_lot_prepare_sync
BEFORE INSERT OR UPDATE ON inventory_batches
FOR EACH ROW
EXECUTE FUNCTION froozerp_prepare_inventory_lot_sync();

DROP TRIGGER IF EXISTS froozerp_inventory_lot_publish_sync ON inventory_batches;
CREATE TRIGGER froozerp_inventory_lot_publish_sync
AFTER INSERT OR UPDATE OR DELETE ON inventory_batches
FOR EACH ROW
EXECUTE FUNCTION froozerp_publish_inventory_lot_sync();

ALTER TABLE operational_location_products
  ADD COLUMN IF NOT EXISTS entity_version INTEGER NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION froozerp_prepare_location_product_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW.entity_version := GREATEST(COALESCE(OLD.entity_version, 0) + 1, 1);
  ELSE
    NEW.entity_version := GREATEST(COALESCE(NEW.entity_version, 1), 1);
  END IF;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION froozerp_publish_location_product_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  setting operational_location_products%ROWTYPE;
  product_global_id_value TEXT;
  product_name_value TEXT;
  operation_value TEXT;
  version_value INTEGER;
  source_device_value TEXT;
  source_user_value INTEGER;
  source_operation_value TEXT;
  entity_id_value TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    setting := OLD;
  ELSE
    setting := NEW;
  END IF;
  PERFORM 1
  FROM operational_locations ol
  WHERE ol.id = setting.operational_location_id
    AND ol.company_id = setting.company_id
    AND ol.branch_id = setting.branch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Location product has an invalid company/branch/location relationship';
  END IF;

  SELECT p.global_id, p.product_name
    INTO product_global_id_value, product_name_value
  FROM products p
  WHERE p.id = setting.product_id
    AND p.company_id = setting.company_id;
  IF product_global_id_value IS NULL THEN
    RAISE EXCEPTION 'Location product has no company product identity';
  END IF;

  operation_value := CASE WHEN TG_OP = 'DELETE' THEN 'DELETE' ELSE 'UPSERT' END;
  version_value := CASE
    WHEN TG_OP = 'DELETE' THEN COALESCE(setting.entity_version, 1) + 1
    ELSE COALESCE(setting.entity_version, 1)
  END;
  source_device_value := NULLIF(CURRENT_SETTING('froozerp.device_id', TRUE), '');
  source_user_value := NULLIF(CURRENT_SETTING('froozerp.user_id', TRUE), '')::INTEGER;
  source_operation_value := NULLIF(CURRENT_SETTING('froozerp.operation_id', TRUE), '');
  entity_id_value := setting.operational_location_id::TEXT || ':' || product_global_id_value;

  INSERT INTO sync_change_log (
    company_id, branch_id, operational_location_id,
    entity_type, entity_id, operation_type, entity_version, payload,
    device_id, source_device_id, created_by_user_id, updated_by_user_id,
    idempotency_key, created_at
  )
  VALUES (
    setting.company_id, setting.branch_id, setting.operational_location_id,
    'location_product', entity_id_value, operation_value, version_value,
    TO_JSONB(setting) || JSONB_BUILD_OBJECT(
      'product_global_id', product_global_id_value,
      'product_name', product_name_value,
      'source_operation_id', source_operation_value
    ),
    source_device_value, source_device_value, source_user_value, source_user_value,
    'location-product:' || entity_id_value || ':v' || version_value::TEXT || ':' || LOWER(operation_value),
    CURRENT_TIMESTAMP
  )
  ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS froozerp_location_product_prepare_sync ON operational_location_products;
CREATE TRIGGER froozerp_location_product_prepare_sync
BEFORE INSERT OR UPDATE ON operational_location_products
FOR EACH ROW
EXECUTE FUNCTION froozerp_prepare_location_product_sync();

DROP TRIGGER IF EXISTS froozerp_location_product_publish_sync ON operational_location_products;
CREATE TRIGGER froozerp_location_product_publish_sync
AFTER INSERT OR UPDATE OR DELETE ON operational_location_products
FOR EACH ROW
EXECUTE FUNCTION froozerp_publish_location_product_sync();
