"use strict";

/**
 * Which browser origins the backend answers (`cloudCorsPolicy.js`).
 *
 * The change this pins: the `https://*.up.railway.app` wildcard is gone, replaced by exact origins,
 * and no `*.onrender.com` wildcard took its place. Everything that worked before and is legitimate
 * -- the Railway origin itself, the Tauri shells, same-origin pages, LAN and loopback rigs, the
 * Vite dev server -- is asserted to still work, first against the pure policy and then through the
 * real server's middleware.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { DEV_ORIGINS, TAURI_ORIGINS, createCorsPolicy, originOf, parseConfiguredOrigins } = require("./cloudCorsPolicy");

const PRODUCTION = "https://froozerp-production-27bb.up.railway.app";
const LEGACY = "https://froozerp-production.up.railway.app";
const RENDER = "https://froozerp-cloud.onrender.com";

const railwayToday = () => createCorsPolicy({
  productionOrigin: PRODUCTION,
  legacyOrigins: [LEGACY],
  // On Railway publicCloudApiUrl is CLOUD_API_URL, or the production origin when that is unset.
  publicCloudApiUrl: PRODUCTION,
  configured: "",
});

test("Railway's own origin, the retired one and the dev servers are allowed exactly", () => {
  const policy = railwayToday();
  for (const origin of [PRODUCTION, LEGACY, ...DEV_ORIGINS]) {
    assert.equal(policy.isAllowedOrigin(origin, { host: "elsewhere.example" }), true, origin);
  }
  assert.ok(policy.allowedOrigins.includes(PRODUCTION));
  assert.ok(policy.allowedOrigins.includes(LEGACY));
});

test("every Tauri shell origin is allowed: the desktop gateway forwards the WebView's Origin unchanged", () => {
  const policy = railwayToday();
  for (const origin of TAURI_ORIGINS) {
    assert.equal(policy.isAllowedOrigin(origin, { host: "froozerp-production-27bb.up.railway.app" }), true, origin);
  }
  assert.deepEqual([...TAURI_ORIGINS].sort(), ["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"]);
});

test("a request with no Origin is allowed (server-to-server, the gateway's probes, curl)", () => {
  assert.equal(railwayToday().isAllowedOrigin(undefined), true);
  assert.equal(railwayToday().isAllowedOrigin(""), true);
});

test("same-origin is allowed by Host or X-Forwarded-Host, so the hosted web UI needs no configuration", () => {
  const policy = railwayToday();
  assert.equal(policy.isAllowedOrigin(RENDER, { host: "froozerp-cloud.onrender.com" }), true);
  assert.equal(policy.isAllowedOrigin(RENDER, { host: "10.0.0.5:10000", forwardedHost: "froozerp-cloud.onrender.com" }), true);
});

test("private-network and loopback hosts are allowed over http(s), for the LAN and the disposable rigs", () => {
  const policy = railwayToday();
  for (const origin of [
    "http://127.0.0.1:5090",
    "http://localhost:5174",
    "http://192.168.1.20:5000",
    "https://10.1.2.3",
    "http://172.16.0.9:5173",
    "http://[::1]:5173",
  ]) {
    assert.equal(policy.isAllowedOrigin(origin, { host: "x.example" }), true, origin);
  }
  assert.equal(policy.isAllowedOrigin("http://172.32.0.1", { host: "x.example" }), false);
});

test("no platform wildcard: other apps on Railway or Render are refused", () => {
  const policy = railwayToday();
  for (const origin of [
    "https://attacker.up.railway.app",
    "https://froozerp-production-27bb-evil.up.railway.app",
    "https://anything.onrender.com",
    "https://froozerp-cloud.onrender.com",
  ]) {
    assert.equal(policy.isAllowedOrigin(origin, { host: "froozerp-production-27bb.up.railway.app" }), false, origin);
  }
});

test("on Render, the service's own public URL is allowed exactly, and only it", () => {
  const policy = createCorsPolicy({
    productionOrigin: PRODUCTION,
    legacyOrigins: [LEGACY],
    publicCloudApiUrl: `${RENDER}/`,
  });
  assert.equal(policy.isAllowedOrigin(RENDER, { host: "internal:10000" }), true);
  assert.equal(policy.isAllowedOrigin("https://other.onrender.com", { host: "internal:10000" }), false);
  assert.ok(policy.allowedOrigins.includes(RENDER));
});

test("ALLOWED_ORIGINS adds exact origins and can never add '*'", () => {
  const policy = createCorsPolicy({ productionOrigin: PRODUCTION, configured: "https://owner.example.com, * ,," });
  assert.equal(policy.isAllowedOrigin("https://owner.example.com", { host: "x" }), true);
  assert.equal(policy.allowedOrigins.includes("*"), false);
  assert.deepEqual(parseConfiguredOrigins(" a , * , b "), ["a", "b"]);
});

test("an unparseable Origin still throws, so the server logs it as invalid rather than allowing it", () => {
  assert.throws(() => railwayToday().isAllowedOrigin("not a url", { host: "x" }));
});

test("originOf keeps only http(s) origins", () => {
  assert.equal(originOf(`${RENDER}/api/health`), RENDER);
  assert.equal(originOf("tauri://localhost"), "");
  assert.equal(originOf(""), "");
  assert.equal(originOf("nonsense"), "");
});

const SERVER = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

test("server.js has no platform wildcard left and builds its list from this policy", () => {
  assert.doesNotMatch(SERVER, /endsWith\("\.up\.railway\.app"\)/);
  assert.doesNotMatch(SERVER, /endsWith\("\.onrender\.com"\)/);
  assert.match(SERVER, /const corsPolicy = createCorsPolicy\(\{/);
  assert.match(SERVER, /publicCloudApiUrl,\n/);
});

test("through the real server: tauri and same-origin pass CORS, a foreign Railway app is refused", async () => {
  const { loadServerApp, probe } = require("./routeAuthCoverage");
  const app = loadServerApp();
  // Past CORS, an anonymous request meets the default-deny gate: 401. A CORS refusal never gets
  // that far and is answered by the error handler instead.
  for (const origin of ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", PRODUCTION, LEGACY]) {
    const result = await probe(app, "GET", "/api/sync/pull", { origin });
    assert.equal(result.status, 401, `${origin}: ${result.status}`);
  }
  const sameOrigin = await probe(app, "GET", "/api/sync/pull", { origin: "https://froozerp-cloud.onrender.com", host: "froozerp-cloud.onrender.com" });
  assert.equal(sameOrigin.status, 401);
  for (const origin of ["https://attacker.up.railway.app", "https://anything.onrender.com"]) {
    const result = await probe(app, "GET", "/api/sync/pull", { origin, host: "froozerp-production-27bb.up.railway.app" });
    assert.equal(result.status, 500, `${origin} must be refused: ${result.status}`);
    assert.equal(result.code, "INTERNAL_SERVER_ERROR");
  }
});
