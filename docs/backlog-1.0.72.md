# 1.0.72 Backlog

Items deferred out of 1.0.71. Nothing here is implemented.

---

## 1. `purchase_bill_status` is dropped during sync, so provisional costs are indistinguishable from real ones

**Status:** open, not started. Logged 2026-08-15.
**Severity:** correctness / reporting. Understates stock valuation silently.

### The gap

`local_inventory_lots` has no `purchase_bill_status` (or equivalent cost-status) column.

The cloud side tracks it properly — `inventory_batches.purchase_bill_status` is `BILL_PENDING`
until the bill is completed, and the API derives
`costStatus: PROVISIONAL | FINAL` from it (`backend/server.js:5048`, `:18058`).

The SQLite sync arm for `inventory_lot` (`src-tauri/src/local_db.rs:3803`) maps
`batch_status → status` and drops `purchase_bill_status` entirely. `cost_rate` is taken from
`effective_cost_per_unit ?? purchase_rate ?? 0.0` (`local_db.rs:3876`) with no record of whether
that number is provisional.

Consequence: the desktop cannot tell a provisional `cost_rate = 0` from a genuine one.
`frontend/src/local/dashboardSnapshot.js:37` multiplies it straight into stock value, so a
pending-bill lot contributes ₹0 of value while presenting as ordinary stock. The stock
valuation reads as authoritative when part of it is unpriced.

This is the "errors must never render as zero" failure mode from `CLAUDE.md` — the number is
not wrong-looking, it is quietly incomplete.

### How lots reach `cost_rate = 0`

Not a bug in the backfill. The backfill works:

- Arrival with a pending bill books `provisionalCost = Number(entry.expectedPurchaseRate || 0)`
  into both `purchase_rate` and `effective_cost_per_unit` (`server.js:16551`, `:16591`).
  `expected_purchase_rate` is parsed with `parseNonNegativeNumber` and the validator at
  `:16191` only rejects `null` — **zero is an accepted expected rate**.
- `POST /purchase/:id/complete-bill` / `POST /api/v3/purchases/:id/complete-bill`
  (`server.js:17693-17694`) overwrites `purchase_rate` and `effective_cost_per_unit` with
  `financials.effectiveCostPerUnit` (`:17630`), sets `BILL_COMPLETED`, zeroes
  `temporary_sale_rate`, then restates already-made sales via
  `sale_batch_allocations` + `recalculateSalesForBatch` (`:17652-17656`).
- That correction reaches SQLite through the normal change-log pull —
  `ON CONFLICT(id) DO UPDATE SET cost_rate = excluded.cost_rate` (`local_db.rs:3848`).
  There is no separate backfill job.

So a zero `cost_rate` means the bill is genuinely still open, not that sync failed.

### Related trap: the `PENDING-` prefix is not a state flag

Lot numbers are minted as `PENDING-${Date.now()}-${purchase.id}` (`server.js:16582`, `:16957`),
and the completion `UPDATE` at `:17630` **does not rewrite `batch_no`**. The prefix therefore
survives bill completion forever.

Measured on the 2026-08-15 device snapshot: 49 lots carried a `PENDING-` prefix, of which 39
already had a nonzero `cost_rate`. Any logic that treats the prefix as "bill outstanding" will
be wrong about ~80% of those rows. Do not filter on it.

### Proposed direction (not agreed, not implemented)

1. Carry `purchase_bill_status` through the `inventory_lot` sync arm into a new
   `local_inventory_lots` column, via a forward-only idempotent migration under
   `src-tauri/migrations/sqlite/`.
2. Surface a distinct provisional-cost state in `resolveInventoryPresentation` rather than
   letting a provisional lot render as ordinary priced stock.
3. Exclude — or separately subtotal — provisional lots in stock valuation so the headline
   figure is not silently short. A visible "N lots awaiting bill" indicator beats a wrong total.
4. Consider whether `expected_purchase_rate = 0` should be rejected at entry
   (`server.js:16191`). Deferred: zero may be legitimate for gifted or sample stock.

Steps 1–2 are the minimum that makes the condition visible. Step 3 changes a number the owner
reads daily and should be decided explicitly.

### Reproduction case

All application data on this device is **disposable test/sample data**. The seven zero-cost
lots are deliberately being left exactly as they are, so they remain a live reproduction of
this gap. Do not complete those bills, and do not "fix" the data — clearing them destroys the
only standing repro.

Measured 2026-08-15 from the device DB
(`%APPDATA%/com.srtcompany.froozerp/froozerp-local.sqlite3`, read from a copy, source
untouched). These figures are stable and usable directly as a test fixture:

- 70 lots total, all `sync_status='synced'`, no soft deletes, no orphan `product_id`,
  no whitespace/NULL/empty `product_id`.
- 7 ACTIVE lots holding **215.550 units** have `cost_rate = 0`, i.e. **18.2%** of the
  1183.550 units on hand contribute ₹0 to the ₹282,275.00 stock valuation.
- 41.45 units have already been sold from those zero-cost lots (~₹12,890 at sample sale
  rates), costed at zero and therefore booked as 100% margin. This makes the lots a useful
  repro for the sale-restatement path too: completing a bill triggers
  `recalculateSalesForBatch` and would restate that margin.
- Oldest open arrival dated 2026-06-11.

A fix should be validated against these numbers rather than by mutating them.

---

## 2. Uncommitted `CanonicalSnapshotScope` work breaks offline login on every existing profile

**Status:** open, **blocking — must be fixed before it lands**. Logged 2026-08-15.
**Severity:** availability. No device without an assignment row can sign in offline.

### The defect

The uncommitted `local_db.rs` change adds `canonical_snapshot_scope()`, which the reference
snapshot builder calls and propagates unconditionally:

```rust
// local_db.rs:2707 (uncommitted)
let canonical_scope = canonical_snapshot_scope(&conn, requested_device)?;
```

It requires exactly one row satisfying `local_device_assignment.active = 1` joined to an
approved `local_device_identity`. With none, it returns:

```
DEVICE_SCOPE_UNAVAILABLE: No active approved canonical device assignment
                          exists in the local snapshot
```

The `?` aborts the whole snapshot build, and the frontend surfaces
`LOCAL_SNAPSHOT_LOAD_FAILED` — "Saved offline data could not be loaded" — on the login
screen. Offline sign-in becomes impossible.

### Why this is not theoretical

`local_device_assignment` is **empty in every database on the maintainer's machine**:

| Database | `local_device_identity` | `local_device_assignment` |
| --- | --- | --- |
| Live app DB (untouched) | 3 rows (1 approved) | **0 rows** |
| `profiles/roaming` (pre-upgrade 1.0.70) | 3 rows (1 approved) | **0 rows** |
| `failed-1.0.71-state/roaming-profile` | 3 rows (1 approved) | **0 rows** |

Approved device identities exist; assignment rows do not. So the new precondition is
satisfied by *no* real profile, and the failure is total rather than an edge case.

Reproduced 2026-08-15 by running `npm run app` with the change applied: the app reached the
login screen and refused every offline sign-in with `LOCAL_SNAPSHOT_LOAD_FAILED`. Reverting
`local_db.rs` to HEAD restored offline login. The change is shelved at
`scratchpad/local_db-canonical-snapshot-scope.patch`.

### Required direction

Fix it before landing — **do not work around it in the environment**, and do not create
assignment rows to satisfy the check. A snapshot builder should not fail closed on scope
metadata that no shipped profile has ever populated. Options, in order of preference:

1. Make the scope lookup non-fatal: fall back to unscoped snapshot behaviour when no
   assignment exists, and scope only when one does. Preserves upgrade compatibility.
2. If scope must be mandatory, ship a migration that backfills `local_device_assignment`
   from the approved `local_device_identity` row first, and gate the strict check on that
   migration having run.

Whichever is chosen, offline login must keep working for a device that has an approved
identity but no assignment — that is the state every existing installation is in.

### Related

`DEVICE_SCOPE_CONFLICT` (more than one active assignment) and `DEVICE_SCOPE_MISMATCH`
(requested device differs from the canonical one) are emitted from the same function and
share the same fail-closed path. Both need the same review.

---

## 3. Desktop shell falls back to a hardcoded production cloud URL when no cloud is configured

**Status:** open, not started. Logged 2026-08-15.
**Severity:** safety. This is the mechanism by which accidental production contact happens.

### The defect

`frontend/src/App.jsx:249-256`:

```js
const CLOUD_API_URL = normalizeApiBase(
  RAILWAY_PRODUCTION_API_URL ||
  ISOLATED_LOOPBACK_CLOUD_API_URL ||
  canonicalizeCloudApiUrl(SAVED_API_CONFIG.cloudApiUrl) ||
  import.meta.env.VITE_CLOUD_API_URL ||
  window.__FROOZERP_CLOUD_API_URL__ ||
  (isDesktopShell() ? DEFAULT_PRODUCTION_CLOUD_API_URL : "")   // <-- App.jsx:148
);
```

When every earlier rung resolves empty, a desktop build silently adopts the hardcoded
production URL `https://froozerp-production-27bb.up.railway.app`.

**A build with no cloud configuration should contact nothing.** Defaulting to production is
the opposite of failing safe: the less configuration a machine has, the more likely it is to
reach production.

### Observed 2026-08-15

A dev profile was cleaned up by clearing a stale `froozerp.apiConfig` (which had pinned a dead
loopback rehearsal URL) and blanking `VITE_CLOUD_API_URL`. Removing *all* cloud configuration
did not stop cloud calls — it **escalated** them, because emptying the upper rungs exposed the
hardcoded fallback. The dev app then issued live `canonical-cloud-login` health checks against
production. They failed at `NO_NETWORK` and nothing reached Railway, but the attempt was real
and would connect on a working network.

Note the Railway subscription has lapsed, so that host may no longer exist — an unconfigured
build is retrying a dead production endpoint on every login.

### Required direction

The desktop fallback must be `""`, not a production URL. No cloud configured means no cloud
target. If a default is genuinely wanted for packaged production builds, it must come from
build-time release configuration that dev builds never inherit — not from a module constant
that any empty config chain lands on.

---

## 4. `API_MODE=LOCAL_ONLY` does not gate cloud calls, so the name promises a guarantee it does not give

**Status:** open, not started. Logged 2026-08-15.
**Severity:** correctness of a safety control. The label misrepresents the behaviour.

### The defect

`API_MODE` and `connectivityMode` are separate axes. Setting `VITE_API_MODE=LOCAL_ONLY` does
**not** suppress the `canonical-cloud-login` health check — verified 2026-08-15, the check
fired against production with the mode already set to `LOCAL_ONLY`:

```
health-check-start {"apiUrl":"https://froozerp-production-27bb.up.railway.app",
                    "endpoint":".../api/health","reason":"canonical-cloud-login"}
```

Only the connectivity policy actually blocks cloud access. What stopped it was setting the
authoritative backend policy (`PUT /api/cloud/internet-access` with
`allowInternetAccess: false` -> `status: LOCAL_ONLY`, persisted to
`cloud-network-policy.json`), not the API mode.

A second, related trap in the same area: `App.jsx:226-232` silently upgrades
`API_MODE=LOCAL_SINGLE_DEVICE` (and `BRANCH_LAN_SERVER`) to `HYBRID` whenever
`isDesktopShell()` is true. So a reader configuring a "local single device" desktop build gets
cloud-capable HYBRID instead.

### Why this matters beyond naming

`CLAUDE.md` states the LOCAL_ONLY invariant as `blocked=true`, `reachedCloud=false`, zero
cloud-router invocations, zero external connections. A mode literally named `LOCAL_ONLY` that
does not deliver that invariant will be trusted to and will eventually be relied on in the
wrong place.

### Required direction

Pick one, do not leave it ambiguous:

1. Make `API_MODE=LOCAL_ONLY` authoritative over `connectivityMode` so the name is true, and
   have it hard-block every cloud path including `canonical-cloud-login`; or
2. Rename it (e.g. `LOCAL_PREFERRED`) so it stops implying a guarantee, and document that
   `cloud-network-policy.json` / `connectivityMode` is the only real kill switch.

Whichever is chosen, the desktop `LOCAL_SINGLE_DEVICE` -> `HYBRID` upgrade at `App.jsx:226`
needs to be either removed or made explicit in the mode's documented meaning.

---

## 5. A dead or lapsed backend permanently bricks offline login on a device that has no cached credential

**Status:** open, not started. Logged 2026-08-15.
**Severity:** availability, and it contradicts the local-first claim.

### The defect

Offline login is only possible if a device already holds a cached credential. With no cached
record, `offlineSession.js:79` returns:

```
NO_SESSION — "This device must connect to the internet once before offline use."
```

That instruction is unsatisfiable when the cloud backend is gone. The maintainer's Railway
subscription has lapsed, so `froozerp-production-27bb.up.railway.app` may no longer exist. A
device in that state can never complete the one online login that would provision it, and can
therefore never log in again — offline or online.

There is no local escape hatch. Local `/login` on the desktop gateway returns **HTTP 503**
(verified 2026-08-15): login is proxied to the cloud, and LOCAL_ONLY blocks it. So the only
authentication path on a fully local, local-first product depends on a remote service being
alive.

### Scope of the failure

Two distinct populations:

1. **Never provisioned** (no `offline_auth::*` row in `local_kv`) — permanently locked out the
   moment the backend dies. Unrecoverable without a local provisioning path.
2. **Previously provisioned** — survives, because the credential is cached in SQLite at
   `local_kv` key `offline_auth::<device_id>::<username_lower>` (verifier + salt), independent
   of the cloud.

The maintainer's device is in population 2 and is **not** bricked. What made it look bricked
was a different bug, below.

### Contributing bug: stale localStorage shadows the valid SQLite credential

`App.jsx:3487-3499` prefers `snapshot.offline_auth` but falls back to `readOfflineSession()`
from localStorage, then compares `session.deviceId` against `latestDevice.device_id` resolved
from SQLite (`App.jsx:3493`).

Observed state on this machine:

| Source | username | deviceId |
| --- | --- | --- |
| localStorage `froozerp_offline_session_v1` | `owner` | `FZDEV-629FF107-…` (**not in the DB at all**) |
| SQLite `local_kv` offline_auth | `dhirajmanwani` | `FZDEV-DELL-1781852580596` (**approved**) |

The stale localStorage record — a different user, and a device id that exists in no table —
shadowed the valid cached credential and produced `DEVICE_MISMATCH`
("Offline login is only available on the previously authorised device"), which reads exactly
like a permanent lockout. Clearing localStorage restored access with no data change.

### Required direction

1. **A local provisioning path that never requires a reachable cloud.** An owner-authorised,
   on-device enrolment for population 1. Without it, "local-first" is not true of
   authentication, which is the one path that gates everything else.
2. **SQLite must win over localStorage** for cached credentials, or a localStorage record
   naming a device id absent from `local_device_identity` must be discarded rather than
   treated as authoritative. A stale browser-profile value should never mask a valid
   device-bound credential.
3. `NO_SESSION`'s message must stop instructing users to do something that may be impossible.
   It should name the local recovery route.

### Note

At the time this item was logged (2026-08-15), no rows had been inserted to work around this —
provisioning was unnecessary, the device was already authorised locally, and the blocker was the
shadowing described above.

**Re-measured 2026-08-16.** A hand-inserted `local_device_assignment` row was believed to have
been added to a disposable profile to get past the login gate while testing the shelved
`CanonicalSnapshotScope` patch. **No such row exists.** `local_device_assignment` was measured
empty in every database reachable on this machine:

| Database | `local_device_assignment` |
| --- | --- |
| Live app-data profile (`%APPDATA%/com.srtcompany.froozerp/froozerp-local.sqlite3`) | **0 rows** |
| 2026-08-15 session scratchpad `dbcopy/froozerp-local.sqlite3` | 0 rows |
| 2026-08-15 session scratchpad `fixture/fixture.sqlite3` | 0 rows |
| 2026-08-15 session scratchpad `repro/pre.sqlite3` | 0 rows |
| 2026-08-15 session scratchpad `repro/failed.sqlite3` | 0 rows |

All read from copies; the live profile's mtime was unchanged by the inspection. The live
profile's `local_device_identity` is 3 rows with 1 approved (`FZDEV-DELL-1781852580596`), which
matches this document's item 2 baseline exactly. So the original note stands as written: **no
rows were inserted**, and the empty-`local_device_assignment` precondition that items 2 and 5
both depend on is intact. Whatever was done to pass the login gate did not leave an assignment
row behind.

**Related, and separately verified:** there is no isolated disposable SQLite profile on this
machine. `npm run app` runs `tauri dev`, which sets neither `NODE_ENV=test` nor
`FROOZERP_ISOLATED_SQLITE_DIR`; `resolve_app_data_dir` (`src-tauri/src/local_db.rs:2056`)
requires **both** before it will redirect, so dev runs against the real app-data profile. Any
future test that needs a disposable profile must set both variables explicitly — it does not
happen by default, and assuming otherwise risks mutating live data.

---

## 6. Migrations exist on disk but are never registered in `local_db.rs`, so they have never been applied on any device

**Status:** open, not started. Logged 2026-08-17 during Stage 2 of
`docs/offline-activation-plan.md`. **Recorded only — deliberately not fixed in Stage 2**, whose
scope is the additive `017` migration and its registration.
**Severity:** latent schema drift. Nothing is currently broken by it, which is exactly why it has
gone unnoticed.

### 6a. `008_cloud_sync_entity_metadata.sql` is orphaned on this branch

`src-tauri/migrations/sqlite/008_cloud_sync_entity_metadata.sql` exists on disk. The const list in
`src-tauri/src/local_db.rs` runs `MIGRATION_007` straight to `MIGRATION_009`, and the
`apply_migration` call sequence does the same. There is no `MIGRATION_008` const and no call for
it.

`apply_migration` only ever runs SQL that is passed to it explicitly, so an unregistered file is
inert: it is compiled into nothing, executed nowhere, and recorded nowhere in
`local_schema_migrations`. **008 has therefore never been applied on any device** — not in dev,
not in any release, not on the maintainer's laptop.

Confirmed present on `codex/second-laptop-bootstrap-1.0.64` as well (12 migration files on disk,
registered `001`–`007` + `009`–`012`), which is a branch real releases were dispatched from. So
the gap shipped.

### 6b. On `main` the gap is wider — three migrations, and `main` did ship

On `main` @ `977caac` the const list stops at `MIGRATION_005`, while `006`, `007` and `008` all
exist on disk. Three unregistered migrations rather than one.

This is not hypothetical. `main` @ `977caac` is tagged `v1.0.51`, and `v1.0.51` is a published,
non-draft GitHub release. Any device that installed a build cut from that tree ran a schema with
`006_multibranch_identity_foundation`, `007_cloud_runtime_and_inbox_foundation` and
`008_cloud_sync_entity_metadata` all missing.

> **Correction to the framing this was logged under.** The gap does not "start earlier on `main`
> than on the working branch". At the time of logging, `claude/offline-entitlement-migration-0nc0wl`
> *was* `main` @ `977caac` — same SHA, empty `git diff` — because it had been cut from `main`
> rather than from the active development branch. There was no divergence to compare. The real
> comparison is `main` (stops at 005) versus `codex/final-cloud-sync-stabilization` (registers
> `001`–`007`, `009`–`016`; only 008 missing).

### Which branch are releases actually cut from? — verified

**There is no single release branch, and that is the root cause.** Neither release workflow pins a
ref: `.github/workflows/windows-updater-release.yml` uses a bare `actions/checkout@v4`, so it
builds whatever ref triggered it. Both trigger paths are in active use.

| Release range | Trigger | Ref actually built |
| --- | --- | --- |
| `v1.0.38` – `v1.0.51` | `push` on tag `v*` | the tag. `v1.0.51` → `977caac` → **`main`'s HEAD** |
| `1.0.6x` (4 runs, 2026-07-22/23) | `workflow_dispatch` | **`codex/second-laptop-bootstrap-1.0.64`** |

So the tag-push releases were built from `main`'s tree (registering only `001`–`005`), and the
later dispatched releases from a `codex/*` branch (registering `001`–`007`, `009`–`012`). Devices
in the field can be carrying either schema depending on which build they installed.

### Why this is worth fixing deliberately rather than quickly

Registering a skipped migration is **not** a safe one-line addition. `apply_migration` is
version-gated on `local_schema_migrations`, so adding `MIGRATION_008` would cause `008` to run for
the first time on profiles that have already had `009`–`017` applied — i.e. out of order, against
a schema those later migrations already reshaped. Whether that is safe depends entirely on
`008`'s contents versus what `009`+ did to the same tables.

Fixing it needs, at minimum:

1. A read of `008_cloud_sync_entity_metadata.sql` against `009`–`017` to establish whether it is
   still meaningful, already superseded, or actively conflicting.
2. A decision recorded in writing: register it (and prove out-of-order application is safe), fold
   its still-needed parts into a new forward-only `018`, or retire the file with a comment
   explaining why it stays unapplied.
3. A ref-pinning guard on the release workflows, so "which branch shipped" stops being a question
   answerable only by reading Actions history.

Item 3 is arguably the more urgent half: without it, this class of divergence recurs silently.
