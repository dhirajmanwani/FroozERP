"use strict";

/**
 * Refuse to start a hosted backend whose own configuration says it is not hosted.
 *
 * ## What this guards against
 *
 * "Hosted" is decided by FroozERP's own variables, never by the platform's (`storageAdapters.js`
 * `resolveRuntimeMode`, and `hostedCloudDeployment` in `server.js`). Both ways of getting those
 * variables wrong used to start, answer `/api/health` with 200, and go live:
 *
 *   (A) `FROOZERP_RUNTIME_MODE=cloud-server` with `APP_MODE` missing or misspelled. The server runs
 *       against the real Postgres with `hostedCloudDeployment=false`, so `RUN_STARTUP_SCHEMA_BOOTSTRAP`
 *       defaults to true and `initializeDatabase()` runs on every boot. That function is not only
 *       DDL: it archives "duplicate" products, back-fills ids and rewrites role permissions -- on the
 *       shop's live books -- and the hosted-only schema-drift check is skipped.
 *
 *   (B) `APP_MODE` missing or misspelled with no explicit runtime. The process falls through to
 *       `desktop-local`, ignores `DATABASE_URL`, creates an empty SQLite file on the platform's
 *       ephemeral disk, reports healthy, and forwards every business request to whatever cloud URL it
 *       can find -- the old host's, or itself.
 *
 * Neither is visible from the outside until a shop's numbers are wrong. Refusing to start is the
 * cheap direction: a deployment that fails its health check does not replace the one serving the
 * shop, so being wrong here costs "the new version did not go live".
 *
 * ## What it deliberately leaves alone
 *
 * - A correctly configured hosted deployment (cloud-server + `APP_MODE=CLOUD_PRODUCTION`), on any
 *   platform or none.
 * - The loopback stand-in cloud of `scripts/run-rehearsal.mjs` and the in-process test harness
 *   (`routeAuthCoverage.js`): cloud-server, not hosted, `NODE_ENV=test`, and a database that is
 *   loopback or absent. The storage adapter already refuses a loopback database outside that case.
 * - The `scripts/multibranch/isolated-*` rigs: they set `APP_MODE=CLOUD_PRODUCTION`, so they are
 *   hosted as far as this module is concerned, and pass for that reason.
 * - The desktop app. Tauri starts `desktopGateway.js`, not `server.js`, so this never runs there.
 * - Any desktop-local run that *chose* to be desktop-local (`FROOZERP_RUNTIME_MODE` names a mode, or
 *   `FROOZERP_DESKTOP_SERVICE=1`), even with a stray `DATABASE_URL` in the shell, as long as it is
 *   not running on a hosting platform.
 *
 * Pure: reads only what it is handed, so every row of the decision table is a unit test.
 */

const { RUNTIME_MODES, resolveRuntimeMode } = require("./storageAdapters");

const GUARD_CODES = Object.freeze({
  HOSTED_APP_MODE_MISSING: "HOSTED_APP_MODE_MISSING",
  HOSTED_RUNTIME_MISSING: "HOSTED_RUNTIME_MISSING",
});

/**
 * Variables the platforms set on their own. Present only on that platform, so their presence is
 * evidence the process is hosted whatever FroozERP's own variables claim. Values are never read or
 * reported -- only whether a name is set.
 */
const PLATFORM_MARKERS = Object.freeze({
  render: Object.freeze(["RENDER", "RENDER_SERVICE_ID", "RENDER_EXTERNAL_URL", "RENDER_EXTERNAL_HOSTNAME"]),
  railway: Object.freeze([
    "RAILWAY_ENVIRONMENT",
    "RAILWAY_ENVIRONMENT_NAME",
    "RAILWAY_ENVIRONMENT_ID",
    "RAILWAY_PROJECT_ID",
    "RAILWAY_SERVICE_ID",
  ]),
});

const isSet = (value) => String(value ?? "").trim() !== "";

/** `{ platform, markers }` for the first platform whose variables are present, else nulls. */
const detectHostingPlatform = (env = {}) => {
  for (const [platform, names] of Object.entries(PLATFORM_MARKERS)) {
    const markers = names.filter((name) => isSet(env[name]));
    if (markers.length) return { platform, markers };
  }
  return { platform: null, markers: [] };
};

/**
 * The deployment label when `FROOZERP_CLOUD_DEPLOYMENT_ID` is not set. Only a hosted deployment
 * gets one; it names the platform it can see rather than assuming the one it used to run on.
 */
const defaultCloudDeploymentId = ({ env = {}, hostedCloudDeployment = false } = {}) => {
  if (!hostedCloudDeployment) return "";
  const { platform } = detectHostingPlatform(env);
  if (platform === "render") return "render-production";
  if (platform === "railway") return "railway-production";
  return "hosted-production";
};

/**
 * Express `trust proxy` for this process: `false` off the cloud, else a hop count.
 *
 * One hop is right when exactly one proxy sits in front of the app (Railway's edge). A platform
 * whose edge adds more than one hop needs `FROOZERP_TRUST_PROXY_HOPS`, or every per-IP control keys
 * on the platform's own address. Never `true`: trusting the whole chain lets a caller choose the
 * address the server records by prepending it to `X-Forwarded-For`. A value that is not a whole
 * number from 1 to 10 is ignored, with a warning, rather than guessed at.
 */
const MAX_TRUST_PROXY_HOPS = 10;
const resolveTrustProxy = ({ env = {}, cloud = false } = {}) => {
  if (!cloud) return { value: false, warning: "" };
  const raw = String(env.FROOZERP_TRUST_PROXY_HOPS ?? "").trim();
  if (!raw) return { value: 1, warning: "" };
  const hops = Number(raw);
  if (/^\d+$/.test(raw) && Number.isInteger(hops) && hops >= 1 && hops <= MAX_TRUST_PROXY_HOPS) {
    return { value: hops, warning: "" };
  }
  return {
    value: 1,
    warning: `FROOZERP_TRUST_PROXY_HOPS is "${raw}", not a whole number from 1 to ${MAX_TRUST_PROXY_HOPS}; trusting 1 hop.`,
  };
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** "absent" | "loopback" | "remote" | "invalid" for a Postgres connection string. */
const classifyDatabaseUrl = (value) => {
  const text = String(value ?? "").trim();
  if (!text) return "absent";
  try {
    const host = new URL(text).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!host) return "invalid";
    return LOOPBACK_HOSTS.has(host) ? "loopback" : "remote";
  } catch {
    return "invalid";
  }
};

const explicitRuntimeChosen = (env = {}) =>
  Object.values(RUNTIME_MODES).includes(String(env.FROOZERP_RUNTIME_MODE || "").trim().toLowerCase())
  || String(env.FROOZERP_DESKTOP_SERVICE || "").trim() === "1";

/**
 * Decide whether this process may start.
 *
 * @param {object} options
 * @param {object} options.env                     The process environment.
 * @param {string} [options.runtimeMode]           As resolved by the server; derived from env if omitted.
 * @param {boolean} [options.hostedCloudDeployment] As computed by the server; derived if omitted.
 * @param {string} [options.databaseUrl]           For cloud-server: the connection the process will
 *   actually open. The server passes the storage adapter's own connection string, so a test harness
 *   that stubs the adapter is judged by what it connects to (nothing), not by a variable left in the
 *   shell. Defaults to `env.DATABASE_URL`. The desktop-local rule always reads `env.DATABASE_URL`.
 * @returns {{ ok: boolean, code: string|null, message: string, platform: string|null, markers: string[] }}
 */
const evaluateHostedDeploymentGuard = ({
  env = {},
  runtimeMode,
  hostedCloudDeployment,
  databaseUrl,
} = {}) => {
  const resolvedRuntime = runtimeMode || resolveRuntimeMode(env);
  const appMode = String(env.APP_MODE || "").trim().toUpperCase();
  const cloudServer = resolvedRuntime === RUNTIME_MODES.CLOUD_SERVER;
  const hosted = typeof hostedCloudDeployment === "boolean"
    ? hostedCloudDeployment
    : cloudServer && appMode === "CLOUD_PRODUCTION";
  const { platform, markers } = detectHostingPlatform(env);
  const connection = classifyDatabaseUrl(databaseUrl === undefined ? env.DATABASE_URL : databaseUrl);
  const nodeEnvTest = String(env.NODE_ENV || "").trim().toLowerCase() === "test";
  const pass = { ok: true, code: null, message: "", platform, markers };

  if (cloudServer) {
    if (hosted) return pass;
    // Case (A). The only cloud-server that is legitimately not hosted is an isolated test:
    // NODE_ENV=test with nothing remote to connect to. Platform markers do not matter here -- a
    // loopback database cannot be the shop's, and the storage adapter separately refuses loopback
    // unless it is a `_staging` database with the isolated-test flag -- so a rehearsal started from
    // a shell that happens to carry a platform's variables (`railway shell`) still runs.
    const isolatedTest = nodeEnvTest && (connection === "absent" || connection === "loopback");
    if (isolatedTest) return pass;
    return {
      ok: false,
      code: GUARD_CODES.HOSTED_APP_MODE_MISSING,
      platform,
      markers,
      message:
        "Refusing to start: the runtime is cloud-server but APP_MODE is "
        + `${appMode ? `"${appMode}"` : "not set"}, not CLOUD_PRODUCTION. `
        + "Without it this server would run the startup schema bootstrap against "
        + `${connection === "remote" ? "a remote" : "the configured"} PostgreSQL database, `
        + "which rewrites live business data. Set APP_MODE=CLOUD_PRODUCTION and "
        + "FROOZERP_DEPLOYMENT_TYPE=cloud on the hosted service. "
        + "(Only an isolated NODE_ENV=test run against a loopback database may be cloud-server without it.)",
    };
  }

  // Case (B). Not cloud-server, but either running on a hosting platform, or holding a cloud
  // database URL while having fallen through to the default runtime rather than chosen one.
  // Judged on the variable itself: a desktop-local adapter never opens DATABASE_URL, which is the
  // problem -- its presence is the evidence that this process was meant to be the cloud.
  const fellThrough = !explicitRuntimeChosen(env);
  if (platform || (fellThrough && classifyDatabaseUrl(env.DATABASE_URL) !== "absent")) {
    const evidence = platform
      ? `this process is running on ${platform} (${markers.join(", ")} set)`
      : "DATABASE_URL is set but no runtime was chosen";
    return {
      ok: false,
      code: GUARD_CODES.HOSTED_RUNTIME_MISSING,
      platform,
      markers,
      message:
        `Refusing to start: ${evidence}, yet the runtime resolved to ${resolvedRuntime}. `
        + "A hosted backend in desktop-local mode ignores DATABASE_URL, keeps its data on an "
        + "ephemeral disk and forwards business requests to another cloud while reporting itself healthy. "
        + "Set FROOZERP_RUNTIME_MODE=cloud-server, APP_MODE=CLOUD_PRODUCTION and FROOZERP_DEPLOYMENT_TYPE=cloud."
        + (platform ? "" : " (A deliberate local run sets FROOZERP_RUNTIME_MODE=desktop-local, or unsets DATABASE_URL.)"),
    };
  }

  return pass;
};

/** Throw a named error when the guard refuses; return the decision otherwise. */
const assertHostedDeploymentConfiguration = (options) => {
  const decision = evaluateHostedDeploymentGuard(options);
  if (decision.ok) return decision;
  const error = new Error(`[hosted-guard] ${decision.code}: ${decision.message}`);
  error.code = decision.code;
  throw error;
};

module.exports = {
  GUARD_CODES,
  PLATFORM_MARKERS,
  assertHostedDeploymentConfiguration,
  classifyDatabaseUrl,
  defaultCloudDeploymentId,
  detectHostingPlatform,
  evaluateHostedDeploymentGuard,
  resolveTrustProxy,
};
