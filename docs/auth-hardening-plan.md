# Auth Hardening — Scoping and Plan

**Status:** scoped, not started. Written 2026-08-17 at the maintainer's request, to run **in
parallel** with the offline-activation stages.
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
