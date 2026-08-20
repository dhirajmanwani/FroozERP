const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { CLOUD_UNAVAILABLE_MESSAGE, normalizeCloudProxyError } = require("./cloudProxyError");
const { DatabaseSync } = require("node:sqlite");
const { readLocalSettingsBundle } = require("./localSettingsStore");

const PORT = Number(process.env.PORT || 5000);
const APP_VERSION = String(process.env.APP_VERSION || "0.0.0");
const LEGACY_CLOUD_API_URLS = new Set(["https://froozerp-production.up.railway.app"]);
const DEFAULT_CLOUD_API_URL = "https://froozerp-production-27bb.up.railway.app";
const normalizeCloudApiUrl = (value) => {
  const normalized = String(value || "").trim().replace(/\/$/, "");
  return LEGACY_CLOUD_API_URLS.has(normalized) ? DEFAULT_CLOUD_API_URL : normalized;
};
// The desktop shell launches this gateway without CLOUD_API_URL or FROOZERP_PUBLIC_API_URL
// (src-tauri/src/lib.rs), so an unconditional production default meant every packaged
// installation proxied to production whether or not anyone had configured a cloud. An
// unconfigured gateway now has no cloud target and refuses cloud routing by name.
const CLOUD_API_URL = normalizeCloudApiUrl(process.env.CLOUD_API_URL || process.env.FROOZERP_PUBLIC_API_URL || "");
const CLOUD_TARGET_CONFIGURED = CLOUD_API_URL !== "";
const CLOUD_NOT_CONFIGURED_MESSAGE = "No cloud backend is configured for this installation. The request was refused instead of being sent to a default target.";
const cloudNotConfiguredError = (route) => {
  const error = new Error(CLOUD_NOT_CONFIGURED_MESSAGE);
  error.code = "CLOUD_NOT_CONFIGURED";
  error.route = route;
  return error;
};
const APP_DATA = process.env.APPDATA
  ? path.join(process.env.APPDATA, "com.srtcompany.froozerp")
  : path.join(os.homedir(), "AppData", "Roaming", "com.srtcompany.froozerp");
const SQLITE_PATH = path.resolve(String(
  process.env.FROOZERP_SQLITE_PATH || path.join(APP_DATA, "froozerp-local.sqlite3")
));
const POLICY_PATH = path.join(APP_DATA, "cloud-network-policy.json");
const CLOUD_REQUEST_AUDIT_PATH = path.join(APP_DATA, "logs", "cloud-request-audit.jsonl");

const failClosedPolicy = () => ({
  allowInternetAccess: false,
  updatedAt: null,
  confirmedAt: null,
  timeSource: "device",
  changedBy: null,
  deviceId: null,
});

// ---------------------------------------------------------------------------------------------
// LOCAL_ONLY kill-switch authority
//
// PUT /api/cloud/internet-access is the control that decides whether this device may talk to the
// internet at all, so the hard boundary it enforces ("LOCAL_ONLY must keep blocked=true,
// reachedCloud=false, cloud-router invocations at 0 and external connections at 0") is only ever
// as strong as the answer to "who is allowed to call this route?". Until this block existed the
// answer was "anyone who can set two headers": `x-user-id` and `x-user-role: OWNER` were taken at
// face value, and this process has no session middleware standing in front of them.
//
// What this process can and cannot verify, established before any of this was designed:
//
//   - It holds no session signing key. It is a separate process from server.js and never sees one.
//     The desktop shell does hand it FROOZERP_BACKEND_OWNER_TOKEN, which looks like a credential
//     and is not: `desktop_instance_token` in src-tauri/src/lib.rs builds it as
//     `froozerp-<pid>-<unix seconds>`, and `write_backend_ownership` then writes it in clear to a
//     file in the profile directory. It is a "which shell owns this backend process" marker. It is
//     deliberately NOT used as a secret here, because treating a guessable, world-readable value as
//     one would look like authentication while providing none.
//
//   - It listens on 127.0.0.1 only (see server.listen at the foot of this file), so no other
//     device on the LAN can reach it.
//
//   => The one attacker outside this machine's trust boundary is a **web page**. Every response
//      here carries `access-control-allow-origin: *` and `access-control-allow-private-network:
//      true`, and the preflight below advertises PUT along with x-user-id/x-user-role, so any site
//      the Owner happens to load could preflight this route and flip the shop's kill switch. A
//      browser will not let script forge `Origin`, so that header is the one thing here that is
//      actually worth checking, and it is what `classifyControlOrigin` checks.
//
//   - Any *process* running as the Owner on this machine can still call this route with whatever
//     headers it likes. Nothing this process can hold would stop it: any secret the gateway could
//     read from disk, a process running as the same user can read too. That residual risk is real,
//     is not closed by this block, and is stated rather than papered over.
//
// The direction of the request decides how strict the check is allowed to be, and that asymmetry
// is the whole safety argument -- see `resolveKillSwitchDecision`.
// ---------------------------------------------------------------------------------------------

const KILL_SWITCH_REFUSALS = Object.freeze({
  OWNER_REQUIRED: Object.freeze({
    code: "OWNER_REQUIRED",
    message: "Authenticated Owner permission is required.",
  }),
  CROSS_ORIGIN_CONTROL_REFUSED: Object.freeze({
    code: "CROSS_ORIGIN_CONTROL_REFUSED",
    message: "Cloud access can only be re-enabled from FroozERP on this device.",
  }),
  OWNER_NOT_RECOGNISED: Object.freeze({
    code: "OWNER_NOT_RECOGNISED",
    message: "This device does not recognise the requesting user as an Owner.",
  }),
});

const CONTROL_ORIGINS = Object.freeze({
  DESKTOP_APP: "DESKTOP_APP",
  FOREIGN_WEBSITE: "FOREIGN_WEBSITE",
  NOT_A_BROWSER: "NOT_A_BROWSER",
});

// The webview origins the shipped app actually presents. Same set as `allowedTauriCorsOrigins` in
// backend/server.js, which exists because these are the origins the Tauri shell sends to the cloud
// backend -- so this is observed behaviour of the shipped app, not a guess about Tauri internals.
const DESKTOP_SHELL_ORIGINS = new Set(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]);
const LOOPBACK_ORIGIN_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Decide whether an `Origin` header belongs to this device's own app, to a website, or to
 * something that is not a browser at all.
 *
 * The classifier is deliberately built to recognise a **website**, not to enumerate every origin
 * the app might ever present. A website is always http(s) on a publicly resolvable hostname; an
 * origin this function does not understand (a future custom scheme, say) is reported as
 * NOT_A_BROWSER rather than as hostile. Getting that backwards is the expensive mistake: a
 * shipped app whose origin form changed would be refused its own kill switch, and on a device
 * already in LOCAL_ONLY there is no second route back -- the Owner would have to hand-edit
 * cloud-network-policy.json.
 *
 * `Sec-Fetch-Site` is intentionally not consulted. The desktop webview's own request to
 * http://127.0.0.1:5000 is genuinely `cross-site` (it is issued from tauri://localhost), so
 * treating that value as hostile would lock the Owner out of their own switch.
 *
 * The literal `null` origin -- a sandboxed iframe or a file:// page -- is a website, not the app:
 * the app always presents a real origin, so `null` can only be someone else.
 */
const classifyControlOrigin = (value) => {
  const origin = String(value || "").trim();
  if (!origin) return CONTROL_ORIGINS.NOT_A_BROWSER;
  const lowered = origin.toLowerCase();
  if (lowered === "null") return CONTROL_ORIGINS.FOREIGN_WEBSITE;
  if (DESKTOP_SHELL_ORIGINS.has(lowered)) return CONTROL_ORIGINS.DESKTOP_APP;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return CONTROL_ORIGINS.NOT_A_BROWSER;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return CONTROL_ORIGINS.NOT_A_BROWSER;
  const hostname = parsed.hostname.toLowerCase();
  // `.localhost` is reserved to loopback (RFC 6761) and browsers resolve it locally, so it cannot
  // be claimed by a public site. This covers the dev server on http://localhost:5173 as well as
  // the packaged shell's http://tauri.localhost.
  if (LOOPBACK_ORIGIN_HOSTNAMES.has(hostname)) return CONTROL_ORIGINS.DESKTOP_APP;
  if (hostname.endsWith(".localhost")) return CONTROL_ORIGINS.DESKTOP_APP;
  if (/^127\./.test(hostname)) return CONTROL_ORIGINS.DESKTOP_APP;
  return CONTROL_ORIGINS.FOREIGN_WEBSITE;
};

/**
 * Who may move the kill switch, and in which direction.
 *
 * Pure on purpose: no fs, no http, no clock. The decision is the part that has to be right, and
 * keeping it separable is why it can be tested exhaustively in
 * backend/desktopGatewayOwnerControl.test.js.
 *
 * ## The asymmetry
 *
 * The two directions of this switch do not carry the same risk, so they do not get the same test:
 *
 *   - **Unlocking** (allowInternetAccess: true) is the direction that can end the LOCAL_ONLY
 *     guarantee. Every check below applies to it, and any check that cannot be satisfied refuses,
 *     which leaves the policy file untouched and therefore leaves the device exactly as blocked as
 *     it already was. That is what "fail closed" means for this control.
 *
 *   - **Locking down** (allowInternetAccess: false) can only ever make the device more isolated. A
 *     refusal here would be the one way this hardening could leave a device *less* locked down
 *     than before -- an Owner who cannot switch into LOCAL_ONLY stays on the internet. So the
 *     lockdown direction keeps exactly the check it had before this change (Owner headers) and
 *     gains no new way to fail. It is not made weaker either: `OWNER_REQUIRED` still applies.
 *
 * A consequence worth stating plainly: a website that guesses the two headers can still force this
 * device *into* LOCAL_ONLY. That is unchanged from before this block existed, it never opens cloud
 * access, and closing it would cost the property in the paragraph above.
 *
 * `localOwnerUserIds` is the list of user ids this device has cached as Owners, or `null` when
 * that could not be established (no local database, no cached profiles, unreadable file). Null and
 * empty mean *cannot evaluate*, and an unevaluable corroboration is skipped rather than treated as
 * a failure -- the same rule, for the same reason, as
 * frontend/src/local/offlineCredentialSource.js: a device that has never cached a profile would
 * otherwise be unable to leave LOCAL_ONLY at all, which is a lockout, not a defence. When the list
 * *can* be evaluated, the Owner role is taken from local data instead of from a header a caller
 * chose, which is the point.
 */
const resolveKillSwitchDecision = ({
  requestedInternetAccess,
  userId: claimedUserId = "",
  role: claimedRole = "",
  deviceId: claimedDeviceId = "",
  origin: originHeader = "",
  localOwnerUserIds = null,
} = {}) => {
  const userId = String(claimedUserId || "").trim();
  const role = String(claimedRole || "").trim().toUpperCase();
  const deviceId = String(claimedDeviceId || "").trim();
  const provenance = classifyControlOrigin(originHeader);

  if (!userId || !deviceId || role !== "OWNER") {
    return { allowed: false, provenance, ...KILL_SWITCH_REFUSALS.OWNER_REQUIRED };
  }

  if (requestedInternetAccess !== true) return { allowed: true, direction: "LOCK_DOWN", provenance };

  if (provenance === CONTROL_ORIGINS.FOREIGN_WEBSITE) {
    return { allowed: false, provenance, ...KILL_SWITCH_REFUSALS.CROSS_ORIGIN_CONTROL_REFUSED };
  }

  // User ids are opaque strings (CLAUDE.md): compared trimmed and exact, never coerced with
  // Number(), so "004" and "4" stay different people.
  const knownOwners = (Array.isArray(localOwnerUserIds) ? localOwnerUserIds : [])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  if (knownOwners.length > 0 && !knownOwners.includes(userId)) {
    return { allowed: false, provenance, ...KILL_SWITCH_REFUSALS.OWNER_NOT_RECOGNISED };
  }

  return { allowed: true, direction: "UNLOCK", provenance };
};

/**
 * Owner user ids this device has cached, or `null` when the question cannot be answered.
 *
 * The local database is the only place this process can learn anything about users that the
 * caller did not simply assert: local_kv holds `offline_user_profile::<device>::<username>`
 * records written by src-tauri/src/local_db.rs, and those carry `id` and `role`. Read-only, and
 * every failure -- missing file, missing table, malformed JSON -- returns `null`, meaning
 * "cannot evaluate". `null` never grants anything on its own; it only leaves the corroboration
 * step to be skipped by `resolveKillSwitchDecision`.
 *
 * Profiles are read across every device prefix on purpose. This machine is one trust boundary,
 * and a profile filed under a superseded device id is still evidence about who the Owner is.
 */
const readLocalOwnerUserIds = () => {
  let database = null;
  try {
    database = new DatabaseSync(SQLITE_PATH, { readOnly: true });
    const rows = database
      .prepare("SELECT value FROM local_kv WHERE key LIKE 'offline_user_profile::%'")
      .all();
    const owners = [];
    for (const row of rows) {
      let profile;
      try {
        profile = JSON.parse(row.value);
      } catch {
        continue;
      }
      if (String(profile?.role || "").trim().toUpperCase() !== "OWNER") continue;
      const id = String(profile?.id ?? "").trim();
      if (id) owners.push(id);
    }
    return owners;
  } catch {
    return null;
  } finally {
    try {
      database?.close();
    } catch {}
  }
};

const sendJson = (res, status, payload, headers = {}) => {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": body.length, "cache-control": "no-store", "access-control-allow-origin": "*", "access-control-allow-private-network": "true", ...headers });
  res.end(body);
};

const readPolicy = () => {
  try {
    const value = JSON.parse(fs.readFileSync(POLICY_PATH, "utf8"));
    if (typeof value?.allowInternetAccess !== "boolean") return failClosedPolicy();
    return {
      allowInternetAccess: value.allowInternetAccess,
      updatedAt: value.updatedAt || null,
      confirmedAt: value.confirmedAt || value.updatedAt || null,
      timeSource: value.timeSource || "device",
      changedBy: value.changedBy || null,
      deviceId: value.deviceId || null,
    };
  } catch {
    return failClosedPolicy();
  }
};

const writePolicy = (allowed, metadata = {}) => {
  fs.mkdirSync(path.dirname(POLICY_PATH), { recursive: true });
  const value = {
    allowInternetAccess: allowed !== false,
    updatedAt: new Date().toISOString(),
    confirmedAt: metadata.confirmedAt || new Date().toISOString(),
    timeSource: metadata.timeSource || "device",
    changedBy: metadata.changedBy || null,
    deviceId: metadata.deviceId || null,
  };
  fs.writeFileSync(POLICY_PATH, JSON.stringify(value, null, 2));
  return value;
};

const auditCloudRequest = (entry) => {
  try {
    fs.mkdirSync(path.dirname(CLOUD_REQUEST_AUDIT_PATH), { recursive: true });
    fs.appendFileSync(CLOUD_REQUEST_AUDIT_PATH, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch {}
};

const readAuthoritativeTime = async () => {
  if (!CLOUD_TARGET_CONFIGURED) {
    // Without this the empty base turned the probe into fetch("/api/health"), which throws
    // on a relative URL and was swallowed by the catch below -- a silent no-op that made
    // "no cloud configured" look identical to "cloud is down". Name it and audit it.
    auditCloudRequest({ method: "GET", route: "/api/health", blocked: true, reachedCloud: false, reason: "CLOUD_NOT_CONFIGURED", source: "authoritative-time" });
    return { confirmedAt: new Date().toISOString(), timeSource: "device" };
  }
  try {
    const response = await fetch(`${CLOUD_API_URL}/api/health`, { signal: AbortSignal.timeout(5000) });
    const value = await response.json().catch(() => ({}));
    if (response.ok && value.server_time) return { confirmedAt: new Date(value.server_time).toISOString(), timeSource: "railway" };
  } catch {}
  return { confirmedAt: new Date().toISOString(), timeSource: "device" };
};

const validateSQLite = () => {
  if (!SQLITE_PATH) throw new Error("FROOZERP_SQLITE_PATH is required.");
  const descriptor = fs.openSync(SQLITE_PATH, "r+");
  try {
    const header = Buffer.alloc(16);
    if (fs.readSync(descriptor, header, 0, 16, 0) !== 16 || header.toString("utf8") !== "SQLite format 3\u0000") {
      throw new Error("The local database is not valid SQLite.");
    }
  } finally {
    fs.closeSync(descriptor);
  }
};

const health = () => {
  validateSQLite();
  return {
    status: "ok",
    app: "FroozERP",
    api_version: "1",
    server_time: new Date().toISOString(),
    version: APP_VERSION,
    database: "reachable",
    database_type: "sqlite",
    database_path: SQLITE_PATH,
    storage_adapter: "desktop-sqlite",
    client_postgres_access: false,
    deployment_type: "local",
    app_mode: "LOCAL_SINGLE_DEVICE",
    cloud_api_configured: Boolean(CLOUD_API_URL),
  };
};

const readBody = async (req) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 25 * 1024 * 1024) throw new Error("Request body exceeds the desktop gateway limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const cloudRequest = async (req, body, route = req.url, options = {}) => {
  if (!options.bypassPolicy && !readPolicy().allowInternetAccess) {
    auditCloudRequest({ method: options.method || req.method, route, blocked: true, reachedCloud: false, reason: "APP_LOCAL_ONLY" });
    const error = new Error("Local Only mode selected - cloud sync paused.");
    error.code = "APP_LOCAL_ONLY";
    throw error;
  }
  if (!CLOUD_TARGET_CONFIGURED) {
    auditCloudRequest({ method: options.method || req.method, route, blocked: true, reachedCloud: false, reason: "CLOUD_NOT_CONFIGURED" });
    throw cloudNotConfiguredError(route);
  }
  const headers = {};
  for (const [name, value] of Object.entries(req.headers || {})) {
    if ([
      "host",
      "content-length",
      "connection",
      "accept-encoding",
      "expect",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
    ].includes(name.toLowerCase())) continue;
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  headers["x-froozerp-client-runtime"] = "desktop-local";
  auditCloudRequest({ method: options.method || req.method, route, blocked: false, reachedCloud: true });
  return fetch(`${CLOUD_API_URL}${route}`, {
    method: options.method || req.method,
    headers,
    body: ["GET", "HEAD"].includes(options.method || req.method) ? undefined : body,
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  });
};

const proxy = async (res, response) => {
  if ([502, 503, 504].includes(response.status)) {
    return sendJson(res, 503, {
      code: "CLOUD_UNAVAILABLE",
      failure_kind: "CLOUD_UNAVAILABLE",
      cloud_connected: false,
      message: CLOUD_UNAVAILABLE_MESSAGE,
    });
  }
  const body = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, {
    "content-type": response.headers.get("content-type") || "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-private-network": "true",
    "x-froozerp-storage-mode": "desktop-sqlite",
  });
  res.end(body);
};

const localRoute = async (req, res, url, body) => {
  if (["/health", "/api/health"].includes(url.pathname)) return sendJson(res, 200, health());
  if (url.pathname === "/api/version") return sendJson(res, 200, { ...health(), api: "FroozERP Desktop Gateway" });
  if (url.pathname === "/api/system/compatibility") {
    const frontendVersion = url.searchParams.get("frontend_version") || req.headers["x-froozerp-frontend-version"] || APP_VERSION;
    return sendJson(res, 200, { status: "ok", appVersion: APP_VERSION, frontendVersion, backendVersion: APP_VERSION, compatible: frontendVersion === APP_VERSION, database: "reachable", databaseType: "sqlite", storageAdapter: "desktop-sqlite", clientPostgresAccess: false, deploymentType: "local", appMode: "LOCAL_SINGLE_DEVICE" });
  }
  if (url.pathname === "/api/cloud/internet-access" && req.method === "GET") {
    const policy = readPolicy();
    return sendJson(res, 200, { ...policy, status: policy.allowInternetAccess ? "AUTO" : "LOCAL_ONLY" });
  }
  if (url.pathname === "/api/cloud/internet-access" && req.method === "PUT") {
    const input = body.length ? JSON.parse(body.toString("utf8")) : {};
    const userId = String(input.user_id || req.headers["x-user-id"] || "").trim();
    const role = String(input.role || req.headers["x-user-role"] || "").trim().toUpperCase();
    const deviceId = String(input.device_id || req.headers["x-device-id"] || "").trim();
    const requestedInternetAccess = input.allowInternetAccess !== false;
    const decision = resolveKillSwitchDecision({
      requestedInternetAccess,
      userId,
      role,
      deviceId,
      origin: req.headers.origin,
      // Only the unlocking direction is corroborated against local data, and only that direction
      // pays for the read. See resolveKillSwitchDecision for why the lockdown direction must not
      // acquire a new way to fail.
      localOwnerUserIds: requestedInternetAccess ? readLocalOwnerUserIds() : null,
    });
    if (!decision.allowed) {
      // A refusal returns before writePolicy, so the policy file is untouched and the device keeps
      // the mode it already had. A refused request can never be the thing that opens cloud access,
      // and no outbound request has been made at this point -- both are asserted in
      // backend/desktopGatewayOwnerControl.test.js. Auditing it as blocked keeps the refusal
      // visible in cloud-request-audit.jsonl rather than silent.
      auditCloudRequest({
        method: req.method,
        route: url.pathname,
        blocked: true,
        reachedCloud: false,
        reason: decision.code,
        source: "kill-switch-authority",
        provenance: decision.provenance,
      });
      return sendJson(res, 403, { code: decision.code, message: decision.message });
    }
    // Gate the authoritative-time probe on the mode being *requested*, not the mode currently in
    // force. This handler is the one place where those two disagree, because it is the moment the
    // Owner switches. Consulting the policy in force would be wrong in both directions:
    //   - switching *into* LOCAL_ONLY, the old policy still says Auto, so the outbound
    //     /api/health probe would still fire — the exact breach of the CLAUDE.md invariant
    //     "LOCAL_ONLY ... external connections at 0";
    //   - switching back *to* Auto, the old policy still says LOCAL_ONLY, so the probe would be
    //     refused and a legitimate switch-on would lose server-confirmed time for no reason.
    // The requested value is the policy that takes effect the instant writePolicy returns, and it
    // is the Owner's authorisation for this request, so it is what the gate consults. It is
    // computed above because the authority check needs it too.
    let time;
    if (requestedInternetAccess) {
      time = await readAuthoritativeTime();
    } else {
      auditCloudRequest({ method: req.method, route: url.pathname, blocked: true, reachedCloud: false, reason: "APP_LOCAL_ONLY", source: "authoritative-time" });
      time = { confirmedAt: new Date().toISOString(), timeSource: "device" };
    }
    const policy = writePolicy(input.allowInternetAccess !== false, { ...time, changedBy: userId, deviceId });
    return sendJson(res, 200, { ...policy, status: policy.allowInternetAccess ? "AUTO" : "LOCAL_ONLY" });
  }
  if (url.pathname === "/api/cloud/health") {
    if (!readPolicy().allowInternetAccess) return sendJson(res, 200, { status: "ok", localBackendStatus: "ok", appInternetAllowed: false, cloudReachable: false, syncReady: false, errorCode: "APP_LOCAL_ONLY", safeErrorMessage: "Local Only mode selected - cloud sync paused." });
    if (!CLOUD_TARGET_CONFIGURED) {
      auditCloudRequest({ method: req.method, route: url.pathname, blocked: true, reachedCloud: false, reason: "CLOUD_NOT_CONFIGURED", source: "cloud-health" });
      return sendJson(res, 200, { status: "ok", localBackendStatus: "ok", configuredCloudBaseUrl: "", cloudApiConfigured: false, appInternetAllowed: true, cloudReachable: false, syncReady: false, errorCode: "CLOUD_NOT_CONFIGURED", safeErrorMessage: CLOUD_NOT_CONFIGURED_MESSAGE });
    }
    try {
      const response = await fetch(`${CLOUD_API_URL}/api/health`, { signal: AbortSignal.timeout(8000) });
      const value = await response.json().catch(() => ({}));
      return sendJson(res, 200, { status: "ok", localBackendStatus: "ok", configuredCloudBaseUrl: CLOUD_API_URL, cloudApiConfigured: true, appInternetAllowed: true, railwayHttpStatus: response.status, cloudReachable: response.ok && value.status === "ok", syncReady: false, cloudVersion: value.version || "", errorCode: response.ok ? "" : "CLOUD_HTTP_ERROR", safeErrorMessage: response.ok ? "Cloud backend is reachable." : `Cloud returned HTTP ${response.status}.` });
    } catch {
      return sendJson(res, 200, { status: "ok", localBackendStatus: "ok", configuredCloudBaseUrl: CLOUD_API_URL, cloudApiConfigured: true, appInternetAllowed: true, cloudReachable: false, syncReady: false, errorCode: "CLOUD_UNREACHABLE", safeErrorMessage: "Cloud backend is not reachable." });
    }
  }
  if (url.pathname === "/settings" && req.method === "GET" && !readPolicy().allowInternetAccess) {
    auditCloudRequest({ method: req.method, route: req.url, blocked: true, reachedCloud: false, reason: "APP_LOCAL_ONLY", source: "local-sqlite" });
    const local = readLocalSettingsBundle(SQLITE_PATH);
    return sendJson(res, 200, local.settings, {
      "x-froozerp-settings-source": "local-sqlite",
      "x-froozerp-canonical-device-id": local.canonicalDeviceId,
    });
  }
  return false;
};

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-private-network": "true", "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS", "access-control-allow-headers": "cache-control,content-type,authorization,x-user-id,x-user-role,x-session-id,x-device-id,x-froozerp-frontend-version" });
    return res.end();
  }
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const body = await readBody(req);
    if (await localRoute(req, res, url, body) !== false) return;
    return proxy(res, await cloudRequest(req, body));
  } catch (error) {
    if (String(error?.code || "").startsWith("LOCAL_") || error?.code === "DEVICE_IDENTITY_CONFLICT") {
      return sendJson(res, 503, {
        code: error.code,
        failure_kind: "LOCAL_SETTINGS_UNAVAILABLE",
        cloud_connected: false,
        message: error.message,
      });
    }
    const normalized = normalizeCloudProxyError(error);
    return sendJson(res, normalized.status, normalized.payload);
  }
});

// The kill-switch decision is exported so it can be tested without a live port, and the listener
// is started only when this file is the process entry point (src-tauri/src/lib.rs runs it as
// `node desktopGateway.js`). Binding the port on `require` would mean a test either fights the
// running app for port 5000 or cannot import the decision at all.
//
// The exports stay inside this file rather than moving to a module of their own because
// src-tauri/tauri.conf.json lists the gateway's dependencies as individual bundle resources
// (desktopGateway.js, cloudProxyError.js, localSettingsStore.js). A new require target that nobody
// remembered to add to that list would be missing from the installer, and the gateway would die on
// startup in the packaged app only.
module.exports = {
  CONTROL_ORIGINS,
  KILL_SWITCH_REFUSALS,
  classifyControlOrigin,
  resolveKillSwitchDecision,
};

if (require.main === module) {
  server.once("error", (error) => {
    if (error?.code === "EADDRINUSE") {
      console.error(`FroozERP desktop gateway port ${PORT} is already owned; duplicate process exiting.`);
      process.exit(0);
    }
    throw error;
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`FroozERP desktop gateway ready on 127.0.0.1:${PORT}`);
    console.log(`Storage adapter: desktop-sqlite`);
    console.log(`SQLite path: ${SQLITE_PATH}`);
    console.log("PostgreSQL client access: blocked");
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
