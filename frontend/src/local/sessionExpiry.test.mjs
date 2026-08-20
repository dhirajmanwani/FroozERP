import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SESSION_ACTIONS,
  SESSION_EXPIRY_WARNING_SECONDS,
  SESSION_FAILURE_KINDS,
  SESSION_TOKEN_VERSION,
  SESSION_TTL_SECONDS,
  classifySessionFailure,
  describeRemainingTime,
  describeTokenExpiry,
  isAuthenticationFailure,
  isOfflineFailure,
  readSessionTokenPayload,
  resolveSessionAction,
} from "./sessionExpiry.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const readSource = (relative) => fs.readFileSync(path.join(here, relative), "utf8");

const NOW_MS = Date.parse("2026-08-20T09:00:00.000Z");
const nowSeconds = Math.floor(NOW_MS / 1000);

const base64url = (value) => Buffer.from(value, "utf8").toString("base64url");

/** Builds a token the way `backend/deviceSession.js` does, with a signature we cannot check. */
const tokenExpiringIn = (seconds, overrides = {}) => {
  const claims = {
    user_id: 7,
    device_id: "device-alpha",
    company_id: 1,
    branch_id: 1,
    role: "CASHIER",
    session_revocation_version: 0,
    issued_at: nowSeconds - (SESSION_TTL_SECONDS - seconds),
    expires_at: nowSeconds + seconds,
    ...overrides,
  };
  return `${SESSION_TOKEN_VERSION}.${base64url(JSON.stringify(claims))}.not-a-real-signature`;
};

const HEALTHY_TOKEN = tokenExpiringIn(6 * 60 * 60);

/** The shapes this codebase actually throws when nothing answered. */
const OFFLINE_FAILURES = [
  { message: "Network Error", code: "ERR_NETWORK", request: {} },
  { message: "timeout of 15000ms exceeded", code: "ECONNABORTED" },
  { message: "connect ECONNREFUSED 127.0.0.1:5000", code: "ECONNREFUSED" },
  { message: "getaddrinfo ENOTFOUND froozerp.local", code: "ENOTFOUND" },
  { message: "Local Only mode selected - cloud sync paused.", code: "APP_LOCAL_ONLY" },
  { message: "Local FroozERP service unreachable", kind: "BACKEND_UNREACHABLE" },
  { message: "Failed to fetch" },
  "Cloud temporarily unavailable - sync paused until internet returns.",
];

test("no unreachable-server failure is ever an authentication failure", () => {
  // The property the whole module exists for. A local-first app that says "you have been signed
  // out" to a user with no internet is both wrong and frightening, and it puts a login form they
  // cannot use in front of a shift they could otherwise finish offline.
  for (const failure of OFFLINE_FAILURES) {
    const classified = classifySessionFailure(failure);
    assert.equal(classified.authentication, false, `${JSON.stringify(failure)} must not read as auth`);
    assert.equal(classified.offline, true, `${JSON.stringify(failure)} must read as offline`);
    assert.equal(classified.answered, false);

    const outcome = resolveSessionAction({ token: HEALTHY_TOKEN, failure, nowMs: NOW_MS, online: false });
    assert.equal(outcome.action, SESSION_ACTIONS.WORK_OFFLINE);
    assert.equal(outcome.requiresSignIn, false);
  }
});

test("a network error that merely mentions 401 or expiry is still offline", () => {
  // Classification reads the HTTP status and nothing else. If it ever fell back to scanning text,
  // a proxy error page or a retry log line could sign a shop out mid-sale.
  const failures = [
    { message: "Network Error while retrying request that returned 401 earlier", code: "ERR_NETWORK" },
    { message: "connection refused - previous session expired unauthorized", code: "ECONNREFUSED" },
    "Failed to fetch: DEVICE_SESSION_EXPIRED seen in last log line",
  ];
  for (const failure of failures) {
    assert.equal(isAuthenticationFailure(failure), false, `${failure} must not read as auth`);
    assert.equal(isOfflineFailure(failure), true);
  }
});

test("a failure with no HTTP status can never be classified as authentication", () => {
  // Structural version of the rule above: no answer means no refusal, whatever the payload says.
  const shapes = [
    { code: "DEVICE_SESSION_EXPIRED", message: "expired" },
    { code: "AUTH_SESSION_REQUIRED" },
    { response: undefined, message: "Unauthorized" },
    { status: null, code: "DEVICE_SESSION_INVALID" },
    new TypeError("Cannot read properties of undefined (reading 'data')"),
  ];
  for (const failure of shapes) {
    assert.equal(classifySessionFailure(failure).authentication, false);
  }
});

test("the server refusing the session asks for a fresh sign-in", () => {
  const cases = [
    ["DEVICE_SESSION_EXPIRED", SESSION_FAILURE_KINDS.SESSION_EXPIRED],
    ["DEVICE_SESSION_INVALID", SESSION_FAILURE_KINDS.SESSION_INVALID],
    ["DEVICE_SESSION_REQUIRED", SESSION_FAILURE_KINDS.SESSION_MISSING],
    ["AUTH_SESSION_REQUIRED", SESSION_FAILURE_KINDS.SESSION_MISSING],
    ["", SESSION_FAILURE_KINDS.SESSION_INVALID],
  ];
  for (const [code, kind] of cases) {
    const failure = { response: { status: 401, data: { code, message: "Authenticated device session is invalid" } } };
    assert.equal(classifySessionFailure(failure).kind, kind, code || "(uncoded 401)");
    const outcome = resolveSessionAction({ token: HEALTHY_TOKEN, failure, nowMs: NOW_MS });
    assert.equal(outcome.action, SESSION_ACTIONS.SIGN_IN_REQUIRED);
    assert.equal(outcome.requiresSignIn, true);
    assert.equal(outcome.evidence, "SERVER");
  }
});

test("a real 401 outranks a stale offline flag", () => {
  // The branch backend can answer while the internet is down, so `online: false` is not proof that
  // nothing answered. A refusal we can point at is stronger evidence than a flag.
  const outcome = resolveSessionAction({
    token: HEALTHY_TOKEN,
    failure: { response: { status: 401, data: { code: "DEVICE_SESSION_EXPIRED" } } },
    nowMs: NOW_MS,
    online: false,
  });
  assert.equal(outcome.action, SESSION_ACTIONS.SIGN_IN_REQUIRED);
});

test("a 403 about permission never triggers a sign-in prompt", () => {
  // "You may not do that" is not "who are you". Answering it with a login screen teaches users
  // that re-signing-in defeats a permission wall — it does not, and the wall returns immediately.
  for (const code of ["AUTH_ROLE_FORBIDDEN", "SOME_OTHER_FORBIDDEN", ""]) {
    const failure = { response: { status: 403, data: { code, message: "This account does not have permission for that action." } } };
    const classified = classifySessionFailure(failure);
    assert.equal(classified.kind, SESSION_FAILURE_KINDS.PERMISSION_DENIED);
    assert.equal(classified.authentication, false);

    const outcome = resolveSessionAction({ token: HEALTHY_TOKEN, failure, nowMs: NOW_MS });
    assert.equal(outcome.action, SESSION_ACTIONS.BLOCKED_BY_PERMISSION);
    assert.equal(outcome.requiresSignIn, false);
    assert.notEqual(outcome.action, SESSION_ACTIONS.SIGN_IN_REQUIRED);
  }
});

test("a mismatched identity is blocked, not re-prompted", () => {
  const failure = {
    response: {
      status: 403,
      data: { code: "DEVICE_SESSION_SUBSTITUTION_REJECTED", message: "user_id does not match the authenticated device session" },
    },
  };
  const outcome = resolveSessionAction({ token: HEALTHY_TOKEN, failure, nowMs: NOW_MS });
  assert.equal(outcome.kind, SESSION_FAILURE_KINDS.IDENTITY_CONFLICT);
  assert.equal(outcome.action, SESSION_ACTIONS.BLOCKED_BY_PERMISSION);
  assert.equal(outcome.requiresSignIn, false);
});

test("a role-less token is the one 403 that a fresh sign-in fixes", () => {
  // The server's own message for AUTH_ROLE_UNKNOWN says "Sign in again to continue": the token
  // verifies but predates the role claim, so the remedy really is a new token.
  const failure = { response: { status: 403, data: { code: "AUTH_ROLE_UNKNOWN" } } };
  const outcome = resolveSessionAction({ token: HEALTHY_TOKEN, failure, nowMs: NOW_MS });
  assert.equal(outcome.kind, SESSION_FAILURE_KINDS.SESSION_OUTDATED);
  assert.equal(outcome.action, SESSION_ACTIONS.SIGN_IN_REQUIRED);
});

test("a failed sign-in attempt is not an expired sign-in", () => {
  // `/login` is not behind requireAuth and answers a wrong password with 401 INVALID_CREDENTIALS.
  // Repainting that as "please sign in again" tells the user nothing about what they got wrong,
  // and the login screen already words these cases precisely.
  const cases = [
    { status: 401, code: "INVALID_CREDENTIALS" },
    { status: 403, code: "DEVICE_PENDING_APPROVAL" },
    { status: 403, code: "DEVICE_DISABLED" },
    { status: 403, code: "DEVICE_REVOKED" },
    { status: 403, code: "CLOUD_DEVICE_NOT_APPROVED" },
  ];
  for (const { status, code } of cases) {
    const failure = { response: { status, data: { code, message: "Invalid username or password." } } };
    const classified = classifySessionFailure(failure);
    assert.equal(classified.authentication, false, code);
    const outcome = resolveSessionAction({ token: "", failure, nowMs: NOW_MS });
    assert.equal(outcome.requiresSignIn, false, code);
    assert.equal(outcome.action, SESSION_ACTIONS.REPORT_ERROR, code);
  }
});

test("server faults and ordinary HTTP errors are reported, not treated as sign-out", () => {
  const cases = [
    [500, "AUTH_NOT_CONFIGURED", SESSION_FAILURE_KINDS.SERVER_FAULT],
    [503, "", SESSION_FAILURE_KINDS.SERVER_FAULT],
    [404, "", SESSION_FAILURE_KINDS.OTHER],
    [409, "", SESSION_FAILURE_KINDS.OTHER],
    [422, "", SESSION_FAILURE_KINDS.OTHER],
  ];
  for (const [status, code, kind] of cases) {
    const failure = { response: { status, data: { code } } };
    assert.equal(classifySessionFailure(failure).kind, kind, String(status));
    const outcome = resolveSessionAction({ token: HEALTHY_TOKEN, failure, nowMs: NOW_MS });
    assert.equal(outcome.action, SESSION_ACTIONS.REPORT_ERROR, String(status));
    assert.equal(outcome.requiresSignIn, false);
  }
});

test("a misconfigured server (500 AUTH_NOT_CONFIGURED) never signs anyone out", () => {
  // Fail-closed on the server must not become fail-destructive on the client: every device in the
  // shop would otherwise sign out at once because of one bad environment variable.
  const outcome = resolveSessionAction({
    token: HEALTHY_TOKEN,
    failure: { response: { status: 500, data: { code: "AUTH_NOT_CONFIGURED", message: "Server authentication is not configured." } } },
    nowMs: NOW_MS,
  });
  assert.equal(outcome.requiresSignIn, false);
});

test("being signed out never authorises discarding queued offline work", () => {
  // The outbox holds sales made while offline. It lives in SQLite, survives `setUser(null)`, and
  // `pushPendingOperations` releases operations back to pending when a push throws. Nothing in
  // this module may ever suggest otherwise — if this assertion is what a future change has to
  // delete, that change is deleting a shop's unsent sales.
  const scenarios = [
    { name: "expired session refused by server", input: { token: HEALTHY_TOKEN, failure: { response: { status: 401, data: { code: "DEVICE_SESSION_EXPIRED" } } } } },
    { name: "expired by local clock", input: { token: tokenExpiringIn(-60) } },
    { name: "offline", input: { token: HEALTHY_TOKEN, failure: { code: "ERR_NETWORK", message: "Network Error" } } },
    { name: "offline flag with dead token", input: { token: tokenExpiringIn(-9999), online: false } },
    { name: "forbidden", input: { token: HEALTHY_TOKEN, failure: { response: { status: 403, data: { code: "AUTH_ROLE_FORBIDDEN" } } } } },
    { name: "warning window", input: { token: tokenExpiringIn(60) } },
    { name: "renewal available", input: { token: tokenExpiringIn(60), canRenew: true } },
    { name: "healthy", input: { token: HEALTHY_TOKEN } },
    { name: "unreadable token", input: { token: "not-a-token" } },
    { name: "server fault", input: { token: HEALTHY_TOKEN, failure: { response: { status: 500 } } } },
  ];
  const seen = new Set();
  for (const { name, input } of scenarios) {
    const outcome = resolveSessionAction({ nowMs: NOW_MS, ...input });
    assert.equal(outcome.discardQueuedWork, false, `${name} must never discard queued work`);
    seen.add(outcome.action);
  }
  // The guarantee is only worth something if the scenarios actually reach every outcome.
  assert.deepEqual([...seen].sort(), Object.values(SESSION_ACTIONS).sort());
});

test("an offline device with a long-dead token keeps working instead of signing out", () => {
  // Offline sign-in restores a cached user record, stale token and all (`offlineSession.js`), so
  // this is the ordinary state of a device that has been off the network for a day — not a fault.
  const outcome = resolveSessionAction({ token: tokenExpiringIn(-SESSION_TTL_SECONDS), nowMs: NOW_MS, online: false });
  assert.equal(outcome.action, SESSION_ACTIONS.WORK_OFFLINE);
  assert.equal(outcome.requiresSignIn, false);
  assert.equal(outcome.offline, true);
});

test("an expired token on a reachable network prompts once, marked as a local-clock judgement", () => {
  const outcome = resolveSessionAction({ token: tokenExpiringIn(-1), nowMs: NOW_MS, online: true });
  assert.equal(outcome.action, SESSION_ACTIONS.SIGN_IN_REQUIRED);
  assert.equal(outcome.requiresSignIn, true);
  // The device clock can be wrong; a caller that wants to be certain waits for the server's 401.
  assert.equal(outcome.evidence, "LOCAL_CLOCK");
});

test("expiry uses the same boundary as the server", () => {
  // `verifyDeviceSession` refuses when `expires_at <= now`. Calling that instant "still valid"
  // would produce a warning the server has already stopped agreeing with.
  assert.equal(describeTokenExpiry(tokenExpiringIn(0), NOW_MS).status, "expired");
  assert.equal(describeTokenExpiry(tokenExpiringIn(1), NOW_MS).status, "expiring");
  assert.equal(describeTokenExpiry(tokenExpiringIn(SESSION_EXPIRY_WARNING_SECONDS), NOW_MS).status, "expiring");
  assert.equal(describeTokenExpiry(tokenExpiringIn(SESSION_EXPIRY_WARNING_SECONDS + 1), NOW_MS).status, "active");
});

test("the warning window warns, and steps aside when renewal is possible", () => {
  const warned = resolveSessionAction({ token: tokenExpiringIn(12 * 60), nowMs: NOW_MS });
  assert.equal(warned.action, SESSION_ACTIONS.WARN_EXPIRING_SOON);
  assert.equal(warned.requiresSignIn, false);
  assert.match(warned.message, /about 12 minutes/);

  const renewed = resolveSessionAction({ token: tokenExpiringIn(12 * 60), nowMs: NOW_MS, canRenew: true });
  assert.equal(renewed.action, SESSION_ACTIONS.RENEW_SILENTLY);
  assert.equal(renewed.message, "", "a silent renewal must not interrupt the user");
});

test("an unreadable token is reported as unknown and never throws or signs anyone out", () => {
  // A user can reach their own localStorage. A parse error thrown from a render path takes the
  // whole app down instead of one panel, and guessing "expired" would sign out every user the
  // day the token format changes.
  const inputs = [
    "", "   ", null, undefined, 42, {}, [],
    "garbage",
    "v1",
    "v1.",
    "v1..sig",
    "v1.!!!not-base64!!!.sig",
    `v1.${base64url("not json at all")}.sig`,
    `v1.${base64url("[1,2,3]")}.sig`,
    `v2.${base64url(JSON.stringify({ expires_at: nowSeconds + 60 }))}.sig`,
    `v1.${base64url(JSON.stringify({ user_id: 1 }))}.sig`,
    `v1.${base64url(JSON.stringify({ expires_at: "soon" }))}.sig`,
    // `Number(null)`, `Number("")`, `Number([])` and `Number(false)` are all 0. A coercing expiry
    // check reads every one of these as "expired in 1970" and signs the user out.
    `v1.${base64url(JSON.stringify({ expires_at: null }))}.sig`,
    `v1.${base64url(JSON.stringify({ expires_at: "" }))}.sig`,
    `v1.${base64url(JSON.stringify({ expires_at: [] }))}.sig`,
    `v1.${base64url(JSON.stringify({ expires_at: false }))}.sig`,
    `v1.${base64url(JSON.stringify({ expires_at: {} }))}.sig`,
  ];
  for (const token of inputs) {
    const expiry = describeTokenExpiry(token, NOW_MS);
    assert.equal(expiry.status, "unknown", `${JSON.stringify(token)} must read as unknown`);
    assert.equal(expiry.secondsRemaining, null);

    const outcome = resolveSessionAction({ token, nowMs: NOW_MS });
    assert.equal(outcome.action, SESSION_ACTIONS.CONTINUE, `${JSON.stringify(token)} must not force a sign-out`);
    assert.equal(outcome.requiresSignIn, false);
  }
});

test("the payload is read without verifying the signature, and says so", () => {
  // The device holds no secret. This is a UX hint only; anything that gated access on it would be
  // trusting a value the user can edit.
  const claims = readSessionTokenPayload(tokenExpiringIn(60, { role: "OWNER" }));
  assert.equal(claims.role, "OWNER");
  assert.equal(claims.user_id, 7);

  const forged = `${SESSION_TOKEN_VERSION}.${base64url(JSON.stringify({ user_id: 9999, expires_at: nowSeconds + 999 }))}.obviously-forged`;
  assert.equal(readSessionTokenPayload(forged).user_id, 9999, "no signature check happens here");

  const source = readSource("./sessionExpiry.js");
  assert.match(source, /without\s+(?:checking|verifying)/i, "the limitation must be stated in the module");
});

test("a non-ASCII claim survives decoding", () => {
  // base64url payloads are UTF-8; a naive charCode decode would mangle a Devanagari branch name
  // and throw the parse away, which would silently downgrade a valid token to "unknown".
  const claims = readSessionTokenPayload(tokenExpiringIn(60, { device_id: "काउंटर-१" }));
  assert.equal(claims.device_id, "काउंटर-१");
});

test("every user-facing message is plain English with no codes or jargon", () => {
  // The maintainer asked for language a shop user reads once and acts on. "Please sign in again to
  // continue" is right; "DEVICE_SESSION_EXPIRED" is not.
  const banned = [
    /\b(?:400|401|403|404|409|500|503)\b/,
    /HTTP/i,
    /\btokens?\b/i,
    /\bsessions?\b/i,
    /\bauth(?:entication|orisation|orization)?\b/i,
    /\bcredentials?\b/i,
    /\bAPI\b/,
    /\bserver\b/i,
    /[A-Z]{3,}_[A-Z]{3,}/,
    /\bnull\b|\bundefined\b/,
  ];
  const scenarios = [
    { token: HEALTHY_TOKEN, failure: { response: { status: 401, data: { code: "DEVICE_SESSION_EXPIRED", message: "Authenticated device session has expired" } } } },
    { token: HEALTHY_TOKEN, failure: { response: { status: 401, data: { code: "AUTH_SESSION_REQUIRED" } } } },
    { token: HEALTHY_TOKEN, failure: { response: { status: 403, data: { code: "AUTH_ROLE_FORBIDDEN" } } } },
    { token: HEALTHY_TOKEN, failure: { response: { status: 403, data: { code: "DEVICE_SESSION_SUBSTITUTION_REJECTED" } } } },
    { token: HEALTHY_TOKEN, failure: { response: { status: 500, data: { code: "AUTH_NOT_CONFIGURED" } } } },
    { token: HEALTHY_TOKEN, failure: { response: { status: 404 } } },
    { token: HEALTHY_TOKEN, failure: { code: "ERR_NETWORK", message: "Network Error" } },
    { token: tokenExpiringIn(90) },
    { token: tokenExpiringIn(SESSION_EXPIRY_WARNING_SECONDS - 1) },
  ];
  for (const scenario of scenarios) {
    const { message } = resolveSessionAction({ nowMs: NOW_MS, ...scenario });
    assert.ok(message.length > 0, `${JSON.stringify(scenario)} must explain itself`);
    for (const pattern of banned) {
      assert.equal(pattern.test(message), false, `"${message}" contains ${pattern}`);
    }
  }
});

test("a sign-out message reassures the user that local work survives", () => {
  // The first fear when a login screen appears mid-shift is that the morning's sales went with it.
  const outcome = resolveSessionAction({
    token: HEALTHY_TOKEN,
    failure: { response: { status: 401, data: { code: "DEVICE_SESSION_EXPIRED" } } },
    nowMs: NOW_MS,
  });
  assert.match(outcome.message, /saved on this device is safe/i);
});

test("remaining time is spoken the way a person would say it", () => {
  assert.equal(describeRemainingTime(0), "less than a minute");
  assert.equal(describeRemainingTime(-500), "less than a minute");
  assert.equal(describeRemainingTime(45), "less than a minute");
  assert.equal(describeRemainingTime(14 * 60), "about 14 minutes");
  assert.equal(describeRemainingTime(3600), "about an hour");
  assert.equal(describeRemainingTime(5 * 3600), "about 5 hours");
  assert.equal(describeRemainingTime("nonsense"), "less than a minute");
});

test("no failure and a healthy session means carry on silently", () => {
  const outcome = resolveSessionAction({ token: HEALTHY_TOKEN, nowMs: NOW_MS });
  assert.equal(outcome.action, SESSION_ACTIONS.CONTINUE);
  assert.equal(outcome.message, "");
  assert.equal(classifySessionFailure(null).kind, SESSION_FAILURE_KINDS.NONE);
  assert.equal(classifySessionFailure(undefined).authentication, false);
});

test("decisions are frozen so a consumer cannot mutate one into a sign-out", () => {
  const outcome = resolveSessionAction({ token: HEALTHY_TOKEN, nowMs: NOW_MS });
  assert.equal(Object.isFrozen(outcome), true);
});

test("the module agrees with the backend it is reading", () => {
  // These constants and codes are the backend's, restated here. If A-4 renames one, this fails
  // instead of the module quietly mapping an unknown code to the wrong outcome.
  const deviceSession = readSource("../../../backend/deviceSession.js");
  const authMiddleware = readSource("../../../backend/authMiddleware.js");

  assert.match(deviceSession, new RegExp(`TOKEN_VERSION = "${SESSION_TOKEN_VERSION}"`));
  assert.match(deviceSession, /DEFAULT_TTL_SECONDS = 12 \* 60 \* 60/);
  assert.equal(SESSION_TTL_SECONDS, 12 * 60 * 60);

  const moduleSource = readSource("./sessionExpiry.js");
  const backendCodes = [
    ["DEVICE_SESSION_EXPIRED", deviceSession],
    ["DEVICE_SESSION_INVALID", deviceSession],
    ["DEVICE_SESSION_REQUIRED", deviceSession],
    ["DEVICE_SESSION_SUBSTITUTION_REJECTED", deviceSession],
    ["AUTH_SESSION_REQUIRED", authMiddleware],
    ["AUTH_ROLE_UNKNOWN", authMiddleware],
  ];
  for (const [code, source] of backendCodes) {
    assert.ok(source.includes(code), `${code} must still exist in the backend`);
    assert.ok(moduleSource.includes(code), `${code} must still be handled here`);
  }
});

// -----------------------------------------------------------------------------------------------
// The offline-purchase replay path, which this module is now wired into.
//
// `replayOfflinePurchase` turns a failed replay into an *acknowledgement* — a verdict on the
// purchase that marks it `failed` in `local_purchases` and drops it out of the automatic retry
// queue. Before A-4 almost nothing returned 401, so the distinction rarely mattered. After it, an
// expired session would have marked a shop's whole queue of offline sales as business rejections.
// -----------------------------------------------------------------------------------------------

test("a replay failure that judged nothing about the purchase is retried, not recorded", () => {
  const source = fs.readFileSync(new URL("./syncService.js", import.meta.url), "utf8");
  assert.match(
    source,
    /if \(classified\.authentication \|\| NON_BUSINESS_REPLAY_KINDS\.has\(classified\.kind\)\) throw error;/,
    "replayOfflinePurchase must rethrow so the caller releases the operations back to pending",
  );

  // The behavioural half: exactly the failures that must be rethrown, and the ones that must not.
  const rethrown = [
    { response: { status: 401, data: { code: "DEVICE_SESSION_EXPIRED" } } },
    { response: { status: 401, data: { code: "AUTH_SESSION_REQUIRED" } } },
    { response: { status: 403, data: { code: "AUTH_ROLE_FORBIDDEN" } } },
    { response: { status: 403, data: { code: "DEVICE_SESSION_SUBSTITUTION_REJECTED" } } },
    { response: { status: 500, data: { code: "AUTH_NOT_CONFIGURED" } } },
    { response: { status: 503, data: {} } },
  ];
  const nonBusinessKinds = new Set([
    SESSION_FAILURE_KINDS.PERMISSION_DENIED,
    SESSION_FAILURE_KINDS.IDENTITY_CONFLICT,
    SESSION_FAILURE_KINDS.SERVER_FAULT,
  ]);
  const mustRethrow = (failure) => {
    const classified = classifySessionFailure(failure);
    return classified.authentication || nonBusinessKinds.has(classified.kind);
  };

  for (const failure of rethrown) {
    assert.equal(mustRethrow(failure), true, `must requeue: ${JSON.stringify(failure.response)}`);
  }

  // A genuine verdict on the purchase itself must still be recorded, or a duplicate or invalid
  // purchase would retry forever instead of being reported to the shop.
  for (const failure of [
    { response: { status: 409, data: { code: "DUPLICATE_OPERATION" } } },
    { response: { status: 400, data: { code: "VALIDATION_FAILED" } } },
    { response: { status: 422, data: {} } },
  ]) {
    assert.equal(mustRethrow(failure), false, `must record: ${JSON.stringify(failure.response)}`);
  }
});

test("App.jsx reacts to an ended session in exactly one place, and only when signed in", () => {
  // Source-text assertions are how this repo pins structure. The properties being pinned:
  //   - one interceptor, not per-panel handling, so the user gets one sentence not twenty;
  //   - it is inert on the login screen, where a 401 means "wrong password", not "session ended";
  //   - it passes the offline flag, without which an outage reads as a sign-out;
  //   - it rethrows, so panels error rather than rendering empty;
  //   - it ejects, or every re-render stacks another copy and the user is prompted N times.
  const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /axios\.interceptors\.response\.use\(undefined, \(error\) => \{/);
  assert.match(app, /if \(!user\) return undefined;/);
  assert.match(app, /online: !offlineMode/);
  assert.match(app, /return Promise\.reject\(error\);/);
  assert.match(app, /axios\.interceptors\.response\.eject\(interceptorId\)/);
  assert.equal(
    (app.match(/axios\.interceptors\.response\.use/g) || []).length,
    1,
    "a second response interceptor would mean two answers to the same question",
  );
});
