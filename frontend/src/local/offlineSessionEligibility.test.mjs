import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { describeOfflineSessionEligibility, mayOpenOfflineSession } from "./offlineSessionEligibility.js";

/**
 * A cloud refusal must not be answered by a cached session.
 *
 * A second counter signed in with a password that had been changed on the cloud weeks earlier. The
 * cloud answered 401. The app caught it, opened an offline session against the still-cached old
 * credential, and let the person in -- with no cloud token, so every sync afterwards failed. The
 * screen said "Sync Failed": true, and useless. The fault was in the sign-in, and the sign-in had
 * reported success.
 */

test("a refused sign-in does not open an offline session", () => {
  for (const failure of [
    { response: { status: 401, data: { code: "INVALID_CREDENTIALS" } } },
    { response: { status: 401, data: {} } },
    { response: { status: 403, data: { code: "DEVICE_NOT_APPROVED" } } },
    { response: { status: 423, data: { code: "ACCOUNT_LOCKED" } } },
    { response: { status: 429, data: {} } },
  ]) {
    const verdict = describeOfflineSessionEligibility(failure);
    assert.equal(verdict.allowed, false, `status ${failure.response.status} is a refusal`);
    assert.equal(verdict.reason, "CLOUD_REFUSED");
  }
});

test("INVALID_CREDENTIALS in particular, because that is the one that got through", () => {
  // The first version of this rule reused `classifySessionFailure`, which deliberately treats
  // login-attempt codes as non-authentication failures so a wrong password is never repainted as
  // "your session ended". That is right for its job and wrong for this one: `INVALID_CREDENTIALS`
  // came back `authentication: false` and the hole stayed exactly where it was.
  assert.equal(
    mayOpenOfflineSession({ response: { status: 401, data: { code: "INVALID_CREDENTIALS" } } }),
    false,
  );
});

test("a cloud that never answered still opens one", () => {
  // This is what an offline session is for, and the shop bills through it.
  for (const failure of [
    { code: "ECONNABORTED", message: "timeout of 8000ms exceeded" },
    { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND" },
    new Error("Network Error"),
    null,
    undefined,
  ]) {
    assert.equal(mayOpenOfflineSession(failure), true, `offline must still work for ${failure?.code || failure?.message || failure}`);
  }
});

test("a broken cloud is an outage, not a verdict", () => {
  // Refusing to work offline through somebody else's outage would close a counter, which is a worse
  // failure than the one this rule exists to stop.
  for (const status of [500, 502, 503, 504]) {
    const verdict = describeOfflineSessionEligibility({ response: { status, data: {} } });
    assert.equal(verdict.allowed, true, `${status} must still allow offline`);
    assert.equal(verdict.reason, "CLOUD_FAULT");
  }
});

test("the boundary is 500, and it is a boundary", () => {
  assert.equal(mayOpenOfflineSession({ response: { status: 499 } }), false);
  assert.equal(mayOpenOfflineSession({ response: { status: 500 } }), true);
});

test("a status on the error itself is read too", () => {
  // Not every refusal arrives shaped like an axios response.
  assert.equal(mayOpenOfflineSession({ status: 401 }), false);
  assert.equal(mayOpenOfflineSession({ status: 503 }), true);
});

test("the login path actually consults the rule", () => {
  // The bug lived in App.jsx, not here. The module being right was never the difficulty.
  const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /if \(isTauriRuntime\(\) && mayOpenOfflineSession\(error\)\) \{/);
  assert.match(app, /from "\.\/local\/offlineSessionEligibility"/);
});
