ALTER TABLE local_connectivity_mode_audit ADD COLUMN server_confirmed_at TEXT;
ALTER TABLE local_connectivity_mode_audit ADD COLUMN time_source TEXT NOT NULL DEFAULT 'device';

UPDATE local_connectivity_mode_audit
SET server_confirmed_at = COALESCE(server_confirmed_at, changed_at),
    time_source = COALESCE(NULLIF(time_source, ''), 'device');
