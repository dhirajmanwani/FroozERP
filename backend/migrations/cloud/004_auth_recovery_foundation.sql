ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_email VARCHAR(180);
ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_mobile VARCHAR(30);
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_email VARCHAR(180);
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_email_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_email_verified_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_recovery_email VARCHAR(180);
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_mobile VARCHAR(30);
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_mobile_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_mobile_verified_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_recovery_mobile VARCHAR(30);
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_enabled BOOLEAN DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_self_recovery_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS force_password_change BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_revocation_version INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP;

CREATE TABLE IF NOT EXISTS auth_audit_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  actor_user_id INTEGER REFERENCES users(id),
  username VARCHAR(120),
  action VARCHAR(80) NOT NULL,
  safe_code VARCHAR(80),
  device_id VARCHAR(160),
  ip_address VARCHAR(80),
  details JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS account_recovery_requests (
  request_id VARCHAR(80) PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  purpose VARCHAR(40) NOT NULL,
  method VARCHAR(20) NOT NULL,
  contact_hash VARCHAR(128) NOT NULL,
  otp_hash VARCHAR(128) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  attempt_count INTEGER DEFAULT 0,
  resend_available_at TIMESTAMP,
  used_at TIMESTAMP,
  invalidated_at TIMESTAMP,
  verified_at TIMESTAMP,
  verification_token_hash VARCHAR(128),
  verification_expires_at TIMESTAMP,
  requested_ip VARCHAR(80),
  requested_device_id VARCHAR(160),
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS account_recovery_user_idx
  ON account_recovery_requests (user_id, purpose, created_at DESC);

CREATE INDEX IF NOT EXISTS account_recovery_contact_idx
  ON account_recovery_requests (contact_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS owner_admin_support_contacts (
  id SERIAL PRIMARY KEY,
  label VARCHAR(120) NOT NULL,
  contact_type VARCHAR(30) NOT NULL,
  contact_value VARCHAR(180) NOT NULL,
  visible_to_staff BOOLEAN DEFAULT FALSE,
  active BOOLEAN DEFAULT TRUE,
  updated_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Recovery readiness report:
-- SELECT u.id, u.username, r.role_name, u.email, u.mobile_number
-- FROM users u
-- JOIN roles r ON r.id = u.role_id
-- WHERE u.active = TRUE
--   AND NOT (
--     (COALESCE(u.recovery_email_verified, FALSE) = TRUE AND COALESCE(u.recovery_email, '') <> '')
--     OR (COALESCE(u.recovery_mobile_verified, FALSE) = TRUE AND COALESCE(u.recovery_mobile, '') <> '')
--     OR COALESCE(u.verified_email, '') <> ''
--     OR COALESCE(u.verified_mobile, '') <> ''
--   )
-- ORDER BY r.role_name, u.username;
