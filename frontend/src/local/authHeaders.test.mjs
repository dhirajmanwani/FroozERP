import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUTHORIZATION_HEADER,
  SESSION_HEADER,
  optionalSessionAuthHeaders,
  sessionAuthHeaders,
  shouldAttachSessionAuth,
} from "./authHeaders.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const readSource = (relative) => fs.readFileSync(path.join(here, relative), "utf8");

test("a signed-in request carries the token as Bearer and as the legacy header", () => {
  const headers = sessionAuthHeaders("v1.payload.signature");
  assert.equal(headers[AUTHORIZATION_HEADER], "Bearer v1.payload.signature");
  assert.equal(headers[SESSION_HEADER], "v1.payload.signature");
});

test("both headers carry the same token", () => {
  // If these ever disagree, one of the two backends' verification paths is being handed a
  // different credential than the other, which is unresolvable from the server side.
  const headers = sessionAuthHeaders("a-token");
  assert.equal(headers[AUTHORIZATION_HEADER], `Bearer ${headers[SESSION_HEADER]}`);
});

test("no token means no Authorization header, rather than an empty one", () => {
  // `Bearer ` is a malformed credential; absence is what "not signed in" means.
  for (const value of ["", "   ", null, undefined, 0, {}]) {
    const headers = sessionAuthHeaders(value);
    assert.ok(!(AUTHORIZATION_HEADER in headers), `must omit Authorization for ${JSON.stringify(value)}`);
    assert.equal(headers[SESSION_HEADER], "", "the legacy header keeps its empty-string behaviour");
  }
});

test("surrounding whitespace never reaches the wire", () => {
  const headers = sessionAuthHeaders("  v1.token  ");
  assert.equal(headers[AUTHORIZATION_HEADER], "Bearer v1.token");
  assert.equal(headers[SESSION_HEADER], "v1.token");
});

test("the optional form omits the headers entirely when signed out", () => {
  // The sync paths distinguish "no credentials" from "empty credentials"; preserve that.
  assert.equal(optionalSessionAuthHeaders(""), undefined);
  assert.equal(optionalSessionAuthHeaders(null), undefined);
  assert.equal(optionalSessionAuthHeaders("   "), undefined);
  const headers = optionalSessionAuthHeaders("v1.token");
  assert.equal(headers[AUTHORIZATION_HEADER], "Bearer v1.token");
  assert.equal(headers[SESSION_HEADER], "v1.token");
});

test("the header names are exactly what the backend reads", () => {
  // backend/authMiddleware.js lowercases incoming header names; these are the two it accepts.
  assert.equal(SESSION_HEADER, "x-froozerp-device-session");
  assert.equal(AUTHORIZATION_HEADER.toLowerCase(), "authorization");
});

test("every request layer builds its auth headers here, not inline", () => {
  // The property this module exists for: one place decides how a request proves who it is. An
  // inline header literal is a copy that will drift.
  for (const file of ["../App.jsx", "./syncService.js"]) {
    const source = readSource(file);
    const inline = source.match(/"x-froozerp-device-session"\s*:/g) || [];
    assert.equal(
      inline.length,
      0,
      `${file} must build session headers with sessionAuthHeaders, not inline (${inline.length} inline uses)`,
    );
    assert.match(source, /[sS]essionAuthHeaders/, `${file} must use the shared helper`);
  }
});

// -----------------------------------------------------------------------------------------------
// Where the token is allowed to travel.
//
// A global request interceptor attaches headers to every axios call in the process. Without a
// scope check that includes calls to hosts this app does not own, and a bearer token handed to a
// third party is a working credential for the whole business.
// -----------------------------------------------------------------------------------------------

test("the token goes to configured API origins and to same-origin requests", () => {
  const allowed = ["https://api.example.com", "http://192.168.1.9:5000/"];
  assert.equal(shouldAttachSessionAuth("https://api.example.com/login", allowed), true);
  assert.equal(shouldAttachSessionAuth("http://192.168.1.9:5000/sales", allowed), true);
  assert.equal(shouldAttachSessionAuth("/api/sync/pull", allowed), true, "relative is same-origin");
  assert.equal(shouldAttachSessionAuth("reports/summary", allowed), true);
});

test("the token never goes to a host the app was not configured to talk to", () => {
  const allowed = ["https://api.example.com"];
  for (const url of [
    "https://evil.example.net/collect",
    "http://api.example.com/login",          // different scheme is a different origin
    "https://api.example.com.evil.net/x",    // suffix trick
    "https://api.example.com:8443/login",    // different port is a different origin
  ]) {
    assert.equal(shouldAttachSessionAuth(url, allowed), false, `must not send the token to ${url}`);
  }
});

test("with nothing configured, only same-origin requests carry the token", () => {
  // Failing towards "send nothing" is the safe direction; the alternative leaks on misconfiguration.
  assert.equal(shouldAttachSessionAuth("https://api.example.com/x", []), false);
  assert.equal(shouldAttachSessionAuth("https://api.example.com/x", [""]), false);
  assert.equal(shouldAttachSessionAuth("https://api.example.com/x", [null, undefined]), false);
  assert.equal(shouldAttachSessionAuth("/local", []), true);
});

test("an unparseable allowed origin is ignored, not treated as a wildcard", () => {
  assert.equal(shouldAttachSessionAuth("https://api.example.com/x", ["not a url"]), false);
});

/**
 * The token a request carries must be the one the session actually has.
 *
 * ## What went wrong
 *
 * The request interceptor closed over `user?.device_session_token` and re-installed whenever `user`
 * changed. That is one render too late for the requests that matter most, because `login()` does:
 *
 *     setUser(response.data);
 *     await registerCloudDevice(...);
 *     await hydrateOnlineSession(...);   // /products, /settings, /inventory, /customers ...
 *
 * `setUser` only schedules a render, so every await above ran under the *previous* interceptor with
 * the *previous* token. The shop's cloud log on 2026-09-09 showed both halves of that, one per
 * sign-in: `401 AUTH_SESSION_REQUIRED` on the first (no earlier session, so no token at all) and
 * `401 DEVICE_SESSION_EXPIRED` on the next (the token belonging to the session just signed out).
 *
 * ## Why it presented as nothing at all
 *
 * `fetchOnlineReferenceSnapshot` falls back to locally cached values when a request fails. On a
 * device whose database had just been cleared those values were empty, so the failure rendered as
 * empty POS and Dashboard screens under a banner reading "Cloud sync active", with `lastSync` blank
 * and `failedSync` zero. Every visible signal said healthy.
 *
 * ## What is pinned
 *
 * Two halves, because either alone leaves the bug: the interceptor must read the token when the
 * request is made, and `login()` must put the new session in the ref before it awaits anything.
 */
test("the interceptor reads the session when the request is made, not when it was installed", () => {
  const app = readSource("../App.jsx");
  const start = app.indexOf("axios.interceptors.request.use");
  assert.notEqual(start, -1, "the request interceptor must still exist");
  const block = app.slice(app.lastIndexOf("useEffect", start), app.indexOf("}, [", start));

  assert.match(
    block,
    /const token = userRef\.current\?\.device_session_token/,
    "the token must be read inside the handler, from a ref",
  );
  assert.doesNotMatch(
    block,
    /const token = user\?\.device_session_token/,
    "closing over the rendered user is what made the first requests after login carry a stale token",
  );
  // Installed once. A dependency on `user` is what tied the interceptor's lifetime to the render
  // cycle in the first place.
  assert.match(app.slice(start, start + 900), /\}, \[\]\);/);
});

test("login puts the new session in the ref before it awaits anything", () => {
  // The other half. A request-time read is useless if the ref still holds the old session when the
  // post-login calls run.
  const app = readSource("../App.jsx");
  const at = app.indexOf("userRef.current = response.data;");
  assert.notEqual(at, -1, "login must record the new session synchronously");

  const setUserAt = app.lastIndexOf("setUser(response.data);", at);
  assert.notEqual(setUserAt, -1);
  const between = app.slice(setUserAt, at);
  assert.doesNotMatch(between, /await /, "nothing may be awaited between signing in and recording the session");

  // And it must come before the calls that were failing.
  const registerAt = app.indexOf("await registerCloudDevice(response.data", at);
  assert.ok(registerAt > at, "the ref must be set before the post-login calls run");
});
