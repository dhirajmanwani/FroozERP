-- Phase 4B.5 truthful server-confirmed sync delivery state.
-- Additive only. Existing rows, local identity, and business data are preserved.
ALTER TABLE sync_state ADD COLUMN last_push_result TEXT;

-- Earlier builds wrote pull-only activity as a completed sync. Clear only that
-- ambiguous metadata; the next full server-confirmed cycle writes the value.
UPDATE sync_state
SET last_successful_sync_at = NULL
WHERE device_id <> 'default'
  AND last_push_at IS NULL;
