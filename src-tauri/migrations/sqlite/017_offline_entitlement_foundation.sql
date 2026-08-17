-- Offline activation entitlement foundation (design doc §5).
--
-- Additive only: three new tables, no ALTER of any existing table, no row written to any
-- existing table. Stage 2 of docs/offline-activation-plan.md is storage shape only — nothing
-- reads these tables yet, and src-tauri/src/entitlement.rs stays pure with no call sites
-- until Stage 5.
--
-- Idempotent across restarts by construction (CREATE TABLE / CREATE INDEX ... IF NOT EXISTS),
-- and additionally version-gated by apply_migration() in local_db.rs, which skips any version
-- already recorded APPLIED in local_schema_migrations. Forward-only: never edit this file once
-- it has been applied anywhere.
--
-- TIMESTAMP TRUST — read this before using any column here as a clock (§5.3, amended
-- 2026-08-16). `accepted_at`, `occurred_at` and `first_seen_at` default to the DEVICE clock.
-- They record when this device *observed* something and are deliberately NOT trustworthy time.
-- They must never advance local_kv.entitlement_clock_high_water. Only `issued_at`,
-- `expires_at` and `grace_until` carry weight, because all three are derived from the signed
-- payload — a valid signature is proof that real time was at least `issued_at` when the
-- artefact was minted.


-- ---------------------------------------------------------------------------------------
-- §5.1 — the entitlement ledger
--
-- Append-mostly: rows are never deleted and never mutated except to set `superseded_at` or
-- `revoked_at`. Renewal INSERTs a new row and supersedes the old one, so "when did this device
-- stop working?" stays answerable from the device itself, with no cloud contact.
--
-- The active entitlement is the row with the greatest `issued_at` among those where
-- `superseded_at IS NULL AND revoked_at IS NULL`. More than one non-superseded row may exist
-- transiently (accept-then-supersede is two statements), so this is deliberately NOT enforced
-- by a unique index — enforcing it would turn an ordinary interleaving into a write failure.
-- ---------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS local_entitlement (
  entitlement_serial TEXT PRIMARY KEY,
  key_id             INTEGER NOT NULL,
  format_version     INTEGER NOT NULL,
  company_id         TEXT NOT NULL,
  branch_id          TEXT NOT NULL,
  device_id          TEXT NOT NULL,
  device_binding_hex TEXT NOT NULL,
  issued_at          TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  grace_until        TEXT NOT NULL,
  capabilities_json  TEXT NOT NULL DEFAULT '{}',
  payload_blob       BLOB NOT NULL,
  signature_blob     BLOB NOT NULL,
  verification_state TEXT NOT NULL CHECK (
                       verification_state IN ('VERIFIED', 'LEGACY_GRANDFATHER')
                     ),
  source             TEXT NOT NULL CHECK (
                       source IN (
                         'ONLINE_REGISTRATION',
                         'OFFLINE_FILE',
                         'OFFLINE_TYPED',
                         'OFFLINE_QR',
                         'LEGACY_UPGRADE'
                       )
                     ),
  accepted_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  superseded_at      TEXT,
  revoked_at         TEXT,
  revocation_reason  TEXT,

  -- A VERIFIED row must carry a real Ed25519 signature over real bytes. A grandfathered row
  -- (§11.1) is a compatibility shim, not a credential, and must carry none. Tying the two
  -- together here stops the one confusion in this schema that would silently grant authority:
  -- a shim mistaken for a signed entitlement. If Stage 4 grandfathering ever trips this, the
  -- constraint has done its job — do not relax it without re-reading §11.1.
  CHECK (
    (verification_state = 'VERIFIED'
      AND length(signature_blob) = 64
      AND length(payload_blob) > 0)
    OR
    (verification_state = 'LEGACY_GRANDFATHER'
      AND length(signature_blob) = 0)
  ),

  -- Ordering sanity on the signed window. All three are ISO-8601 UTC in the fixed
  -- '%Y-%m-%dT%H:%M:%fZ' shape of migration 009, so lexicographic comparison is chronological.
  CHECK (issued_at <= expires_at),
  CHECK (expires_at <= grace_until)
);

-- Resolving the active entitlement is the hot path (every state evaluation). Partial index so
-- superseded and revoked history stays out of it entirely.
CREATE INDEX IF NOT EXISTS idx_local_entitlement_active
  ON local_entitlement (device_id, issued_at DESC)
  WHERE superseded_at IS NULL AND revoked_at IS NULL;


-- ---------------------------------------------------------------------------------------
-- §5.2 — append-only event log
--
-- `event` is deliberately NOT constrained by a CHECK. An audit log that refuses a write
-- because it does not recognise an event name is worse than one that stores an unexpected
-- value: later stages add events (§8.2's BOOTSTRAP_CREDENTIAL_CONSUMED), and SQLite cannot
-- alter a CHECK without rebuilding the table — which a forward-only migration policy makes
-- expensive. Known events:
--   ACCEPTED, REJECTED, RENEWED, SUPERSEDED, REVOKED,
--   ENTERED_GRACE, ENTERED_EXPIRED, CLOCK_ANOMALY, BOOTSTRAP_CREDENTIAL_CONSUMED
--
-- `entitlement_serial` is NULLABLE and there is deliberately NO foreign key to
-- local_entitlement. A REJECTED event describes an artefact that was never accepted and so has
-- no ledger row, and an artefact rejected as Truncated or UnknownFormatVersion may have no
-- readable serial at all. An FK, or NOT NULL, would make the failure path unloggable — and the
-- failure path is exactly what a maintainer debugging a branch over the phone needs (§5.2).
--
-- `id` is INTEGER PRIMARY KEY AUTOINCREMENT rather than the TEXT ids used elsewhere in this
-- schema: AUTOINCREMENT guarantees strictly increasing, never-reused keys, which is what makes
-- this readable as an ordered log rather than a bag of rows.
-- ---------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS local_entitlement_audit (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  entitlement_serial TEXT,
  event              TEXT NOT NULL,
  reason_code        TEXT,
  detail_json        TEXT NOT NULL DEFAULT '{}',
  occurred_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  device_id          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_local_entitlement_audit_serial
  ON local_entitlement_audit (entitlement_serial, occurred_at);

CREATE INDEX IF NOT EXISTS idx_local_entitlement_audit_occurred
  ON local_entitlement_audit (occurred_at);


-- ---------------------------------------------------------------------------------------
-- §5.3 — replay guard
--
-- `fingerprint` is the SHA-256 of the exact payload blob, lowercase hex. It answers "have I
-- seen this artefact before?" locally and offline, which is the only place that question can
-- be answered when there is no cloud to ask.
--
-- `outcome` is unconstrained for the same reason `event` is above. Expected values:
--   ACCEPTED, REJECTED, SUPERSEDED_EXISTING
-- ---------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS local_activation_code_seen (
  fingerprint   TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  outcome       TEXT NOT NULL
);


-- ---------------------------------------------------------------------------------------
-- §5.3 — clock high-water mark: convention only, no schema change and NO SEEDED VALUE
--
-- The mark lives in the existing local_kv table under the key:
--
--     entitlement_clock_high_water
--
-- holding one ISO-8601 UTC timestamp in the migration-009 shape. This migration deliberately
-- does NOT insert it. Absence is the correct initial state and means "no corroborated floor
-- yet"; seeding it from the device clock at migration time would be precisely the defect the
-- 2026-08-16 amendment to §5.3 withdrew — a mark that anything can write is not a high-water
-- mark, it is a copy of the clock it was supposed to check.
--
-- Write rules, restated here because the writer is what makes or breaks both anomaly checks:
--   1. Only corroborated server time may advance it (a completed authenticated cloud exchange
--      via serverTime.js). The device's own clock never writes it.
--   2. The greatest `issued_at` among accepted entitlements is a floor. On a device that has
--      never synced, that floor IS the high-water mark.
--   3. Monotonic non-decreasing, persisted across restarts.
--   4. Never written from an unauthenticated or unsigned source — not an HTTP Date header, not
--      a file mtime, not an unverified sync payload, and not accepted_at/occurred_at above.
-- ---------------------------------------------------------------------------------------
