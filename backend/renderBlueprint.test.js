"use strict";

/**
 * `render.yaml`, the Render Blueprint for the cloud backend.
 *
 * A Blueprint is applied by hand in a dashboard and then forgotten; the next time anybody reads it
 * is when something is wrong. So what matters about it is pinned here, where a change to it fails a
 * gate instead of a deploy:
 *
 *   - it starts the file that exists, and gates the deploy on the health route;
 *   - its runtime variables make a hosted cloud-server -- checked by running the real guard on them,
 *     so a typo that would bootstrap the live database is a red test, not an incident;
 *   - Singapore, the free plan, and no auto-deploy;
 *   - no secret carries a value, and nothing from the test rigs leaks in.
 *
 * There is no YAML library in this repository, and the file deliberately keeps to a plain block
 * style, so the reader below handles exactly that subset and refuses anything it does not recognise.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { evaluateHostedDeploymentGuard } = require("./hostedDeploymentGuard");
const { resolvePoolOptions } = require("./storageAdapters");

const ROOT = path.join(__dirname, "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "render.yaml"), "utf8");

const unquote = (value) => {
  const text = value.trim();
  const quoted = text.match(/^"(.*)"$/) || text.match(/^'(.*)'$/);
  return quoted ? quoted[1] : text;
};

/** Top-level service scalars, the folded build command, and the env var list. */
const parseBlueprint = (source) => {
  const lines = source.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith("#"));
  const service = {};
  const envVars = [];
  let current = null;
  let folding = null;
  let inEnv = false;
  for (const line of lines) {
    if (folding) {
      if (/^ {6}\S/.test(line)) {
        service[folding] = `${service[folding]} ${line.trim()}`.trim();
        continue;
      }
      folding = null;
    }
    if (inEnv) {
      const key = line.match(/^ {6}- key: (.+)$/);
      if (key) {
        current = { key: unquote(key[1]) };
        envVars.push(current);
        continue;
      }
      const field = line.match(/^ {8}(value|sync): (.+)$/);
      if (field && current) {
        current[field[1]] = unquote(field[2]);
        continue;
      }
      throw new Error(`render.yaml: unrecognised line in envVars: ${line}`);
    }
    if (/^services:$/.test(line) || /^ {2}- type: /.test(line)) {
      const type = line.match(/^ {2}- type: (.+)$/);
      if (type) service.type = unquote(type[1]);
      continue;
    }
    if (/^ {4}envVars:$/.test(line)) {
      inEnv = true;
      continue;
    }
    const folded = line.match(/^ {4}(\w+): >-$/);
    if (folded) {
      folding = folded[1];
      service[folding] = "";
      continue;
    }
    const scalar = line.match(/^ {4}(\w+): (.+)$/);
    if (scalar) {
      service[scalar[1]] = unquote(scalar[2]);
      continue;
    }
    throw new Error(`render.yaml: unrecognised line: ${line}`);
  }
  return { service, envVars };
};

const { service, envVars } = parseBlueprint(SOURCE);
const envByKey = new Map(envVars.map((entry) => [entry.key, entry]));

test("one web service, Singapore, free plan, deployed on purpose only", () => {
  assert.equal((SOURCE.match(/^ {2}- type: /gm) || []).length, 1, "exactly one service");
  assert.equal(service.type, "web");
  assert.equal(service.runtime, "node");
  assert.equal(service.plan, "free");
  assert.equal(service.region, "singapore", "same region as the Neon database (AWS ap-southeast-1)");
  assert.equal(service.branch, "main");
  assert.equal(service.autoDeploy, "false", "a merge must never move the shop's cloud by itself");
});

test("the start command runs server.js, and the deploy is gated on /api/health", () => {
  assert.equal(service.startCommand, "npm --prefix backend start");
  const backendPackage = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
  assert.match(backendPackage.scripts.start, /^node server\.js$/);
  assert.equal(service.healthCheckPath, "/api/health");
});

test("the build installs vite despite NODE_ENV=production, and ships the frontend inside the backend", () => {
  assert.match(service.buildCommand, /npm --prefix backend ci --omit=dev/);
  assert.match(service.buildCommand, /npm --prefix frontend ci --include=dev/);
  assert.match(service.buildCommand, /npm --prefix frontend run build/);
  assert.match(service.buildCommand, /cp -R frontend\/dist\/\. backend\/public\//);
});

test("runtime identity: a hosted cloud-server, as the real guard judges it on Render", () => {
  assert.equal(envByKey.get("APP_MODE")?.value, "CLOUD_PRODUCTION");
  assert.equal(envByKey.get("FROOZERP_DEPLOYMENT_TYPE")?.value, "cloud");
  assert.equal(envByKey.get("FROOZERP_RUNTIME_MODE")?.value, "cloud-server");
  assert.equal(envByKey.get("NODE_ENV")?.value, "production");
  assert.equal(envByKey.get("NODE_VERSION")?.value, "22");
  assert.equal(envByKey.get("RUN_STARTUP_SCHEMA_BOOTSTRAP")?.value, "false");
  assert.equal(envByKey.get("FROOZERP_CLOUD_DEPLOYMENT_ID")?.value, "render-production");

  const env = Object.fromEntries(envVars.filter((entry) => "value" in entry).map((entry) => [entry.key, entry.value]));
  // What Render adds itself, plus a stand-in for the secret database URL.
  Object.assign(env, {
    RENDER: "true",
    RENDER_SERVICE_ID: "srv-test",
    RENDER_EXTERNAL_URL: "https://froozerp-cloud.onrender.com",
    DATABASE_URL: "postgresql://u:p@ep-test.ap-southeast-1.aws.neon.tech/froozerp?sslmode=verify-full",
  });
  const decision = evaluateHostedDeploymentGuard({ env });
  assert.equal(decision.ok, true, decision.message);
  assert.equal(decision.platform, "render");
});

test("the pool is sized for Neon free and within what the code accepts", () => {
  const value = envByKey.get("PG_POOL_MAX")?.value;
  assert.equal(value, "5");
  assert.equal(resolvePoolOptions({ PG_POOL_MAX: value }).max, 5, "a value the code would ignore is no setting at all");
});

const SECRETS = [
  "DATABASE_URL",
  "DEVICE_SESSION_SECRET",
  "RECOVERY_OTP_HASH_SECRET",
  "FROOZERP_ACTIVATION_SIGNING_KEY",
  "EMAIL_API_KEY",
];

test("every secret is declared sync:false with no value", () => {
  for (const key of SECRETS) {
    const entry = envByKey.get(key);
    assert.ok(entry, `${key} must be declared so Render asks for it`);
    assert.equal(entry.sync, "false", `${key} must be sync: false`);
    assert.equal("value" in entry, false, `${key} must never carry a value in the repository`);
  }
  for (const entry of envVars) {
    assert.ok(("value" in entry) !== ("sync" in entry), `${entry.key}: exactly one of value / sync`);
    if ("sync" in entry) assert.equal(entry.sync, "false", `${entry.key}`);
    if ("value" in entry) {
      assert.doesNotMatch(entry.value, /:\/\/[^/\s]*@/, `${entry.key} looks like a URL with credentials`);
      assert.doesNotMatch(entry.key, /SECRET|PASSWORD|PASS$|API_KEY|TOKEN|SIGNING_KEY|DATABASE_URL/, `${entry.key} is secret-shaped and has a value`);
    }
  }
  assert.doesNotMatch(SOURCE, /postgres(ql)?:\/\/\S+@/, "no connection string anywhere in the file");
});

test("nothing from the desktop or the test rigs is configured on the cloud", () => {
  for (const key of [
    "FROOZERP_DESKTOP_SERVICE",
    "FROOZERP_SQLITE_PATH",
    "FROOZERP_ALLOW_LOOPBACK_POSTGRES_FOR_ISOLATED_TESTS",
    "FROOZERP_ALLOW_LOOPBACK_CLOUD_FOR_ISOLATED_TESTS",
    "FROOZERP_ALLOW_SCHEMA_DRIFT",
    "RECOVERY_DEV_OTP_ENABLED",
    "BACKUP_DIR",
    "PORT",
    "FROOZERP_CLOUD_FROZEN",
    "DB_SSL_REJECT_UNAUTHORIZED",
  ]) {
    assert.equal(envByKey.has(key), false, `${key} must not be set by the Blueprint`);
  }
  assert.equal(new Set(envVars.map((entry) => entry.key)).size, envVars.length, "no key declared twice");
});

test("Railway's own config is still there, untouched by this phase", () => {
  for (const file of [path.join(ROOT, "railway.json"), path.join(__dirname, "railway.json")]) {
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(config.deploy.healthcheckPath, "/api/health", file);
  }
});
