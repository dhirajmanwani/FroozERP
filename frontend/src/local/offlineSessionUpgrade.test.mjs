import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  OFFLINE_UPGRADE_RETRY_MS,
  decideOfflineSessionUpgrade,
  resolveOfflineSessionUpgrade,
} from "./offlineSessionUpgrade.js";

const offlineUser = { id: 1, username: "owner", offline_session: true, canonical_user_id: 1 };
const ready = { user: offlineUser, hasPassword: true, now: 1_000_000 };

test("an offline session with the cloud configured and nothing in the way is retried", () => {
  assert.deepEqual(decideOfflineSessionUpgrade(ready), { attempt: true, reason: "READY" });
});

test("an online session is never retried", () => {
  const online = { ...offlineUser, offline_session: false, device_session_token: "t" };
  assert.equal(decideOfflineSessionUpgrade({ ...ready, user: online }).reason, "NOT_OFFLINE");
  assert.equal(decideOfflineSessionUpgrade({ ...ready, user: null }).reason, "NOT_OFFLINE");
});

test("Local Only makes no cloud call, whatever else holds", () => {
  const decision = decideOfflineSessionUpgrade({ ...ready, localOnly: true });
  assert.deepEqual(decision, { attempt: false, reason: "LOCAL_ONLY" });
});

test("no configured cloud, no password, or a refusal already seen: no attempt", () => {
  assert.equal(decideOfflineSessionUpgrade({ ...ready, cloudConfigured: false }).reason, "NO_CLOUD");
  assert.equal(decideOfflineSessionUpgrade({ ...ready, hasPassword: false }).reason, "NO_PASSWORD");
  assert.equal(decideOfflineSessionUpgrade({ ...ready, refused: true }).reason, "REFUSED");
});

test("a bill in progress holds the attempt until the cart is empty", () => {
  assert.equal(decideOfflineSessionUpgrade({ ...ready, billInProgress: true }).reason, "BILL_IN_PROGRESS");
});

test("never two attempts at once, and at most one a minute", () => {
  assert.equal(decideOfflineSessionUpgrade({ ...ready, inFlight: true }).reason, "IN_FLIGHT");
  const recent = { ...ready, lastAttemptAt: ready.now - OFFLINE_UPGRADE_RETRY_MS + 1 };
  assert.equal(decideOfflineSessionUpgrade(recent).reason, "TOO_SOON");
  const due = { ...ready, lastAttemptAt: ready.now - OFFLINE_UPGRADE_RETRY_MS };
  assert.equal(decideOfflineSessionUpgrade(due).reason, "READY");
});

test("the cloud's answer for the same person, with a token, upgrades the session", () => {
  const cloudUser = { id: 1, username: "owner", device_session_token: "token-abc" };
  const result = resolveOfflineSessionUpgrade({ offlineUser, response: { data: cloudUser } });
  assert.equal(result.outcome, "UPGRADED");
  assert.equal(result.user, cloudUser);
});

test("a different user from the cloud is refused, never adopted", () => {
  const result = resolveOfflineSessionUpgrade({
    offlineUser,
    response: { data: { id: 2, device_session_token: "token-abc" } },
  });
  assert.equal(result.outcome, "IDENTITY_MISMATCH");
  assert.equal(result.user, undefined);
});

test("ids are compared as the opaque strings they are: '004' is not 4", () => {
  const result = resolveOfflineSessionUpgrade({
    offlineUser: { ...offlineUser, id: "004", canonical_user_id: "004" },
    response: { data: { id: 4, device_session_token: "t" } },
  });
  assert.equal(result.outcome, "IDENTITY_MISMATCH");
});

test("a 2xx without a session token is not success", () => {
  const result = resolveOfflineSessionUpgrade({ offlineUser, response: { data: { id: 1 } } });
  assert.equal(result.outcome, "STILL_OFFLINE");
});

test("no answer or a cloud fault means try again later", () => {
  assert.equal(resolveOfflineSessionUpgrade({ offlineUser, error: new Error("Network Error") }).outcome, "STILL_OFFLINE");
  assert.equal(resolveOfflineSessionUpgrade({ offlineUser, error: { response: { status: 503 } } }).outcome, "STILL_OFFLINE");
});

test("a refusal stops the retries and says what to do, with the server's reason", () => {
  const result = resolveOfflineSessionUpgrade({
    offlineUser,
    error: { response: { status: 401, data: { code: "INVALID_CREDENTIALS", message: "Invalid username or password" } } },
  });
  assert.equal(result.outcome, "REFUSED");
  assert.match(result.message, /Invalid username or password/);
  assert.match(result.message, /Sign out and sign in again/);
});

// The wiring in App.jsx: the attempt is gated by the decision above, guarded like every other cloud
// call, and never reaches the cloud in Local Only.
const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

test("App.jsx asks the decision before every retried sign-in", () => {
  const start = app.indexOf("const upgradeOfflineSession = async");
  assert.ok(start > 0, "upgradeOfflineSession exists");
  const body = app.slice(start, app.indexOf("\n  };\n", start));
  const decision = body.indexOf("decideOfflineSessionUpgrade(");
  const gate = body.indexOf('guardCloudCall("canonical-cloud-login"');
  const request = body.indexOf("/login`");
  assert.ok(decision > 0 && gate > decision && request > gate, "decision, then cloud gate, then the request");
  assert.match(body, /localOnly: isLocalOnlyConnectivitySelected\(\)/);
  assert.match(body, /billInProgress: posWorkRef\.current\.cartLines > 0 \|\| posWorkRef\.current\.saving === true/);
  assert.match(body, /if \(userRef\.current !== offlineUser\) return "SESSION_CHANGED"/);
  assert.match(body, /resolveOfflineSessionUpgrade\(/);
});
