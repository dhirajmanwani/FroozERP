"use strict";

/**
 * A-7 step 1 — the cross-branch write hole.
 *
 * 22 handlers were registered twice: once behind `v3WriteAdapter`, once on a bare legacy path. On
 * the legacy path `req.v3OperationalContext` is undefined, so the scope filter
 * `($2::INTEGER IS NULL OR company_id = $2)` binds NULL, the conjunct is true, and the row is
 * selected **by primary key alone**. `PUT /lots/<any id>` rewrote another branch's lot and the
 * change published to that branch attributed to a foreign actor.
 *
 * These tests exist because the fix is a list, and a list is only as good as the next person's
 * willingness to keep it accurate.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { LEGACY_WRITE_ROUTES, isRetiredLegacyWrite } = require("./operationalScope");

const backendSource = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const backendCode = backendSource
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

test("every retired legacy write is refused, whatever its id looks like", () => {
  // Ids in this system are opaque strings (CLAUDE.md), so the matcher must not assume numeric.
  for (const [method, routePath] of LEGACY_WRITE_ROUTES) {
    for (const id of ["1", "004", "abc-def", "a%20b", "00000000-0000-0000-0000-000000000000"]) {
      const concrete = routePath.replace(/:[A-Za-z]+/g, id);
      assert.equal(
        isRetiredLegacyWrite(method, concrete),
        true,
        `${method} ${concrete} must be refused`,
      );
    }
  }
});

test("the protocol-v3 replacements are never refused", () => {
  // Refusing the replacement as well as the original would take the feature away entirely.
  for (const [method, , replacement] of LEGACY_WRITE_ROUTES) {
    const v3 = replacement.replace(/:[A-Za-z]+/g, "7");
    assert.equal(isRetiredLegacyWrite(method, v3), false, `${method} ${v3} must still work`);
  }
});

test("reads on the same paths are untouched", () => {
  // The shipped client still GETs /sales and /purchases. This stage closes writes only; the read
  // exposure is a separate, larger piece of work.
  for (const routePath of ["/sales", "/products", "/purchase-bill", "/inventory-lots/9"]) {
    assert.equal(isRetiredLegacyWrite("GET", routePath), false, `GET ${routePath} must still work`);
  }
});

test("the matcher does not over-match, which is how the old regex failed", () => {
  // LEGACY_OPERATIONAL_ROUTE ends each alternative with (?:\/|$), so /sales-history escaped it.
  // The replacement must not make the opposite mistake and swallow neighbours.
  for (const [method, routePath] of [
    ["POST", "/sales-history"],
    ["POST", "/salesx"],
    ["PUT", "/products"],
    ["POST", "/products/1/opening-stock/extra"],
    ["POST", "/x/sales"],
    ["POST", "/sales/1/cancel/again"],
    ["PUT", "/products/1/2"],
  ]) {
    assert.equal(isRetiredLegacyWrite(method, routePath), false, `${method} ${routePath} must not match`);
  }
});

test("a parameter matches exactly one segment", () => {
  assert.equal(isRetiredLegacyWrite("PUT", "/products/1"), true);
  assert.equal(isRetiredLegacyWrite("PUT", "/products/1/2"), false, "a parameter is not a wildcard");
  assert.equal(isRetiredLegacyWrite("PUT", "/products/"), false, "and it is not optional");
});

test("the verb matters, so a retired POST does not retire the GET", () => {
  assert.equal(isRetiredLegacyWrite("POST", "/sales"), true);
  assert.equal(isRetiredLegacyWrite("get", "/sales"), false);
  assert.equal(isRetiredLegacyWrite("", "/sales"), false);
});

test("the refusal runs behind authentication, not in front of it", () => {
  // Ahead of the auth gate a stranger probing a retired path learns it exists and receives an
  // upgrade hint rather than a refusal, and the route-coverage test rightly stops counting these
  // routes as authenticated.
  const authIndex = backendCode.indexOf("if (PUBLIC_ROUTES.has(publicRouteKey(req))) return next();");
  const retireIndex = backendCode.indexOf("const replacement = retiredLegacyWriteReplacement(req.method, req.path);");
  assert.ok(authIndex > 0 && retireIndex > 0, "both gates must exist");
  assert.ok(authIndex < retireIndex, "authentication must come first");
});

test("the refusal is unconditional, not gated on the scope mode", () => {
  // FROOZERP_OPERATIONAL_SCOPE_MODE defaults to `off` and nothing in the repository sets it. A hole
  // that closes only when an environment variable happens to be set is not closed.
  const gate = backendCode.slice(
    backendCode.indexOf("const replacement = retiredLegacyWriteReplacement(req.method, req.path);"),
    backendCode.indexOf("const replacement = retiredLegacyWriteReplacement(req.method, req.path);") + 400,
  );
  assert.doesNotMatch(gate, /operationalScopeMode|SCOPE_MODES/, "no scope-mode condition may guard this");
});

test("every listed route still has a v3 twin registered, or retiring it removes the feature", () => {
  // The safety of this whole stage rests on the replacement existing. If a v3 registration is ever
  // deleted while its legacy twin stays on this list, the operation becomes impossible rather than
  // merely upgraded — and nothing else in the suite would notice.
  for (const [method, routePath, replacement] of LEGACY_WRITE_ROUTES) {
    assert.ok(
      backendCode.includes(`"${replacement}"`),
      `${method} ${replacement} must be registered before ${method} ${routePath} can be retired`,
    );
  }
});
