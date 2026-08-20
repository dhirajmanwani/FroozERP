"use strict";

/**
 * Stage A-3 — request authentication.
 *
 * The property this whole stage exists for is the first test below: **`x-user-id` alone must never
 * authenticate anyone.** Everything else is detail around that.
 *
 * The others pin the failures that are silent rather than loud — a token that is expired, tampered,
 * signed with a different key, or belonging to someone else must each be rejected, and none of them
 * looks different from a valid token until it is checked.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { issueDeviceSession } = require("./deviceSession");
const {
  AUTH_ERRORS,
  createRequireAuth,
  extractSessionToken,
  requireRole,
} = require("./authMiddleware");

const SECRET = "test-signing-secret";
const OTHER_SECRET = "a-different-signing-secret";

const token = (overrides = {}) => issueDeviceSession({
  userId: 7,
  deviceId: "FZDEV-TEST-1",
  companyId: 1,
  branchId: 2,
  role: "Owner",
  secret: SECRET,
  ...overrides,
});

/** Minimal Express double: records what the middleware did instead of sending a response. */
const runMiddleware = (middleware, req) => {
  const state = { nexted: false, status: null, body: null };
  const res = {
    status(code) {
      state.status = code;
      return this;
    },
    json(payload) {
      state.body = payload;
      return this;
    },
  };
  middleware(req, res, () => {
    state.nexted = true;
  });
  return state;
};

const requestWith = (headers = {}, extra = {}) => ({ headers, body: {}, query: {}, ...extra });

// ---------------------------------------------------------------------------------------------
// The point of the whole stage
// ---------------------------------------------------------------------------------------------

test("x-user-id alone never authenticates anyone", () => {
  // Before A-3 this header WAS the identity, with no verification at all. If this test ever fails,
  // the API is wide open again to anyone who can reach it.
  const auth = createRequireAuth({ secret: SECRET });
  const state = runMiddleware(auth, requestWith({ "x-user-id": "1" }));

  assert.equal(state.nexted, false, "a bare x-user-id must not reach the route");
  assert.equal(state.status, 401);
  assert.equal(state.body.code, AUTH_ERRORS.MISSING.code);
});

test("no credentials at all are rejected, never treated as anonymous access", () => {
  const auth = createRequireAuth({ secret: SECRET });
  const state = runMiddleware(auth, requestWith({}));
  assert.equal(state.nexted, false);
  assert.equal(state.status, 401);
});

test("a valid token authenticates and exposes only verified identity", () => {
  const auth = createRequireAuth({ secret: SECRET });
  const req = requestWith({ authorization: `Bearer ${token()}` });
  const state = runMiddleware(auth, req);

  assert.equal(state.nexted, true);
  assert.equal(req.auth.userId, 7);
  assert.equal(req.auth.deviceId, "FZDEV-TEST-1");
  assert.equal(req.auth.companyId, 1);
  assert.equal(req.auth.branchId, 2);
  assert.equal(req.auth.role, "Owner");
  assert.equal(req.auth.normalizedRole, "OWNER");
});

test("identity comes from the token even when x-user-id disagrees in the same request", () => {
  // The upgrade hazard: a caller holding a real session for themselves, asserting someone else's
  // id alongside it. The token wins, and the mismatch is refused outright.
  const auth = createRequireAuth({ secret: SECRET });
  const state = runMiddleware(auth, requestWith({
    authorization: `Bearer ${token({ userId: 7 })}`,
    "x-user-id": "99",
  }));

  assert.equal(state.nexted, false, "a contradictory identity claim must be rejected");
  assert.equal(state.status, 403);
  assert.equal(state.body.code, "DEVICE_SESSION_SUBSTITUTION_REJECTED");
});

test("an x-user-id that agrees with the token is harmless", () => {
  // Existing clients send it; agreement must not be punished, only contradiction.
  const auth = createRequireAuth({ secret: SECRET });
  const req = requestWith({
    authorization: `Bearer ${token({ userId: 7 })}`,
    "x-user-id": "7",
  });
  const state = runMiddleware(auth, req);
  assert.equal(state.nexted, true);
  assert.equal(req.auth.userId, 7);
});

// ---------------------------------------------------------------------------------------------
// Token rejection paths — each with its own code, per the plan
// ---------------------------------------------------------------------------------------------

test("an expired token is rejected", () => {
  const auth = createRequireAuth({ secret: SECRET });
  const expired = token({ nowMs: Date.now() - 24 * 60 * 60 * 1000, ttlSeconds: 60 });
  const state = runMiddleware(auth, requestWith({ authorization: `Bearer ${expired}` }));

  assert.equal(state.nexted, false);
  assert.equal(state.status, 401);
  assert.equal(state.body.code, "DEVICE_SESSION_EXPIRED");
});

test("a tampered payload is rejected", () => {
  // Flip a character in the payload segment; the signature no longer covers it.
  const auth = createRequireAuth({ secret: SECRET });
  const parts = token().split(".");
  parts[1] = `${parts[1].slice(0, -1)}${parts[1].slice(-1) === "A" ? "B" : "A"}`;
  const state = runMiddleware(auth, requestWith({ authorization: `Bearer ${parts.join(".")}` }));

  assert.equal(state.nexted, false);
  assert.equal(state.status, 401);
  assert.equal(state.body.code, "DEVICE_SESSION_INVALID");
});

test("a token signed with a different secret is rejected", () => {
  // Forgery with the right shape but the wrong key.
  const auth = createRequireAuth({ secret: SECRET });
  const forged = token({ secret: OTHER_SECRET });
  const state = runMiddleware(auth, requestWith({ authorization: `Bearer ${forged}` }));

  assert.equal(state.nexted, false);
  assert.equal(state.body.code, "DEVICE_SESSION_INVALID");
});

test("a wrong-version token is rejected", () => {
  const auth = createRequireAuth({ secret: SECRET });
  const parts = token().split(".");
  parts[0] = "v2";
  const state = runMiddleware(auth, requestWith({ authorization: `Bearer ${parts.join(".")}` }));

  assert.equal(state.nexted, false);
  assert.equal(state.body.code, "DEVICE_SESSION_REQUIRED");
});

test("a garbage token is rejected without throwing", () => {
  const auth = createRequireAuth({ secret: SECRET });
  for (const value of ["not-a-token", "a.b.c", "Bearer", "..", "v1..", "v1.!!!.***"]) {
    const state = runMiddleware(auth, requestWith({ authorization: `Bearer ${value}` }));
    assert.equal(state.nexted, false, `must reject ${JSON.stringify(value)}`);
  }
});

test("a server with no configured secret refuses rather than allowing", () => {
  // A misconfiguration must never degrade into "let everyone in".
  const auth = createRequireAuth({ secret: "" });
  const state = runMiddleware(auth, requestWith({ authorization: `Bearer ${token()}` }));
  assert.equal(state.nexted, false);
  assert.equal(state.status, 500);
  assert.equal(state.body.code, AUTH_ERRORS.MISCONFIGURED.code);
});

// ---------------------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------------------

test("the existing x-froozerp-device-session header still works", () => {
  // The sync path and desktop already send this. Breaking it would gain nothing.
  const auth = createRequireAuth({ secret: SECRET });
  const req = requestWith({ "x-froozerp-device-session": token() });
  const state = runMiddleware(auth, req);
  assert.equal(state.nexted, true);
  assert.equal(req.auth.userId, 7);
});

test("Authorization: Bearer is preferred, and parsing is case-insensitive", () => {
  assert.equal(extractSessionToken({ headers: { authorization: "Bearer abc" } }), "abc");
  assert.equal(extractSessionToken({ headers: { authorization: "bearer abc" } }), "abc");
  assert.equal(extractSessionToken({ headers: { authorization: "BEARER   abc" } }), "abc");
  assert.equal(
    extractSessionToken({ headers: { authorization: "Bearer abc", "x-froozerp-device-session": "xyz" } }),
    "abc",
    "Authorization wins when both are present",
  );
});

test("a non-Bearer Authorization header falls through rather than being misread", () => {
  // Basic auth or an API key must not be mistaken for a session token.
  assert.equal(extractSessionToken({ headers: { authorization: "Basic dXNlcjpwYXNz" } }), "");
  assert.equal(extractSessionToken({ headers: {} }), "");
  assert.equal(extractSessionToken({}), "");
});

// ---------------------------------------------------------------------------------------------
// requireRole
// ---------------------------------------------------------------------------------------------

test("requireRole admits a permitted role and refuses others", () => {
  const owner = { auth: { normalizedRole: "OWNER" } };
  const cashier = { auth: { normalizedRole: "CASHIER" } };

  assert.equal(runMiddleware(requireRole("Owner"), owner).nexted, true);
  assert.equal(runMiddleware(requireRole("Owner", "Admin"), owner).nexted, true);

  const refused = runMiddleware(requireRole("Owner"), cashier);
  assert.equal(refused.nexted, false);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, AUTH_ERRORS.ROLE_FORBIDDEN.code);
});

test("requireRole matches roles case-insensitively", () => {
  const req = { auth: { normalizedRole: "OWNER" } };
  assert.equal(runMiddleware(requireRole("owner"), req).nexted, true);
  assert.equal(runMiddleware(requireRole(["OWNER"]), req).nexted, true);
});

test("requireRole denies when the session carries no role", () => {
  // A token minted before A-3 proves who someone is but not what they may do. "Unknown role" must
  // never read as "any role".
  const req = { auth: { normalizedRole: "" } };
  const state = runMiddleware(requireRole("Owner"), req);
  assert.equal(state.nexted, false);
  assert.equal(state.status, 403);
  assert.equal(state.body.code, AUTH_ERRORS.ROLE_UNKNOWN.code);
});

test("requireRole denies when requireAuth has not run", () => {
  // Mounting order is a mistake someone will make; it must fail closed, not open.
  const state = runMiddleware(requireRole("Owner"), { headers: {} });
  assert.equal(state.nexted, false);
  assert.equal(state.status, 401);
});

test("requireRole with no roles listed permits nobody", () => {
  // An empty allow-list is almost certainly a bug at the call site; denying makes it visible
  // immediately rather than silently granting everyone.
  const state = runMiddleware(requireRole(), { auth: { normalizedRole: "OWNER" } });
  assert.equal(state.nexted, false);
  assert.equal(state.status, 403);
});

// ---------------------------------------------------------------------------------------------
// Backwards compatibility with tokens minted before A-3
// ---------------------------------------------------------------------------------------------

test("a token minted without a role still authenticates", () => {
  // Adding the role claim must not invalidate sessions issued by an older build.
  const auth = createRequireAuth({ secret: SECRET });
  const legacy = issueDeviceSession({
    userId: 3,
    deviceId: "FZDEV-OLD",
    companyId: 1,
    branchId: 1,
    secret: SECRET,
  });
  const req = requestWith({ authorization: `Bearer ${legacy}` });
  const state = runMiddleware(auth, req);

  assert.equal(state.nexted, true, "an older token must still prove identity");
  assert.equal(req.auth.userId, 3);
  assert.equal(req.auth.role, "", "but it carries no role");
  assert.equal(
    runMiddleware(requireRole("Owner"), req).nexted,
    false,
    "so a role-gated route refuses it until the user signs in again",
  );
});
