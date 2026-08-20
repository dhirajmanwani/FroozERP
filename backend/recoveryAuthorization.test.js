"use strict";

/**
 * The account-management routes that could be driven by an anonymous caller.
 *
 * `requireSelfOrRateManager(target, actor)` passes whenever target and actor are the same user.
 * Seven routes called it with both arguments derived from the *same client-supplied field*, so the
 * comparison was always true and the guard always passed. That turned into a full takeover chain:
 * read the Owner's recovery contacts, repoint them at yourself, recover the account.
 *
 * These tests pin the fix from both ends — the guard's own behaviour, and the fact that every
 * caller now sits behind `requireAuth`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const backendSource = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

/**
 * Source with comments removed.
 *
 * The comment above `requireSelfOrRateManager` quotes the vulnerable call verbatim, because a fix
 * whose reason is not written down gets undone. A "this pattern must not appear" assertion has to
 * look at code, or the explanation of the bug reads as the bug.
 */
const backendCode = backendSource
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** The seven routes that shared the defect. */
const GUARDED_ROUTES = [
  ['app.get("/auth/recovery/profile"', "reads recovery email and mobile in the clear"],
  ['app.post("/auth/recovery/contact/request"', "repoints a recovery contact"],
  ['app.post("/auth/recovery/contact/verify"', "confirms a repointed recovery contact"],
  ['app.post("/api/auth/email/send-verification"', "sends a verification to a chosen address"],
  ['app.post("/api/auth/email/verify"', "marks an address verified"],
  ['app.post("/api/auth/phone/send-otp"', "sends an OTP to a chosen number"],
  ['app.post("/api/auth/phone/verify-otp"', "marks a number verified"],
];

test("the actor is never taken from a client-supplied field", () => {
  // The exact shape of the vulnerability. Both arguments came from the same request value, so the
  // self-comparison inside the guard could not fail.
  assert.doesNotMatch(
    backendCode,
    /requireSelfOrRateManager\(\s*userId,\s*req\.(query|body)\./,
    "the actor must come from the verified session, not from the request",
  );
  assert.doesNotMatch(
    backendCode,
    /requireSelfOrRateManager\([^)]*updated_by/,
    "`updated_by` is a client-supplied field and can never establish who the caller is",
  );

  const sessionDerived = backendCode.match(/requireSelfOrRateManager\(\s*userId,\s*req\.auth\.userId/g) || [];
  assert.equal(
    sessionDerived.length,
    GUARDED_ROUTES.length,
    `all ${GUARDED_ROUTES.length} call sites must derive the actor from req.auth`,
  );
});

test("every route reachable by that chain requires a verified session", () => {
  // `req.auth` only exists when `requireAuth` ran. A call site reading it on an unmounted route
  // would throw rather than authorise, but relying on that is relying on a crash — assert the mount.
  for (const [registration, why] of GUARDED_ROUTES) {
    const escaped = registration.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(
      backendSource,
      new RegExp(`${escaped},\\s*requireAuth,`),
      `${registration} must require a session — it ${why}`,
    );
  }
});

test("requireAuth is built from the resolved signing key, once", () => {
  assert.match(backendSource, /const requireAuth = createRequireAuth\(\{ secret: deviceSessionSecret \}\)/);
  assert.equal(
    (backendSource.match(/createRequireAuth\(/g) || []).length,
    1,
    "a second instance could be built with a different secret and silently accept different tokens",
  );
});

test("the guard still cannot authenticate, which is why the session is required", () => {
  // Documents the boundary rather than pretending the guard was fixed: given equal ids it passes,
  // by design. Its safety comes entirely from the actor id being proven before it arrives.
  const source = backendSource.slice(backendSource.indexOf("const requireSelfOrRateManager"));
  assert.match(
    source.slice(0, 600),
    /if \(parsedTarget === parsedActor\)/,
    "self-access is still permitted; only the provenance of the actor id changed",
  );
});
