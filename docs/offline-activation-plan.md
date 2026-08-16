# Offline-First Activation — Implementation Plan

> **Provenance and status** (this block is the only addition; the plan body below is verbatim as
> approved on 2026-08-16).
>
> Approved by the maintainer 2026-08-16. Companion to `docs/offline-activation-design.md`, whose
> §14 decision register is the authority for *what* is built; this file is the authority for
> *in what order*.
>
> | Stage | Status |
> | --- | --- |
> | 0 — test-environment hygiene | **Closed 2026-08-16.** No action was needed: `local_device_assignment` measured empty (0 rows) across the live app-data profile and all four 2026-08-15 scratchpad copies. Nothing was deleted. See the re-measurement note in `docs/backlog-1.0.72.md` item 5. |
> | 1 — `entitlement.rs` pure core | **Complete 2026-08-16.** `src-tauri/src/entitlement.rs`, declared as `pub mod entitlement;` in `lib.rs` with no call sites. |
> | 2–10 | Not started. |
>
> **Two amendments made after this plan was approved — both supersede the text below:**
>
> 1. **Stage 1 crypto.** The plan's Stage 1 already named `ed25519-dalek`, which is what shipped
>    (2.2.0, plus `sha2` 0.10.9 for `device_binding_hash`). Its aside that "`minisign-verify`
>    stays reserved for future QR/tooling convenience" is **withdrawn** — that crate cannot
>    verify raw signatures at all, for structural reasons recorded in design §3.1. It has no
>    role in the activation path.
> 2. **Stage 4 disposable profile.** The plan's Stage 4 assumes a disposable profile exists.
>    **It does not.** `resolve_app_data_dir` (`src-tauri/src/local_db.rs:2056`) redirects only
>    when **both** `NODE_ENV=test` and `FROOZERP_ISOLATED_SQLITE_DIR` (absolute path) are set,
>    and `npm run app` sets neither — so dev runs against live app data. Any Stage 4 manual
>    walkthrough must set both explicitly, or it will exercise the real profile.

## Context

`docs/offline-activation-design.md` is the approved design (all 17 decisions ruled 2026-08-16).
The maintainer's Railway subscription lapsed, which permanently locked the maintainer's own
laptop out of offline login — device authorisation currently routes through the cloud, so a
lapsed backend bricks offline login on an already-provisioned device. That is unacceptable with
multiple branches in different locations.

This plan sequences the ruled design into implementation stages. Each stage is either a pure
addition (nothing existing can break) or a targeted fix to a defect already recorded in
`docs/backlog-1.0.72.md`. Stage 4 is the one that actually repairs the maintainer's laptop, and it
is placed early on purpose — everything after it is hardening, not repair.

No stage requires Railway. No stage touches `release/`, updater metadata, the signing password, or
`F:\FroozERP_recovery_backups\`. The hand-inserted `local_device_assignment` row in the disposable
profile is removed as a precondition, not fixed in application code (§11.3 of the design doc,
correction already recorded in backlog item 5).

Ruling references below (D-1 … D-17) are to the decision register in
`docs/offline-activation-design.md` §14.

---

## Stage 0 — Test-environment hygiene (no code)

Remove the hand-inserted `local_device_assignment` row from the disposable profile before any
later stage is tested against it. Confirm via `sqlite3` query that `local_device_assignment` is
empty again, matching the state of every real installation (backlog item 2's measurement).

**Testable:** `SELECT COUNT(*) FROM local_device_assignment` on the disposable profile returns 0.

---

## Stage 1 — Pure Rust entitlement core (`entitlement.rs`)

New file `src-tauri/src/entitlement.rs`. No database, no filesystem, no Tauri wiring — three pure
functions operating on bytes and timestamps:

```
parse_payload(bytes) -> Result<Payload, RejectReason>
verify(bytes, sig, trusted_keys) -> Result<Verified, RejectReason>
evaluate_state(verified, now, high_water) -> EntitlementState
```

- `Payload` matches design doc §4: `format_version`, `key_id`, `flags`, `company_id`, `branch_id`,
  `device_binding`, `entitlement_serial`, `issued_at`, `valid_days`, and (when the
  carries-credential flag is set) the bootstrap fields from §8.1 (`owner_username`, `owner_salt`,
  `owner_verifier`, `bootstrap_expires_at`).
- `TRUSTED_ACTIVATION_KEYS: &[(u8, [u8; 32])]` ships with **two slots populated** per D-2 — the
  current signing key plus a pre-generated, currently-unused "next" key — so a future rotation
  never requires devices to update before verifying new codes.
- `EntitlementState` enum: `Unprovisioned`, `Active`, `Grace`, `Expired`, `Revoked`,
  `ClockAnomaly`, `Malformed { reason }`. This is the entire policy surface in one type — nothing
  outside this module decides what a timestamp or a signature means.
- Verification uses `ed25519-dalek` directly on the raw payload bytes (both file and typed
  delivery carry the identical binary structure from §4, so there is no separate minisign
  envelope to unwrap — `minisign-verify` stays reserved for §5's future QR/tooling convenience if
  D-7 is revisited, not used on the hot path). Add `ed25519-dalek` to `src-tauri/Cargo.toml`.
- Clock anomaly logic (D-5): `evaluate_state` takes `now` and `high_water` as plain arguments —
  no global clock access inside the module — so every anomaly branch is directly unit-testable
  without mocking time.

**Testable:** `cargo check --manifest-path src-tauri/Cargo.toml` and `cargo test`, entirely inside
this module. Unit tests cover: valid signature → `Active`; tampered payload byte → rejected;
wrong `key_id` → rejected; expired `valid_days` → `Expired`; `expires_at ≤ now < grace_until` →
`Grace`; clock behind high-water beyond threshold → `ClockAnomaly`; clock ahead beyond threshold →
`ClockAnomaly` (D-5, both directions); unknown `format_version` → `Malformed`. Nothing else in the
app can be affected — this stage touches no existing file.

---

## Stage 2 — Migration `017_offline_entitlement_foundation.sql`

New file `src-tauri/migrations/sqlite/017_offline_entitlement_foundation.sql`, forward-only,
idempotent (`CREATE TABLE IF NOT EXISTS`), per `CLAUDE.md`. Adds three tables from design doc §5,
no changes to existing tables:

- `local_entitlement` — the append-mostly ledger (rows never deleted, only superseded/revoked).
- `local_entitlement_audit` — append-only event log (`ACCEPTED`, `REJECTED`, `RENEWED`,
  `SUPERSEDED`, `REVOKED`, `ENTERED_GRACE`, `ENTERED_EXPIRED`, `CLOCK_ANOMALY`,
  `BOOTSTRAP_CREDENTIAL_CONSUMED`).
- `local_activation_code_seen` — replay guard, keyed by SHA-256 of the payload blob.

Also documents (no schema change needed) the `local_kv` convention
`entitlement_clock_high_water` used by stage 1's `evaluate_state`.

**Testable:** run the migration against a disposable copy of `froozerp-local.sqlite3`, confirm the
three tables exist with the documented columns, run it a second time and confirm no error and no
duplicate rows (idempotency). Confirm every existing table and row is untouched (`local_*` table
counts before/after match).

---

## Stage 3 — Signing CLI + fixture set

A local-only binary, `src-tauri/src/bin/sign_activation.rs`, a separate `[[bin]]` target **not**
included in the release bundle (verified by checking `npm run build:windows` output does not
package it). Takes company/branch/device-id/validity/optional-bootstrap-credential arguments,
signs with the root private key read from a local file path (never bundled, never committed),
emits both the `.lic` file format and, for testing, raw payload+signature bytes.

Produces a fixture set exercising every rejection path stage 1 defined: valid, expired, wrong
key id, wrong device binding, malformed (bad `format_version`), truncated signature, unknown key
id, bootstrap credential present, bootstrap credential expired, bootstrap credential already
consumed (replay).

**Testable:** `cargo test` in `entitlement.rs` now runs against real signed bytes produced by the
CLI, not synthetic buffers — this is the first point where the actual signature format is
exercised end-to-end. Every fixture's expected `EntitlementState` / `RejectReason` is asserted.

---

## Stage 4 — Grandfathering, the localStorage-shadowing fix, and backlog items 3/4/5

**This is the stage that fixes the maintainer's laptop.** Concrete changes:

- `local_db.rs`: on `ensure_device_identity_with_preference_at`, if the device has exactly one
  approved `local_device_identity`, a cached reference snapshot with a real `user_profile`, and
  **no** `local_entitlement` row yet, insert one with `verification_state = 'LEGACY_GRANDFATHER'`,
  `source = 'LEGACY_UPGRADE'`, empty `signature_blob`, 400-day validity (D-15). Not exportable,
  cannot authorise provisioning another device, superseded on first real redemption.
- `frontend/src/local/offlineSession.js` (or a new sibling module, per `CLAUDE.md`'s "new logic
  belongs in `local/`, not `App.jsx`"): extract the credential-source precedence into a testable
  function — SQLite `offline_auth` wins over `localStorage`; a `localStorage` record naming a
  `device_id` absent from `local_device_identity` is discarded, not treated as authoritative.
  This is the exact bug from backlog item 5 (`App.jsx:3517`'s fallback to `readOfflineSession()`).
- `App.jsx:148` / `:249-256` — remove `DEFAULT_PRODUCTION_CLOUD_API_URL` as the desktop fallback;
  an unconfigured build resolves to `""` (backlog item 3).
- `App.jsx:226-232` and the `canonical-cloud-login` health probe — make `API_MODE=LOCAL_ONLY`
  authoritative over `connectivityMode` per D-16/backlog item 4 (option 1 from that item): it
  hard-blocks every cloud path, including the probe that currently fires at dead Railway even in
  `LOCAL_ONLY`. Remove or make explicit the silent `LOCAL_SINGLE_DEVICE` → `HYBRID` upgrade on
  desktop.
- `offlineSession.js:79` — `NO_SESSION` message stops instructing the user to do something
  impossible; interim wording until stage 5 lands the real recovery route.

**Testable:**
- `cargo test` covering the grandfathering insert logic in isolation (identity present, snapshot
  present but no entitlement → row inserted with correct fields; identity present but no snapshot
  → no row; entitlement already present → no duplicate).
- New `node:test` suite for the extracted precedence function (SQLite wins; unknown-device
  localStorage discarded; matching-device localStorage still honoured) — this is exactly the
  regression test for backlog item 5.
- Manual walkthrough (`npm run app`) against a copy of the maintainer's actual pre-upgrade
  profile, per `CLAUDE.md`'s "never install or launch the packaged app on the real laptop" —
  disposable copy only: confirm offline login succeeds with the stale localStorage record still
  present, confirm zero cloud calls are attempted under `LOCAL_ONLY` (connectivity audit shows
  `blocked=true`, `reachedCloud=false`, cloud-router invocations at 0 — the `CLAUDE.md` invariant),
  confirm an unconfigured build makes no request to the production URL.

---

## Stage 5 — File redemption path and activation screen

- New Tauri commands in `lib.rs`: `entitlement_status`, `entitlement_redeem`,
  `entitlement_import_file`, calling into `local_db.rs` functions
  (`accept_entitlement`, `active_entitlement`, `record_entitlement_audit`) which in turn call
  stage 1's pure `entitlement.rs` functions. The frontend never evaluates policy itself (design
  principle §2.3).
- New frontend surface: an activation screen shown before the login form whenever
  `entitlement_status` reports `Unprovisioned` — file picker for `.lic` import, plus the device's
  own `device_id` displayed for the phone-call round trip (D-9).
- Bootstrap Owner creation (D-11/§8.1-8.2): on first successful redemption of a code carrying a
  credential, create the local Owner account, force a password-change screen that blocks every
  other action, and on completion write a normal `offline_auth` record via the existing
  `cacheOfflineSession` path, set `bootstrap_consumed_at`, and log
  `BOOTSTRAP_CREDENTIAL_CONSUMED`.

**Testable:** end-to-end on a disposable, fully fresh profile (no `local_device_identity` at all):
redeem a stage-3 fixture `.lic` file, confirm device promoted to `approved` with correct
`company_id`/`branch_id`, confirm Owner login works fully offline with the bootstrap password,
confirm the forced password-change gate cannot be bypassed, confirm post-change login uses the
new password and the bootstrap credential is rejected with `BOOTSTRAP_CREDENTIAL_CONSUMED` on
replay, confirm the expired/wrong-device/malformed/truncated fixtures are all rejected with the
correct reason recorded in `local_entitlement_audit`.

---

## Stage 6 — Local promotion of `registration_status`; remove the two hardcoded "approved" defaults

- `local_db.rs`: accepting a verified (or grandfathered) entitlement promotes
  `local_device_identity.registration_status` locally. Remove the `"approved"` default in
  `cache_reference_snapshot_at` (`local_db.rs:2194`) — a snapshot omitting the field yields the
  device's existing status, never an upgrade.
- `App.jsx:3408` — remove the hardcoded `registration_status: "approved"` in the snapshot the
  desktop builds for itself.
- Cloud-side note carried into stage 9, not built here: `device-bootstrap-status` stops being a
  hard gate on a device whose local entitlement already says approved — it becomes advisory/
  reconciliation, since a locally-entitled device won't have registered with the cloud yet if it
  activated fully offline.

**Testable:** `cargo test` — fresh device with no entitlement stays `pending` through a full
snapshot round-trip. Run the **entire** local suite
(`node --test frontend/src/local/*.test.mjs`), not just touched files — `CLAUDE.md` flags that
several suites assert against `App.jsx` source text and this stage edits `App.jsx` structure.

---

## Stage 7 — State machine wiring, banners, never-stop-billing assertion

- New `frontend/src/local/entitlementState.js` — a pure mirror of stage 1's Rust
  `EntitlementState` logic (banner text, capability flags per state) so the frontend's
  presentation decision is testable per `CLAUDE.md` convention, not buried in `App.jsx`.
- Wire the state into the UI: persistent non-blocking `Grace` banner with days remaining;
  non-dismissible `Expired`/`Revoked` banners naming the state, date, and contact route;
  `ClockAnomaly`/`Malformed` hold whatever state the device previously had and log loudly
  (design doc §2.5, §9).
- Finalize `NO_SESSION` / no-entitlement copy now that the real recovery route (stage 5) exists.

**Testable:** `node --test` suite for `entitlementState.js` covering every transition in design
doc §9's table, **plus an explicit assertion that billing capability is `true` in every state
except `Unprovisioned`** — this is the invariant from design principle §2.2 and it should not be
possible to silently regress it. Manual UI smoke on a disposable profile with a crafted expired/
revoked/clock-skewed `local_entitlement` row: confirm banners render and billing still works.

---

## Stage 8 — Rework and land `CanonicalSnapshotScope`

Replaces `scratchpad/local_db-canonical-snapshot-scope.patch` (never landed as-is). Same
`canonical_snapshot_scope()` shape, but non-fatal with four rungs (design doc §6.4):

1. Active verified entitlement → `company_id`/`branch_id`.
2. Active `local_device_assignment` row → adds `operational_location_id`.
3. Approved `local_device_identity` → `branch_id` only.
4. Unscoped — current behaviour, permanently kept (D-6).

`DEVICE_SCOPE_CONFLICT` and `DEVICE_SCOPE_MISMATCH` become surfaced warnings that fall through to
the next rung rather than `?`-aborting the snapshot build.

**Testable:** `cargo test` covering all four rungs individually, plus the two former hard-error
paths now falling through instead of aborting. Manual disposable-profile walkthrough confirming
offline login still works with this patch applied — the exact scenario that broke when the
original shelved patch was tested 2026-08-15.

---

## Stage 9 — Cloud side: registration, renewal, revocation

Per D-2, no private key ever touches Railway, so "online registration" cannot mean on-demand
server-side signing. Concretely:

- `backend/server.js`: a new endpoint records pending device-registration requests (device id,
  company, branch) without signing anything.
- A local (maintainer-run) batch step — using stage 3's signing CLI — periodically signs
  entitlements for pending/renewing devices and uploads the resulting blobs.
- The cloud serves the right pre-signed blob to the right device on check-in (silent renewal) and
  delivers the revocation list through the existing sync pull — consulted only at next successful
  sync, never as a live gate, per the brief.
- Remove `POST /devices/activate`'s lookup-based approval (`server.js:9851`) and
  `hashActivationCode` (`server.js:609`) from the auth path. `activation_codes` table kept per
  D-17 for audit/seat history only.

**Testable:** backend `node:test` suite (matching the existing `backend/*.test.js` pattern, e.g.
`deviceSession.test.js`) for the new registration-request and blob-serving endpoints, and for
revocation delivery through the sync pull. `npm --prefix backend test` passes. No Railway contact
in any test — this stage is developed and tested entirely against a local Postgres instance,
consistent with the `CLAUDE.md` hard boundary.

---

## Stage 10 — Typed code input

Crockford Base32 input UI: auto-uppercase, auto-group into 5s, ambiguous-character folding
(I/L/O/U), per-group checksum, paste support. Carries **no bootstrap credential** (§8.1) — a
typed-code activation falls back to first-run local Owner setup instead.

**Testable:** `node --test` for the Base32 encode/decode/grouping/checksum logic in a new local
module. Manual UI test: type a stage-3 fixture code end to end, confirm it activates identically
to the file path minus the bootstrap credential, confirm the first-run Owner setup screen appears
in its place.

---

## Verification run before any release commit

Per `CLAUDE.md`, before proposing a release commit: `npm --prefix frontend run lint`,
`npm run build`, `npm run backend:check`, `npm --prefix backend test`,
`node --test frontend/src/local/*.test.mjs`, `cargo check --manifest-path src-tauri/Cargo.toml`.
Stages 1, 3, 6, 8 also require `cargo test` (not just `cargo check`) to exercise the entitlement
unit and fixture suites.

Stages 1–4 are worth completing regardless of how any remaining implementation detail shakes out
during the work — they are pure additions or direct fixes to defects already recorded in
`docs/backlog-1.0.72.md`, and stage 4 is the one the maintainer is actually blocked on.
