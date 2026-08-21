"use strict";

/**
 * Hostile request bodies, against live routes.
 *
 * A-4b's substitution check is unit-tested in `authMiddleware.test.js` with hand-built request
 * objects. That proves the function is correct; it does not prove the function is *reached* on a
 * real route with a real parsed body — and those are different claims. The check reads `req.body`,
 * which only exists because `express.json` ran first, so its correctness depends on middleware
 * order that no test observed.
 *
 * This file closes that gap, and it exists because of a near miss: an attempt to attack
 * `/api/sync/push` with a substituted `user_id` reported the same status for the honest request and
 * every hostile one. The natural reading was "the check does not fire". The truth was that `probe`
 * took no body parameter, so all five requests were byte-identical and empty. The tooling was wrong,
 * not the product — but a test written on that evidence would have been a false alarm, and a test
 * written the other way round would have been a false pass.
 *
 * So `probe` gained a body that is pushed through the request stream and parsed by the app's own
 * JSON middleware, rather than assigned onto `req.body` where `express.json` would overwrite it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  loadServerApp,
  probe,
  startQueryRecording,
  stopQueryRecording,
} = require("./routeAuthCoverage");
const { issueDeviceSession } = require("./deviceSession");

/** Must match the throwaway key `routeAuthCoverage` pins into the environment before loading. */
const TEST_SIGNING_KEY = "route-auth-coverage-isolated-signing-key-000000";

const SESSION = Object.freeze({ userId: 7, deviceId: "FZ-CASHIER", companyId: 1, branchId: 1 });

let app;
const send = async (method, url, body) => {
  if (!app) app = loadServerApp();
  const token = issueDeviceSession({ ...SESSION, role: "Cashier", secret: TEST_SIGNING_KEY });
  startQueryRecording();
  const response = await probe(app, method, url, {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  }, body);
  stopQueryRecording();
  return response;
};

/** Routes that read identity out of the body, one per shape of handler. */
const BODY_IDENTITY_ROUTES = [
  ["POST", "/api/sync/push"],
  ["POST", "/api/sync/pull"],
];

const HOSTILE_BODIES = [
  ["another user", { user_id: 1, device_id: SESSION.deviceId, branch_id: 1, company_id: 1 }],
  ["another device", { user_id: 7, device_id: "OWNER-LAPTOP", branch_id: 1, company_id: 1 }],
  ["another branch", { user_id: 7, device_id: SESSION.deviceId, branch_id: 2, company_id: 1 }],
  ["another company", { user_id: 7, device_id: SESSION.deviceId, branch_id: 1, company_id: 9 }],
];

for (const [method, url] of BODY_IDENTITY_ROUTES) {
  for (const [label, body] of HOSTILE_BODIES) {
    test(`${method} ${url} refuses a body claiming ${label}`, async () => {
      const response = await send(method, url, body);
      assert.equal(response.status, 403, `${label} was not refused`);
      assert.equal(response.code, "DEVICE_SESSION_SUBSTITUTION_REJECTED");
    });
  }
}

test("a body agreeing with the token is allowed past the auth gate", async () => {
  // The control, and the reason the assertions above mean anything. Without it, a gate that
  // refused *every* request — including honest ones — would look like perfect security.
  //
  // It asserts "not 403", not "200": there is no database here, so the handler cannot complete.
  // `pool.connect()` never settles against the stub and the probe times out with a null status,
  // which is itself the proof that the request got past authentication and into the handler.
  const response = await send("POST", "/api/sync/push", {
    user_id: SESSION.userId,
    device_id: SESSION.deviceId,
    branch_id: SESSION.branchId,
    company_id: SESSION.companyId,
  });
  assert.notEqual(response.status, 403, "an honest request must not be refused as a substitution");
  assert.notEqual(response.status, 401);
});

test("an identity smuggled in the query string is refused too", async () => {
  const response = await send("POST", "/api/sync/push?user_id=1", {
    user_id: SESSION.userId,
    device_id: SESSION.deviceId,
  });
  assert.equal(response.status, 403);
  assert.equal(response.code, "DEVICE_SESSION_SUBSTITUTION_REJECTED");
});

test("agreeing in the body while disagreeing in the query is still refused", async () => {
  // The exact shape A-4b was widened for: satisfy the check in the place it reads, and hand the
  // handler a different id somewhere else. It only fails if every location is compared.
  const response = await send("POST", "/api/sync/push?branch_id=2", {
    user_id: SESSION.userId,
    device_id: SESSION.deviceId,
    branch_id: SESSION.branchId,
  });
  assert.equal(response.status, 403);
  assert.equal(response.code, "DEVICE_SESSION_SUBSTITUTION_REJECTED");
});

test("the probe actually delivers a body, so these tests are not empty requests", async () => {
  // Guards the tooling this file depends on. If `probe` silently drops the body again, every
  // assertion above starts passing for the wrong reason — the request would carry no identity to
  // disagree with, and it was that exact failure that prompted this file.
  //
  // Checked by outcome rather than by the function's arity: a default parameter does not count
  // towards `Function.length`, so an arity assertion here failed against a working probe. The two
  // requests differ only in their body, so a different result is proof the body was delivered.
  const withoutBody = await send("POST", "/api/sync/push", undefined);
  const withHostileBody = await send("POST", "/api/sync/push", { user_id: 1 });
  assert.equal(withHostileBody.status, 403);
  assert.notEqual(
    withoutBody.status,
    withHostileBody.status,
    "an empty request and a hostile-body request produced the same result, so the body is being dropped",
  );
});
