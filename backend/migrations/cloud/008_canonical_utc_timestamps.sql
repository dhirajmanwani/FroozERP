-- Apply only after a verified PostgreSQL backup. Existing TIMESTAMPTZ columns
-- are skipped. Legacy TIMESTAMP columns with sync/audit names are interpreted
-- as UTC wall time, matching FroozERP/Railway server behavior, then converted
-- without applying the device's Asia/Kolkata offset.

DO $$
DECLARE
  column_record RECORD;
BEGIN
  FOR column_record IN
    SELECT table_schema, table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type = 'timestamp without time zone'
      AND column_name IN (
        'created_at', 'updated_at', 'deleted_at', 'pushed_at', 'pulled_at',
        'last_sync_at', 'last_push_at', 'last_pull_at', 'last_successful_sync_at',
        'last_synced_at', 'last_attempt_at', 'processed_at', 'received_at',
        'detected_at', 'resolved_at', 'last_seen_at'
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ALTER COLUMN %I TYPE TIMESTAMPTZ USING %I AT TIME ZONE ''UTC''',
      column_record.table_schema,
      column_record.table_name,
      column_record.column_name,
      column_record.column_name
    );
  END LOOP;
END $$;

ALTER TABLE authorized_devices ALTER COLUMN company_id DROP DEFAULT;
ALTER TABLE sync_processed_operations ALTER COLUMN company_id DROP DEFAULT;
ALTER TABLE sync_change_log ALTER COLUMN company_id DROP DEFAULT;
ALTER TABLE sync_conflict_log ALTER COLUMN company_id DROP DEFAULT;
ALTER TABLE sync_pos_sale_staging ALTER COLUMN company_id DROP DEFAULT;
