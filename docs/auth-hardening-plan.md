# Auth Hardening — Scoping and Plan

**Status:** **A-1 and A-2 complete 2026-08-19.** A-3 … A-6 open. Written 2026-08-17 at the maintainer's
request, to run **in parallel** with the offline-activation stages.

| Stage | Status |
| --- | --- |
| A-1 password hashing | **Complete 2026-08-19** — see the record at the end of this file |
| A-2 remove plaintext fallback | **Complete 2026-08-19** — see the record at the end of this file. **Carries an operational action: see "Before this reaches a live database".** |
| A-3 real sessions | Open |
| A-4 middleware on all routes | Open |
| A-5 lockout + delete legacy verify | Open |
| A-6 exposure checklist | Open |
**Related:** `CLAUDE.md` "Known security debt"; `docs/offline-activation-design.md` §12 (which
rules `deviceSession.js` is *kept*); `docs/backlog-1.0.72.md`.

This is the gate on remote access. The maintainer intends multi-branch operation with multiple
devices per branch and the ability to check the business from anywhere. The first two work
today; the third cannot be turned on safely until this document is done.

---

## 1. Measured state, not remembered state

Every number below was counted in the source on 2026-08-17, not recalled.

| Fact | Measured |
| --- | --- |
| Express routes in `backend/server.js` | **212** |
| Routes carrying any auth middleware | **0** |
| `/login` issues a session token | **No** |
| Requests authenticate by | `x-user-id` header, trusted at face value |
| Password hashing | Unsalted single-round SHA-256 (`hashPassword`) |
| Plaintext fallback in `passwordMatches` | **Present** |
| `locked_until` column exists | Yes (5 references) |
| Failed-attempt lockout enforced at `/login` | **No** |

### The two that matter most

**Identity is client-asserted.** There is no middleware on any of the 212 routes. The server
takes `x-user-id` from the request header and believes it. Anyone who can reach the API can
claim to be any user, including Owner, **without a password**. Not a weak check — no check.

**`passwordMatches` accepts plaintext:**

```js
const passwordMatches = (password, storedHash) => {
  const stored = cleanText(storedHash);
  if (!stored) return false;
  return stored === hashPassword(password) || stored === String(password || "");
};
```

The second clause means any row whose password column holds a plaintext value authenticates on
that plaintext. It exists for migration compatibility and is a permanent bypass while it stays.

Unsalted single-round SHA-256 additionally means the whole user table falls to a rainbow table
the moment it leaks, and identical passwords across users are visibly identical.

### Why this has not bitten yet

The API is not reachable from the internet. Railway lapsed, and the desktop now talks to a local
gateway. **The exposure is entirely a function of reachability**, which is exactly what "check
from anywhere" changes. Nothing here is theoretical once a public host exists.

---

## 2. What is already right, and stays

- **`backend/deviceSession.js`** — HMAC-SHA256 tokens, versioned (`v1`), TTL'd (12h default),
  with `issueDeviceSession`, `verifyDeviceSession`, and `rejectDeviceSessionSubstitution`. This
  is the correct shape for API authorisation and design §12 rules it **kept**. The session work
  below extends this rather than replacing it — the substitution guard in particular is the sort
  of thing that is easy to forget when writing a scheme from scratch.
- The activation work's direction of travel: D-2 keeps every private key off the cloud host, so a
  compromise of the backend cannot mint device authority. That property must survive this work.

---

## 3. Stages

Ordered so each is independently shippable and nothing sits half-migrated. **A-1 and A-2 can be
built before A-3 without changing observable behaviour**, which is what lets this run parallel to
the activation stages.

### A-1 — Password hashing (no behaviour change)

Replace `hashPassword` with **argon2id** (preferred) or bcrypt. Store an algorithm-tagged hash so
old and new coexist: verify against the stored format, and **transparently re-hash on successful
login**. No forced reset, no user-visible change.

*Keep the SHA-256 verify path for now* — removing it before every user has logged in once would
lock people out. Removing it is A-5.

**Testable:** `node:test` over hash/verify round-trip, the tagged-format dispatcher, and the
re-hash-on-login upgrade. No route changes, so nothing else can break.

### A-2 — Remove the plaintext fallback

Delete `|| stored === String(password || "")`. Standalone and tiny, but it needs A-1's dispatcher
in place first so legacy rows still verify.

**Testable:** a plaintext-valued password column no longer authenticates; a legacy SHA-256 row
still does. This is a security regression test worth keeping forever.

### A-3 — Real sessions, issued at `/login`

`/login` returns a signed session token built on `deviceSession.js`. The frontend stores it and
sends it as `Authorization: Bearer`, replacing `x-user-id` as the identity source.

Server-side: `requireAuth` middleware verifying signature, expiry, and version; `requireRole` for
Owner/Manager gates. Token carries `user_id`, `role`, `company_id`, `branch_id`, `device_id`.

**Testable:** `backend/*.test.js` — expired, tampered, wrong-version, and substituted tokens each
rejected with their own code; a valid token resolves the right identity. `deviceSession.test.js`
already establishes the pattern.

### A-4 — Apply middleware to all 212 routes

The bulk of the work, and the only stage that must be exhaustive — one missed route is a full
bypass. Do it as **default-deny**: mount the middleware app-wide and maintain an explicit
allow-list of genuinely public routes (`/health`, `/api/version`, `/login`). A route added later
is then authenticated by default rather than open by default.

**Testable:** a generated suite that enumerates every registered route and asserts each either
requires auth or appears on the allow-list. That test, not the diff, is what proves completeness
— and it keeps proving it as routes are added.

### A-5 — Lockout, and delete the legacy verify path

Enforce `locked_until` at `/login` with a backoff, and remove the SHA-256 verify path once
telemetry shows every active user has logged in since A-1.

**Testable:** N failures set `locked_until`; a locked account refuses a *correct* password; the
lock expires.

### A-6 — Precondition for exposure (checklist, not code)

TLS only; no `x-user-id` accepted anywhere; secrets from env, never committed; rate limiting at
the edge; and a re-read of `CLAUDE.md`'s LOCAL_ONLY invariant, since a reachable API is a new way
to violate it.

---

## 4. Sequencing against the activation work

Independent — no shared files. Activation lives in `src-tauri/`, `frontend/src/local/` and
`App.jsx`'s startup path; this lives in `backend/server.js` and its middleware.

A-3 and A-4 do touch the frontend's request layer, so they should not land the same day as an
`App.jsx`-heavy activation stage. Otherwise they can proceed in parallel.

**Hard ordering:** all of A-1 … A-6 complete **before** the backend is exposed to the internet
(offline-activation Stage 9 stands the cloud back up — A-* gates the *public* part of that, not
the rebuild itself).

---

## 5. What this does not cover

- The offline/device side. Design §12 keeps `deviceSession.js` for API authorisation; entitlement
  verification is a separate trust domain and stays that way.
- Multi-tenant isolation. With auth fixed, the next question is whether every query is scoped by
  `company_id`/`branch_id`, or whether an authenticated user of one branch can read another's
  data. **Not audited.** It deserves its own pass and should not be assumed solved by A-4.

---

## 6. Boundaries

No production or Railway contact; no signing password; nothing under `release/` or the recovery
backups. Auth changes are developed against a local Postgres, per `CLAUDE.md`.

---

## A-1 record — completed 2026-08-19

### What landed

`backend/passwordHash.js` — salted, memory-hard password hashing with a self-describing stored
format, plus a verifier that dispatches on that format so every existing row keeps working.

    scrypt$v=1$n=65536,r=8,p=1$<salt-base64>$<derived-base64>

`verifyPassword` returns `{ ok, format, needsRehash }`. `format` is one of `SCRYPT`,
`LEGACY_SHA256`, `PLAINTEXT`, `UNKNOWN`, `EMPTY`. Legacy SHA-256 rows and plaintext rows still
authenticate — no forced reset, nobody locked out — and are transparently upgraded on the next
successful login by `upgradeStoredPassword` in `server.js`.

### Deviation from the plan: scrypt, not argon2id

The plan names "argon2id (preferred) or bcrypt". Both are **native modules** requiring node-gyp and
a C++ toolchain, or a prebuilt binary matching the exact platform and Node ABI. `npm --prefix
backend test` runs on the maintainer's **Windows** machine; a native dependency would need Visual
Studio Build Tools there. Breaking the maintainer's own test command to improve password storage is
a bad trade at this scale.

Node's built-in `crypto.scrypt` is memory-hard, purpose-built for password storage, has zero
dependencies, and behaves identically on Windows and Linux.

**This is not a one-way door.** Because the algorithm and parameters are stored *in the hash*,
adding argon2id later means teaching the dispatcher one more prefix and changing what
`hashPassword` emits. Existing hashes keep verifying and migrate themselves on login. The same
mechanism raises the scrypt cost later — a test covers exactly that path.

Cost was measured on the development container, not guessed: N=16384 → 53 ms, N=32768 → 88 ms,
N=65536 → 347 ms. **N=65536 (64 MiB) shipped.** Login frequency in a shop ERP is a few times per
user per day, so ~350 ms is imperceptible, and hashing cost is the primary defence if the user
table ever leaks. `crypto.scrypt`'s async form runs on the threadpool, so concurrent logins do not
block the event loop; `hashPasswordSync` exists only for the schema bootstrap, which interpolates a
hash into a SQL template literal and cannot await.

### Verified before changing anything

- **All 7 `hashPassword` and 3 `passwordMatches` call sites** were located and individually
  inspected. Every one except the schema seed sits inside an `async` function, so `await` was safe.
- **No SQL anywhere compares `password_hash` in a `WHERE` clause.** A query doing so would bypass
  the dispatcher entirely and break silently the moment hashes became salted. Checked explicitly;
  every reference is `SET password_hash`.
- **`server.js` is not shipped to the desktop.** `tauri.conf.json` ships only `desktopGateway.js`,
  `cloudProxyError.js` and `localSettingsStore.js`; the sidecar is a Node runtime that runs the
  gateway. So this change touches the cloud backend only, and carries no desktop packaging risk.

### Two existing tests changed, and why that was legitimate

`identityPolicy.test.js` asserts `server.js` **source text** contains
`passwordMatches(password, user.password_hash)`. Renaming the call broke the string match while the
test's behavioural half still passed.

Both assertions were updated to the new call (`checkPassword(...)`) rather than deleted — the
intent ("approval state cannot bypass canonical password verification") is exactly right and is
preserved verbatim. But the failure exposed a weakness in the mechanism: **a source-text assertion
silently becomes a no-op when the thing it names is renamed**, and it keeps passing. Four
behavioural regression tests were added in `passwordHash.test.js` to pin the same properties where
a rename cannot hide a regression: a new hash is never the legacy SHA-256 shape; two users sharing
a password get different hashes; a hash cannot be verified by supplying the hash as the password;
near-miss passwords are rejected.

### Gate results

| Gate | Result |
| --- | --- |
| `npm --prefix backend test` | **139 / 140** — the 1 failure is the pre-existing Linux-vs-Windows path assertion. +19 new tests. |
| `npm run backend:check` | Pass |
| `npm --prefix frontend run lint` | 0 errors, 37 pre-existing warnings |
| `npm run build` | Pass |
| `TZ=Asia/Kolkata node --test frontend/src/local/*.test.mjs` | 231 / 231 (untouched by this stage) |

### Not done here

No route behaviour changed, by design — A-1's contract is "no behaviour change". Identity is still
client-asserted via `x-user-id` on 212 unauthenticated routes; that is A-3 and A-4 and remains the
actual gate on exposing the API. **A-1 improves what happens if the user table leaks. It does not
yet stop anyone claiming to be Owner.** That distinction should not be blurred when judging whether
the backend is safe to expose.

`upgradeStoredPassword` was not exercised against a live Postgres — no database is running in this
environment. Its failure path is deliberately swallowed so a re-hash can never break a valid
sign-in, and the verify/`needsRehash` logic it depends on is covered by unit tests.

---

## A-2 record — completed 2026-08-19

### What changed

One branch deleted from `verifyPassword` in `backend/passwordHash.js`. The original
`passwordMatches` ended with:

```js
return stored === hashPassword(password) || stored === String(password || "");
```

That second clause meant **any user row whose password column held a plaintext value
authenticated on that plaintext**. It was there for migration compatibility and was a permanent
bypass while it stayed.

A stored value that is neither a scrypt hash nor a legacy SHA-256 digest now reports
`UNRECOGNIZED` and never authenticates.

### The rejection deliberately reveals nothing

An earlier draft reported the plaintext case precisely — comparing the stored value against the
supplied password so an operator could see "this row is plaintext" in the logs. That was wrong and
was removed before it shipped: the comparison would tell whoever made the request "your guess
matched, but you may not come in", which leaks the exact fact the rejection exists to protect.

The stored value's **shape** is enough to diagnose "this row was never migrated" without touching
the supplied password at all. A test asserts a correct and an incorrect guess against a plaintext
row are reported identically.

### Before this reaches a live database

**Any account whose password is still stored as plaintext can no longer sign in.** It needs an
administrative password reset. This is the intended effect — that bypass was the vulnerability —
but it is a lockout, so it should be checked for rather than discovered by a user.

The A-1 upgrade path would normally absorb this: a plaintext row that logged in once between A-1
and A-2 shipping would have been re-hashed to scrypt automatically. **That window never opened.**
The cloud backend is not running (Railway lapsed), so nobody has logged in against `server.js`
since A-1 landed, and A-1 and A-2 will reach a live database in the same deployment.

Run this against the users table **before** deploying, to find any account that would be locked
out:

```sql
SELECT id, username
  FROM users
 WHERE password_hash IS NOT NULL
   AND password_hash <> ''
   AND password_hash !~ '^scrypt\$'
   AND password_hash !~ '^[0-9a-f]{64}$';
```

An empty result means nobody is affected and A-2 is invisible. Any row returned needs its password
reset through the normal admin flow after deployment, which will write a proper scrypt hash.

Expectation, not a measurement: the schema seed writes a hash, and every create/reset path in
`server.js` writes a hash, so plaintext rows should only exist if one was inserted by hand. That
has not been verified against a real database, because none is reachable from here.

### Tests

The A-1 test asserting plaintext *works* was replaced by its inverse, which is the security
regression test worth keeping permanently: a plaintext-valued column no longer authenticates. Two
more were added alongside it — a legacy SHA-256 row still authenticates (removing the bypass must
not take the migration path with it, or everyone who has not logged in since A-1 is locked out),
and the rejection does not reveal whether the guess was correct.

### Gate results

| Gate | Result |
| --- | --- |
| `npm --prefix backend test` | **141 / 142** — the 1 failure is the pre-existing Linux-vs-Windows path assertion. +2 over A-1. |
| `npm run backend:check` | Pass |

Frontend gates were not re-run: A-2 touches one branch of one backend module and no frontend file.

### Still not fixed by this

Identity remains client-asserted. `x-user-id` is still trusted across 212 unauthenticated routes,
so anyone who can reach the API can still claim to be Owner **without any password at all** —
which makes the plaintext bypass moot in the one scenario that matters most. A-2 closes a real hole
in the password path; it does not make the API safe to expose. That is A-3 and A-4.
