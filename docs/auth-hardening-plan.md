# Auth Hardening — Scoping and Plan

**Status:** **A-1 … A-5 (lockout) complete; A-6 written (all 2026-08-19/20).** The A-5 legacy-hash removal is blocked on a precondition, and **A-7 — branch isolation — is now the largest open item on this track.** §5's "Not audited" is now **audited and failing**: see `docs/branch-isolation-audit.md`. Written 2026-08-17 at the maintainer's
request, to run **in parallel** with the offline-activation stages.

| Stage | Status |
| --- | --- |
| A-1 password hashing | **Complete 2026-08-19** — see the record at the end of this file |
| A-2 remove plaintext fallback | **Complete 2026-08-19** — see the record at the end of this file. **Carries an operational action: see "Before this reaches a live database".** |
| A-3 real sessions | **Complete 2026-08-20** — see the record at the end of this file. **`requireAuth` is built and tested but mounted on nothing; A-4 is what closes the hole.** |
| A-4 middleware on all routes | **Complete 2026-08-20** — 268/285 routes authenticated, 16 deliberately public. **Not the end of the story: see A-4b.** |
| A-4b `updated_by` authorisation | **Complete 2026-08-20** — 92 routes across four guard families now read the verified session. See the record. |
| A-4c money-route permissions | **Complete 2026-08-20** — 13 handlers / 15 registrations. See the record. **Found a further unguarded class: see A-4d.** |
| A-4d unguarded master-data writes | **Complete 2026-08-20** — including the live `/api/v3/suppliers` path the sweep nearly missed. See the record. |
| A-5 lockout + delete legacy verify | **Lockout complete 2026-08-20. The legacy SHA-256 removal is deliberately NOT done** — its precondition is not met. See the record. |
| **A-7 branch isolation** | **Write half closed 2026-08-21 (steps 1-4).** The read exposure remains, now measured and baselined by `tenancyCoverage.test.js` rather than estimated. Still gates multibranch. |
| A-6 exposure checklist | **Written 2026-08-20** — see the record. It is a **gate**, not a summary: every unticked line is a reason not to expose the backend. |
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
- ~~Multi-tenant isolation ... **Not audited.**~~ **Audited 2026-08-20. It fails.** A signed-in
  Branch A user can read essentially all of Branch B's business data, and write into Branch B on a
  smaller set of routes. Full report: `docs/branch-isolation-audit.md`. Tracked as **A-7**, which is
  now the largest open item on this track and the gate on multibranch operation.

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

---

## A-4b record — the actor comes from the session (2026-08-20)

### The inventory was four families, not one

The plan and the audit both framed this as "~63 `requireRateManager` sites reading `updated_by`".
Measured on the tree, that framing would have left most of the hole open:

| Actor source | Sites |
| --- | --- |
| `req.body.updated_by` | 33 |
| `created_by` / `edited_by` / `changed_by` / `deactivated_by` / `reactivated_by`, alone or in `\|\|` chains | 13 |
| `req.query.user_id` / `req.query.updated_by` variants | 5 |
| locals assigned from `req.body.*` | 10 |
| helper-internal (fed by callers) | 2 |

**A grep for `req.body.updated_by` would have found 33 of 61 live escalation sites.** Three further
guard families had the same defect and were not separated out by the audit: `getPermissionUser`
(12 sites), `getSalePermissionUser` (4), and `getSettingsBundle` (1 — the guard behind VULN-2,
deciding whether the response carries the users table, every device and every activation code).

**92 routes** now read `req.auth.userId`.

### Two `|| 1` defaults were escalations in their own right

`readPurchaseEntryPayload` used `body.created_by || body.edited_by || 1`, and `createSaleHandler`
used `parsePositiveInteger(created_by) || 1`. A request that simply **omitted** the field was
attributed to user 1 — the Owner in a single-owner shop. In both cases the same value was *also*
the guard's actor and the `created_by` stamped on the row, so one change fixes the authorisation
and the false record together.

`createSaleHandler`'s version gated `pos_date_override` and `manual_pos_rate_override`.

### Where substitution was not the fix

- **`PUT /users/:id/password`** — actor and target are genuinely different people. The target stays
  `req.params.id`; only the actor moves to the session. Self-service change and manager reset both
  still work.
- **`readPurchaseEntryPayload` / `createSaleHandler`** — the field served two jobs, so the verified
  actor had to be threaded into the payload reader rather than substituted at the guard.

### Second copy of the FROST precedence bug, fixed

`resolveV3OperationalContext` still built its substitution comparison with first-match `||`
precedence — the exact narrow form `submittedIdentityFrom` was widened away from after FROST proved
handlers read a different location than the check. No escalation is known through this resolver
(it uses the token's own claims), but a second copy of a check that was deliberately fixed elsewhere
is how the fix gets quietly undone. It now collects every location.

### Not fixed — A-4c, and it moves money

**14 routes stamp a caller-chosen actor with a `|| 1` fallback *and have no authorisation check at
all*.** They are authenticated after A-4, so any employee reaches them:

`POST /accounts/payments`, `PUT /accounts/payments/:paymentKey`,
`POST /accounts/payments/:paymentKey/cancel`, `POST /customer-payments`, `POST /contra-entries`,
`POST /expenses`, `PUT /expenses/:id`, `POST /expenses/:id/cancel`, `POST /supplier-payments`,
`PUT /supplier-payments/:id`, `POST /supplier-payments/:id/cancel`, `createSaleReturnHandler`,
`createWasteEntryHandler`.

The audit trail on every payment, expense and cancellation currently records whoever the client
said, and defaults to user 1 when the client says nothing. A-4c should switch all 14 to
`req.auth.userId` **and add a real permission check** — the missing check is the larger half.

*(An earlier commit message on this branch put this at "~11 sites … audit data rather than
authorisation". Both halves were wrong: it is 14, and the routes have no authorisation at all.)*

### Also left, with reasons

- **Sync-path actors** (`context.user.id` at the offline sale edit/cancel replay,
  `requireSyncContext` on `/api/device/identity` and `/api/branch/status`) are safe **indirectly**:
  `/api/sync/push` sits behind `requireAuth` and the substitution check pins the body's `user_id`.
  That is authentication by a check in a different file rather than by construction — precisely the
  arrangement that stopped being true for FROST. It belongs to the sync-enforcement item.
- `getPermissionUser(editor.id, …)` — `editor` is already the row returned for the verified actor.

### What a legitimate caller sees change

All 15 `created_by`, 39 `updated_by`, 5 `cancelled_by`, 4 `edited_by` and 1 `changed_by` that
`App.jsx` sends are `user.id` — the signed-in user — so this is a no-op for the shipped client on
all 92 routes. Exceptions to watch on hardware:

1. **Purchases and POS sales now record the real operator.** Rows previously created without
   `created_by` were filed under user 1; reports grouped by user will show different, correct names
   going forward. Existing rows are untouched.
2. **`PUT /products/:id` audit rows** carry the session user and can no longer be `NULL`.
3. **`GET /settings`, `GET /users`, `GET /sale-rates`, the five dashboard routes** and others now
   ignore `?user_id=` entirely. A caller relying on querying as another user gets their own
   permissions.
4. **`PUT /users/:id/password`** — a manager resetting someone else's password must now hold the
   manager's session. That is the fix, and it is user-visible.

### Tests

`backend/authorizationActor.test.js` — 7 tests. Comments are stripped before pattern matching (the
new guard comment quotes the vulnerable call deliberately). Includes a **count** assertion with each
exception pinned by source line and reason, so a site added later in the old style fails; a
behavioural test that `rejectDeviceSessionSubstitution` accepts a valid session carrying
`updated_by: 1` — pinning that the auth layer never covered this and only the call sites could; and
a probe of all 92 routes on the loaded app asserting each is unreachable without a session.

The suite was verified to bite: reverting one site to the old form fails two tests.

### Gate results

| Gate | Result |
| --- | --- |
| `npm --prefix backend test` | **204 / 205** — the 1 failure is the pre-existing Linux-vs-Windows path assertion |
| `TZ=Asia/Kolkata node --test frontend/src/local/*.test.mjs` | **274 / 274** |
| `npm --prefix frontend run lint` | 0 errors, 37 warnings (unchanged) |
| `npm run build` | Pass |

### Could not determine

- Whether any client outside this repo posts an actor field different from the logged-in user. Only
  `App.jsx` and `frontend/src/local/` were verified; anything else now gets its own permissions
  instead of the id it names.
- Whether `product_audit_trail.edited_by`, `purchases.created_by` and the stock-movement actor
  columns carry NOT NULL or FK constraints. The new values are strictly better-formed than the old
  `|| 1` / `|| null` paths, but the Postgres bootstrap was not read to confirm.

---

## A-6 record — the exposure gate (2026-08-20)

### What this is

Every other stage in this document makes the backend safer. This one decides **whether it may be
reached from the internet at all**, and it is deliberately written as a gate rather than a summary:
an unticked line is a reason not to expose, not a note to revisit later.

It is written now, while the cloud is *not* running, precisely because that is the honest moment.
Written the week of a launch, a checklist becomes a list of things to argue around.

**Current verdict: DO NOT EXPOSE.** Updated 2026-08-21 after A-4c, A-4d and A-5 landed and after
branch isolation was audited. The blocking picture has changed shape rather than shrunk: the
authentication gates are now largely met, and **Gate 4 turned from an unknown into a confirmed
failure**, which is now the single reason this verdict cannot change.

### Why the timing is not urgent, and why the list still matters

There is currently **no hosted backend** — the Railway subscription is inactive, App Mode on the
maintainer's device is Local Only, and `CLOUD_TARGET_CONFIGURED` is false in the desktop gateway.
Nothing is reachable, so nothing here is presently at risk.

That is a reprieve, not a fix. The moment a cloud instance is stood up (offline-activation Stage 9),
every item below applies at once, and several take real work. The list exists so that day is a
morning of ticking boxes rather than a decision made under pressure.

---

### Gate 1 — Authentication and authorisation

| # | Requirement | State |
| --- | --- | --- |
| 1.1 | Every route requires a verified session, or is on an explicit public allow-list | **Met (A-4)** — 268/285, 16 deliberately public, proved by `routeAuthCoverage.test.js` on every run |
| 1.2 | No route derives *identity* from a request field | **Met (A-3, A-4b)** — 92 routes moved to `req.auth.userId` |
| 1.3 | Money-moving routes carry a permission check, not just authentication | **Met (A-4c, A-4d)** — 13 money handlers plus the master-data writes that rewrite balances |
| 1.4 | Failed logins are rate-limited and lock the account | **Met (A-5).** Escalating lock on `/login` **and** `/bootstrap/first-owner-device`, sharing one counter. Offline sign-in got its own lock after hardware testing showed it bypassed both |
| 1.5 | Sessions can be revoked on sign-out | **Open.** `session_revocation_version` is carried in the token and checked by the sync path; nothing increments it. Today the only revocation is rotating the signing key, which signs everybody out |
| 1.6 | The legacy SHA-256 verify path is removed | **A-5 — open.** Requires evidence every active user has signed in since A-1 |

### Gate 2 — Secrets and transport

| # | Requirement | State |
| --- | --- | --- |
| 2.1 | `DEVICE_SESSION_SECRET` set explicitly to a fresh random value ≥32 chars | **Enforced by the server** — an exposed instance refuses to start on a borrowed credential. Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"` |
| 2.2 | No secret is committed to the repository | **Believed met, unverified.** Run a secret scan before the first deploy rather than trusting recall |
| 2.3 | TLS terminates in front of the app; no plaintext HTTP listener is reachable | **Not configured.** Sessions are bearer tokens: over plaintext, one interception is a full account takeover |
| 2.4 | `trust proxy` set correctly if behind a load balancer | **Not set.** Without it `req.ip` is the proxy's address, so every per-IP control and every audit row records the wrong origin |
| 2.5 | CORS allow-list contains real origins and never `*` | **Partly met.** `cloudConfigurationChecks` already asserts this for the cloud backend. The **desktop gateway still sends `access-control-allow-origin: *`** — acceptable while it is loopback-only, and it must never be exposed |

### Gate 3 — What an unauthenticated caller can still learn

| # | Requirement | State |
| --- | --- | --- |
| 3.1 | Public routes disclose nothing about the business | **Met 2026-08-22.** Identity, database path, storage kind and deployment posture now require a session on `/api/health`, `/health` and `/api/version`; an anonymous caller gets liveness, version and a `tenant_configured` boolean. Proved by `publicDisclosure.test.js`, which asserts a **denylist over the whole response body** rather than a list of known keys, so a field added later is caught by default. Closing this also uncovered that a `req.auth ?` gate on a public route withholds fields from *everyone* — `requireAuth` never runs there — so `createAttachOptionalAuth` now populates a session on the allow-list without ever denying |
| 3.2 | Device-status and activation routes are rate-limited | **Met 2026-08-22.** Both, plus `/auth/recovery/send-otp` and `/auth/recovery/options` — the last added here, because its answer differs for an account that exists and one that does not, which unlimited makes it an enumeration oracle. 10 attempts per 10 minutes, keyed on the caller's address and nothing they supply. `publicGuessSurface.test.js` derives the check **from the allow-list itself**, so a public route added later cannot skip it silently, and asserts the throttle runs *before* the handler's first query — a limiter that runs after the lookup has already answered the question. `POST /login` is exempt with its reason and its residual risk written down: a per-account lock does nothing against one password sprayed across many accounts, and an address limit is withheld because a shop is one address and locking the counter out of billing is the worse failure |
| 3.3 | `POST /bootstrap/first-owner-device` is not reachable from the internet | **Met 2026-08-22.** Never served on a hosted deployment, whatever the environment says — structural rather than configurable, because a hole that opens when a variable happens to be set is no more closed than one that closes that way. Closed by default elsewhere behind a deliberately awkward opt-in. The refusal is emitted **before the body is read and before any password comparison**, which is the actual control: a refusal after the comparison still answers the attacker through the failed-attempt counter. `scripts/bootstrap-first-owner.mjs` is the replacement, moving the trust boundary to shell access on the server; it prompts for the password rather than taking it as an argument, and keeps the route's "an owner device already exists" refusal. Proved by `ownerBootstrapPolicy.test.js`, which pins the ordering as well as the policy |
| 3.4 | Recovery routes are rate-limited and OTP attempts are capped | **Met — and it already was.** Verified 2026-08-22: `/auth/recovery/verify-otp` caps at five attempts on the recovery record and answers `OTP_ATTEMPTS_EXCEEDED`. It was never unimplemented, only unverified, which is its own kind of problem: an unconfirmed control gets planned around as though it were absent. The cap lives on the record rather than on the address, so changing address does not reset it, and it is checked before the code is compared. Now pinned by `publicGuessSurface.test.js` — nothing tested it before, so it could have regressed without anyone noticing |

### Gate 4 — Isolation between tenants

| # | Requirement | State |
| --- | --- | --- |
| 4.1 | Every query is scoped by `company_id` / `branch_id` | **Reassessed 2026-08-22 after the maintainer ruled one company with multiple branches — see `docs/tenancy-backfill-plan.md`. Branch isolation is the requirement that applies, and Phase 1 delivered it: 37 unscoped GET routes to 2, both of which read company-wide master data that a single-company installation cannot leak. Company-level scoping is not applicable until a second company exists.** Original finding, kept because it is what the ruling reinterprets rather than erases — **audited 2026-08-20, FAILED:** `req.auth.branchId` and `req.auth.companyId` have **zero read sites** in the entire backend. 119 of 285 registrations return or write business data with no tenancy predicate. See `docs/branch-isolation-audit.md` |

~~**This is now the single reason the verdict at the top cannot change.**~~ It stopped being the
document's largest *unknown* and became its largest *known failure*, which is progress only in the
sense that it could then be planned. Tracked as **A-7**, originally estimated 3–4 weeks.

> **Superseded 2026-08-22.** Phase 1 landed the branch scoping, and the maintainer then ruled the
> installation is one company with multiple branches. Branch isolation is therefore the real
> requirement and it is met; the company-level work is not applicable. **Gate 4 is no longer what
> holds the verdict.** What now holds it is Gate 3 in full, plus 1.5, 1.6, 2.2 and 2.3 — a list of
> days, not weeks. The estimate above is left visible because a 3–4 week figure that quietly
> vanished would look like it was delivered rather than ruled out of scope.

Latent while one branch exists — there is no second branch's data to leak — and live the moment
there is one. Because the maintainer's first product goal *is* multibranch, this gates the goal and
the exposure together.

### Gate 5 — Operational

| # | Requirement | State |
| --- | --- | --- |
| 5.1 | The plaintext-password query has been run against the live database | **Outstanding, now self-reporting** — the server counts legacy hashes at every cloud startup (see the A-5 record). Any account it names cannot sign in after A-2 and needs an admin reset |
| 5.2 | A restore has been tested from a real backup, not just taken | Untested |
| 5.3 | Logs do not contain tokens, passwords or OTPs | Unverified |
| 5.4 | LOCAL_ONLY invariants re-read and re-tested after exposure work | `desktopGatewayOwnerControl.test.js` asserts them on the gateway paths; re-run after any cloud change |

---

### The three that would hurt most

Not a ranking of severity so much as of regret:

1. ~~**1.4 — no lockout.**~~ **Closed by A-5**, on both password-verifying routes and offline.
2. **4.1 — tenant isolation. Now the top item, and no longer a guess.** Audited and failing.
   Unknown risk became known risk, which is worse to look at and far better to have.
3. **3.3 — `first-owner-device` on the public list.** A route that hands out an approved device on a
   correct password guess, published to the internet. A-5 rate-limits it now, which lowers the
   severity without removing the reason it should be a CLI action instead.
4. **2.3 — no TLS.** Sessions are bearer tokens. Over plaintext HTTP, one interception is a full
   account takeover, and no amount of work in Gate 1 survives it. Cheap to fix and easy to forget,
   which is a bad combination.

### How to use this

Work top to bottom and tick in the table itself. When every line is met, the verdict at the top
changes and the reason is auditable. If a line is going to be waived, write *why* next to it —
a waiver with a reason is a decision, and an untracked exception is how the checklist stops meaning
anything.

---

## A-4c record — permissions on the money routes (2026-08-20)

### The count was wrong in both directions

The A-4b record said 14. Measured: **13 handlers, 15 HTTP registrations** —
`createSaleReturnHandler` and `createWasteEntryHandler` are each mounted twice, at the bare path and
under `/api/v3/`. All 13 confirmed to have had no authorisation call of any kind.

One further correction: `POST /contra-entries` had **no** `|| 1`. It wrote
`parsePositiveInteger(req.body.created_by)` — caller-chosen or NULL. The other 12 defaulted to
user 1.

### Two new permission keys, and why not to reuse

`customer_payments`, `supplier_payments`, `invoice_cancellation`, `billing` and `waste_management`
already fit their routes exactly. Two did not:

- **`expenses`** — the closest existing key is `reports`, which is literally what `App.jsx`'s
  `modulePermissionMap` gates the Expenses screen on. Reusing it was rejected: *"can read reports"*
  silently granting *"can spend the shop's money"* is invisible in the role table the maintainer
  actually edits. The distinction has to exist in the name.
- **`contra_entries`** — cash↔bank treasury movement is neither a customer nor a supplier
  settlement. No shipped screen posts to this route at all.

### `POST /accounts/payments` needs two keys, not one

One route, two money movements. A Cashier is seeded `customer_payments: true` and
`supplier_payments: false`, so a single key would have been wrong in one direction. The key follows
the `(payment_action, account source)` pair the request will actually take. An unrecognised pair
gets no key and falls through to the pre-existing 400 — no branch writes before that point.

### Cancellation is stricter than creation

Cancelling a payment or an expense requires the domain key **and** `invoice_cancellation`. Recording
a real payment and then quietly voiding it is the classic fraud path, and an expense one person can
both enter and void is an untraceable withdrawal.

`createSaleReturnHandler` was **deliberately left on `billing` alone.** A return refunds money and
is arguably a partial void, but returns are counter work a Cashier does all day, and requiring the
void key would have stopped the counter working on the first restart after upgrade. A judgement
call, recorded as one rather than left to look like an oversight.

### What happens to an existing installation

Three idempotent startup statements, each guarded on the key being absent so a restart never
overwrites a later decision:

1. Owner/Admin get `expenses: true` outright — the client treats both as all-modules roles, so an
   Admin with Reports unticked would otherwise see the screen and be refused by the server.
2. **Every other role inherits its own stored `reports` value into `expenses`.** On the seeded roles
   that is Purchase Manager `true`, Inventory Manager `true`, Cashier `false` — *identical to who
   can reach the Expenses screen today*, including any per-shop customisation. **Nobody who records
   expenses this week is locked out next week**, which was the explicit bar: a migration that stops
   a shop recording expenses on Monday morning is worse than the hole it closes.
3. `contra_entries`: `true` for Owner/Admin, `false` for staff roles. No population to preserve.

### The frontend half, without which this is unusable

Enforcement alone would have been worse than nothing in two specific ways, both fixed here:

- **The keys had no labels**, so they were enforced on the server and invisible in
  Settings → Role Permissions. A key that cannot be seen cannot be granted.
- **The Cancel buttons were not role-gated**, so a Cashier would have kept a clickable button that
  now always 403s. Both are disabled with a reason, gated on the same `canCancelSales` the invoice
  Cancel button already uses — the same rule as `autoConnectivityAvailability.js`: an action that
  cannot succeed must not render as available. `canCancel` defaults to `false`, so a future call
  site that forgets the prop denies rather than permits.

### What changes for a legitimate caller

No change for: Owner, Admin, Cashier recording customer payments and sale returns, Inventory Manager
recording waste, Purchase Manager recording supplier payments, all four manager roles on expenses.

**Changes, each surfacing as a permission-denied message:**

1. A **Cashier paying a supplier** from the Accounts screen → 403. The Accounts module is visible to
   a Cashier by a hardcoded frontend default, but `supplier_payments` is seeded `false`. If a shop's
   cashier genuinely pays suppliers, tick Supplier Payments for Cashier.
2. A **Purchase Manager receiving a customer payment** → 403, same shape, same remedy.
3. **Cancel buttons** are now disabled for anyone without Invoice Cancellation.
4. **Audit values change going forward.** Rows previously filed under user 1 because the client
   omitted the field now carry the real operator. Existing rows are untouched.

### Gate results

| Gate | Result |
| --- | --- |
| `npm --prefix backend test` | **213 / 214** — the 1 failure is the pre-existing Linux-vs-Windows path assertion |
| `TZ=Asia/Kolkata node --test frontend/src/local/*.test.mjs` | **313 / 313** |
| `npm --prefix frontend run lint` | 0 errors, 37 warnings (unchanged) |
| `npm run build` | Pass |

---

## A-4d — unguarded master-data writes (open, found during A-4c)

A sweep for *every* write route with no guard found the same defect outside the money list:

- **`POST /accounts`, `PUT /accounts/:accountKey`** — no permission check, no actor at all, and they
  write `opening_balance`, which the ledger renders directly as `outstanding_balance` /
  `payable_balance`. Any signed-in employee can restate what a customer or supplier owes.
  **Arguably worse than several routes A-4c just fixed**, because it rewrites history rather than
  adding to it.
- **`POST /suppliers`, `PUT /suppliers/:id`, `DELETE /suppliers/:id`, `POST /customers`,
  `PUT /customers/:id`** — same class, same `opening_balance` field.
- **`POST /api/whatsapp/send-document`** — no check, despite a `whatsapp_send` key existing for
  exactly this.
- `sale_rate_history.changed_by` still has an `actorId || 1` in the opening-stock helper. Dead today
  (A-4b made `actorId` the session), but the same latent user-1 attribution.

### Not determined

- Whether a queued offline entry can be replayed by a *different* signed-in user than the one who
  created it. If it can, the stamp becomes the replaying user. `/api/sync/push` handles only
  `sync_test` and `pos_sale`, so expenses/returns/waste replay over the same HTTP routes and are
  covered — but the general question was not traced to the end.
- Whether `contra_entries.created_by`, `expenses.created_by` and the payment actor columns carry
  NOT NULL/FK constraints. The new values are strictly better-formed than the `|| 1` path.

---

## A-4d record — master-data writes (2026-08-20)

### The routes that rewrite what people owe

`POST/PUT /accounts`, `POST/PUT/DELETE /suppliers`, `POST/PUT /customers` and
`POST /api/whatsapp/send-document` had **no authorisation call of any kind**. They write
`opening_balance`, which the ledger renders directly as `outstanding_balance` / `payable_balance` —
so any signed-in employee could restate what a customer or supplier owed. That rewrites history
rather than adding to it, which is why this was ranked above several routes A-4c fixed.

Two corrections to the A-4d note written at the end of the A-4c record: `POST /accounts` has
**three** destination tables (customers, suppliers, and the generic `accounts` ledger for
`STAFF`/`OTHER`), not two; and `DELETE /suppliers/:id` is a **deactivation** (`active = FALSE`), not
a hard delete.

### The route the sweep nearly missed, and the lesson in it

The shipped Accounts screen posts **all** supplier saves to `/api/v3/suppliers` in
`operationalV3.js`, not to `/accounts`. So the supplier branch of `POST /accounts` is **dead from
the client**, and guarding only the routes the sweep named would have closed an API hole while
leaving the path a Cashier actually uses to rewrite a supplier's `opening_balance` completely open.

`operationalV3.js` contained **zero** permission calls across all 20 of its routes. The three
supplier master writes now declare `permission: "supplier_accounts"` through a new option on the
module's own route guard, with the authorizer injected from `server.js` so the module stays free of
it. **A declared permission with no authorizer wired in refuses with 500** rather than falling
through — a wiring mistake must not become a silent bypass on the routes that most need a check.

That guard immediately bit: `operationalV3.test.js` registered routes without an authorizer and
started failing. The harness was corrected to wire one; the guard was not weakened.

*The lesson worth keeping: "this route is unguarded" and "this route is reachable from the app" are
different questions, and fixing only the first can produce a stage that reports success while the
live exposure stands.*

### Keys

| Route | Key |
| --- | --- |
| `POST /accounts` | `customer_accounts` (CUSTOMER) / `supplier_accounts` (all others) |
| `PUT /accounts/:accountKey` | keyed on the `CUSTOMER-` / `SUPPLIER-` / `ACCOUNT-` prefix |
| `POST/PUT/DELETE /suppliers`, `POST/PUT/DELETE /api/v3/suppliers` | `supplier_accounts` |
| `POST/PUT /customers` | **`customer_accounts`** (new) |
| `POST /api/whatsapp/send-document` | `whatsapp_send`, actor moved to `req.auth.userId` |

**`customer_accounts` is new rather than reusing `supplier_accounts`**, which fails both A-4c
criteria at once: "Supplier Accounts" silently granting authority over *customer* ledgers is
invisible in the role table the maintainer edits, and `supplier_accounts` is seeded **false for
Cashier**, so reuse would have stopped a shop's cashier adding a customer on the first restart.

**`DELETE /suppliers/:id` deliberately takes the same key as create/edit**, not a stricter one.
A-4c made cancellation stricter because a void destroys a recorded movement; this sets
`active = FALSE`, is reversed by the edit route, and loses no balance or history. A second authority
would only block housekeeping.

### The migration keeps everyone who has access today

Two idempotent statements: Owner/Admin/Cashier/Purchase Manager get `customer_accounts: true` (the
four roles the client hardcodes the Accounts module open for), then every other role — including
custom ones — inherits the same OR-expression the frontend gate uses rather than a flat value. On
the seeded rows Inventory Manager lands `false`, which is already what it sees. **Nobody loses
customer master access.**

### The one place access is genuinely removed — and it is not migrated

**`whatsapp_send` is seeded `false` for Cashier, Purchase Manager and Inventory Manager.** Nothing
has ever read that key, so enforcing it removes WhatsApp sending from those three roles on POS
invoices, payment receipts, account ledgers and reports.

No migration was added to re-grant it. This is the one deliberate departure from A-4c's
"nobody loses access" bar, and the distinction is real: for `expenses` there was **no existing key
expressing intent**, so a seed had to be chosen and copying `reports` preserved behaviour. Here the
maintainer's key already exists with an explicit `false`. Overwriting it under cover of a security
fix would be the tool deciding shop policy.

**Consequence, stated plainly: a Cashier sending a bill on WhatsApp after billing is core counter
work, and it stops.** Remedy is one tick — Settings → Role Permissions → WhatsApp Send. All four
WhatsApp buttons are disabled with a title explaining why, so it is a visibly unavailable action
rather than a failed request; Print and Save/Export PDF beside them are untouched, so the manual
share path survives for every role.

**This needs the maintainer's decision, not a default.**

### Also changed

`sale_rate_history.changed_by` had `actorId || 1` in `insertOpeningStockLot`. Removed: both callers
resolve the actor from a permission check first, and `changed_by` is NOT NULL, so an unattributable
rate change now fails the insert rather than being filed under user 1.

### Still open

- **`customers`, `suppliers` and `accounts` carry no actor column at all** — no `created_by` /
  `updated_by`. Even after this stage, *who* restated an opening balance is unrecorded. Adding the
  columns means editing the startup bootstrap path.
- The frontend still sends `sentByUserId` in the WhatsApp body. The server ignores it.
- **Not verified against a real Postgres.** No database exists in the development environment, so
  the migration SQL is verified by construction and source assertion only. Worth one manual check on
  a disposable database before release.

### Gate results

| Gate | Result |
| --- | --- |
| `npm --prefix backend test` | **228 / 229** — the 1 failure is the pre-existing Linux-vs-Windows path assertion |
| `TZ=Asia/Kolkata node --test frontend/src/local/*.test.mjs` | **313 / 313** |
| `npm --prefix frontend run lint` | 0 errors, 37 warnings (unchanged) |
| `npm run build` | Pass |

---

## A-7 — branch isolation (audited 2026-08-20, failing)

Full report: **`docs/branch-isolation-audit.md`** (896 lines, line-numbered). Summary and the four
claims I verified myself before accepting it:

### The finding in one line

**`req.auth.branchId` and `req.auth.companyId` have zero read sites in the entire backend.**
Verified: `grep -c "req.auth.branchId\|req.auth.companyId"` returns **0** in `server.js`,
`operationalV3.js` and `aiBusinessAssistantService.js`. A-3 put verified `company_id` / `branch_id`
into every token; nothing has ever consumed them. There is no row-level security in the schema
either.

So A-4 established *who you are* and A-4b/c/d established *what you may do* — and neither asks
*whose data this is*.

### Measured surface

285 registrations. **119 return or write business data with no tenancy predicate at all**: 69
branch-level in `server.js` (42 reads, 27 writes), 8 against untenanted tables, 42 FROST. 53 are
correctly scoped — all of them in `operationalV3.js` / `scopeManagement.js`, which are a genuinely
sound multi-tenant design and should not be disturbed.

### The two I verified in the source

**Reads.** `GET /reports/summary` spans lines 15012–16113 — **1,101 lines containing zero
occurrences of `branch_id` or `company_id`.** Counted directly. The same holds for `/reports/day-book`,
`/reports/balance-sheet`, `/reports/cash-book`, the dashboard, `/sales`, `/sales-history`, the
customer and supplier ledgers, `/accounts/ledger`, `/inventory` and `GET /users`. **No crafted
request is needed — the shipped frontend already calls these**, so the first symptom of adding a
second branch is that every report silently includes it.

**Writes.** 22 handlers are registered twice: once behind `v3WriteAdapter`, once on a legacy path
with no adapter. Inside, the scope filter reads:

```sql
WHERE id = $1 AND ($2::INTEGER IS NULL OR company_id = $2)
```

bound from `req.v3OperationalContext?.company_id || null`. On the legacy path that context is
`undefined`, `$2` is NULL, the conjunct is **true**, and the row is selected **by primary key
alone**. Verified at `server.js:11616-11620` and 30 sibling sites. It fails *open*: `PUT /lots/<id>`
rewrites another branch's lot, and the change then publishes to that branch attributed to a foreign
actor.

### `enforce` does not fix it, and `shadow` does nothing

`FROOZERP_OPERATIONAL_SCOPE_MODE` defaults to `off` and nothing in the repo sets it. Even set to
`enforce`, its 426 gate is a token-boundary regex, so hyphenated siblings escape: **64 of 216 routes
blocked, 152 still reachable** — including `/stock-inventory`, `/customer-ledger`, `/supplier-ledger`,
every `/dashboard-*`, `/sales-history*` and all 42 `/api/ai/*`. `shadow` is accepted by the
normaliser and never branched on, so it behaves exactly as `off`.

**Anyone tempted to "just turn on enforce" should read that paragraph twice.**

### Severity, stated honestly

This is **latent, not live**, while the business runs a single branch: with one branch there is no
other branch's data to leak. It becomes real the moment a second branch exists — and the failure
mode is quiet. Cross-branch totals look like an accounting mistake, not a breach, and leave no
artefact.

**It is the gate on multibranch, which is the maintainer's first stated product goal.**

### Direction

Not a middleware problem and not a query-helper problem: `server.js` builds SQL by interpolation
with dynamic `$n` arithmetic, so a wrapping helper would be silently wrong somewhere. Recommended
sequence: fix the device routes → delete the fail-open defaults → build a two-branch coverage suite
→ thread scope through the remaining handlers → Postgres RLS as the backstop. **3–4 weeks**, and it
deserves its own stage rather than a bullet under A-6.

**The cheapest structural win: 22 of these handlers already have a correct v3 twin.** Deleting the
legacy registration is smaller and far more verifiable than scoping them by hand.

### Also found

- `PUT /settings/devices/:deviceId` can re-point *any* device into *any* branch (role check only, no
  scoping on the target), and `assigned_branch_id` is not one of the four fields the substitution
  check covers. `/login` then mints a **legitimately signed** token for that branch. Possible
  escalation, not just corruption.
- `logSyncChange` has `branchId = 1` as a **default parameter**; there is a hard-coded
  `branchId: 1` at `server.js:11440`; and `POST /users`' `|| manager.branch_id ||` is dead code, so
  it is always `req.body.branch_id || 1`.
- Eleven money routes write `NULL` branch, invisible to `branch_id = $n` and counted as Branch 1 by
  `COALESCE(branch_id, 1)`.

### Not determined

- The live `FROOZERP_OPERATIONAL_SCOPE_MODE` value on Railway. Not investigated — production is out
  of bounds.

### Process note

The audit agent disclosed running one `git status` despite being told not to run any git command.
Read-only, output discarded, no `.git/index.lock` left behind and the index intact — but recorded
here rather than dropped, because the instruction existed to prevent concurrent agents racing on
the index and "it turned out fine" is not the same as "it was safe".

---

## A-5 record — failed-login lockout (2026-08-20)

### A column, a check, and nothing in between

`users.locked_until` has existed for a long time, and `/login` already refused a sign-in while it
was in the future. **Nothing ever set it.** The only statement touching the column *cleared* it, so
the guard was unreachable — password guessing against `/login` was unlimited, which is exactly why
the API cannot be exposed even after A-1 fixed the hashing.

This stage is the missing half: `backend/loginLockout.js`, pure and free of clock or database, so
every branch could be tested. Each branch is a decision about locking a real shopkeeper out of
their own till, which is the reason it is a separate module rather than inline SQL.

### The policy, and the reasoning behind the shape

| Consecutive failures | Result |
| --- | --- |
| 1–4 | nothing |
| 5th | 1 minute |
| 6th | 2 minutes |
| 7th | 5 minutes |
| 8th | 15 minutes |
| 9th | 30 minutes |
| 10th and beyond | 1 hour (capped) |

**A short streak is a typo; a long one is an attack.** People mistype passwords at a counter, in a
hurry, on a keyboard they are not looking at. The first few failures cost nothing and the curve then
climbs steeply — barely noticeable to a human, an hour per ten guesses for a script.

**The streak decays after 15 minutes.** Without it, four typos spread across a year would meet a
fifth and lock an account that has never been attacked. A failure that is not part of a burst is not
evidence of anything.

**A locked account refuses the correct password too.** If the right password lifted the lock early,
an attacker who guessed it would never learn the lock existed, and the lock would fail at the only
moment it mattered.

**The lock expires by itself, and the escalation stops at an hour.** A permanent lock needing an
administrator turns a nuisance attack into a denial of service against a shop that may have nobody
awake to unlock it. An unbounded lock is a denial of service dressed as security.

**The message states the wait, never the policy** — naming the threshold hands an attacker the
tuning for free and tells a legitimate user nothing they can act on. Remaining time is rounded
*up*: "try again in 1 minute" when 61 seconds remain earns a second failed attempt and justified
annoyance.

### The route that would have made this theatre

Locking `/login` alone would have been close to pointless. **`POST /bootstrap/first-owner-device` is
on A-4's public allow-list, verifies the Owner's password, and had no limit of any kind.** An
attacker would simply have guessed there instead — against the single most valuable account in the
system, with no session required.

It now shares the same lock and the *same counters*, so a streak accumulated on either route locks
both. Two independent counters would have halved the cost of guessing: alternate routes, never trip
either threshold. There is a test asserting exactly one shared counter.

That route stays on the "no permission check by design" list in
`masterDataAuthorization.test.js` — it authenticates itself, so there is no session to check a
permission against — but the entry now records that "no permission check" no longer means
"unlimited guessing".

### Bookkeeping never breaks a sign-in

Both counter updates are wrapped and swallowed. A failure there must never turn a wrong password
into a 500: that would tell an attacker their guess was interesting, and would break sign-in for
everyone the moment the column was missing.

A successful sign-in clears the streak and the lock. Without that the counter only ever climbs, and
a user who mistyped four times last week is locked by their next single slip.

Locking is written to `auth_audit_log` as `ACCOUNT_LOCKED` with the streak length and the unlock
time, so a lockout is explicable after the fact rather than mysterious.

### The other half of A-5 is deliberately NOT done

The plan pairs the lockout with **removing the legacy SHA-256 verify path**, gated on this
condition, quoted from the plan itself:

> remove the SHA-256 verify path once telemetry shows every active user has logged in since A-1.

**A-1 landed on 2026-08-19 — yesterday.** Nobody except the maintainer has signed in since. Removing
the legacy path today would lock out every user whose password has not yet been re-hashed, which is
very likely all of them. That is not a judgement call; it is the precondition plainly not being met.

**Precondition, to be checked before the removal:**

```sql
SELECT COUNT(*) AS still_legacy
  FROM users
 WHERE active = TRUE
   AND password_hash ~ '^[0-9a-f]{64}$';
```

`0` means every active user has signed in since A-1 and the legacy branch in
`backend/passwordHash.js` can be deleted along with its tests. Any other number is the list of
people that removal would lock out.

Until then the legacy path stays, and A-5 is **half complete by design** rather than by oversight.

**The count is now printed at every cloud startup** (`reportLegacyPasswordHashes`) rather than left
as a query in this document. The answer changes silently as people sign in, and a number nobody is
watching is a number nobody knows. Only the count is reported — no usernames, no ids, because a
startup log naming accounts with weak hashes is a list of targets. It is never fatal.

### Why this is not unblocked by "the other accounts are only samples"

The maintainer confirmed on 2026-08-20 that only their own account is real. That removes the
*"other users would be locked out"* objection — but **not the one that matters**, which points at
their own account:

`passwordHash.js` is only ever reached by the **cloud** backend. `desktopGateway.js` never uses it.
The cloud has been down (Railway lapsed) for the whole period since A-1, so nobody has signed in
*against Postgres* since the re-hash-on-login path existed. The maintainer's own hash there is
therefore almost certainly still the legacy format.

**Removing the legacy path today would lock out the one account that matters, the moment the cloud
comes back.** The precondition stands, and it is now self-reporting: sign in once after the cloud
returns, watch the startup line say 0, then delete the path.

Deleting sample user rows was offered and declined — it would not have helped (the risk is the
maintainer's own row, not the samples), and deleting business data to satisfy a check is a
`CLAUDE.md` boundary regardless of how little the data is worth.

### Gate results

| Gate | Result |
| --- | --- |
| `npm --prefix backend test` | **251 / 252** — the 1 failure is the pre-existing Linux-vs-Windows path assertion |
| `TZ=Asia/Kolkata node --test frontend/src/local/*.test.mjs` | **313 / 313** |
| `npm --prefix frontend run lint` | 0 errors, 37 warnings (unchanged) |
| `npm run build` | Pass |

23 tests on the policy and its wiring, including that the lock is consulted *before* the password
on both routes — a lock checked afterwards would let a correct password through and defeat the
mechanism entirely.

### Not verified

Not exercised against a real Postgres; there is no database in the development environment. The two
new columns and both UPDATE statements are verified by construction and source assertion only.
Worth one check on a disposable database before release.

---

## A-7 steps 1–4 record — the write half, and a measurement for the rest (2026-08-21)

The audit split branch isolation into two risks with different profiles: **write corruption**,
which can damage data, and **read exposure**, which is dormant until a second branch exists. These
four steps close the first and make the second countable.

### Step 1 — the duplicate write routes

22 handlers were registered twice, once behind `v3WriteAdapter` and once on a bare legacy path. The
scope filter reads `($2::INTEGER IS NULL OR company_id = $2)` bound from
`req.v3OperationalContext?.company_id || null`; on the legacy path that context is `undefined`, so
`$2` is NULL, the conjunct is true, and **the row is selected by primary key alone.** It fails open.

All 24 legacy write paths now refuse with 426 and name their replacement.

- **Unconditional**, not gated on `FROOZERP_OPERATIONAL_SCOPE_MODE`. That defaults to `off`,
  nothing in the repository sets it, and a hole that closes only when an environment variable
  happens to be set is not closed.
- **An explicit list, not a pattern.** `LEGACY_OPERATIONAL_ROUTE` ends each alternative with
  `(?:\/|$)`, so hyphenated siblings escape — the audit measured 64 of 216 routes actually blocked
  under `enforce`. Parameters now compile to exactly one segment.
- **Placed after the auth gate.** Ahead of it, a stranger probing a retired path would learn it
  exists and get an upgrade hint rather than a refusal; three route-coverage tests failed when it
  was first put there.
- **The replacement is recorded per route**, not derived. Seven were renamed rather than
  re-prefixed — `/purchase-bill` → `/api/v3/purchase-bills`, `/products/:id/cancel` →
  `.../deactivate`. The derived mapping was wrong for a third of the list, and the test comparing it
  against real registrations is what caught that.

### Step 2 — device re-pointing

`PUT /settings/devices/:deviceId` had a role check and nothing else: any Owner or Admin could
rename, disable or re-point **any device in the database** into **any branch**. `/login` mints the
branch claim as `operationalAssignment?.branch_id || device.assigned_branch_id || ...`, so this
produced a *legitimately signed* token for another branch — escalation, not merely corruption.

Now scoped to the actor's company, with the target branch required to exist, be active, and belong
to that company. Validated before the update. A device outside the company gets the same 404 an
unknown id gets, because a distinct "not yours" confirms it exists.

**This is the first consumer of `req.auth.companyId` in the entire backend.** The audit's headline
finding was that it and `req.auth.branchId` had zero read sites; a test now asserts that count stays
above zero.

*Correction recorded:* mid-task I concluded the schema had no company-to-branch relationship and was
ready to report that scoping was impossible. It exists — `branches.company_id` and
`authorized_devices.company_id`, added by cloud migrations 005 and 006 in
`backend/migrations/cloud/`, a directory I had not searched. The relationship was there; the search
was not.

### Step 3 — the Branch 1 defaults

27 `|| 1` fallbacks exist; most are harmless in a single-branch business and stay. Two were not:

- **`POST /users`** used `parsePositiveInteger(req.body.branch_id) || manager.branch_id || 1`, whose
  middle term is dead code — `requireRateManager` selects only id, full_name and role_name. What ran
  was `req.body.branch_id || 1`: any branch of any company, unvalidated, or Branch 1 by omission.
  Now validated against the actor's company, falling back to the actor's own verified branch.
- **`logSyncChange`** defaulted `branchId` to 1. All 21 callers override it, so it was never
  exercised and was waiting for caller 22. Now required, and throws. A change-log row is what every
  other device replays; one attributed to the wrong branch does not fail, **it propagates**.

### Step 4 — the measurement

`backend/tenancyCoverage.js` drives every GET route with a real signed session, records the SQL the
handler issues, and checks whether statements touching a tenant-owned table carry a `branch_id` /
`company_id` predicate.

**Measured 2026-08-21: 125 GET routes — 1 scoped, 37 unscoped, 87 inconclusive** (no tenant table
reached, or the handler threw before its first query).

`tenancyCoverage.test.js` baselines those 37. The list may shrink freely — that is the work — and
cannot grow: a new entry fails the test **with the route's own name attached**. A third test fails
when a route is fixed and left on the list, because a stale baseline hides finished work and makes
the number meaningless.

**What a pass does not mean.** There is no database here, so this proves what the query *said*, not
what it returned. A route counted SCOPED could still scope by a caller-supplied value rather than by
the session; that needs a live two-branch database and remains open. What it catches reliably is
*no predicate at all*, which cannot be right under any reading.

The 37 and the audit's 119 are both honest and measure different things: the audit counted every
registration touching business data by reading, this counts GET routes that actually reached SQL
against a listed table by running them.

### What remains, and a correction to the estimate

**See `docs/tenancy-backfill-plan.md`.** Starting the read scoping turned up something that changes
the size of the job in both directions.

`backend/migrations/cloud/009` adds `company_id` as a **nullable shadow column** and says in its own
comments that it "performs no ownership backfill" and that enforcement follows "an owner-approved
backfill". So the columns are empty: adding `WHERE company_id = $1` to a route today returns nothing
— an empty screen on every module at once, which is the "errors must never render as zero" failure.

But `branch_id` is **not** a shadow column. It is part of the original schema on `sales`,
`purchases`, `inventory_batches`, `expenses`, both payment tables, `waste_entries` and
`sale_returns`, and has been written on every insert since. **Branch-level scoping therefore needs no
backfill at all**, and branch-level is what multibranch requires — `company_id` matters when there is
a second *company*, which is a later problem.

So the audit's 3–4 weeks assumed a blocking backfill that is not blocking. The read scoping can
proceed on the populated column, with the backfill deferred to whenever a second company is real.

One thing to check per batch rather than assume: `branch_id = $1` does not match NULL, so any row
with a NULL branch becomes invisible the moment a predicate is added. The plan carries the query
that counts them.

### The read exposure itself

Those 37, plus whatever the inconclusive 87 hide. Dormant while one branch
exists, live the day there are two. It is now a number in a test rather than a sentence in a
document, which is the difference between work that can be finished and work that can only be
worried about.

### Gate results

| Gate | Result |
| --- | --- |
| `npm --prefix backend test` | **280 / 281** — the 1 failure is the pre-existing Linux-vs-Windows path assertion |
| `TZ=Asia/Kolkata node --test frontend/src/local/*.test.mjs` | **343 / 343** |
| `npm run build` | Pass |

---

## Task 12 revisited (2026-08-21): "sync routes verify signatures only when an env var is set"

**Mostly stale, and the residue is narrower than the title.** Recorded here with the evidence rather
than quietly ticked off.

When it was written, `resolveSyncRequestContext` only called `verifyDeviceSession` under
`FROOZERP_OPERATIONAL_SCOPE_MODE=enforce`, and that variable defaults to `off` and is set nowhere in
the repository. The reading was that sync accepted unverified callers by default.

What actually closed it was A-4, which mounted `requireAuth` app-wide ahead of every route including
the sync surface, so the token is verified before any handler runs — the second verification inside
the enforce branch is now belt and braces. A-4b then widened `submittedIdentityFrom` to collect
`user_id`, `device_id`, `company_id` and `branch_id` from **every** location a caller can put them,
so the off-path's use of `submitted.user_id` cannot differ from the token.

Verified by attack, not by reading: `backend/liveBodySubstitution.test.js` drives live sync routes
with a valid Cashier token and a body claiming another user, device, branch and company. All four are
refused with `DEVICE_SESSION_SUBSTITUTION_REJECTED`, as is an identity smuggled through the query
string, and as is a body that agrees while the query disagrees. An honest request passes the gate.
Eleven of the twelve assertions were confirmed to fail with the substitution check removed.

**A near miss worth recording.** The first attempt at that attack reported the same result for the
honest request and every hostile one, which read as "the check never fires". The truth was that the
harness's `probe` took no body parameter, so all five requests were byte-identical and empty. The
tooling was wrong, not the product. `probe` now pushes a real body through the request stream so
`express.json` parses it the way it parses a network request — assigning `req.body` directly would
have been overwritten by that middleware and the test would have passed while proving nothing.

### What genuinely remains, and why it is not actionable yet

- `operational_location_id` is **not** in the substitution comparison list, so a caller may supply
  any value for it. There is nothing to compare it against: it is not a session claim. It is also
  not yet load-bearing — the column is one of the empty shadow columns Phase 3 exists to fill.
- The v3 scope guards are written `($N::INTEGER IS NULL OR (company_id = $N AND ...))`, and the
  context is null when scope mode is `off`, so those predicates pass unconditionally by default.
  The branch scoping added in A-7 is separate and unconditional, so this is not currently a
  cross-branch hole.

Both are operational-location concerns and both wait on the Phase 3 business decision recorded in
`docs/tenancy-backfill-plan.md`. Neither is a reason to keep task 12 open under its current title.
