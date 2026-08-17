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
> | 2 — migration `017` | **Complete 2026-08-17.** Draft reviewed against design §5 and accepted unchanged; registered in `local_db.rs`. See the Stage 2 record at the end of this file. |
> | 3 — signing CLI + fixtures | **Complete 2026-08-17.** `src-tauri/tools/sign_activation.rs`, `.lic` format, fixture set, 23/23 round-trip tests against real signed bytes. Real root public keys baked into `TRUSTED_ACTIVATION_KEYS`. |
> | 4 — grandfathering, localStorage fix, backlog 3/4/5 | **Complete 2026-08-17.** The localStorage-shadowing fix and backlog items 3, 4 and 5 landed first; grandfathering (`grandfather_existing_device`, the `LEGACY_GRANDFATHER` shim) and migration `018` (`bootstrap_consumed_at`) landed in commit `b923a65`, closing the gap the original Stage 4 record described. |
> | 5 — `.lic` redemption, activation screen, bootstrap Owner | **Complete 2026-08-17.** Rust acceptance/state layer + four Tauri commands + `.lic` parser; frontend `entitlementState.js` (§9 mirror, pulled forward from Stage 7) + `bootstrapCredential.js`; App.jsx activation gate and forced-password-change flow. See the Stage 5 record at the end of this file. `registration_status` promotion and the two hardcoded "approved" removals stay in Stage 6. |
> | 6–10 | Not started. |
>
> **Parallel track:** `docs/auth-hardening-plan.md` (stages A-1 … A-6) scopes the auth debt. It
> is the gate on remote access and is independent of the stages below.
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

---

## Stage 2 record — completed 2026-08-17

### Outcome

`017_offline_entitlement_foundation.sql` **reviewed against design §5 and accepted with no
changes**, then registered in `local_db.rs`. Storage shape only: nothing reads these tables yet,
and `entitlement.rs` still has no call sites.

### Files changed

| File | Change |
| --- | --- |
| `src-tauri/src/local_db.rs` | `MIGRATION_017` const via `include_str!`; `apply_migration(..., "017_offline_entitlement_foundation", MIGRATION_017)` after 016; `CURRENT_SCHEMA_VERSION` → `017_offline_entitlement_foundation`; three migration-count assertions 15 → 16 |
| `docs/backlog-1.0.72.md` | New item 6 — unregistered migrations (`008` here, `006`/`007`/`008` on `main`) and the release-branch finding |
| `docs/offline-activation-plan.md` | Stage table row for Stage 2, and this record |

`017_offline_entitlement_foundation.sql` itself is **unmodified** — it was reviewed, not edited.

> **Scope note.** Stage 2 was briefed as "const + `apply_migration` call are the only changes to
> `local_db.rs`". Two further edits in that file proved mechanically necessary for `cargo test`
> to pass, and both are bookkeeping that tracks the migration count rather than design decisions:
>
> - `CURRENT_SCHEMA_VERSION` (`local_db.rs:9`). `status_at` reads the newest applied version from
>   `local_schema_migrations ORDER BY rowid DESC`, which becomes `017…` the moment 017 is
>   registered, and the test at `:4907` asserts that value equals `CURRENT_SCHEMA_VERSION`.
>   Leaving it at `016…` fails the test and makes the reported schema version wrong in
>   `LocalDbStatus`.
> - Three `assert_eq!(…, 15)` migration-count assertions (`:4916`, `:4978`, `:5097`) → `16`.
>
> Flagged rather than assumed: if the intent was that these stay untouched, Stage 2 cannot pass
> `cargo test`, and the two requirements need reconciling.

### Review of the draft against §5 — three points checked deliberately

All three choices are **correct and should stand**. Each was verified by execution, not by
reading alone.

1. **`local_entitlement_audit.entitlement_serial` nullable, no FK.** Agreed, and it is load-bearing.
   A `REJECTED` event for an artefact that was never accepted has no ledger row to reference, and
   an artefact rejected as truncated or unknown-version may have no readable serial at all. Either
   `NOT NULL` or an FK would make the failure path unloggable — and §5.2 exists precisely so a
   maintainer debugging a branch by phone gets a reason code. Verified: insert with
   `entitlement_serial = NULL` succeeds; insert naming a serial with no ledger row succeeds.

2. **`event` and `outcome` carry no CHECK.** Agreed. §8.2 already adds
   `BOOTSTRAP_CREDENTIAL_CONSUMED` beyond the §5.2 list, and SQLite cannot alter a CHECK without
   rebuilding the table, which forward-only migration policy makes expensive. A log that refuses a
   write because it does not recognise an event name is worse than one storing an unexpected
   string. Verified: an unknown future event name and an unknown outcome both insert cleanly.

3. **`verification_state` ↔ `signature_blob` CHECK, and Stage 4 grandfathering. Confirmed
   satisfiable.** §11.1 specifies grandfathered rows as `verification_state =
   'LEGACY_GRANDFATHER'`, `source = 'LEGACY_UPGRADE'`, **empty `signature_blob`** — exactly the
   branch the constraint permits. Verified by inserting the Stage 4 shape directly:

   | Insert | Result |
   | --- | --- |
   | `VERIFIED` + 64-byte signature + non-empty payload | accepted |
   | `VERIFIED` + 63-byte signature | rejected |
   | `VERIFIED` + empty signature | rejected |
   | `VERIFIED` + empty payload | rejected |
   | `LEGACY_GRANDFATHER` + empty signature + **empty** payload | **accepted** |
   | `LEGACY_GRANDFATHER` + empty signature + non-empty payload | accepted |
   | `LEGACY_GRANDFATHER` + 64-byte signature | rejected |
   | unknown `verification_state` | rejected |

   The one implementation constraint Stage 4 must respect: `payload_blob` is `BLOB NOT NULL`, and
   the `LEGACY_GRANDFATHER` branch does not exempt it. A grandfathered row has no signed payload,
   so Stage 4 must bind an **empty** blob (`X''`), never `NULL`. Both empty and non-empty payloads
   are accepted on that branch, so the constraint does not over-specify the shim.

### Verification — disposable profile only

**No live app-data profile was opened, and none exists in this environment.** The maintainer's
`froozerp-local.sqlite3` lives under `%APPDATA%/com.srtcompany.froozerp/` on the Windows laptop;
`*.sqlite3` is gitignored and no such file is present anywhere on this container. The plan's own
Stage 4 amendment is the reason this is stated explicitly: `npm run app` runs against live app
data, so "which file was opened" is never left to inference.

The disposable profile was therefore **constructed, not copied** — built by replaying migrations
`001`–`016` in the exact order and with the exact version strings `local_db.rs` uses, through a
faithful re-implementation of `apply_migration` (skip-if-`APPLIED`, `execute_batch`, record
version + checksum + status). `008` was deliberately excluded, matching real devices (backlog
item 6).

- Disposable database: `<session scratchpad>/disposable-froozerp-local.sqlite3`
- Harness: `<session scratchpad>/verify_017.mjs`

Both are session-scratchpad artefacts, outside the repo and outside app data. Nothing under
`release/` or `F:\FroozERP_recovery_backups\` was touched; no production or Railway contact; no
signing password; the packaged app was never installed or launched.

**Results — all checks passed:**

| Check | Result |
| --- | --- |
| Three tables exist with §5 columns | `local_entitlement` 19/19, `local_entitlement_audit` 7/7, `local_activation_code_seen` 3/3 — no missing, no extra |
| Three indexes exist | `idx_local_entitlement_active`, `idx_local_entitlement_audit_serial`, `idx_local_entitlement_audit_occurred` — exactly three |
| Second run is a no-op | version already `APPLIED` → skipped, no error |
| No duplicate rows | exactly one `local_schema_migrations` row for `017` after two runs |
| SQL body independently re-runnable | raw re-execute outside the version gate succeeds (`CREATE … IF NOT EXISTS`) |
| Pre-existing `local_*` row counts unchanged | 23 data tables compared, all identical before/after |
| Migration ledger | `local_schema_migrations` 15 → 16; newest row `017_offline_entitlement_foundation` / `APPLIED` |
| Only expected tables added | exactly the three §5 tables |
| New tables start empty | yes |
| `local_kv` high-water row | **absent** — 0 rows for `entitlement_clock_high_water`, the correct initial state per the §5.3 amendment |

### Gate results

| Gate | Result |
| --- | --- |
| `cargo check --manifest-path src-tauri/Cargo.toml` | **Pass** (3 pre-existing `dead_code` warnings) |
| `cargo test` | **58 passed, 3 failed — identical to the clean-tree baseline.** No new failure. |
| `npm --prefix frontend run lint` | **Pass** — 0 errors, 37 pre-existing warnings in `App.jsx` (untouched) |
| `npm run backend:check` | **Pass** |
| `node --test frontend/src/local/*.test.mjs` | **123/123 pass** under `TZ=Asia/Kolkata` |

Two environment caveats, both confirmed pre-existing and unrelated to this stage:

- The 3 `cargo test` failures (`isolated_sqlite_override_is_absolute_and_test_only`, and two
  `local_backend_lifecycle_tests`) hard-code Windows paths (`C:\…`, `F:\…`), which are not
  absolute on Linux. They can only pass on Windows, the only shipped target. Verified by running
  the suite on a stashed (clean) tree: the same 3 fail, and registering `017` adds none.
- The local suite shows 5 failures under the container's UTC clock, all timezone-dependent
  (`reportRefresh.test.mjs`, India calendar boundary). Under `TZ=Asia/Kolkata` the full suite is
  123/123 green.

`cargo check` additionally required installing Linux GTK/WebKit dev packages
(`libgtk-3-dev`, `libwebkit2gtk-4.1-dev`, `libsoup-3.0-dev`) into the container, absent from the
base image. Container-local only; no repository or dependency-manifest change.

### Decisions the documents did not already rule

One, and it is for Stage 5 rather than Stage 2 — recorded here so it is not rediscovered late:

- **`bootstrap_consumed_at` is required by §8.2 but absent from the §5.1 table listing, and so
  absent from `017`.** §8.2 states plainly that "`local_entitlement` gains a
  `bootstrap_consumed_at` column", and the Stage 5 bootstrap-credential flow depends on it to make
  the credential single-use. §5.1's column list — which Stage 2 was scoped to implement verbatim —
  does not include it. The draft follows §5.1, which is the right call for this stage.

  Not a defect and not a blocker: under forward-only policy the column arrives as an
  `ALTER TABLE … ADD COLUMN` in a later migration, which is cheap in SQLite and needs no table
  rebuild. It needs an explicit owner, though — either §5.1 is amended and `017` is revised
  *before it is applied anywhere*, or Stage 5 carries an `018`. Recommend the latter: `017` is now
  registered and must be treated as immutable.

No ruled decision (D-1 … D-17) was reopened, and both 2026-08-16 amendments were honoured — the
§5.3 clock rule is why the migration seeds no `entitlement_clock_high_water` value, and the §3.1
crypto ruling is why the CHECK pins a signature at exactly 64 raw bytes rather than a minisign
envelope.

---

## Stages 3 and 4 record — 2026-08-17

### Stage 3 — complete

`src-tauri/tools/sign_activation.rs` (signing CLI, `sign` and `pubkey` subcommands), the `.lic`
container, a fixture set covering every rejection path, and `tests/activation_roundtrip.rs`.

`cargo test --test activation_roundtrip`: **23 passed, 0 failed.** This is the first point at
which the signature format met bytes the signer actually produces — Stage 1's 33 tests used
synthetic buffers. Includes the §2.2 invariant (no fixture outcome denies billing) and that
winding the clock back does not extend an entitlement.

Bundle exclusion verified against tauri-cli 2.11.2 source in three independent layers:
`required-features` makes `get_binaries` skip the bin because it tests `options.features` (the
`--features` command line, not Cargo defaults); the source lives in `tools/` so the `src/bin`
rescan cannot re-add it; and `build:windows` passes no `--features`.

**Root keypairs generated (D-3).** On the maintainer's machine, never here. Public halves are in
`TRUSTED_ACTIVATION_KEYS`; private seeds are encrypted with a paper backup and never entered the
repo, CI or any cloud host. Each public key was verified three ways before being committed:
SHA-256 against the generator's printed checksum, validity as an Ed25519 curve point, and — the
decisive one — the Rust CLI's `pubkey` subcommand deriving the identical bytes from the seed.

### Stage 4 — partially complete, and the gap matters

**Done:** the localStorage-shadowing fix (new `frontend/src/local/offlineCredentialSource.js`,
wired into `continueOffline`), the `NO_SESSION` wording, and backlog items 3 and 4 (cloud-target
fallback and LOCAL_ONLY gating), plus the pre-existing gateway breach in backlog item 7c.

**Verified in the real application on a disposable profile:** the maintainer's laptop signs in
offline with the stale `localStorage` record still present. Isolation was proven by file
timestamp, not assumed — `F:\froozerp-disposable\froozerp-local.sqlite3` written minutes before,
the live `%APPDATA%` profile untouched four days earlier. A full profile backup was taken first.
Connection status showed `Cloud Backend Paused` / `Sync Paused` with no cloud contact. The
maintainer reported the `cloud-request-audit.jsonl` check clean; that output was not observed
directly by the agent and is recorded on their word.

Two observations from the walkthrough, both expected and neither a regression:
- **`App Mode: Hybrid`** despite `legacyDesktopLocalMode` being removed — the profile has an
  explicitly saved mode, and saved config outranks defaults. The removal only changes the
  *unconfigured* case.
- **"Unable to load branch and device assignments"** — that panel calls the cloud
  `/api/v3/admin/scope-management`. It was already failing with Railway down; it now fails as a
  named refusal with no outbound request. Branch and device management is cloud-side by design.

> **NOT BUILT — grandfathering.** Stage 4's first bullet specifies inserting a
> `LEGACY_GRANDFATHER` / `LEGACY_UPGRADE` row with 400-day validity (D-15) when a device has one
> approved identity, a cached snapshot, and no entitlement. **No such code exists.** Migration 017
> created the table and the CHECK constraint was confirmed to admit the shim's shape, but nothing
> writes it.
>
> This did not block the laptop repair — that was the localStorage fix, which is independent — so
> the stage's headline goal is met. But every existing device still has **zero** rows in
> `local_entitlement`, so `entitlement_status` will report `Unprovisioned` for all of them the
> moment Stage 5 wires it up. Grandfathering must land with or before Stage 5, or upgrading
> devices will meet an activation screen instead of their app, which §11.1 exists specifically to
> prevent.

### Next

Stage 5 (`.lic` redemption, activation screen, Tauri commands) — **carrying the grandfathering
work with it**, and the first stage to exercise the real keys end to end.

---

## Stage 5 record — completed 2026-08-17

The `.lic` redemption path, the activation screen and the bootstrap Owner flow. Grandfathering had
already landed in Stage 4's commit `b923a65`, so this stage did not have to carry it.

### Files changed

| File | Change |
| --- | --- |
| `src-tauri/src/activation.rs` | **New.** `parse_lic(text) -> Result<(payload, signature), String>` for the §7.2 container (ignores `#`/blank lines, reads `format`/`payload`/`signature`, rejects wrong format, missing fields, bad base64) plus a standard padded `base64_decode`. Declared `pub mod activation;` in `lib.rs`. 7 unit tests. |
| `src-tauri/src/local_db.rs` | The four §6.2 functions — `accept_entitlement`, `active_entitlement`, `entitlement_state`, `record_entitlement_audit` — plus `consume_bootstrap` and `_at` helpers. Acceptance verifies the exact bytes against `TRUSTED_ACTIVATION_KEYS`, checks device binding, dedupes on the payload SHA-256 fingerprint, supersedes any prior live row (including a grandfather shim), and logs `ACCEPTED`/`REJECTED`/`SUPERSEDED`. State derivation re-verifies a `VERIFIED` row through `entitlement::evaluate_state`, evaluates a `LEGACY_GRANDFATHER` shim from its stored day-numbers under the same clock rule, and reports `Revoked` from `revoked_at`. Day arithmetic uses SQLite `julianday`/`strftime` anchored at 2020-01-01 to stay consistent with `entitlement::DAY_EPOCH`. 5 unit tests. |
| `src-tauri/src/lib.rs` | Four commands — `entitlement_status`, `entitlement_redeem`, `entitlement_import_file`, `entitlement_consume_bootstrap` — registered in `generate_handler!`. |
| `frontend/src/local/entitlementState.js` (+ test) | Pure mirror of the design §9 state table (pulled forward from Stage 7 at the maintainer's request): `capabilitiesForState`, `billingAllowed`, `holdsPreviousState`, `bannerForState`. The test iterates **every** state asserting `billingAllowed(state) === (state !== "Unprovisioned")` — the §2.2 invariant, defined directly rather than derived from capabilities so `ClockAnomaly`/`Malformed` still bill. |
| `frontend/src/local/bootstrapCredential.js` (+ test) | `verifyBootstrapCredential` / `deriveBootstrapVerifier` (§8.2). PBKDF2 is byte-identical to `offlineSession.deriveVerifier`, with the salt string fed to PBKDF2 being `base64(saltBytes)`. |
| `frontend/src/local/localDatabase.js` | Wrappers: `getEntitlementStatus`, `redeemEntitlement`, `importEntitlementFile`, `consumeBootstrapCredential`. |
| `frontend/src/App.jsx` | Fetches entitlement status once the device identity resolves; renders an **ActivationGate** (device-ID display + `.lic` file import) when the shell reports `Unprovisioned`, and a **BootstrapOwnerSetup** forced-password-change flow that writes a normal `offline_auth` record via `cacheOfflineSession` and then consumes the bootstrap credential (§8.2). The frontend never evaluates policy — it renders what Rust reports (§2.3). |

### Decisions this stage owned

- **Bootstrap credential KDF (§8.1/§8.2 left it to Stage 5).** Chosen to reuse the existing offline-session PBKDF2 exactly: `verifier = PBKDF2-SHA256( UTF8(username_lower::password), salt = UTF8(base64(saltBytes)), 150000, 32 bytes )`. No new crypto primitive was invented; the signed bytes stay verifier-only (never a password), as §8.2 requires. **Do not pass the raw salt bytes to PBKDF2** — the salt fed to the KDF is the UTF-8 bytes of the base64 *string*, an `offlineSession.js` convention. Getting that wrong yields a well-formed verifier that simply never matches, and the symptom appears on a branch machine as "the temporary password is wrong" with nothing to debug.
- **`scripts/make-bootstrap-credential.mjs` (new) closes the §8.2 recommendation** that the tooling auto-generate a high-entropy temporary password rather than defaulting to something memorable. It prints the password, `salt-hex`, `verifier-hex` and a ready-to-paste `sign_activation` command line (`npm run bootstrap:credential -- --username owner`). It reads no private key and signs nothing. The password is 100 bits drawn from Crockford base32 (no I/L/O/U) in dash-separated groups of four, because §8.2 expects it to be dictated on a phone call. Its PBKDF2 is a **deliberately independent** implementation (`node:crypto`) from the app's (`WebCrypto`), following the reasoning `sign_activation.rs` gives for not sharing its encoder with `entitlement.rs`; `frontend/src/local/bootstrapCredentialTooling.test.mjs` asserts the two agree and runs in the ordinary local suite, so the tool is not the one link in this chain without a gate.
- **Trusted keys are a parameter, not a constant, inside `accept_entitlement_at`/`entitlement_state_at`** — mirroring `entitlement::verify`, so tests sign with a throwaway key and never touch production key material.
- **`consume_bootstrap` is set-once** — it never overwrites an existing `bootstrap_consumed_at`, because clearing it would re-open a single-use credential.

### Deliberately left for Stage 6 (not done here)

- `local_device_identity.registration_status` is **not** promoted on acceptance, and the two hardcoded `"approved"` defaults (`App.jsx` self-built snapshot, `cache_reference_snapshot_at`) are **not** removed. The activation screen clears off entitlement state, not `registration_status`, so redemption is already functional without it. Promotion + the removals are Stage 6 per the plan.

### Gate results (lead, on the integrated tree)

| Gate | Result |
| --- | --- |
| `cargo test --lib` | **73 passed / 3 failed** — the 3 are the pre-existing Windows-path tests (`isolated_sqlite_override_is_absolute_and_test_only`, two `local_backend_lifecycle_tests`); +12 new over the 61 baseline. |
| `cargo test --test activation_roundtrip --features signing-cli` | **23 / 23.** |
| `cargo check` | Clean (pre-existing-style `dead_code` warnings only). |
| `npm --prefix frontend run lint` | 0 errors, 37 pre-existing warnings. |
| `npm run build` | Pass. |
| `npm run backend:check` | Pass. |
| `npm --prefix backend test` | 114 / 115 (pre-existing test-102 path assertion). |
| `TZ=Asia/Kolkata node --test frontend/src/local/*.test.mjs` | **192 / 192** (+30 over the 162 baseline). |

### End-to-end check actually performed here

The whole credential chain was exercised on this container with the **TEST-ONLY fixture key**, never
a real seed: `make-bootstrap-credential` generated a password/salt/verifier → `sign_activation`
signed a real `.lic` carrying them → the §4 bootstrap tail was decoded back out of the signed
payload bytes → the app's own `verifyBootstrapCredential` accepted the generated password and
refused a wrong one. The salt and verifier recovered from the signed payload matched the generator's
output byte for byte. That covers every hop except the Tauri/Windows UI itself.

### Not verified here

The App.jsx activation gate and bootstrap login were **not** exercised in the real desktop app — this Linux container has no Windows Tauri runtime, and per `CLAUDE.md` the packaged app is never launched on the real laptop. The pure pieces (state mirror, bootstrap KDF, `.lic` parser, acceptance/state SQL) are covered by unit tests; the App.jsx wiring is lint- and build-clean but wants a disposable-profile walkthrough on Windows before release.
