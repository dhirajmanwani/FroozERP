/**
 * A-6 Gate 3.2 — every public route that accepts a guess must cost something to guess at.
 *
 * `publicRouteThrottle.test.js` proves the limiter is correct. It does not prove any route uses it,
 * and a limiter nothing calls is decoration. This suite closes that gap from the other end: it
 * reads the public allow-list out of `server.js` and requires every entry that takes a submission
 * to either consult the throttle or carry a written reason why it does not need to.
 *
 * Derived from the allow-list rather than from a list kept here on purpose. A hand-kept list is a
 * list somebody has to remember to update, and the failure mode is silent - a public route added
 * next year with no limiter would simply not appear in it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const backendCode = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

/**
 * Routes that accept a submission but are deliberately not IP-throttled, each with the control that
 * stands in its place. A route may only be here if something else genuinely makes guessing costly.
 */
const THROTTLE_EXEMPT = Object.freeze({
  "POST /login": {
    instead: "A-5 per-account lockout with an escalating delay.",
    // Recorded rather than waved away: a per-account lock does nothing against one password tried
    // across many accounts. An address limit would help, and is not applied here because a shop is
    // one address - five staff signing in through the same connection would trip it during an
    // ordinary morning, and locking the counter out of billing is a worse failure than the one it
    // prevents. Revisit if login ever moves off a shared connection.
    residual: "password spraying across accounts from one address",
  },
  "POST /bootstrap/first-owner-device": {
    instead: "A-6 Gate 3.3 refuses it before it reads the body. There is nothing left to guess at.",
    residual: null,
  },
  "POST /auth/recovery/verify-otp": {
    instead: "A per-request attempt cap on the recovery record itself, which survives a changed address.",
    residual: null,
  },
  "POST /auth/recovery/reset-password": {
    instead: "Requires the single-use token minted by verify-otp. No guessable field of its own.",
    residual: null,
  },
});

/** The allow-list, read from the source rather than restated. */
const publicRoutes = () => {
  const start = backendCode.indexOf("const PUBLIC_ROUTES = new Set([");
  const end = backendCode.indexOf("]);", start);
  assert.ok(start > 0 && end > start, "the public allow-list must be findable in server.js");
  return [...backendCode.slice(start, end).matchAll(/"(GET|POST|PUT|PATCH|DELETE) ([^"]+)"/g)]
    .map((match) => ({ method: match[1], path: match[2], key: `${match[1]} ${match[2]}` }));
};

/** The body of a route handler, for asking what it does before anything else. */
const handlerBody = (method, routePath) => {
  const marker = `app.${method.toLowerCase()}("${routePath}"`;
  const start = backendCode.indexOf(marker);
  if (start < 0) return null;
  return backendCode.slice(start, start + 3000);
};

test("the allow-list is readable and has not quietly emptied", () => {
  const routes = publicRoutes();
  assert.ok(routes.length >= 10, `expected a populated allow-list, found ${routes.length}`);
  assert.ok(routes.some((route) => route.key === "POST /devices/activate"));
});

test("every public route that takes a submission is throttled, or says why not", () => {
  const submissions = publicRoutes().filter((route) => route.method !== "GET");
  assert.ok(submissions.length > 0, "expected at least one public route that accepts a body");

  const unprotected = [];
  for (const route of submissions) {
    if (Object.hasOwn(THROTTLE_EXEMPT, route.key)) continue;
    const body = handlerBody(route.method, route.path);
    if (body === null) continue; // registered elsewhere; routeAuthCoverage owns that check
    if (!body.includes("refusePublicFlood(req, res,")) unprotected.push(route.key);
  }

  assert.deepEqual(
    unprotected,
    [],
    unprotected.length
      ? `public routes accepting a guess with no limit and no stated alternative:\n  ` +
        `${unprotected.join("\n  ")}\n\nAdd refusePublicFlood, or add an entry to THROTTLE_EXEMPT` +
        " naming the control that replaces it."
      : "",
  );
});

test("the throttle is consulted before the work, not after it", () => {
  // A limiter that runs after the lookup has already answered the question it was meant to make
  // expensive. Every throttled handler must call it as its first act.
  for (const scope of ["recovery-options", "recovery-send-otp", "device-activate", "device-bootstrap-status"]) {
    const callIndex = backendCode.indexOf(`refusePublicFlood(req, res, "${scope}")`);
    assert.ok(callIndex > 0, `${scope} must consult the throttle`);
    const preamble = backendCode.slice(callIndex - 400, callIndex);
    assert.doesNotMatch(
      preamble,
      /await pool\.query|await find\w+\(/,
      `${scope} queries before it throttles, so the guess is already answered`,
    );
  }
});

test("every exemption names the control standing in for the limit", () => {
  for (const [route, exemption] of Object.entries(THROTTLE_EXEMPT)) {
    assert.ok(exemption.instead && exemption.instead.length > 20,
      `${route} is exempt without naming what protects it instead`);
  }
});

test("a known residual risk stays written down rather than being forgotten", () => {
  // /login is exempt for a real operational reason, and that reason leaves a gap. The gap is
  // recorded here so it is a decision somebody can revisit, not an oversight nobody can find.
  assert.equal(THROTTLE_EXEMPT["POST /login"].residual, "password spraying across accounts from one address");
});

test("recovery OTP attempts are capped on the record, not merely on the address", () => {
  // A-6 Gate 3.4. An address limit alone is beatable by changing address; the cap has to live on
  // the recovery request itself so it survives that.
  const body = handlerBody("POST", "/auth/recovery/verify-otp");
  assert.ok(body, "the verify-otp route must exist");
  assert.match(body, /attempt_count \|\| 0\) >= 5/, "attempts must be capped");
  assert.match(body, /OTP_ATTEMPTS_EXCEEDED/, "an exhausted code must say so distinctly");
  const capIndex = body.indexOf("attempt_count || 0) >= 5");
  const compareIndex = body.search(/hashOtp|verification_code_hash/);
  assert.ok(capIndex > 0 && compareIndex > 0, "both the cap and the comparison must be present");
  assert.ok(capIndex < compareIndex, "the cap must be checked before the code is compared");
});
