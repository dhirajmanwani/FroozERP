/**
 * A-6 Gate 1.5 — a revoked session stops working, and signing out revokes one.
 *
 * `session_revocation_version` was carried in the token, incremented when a password was reset or
 * an account disabled, and compared against the database - but only inside `resolveSyncContext`.
 * So a session revoked because somebody's password had been changed was refused by sync and
 * accepted by the other 268 routes. The claim was read into `req.auth` and then never used.
 *
 * And signing out was a client-side gesture: the app forgot the token, the token kept working for
 * the rest of its twelve hours. On a shared counter machine that is the whole problem.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const backendCode = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

test("the revocation check is mounted app-wide, not per route", () => {
  // Per route would be 285 chances to miss one, and a miss here is a revoked session that keeps
  // working rather than a visible bug.
  assert.match(backendCode, /app\.use\(revokedSessionGuard\);/);
  const guardIndex = backendCode.indexOf("const revokedSessionGuard = async");
  const mountIndex = backendCode.indexOf("app.use(revokedSessionGuard);");
  const authIndex = backendCode.indexOf("return requireAuth(req, res, next);");
  assert.ok(guardIndex > 0 && mountIndex > guardIndex, "the guard must be defined before it is mounted");
  assert.ok(authIndex < mountIndex, "it must run after authentication, which is what puts req.auth there");
});

test("it compares the token's version against the database, not against itself", () => {
  const guard = backendCode.slice(
    backendCode.indexOf("const revokedSessionGuard = async"),
    backendCode.indexOf("app.use(revokedSessionGuard);"),
  );
  assert.match(guard, /SELECT session_revocation_version, active FROM users WHERE id = \$1/);
  assert.match(guard, /req\.auth\.userId/, "the row must be looked up by the token's own user id");
  assert.match(guard, /!== Number\(req\.auth\.sessionRevocationVersion \|\| 0\)/);
});

test("an unreadable answer denies rather than allows", () => {
  // A database that cannot say whether this session is still valid has not said yes. Treating
  // silence as approval is how a revoked session outlives its revocation.
  const guard = backendCode.slice(
    backendCode.indexOf("const revokedSessionGuard = async"),
    backendCode.indexOf("app.use(revokedSessionGuard);"),
  );
  assert.match(guard, /catch \(error\)/);
  assert.match(guard, /res\.status\(503\)/, "a failed check must refuse, not fall through");
  assert.doesNotMatch(guard.slice(guard.indexOf("catch (error)")), /return next\(\)/,
    "the failure path must never call next()");
});

test("a disabled account is refused even if its version still matches", () => {
  const guard = backendCode.slice(
    backendCode.indexOf("const revokedSessionGuard = async"),
    backendCode.indexOf("app.use(revokedSessionGuard);"),
  );
  assert.match(guard, /user\.active === false/);
  // And a deleted account, whose row is simply gone.
  assert.match(guard, /if \(!user\)/);
});

test("signing out revokes the caller's own sessions and nobody else's", () => {
  const route = backendCode.slice(
    backendCode.indexOf('app.post("/auth/sign-out"'),
    backendCode.indexOf('app.post("/auth/sign-out"') + 1600,
  );
  assert.match(route, /session_revocation_version = COALESCE\(session_revocation_version, 0\) \+ 1/);
  assert.match(route, /\[req\.auth\.userId\]/, "the id must come from the verified token");
  // Reading it from the request is the A-3 bug: one user signing another out, or worse.
  assert.doesNotMatch(route, /req\.body\.(user_id|userId)|req\.params/,
    "the account to revoke must never come from the request");
});

test("a failed sign-out says so rather than reporting success", () => {
  // Reporting success on a failed revocation leaves somebody believing they are signed out while
  // the session is still live - worse than showing them an error.
  const route = backendCode.slice(
    backendCode.indexOf('app.post("/auth/sign-out"'),
    backendCode.indexOf('app.post("/auth/sign-out"') + 1600,
  );
  const successIndex = route.indexOf("success: true");
  const catchIndex = route.indexOf("catch (error)");
  assert.ok(successIndex > 0 && catchIndex > successIndex, "success must be inside the try, not after it");
  assert.match(route.slice(catchIndex), /SIGN_OUT_FAILED/);
});

test("the app tells the server, and still signs out locally when it cannot", () => {
  const frontend = fs.readFileSync(path.join(__dirname, "..", "frontend", "src", "App.jsx"), "utf8");
  const signOut = frontend.slice(frontend.indexOf("const signOut = useCallback"), frontend.indexOf("const signOut = useCallback") + 1400);
  assert.match(signOut, /auth\/sign-out/, "the button must reach the server, not only clear local state");
  // Someone pressing sign out on a counter with no internet must still end up signed out on that
  // screen. Refusing to clear it because a request failed leaves their session on display.
  const clearIndex = signOut.indexOf("setUser(null)");
  const catchIndex = signOut.indexOf("catch");
  assert.ok(catchIndex > 0 && clearIndex > catchIndex, "the local sign-out must happen after the catch, not inside the try");
});
