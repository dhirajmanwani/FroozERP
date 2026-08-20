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
