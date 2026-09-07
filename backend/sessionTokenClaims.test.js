"use strict";

/**
 * Every token this server mints must carry the account's revocation version.
 *
 * ## What went wrong
 *
 * `issueDeviceSession` defaults `sessionRevocationVersion` to 0, and `revokedSessionGuard` compares
 * that claim against the row on **every authenticated request**. `/login` passed it. The Owner's
 * shop-view token, issued by `/api/owner/view-branch`, did not — so it claimed version 0 for an
 * account whose real version had long since moved on. Every request after that token was minted
 * failed the comparison and came back `SESSION_REVOKED`.
 *
 * The version moves on each time anybody signs out (Gate 1.5), so this was not a rare edge: after
 * the Owner's first sign-out it was certain, and each subsequent sign-out incremented it again.
 *
 * ## Why it was so hard to see
 *
 * It presented as *"Settings logs me out while I scroll"* on 2026-09-07. Opening Settings reaches
 * the All Shops controls, a view token is issued there, and from that moment the session is dead —
 * so the app signed the Owner out, and signing back in and returning to Settings reproduced it
 * exactly. It reads as an expired sign-in, which is the one explanation that makes signing in again
 * look like the right response.
 *
 * Six other explanations were eliminated from source first — the kill-switch policy file, a NULL
 * revocation column, a token field-name mismatch, Settings requests omitting the token, the
 * revocation guard's own database-failure path, and a stale backend holding the port. None of them
 * were it, and none of them left a mark anywhere either.
 *
 * ## What is pinned
 *
 * Not "view-branch passes it" — the next route to mint a token will not know to. Every call site
 * must, and the default of 0 is exactly what makes the omission silent rather than loud.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SERVER = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

/** Each `issueDeviceSession({ ... })` call in server.js, as source text. */
const issueCallSites = () => {
  const calls = [];
  const marker = "issueDeviceSession({";
  for (let at = SERVER.indexOf(marker); at !== -1; at = SERVER.indexOf(marker, at + 1)) {
    // Balanced to the closing `})` so a call is never truncated by a fixed window.
    let depth = 0;
    let end = at + marker.length - 1;
    for (; end < SERVER.length; end += 1) {
      if (SERVER[end] === "{") depth += 1;
      else if (SERVER[end] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(SERVER.slice(at, end + 1));
  }
  return calls;
};

test("there are token call sites to check, so this file cannot pass on nothing", () => {
  assert.ok(issueCallSites().length >= 2, "server.js must still mint sessions in more than one place");
});

test("every issued token carries the revocation version", () => {
  // The whole bug in one assertion. A token minted without it claims 0, and any account that has
  // ever signed out is past 0.
  for (const [index, call] of issueCallSites().entries()) {
    assert.match(
      call,
      /sessionRevocationVersion:/,
      `token call site ${index} does not carry sessionRevocationVersion:\n${call}`,
    );
  }
});

test("the shop-view token specifically, because that is the one that was wrong", () => {
  const viewBranch = issueCallSites().find((call) => call.includes("viewOnly:"));
  assert.ok(viewBranch, "the Owner's shop-view token must still be issued");
  assert.match(viewBranch, /sessionRevocationVersion: owner\.session_revocation_version \|\| 0/);
});

test("the owner lookup selects the column the token needs", () => {
  // The fix has two halves and the query half is the easier one to lose in a later tidy-up: a
  // SELECT that stops returning the column makes the value `undefined`, which `|| 0` turns straight
  // back into the original bug, silently.
  const start = SERVER.indexOf("const getOwnerUser");
  assert.notEqual(start, -1);
  const fn = SERVER.slice(start, SERVER.indexOf("};", start));
  assert.match(fn, /u\.session_revocation_version/, "getOwnerUser must read the revocation version");
});

test("the guard that compares them is still mounted on every authenticated request", () => {
  // If this were ever removed the tests above would keep passing while the property they protect
  // stopped existing — and the failure would be the opposite one: revoked sessions living on.
  assert.match(SERVER, /^app\.use\(revokedSessionGuard\);$/m);
  assert.match(SERVER, /code: "SESSION_REVOKED"/);
});

test("a refusal is written down where somebody can read it", () => {
  // The reason this took a day. `sendAuthError` returned the refusal and logged nothing, so the one
  // fact that settles any sign-out question -- which route, under which code -- existed only inside
  // a response body nobody could see. Seven explanations were eliminated from source instead.
  const middleware = fs.readFileSync(path.join(__dirname, "authMiddleware.js"), "utf8");
  assert.match(middleware, /\[auth-refused\]/, "every auth refusal must be logged");
  assert.match(middleware, /const sendAuthError = \(res, error, req = null\)/, "and must be able to name the route");

  // Every call site passes the request, or the log line names no route and is useless.
  const callSites = middleware.match(/sendAuthError\([^)]*\)/g) || [];
  const calls = callSites.filter((line) => !line.includes("res, error, req = null"));
  assert.ok(calls.length >= 8, "sanity: the call sites could not be found");
  for (const call of calls) {
    assert.match(call, /, req\)$/, `refusal does not name its request: ${call}`);
  }

  // The token itself must never appear in a log line. A refusal record that leaks the credential it
  // refused is worse than no record.
  const logLine = middleware.slice(middleware.indexOf("[auth-refused]") - 200, middleware.indexOf("[auth-refused]") + 200);
  assert.doesNotMatch(logLine, /token\b(?!=)/, "the token value must not be logged");
});

test("the revocation mismatch logs both numbers", () => {
  // Without the pair, "session revoked" and "token minted without the claim" look identical - and
  // the second is a bug in this server, not an ended session.
  assert.match(SERVER, /\[auth-refused\] 401 SESSION_REVOKED/);
  assert.match(SERVER, /row=\$\{Number\(user\.session_revocation_version \|\| 0\)\}/);
  assert.match(SERVER, /token=\$\{Number\(req\.auth\.sessionRevocationVersion \|\| 0\)\}/);
});
