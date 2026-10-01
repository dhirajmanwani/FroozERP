"use strict";

/**
 * The cut-over freeze (`cloudFreeze.js`).
 *
 * What has to be true for the cut-over in docs/production/RENDER_NEON_CUTOVER.md to be safe:
 *
 *   - the platform health check still passes (200), or the frozen deploy is rolled back and freezes
 *     nothing;
 *   - no client calls a frozen cloud reachable (`status` is not "ok");
 *   - every write answers 503, never 404, because a 404 marks a queued purchase as a business
 *     rejection and takes it out of the retry queue, where a 503 is a server fault that retries.
 *
 * Asserted on the pure pieces and then through the real server, loaded frozen.
 */

// Set before the server is loaded: the freeze is read once at startup, as in production.
process.env.FROOZERP_CLOUD_FROZEN = "true";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  FROZEN_EXEMPT_PATHS,
  FROZEN_RESPONSE,
  FROZEN_STATUS,
  createCloudFreezeMiddleware,
  healthStatus,
  isFrozenExempt,
  readCloudFreeze,
} = require("./cloudFreeze");

test("only the literal true freezes; anything else set is a warning, not a guess", () => {
  assert.deepEqual(readCloudFreeze({}), { frozen: false, warning: "" });
  assert.deepEqual(readCloudFreeze({ FROOZERP_CLOUD_FROZEN: "" }), { frozen: false, warning: "" });
  assert.deepEqual(readCloudFreeze({ FROOZERP_CLOUD_FROZEN: "false" }), { frozen: false, warning: "" });
  assert.deepEqual(readCloudFreeze({ FROOZERP_CLOUD_FROZEN: "true" }), { frozen: true, warning: "" });
  assert.deepEqual(readCloudFreeze({ FROOZERP_CLOUD_FROZEN: " TRUE " }), { frozen: true, warning: "" });
  for (const value of ["1", "yes", "on", "frozen"]) {
    const result = readCloudFreeze({ FROOZERP_CLOUD_FROZEN: value });
    assert.equal(result.frozen, false, value);
    assert.match(result.warning, /NOT frozen/, value);
  }
});

test("exactly the four probe routes are exempt, for GET and HEAD only", () => {
  assert.deepEqual([...FROZEN_EXEMPT_PATHS].sort(), ["/api/health", "/api/time", "/api/version", "/health"]);
  for (const route of FROZEN_EXEMPT_PATHS) {
    assert.equal(isFrozenExempt({ method: "GET", path: route }), true, route);
    assert.equal(isFrozenExempt({ method: "HEAD", path: route }), true, route);
    assert.equal(isFrozenExempt({ method: "GET", path: `${route}/` }), true, `${route}/`);
    assert.equal(isFrozenExempt({ method: "POST", path: route }), false, `POST ${route}`);
  }
  for (const route of ["/login", "/api/sync/push", "/api/sync/pull", "/", "/api/system/compatibility", "/api/health/x", "/api/healthz"]) {
    assert.equal(isFrozenExempt({ method: "GET", path: route }), false, route);
  }
});

test("health reports frozen, not ok, so no client treats the cloud as reachable", () => {
  assert.equal(healthStatus(false), "ok");
  assert.equal(healthStatus(true), FROZEN_STATUS);
  assert.notEqual(FROZEN_STATUS, "ok");
});

test("the refusal is a server fault the clients retry, in the shape they already classify", () => {
  assert.equal(FROZEN_RESPONSE.code, "CLOUD_UNAVAILABLE");
  assert.equal(FROZEN_RESPONSE.failure_kind, "CLOUD_UNAVAILABLE");
  assert.equal(FROZEN_RESPONSE.cloud_connected, false);
});

test("the middleware is a no-op when not frozen and a 503 when frozen", () => {
  const run = (frozen, method, routePath) => {
    const headers = {};
    let status = null;
    let body = null;
    let passed = false;
    const res = {
      setHeader: (name, value) => { headers[name.toLowerCase()] = value; },
      status(code) { status = code; return this; },
      json(payload) { body = payload; return this; },
    };
    createCloudFreezeMiddleware({ frozen })({ method, path: routePath }, res, () => { passed = true; });
    return { passed, status, body, headers };
  };
  assert.equal(run(false, "POST", "/api/sync/push").passed, true);
  assert.equal(run(false, "POST", "/login").passed, true);
  assert.equal(run(true, "GET", "/api/health").passed, true);
  const refused = run(true, "POST", "/api/sync/push");
  assert.equal(refused.passed, false);
  assert.equal(refused.status, 503);
  assert.deepEqual(refused.body, FROZEN_RESPONSE);
  assert.equal(refused.headers["cache-control"], "no-store");
  assert.match(refused.headers["retry-after"], /^\d+$/);
});

const SERVER = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

test("server.js mounts the freeze straight after CORS, before the protocol gate and authentication", () => {
  const corsAt = SERVER.indexOf("app.use((req, res, next) => cors({");
  const freezeAt = SERVER.indexOf("app.use(createCloudFreezeMiddleware({ frozen: cloudFreeze.frozen }));");
  const protocolGateAt = SERVER.indexOf("requiresOperationalProtocolUpgrade(req.path)");
  const authAt = SERVER.indexOf("app.use(revokedSessionGuard)");
  assert.ok(corsAt > 0 && freezeAt > corsAt, "freeze after CORS");
  assert.ok(protocolGateAt > freezeAt, "freeze before the 426 gate");
  assert.ok(authAt > freezeAt, "freeze before authentication");
  assert.equal((SERVER.match(/status: healthStatus\(cloudFreeze\.frozen\)/g) || []).length, 3, "health, time and version");
});

// ---------------------------------------------------------------------------------------------
// Through the real server, loaded with FROOZERP_CLOUD_FROZEN=true.
// ---------------------------------------------------------------------------------------------

const { loadServerApp, probe, setQueryResponder, clearQueryResponder } = require("./routeAuthCoverage");

test("frozen server: the probe routes answer 200 with status frozen", async () => {
  const app = loadServerApp();
  // The health route reads the database; answer it with empty rows, as a reachable database would.
  setQueryResponder(() => ({ rows: [], rowCount: 0 }));
  try {
    for (const route of ["/api/health", "/health", "/api/time", "/api/version"]) {
      const result = await probe(app, "GET", route, {});
      assert.equal(result.status, 200, `${route}: ${result.text}`);
      assert.equal(result.body.status, "frozen", route);
      assert.equal(result.body.app, "FroozERP", route);
    }
  } finally {
    clearQueryResponder();
  }
});

test("frozen server: sign-in, sync and every other route answer 503 CLOUD_UNAVAILABLE, never 404", async () => {
  const app = loadServerApp();
  for (const [method, route] of [
    ["POST", "/login"],
    ["POST", "/api/sync/push"],
    ["GET", "/api/sync/pull"],
    ["POST", "/api/auth/device-bootstrap-status"],
    ["GET", "/api/system/compatibility"],
    ["POST", "/purchases"],
    ["GET", "/no-such-route"],
    ["GET", "/"],
  ]) {
    const result = await probe(app, method, route, {}, method === "POST" ? {} : undefined);
    assert.equal(result.status, 503, `${method} ${route}: ${result.status}`);
    assert.equal(result.code, "CLOUD_UNAVAILABLE", `${method} ${route}`);
  }
});

test("frozen server: a CORS preflight is still answered, so a browser can read the 503", async () => {
  const app = loadServerApp();
  const result = await probe(app, "OPTIONS", "/api/sync/push", {
    origin: "tauri://localhost",
    "access-control-request-method": "POST",
  });
  assert.equal(result.status, 204);
});
