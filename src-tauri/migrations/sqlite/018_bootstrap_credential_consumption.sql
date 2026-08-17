-- Bootstrap credential consumption marker (design doc §8.2).
--
-- Why this is a separate migration rather than a change to 017: §5.1's column list — which
-- Stage 2 implemented verbatim — omits `bootstrap_consumed_at`, but §8.2 requires it, and
-- 017 has already been applied. Migrations are forward-only and never edited once applied
-- (CLAUDE.md), so the column arrives by ALTER TABLE here. In SQLite an ADD COLUMN with no
-- default is an O(1) catalogue change, not a table rebuild.
--
-- Idempotent across restarts by version-gating in apply_migration(), which skips any version
-- already recorded APPLIED in local_schema_migrations. Note that SQLite has no
-- `ADD COLUMN IF NOT EXISTS`, so this file is NOT safe to execute twice against the same
-- database on its own — the version gate is what makes it idempotent in practice, exactly as
-- it is for every other ALTER-bearing migration in this directory.
--
-- WHAT THIS COLUMN MEANS (§8.2). The bootstrap Owner credential carried in a `.lic` file is
-- single-use as a matter of **local policy, not cryptographic revocation**. The signed bytes
-- stay forever verifiable; what stops working is this device's willingness to accept them a
-- second time. The first successful login using the bootstrap credential must:
--
--   1. force the password-change flow before any other screen is reachable,
--   2. on completion write a normal offline_auth record under the NEW password through the
--      existing cacheOfflineSession path,
--   3. set `bootstrap_consumed_at`,
--   4. record BOOTSTRAP_CREDENTIAL_CONSUMED in local_entitlement_audit,
--
-- and from that point the app must never compare against the payload's original verifier
-- again. A later attempt is rejected with a distinct BOOTSTRAP_CREDENTIAL_CONSUMED code, NOT
-- folded into INVALID_CREDENTIALS — a maintainer debugging a branch by phone needs to know
-- which of the two happened.
--
-- NULL means "not consumed". A timestamp means "consumed, never accept the payload verifier
-- again". It is set once and never cleared: clearing it would re-open a credential the design
-- describes as single-use, so no code path may write NULL back over a timestamp.

ALTER TABLE local_entitlement ADD COLUMN bootstrap_consumed_at TEXT;

-- Finding the unconsumed bootstrap row is a login-path question, so it gets an index rather
-- than a scan. Partial, because a consumed row is never a candidate again and history is kept
-- forever (§5.1 rows are never deleted).
CREATE INDEX IF NOT EXISTS idx_local_entitlement_bootstrap_pending
  ON local_entitlement (device_id, issued_at DESC)
  WHERE bootstrap_consumed_at IS NULL
    AND superseded_at IS NULL
    AND revoked_at IS NULL;
