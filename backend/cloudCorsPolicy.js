"use strict";

/**
 * Which browser origins the backend answers.
 *
 * ## Exact origins, no platform wildcards
 *
 * This used to allow any `https://*.up.railway.app` origin. That suffix is shared by every app on
 * the platform, so the rule did not mean "our cloud" -- it meant "anyone's site on Railway", and
 * any page hosted there could drive a signed-in browser at this API. Moving the cloud would have
 * meant adding `*.onrender.com` and repeating the mistake on a second platform.
 *
 * So the list is exact: the production origin, the retired production origins, the origin this
 * deployment says it is served from (`CLOUD_API_URL` / `FROOZERP_PUBLIC_API_URL` /
 * `RENDER_EXTERNAL_URL`), local development, and `ALLOWED_ORIGINS` for anything deliberate.
 *
 * ## What still works without being listed
 *
 * - No `Origin` at all (server-to-server, the desktop gateway's own health probes, curl).
 * - The Tauri shells: `tauri://localhost` (macOS/Linux) and `http(s)://tauri.localhost` (Windows,
 *   Android). The desktop gateway forwards the WebView's `Origin` unchanged, so these are what the
 *   cloud sees from every counter.
 * - Same origin: a page served by this backend calling this backend, judged by `Host` /
 *   `X-Forwarded-Host`. This is how the hosted web UI works on any platform without configuration.
 * - Loopback and private-network hosts over http(s), for the LAN and the disposable rigs.
 *
 * Pure: the server hands it its configuration and asks per request.
 */

const DEV_ORIGINS = Object.freeze([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5000",
  "http://127.0.0.1:5000",
]);

const TAURI_ORIGINS = Object.freeze(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]);

/** `https://host[:port]` for a URL, or "" when it is not an http(s) URL. */
const originOf = (value) => {
  const text = String(value ?? "").trim();
  if (!text) return "";
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.origin;
  } catch {
    return "";
  }
};

const parseConfiguredOrigins = (value) =>
  String(value ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin && origin !== "*");

const normalizeCorsHost = (value) => {
  const hostValue = String(value || "").split(",")[0].trim().toLowerCase();
  if (!hostValue) return "";
  try {
    return new URL(hostValue).host.toLowerCase();
  } catch {
    return hostValue.replace(/^\[|\]$/g, "");
  }
};

const normalizeCorsHostname = (value) =>
  String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "");

const isPrivateNetworkHost = (hostname) => {
  const hostValue = normalizeCorsHostname(hostname);
  if (!hostValue) return false;
  if (hostValue === "localhost" || hostValue === "127.0.0.1" || hostValue === "::1") return true;
  if (/^10\./.test(hostValue) || /^192\.168\./.test(hostValue)) return true;
  const private172 = hostValue.match(/^172\.(\d{1,3})\./);
  return Boolean(private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31);
};

/**
 * @param {object} options
 * @param {string}   options.productionOrigin  The built-in production cloud origin.
 * @param {string[]} [options.legacyOrigins]   Retired production origins.
 * @param {string}   [options.publicCloudApiUrl] The URL this deployment is served from, if known.
 * @param {string}   [options.configured]      `ALLOWED_ORIGINS` / `CORS_ORIGINS`, comma separated.
 */
const createCorsPolicy = ({ productionOrigin, legacyOrigins = [], publicCloudApiUrl = "", configured = "" } = {}) => {
  const allowedOrigins = [
    ...new Set(
      [
        originOf(productionOrigin),
        ...[...legacyOrigins].map(originOf),
        originOf(publicCloudApiUrl),
        ...DEV_ORIGINS,
        ...parseConfiguredOrigins(configured),
      ].filter(Boolean),
    ),
  ];
  const exact = new Set(allowedOrigins);
  const tauri = new Set(TAURI_ORIGINS);

  /**
   * @param {string|undefined} origin  The request's `Origin` header.
   * @param {{host?: string, forwardedHost?: string}} [request]
   * @throws when the origin is present but not a parseable URL, as before.
   */
  const isAllowedOrigin = (origin, { host = "", forwardedHost = "" } = {}) => {
    if (!origin) return true;
    if (exact.has(origin) || tauri.has(origin)) return true;
    const parsed = new URL(origin);
    if (exact.has(parsed.origin)) return true;
    const originHost = normalizeCorsHost(parsed.host);
    const requestHosts = [normalizeCorsHost(host), normalizeCorsHost(forwardedHost)].filter(Boolean);
    if (requestHosts.includes(originHost)) return true;
    const hostname = normalizeCorsHostname(parsed.hostname);
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && isPrivateNetworkHost(hostname)) return true;
    return false;
  };

  return { allowedOrigins, isAllowedOrigin };
};

module.exports = {
  DEV_ORIGINS,
  TAURI_ORIGINS,
  createCorsPolicy,
  isPrivateNetworkHost,
  originOf,
  parseConfiguredOrigins,
};
