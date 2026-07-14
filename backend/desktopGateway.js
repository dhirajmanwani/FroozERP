const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const PORT = Number(process.env.PORT || 5000);
const APP_VERSION = String(process.env.APP_VERSION || "0.0.0");
const LEGACY_CLOUD_API_URLS = new Set(["https://froozerp-production.up.railway.app"]);
const DEFAULT_CLOUD_API_URL = "https://froozerp-production-27bb.up.railway.app";
const normalizeCloudApiUrl = (value) => {
  const normalized = String(value || "").trim().replace(/\/$/, "");
  return LEGACY_CLOUD_API_URLS.has(normalized) ? DEFAULT_CLOUD_API_URL : normalized;
};
const CLOUD_API_URL = normalizeCloudApiUrl(process.env.CLOUD_API_URL || process.env.FROOZERP_PUBLIC_API_URL || DEFAULT_CLOUD_API_URL);
const APP_DATA = process.env.APPDATA
  ? path.join(process.env.APPDATA, "com.srtcompany.froozerp")
  : path.join(os.homedir(), "AppData", "Roaming", "com.srtcompany.froozerp");
const SQLITE_PATH = path.resolve(String(
  process.env.FROOZERP_SQLITE_PATH || path.join(APP_DATA, "froozerp-local.sqlite3")
));
const POLICY_PATH = path.join(APP_DATA, "cloud-network-policy.json");

const sendJson = (res, status, payload, headers = {}) => {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": body.length, "cache-control": "no-store", "access-control-allow-origin": "*", "access-control-allow-private-network": "true", ...headers });
  res.end(body);
};

const readPolicy = () => {
  try {
    const value = JSON.parse(fs.readFileSync(POLICY_PATH, "utf8"));
    return { allowInternetAccess: value.allowInternetAccess !== false, updatedAt: value.updatedAt || null };
  } catch {
    return { allowInternetAccess: true, updatedAt: null };
  }
};

const writePolicy = (allowed) => {
  fs.mkdirSync(path.dirname(POLICY_PATH), { recursive: true });
  const value = { allowInternetAccess: allowed !== false, updatedAt: new Date().toISOString() };
  fs.writeFileSync(POLICY_PATH, JSON.stringify(value, null, 2));
  return value;
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
    const error = new Error("FroozERP cloud access is disabled by the Owner.");
    error.code = "APP_INTERNET_DISABLED";
    throw error;
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
  return fetch(`${CLOUD_API_URL}${route}`, {
    method: options.method || req.method,
    headers,
    body: ["GET", "HEAD"].includes(options.method || req.method) ? undefined : body,
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  });
};

const proxy = async (res, response) => {
  const body = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, {
    "content-type": response.headers.get("content-type") || "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
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
    return sendJson(res, 200, { ...policy, status: policy.allowInternetAccess ? "ONLINE" : "APP_INTERNET_DISABLED" });
  }
  if (url.pathname === "/api/cloud/internet-access" && req.method === "PUT") {
    const input = body.length ? JSON.parse(body.toString("utf8")) : {};
    const route = `/api/auth/me?user_id=${encodeURIComponent(input.user_id || req.headers["x-user-id"] || "")}&session_id=${encodeURIComponent(input.session_id || req.headers["x-session-id"] || "")}`;
    const response = await cloudRequest(req, Buffer.alloc(0), route, {
      method: "GET",
      bypassPolicy: input.allowInternetAccess !== false,
    });
    const identity = await response.json().catch(() => ({}));
    if (!response.ok || identity.is_owner !== true) return sendJson(res, 403, { code: "OWNER_REQUIRED", message: "Authenticated Owner permission is required." });
    const policy = writePolicy(input.allowInternetAccess !== false);
    return sendJson(res, 200, { ...policy, status: policy.allowInternetAccess ? "ONLINE" : "APP_INTERNET_DISABLED" });
  }
  if (url.pathname === "/api/cloud/health") {
    if (!readPolicy().allowInternetAccess) return sendJson(res, 200, { status: "ok", localBackendStatus: "ok", appInternetAllowed: false, cloudReachable: false, syncReady: false, errorCode: "APP_INTERNET_DISABLED", safeErrorMessage: "FroozERP cloud access is disabled by the Owner." });
    try {
      const response = await fetch(`${CLOUD_API_URL}/api/health`, { signal: AbortSignal.timeout(8000) });
      const value = await response.json().catch(() => ({}));
      return sendJson(res, 200, { status: "ok", localBackendStatus: "ok", configuredCloudBaseUrl: CLOUD_API_URL, cloudApiConfigured: true, appInternetAllowed: true, railwayHttpStatus: response.status, cloudReachable: response.ok && value.status === "ok", syncReady: false, cloudVersion: value.version || "", errorCode: response.ok ? "" : "CLOUD_HTTP_ERROR", safeErrorMessage: response.ok ? "Cloud backend is reachable." : `Cloud returned HTTP ${response.status}.` });
    } catch {
      return sendJson(res, 200, { status: "ok", localBackendStatus: "ok", configuredCloudBaseUrl: CLOUD_API_URL, cloudApiConfigured: true, appInternetAllowed: true, cloudReachable: false, syncReady: false, errorCode: "CLOUD_UNREACHABLE", safeErrorMessage: "Cloud backend is not reachable." });
    }
  }
  return false;
};

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-private-network": "true", "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS", "access-control-allow-headers": "cache-control,content-type,authorization,x-user-id,x-session-id,x-device-id,x-froozerp-frontend-version" });
    return res.end();
  }
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const body = await readBody(req);
    if (await localRoute(req, res, url, body) !== false) return;
    return proxy(res, await cloudRequest(req, body));
  } catch (error) {
    const causeCode = String(error?.cause?.code || "").trim();
    const causeMessage = String(error?.cause?.message || "").trim();
    return sendJson(res, error.code === "APP_INTERNET_DISABLED" ? 503 : 502, {
      code: error.code || causeCode || "DESKTOP_GATEWAY_ERROR",
      message: causeMessage || error.message || "Desktop gateway request failed.",
    });
  }
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
