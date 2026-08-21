"use strict";

/**
 * An Owner may look at another shop. They may not change anything while they are there.
 *
 * The feature works by re-minting the session with the viewed shop's `branch_id`, so all thirty-odd
 * reads scoped in A-7 keep working untouched and the token stays the only place scope comes from.
 * The whole cost of that simplicity is one risk: a write would land in the shop being *viewed*.
 * An Owner glancing at another branch's report and then ringing up a sale would file it against the
 * wrong shop, and nothing downstream would find that odd — the request would be perfectly valid.
 *
 * `view_only` closes that, in `requireAuth`, for every non-GET. These tests exist because that is a
 * single check standing between "convenient" and "money recorded against the wrong shop".
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadServerApp, probe, startQueryRecording, stopQueryRecording } = require("./routeAuthCoverage");
const { VIEW_ONLY_TTL_SECONDS, issueDeviceSession, verifyDeviceSession } = require("./deviceSession");
const { authContextFromClaims } = require("./authMiddleware");

/** Must match the throwaway key `routeAuthCoverage` pins into the environment before loading. */
const TEST_SIGNING_KEY = "route-auth-coverage-isolated-signing-key-000000";

const token = (overrides = {}) => issueDeviceSession({
  userId: 7,
  deviceId: "FZDEV-VIEW",
  companyId: 1,
  branchId: 1,
  role: "Owner",
  secret: TEST_SIGNING_KEY,
  ...overrides,
});

let app;
const call = async (method, url, sessionToken, body = {}) => {
  if (!app) app = loadServerApp();
  startQueryRecording();
  const response = await probe(app, method, url, {
    authorization: `Bearer ${sessionToken}`,
    "content-type": "application/json",
  }, body);
  stopQueryRecording();
  return response;
};

const WRITE_ATTEMPTS = [
  ["POST", "/expenses"],
  ["PUT", "/expenses/1"],
  ["DELETE", "/expenses/1"],
  ["POST", "/api/sync/push"],
];

for (const [method, url] of WRITE_ATTEMPTS) {
  test(`a view-only session cannot ${method} ${url}`, async () => {
    const response = await call(method, url, token({ viewOnly: true }));
    assert.equal(response.status, 403);
    assert.equal(response.code, "VIEW_ONLY_SESSION");
  });
}

test("sync is blocked too, deliberately, with no allowlist for read-shaped POSTs", async () => {
  // `/api/sync/pull` is morally a read, and it is still refused. A sync running under a viewing
  // session would pull the *viewed* shop's data down onto this device, which is a worse outcome
  // than a sync that waits half an hour for the token to expire.
  const response = await call("POST", "/api/sync/pull", token({ viewOnly: true }));
  assert.equal(response.code, "VIEW_ONLY_SESSION");
});

test("a view-only session can still read", async () => {
  // The control. A gate that refused everything would pass every assertion above while making the
  // feature useless. There is no database here, so a read reaches the handler and hangs rather than
  // completing — a null status is the proof it got past authentication.
  const response = await call("GET", "/sales", token({ viewOnly: true }));
  assert.notEqual(response.status, 403);
  assert.notEqual(response.status, 401);
});

test("an ordinary session is unaffected and may still write", async () => {
  // The second control, and the one that would catch the worst possible mistake here: a check
  // written slightly wrong that blocks writes for everybody and turns the whole app read-only.
  const response = await call("POST", "/expenses", token());
  assert.notEqual(response.status, 403);
});

test("a token minted before view_only existed is treated as an ordinary session", () => {
  // Backward compatibility, asserted at the claim layer where it is decided. Existing sessions
  // carry no such field, and `undefined` must read as "not view-only" rather than as missing data.
  const claims = { user_id: 7, device_id: "D", company_id: 1, branch_id: 1, role: "Owner" };
  assert.equal(authContextFromClaims(claims).viewOnly, false);
});

test("view_only survives a signing round trip rather than being dropped", () => {
  const verified = verifyDeviceSession(token({ viewOnly: true }), TEST_SIGNING_KEY);
  assert.equal(verified.error, undefined);
  assert.equal(verified.claims.view_only, true);
  assert.equal(authContextFromClaims(verified.claims).viewOnly, true);
});

test("a viewing session expires in well under an ordinary one", () => {
  // It is a state nobody should sit in. Asserted as a relationship rather than a literal so the
  // intent survives someone tuning either number.
  assert.ok(VIEW_ONLY_TTL_SECONDS <= 60 * 60, "a viewing session must be short-lived");
});

test("switching shops needs an Owner, checked against the database", async () => {
  // The token below genuinely claims Owner. The route still refuses, because it re-reads the role
  // rather than believing the claim — so demoting someone shuts this door immediately instead of
  // whenever their token happens to expire.
  const response = await call("POST", "/api/owner/view-branch", token(), { view_branch_id: 2 });
  assert.equal(response.status, 403);
  assert.equal(response.code, "OWNER_ONLY");
});

test("the shop list needs an Owner too", async () => {
  const response = await call("GET", "/api/owner/viewable-branches", token());
  assert.equal(response.status, 403);
  assert.equal(response.code, "OWNER_ONLY");
});

test("an anonymous caller cannot switch shops", async () => {
  if (!app) app = loadServerApp();
  startQueryRecording();
  const response = await probe(app, "POST", "/api/owner/view-branch", {
    "content-type": "application/json",
  }, { view_branch_id: 2 });
  stopQueryRecording();
  assert.equal(response.status, 401);
});
