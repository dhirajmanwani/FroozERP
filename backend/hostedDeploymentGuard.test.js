"use strict";

/**
 * The fail-closed hosted guard (`hostedDeploymentGuard.js`).
 *
 * Two halves. The named rows pin the configurations that exist today -- Railway as it runs, Render
 * as `render.yaml` describes it, the rehearsal stand-in, the multibranch rigs, the in-process test
 * harness -- because the guard is worthless if it refuses any of them. The exhaustive half walks
 * every combination of the variables that decide the runtime and checks the two promises the guard
 * makes, whatever the combination:
 *
 *   1. a process it lets start never runs the startup bootstrap against a remote database while
 *      believing it is not hosted (case A), and
 *   2. a process it lets start on a hosting platform is a hosted cloud-server (case B).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const {
  GUARD_CODES,
  PLATFORM_MARKERS,
  assertHostedDeploymentConfiguration,
  classifyDatabaseUrl,
  defaultCloudDeploymentId,
  detectHostingPlatform,
  evaluateHostedDeploymentGuard,
  resolveTrustProxy,
} = require("./hostedDeploymentGuard");
const { RUNTIME_MODES, resolveRuntimeMode } = require("./storageAdapters");

const REMOTE_DB = "postgresql://user:pw@ep-example-123.ap-southeast-1.aws.neon.tech/froozerp?sslmode=verify-full";
const RAILWAY_DB = "postgresql://postgres:pw@postgres.railway.internal:5432/railway";
const LOOPBACK_DB = "postgresql://postgres@127.0.0.1:5432/froozerp_staging";

const evaluate = (env, extra = {}) => evaluateHostedDeploymentGuard({ env, ...extra });

// ---------------------------------------------------------------------------------------------
// Configurations that run today and must keep starting.
// ---------------------------------------------------------------------------------------------

test("Railway as it runs today starts: cloud-server, CLOUD_PRODUCTION, cloud, platform markers", () => {
  const env = {
    FROOZERP_RUNTIME_MODE: "cloud-server",
    APP_MODE: "CLOUD_PRODUCTION",
    FROOZERP_DEPLOYMENT_TYPE: "cloud",
    NODE_ENV: "production",
    DATABASE_URL: RAILWAY_DB,
    RAILWAY_ENVIRONMENT: "production",
    RAILWAY_ENVIRONMENT_NAME: "production",
    RAILWAY_PROJECT_ID: "p",
    RAILWAY_SERVICE_ID: "s",
  };
  const decision = evaluate(env);
  assert.equal(decision.ok, true, decision.message);
  assert.equal(decision.platform, "railway");
});

test("Railway starts with or without the explicit runtime, and whatever NODE_ENV is", () => {
  for (const runtime of [undefined, "cloud-server"]) {
    for (const nodeEnv of [undefined, "production", "test"]) {
      const env = {
        APP_MODE: "CLOUD_PRODUCTION",
        FROOZERP_DEPLOYMENT_TYPE: "cloud",
        DATABASE_URL: RAILWAY_DB,
        RAILWAY_ENVIRONMENT: "production",
        ...(runtime ? { FROOZERP_RUNTIME_MODE: runtime } : {}),
        ...(nodeEnv ? { NODE_ENV: nodeEnv } : {}),
      };
      assert.equal(evaluate(env).ok, true, JSON.stringify(env));
    }
  }
});

test("APP_MODE is read the way the server reads it: trimmed and upper-cased", () => {
  const env = { FROOZERP_RUNTIME_MODE: "cloud-server", APP_MODE: "  cloud_production ", DATABASE_URL: REMOTE_DB, RENDER: "true" };
  assert.equal(evaluate(env).ok, true);
});

test("Render as render.yaml configures it starts", () => {
  const env = {
    NODE_ENV: "production",
    APP_MODE: "CLOUD_PRODUCTION",
    FROOZERP_DEPLOYMENT_TYPE: "cloud",
    FROOZERP_RUNTIME_MODE: "cloud-server",
    RUN_STARTUP_SCHEMA_BOOTSTRAP: "false",
    DATABASE_URL: REMOTE_DB,
    RENDER: "true",
    RENDER_SERVICE_ID: "srv-x",
    RENDER_EXTERNAL_URL: "https://froozerp-cloud.onrender.com",
  };
  const decision = evaluate(env);
  assert.equal(decision.ok, true, decision.message);
  assert.equal(decision.platform, "render");
});

test("the rehearsal stand-in cloud starts, from a clean shell and from one carrying platform variables", async () => {
  const { cloudEnvironment } = await import(pathToFileURL(path.join(__dirname, "..", "scripts", "run-rehearsal.mjs")).href);
  for (const shell of [
    {},
    { DATABASE_URL: RAILWAY_DB, APP_MODE: "CLOUD_PRODUCTION", NODE_ENV: "production" },
    // `railway shell` exports the platform's variables into a local shell.
    { RAILWAY_ENVIRONMENT: "production", RAILWAY_PROJECT_ID: "p", DATABASE_URL: RAILWAY_DB },
  ]) {
    const env = cloudEnvironment({ env: shell, database: "froozerp_staging", sessionSecret: "s".repeat(40) });
    assert.equal(resolveRuntimeMode(env), RUNTIME_MODES.CLOUD_SERVER);
    const decision = evaluate(env);
    assert.equal(decision.ok, true, `${JSON.stringify(shell)}: ${decision.message}`);
  }
});

test("the multibranch isolated rigs start: they declare themselves hosted against a loopback _staging DB", () => {
  const env = {
    NODE_ENV: "test",
    APP_MODE: "CLOUD_PRODUCTION",
    FROOZERP_DEPLOYMENT_TYPE: "cloud",
    FROOZERP_RUNTIME_MODE: "cloud-server",
    FROOZERP_ALLOW_LOOPBACK_POSTGRES_FOR_ISOLATED_TESTS: "true",
    DATABASE_URL: LOOPBACK_DB,
    DB_SSL: "false",
  };
  assert.equal(evaluate(env).ok, true);
});

test("the in-process test harness starts: cloud-server, NODE_ENV=test, adapter stubbed", () => {
  // routeAuthCoverage.js deletes APP_MODE and stubs the adapter, which opens nothing. The server
  // hands the guard the adapter's own connection string, so a DATABASE_URL left in the developer's
  // shell does not turn the test run into a refusal.
  const env = { FROOZERP_RUNTIME_MODE: "cloud-server", NODE_ENV: "test", DATABASE_URL: RAILWAY_DB };
  assert.equal(evaluate(env, { databaseUrl: "" }).ok, true);
  assert.equal(evaluate({ FROOZERP_RUNTIME_MODE: "cloud-server", NODE_ENV: "test" }).ok, true);
});

test("deliberate local runs start: the documented bare run, an explicit desktop-local, the desktop service", () => {
  assert.equal(evaluate({}).ok, true, "node backend/server.js with nothing set");
  assert.equal(evaluate({ FROOZERP_RUNTIME_MODE: "desktop-local", DATABASE_URL: RAILWAY_DB }).ok, true);
  assert.equal(evaluate({ FROOZERP_DESKTOP_SERVICE: "1", DATABASE_URL: RAILWAY_DB }).ok, true);
  assert.equal(evaluate({ APP_MODE: "LOCAL_SINGLE_DEVICE", FROOZERP_RUNTIME_MODE: "desktop-local" }).ok, true);
});

// ---------------------------------------------------------------------------------------------
// The two failure shapes.
// ---------------------------------------------------------------------------------------------

test("case A: cloud-server without CLOUD_PRODUCTION against a remote database is refused", () => {
  for (const appMode of [undefined, "", "CLOUD", "CLOUD_PRODUCTON", "LOCAL_SINGLE_DEVICE", "HYBRID"]) {
    const env = {
      FROOZERP_RUNTIME_MODE: "cloud-server",
      NODE_ENV: "production",
      DATABASE_URL: REMOTE_DB,
      ...(appMode === undefined ? {} : { APP_MODE: appMode }),
    };
    const decision = evaluate(env);
    assert.equal(decision.ok, false, JSON.stringify(env));
    assert.equal(decision.code, GUARD_CODES.HOSTED_APP_MODE_MISSING);
    assert.match(decision.message, /APP_MODE=CLOUD_PRODUCTION/);
  }
});

test("case A is refused even with NODE_ENV=test when the database is remote", () => {
  const decision = evaluate({ FROOZERP_RUNTIME_MODE: "cloud-server", NODE_ENV: "test", DATABASE_URL: REMOTE_DB });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, GUARD_CODES.HOSTED_APP_MODE_MISSING);
});

test("case A is refused outside a test even against loopback", () => {
  const decision = evaluate({ FROOZERP_RUNTIME_MODE: "cloud-server", NODE_ENV: "production", DATABASE_URL: LOOPBACK_DB });
  assert.equal(decision.ok, false);
});

test("case B: APP_MODE missing on a hosting platform falls to desktop-local and is refused", () => {
  for (const [platform, names] of Object.entries(PLATFORM_MARKERS)) {
    for (const marker of names) {
      const env = { FROOZERP_DEPLOYMENT_TYPE: "cloud", DATABASE_URL: REMOTE_DB, [marker]: "x" };
      assert.equal(resolveRuntimeMode(env), RUNTIME_MODES.DESKTOP_LOCAL);
      const decision = evaluate(env);
      assert.equal(decision.ok, false, `${platform}/${marker}`);
      assert.equal(decision.code, GUARD_CODES.HOSTED_RUNTIME_MISSING);
      assert.equal(decision.platform, platform);
      assert.deepEqual(decision.markers, [marker]);
    }
  }
});

test("case B: an explicit desktop-local on a hosting platform is refused too", () => {
  const decision = evaluate({ FROOZERP_RUNTIME_MODE: "desktop-local", RENDER: "true" });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, GUARD_CODES.HOSTED_RUNTIME_MISSING);
});

test("case B: DATABASE_URL with no runtime chosen is refused even off-platform", () => {
  for (const env of [
    { DATABASE_URL: REMOTE_DB },
    { DATABASE_URL: REMOTE_DB, APP_MODE: "CLOUD_PRODUCTON", FROOZERP_DEPLOYMENT_TYPE: "cloud" },
    { DATABASE_URL: REMOTE_DB, FROOZERP_RUNTIME_MODE: "cloud_server" },
  ]) {
    const decision = evaluate(env);
    assert.equal(decision.ok, false, JSON.stringify(env));
    assert.equal(decision.code, GUARD_CODES.HOSTED_RUNTIME_MISSING);
    assert.match(decision.message, /DATABASE_URL is set but no runtime was chosen/);
  }
});

test("messages name variables, never their values", () => {
  const secretDb = "postgresql://owner:sup3r-secret@db.example.com:5432/live";
  for (const env of [
    { FROOZERP_RUNTIME_MODE: "cloud-server", DATABASE_URL: secretDb },
    { DATABASE_URL: secretDb, RENDER_SERVICE_ID: "srv-private-id" },
  ]) {
    const decision = evaluate(env);
    assert.equal(decision.ok, false);
    assert.doesNotMatch(decision.message, /sup3r-secret|db\.example\.com|srv-private-id/);
  }
});

test("assert throws a coded error on refusal and returns the decision otherwise", () => {
  assert.throws(
    () => assertHostedDeploymentConfiguration({ env: { FROOZERP_RUNTIME_MODE: "cloud-server", DATABASE_URL: REMOTE_DB } }),
    (error) => error.code === GUARD_CODES.HOSTED_APP_MODE_MISSING && /\[hosted-guard\]/.test(error.message),
  );
  assert.equal(assertHostedDeploymentConfiguration({ env: {} }).ok, true);
});

test("the server's own runtime and hosted values override what the env alone would say", () => {
  const env = { DATABASE_URL: REMOTE_DB, FROOZERP_RUNTIME_MODE: "cloud-server" };
  assert.equal(evaluate(env, { runtimeMode: "cloud-server", hostedCloudDeployment: true }).ok, true);
  assert.equal(evaluate(env, { runtimeMode: "cloud-server", hostedCloudDeployment: false }).ok, false);
});

// ---------------------------------------------------------------------------------------------
// Exhaustive: every combination of the deciding variables.
// ---------------------------------------------------------------------------------------------

test("exhaustively: nothing that starts bootstraps a remote database unhosted, or runs unhosted on a platform", () => {
  const options = {
    FROOZERP_RUNTIME_MODE: [undefined, "cloud-server", "desktop-local", "mobile-local", "cloud_server"],
    APP_MODE: [undefined, "CLOUD_PRODUCTION", "cloud_production", "CLOUD_PRODUCTON", "LOCAL_SINGLE_DEVICE"],
    FROOZERP_DEPLOYMENT_TYPE: [undefined, "cloud", "local"],
    FROOZERP_DESKTOP_SERVICE: [undefined, "1"],
    NODE_ENV: [undefined, "production", "test"],
    DATABASE_URL: [undefined, LOOPBACK_DB, REMOTE_DB],
    platform: [null, "RENDER", "RAILWAY_ENVIRONMENT"],
  };
  const keys = Object.keys(options);
  let combinations = 0;
  let refused = 0;
  const walk = (index, env) => {
    if (index === keys.length) {
      combinations += 1;
      const { platform, ...rest } = env;
      const full = Object.fromEntries(Object.entries({ ...rest, ...(platform ? { [platform]: "x" } : {}) }).filter(([, v]) => v !== undefined));
      const runtime = resolveRuntimeMode(full);
      const appMode = String(full.APP_MODE || "").trim().toUpperCase();
      const hosted = runtime === RUNTIME_MODES.CLOUD_SERVER && appMode === "CLOUD_PRODUCTION";
      const decision = evaluate(full);
      if (!decision.ok) {
        refused += 1;
        assert.ok(Object.values(GUARD_CODES).includes(decision.code), JSON.stringify(full));
      }
      // Hosted is always allowed.
      if (hosted) assert.equal(decision.ok, true, `hosted refused: ${JSON.stringify(full)}`);
      if (decision.ok) {
        // Promise 1: the startup bootstrap (on whenever cloud-server is not hosted) never meets a
        // remote database.
        if (runtime === RUNTIME_MODES.CLOUD_SERVER && !hosted) {
          assert.notEqual(classifyDatabaseUrl(full.DATABASE_URL), "remote", `case A allowed: ${JSON.stringify(full)}`);
          assert.equal(full.NODE_ENV, "test", `unhosted cloud-server outside a test: ${JSON.stringify(full)}`);
        }
        // Promise 2: on a platform, only a hosted cloud-server runs -- unless it is the isolated
        // loopback test shape, which cannot reach the shop's database.
        if (platform && !hosted) {
          assert.equal(runtime, RUNTIME_MODES.CLOUD_SERVER, `desktop-local on a platform: ${JSON.stringify(full)}`);
          assert.equal(full.NODE_ENV, "test");
        }
        // A fall-through to the default runtime never carries a database URL.
        const explicit = ["cloud-server", "desktop-local", "mobile-local"].includes(full.FROOZERP_RUNTIME_MODE) || full.FROOZERP_DESKTOP_SERVICE === "1";
        if (runtime !== RUNTIME_MODES.CLOUD_SERVER && !explicit) {
          assert.equal(full.DATABASE_URL, undefined, `fall-through with DATABASE_URL: ${JSON.stringify(full)}`);
        }
      }
      return;
    }
    for (const value of options[keys[index]]) walk(index + 1, { ...env, [keys[index]]: value });
  };
  walk(0, {});
  assert.equal(combinations, 5 * 5 * 3 * 2 * 3 * 3 * 3);
  assert.ok(refused > 0 && refused < combinations, "the walk must exercise both answers");
});

// ---------------------------------------------------------------------------------------------
// Helpers that share the platform detection.
// ---------------------------------------------------------------------------------------------

test("platform detection reads names only, and an empty value is not a marker", () => {
  assert.deepEqual(detectHostingPlatform({}), { platform: null, markers: [] });
  assert.deepEqual(detectHostingPlatform({ RENDER: "  " }), { platform: null, markers: [] });
  assert.equal(detectHostingPlatform({ RENDER: "true" }).platform, "render");
  assert.equal(detectHostingPlatform({ RAILWAY_PROJECT_ID: "p" }).platform, "railway");
});

test("the default deployment id names the platform it can see, and only when hosted", () => {
  assert.equal(defaultCloudDeploymentId({ env: { RENDER: "true" }, hostedCloudDeployment: true }), "render-production");
  assert.equal(defaultCloudDeploymentId({ env: { RAILWAY_ENVIRONMENT: "production" }, hostedCloudDeployment: true }), "railway-production");
  assert.equal(defaultCloudDeploymentId({ env: {}, hostedCloudDeployment: true }), "hosted-production");
  assert.equal(defaultCloudDeploymentId({ env: { RENDER: "true" }, hostedCloudDeployment: false }), "");
});

test("trust proxy: off the cloud never trusts, on it defaults to one hop and takes a sane override", () => {
  assert.deepEqual(resolveTrustProxy({ env: { FROOZERP_TRUST_PROXY_HOPS: "3" }, cloud: false }), { value: false, warning: "" });
  assert.deepEqual(resolveTrustProxy({ env: {}, cloud: true }), { value: 1, warning: "" });
  assert.deepEqual(resolveTrustProxy({ env: { FROOZERP_TRUST_PROXY_HOPS: "2" }, cloud: true }), { value: 2, warning: "" });
  for (const bad of ["0", "-1", "true", "1.5", "11", "two", "1e1"]) {
    const resolved = resolveTrustProxy({ env: { FROOZERP_TRUST_PROXY_HOPS: bad }, cloud: true });
    assert.equal(resolved.value, 1, bad);
    assert.match(resolved.warning, /trusting 1 hop/, bad);
  }
});

test("database URLs are classified by host", () => {
  assert.equal(classifyDatabaseUrl(""), "absent");
  assert.equal(classifyDatabaseUrl(undefined), "absent");
  assert.equal(classifyDatabaseUrl(LOOPBACK_DB), "loopback");
  assert.equal(classifyDatabaseUrl("postgresql://u@localhost/x_staging"), "loopback");
  assert.equal(classifyDatabaseUrl("postgresql://u@[::1]:5432/x_staging"), "loopback");
  assert.equal(classifyDatabaseUrl(REMOTE_DB), "remote");
  assert.equal(classifyDatabaseUrl("not a url"), "invalid");
});

// ---------------------------------------------------------------------------------------------
// Wiring in server.js.
// ---------------------------------------------------------------------------------------------

const SERVER = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

test("server.js runs the guard before anything with side effects, with the adapter's real connection", () => {
  const guardAt = SERVER.indexOf("assertHostedDeploymentConfiguration({");
  assert.ok(guardAt > 0, "the guard must be called");
  const call = SERVER.slice(guardAt, SERVER.indexOf("});", guardAt));
  assert.match(call, /runtimeMode,/);
  assert.match(call, /hostedCloudDeployment,/);
  assert.match(call, /databaseUrl: storageAdapter\.connectionString \|\| ""/);
  for (const later of [
    "resolveBackupLocation({ dirname: __dirname",
    "resolveSessionSecret(",
    "prepareDatabaseForStartup()\n",
    "app.listen(PORT",
  ]) {
    const at = SERVER.indexOf(later);
    assert.ok(at > guardAt, `${later} must come after the guard`);
  }
  assert.ok(SERVER.indexOf("const hostedCloudDeployment =") < guardAt, "the guard needs the server's own hosted value");
});

test("a misconfigured server exits before it listens or opens anything (spawned)", () => {
  // Real process, real refusal. The database host does not resolve, and a temp SQLite path and
  // HOME keep a regression from touching any real profile; PORT 0 keeps it off every real port.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "froozerp-hosted-guard-"));
  const base = {
    PATH: process.env.PATH,
    HOME: tmp,
    USERPROFILE: tmp,
    APPDATA: tmp,
    XDG_DATA_HOME: tmp,
    FROOZERP_SQLITE_PATH: path.join(tmp, "guard.sqlite3"),
    PORT: "0",
    DEVICE_SESSION_SECRET: "hosted-guard-spawn-test-signing-key-0000000000",
  };
  const cases = [
    [{ FROOZERP_RUNTIME_MODE: "cloud-server", NODE_ENV: "production", DATABASE_URL: "postgresql://u:p@db.invalid:5432/x" }, GUARD_CODES.HOSTED_APP_MODE_MISSING],
    [{ RENDER: "true", NODE_ENV: "production", DATABASE_URL: "postgresql://u:p@db.invalid:5432/x" }, GUARD_CODES.HOSTED_RUNTIME_MISSING],
  ];
  try {
    for (const [env, code] of cases) {
      const result = spawnSync(process.execPath, [path.join(__dirname, "server.js")], {
        cwd: tmp,
        env: { ...base, ...env },
        encoding: "utf8",
        timeout: 20000,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      assert.notEqual(result.status, 0, `must exit non-zero: ${output}`);
      assert.match(output, new RegExp(code));
      assert.doesNotMatch(output, /Server running on/);
      assert.doesNotMatch(output, /schema bootstrap started/);
      assert.equal(fs.existsSync(base.FROOZERP_SQLITE_PATH), false, "no SQLite file may be created");
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("server.js names the cloud host-neutrally and lets the deployment name itself", () => {
  // B1: no platform in the constant names. Since the cut-over release the default is Render, and
  // both Railway addresses are retired (rewritten to it).
  assert.doesNotMatch(SERVER, /productionRailwayOrigin|legacyProductionRailwayOrigins/);
  assert.match(SERVER, /const defaultProductionCloudOrigin = "https:\/\/froozerp-cloud\.onrender\.com";/);
  const legacy = SERVER.match(/const legacyProductionCloudOrigins = new Set\(\[([^\]]*)\]\);/)?.[1] || "";
  assert.match(legacy, /"https:\/\/froozerp-production\.up\.railway\.app"/);
  assert.match(legacy, /"https:\/\/froozerp-production-27bb\.up\.railway\.app"/);
  // B2: Render's own URL is consulted after the explicit variables and before the built-in default.
  const chain = SERVER.slice(SERVER.indexOf("const publicCloudApiUrl = canonicalizeCloudApiUrl("));
  const order = ["process.env.CLOUD_API_URL", "process.env.FROOZERP_PUBLIC_API_URL", "process.env.RENDER_EXTERNAL_URL", "defaultProductionCloudOrigin"]
    .map((token) => chain.indexOf(token));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), `precedence: ${order}`);
  assert.match(SERVER, /canonical_cloud_api_url: canonicalCloudApiUrl,/);
  // B4: the deployment id is not hard-coded to one platform.
  assert.doesNotMatch(SERVER, /"railway-production"/);
  assert.match(SERVER, /defaultCloudDeploymentId\(\{ env: process\.env, hostedCloudDeployment \}\)/);
  // B6: trust proxy comes from the tested rule, still off when not cloud.
  assert.match(SERVER, /resolveTrustProxy\(\{ env: process\.env, cloud: deploymentType === "cloud" \}\)/);
  assert.match(SERVER, /app\.set\("trust proxy", trustProxy\.value\);/);
});
