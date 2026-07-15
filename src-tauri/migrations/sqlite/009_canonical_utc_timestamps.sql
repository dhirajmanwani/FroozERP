-- Canonicalize timestamp text already known to represent UTC. Values with an
-- explicit offset are converted to UTC; timezone-free SQLite values are treated
-- as UTC and are never shifted by the device timezone.

UPDATE local_kv SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) WHERE updated_at IS NOT NULL;
UPDATE sync_outbox SET
  created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at),
  last_attempt_at = CASE WHEN last_attempt_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', last_attempt_at) END,
  synced_at = CASE WHEN synced_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', synced_at) END,
  last_synced_at = CASE WHEN last_synced_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', last_synced_at) END;
UPDATE sync_state SET
  last_successful_sync_at = CASE WHEN last_successful_sync_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', last_successful_sync_at) END,
  last_push_at = CASE WHEN last_push_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', last_push_at) END,
  last_pull_at = CASE WHEN last_pull_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', last_pull_at) END,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at);
UPDATE sync_conflicts SET
  detected_at = strftime('%Y-%m-%dT%H:%M:%fZ', detected_at),
  resolved_at = CASE WHEN resolved_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at) END,
  last_synced_at = CASE WHEN last_synced_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', last_synced_at) END;
UPDATE local_categories SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at), deleted_at = CASE WHEN deleted_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) END;
UPDATE local_products SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at), deleted_at = CASE WHEN deleted_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) END;
UPDATE local_inventory_lots SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at), deleted_at = CASE WHEN deleted_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) END;
UPDATE local_customers SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at), deleted_at = CASE WHEN deleted_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) END;
UPDATE local_settings SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at), deleted_at = CASE WHEN deleted_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) END;
UPDATE local_device_identity SET last_seen_at = CASE WHEN last_seen_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', last_seen_at) END, last_sync_at = CASE WHEN last_sync_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', last_sync_at) END, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at);
UPDATE local_sync_test_entities SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at), deleted_at = CASE WHEN deleted_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) END;
UPDATE local_pos_sale_drafts SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at);
UPDATE local_pos_invoices SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at), synced_at = CASE WHEN synced_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', synced_at) END, cancelled_at = CASE WHEN cancelled_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', cancelled_at) END, last_synced_at = CASE WHEN last_synced_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', last_synced_at) END;
UPDATE local_stock_movements SET movement_time = strftime('%Y-%m-%dT%H:%M:%fZ', movement_time), created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), last_synced_at = CASE WHEN last_synced_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', last_synced_at) END;
UPDATE local_payment_postings SET posting_time = strftime('%Y-%m-%dT%H:%M:%fZ', posting_time), created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at);
UPDATE local_sale_audit_log SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at);
UPDATE local_customer_ledger_entries SET transaction_time = strftime('%Y-%m-%dT%H:%M:%fZ', transaction_time);
UPDATE sync_devices SET last_seen_at = CASE WHEN last_seen_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', last_seen_at) END, last_sync_at = CASE WHEN last_sync_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', last_sync_at) END, created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at);
UPDATE sync_runtime_config SET last_sync_at = CASE WHEN last_sync_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', last_sync_at) END, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at);
UPDATE sync_inbox SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at), processed_at = CASE WHEN processed_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', processed_at) END, received_at = strftime('%Y-%m-%dT%H:%M:%fZ', received_at);
