CREATE TABLE IF NOT EXISTS local_connectivity_mode_audit (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  username TEXT,
  role TEXT NOT NULL,
  device_id TEXT NOT NULL,
  previous_mode TEXT NOT NULL,
  next_mode TEXT NOT NULL,
  changed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_local_connectivity_mode_audit_changed_at
  ON local_connectivity_mode_audit(changed_at DESC);
