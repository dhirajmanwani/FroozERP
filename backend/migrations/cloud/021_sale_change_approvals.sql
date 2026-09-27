-- Owner/Admin approval for a cashier's bill cancel or edit.
--
-- ## What this carries
--
-- `sale_change_approvals`: one row per approval attempt made through
-- `POST /api/v3/sale-change-approvals`. ISSUED when the Owner or Admin password typed on the counter
-- was right, CONSUMED once the cancel or edit it covers has been written, FAILED for a wrong attempt.
-- FAILED rows are what the per-requester limit counts (5 in 15 minutes, 10 a day); the approver's own login
-- lockout is never touched, so a cashier cannot lock the Owner out by typing their username.
--
-- `sale_audit_trail.approved_by`: who approved a change, next to `edited_by`, who made it.
--
-- ## Why this file exists
--
-- Both are declared in `initializeDatabase()`, which is switched off on a hosted deployment.
-- Without this file neither reaches the cloud, `verifyDeclaredSchema` refuses to start the backend,
-- and every cashier's cancel or edit would 500 on the missing table -- the shape of gap 014, 015/016,
-- 018, 019 and 020 were each written to close.
--
-- Forward-only. Never edit this file once it has been applied anywhere.

-- Exactly the statements from the startup bootstrap, so the two paths cannot drift. IF NOT EXISTS
-- keeps this safe to re-run (the runner replays the whole list every time) and safe on a database
-- that was bootstrapped locally and already has them.
--
-- The timestamps are TIMESTAMPTZ from the start. 008 converts legacy TIMESTAMP `created_at`
-- columns on every replay, so a plain TIMESTAMP here would be silently retyped on the cloud and
-- not on a locally bootstrapped database.
CREATE TABLE IF NOT EXISTS sale_change_approvals (
  id TEXT PRIMARY KEY,
  status VARCHAR(20) NOT NULL,
  action VARCHAR(20) NOT NULL,
  sale_ref VARCHAR(180) NOT NULL,
  requester_id INTEGER NOT NULL REFERENCES users(id),
  approver_id INTEGER REFERENCES users(id),
  company_id INTEGER,
  branch_id INTEGER,
  device_id VARCHAR(160),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  consumed_sale_id INTEGER REFERENCES sales(id)
);

CREATE INDEX IF NOT EXISTS sale_change_approvals_requester_idx
  ON sale_change_approvals (requester_id, created_at);

ALTER TABLE sale_audit_trail ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES users(id);

-- `users`, `sales` and `sale_audit_trail` are not created here. They are in the 2026-09-21 schema
-- baseline, so the hosted database necessarily has them; if one were absent, the foreign key
-- raising `relation ... does not exist` is the louder and better failure.
