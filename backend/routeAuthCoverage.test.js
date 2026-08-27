"use strict";

/**
 * Auth-hardening A-4: every registered route must require an authenticated session, or be on the
 * public allow-list below with a stated reason.
 *
 * **This suite is expected to fail until A-4 lands.** `requireAuth` exists (A-3) but is mounted on
 * nothing, so ~217 of ~284 routes still serve any caller who asserts an `x-user-id` header. The
 * failure output names each one; that list is the work.
 *
 * A-4 is the one stage that has to be exhaustive — a single missed route is a full bypass — and a
 * diff cannot show exhaustiveness. This can, because it enumerates routes from the running Express
 * app rather than from a list somebody has to remember to update. A route added in 2027 is
 * classified the moment it is registered, and if it is neither protected nor deliberately public,
 * this suite says so by name.
 *
 * The mechanics — sandboxed load of `server.js`, in-process probing, what counts as protection —
 * are in `routeAuthCoverage.js`. This file holds the policy.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { MINIMUM_EXPECTED_ROUTES, collectRouteAuthCoverage } = require("./routeAuthCoverage");

/**
 * Routes that must answer without credentials, and why each one has to.
 *
 * The reason is data, not a comment, because the test asserts it is present: an entry cannot be
 * added without writing down what breaks if the route is protected. The bar for an entry is not
 * "authentication would be inconvenient here" — it is "the caller cannot possibly hold a session
 * yet". Anything that fails that bar belongs behind `requireAuth`, even if it feels harmless.
 *
 * Every route on this list is also, permanently, unauthenticated attack surface. A-6's exposure
 * checklist should read this list as its inventory of what a stranger on the internet can reach.
 *
 * Each value is `{ reason, conditional? }`. `conditional` marks a route that is only registered
 * under some build condition, so its absence is not a stale entry.
 */
const PUBLIC_ROUTES = new Map([
  [
    "POST /login",
    { reason: "Issues the session token. Requiring one to get one is a deadlock and nobody could ever sign in." },
  ],
  [
    "GET /health",
    { reason: "Platform liveness probe. Railway's health check has no account and cannot be given one; a 401 here reads as a dead service and gets the deployment rolled back." },
  ],
  [
    "GET /api/health",
    { reason: "The /health probe under the /api prefix, used by the same platform check." },
  ],
  [
    "GET /api/version",
    { reason: "Client/server contract negotiation, which happens before sign-in. Behind auth, a client too old to log in would be told 401 instead of 'update required', and the update path is the one thing that must work when everything else does not." },
  ],
  [
    "GET /api/system/compatibility",
    { reason: "The minimum-client gate the desktop shell checks at startup, before any user has typed a password." },
  ],
  [
    "GET /api/time",
    { reason: "Session tokens are time-bound, so a device with a skewed clock cannot hold a valid one. It has to be able to discover the skew first. Returns server time only." },
  ],
  [
    "GET /",
    { reason: "Serves the built frontend. The login screen itself has to load before anyone can authenticate." },
  ],
  [
    "GET /^\\/(?!api\\/).*/",
    {
      reason: "The SPA history fallback, serving index.html for non-/api paths. Same reason as GET / — it is the app shell, and it is registered as a RegExp so it cannot be probed; it is public by inspection of its handler, which only sends index.html.",
      // server.js registers this route only when frontend/dist has been built, so on a tree that
      // has not run `npm run build` it is legitimately absent rather than stale.
      conditional: true,
    },
  ],
  [
    "GET /settings/device-control",
    {
      reason: "The login screen has to know whether this terminal is kiosk-locked before anyone signs in. A-4 split these four fields out of GET /settings rather than making that route public: the bundle also returns the whole users table, every authorized device, every activation code and the backup log to any caller who names a manager's user_id. An unauthenticated attacker gets whether fullscreen lock and an exit code are switched on, and when they last changed — never the exit-code hash, and no account, device or business data.",
    },
  ],
  [
    "POST /api/auth/device-bootstrap-status",
    {
      reason: "Called immediately before POST /login to decide whether this device may attempt a sign-in at all; there is no token in existence at that point. An unauthenticated attacker gets a device-ID oracle: whether an id they already know is registered, and whether it is approved. It reveals nothing about accounts or data and cannot enumerate ids, since the caller must supply the exact device_id. It wants a rate limit before internet exposure (A-6).",
    },
  ],
  [
    "POST /devices/activate",
    {
      reason: "Pre-login device enrolment by one-time activation code. An unapproved device is refused by /login, so it can never hold a session, so this route cannot require one — this is the credential that precedes the session, not a gap in it. An unauthenticated attacker gets brute force against a hashed 48-bit code that expires and is single-use; on success, an approved device, which still needs a username and password to be worth anything. It wants an attempt lockout (A-5).",
    },
  ],
  [
    "POST /bootstrap/first-owner-device",
    {
      reason: "The first-install escape hatch. On a fresh database no device is approved, so nobody can sign in and no token can exist; behind requireAuth this route could never run at all. It authenticates itself instead — it verifies the owner's username and password with checkPassword and refuses with 409 once any approved owner device exists. An unauthenticated attacker gets password guessing against the owner account and, on success, an approved device: the sharpest entry on this list. A-6 Gate 3.3 closed it on 2026-08-22 - the handler now refuses before it reads the body, never serves a hosted deployment at all, and is closed by default everywhere else, with `scripts/bootstrap-first-owner.mjs` as the ops path. It stays listed because the registration still exists; what an unauthenticated attacker now gets is a 404 with no password comparison behind it.",
    },
  ],
  [
    "GET /auth/recovery/config",
    { reason: "Renders the account-recovery form for someone who is locked out. Returns support contacts and provider status only — no account data, and no answer that depends on who is asking." },
  ],
  [
    "POST /auth/recovery/options",
    { reason: "Account recovery is by definition the flow for a user who cannot authenticate. Requiring auth would make it useless." },
  ],
  [
    "POST /auth/recovery/send-otp",
    { reason: "Same recovery flow: the user has no password, so they have no session to present." },
  ],
  [
    "POST /auth/recovery/verify-otp",
    { reason: "Same recovery flow. The OTP is the credential here, and A-5's lockout work is what limits abuse of it." },
  ],
  [
    "POST /auth/recovery/reset-password",
    { reason: "Same recovery flow. Authorised by the verified recovery token rather than by a session." },
  ],
]);

/**
 * Device enrolment was the open question A-4 had to answer. This is how it was answered, and why
 * the six routes split three and three.
 *
 * Public, because the caller provably cannot hold a session: `POST /devices/activate`,
 * `POST /bootstrap/first-owner-device` and `POST /api/auth/device-bootstrap-status`. A device that
 * has not been approved is refused by `/login`, so no token can exist for it — requiring one would
 * make enrolment impossible rather than safe. Each carries its own credential in place of the
 * session: a hashed single-use activation code, the owner's password plus a "no approved owner
 * device yet" precondition, and nothing at all for the status oracle, which grants no authority.
 *
 * Authenticated, because the premise was wrong: `POST /api/sync/register-device`,
 * `POST /api/device/register` and the `/api/cloud/device/*` routes. These read as bootstrap and are
 * not — `syncService.initialiseSync` calls the first two *after* login with the signed-in user's
 * context, and the cloud pair are driven from in-app admin panels. `registerSyncDeviceHandler` had
 * no identity check of any kind and updates `authorized_devices` for whatever `device_id` the
 * caller names, including an already-approved one. Public, that is device-record tampering by
 * anyone who can reach the port.
 */

let coverage = null;
const routeCoverage = async () => {
  if (!coverage) coverage = await collectRouteAuthCoverage();
  return coverage;
};

const formatRow = (route) => `  ${route.method.padEnd(6)} ${route.path.padEnd(52)} ${route.evidence}`;

test("route enumeration reflects the real Express app", async () => {
  const routes = await routeCoverage();
  // An empty or truncated enumeration would make every later assertion vacuously true — nothing
  // unclassified because nothing enumerated. That is the one way this suite could pass while
  // proving nothing, so it is checked before anything else.
  assert.ok(
    routes.length >= MINIMUM_EXPECTED_ROUTES,
    `only ${routes.length} routes enumerated; the sandboxed load of server.js is broken, not the app`
  );
  for (const key of ["POST /login", "GET /api/v3/inventory", "GET /products"]) {
    assert.ok(routes.some((route) => route.key === key), `expected ${key} among the enumerated routes`);
  }
  // Routes registered by operationalV3.js and aiBusinessAssistantService.js are the ones a
  // server.js-only list would miss, so their presence is what proves the enumeration is live.
  assert.ok(routes.some((route) => route.path.startsWith("/api/ai/")), "FROST routes are missing");
});

test("every registered route requires authentication or is explicitly public", async () => {
  const routes = await routeCoverage();
  const unclassified = routes.filter((route) => !route.authenticated && !PUBLIC_ROUTES.has(route.key));
  assert.equal(
    unclassified.length,
    0,
    [
      `${unclassified.length} of ${routes.length} registered routes are reachable without an authenticated session and are not on the public allow-list.`,
      "",
      "Until auth-hardening A-4 mounts requireAuth app-wide this failure is the expected state, and",
      "the list below is the work. Each route must either be put behind requireAuth or added to",
      "PUBLIC_ROUTES in this file with a written reason.",
      "",
      "'evidence' is what the route actually returned to a caller holding no token: first with no",
      "headers at all, then asserting x-user-id the way an attacker would. A denial that changes",
      "when an identity is asserted is a role check, not authentication, and does not count.",
      "",
      ...unclassified.map(formatRow),
    ].join("\n")
  );
});

test("the public allow-list names only routes that still exist", async () => {
  const routes = await routeCoverage();
  const known = new Set(routes.map((route) => route.key));
  const stale = [...PUBLIC_ROUTES]
    .filter(([key, entry]) => !known.has(key) && !entry.conditional)
    .map(([key]) => key);
  // A stale entry is not merely untidy: if a route is ever re-registered under that name it becomes
  // public silently, having been exempted years earlier for a reason nobody remembers.
  assert.deepEqual(stale, [], `allow-list entries name routes that are no longer registered: ${stale.join(", ")}`);
});

test("every public route states why it is public", async () => {
  for (const [key, entry] of PUBLIC_ROUTES) {
    assert.ok(
      typeof entry.reason === "string" && entry.reason.trim().length > 0,
      `${key} is exempt from authentication with no reason recorded`
    );
  }
});

test("public routes stay reachable without credentials", async () => {
  const routes = await routeCoverage();
  const denied = routes.filter((route) => PUBLIC_ROUTES.has(route.key) && route.authenticated);
  // The failure mode this catches is A-4 mounting requireAuth ahead of its own allow-list check, or
  // an allow-list path typo. It locks every user out of the product, and it does it at the login
  // screen, so it must never reach a release.
  assert.deepEqual(
    denied.map((route) => route.key),
    [],
    `these routes must be reachable without a session but were refused for lack of one:\n${denied.map(formatRow).join("\n")}`
  );
});
