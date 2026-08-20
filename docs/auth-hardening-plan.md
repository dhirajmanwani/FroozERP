# Auth Hardening — Scoping and Plan

**Status:** **A-1 … A-4 complete (A-1/A-2 2026-08-19, A-3/A-4 2026-08-20).** A-5 and A-6 open, plus **A-4b**, which is the stage that actually finishes authorisation — see the A-4 record. Written 2026-08-17 at the maintainer's
request, to run **in parallel** with the offline-activation stages.

| Stage | Status |
| --- | --- |
| A-1 password hashing | **Complete 2026-08-19** — see the record at the end of this file |
| A-2 remove plaintext fallback | **Complete 2026-08-19** — see the record at the end of this file. **Carries an operational action: see "Before this reaches a live database".** |
| A-3 real sessions | **Complete 2026-08-20** — see the record at the end of this file. **`requireAuth` is built and tested but mounted on nothing; A-4 is what closes the hole.** |
| A-4 middleware on all routes | **Complete 2026-08-20** — 268/285 routes authenticated, 16 deliberately public. **Not the end of the story: see A-4b.** |
| A-4b `updated_by` authorisation | **Open — this is now the top of the track.** After A-4 a signed-in Cashier can still act as Owner on ~63 routes. |
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

---

## A-3 record — real sessions, issued at `/login` (2026-08-20)

### What was already there, and what actually had to be built

The plan describes A-3 as if there were no sessions at all. Measured in the source first, most of
the machinery already existed and was already load-bearing for sync:

| Piece | State before A-3 |
| --- | --- |
| HMAC token module (`deviceSession.js`) | Present, v1, 12h TTL, substitution check |
| `/login` issues a token | **Yes** — `device_session_token` in the response |
| Frontend stores and sends it | **Yes** — as `x-froozerp-device-session` |
| Sync + protocol-v3 routes verify it | **Yes** |
| Token carries a `role` claim | **No** |
| `Authorization: Bearer` accepted | **No** |
| Reusable `requireAuth` / `requireRole` | **No** |

So A-3 was narrower than written, and it is worth recording *why the hole stayed open anyway*: the
signed session existed but only about a dozen routes consulted it. The other two hundred read
`x-user-id`. A token nobody checks is not authentication.

This stage builds the checker and the missing claim. Mounting it everywhere is A-4, and until that
lands the hole is still open — see "Still not fixed by this".

### `backend/authMiddleware.js` (new)

`createRequireAuth({ secret })` returns middleware that extracts the token, verifies it via
`deviceSession.js`, runs the substitution check, and sets `req.auth`. It **never reads `x-user-id`
as identity.** The only way to influence who the server thinks you are is to present a token this
server signed.

Every path that cannot positively establish identity refuses:

| Situation | Response |
| --- | --- |
| No token | 401 `AUTH_SESSION_REQUIRED` |
| Expired / tampered / wrong-version / forged | 401, each with its own existing `DEVICE_SESSION_*` code |
| Token valid but a submitted id contradicts it | 403 `DEVICE_SESSION_SUBSTITUTION_REJECTED` |
| Server has no signing secret configured | 500 `AUTH_NOT_CONFIGURED` |

There is no anonymous fallback and no development bypass. A bypass switch is the thing that
survives into production.

`requireRole(...roles)` denies when `requireAuth` has not run, when the session carries no role, and
when the allow-list is empty. "Unknown role" must never read as "any role", and an empty allow-list
is a bug at the call site that should be visible immediately rather than silently granting everyone.

### The `role` claim

`issueDeviceSession` gained a `role` parameter, emitted as a claim, and `/login` passes
`user.role_name` — the role resolved server-side, never anything the client sent. `requireRole` can
then authorise without a database round trip.

It is **deliberately excluded from the token's completeness check**: a token minted before A-3
carries no role and must still prove identity, otherwise deploying A-3 signs everyone out
mid-shift. Such a token authenticates and is refused by any role-gated route until the next sign-in.
There is a test for exactly that.

### Transport: `Authorization: Bearer`

`extractSessionToken` prefers `Authorization: Bearer <token>` and falls back to
`x-froozerp-device-session`. Same token, same signature, same verification — only the envelope
differs.

Both server-side verification sites (`resolveSyncRequestContext`, `resolveV3OperationalContext`) now
extract rather than reading the header directly, so a client sending only the standard header
authenticates on the routes that already verified sessions.

The legacy header is still sent by the frontend and still accepted. Dropping it would break sync
against any backend built before A-3 for no security gain. It goes in A-4, when the old header has
no remaining reader.

### `frontend/src/local/authHeaders.js` (new)

The session headers were written inline at five call sites across `App.jsx` and `syncService.js`.
Five copies of an authentication decision is how one of them ends up subtly different and wrong, so
they now all call `sessionAuthHeaders` / `optionalSessionAuthHeaders`. A test asserts no inline copy
comes back.

Two forms, because the existing behaviour differed and the difference is load-bearing: the
operational paths always sent the header (empty when signed out), while the sync push/pull paths
omitted it entirely. Preserved exactly. `Authorization` is never sent empty — `Bearer ` is a
malformed credential, not an absent one.

### Tests

`backend/authMiddleware.test.js` — 20 tests, registered in `backend/package.json`. The first is the
one the whole stage exists for: **a bare `x-user-id` never authenticates anyone.** If that ever
fails, the API is wide open again.

The rest pin the failures that are silent rather than loud: expired, tampered, wrong-secret,
wrong-version and garbage tokens each rejected; an `x-user-id` that *contradicts* the token refused
while one that *agrees* passes; a missing secret refusing rather than allowing; and a pre-A-3 token
still proving identity but not role.

`frontend/src/local/authHeaders.test.mjs` — 7 tests, including that both headers always carry the
same token, and that no request layer builds them inline.

Three existing source-text assertions matched the old inline header literals. They were updated to
the new form with their intent preserved, and `operationalWriteRoutes.test.js` gained a companion
assertion that no request path reads the session header for identity without verifying it — the
failure being guarded is a future call site pulling the raw header and trusting it, which looks like
authentication and is not.

### Gate results

| Gate | Result |
| --- | --- |
| `npm --prefix backend test` | **162 / 163** — the 1 failure is the pre-existing Linux-vs-Windows path assertion |
| `npm run backend:check` | Pass |
| `TZ=Asia/Kolkata node --test frontend/src/local/*.test.mjs` | **238 / 238** |
| `npm --prefix frontend run lint` | 0 errors, 37 warnings (unchanged) |
| `npm run build` | Pass |
| `cargo check` | Pass (no Rust changes this stage) |

### Still not fixed by this

**The API is not yet safe to expose, and A-3 does not make it so.** `requireAuth` exists, is tested,
and is mounted on nothing. Of 219 route registrations in `server.js`, the sync and protocol-v3
paths verify sessions; the rest still trust `x-user-id`. Anyone who can reach the API can still
claim to be Owner on those routes without a password.

That is A-4, and A-4 is the stage that actually closes the hole — which is why its completeness test
(enumerate every registered route, assert each either requires auth or is on an explicit allow-list)
matters more than its diff.

Also unaddressed, and worth recording because it is easy to miss:

- ~~**The signing secret falls back to a database credential.**~~ **Fixed 2026-08-20**, see the
  record below. It is no longer possible to *start* an exposed server on a borrowed credential.
- **No revocation on sign-out.** The token is valid for its full 12 hours regardless.
  `session_revocation_version` is carried in the claim and checked by the sync path, so the
  mechanism exists; nothing increments it.
- **Multi-tenant isolation is still unaudited** (§5).

---

## Session signing key — provenance enforced (2026-08-20)

Recorded separately from A-3 because it was found while writing that stage's record, not planned.

`deviceSessionSecret` resolved as `DEVICE_SESSION_SECRET || DB_PASSWORD || <database URL> ||
<OTP secret>`. Every entry after the first is, directly or transitively, a database credential. That
means one leaked credential did two unrelated things: opened the database, **and** forged a valid
session for any user including Owner. A forged session is indistinguishable from a real login, so
the second half is silent.

`backend/sessionSecret.js` now judges the source and graduates the response by consequence:

| Where | Dedicated key | Borrowed credential | Key under 32 chars | No key at all |
| --- | --- | --- | --- | --- |
| Exposed (`NODE_ENV=production` or a cloud deployment) | starts | **refuses to start** | **refuses to start** | **refuses to start** |
| Local | starts | starts, warns every boot | starts, warns | refuses to start |

Refusing to start is the right outcome where it applies: a server that boots with a forgeable
signing key is worse than one that does not boot, because nobody finds out.

Requiring the variable unconditionally was rejected — it would stop the maintainer's local backend
from starting on a single-maintainer project where local development *is* the normal case, and a
check that gets in the way daily is a check that gets removed. In practice the local fallback lands
on the OTP secret's hardcoded development default, so nothing breaks today.

The 32-character floor exists because a short HMAC key is recoverable offline from a single issued
token, with no rate limit in the way.

10 tests in `backend/sessionSecret.test.js`, including one asserting **no diagnostic ever contains
the key itself** — startup output lands in logs and screenshots, and a message that printed the
signing key would leak, through the very channel meant to report the problem, the thing being
protected.

### Operational note

Rotating this key invalidates every outstanding token, so everyone signs in again. That is
deliberate: it is currently the *only* revocation mechanism this system has, since nothing
increments `session_revocation_version` on sign-out.

**Before exposure:** set `DEVICE_SESSION_SECRET` to a fresh random value of at least 32 characters
(`openssl rand -base64 48`, or `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`).
An A-6 checklist item, now enforced by the server rather than by remembering.

---

## A-4 record — default-deny on every route (2026-08-20)

### The one line

```js
app.use((req, res, next) => {
  if (PUBLIC_ROUTES.has(publicRouteKey(req))) return next();
  return requireAuth(req, res, next);
});
```

**60 of 285 routes authenticated before. 268 after**, with 16 deliberately public and one
unprobeable SPA fallback. Measured by probing every registered route on the loaded app, twice —
anonymously, and with a forged `x-user-id` — not by reading the diff.

The default is the point. A route added in 2027 is authenticated because nobody did anything, and
opening one takes a deliberate edit to a list where every entry has to say what a stranger gets
from it. The inverse arrangement is what produced the 98 completely unguarded routes.

### Where it sits, and why nowhere else

The mount window is bounded on both sides, and both bounds are load-bearing:

| Must be after | Because |
| --- | --- |
| `express.json` | else `submittedIdentityFrom` reads an undefined body and the substitution check passes everything |
| `cors` | else a 401 arrives without CORS headers and the browser reports a network error, not an auth error |
| the 426 protocol gate | so an out-of-date client is told to upgrade rather than handed a 401 it cannot act on |
| the desktop-local cloud forwarder | a desktop backend *relays* most requests; refusing what it only forwards breaks the desktop app and protects nothing — the users table lives in the cloud |

| Must be before | Because |
| --- | --- |
| `registerAiBusinessAssistantRoutes` (42 routes) | mounted after, a fifth of the app is silently open |
| `registerOperationalV3Routes` (20 routes) | same |

That last pair is why **the plan's "212 routes" was wrong**: it was a `server.js` grep, and 62
routes are registered from other modules. Any completeness check that reads source text misses
them. The coverage test enumerates from the live router instead.

### Static assets: the trap in this stage

`express.static` moved *above* the gate — a 401 on the JavaScript bundle means there is no login
screen to log in from. It answers only for files that exist and calls `next()` otherwise, so it
cannot expose a route.

The SPA history fallback deliberately stayed *below* the gate. Registered early it would shadow
`/products`, `/settings`, `/sales` and every other route served off the bare root. Two tempting
alternatives were rejected as bypasses: "public = any GET not under `/api/`" makes `/products`
public, and an extension-based rule lets `GET /sales-history/1.0` through. The cost is that an
anonymous GET of an unknown non-`/api` path now 401s instead of returning the shell, which costs
nothing today — the frontend navigates with `?view=` and loads the shell only from `/`.

### The allow-list — 16 entries

`/login`, `/health`, `/api/health`, `/api/version`, `/api/system/compatibility`, `/api/time`, `/`,
`/settings/device-control`, `/api/auth/device-bootstrap-status`, `/devices/activate`,
`/bootstrap/first-owner-device`, and the five `/auth/recovery/*` pre-login routes.

The bar is **not** "authentication is awkward here" — it is "the caller provably cannot hold a token
yet". Each entry in the source states what an unauthenticated attacker gets from it.

`GET /settings/device-control` is new. The login screen needed four kiosk flags from `GET /settings`
— a route that also returns the entire users table, every authorized device, every activation code
and the backup log to anyone naming a manager's `user_id`. Splitting out the four fields is what
lets `/settings` stay authenticated instead of being allow-listed.

**`POST /bootstrap/first-owner-device` is the sharpest edge on the list.** On a fresh database
nobody can log in, so it cannot require a session; it authenticates itself and refuses once an
approved owner device exists. It should become a documented CLI action rather than an HTTP route.

Matching is exact `METHOD path` — never by prefix (which would turn `/api/health` into a pass for
`/api/health/../admin`) and never by regex. `req.path` is compared raw, so `/api/%68ealth` misses
the list and is denied: the fail-closed direction.

### Two escalations found while integrating, both fixed here

**FROST, 42 routes.** `requireAiPermission` read `req.query.user_id || req.body?.user_id ||
req.headers["x-user-id"]` — the *opposite* precedence to `submittedIdentityFrom`, which took the
header. A signed-in Cashier sending `x-user-id: <own id>` (satisfying the substitution check)
alongside `?user_id=<owner id>` got Owner authority on every FROST route. Now reads
`req.auth.userId`, and refuses rather than falling back if the claim is absent.

**The general form of it.** `rejectDeviceSessionSubstitution` compared only the *first* place a
field was supplied. That is safe only if every downstream handler reads the same one — and FROST
proved they do not. `submittedIdentityFrom` now collects **every** location a field can arrive from
and the check requires all of them to agree, so it no longer matters which one a handler happens to
read. Three regression tests cover it.

The lesson is worth keeping: *"the substitution check covers it"* was true only where a route read
the field the check had picked.

### What a legitimate caller sees change

1. The login screen now reads kiosk settings from `/settings/device-control` (wired in `App.jsx`).
   Without that change fullscreen lock would silently read as **off** on the login screen — a
   failed load rendering as a disabled feature, exactly the pattern `CLAUDE.md` forbids.
2. `/api/sync/register-device`, `/api/device/register` and `/api/device/identity` now require a
   session. The global request interceptor covers them. **Watch on hardware:** the substitution
   check now applies to their bodies, so `company_id` and `branch_id` must equal the token claims
   or the answer is 403, not 401.
3. `GET /api/cloud/health` 401s before login, so the cloud tile reads not-ready on the login
   screen. It does not block sign-in — login gates on `/api/health`, which is public.
4. Owner/Admin checks on the `/api/cloud/*` and `/api/integrations/*` routes now run against the
   session user. A client that sent `user_id=<owner>` while signed in as someone else now gets 403
   where it used to succeed. That is the fix, and it is user-visible.
5. Existing tokens keep working — same secret, same scheme, no forced re-login.

### Gate results

| Gate | Result |
| --- | --- |
| `npm --prefix backend test` | **184 / 185** — the 1 failure is the pre-existing Linux-vs-Windows path assertion |
| `backend/routeAuthCoverage.test.js` | **Passes**, and is now registered in the test script |
| `TZ=Asia/Kolkata node --test frontend/src/local/*.test.mjs` | **269 / 269** |
| `npm --prefix frontend run lint` | 0 errors, 37 warnings (unchanged) |
| `npm run build` | Pass |
| `cargo check` | Pass |

### Still not fixed by this — and A-4 must not be recorded as "auth is done"

**A-4b, the `updated_by` surface.** Roughly 63 sites decide permission from a `updated_by` /
`created_by` field in the request body. After A-4 a signed-in **Cashier can still act as Owner** on
those routes by supplying the Owner's id. A-4 converts *"anyone is Owner"* into *"any employee is
Owner"* — real progress, and not the finish line. This is now the top of the track.

Also open:

- **Sync verifies signatures only when `FROOZERP_OPERATIONAL_SCOPE_MODE=enforce`**, and the default
  is `off`. `/api/sync/push|pull|status` take identity from the request body by default.
- **The LOCAL_ONLY kill switch** (`desktopGateway.js`) is gated on `x-user-id` / `x-user-role`,
  both caller-supplied. Different process, no signing key, unreachable by `requireAuth`.
- **`/api/health` and `/api/version` disclose** `company_id`, `company_name`, `branch_id`
  unauthenticated. A-6.
- **`rateLimitSyncRequest` is keyed on a client-chosen `device_id`** and is not a control.
- **Not determined:** whether `/auth/recovery/verify-otp` enforces an attempt cap. It is
  allow-listed, so this matters, and neither the audit nor the implementation confirmed it. A-5.

### LOCAL_ONLY

Unchanged. The gate is inside `server.js`, after the desktop-local forwarder; under LOCAL_ONLY
`desktopGateway.cloudRequest` refuses before opening a socket, so `server.js` is never reached and
`blocked=true` / `reachedCloud=false` / 0 cloud-router invocations / 0 external connections all
hold. The only outbound change is an `Authorization` header on an existing `cloudFetchJson` call
already gated on `appInternetAllowed`.
