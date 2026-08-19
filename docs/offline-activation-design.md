# Offline-First Activation and Device Authorisation — Design Proposal

**Status:** proposal only. Nothing here is implemented. No code has been written.
**Written:** 2026-08-16.
**Related:** `docs/backlog-1.0.72.md` items 2, 3, 4, 5.

Every decision that is the maintainer's rather than mine is marked **[D-n]** inline and
collected in the register at the end. I have given a recommendation for each; none is settled.

---

## 1. What is actually broken

The brief is correct, and the code confirms it more sharply than the backlog does.

**Login cannot complete without the cloud.** `login()` (`frontend/src/App.jsx:4223`) runs, in
order: a connectivity check, a `canonical-cloud-login` health probe against `AUTH_API_URL`,
`POST /api/auth/device-bootstrap-status`, then `POST /login`. On the desktop all three leave
through `backend/desktopGateway.js`, whose `localRoute` handles only `/health`, `/api/version`,
`/api/system/compatibility`, `/api/cloud/internet-access`, `/api/cloud/health` and
`GET /settings`. Everything else — including `/login` — falls through to `cloudRequest`, which
throws `APP_LOCAL_ONLY` and returns HTTP 503 when internet access is off. There is no local
`/login`. There is no local users table in SQLite at all; none of the 23 `local_*` tables in
`src-tauri/migrations/sqlite/` holds credentials.

**Offline login is only a cache of a previous online login.** `continueOffline()`
(`App.jsx:3513`) loads the reference snapshot and verifies against `snapshot.offline_auth`, or
falls back to `readOfflineSession()` from localStorage. That record exists only because
`hydrateOnlineSession()` wrote it after a successful *cloud* login. A device that has never
reached the cloud has no record, and `offlineSession.js:79` tells the user to "connect to the
internet once before offline use" — unsatisfiable when the backend is gone.

**Device approval is asserted, not proved.** Two places grant approval with no evidence:
`App.jsx` (`fetchOnlineReferenceSnapshot`) hardcodes `registration_status: "approved"` into the snapshot the desktop builds
for itself, and `cache_reference_snapshot_at` (`local_db.rs:2194`) defaults the same field to
`"approved"` when the snapshot omits it. So authorisation today is simultaneously cloud-gated
(you cannot get in without it) and unverifiable (once in, it is self-granted). That is the worst
of both.

**The existing activation-code mechanism is a server lookup.** `POST /devices/activate`
(`server.js:9851`) hashes the submitted code with `hashActivationCode` (`server.js:609`), looks
it up in `activation_codes` (`server.js:2189`), and calls `approveDevice`. The code carries no
proof of anything; its meaning lives in Postgres. When Postgres is unreachable the code is
worthless. This is exactly the mechanism the brief replaces.

**`deviceSession.js` cannot help.** It issues HMAC-SHA256 tokens signed with a server secret.
Symmetric — a device could only verify one by holding the secret, which would mean shipping the
secret. Right shape for *API* authorisation, and it should stay for that, but it cannot be the
offline trust root.

### The conflation that has to be undone

Three different questions are currently answered by one cloud round-trip:

| # | Question | Authority | Today |
| --- | --- | --- | --- |
| 1 | **Entitlement** — may this company run FroozERP, on how many devices, until when? | You, the vendor | Not modelled |
| 2 | **Device authorisation** — is this device a legitimate member of company C, branch B? | You, at provisioning time | Cloud lookup, then self-granted |
| 3 | **User authentication** — is this human user U? | The company's own owner | Cloud `/login`, cached afterwards |
| 4 | **Sync** — may this device exchange data? | Cloud, at connect time | Correctly separate already |

The signed activation code answers **1 and 2**. It does **not** answer 3, and the design must
say what happens to user credentials on a device that has never been online — §8 does. Keeping
these four axes separate is the whole design; everything below follows from it.

---

## 2. Design principles

1. **Nothing on the critical path may require a network round-trip.** Login, billing, local
   stock and local reports are critical path. Provisioning a *new* device and issuing codes are
   not.
2. **A shop that is running never stops billing.** Not on expiry, not on revocation, not on a
   clock anomaly, not on a corrupt entitlement. Degradation removes administrative capability
   only. This should be asserted as an invariant in the test suite.
3. **Verification happens in Rust, not JavaScript.** `App.jsx` is a bundle a user can edit; a
   check there is decoration. Rust is not tamper-proof either, but it raises the bar from
   "edit a text file" to "patch a binary", and it stops the frontend *deciding* anything — it
   only renders state the shell reports. Second reason: WebView2's `crypto.subtle` does not
   reliably expose Ed25519, so JS verification would need a bundled crypto library anyway.
4. **Errors are never silence and never zero.** A malformed, expired or unverifiable entitlement
   produces a named state with a banner, never a blank or a permissive default. The `CLAUDE.md`
   rule applied to authorisation.
5. **Fail into the running state, not out of it.** Where a check is ambiguous — unreadable clock,
   corrupt row, unknown key id — the device keeps whatever capability it last legitimately had
   and shouts. The opposite is precisely what bricked the laptop.

---

## 3. Signature scheme and key management

### 3.1 Primitive — AMENDED 2026-08-16 (implementation), supersedes the original D-1 ruling

**Ed25519 via `ed25519-dalek`, verifying raw 64-byte signatures over caller-supplied bytes.**

> **Do not "fix" this back to `minisign-verify`.** The original D-1 ruling named
> `minisign-verify` because it was already in the dependency tree. That crate **cannot perform
> the verification this design requires**, which was established by reading its source, not by
> preference. The reasons are structural and will not change with a version bump:
>
> 1. `mod crypto;` is **private** at the crate root (`minisign-verify-0.2.5/src/lib.rs:107`), so
>    `crypto::ed25519::verify` is unreachable from outside the crate. There is no raw-Ed25519
>    entry point in its public API.
> 2. `Signature` has **no public constructor from bytes** — only `Signature::decode(&str)` over
>    the 4-line minisign text envelope, and `Signature::from_file`. A bare `(key_id, 64-byte
>    sig)` pair cannot be turned into a `Signature`.
> 3. `PublicKey::verify` → `verify_ed25519` also verifies the **global signature** over
>    `signature ‖ trusted_comment` (`src/lib.rs:338-344`). Synthesising an envelope around a raw
>    signature therefore cannot work either: the global signature requires the private key.
>
> Consequence: a minisign artefact carries ~138 bytes of signature framing before any payload,
> which is **220+ Base32 characters of signature alone**. That is incompatible with §3.4
> (verify the exact bytes supplied), with the §4 compact layout, and with the 140-character
> typed-code budget in §7.1 that D-8 depends on. Adopting minisign format would silently revoke
> the typed-code half of D-8.

Two direct dependencies were added to `src-tauri/Cargo.toml`:

| Crate | Resolved | Why |
| --- | --- | --- |
| `ed25519-dalek` | 2.2.0 | Raw 64-byte signature verification over exact caller-supplied bytes (§3.4) |
| `sha2` | 0.10.9 | `device_binding_hash` — truncated SHA-256 of the device identity string (§4, §7.3) |

`sha2` was already present transitively and vendored in the local registry cache; `ed25519-dalek`
required one `cargo fetch` from crates.io (a normal dependency fetch — not Railway, not
production). `minisign-verify` remains in the tree as a transitive dependency of
`tauri-plugin-updater` and is **not** used by the activation path. The updater's minisign key at
`tauri.conf.json:67` remains untouched and belongs to a separate trust domain (§3.3).

What survives from D-1 unchanged: the primitive is Ed25519, and the intent — prefer what is
already in the tree — was honoured up to the point where it proved technically impossible.

Hard constraint that falls out: **an Ed25519 signature is 64 bytes and cannot be truncated.**
§7 shows what that does to typed codes. Every other primitive worth trusting (ECDSA P-256,
secp256k1) is also 64 bytes. There is no short-signature option that is not exotic.

### 3.2 Key hierarchy — RULED (2026-08-16)

**Single root key, offline on the maintainer's machine, no subordinate hierarchy.** No private
key of any kind ever touches Railway or any cloud host. This is Option A2 from the original
draft: the maintainer runs a local signing step to produce renewal entitlements ahead of time
(§10), and the cloud does no more than hand the right pre-signed blob to the right device on
check-in. A total compromise of the cloud side leaks nothing that can authorise anything, which
matters more than the convenience of on-demand cloud signing at a scale of one maintainer and a
handful of branches.

**Rotation is built in from day one, not deferred.** §3.3's trusted-key array
(`TRUSTED_ACTIVATION_KEYS: &[(u8, [u8; 32])]`) ships with **at least two slots populated at
first release** — the current signing key, plus a second key generated and baked in now but not
yet used to sign anything ("next"). Rotating later means switching which key new codes are
signed with; every code already in the field keeps verifying against its original `key_id`
without an app update. The alternative — shipping one key and adding a second only when rotation
is actually needed — forces every existing device to update its trusted-key list before it can
verify anything signed after the rotation, which is the wrong order for a rotation that is
supposed to be uneventful.

### 3.3 The keys themselves

- **New key, not the updater key.** `src-tauri/tauri.conf.json:67` already carries a minisign
  public key for the updater. It must not be reused: separate trust domains, separate blast
  radius, and per `CLAUDE.md` I am not to touch updater metadata at all. Activation gets its own
  keypair.
- **Public key baked into the binary as a Rust constant** — not `tauri.conf.json`, not a JSON
  file, not fetched. A `const TRUSTED_ACTIVATION_KEYS: &[(u8, [u8; 32])]`, an *array* keyed by a
  1-byte key id, from day one. Rotation without bricking costs one byte in the payload and is
  impossible to retrofit cheaply.
- **Private key never ships, never enters the repo, never enters Railway, never enters CI.**
  Signing is a local CLI (`scripts/sign-activation.mjs` or a small Rust bin) excluded from the
  bundle.
- **[D-3]** Where the root private key lives and how it is backed up: encrypted file on the
  maintainer's machine, hardware token, or offline paper backup. This is the single point of
  failure for the whole scheme — lost, and no device can ever be provisioned offline again;
  leaked, and anyone can mint entitlements with the only remedy being an app update that removes
  the key id. I recommend an encrypted file plus a paper backup stored separately, and
  explicitly *not* the same passphrase as the signing password referenced in `CLAUDE.md`.

### 3.4 What is signed

The signature covers the **exact canonical bytes** of the payload, stored verbatim on the device
alongside the signature. Never re-serialise before verifying — re-serialisation is where
signature schemes die. The stored `payload_blob` is the source of truth; parsed columns are a
convenience index, rebuilt from the blob and never the other way round.

---

## 4. Payload contents

Compact binary, little-endian, versioned. Field sizes chosen for the typed-code budget in §7.

| Field | Size | Notes |
| --- | --- | --- |
| `format_version` | 1 | Rejecting an unknown version must be a *named* state, not a crash |
| `key_id` | 1 | Selects the trusted public key; enables rotation |
| `flags` | 1 | Code type (device-bound / seat), carries-credential, capability bits |
| `company_id` | varint 1–3 | |
| `branch_id` | varint 1–2 | |
| `operational_location_id` | varint 1–2 | Optional — see **[D-4]** |
| `device_binding` | 8 | Truncated SHA-256 of the device identity string (§7.3) |
| `entitlement_serial` | 4 | Unique id for audit, revocation and dedupe |
| `issued_at` | 2 | Days since 2020-01-01 |
| `valid_days` | 2 | Expiry as a duration, not an absolute — a byte cheaper and friendlier to clock anomalies |
| **subtotal** | **~23** | |
| `signature` | 64 | Ed25519, irreducible |
| **total** | **~87 bytes** | |

The payload deliberately does **not** carry a user list, a seat count the device is expected to
enforce alone, or anything the cloud can revise. Everything the device must prove standing alone
is here; everything else arrives by sync.

**Bootstrap credential extension (file format only, ruled in §8.1):** when the `flags`
carries-credential bit is set, three additional fields follow the core payload before the
signature — `owner_username` (length-prefixed, ≤24 bytes), `owner_salt` (16 bytes),
`owner_verifier` (32 bytes) — plus a `bootstrap_expires_at` short offset (§8.2). This raises the
file payload to roughly 160 bytes; it is never present in typed codes, which stay at the ~87-byte
core.

**[D-4]** Whether `operational_location_id` belongs in the signed payload. Including it pins a
device to a counter, so moving a device between counters needs a new code. Excluding it leaves
location assignment a sync-delivered, revisable fact. I recommend **excluding** it and letting
`local_device_assignment` carry it — this matters in §6.

---

## 5. Local SQLite changes

One new forward-only migration, `017_offline_entitlement_foundation.sql`, idempotent across
restarts per `CLAUDE.md`.

### 5.1 `local_entitlement`

```
local_entitlement
  entitlement_serial   TEXT PRIMARY KEY
  key_id               INTEGER NOT NULL
  format_version       INTEGER NOT NULL
  company_id           TEXT NOT NULL
  branch_id            TEXT NOT NULL
  device_id            TEXT NOT NULL
  device_binding_hex   TEXT NOT NULL
  issued_at            TEXT NOT NULL      -- ISO-8601 UTC, per migration 009
  expires_at           TEXT NOT NULL
  grace_until          TEXT NOT NULL
  capabilities_json    TEXT NOT NULL DEFAULT '{}'
  payload_blob         BLOB NOT NULL      -- exact signed bytes
  signature_blob       BLOB NOT NULL
  verification_state   TEXT NOT NULL      -- VERIFIED | LEGACY_GRANDFATHER
  source               TEXT NOT NULL      -- ONLINE_REGISTRATION | OFFLINE_FILE | OFFLINE_TYPED | OFFLINE_QR | LEGACY_UPGRADE
  accepted_at          TEXT NOT NULL
  superseded_at        TEXT
  revoked_at           TEXT
  revocation_reason    TEXT
```

**Rows are never deleted and never mutated except to set `superseded_at` / `revoked_at`.**
Renewal inserts a new row and supersedes the old. The active entitlement is the non-superseded,
non-revoked row with the greatest `issued_at`. Keeping history means "when did this device stop
working?" is answerable from the device itself.

Timestamps follow migration `009_canonical_utc_timestamps.sql`, which normalised every timestamp
column to `strftime('%Y-%m-%dT%H:%M:%fZ')`.

### 5.2 `local_entitlement_audit`

Append-only: `(id, entitlement_serial, event, reason_code, detail_json, occurred_at, device_id)`.
Events: `ACCEPTED`, `REJECTED`, `RENEWED`, `SUPERSEDED`, `REVOKED`, `ENTERED_GRACE`,
`ENTERED_EXPIRED`, `CLOCK_ANOMALY`. Every rejection records *why* — a maintainer debugging a
branch over the phone needs the reason code, not "activation failed".

### 5.3 Replay guard and clock

- `local_activation_code_seen (fingerprint TEXT PRIMARY KEY, first_seen_at TEXT, outcome TEXT)`
  — SHA-256 of the payload blob. Prevents re-consuming the same code on the same device and gives
  a local, offline answer to "have I seen this before?".
- **Clock high-water mark** in `local_kv`: `entitlement_clock_high_water`.

  > **AMENDED 2026-08-16.** The original wording — "the greatest trustworthy timestamp ever
  > observed (from `serverTime.js` when online, **from the device otherwise**)" — is **withdrawn**.
  > Letting the device clock write the high-water mark defeats both anomaly checks:
  >
  > 1. **The ahead-check could never fire.** If the device clock writes `high_water`, then
  >    `high_water ≈ now` permanently, so `now > high_water + threshold` is unreachable by
  >    construction. The check would be dead code that reads as protection.
  > 2. **A single forward jump poisons the mark permanently.** A clock that jumps to 2099 once
  >    writes `high_water = 2099`. Correcting the clock afterwards leaves `now ≪ high_water`
  >    forever, so the *behind*-check fires on every subsequent evaluation and the device sits in
  >    permanent `CLOCK_ANOMALY`. Because `high_water` is monotonic by design, there is no
  >    recovery path short of editing SQLite by hand.
  >
  > A mark that anything can write is not a high-water mark; it is a copy of the clock it was
  > supposed to check.

  **Corrected rule.** `entitlement_clock_high_water` advances from **corroborated server time
  only**, floored by the entitlement's own `issued_at`:

  1. **Only corroborated server time may advance it.** A timestamp from a completed authenticated
     exchange with the cloud (`serverTime.js`). The device's own clock **never** writes it.
  2. **The signed entitlement provides the floor.** `high_water` is never lower than the greatest
     `issued_at` among accepted entitlements. A valid signature is cryptographic proof that real
     time was at least `issued_at` when the artefact was minted — a trustworthy lower bound that
     needs no server. On a device that has never synced, this floor *is* the high-water mark.
  3. **Monotonic non-decreasing**, persisted across restarts.
  4. **Never written from an unauthenticated or unsigned source** — not from an HTTP `Date`
     header, not from a file mtime, not from a sync payload that failed verification.

  Under this rule both checks recover their meaning: the gap `now − high_water` grows only while
  time is *uncorroborated*, so a large gap genuinely indicates either a long offline period or a
  broken clock, and no local actor can poison the mark.

  - Expiry is still evaluated against `max(system_clock, high_water)`. Winding the clock back does
    not extend an entitlement.
  - A clock untrustworthy in **either** direction yields `CLOCK_ANOMALY`: log it, banner it, and
    **hold the current state** (D-5). Never transition to a more restricted state on the strength
    of a clock that is demonstrably wrong. A dead CMOS battery must not lock a shop.

  **Two consequences that are not yet resolved.** Both are policy gaps this amendment exposes
  rather than creates, and both are for the Stage 4/7 wiring, not for storage:

  - **`CLOCK_ANOMALY` is undefined when there is no previous state.** "Hold the current state"
    presumes one exists. A device activating a code that was minted long ago (mailed, shelved,
    installed months later) can trip the ahead-check on its very first evaluation, with nothing
    to hold but `Unprovisioned` — which would deny billing and contradict §2.2. *Proposal:* when
    no previous state exists, resolve against the `issued_at` floor instead of holding, so a
    freshly activated device starts `Active` regardless of clock condition.
  - **A legitimately long-offline device eventually crosses the ahead threshold.** With expiry at
    365 + 60 days (D-13) and the ahead threshold at 730 days, such a device runs
    `Active → Grace → Expired` and then flips to `ClockAnomaly` at day 730 — a state it reaches
    by being honest. Capability is unchanged in practice (both keep billing, both withhold
    admin), but the banner would contradict itself. *Proposal:* apply the anomaly check only when
    it would prevent a transition to a **more restricted** state — evaluate once against the
    floor and once against the effective clock, and return `ClockAnomaly` only where the clock is
    untrustworthy *and* would restrict further than the floor allows. This is D-5's principle
    stated precisely rather than a new rule.

  **Effect on `src-tauri/src/entitlement.rs`: no change is required now.** `evaluate_state` takes
  `now` and `high_water` as plain arguments and is deliberately agnostic about where either comes
  from, so the defect was always in the *writer* of the mark, never in the evaluator. The shipped
  module is already correct under the corrected rule. The two proposals above would, if accepted,
  touch the pure layer rather than storage — an internal `issued_at` floor inside `evaluate_state`
  (defensive: it already has `verified.payload().issued_at` in hand, so a caller passing a
  too-low `high_water` cannot weaken it), and a suppress-only-restrictions form of the ahead
  check. Both are recommended for **Stage 4**, when a caller exists to exercise them; neither is
  worth changing while the module has no call sites.

### 5.4 Existing tables

- `local_device_identity` — no schema change. `registration_status` becomes *derived from* the
  entitlement rather than asserted (§6.3).
- `local_device_assignment` — no schema change. It stops being a precondition for anything and
  becomes what it should always have been: a sync-delivered convenience.

---

## 6. Rust device-identity path, and the shelved `CanonicalSnapshotScope` work

### 6.1 New module

`src-tauri/src/entitlement.rs` — pure verification, no database, no filesystem:

```
parse_payload(bytes)                      -> Result<Payload, RejectReason>
verify(bytes, sig, trusted_keys)          -> Result<Verified, RejectReason>
evaluate_state(verified, now, high_water)  -> EntitlementState
```

`EntitlementState` is the whole policy in one enum: `Unprovisioned`, `Active`, `Grace`,
`Expired`, `Revoked`, `ClockAnomaly`, `Malformed { reason }`. Pure functions, exhaustively
unit-testable under `cargo test`, no I/O. Same reasoning `CLAUDE.md` gives for preferring
`frontend/src/local/` over `App.jsx`: put the logic where it can be tested.

### 6.2 `local_db.rs` additions

`accept_entitlement()`, `active_entitlement()`, `entitlement_state()`,
`record_entitlement_audit()`. New Tauri commands in `lib.rs`: `entitlement_status`,
`entitlement_redeem`, `entitlement_import_file`. The frontend calls these and renders the result;
it does not evaluate policy.

### 6.3 Changes to the device-identity path

`ensure_device_identity_with_preference_at()` (`local_db.rs:3067`) currently inserts a fresh
identity as `branch_id = 'unassigned'`, `registration_status = 'pending'`, and only the cloud can
move it to approved. Change: **accepting a verified entitlement promotes the identity locally** —
`registration_status = 'approved'`, `branch_id` and `company_id` from the payload. That single
change removes the cloud from the authorisation path.

Two removals go with it:

- `App.jsx`'s hardcoded `registration_status: "approved"` in `fetchOnlineReferenceSnapshot`.
- The `"approved"` default in `cache_reference_snapshot_at` (`local_db.rs:2194`). A snapshot that
  omits the field should yield the device's existing status, never an upgrade to approved.

The `DEVICE_IDENTITY_CONFLICT` guard (multiple approved identities) stays — that check is sound.

### 6.4 Relationship to the shelved patch

`scratchpad/local_db-canonical-snapshot-scope.patch` fails for a specific reason:
`canonical_snapshot_scope()` demands exactly one row in `local_device_assignment` joined to an
approved identity, and `local_device_assignment` is **empty in every profile that has ever
existed** (backlog item 2 measured this across three databases). The `?` at the call site aborts
the whole snapshot build, so offline login dies.

The entitlement work is the missing piece that patch was reaching for. It supplies `company_id`
and `branch_id` from a *signed artefact every provisioned device holds*, which is a far better
authority than an assignment row the cloud may or may not have delivered.

**Resolution order for snapshot scope, once entitlements land:**

1. Active verified entitlement — `company_id`, `branch_id`.
2. Active `local_device_assignment` row — adds `operational_location_id`.
3. Approved `local_device_identity` — `branch_id` only.
4. **Unscoped, current behaviour.**

**Rung 4 is not optional.** Even after entitlements exist, the scope lookup must stay non-fatal.
Backlog item 2 recommends this and it is right for a reason that generalises: *a snapshot builder
must not fail closed on metadata*. A device with a corrupt entitlement row still needs to load
its own stock and bill. Scope narrows the snapshot when scope is known; absent scope means an
unnarrowed snapshot plus a diagnostic, not an exception.

Same treatment for the siblings: `DEVICE_SCOPE_CONFLICT` and `DEVICE_SCOPE_MISMATCH` become
surfaced warnings that fall through to the next rung, not `?`-aborts.

**Sequencing:** entitlements land first; the scope patch is reworked on top with rungs 1–4 and
lands second. Landing the patch as it stands, before or after, brings offline login down.

**[D-6]** Confirm scope stays non-fatal permanently (my recommendation), rather than becoming
mandatory once entitlements make rung 1 usually available.

---

## 7. Code delivery: file, QR, typed

All three carry the same ~87 bytes. The differences are entirely about how those bytes travel.

### 7.1 The length arithmetic

87 bytes, of which 64 are an irreducible signature.

| Encoding | Chars | Typing feasibility |
| --- | --- | --- |
| Crockford Base32 (case-insensitive, no I/L/O/U) | **140** | 28 groups of 5. Painful but possible. |
| Base58 | 119 | Case-sensitive — worse to dictate by phone despite being shorter |
| Base64 | 116 | Case-sensitive, `+/=`. Poor for typing, fine for files |
| Hex | 174 | Too long |

For scale: a Windows product key is 25 characters. This is **~5.6×** that, because a product key
is a short opaque token validated by lookup or by a keyed algorithm — it proves nothing by
itself. Self-proving and short are mutually exclusive. That trade is the direct consequence of
"no server lookup, ever", and it is the one place the brief's requirements pull against each
other, so it is worth stating plainly rather than discovering during implementation.

### 7.2 The three options

**File — `.frzact`.** No length constraint. Self-contained text: human-readable header comment
lines (company, branch, device, expiry, serial) for support, then base64 payload and signature.
~350 bytes. Delivered by email, USB stick, WhatsApp, anything. Imported via a file picker or by
dropping it in a watched folder beside the SQLite file.
*Pros:* no transcription errors, room for optional extras (§8), trivially verifiable, easy to
re-send. Can use the minisign format directly, which makes `minisign -S` the signing tool and
`minisign-verify` — already compiled in — the verifier.
*Cons:* needs a file to reach a machine that may be locked out of everything except a login
screen. In practice a USB stick, or an email opened on a phone and transferred. Fine.

**QR.** 87 bytes in byte mode fits **QR version 5 (37×37) at ECC level M** comfortably. Printable
on a receipt, displayable on the maintainer's phone.
*Cons:* the shop device needs a camera or a way to receive an image, and decoding needs a QR
decoder dependency (Rust `rqrr`, or a JS decoder). Neither is in the tree. On a Windows till with
no webcam, QR buys nothing the file path does not.
**[D-7]** I recommend deferring QR unless there is a concrete camera-equipped device in the
rollout.

**Typed — 140 characters.** The genuine last resort: a phone call to a branch with no internet,
no USB stick and no email. It must exist for that case or the "long outage" requirement has a
hole. *If built:* Crockford Base32, case-insensitive, auto-uppercased, auto-grouped into 5s as
the user types, ambiguous characters (I/L/O/U) folded to their lookalikes on input, a per-group
checksum so an error is caught at the group rather than after 140 characters, and a paste path
that accepts the whole string. Estimate ~2–3 minutes of careful typing with one or two retries.

**[D-8] RULED (2026-08-16):** file as primary (delivered as a WhatsApp `.lic` attachment in
practice), typed as the documented fallback, QR skipped for now with the door left open — the
encoding is just an alternate transport of the same signed bytes, so adding a QR path later
touches nothing already built. Confirmed rationale: the till devices have no cameras, so QR buys
nothing today.

### 7.3 Device binding and the round trip

A device-bound code requires the issuer to know the device's identity *before* signing. The
device generates its own id on first run (`generate_opaque_device_id`, `local_db.rs:3360`, a
Windows GUID) and displays it on the activation screen. The branch reads it out; the maintainer
signs a code for it. One phone call, no internet.

The alternative is an **unbound seat code** that the first device to consume it claims. It
removes the round trip, but offline there is nothing to enforce single use — the same code runs
on N devices until they sync and the overage is noticed.

**[D-9]** Device-bound only (round trip, no replay) versus allowing unbound seat codes (no round
trip, replayable until sync). I recommend **device-bound only**, revisiting if the round trip
proves painful in practice.

### 7.4 A binding weakness worth naming

`device_id` is a random GUID stored in SQLite. It is **not** hardware-bound. Copying
`froozerp-local.sqlite3` to another machine copies the identity, and a device-bound entitlement
travels with it. Whether that matters depends on the threat model — a non-issue for an honest
branch, a trivial bypass for a dishonest one.

Adding a hardware component (Windows `MachineGuid` from the registry, plus the system volume
serial) to `device_binding` would close it, at the cost of hardware changes (disk swap,
motherboard replacement, Windows reinstall) invalidating the entitlement and requiring a new
code, and VM/imaging scenarios breaking. Given the never-lock-the-shop stance, a hardware binding
that can spuriously invalidate is a real availability risk.

**[D-10]** Bind to the SQLite-stored `device_id` alone (copyable, never spuriously breaks), or
add a hardware fingerprint (harder to copy, can spuriously break). I recommend **`device_id`
alone**, with the hardware fingerprint recorded in the audit trail as an observation — so a
copied profile is *visible* at next sync without being *blocked* offline.

---

## 8. User authentication on a never-online device

This is the gap the brief's four bullets do not close, and it is the difference between "the
device is authorised" and "someone can actually log in".

An entitlement proves the device belongs to company C. It says nothing about who may sign in. On
a device that has never been online there is no `offline_auth::*` row in `local_kv`, no users in
`settings_bundle`, and no local users table. Activation alone leaves a device that is authorised
and unusable.

### 8.1 RULED (2026-08-16): the activation code carries the first Owner credential

The **file** format carries a bootstrap Owner credential: username, a PBKDF2 salt (16 bytes) and
verifier (32 bytes), signed as part of the same payload. On activation the app creates that Owner
locally and immediately forces a password change before any other action is available — one
signed artefact makes the device both authorised and usable, with no first-run prompt and no
branch-chosen credential in the primary path.

This is Option 1 from the original draft, with the file/typed split from §7 resolved by putting
it only in the file: **the typed fallback does not carry the credential.** Adding ~73 bytes
(username + salt + verifier) to the ~87-byte core payload pushes typed codes well past the
140-character budget agreed in §7 — a typed-code activation falls back to first-run local Owner
setup (the original Option 2: the branch sets its own password, reconciled at first sync)
instead. This keeps the file path at maximum strength and the typed path within a typeable
length; flag if the credential was meant to travel in typed codes too, since that reopens the
length trade in §7.1.

### 8.2 Achievability of single-use, short-lived, invalid-after-password-change

Asked and confirmed achievable, with one honest limit.

**Short-lived.** A `bootstrap_expires_at` field, a short offset from `issued_at` (default
proposed: 7 days, tunable), checked locally against the same clock high-water-mark machinery
already specified in §5.3. No cloud round trip needed to enforce it.

**Invalid once the password is changed.** Enforced as local policy, not as cryptographic
revocation — the signed bytes themselves remain forever verifiable; what stops working is the
device's willingness to *accept* them a second time. Concretely: `local_entitlement` gains a
`bootstrap_consumed_at` column. The first successful login using the bootstrap credential (a)
forces the password-change flow before any other screen is reachable, (b) on completion, writes
a normal `offline_auth` record for that user under the new password through the existing
`cacheOfflineSession` path, (c) sets `bootstrap_consumed_at` and records a
`BOOTSTRAP_CREDENTIAL_CONSUMED` event in `local_entitlement_audit`, and (d) from that point the
app never compares against the payload's original verifier again — a later attempt is rejected
with a distinct `BOOTSTRAP_CREDENTIAL_CONSUMED` code, not folded into `INVALID_CREDENTIALS`.

**Single-use in practice.** This falls out of device binding (§7.3, D-9) rather than needing new
machinery: the bootstrap credential is only reachable through a successful entitlement
acceptance, and acceptance requires the accepting device's `device_id` to match the payload's
`device_binding`. An interceptor holding the file but not the bound device cannot complete
activation, so cannot reach the login step at all.

**The limit.** None of the above makes the signature revocable — it makes local *acceptance*
single-shot. Two things it does not close, both physical rather than cryptographic: (1) whoever
has both the file and physical or network access to the specific bound device before its
rightful operator activates it wins the race — this is the same exposure a physical key or
activation card has, and no offline-verifiable scheme closes it; (2) because signing is not
encryption, the salt and verifier are plaintext-readable to anyone holding the file, so the
credential's real strength rests on the entropy of the temporary password chosen at signing time,
not on anything in this mechanism. Recommend the signing CLI auto-generate a high-entropy
temporary password and have the maintainer relay it through a channel separate from the file
itself (e.g. read aloud on the same phone call that carries the device id) rather than defaulting
to something memorable. This is an implementation detail, not a reopened decision.

### 8.3 Multi-user offline billing — RULED (2026-08-16): not built

No per-user signed verifiers, and no code issued per cashier. Once the bootstrap Owner is active
on a device, the Owner creates staff users **locally, on that device** — the same shape the local
users table had before, not something delivered through an activation artefact. This keeps the
signed payload scoped to device authorisation and one bootstrap identity only; staff account
management is ordinary local CRUD gated behind the Owner role, reconciled at sync like any other
local write.

---

## 9. State machine

| State | Condition | Billing | Local stock/reports | Sync | Admin & settings | New-device provisioning |
| --- | --- | --- | --- | --- | --- | --- |
| `UNPROVISIONED` | No entitlement | ✗ | ✗ | ✗ | ✗ | Activation screen only |
| `ACTIVE` | `now < expires_at` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `GRACE` | `expires_at ≤ now < grace_until` | ✓ | ✓ | ✓ | ✓ | ✗ |
| `EXPIRED` | `now ≥ grace_until` | **✓** | **✓** | ✓ | ✗ | ✗ |
| `REVOKED` | Revocation seen at sync | **✓** | **✓** | ✓ | ✗ | ✗ |
| `CLOCK_ANOMALY` | Clock untrustworthy | hold previous state | | | | |
| `MALFORMED` | Unparseable / unknown key | hold previous state, loud banner | | | | |

Billing is never in the ✗ column except before first provisioning. That is the invariant from
§2.2, and it should be asserted directly in tests so no future change can quietly remove it.

**Banners.** `GRACE` gets a persistent but non-blocking banner with days remaining and, when
connectivity exists, a renewal attempt. `EXPIRED` and `REVOKED` get a loud, non-dismissible
banner naming the state, the date it happened, and the contact route. Per `CLAUDE.md`'s "errors
must never render as zero", none of these states may present as a normal screen.

**[D-13]** `valid_days` and grace length. I recommend **365 days validity, 60 days grace** —
"survive a long outage" means months, and the Railway lapse is the proof case. Shorter validity
means more renewal traffic and more exposure to exactly this failure.

**[D-14]** Should `REVOKED` be harsher than `EXPIRED`? A revoked device is one you have decided
should not operate — a stolen till, a departed franchisee. I still recommend it keeps billing (a
shop mid-transaction is not the place to enforce a commercial dispute), with an unmissable banner
and the state syncing out so you can see it took effect. If you want revoked devices to stop
billing at end of business day, that is a defensible different answer and needs to be your call.

---

## 10. What the cloud still legitimately does

Nothing on the critical path. Everything below is convenience, oversight, or data.

- **Issue entitlements on online registration.** The pleasant path: a new device connects,
  authenticates, receives a signed entitlement, nobody types anything.
- **Silent renewal.** Serve a fresh signed entitlement when the device checks in. Per **[D-2]**,
  either signed on demand by a subordinate key (A) or served from a pre-signed batch (A2).
- **Authoritative device roster and seat accounting.** How many devices a company actually runs,
  which are in grace, which have not been seen. Reconciliation and reporting, not enforcement.
- **Revocation list**, delivered through the existing sync pull. Applied on next successful sync,
  as the brief requires — never consulted as a live gate.
- **Business data sync.** Unchanged and explicitly independent: a branch with no internet bills
  fine and simply does not sync.
- **Owner-facing device management UI** and the `device_audit_trail`.

What it stops doing: gating `/login`, being probed before login (`canonical-cloud-login`),
answering `device-bootstrap-status` as a precondition, or being required for a device to know its
own scope.

---

## 11. Migration

### 11.1 Devices already provisioned

Every existing installation has an approved `local_device_identity`, a cached snapshot, and
`offline_auth::*` rows — but no entitlement and, critically, **no way to obtain one online**,
because Railway is gone. Requiring a signed code before the app runs would brick every existing
device on upgrade. Not acceptable.

**Grandfathering.** On first run after upgrade, if the device has exactly one approved
`local_device_identity` **and** a cached reference snapshot with a real `user_profile`, write a
`local_entitlement` row with:

- `verification_state = 'LEGACY_GRANDFATHER'`, `source = 'LEGACY_UPGRADE'`, empty
  `signature_blob`
- `company_id` / `branch_id` from the existing identity and snapshot
- `device_binding_hex` computed from the existing `device_id`
- generous validity (**[D-15]**, I suggest 400 days) so a device cannot silently expire before
  anyone notices the rollout stalled

Constraints — it is a compatibility shim, not a credential:

- **Not exportable.** No path produces a file or code from it.
- **Cannot authorise provisioning another device.** That requires a `VERIFIED` entitlement.
- **Presents its own state.** A quiet admin indicator (not customer-facing) reading "provisional
  activation — replace with a signed activation code".
- **Superseded** on first redemption of a real code, or first successful online registration.

The rule keys off `local_device_identity` plus a real cached snapshot deliberately — **not** off
`local_device_assignment`, which is empty everywhere and, on the disposable profile, currently
contains a hand-inserted row.

### 11.2 This laptop specifically

The maintainer's device is in the recoverable population. Backlog item 5 established it holds a
valid credential in `local_kv` under `offline_auth::FZDEV-DELL-1781852580596::dhirajmanwani`, and
that the apparent lockout was caused by a stale `localStorage` record naming a device id
(`FZDEV-629FF107-…`) that exists in no table, shadowing the valid one via `App.jsx:3517`'s
fallback to `readOfflineSession()`.

So: grandfathering restores entitlement with zero cloud contact, **and then a real signed code
should be redeemed on it immediately** — the natural first test of the whole path, on the machine
where the failure was found.

But grandfathering alone does not fix it. **The localStorage shadowing bug must be fixed in the
same change**, or the laptop still fails to log in for a reason unrelated to entitlements.
Concretely: SQLite wins over `localStorage`, and any `localStorage` session naming a `device_id`
absent from `local_device_identity` is discarded rather than treated as authoritative.

Two more backlog items belong in this work rather than after it:

- **Item 3** — the hardcoded `DEFAULT_PRODUCTION_CLOUD_API_URL` fallback (`App.jsx:148`,
  `:249-256`). An unprovisioned device must contact *nothing*; today an unconfigured desktop
  build adopts the dead production URL. Shipping activation while that fallback exists means
  fresh devices still fire at Railway on every login.
- **Item 4** — `API_MODE=LOCAL_ONLY` not actually gating cloud calls. If activation is supposed
  to make the cloud optional, the switch that claims to disable the cloud should do so.

**[D-16]** Whether items 3 and 4 land inside this change or immediately alongside it. I recommend
inside — they are the same invariant.

### 11.3 The manually inserted assignment row

A device-authorisation row was inserted by hand into the disposable profile yesterday to get past
the login gate. Two consequences:

1. It should be **removed before any of this is tested**, so the grandfathering path is exercised
   against a realistic profile rather than a doctored one.
2. It must never be read as evidence that `local_device_assignment` is populated in the field.
   Backlog item 2's measurement — zero rows across all three real databases — stands, and the
   design above depends on it.

This also contradicts the closing line of backlog item 5 ("No rows were inserted to work around
this"). Worth correcting there so the record is accurate; I have not edited that document.

---

## 12. What we remove

| Removed | Location | Why |
| --- | --- | --- |
| `POST /devices/activate` server-lookup activation | `server.js:9851` | Replaced by self-proving codes; bearer token with no proof |
| `hashActivationCode` | `server.js:609` | Only consumer is the above |
| `activation_codes` as an auth mechanism | `server.js:2189` | **[D-17]** keep the table for audit/seat history, or drop it |
| `POST /api/auth/device-bootstrap-status` as a login precondition | `App.jsx:4263` | Cloud round-trip on the critical path |
| `canonical-cloud-login` health probe as a gate | `App.jsx:4249` | Same, and it is what fires at dead Railway today |
| Hardcoded `registration_status: "approved"` | `App.jsx` `fetchOnlineReferenceSnapshot` | Self-granted approval |
| `"approved"` default when the snapshot omits it | `local_db.rs:2194` | Same |
| `DEFAULT_PRODUCTION_CLOUD_API_URL` desktop fallback | `App.jsx:148` | Unconfigured must mean no target — **[D-16]** |
| `NO_SESSION` message text | `offlineSession.js:79` | Instructs the user to do something impossible; must name the local route |
| `local_device_assignment` as a *precondition* | shelved patch | Empty in every real profile |

**Kept:** `deviceSession.js` HMAC tokens (right shape for API authorisation, and the direction
`CLAUDE.md` names for the auth debt); `DEVICE_IDENTITY_CONFLICT`; the entire sync path, untouched.

---

## 13. Suggested sequencing

1. `entitlement.rs` — pure parse/verify/evaluate plus `cargo test`. No wiring. Nothing can break.
2. Migration `017`, table creation only, still unread.
3. Signing CLI plus a fixture set: valid, expired, wrong key, wrong device, malformed, truncated
   signature, unknown version, unknown key id.
4. Grandfathering + the localStorage-shadowing fix + backlog items 3 and 4. **This is where the
   laptop's failure mode is actually fixed**, and it is deliberately early.
5. File redemption path (`.frzact` import) and the activation screen.
6. Local promotion of `registration_status`; removal of the two hardcoded "approved" defaults.
7. State machine wiring, banners, and the never-stop-billing assertion in tests.
8. Rework and land `CanonicalSnapshotScope` with the four-rung non-fatal resolution.
9. Cloud side: entitlement issuance on registration, renewal, revocation list.
10. Typed code input (no bootstrap credential — first-run Owner setup instead, per §8.1).

Steps 1–4 are worth doing regardless of how the remaining decisions land — all are either pure
additions or fixes to defects already recorded in the backlog.

Per `CLAUDE.md`, anything landing runs lint, build, `backend:check`, both test suites and
`cargo check` — and the local suite in full, since several suites assert against `App.jsx` source
text.

---

## 14. Decision register — RULED (2026-08-16)

All items ruled. Where the ruling differs from the original recommendation, the change is noted.

| # | Decision | Ruling |
| --- | --- | --- |
| D-1 | Ed25519 confirmed; `minisign-verify` vs `ed25519-dalek` | **AMENDED 2026-08-16 — see §3.1.** Originally ruled "Ed25519 via `minisign-verify` for files". Implementation established that `minisign-verify` **cannot** verify a bare 64-byte signature over caller-supplied bytes (private `crypto` module, no `Signature` byte constructor, mandatory global-signature check), which §3.4 and the §4 compact layout both require. **Shipped: Ed25519 via `ed25519-dalek` 2.2.0, raw 64-byte signatures**, plus `sha2` 0.10.9 for `device_binding_hash`. Primitive unchanged. Do not revert. |
| D-2 | Key hierarchy | **Changed.** Single root key, offline, no subordinate hierarchy at all (not "A2 for now" — no hierarchy, period, at current scale). Rotation built in from day one via ≥2 baked-in key slots (§3.2) |
| D-3 | Root private key custody | Accepted as recommended: encrypted file + separate paper backup, distinct passphrase |
| D-4 | `operational_location_id` in signed payload | Accepted as recommended: excluded, sync-delivered |
| D-5 | Clock anomaly threshold, both directions | Accepted as recommended: both directions anomalous, hold current state. **See the §5.3 amendment (2026-08-16):** the high-water mark advances from corroborated server time only, floored by `issued_at` — the device clock must never write it, or both checks become inoperative. Two open policy gaps noted there for Stage 4. |
| D-6 | Snapshot scope stays non-fatal permanently | Accepted as recommended: yes |
| D-7 | Build QR delivery | Accepted as recommended: deferred, door left open |
| D-8 | Delivery formats | Accepted as recommended: file primary (WhatsApp `.lic`), typed fallback, QR skipped |
| D-9 | Device-bound only vs unbound seat codes | Accepted as recommended: device-bound only |
| D-10 | Hardware fingerprint in device binding | Accepted as recommended: no, `device_id` alone, hardware fingerprint recorded for visibility only |
| D-11 | Bootstrap Owner credential | **Changed.** Code carries the credential (file only, not typed); forced password change on first login; must be single-use, short-lived, invalid after password change — confirmed achievable as local policy, see §8.2 for the one non-cryptographic residual gap |
| D-12 | Per-user offline verifiers | **Changed.** Not built. Owner creates staff locally on-device post-activation instead (§8.3) |
| D-13 | Validity and grace lengths | Accepted as recommended: 365 days + 60 days grace |
| D-14 | Is `REVOKED` harsher than `EXPIRED` | Accepted as recommended: same capability, louder banner |
| D-15 | Grandfathered entitlement validity | Accepted as recommended: 400 days |
| D-16 | Do backlog items 3, 4 land inside this change | **Expanded.** Yes, and item 5 explicitly added — without it grandfathering does not fix the laptop (§11.2) |
| D-17 | Keep `activation_codes` for audit/seat history | Accepted as recommended: kept as history, removed from the auth path |

**Testing precondition, confirmed:** the hand-inserted `local_device_assignment` row in the
disposable profile (§11.3) must be removed before any grandfathering test runs, so the test
exercises the empty-assignment-table state every real installation is actually in. See the
correction added to `docs/backlog-1.0.72.md` item 5.

---

## 15. Boundaries observed

No production or Railway contact. No signing password requested or used. No changes to updater
metadata or `release/` — the activation keypair is new and separate from the updater's minisign
key at `tauri.conf.json:67`. Nothing under `F:\FroozERP_recovery_backups\` touched. No business
data created, deleted or reassigned. No code written; this document is the deliverable.
