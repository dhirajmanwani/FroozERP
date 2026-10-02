// The production cloud's address, and how a page recognises that it is being served by the cloud.
//
// ## One place per layer
//
// The frontend used to carry this twice -- once in App.jsx, once in syncService.js -- with the
// "is this page served by the cloud?" test copied alongside each. Two copies of a URL do not fail
// loudly when they drift; they split one shop's bills across two databases, and neither half looks
// wrong on screen. So the frontend names it here, once, and both import it.
//
// The other layers still carry their own copy, because they are different languages and processes:
//
//   - src-tauri/src/lib.rs           `PRODUCTION_CLOUD_API_URL`   (what the desktop gateway is handed)
//   - src-tauri/src/mobile_gateway.rs `LEGACY_CLOUD_API_URLS`
//   - backend/desktopGateway.js      `DEFAULT_CLOUD_API_URL`, `LEGACY_CLOUD_API_URLS`
//   - backend/server.js              the legacy origin set
//
// `cloudAddress.test.mjs` reads every one of those and fails if any names a different production
// URL or a different legacy set. Keep the literal below a plain `const NAME = "..."` line: that
// test reads it by regex, deliberately, so it cannot be fed from a build-time variable that the
// Rust side would never see.
//
// ## Moving the cloud
//
// A counter that has signed in once has the production URL *saved* in localStorage
// (`froozerp.apiConfig.cloudApiUrl`), and a saved URL outranks the built-in one. Changing only
// `PRODUCTION_CLOUD_API_URL` therefore moves nobody. The old URL must also go into
// `LEGACY_PRODUCTION_CLOUD_API_URLS`, so `canonicalizeCloudApiUrl` rewrites it on the next load --
// and into every other layer's legacy list at the same time.
//
// Pure: no `import.meta.env`, no React, so `node --test` can load it.

export const PRODUCTION_CLOUD_API_URL = "https://froozerp-cloud.onrender.com";

/** Retired production addresses. A saved one is rewritten to `PRODUCTION_CLOUD_API_URL`. */
export const LEGACY_PRODUCTION_CLOUD_API_URLS = Object.freeze([
  "https://froozerp-production.up.railway.app",
  // Railway, retired by the move to Render + Neon (October 2026).
  "https://froozerp-production-27bb.up.railway.app",
]);

/**
 * Hostname suffixes of the platforms the cloud is (or is about to be) served from.
 *
 * Both stay recognised while the cloud moves: a browser opened on the old service must keep working
 * until that service is gone, and one opened on the new service must work from its first deploy.
 */
export const HOSTED_CLOUD_HOSTNAME_SUFFIXES = Object.freeze([
  ".up.railway.app",
  ".onrender.com",
]);

const LEGACY_SET = new Set(LEGACY_PRODUCTION_CLOUD_API_URLS);

/** Trim and drop one trailing slash. "" for anything absent. */
export const normalizeCloudApiUrl = (value) => String(value || "").trim().replace(/\/$/, "");

/** A retired production address becomes the current one; anything else is only normalised. */
export const canonicalizeCloudApiUrl = (value) => {
  const normalized = normalizeCloudApiUrl(value);
  return LEGACY_SET.has(normalized) ? PRODUCTION_CLOUD_API_URL : normalized;
};

export const isLegacyProductionCloudApiUrl = (value) => LEGACY_SET.has(normalizeCloudApiUrl(value));

const detectTauriRuntime = () => {
  const scope = typeof window === "undefined" ? globalThis : window;
  return Boolean(scope?.__TAURI_INTERNALS__ || scope?.__TAURI__);
};

const currentLocation = () => (typeof window === "undefined" ? undefined : window.location);

const originOf = (location) => {
  if (!location) return "";
  if (location.origin && location.origin !== "null") return normalizeCloudApiUrl(location.origin);
  if (location.protocol && location.host) return normalizeCloudApiUrl(`${location.protocol}//${location.host}`);
  return "";
};

/**
 * True when this page is being served by the hosted cloud itself, so the cloud is its own origin.
 *
 * Recognised: the production URL, a legacy production URL, or any hostname on a hosting platform in
 * `HOSTED_CLOUD_HOSTNAME_SUFFIXES`.
 *
 * Never true inside Tauri. The installed app is not served by the cloud, whatever its location
 * says, and treating it as if it were would make it skip its own local backend.
 */
export const isHostedCloudOrigin = (location = currentLocation(), { tauriRuntime = detectTauriRuntime() } = {}) => {
  if (tauriRuntime) return false;
  if (!location) return false;
  const origin = originOf(location);
  if (origin && (origin === PRODUCTION_CLOUD_API_URL || LEGACY_SET.has(origin))) return true;
  const hostname = String(location.hostname || "").trim().toLowerCase();
  if (!hostname) return false;
  return HOSTED_CLOUD_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
};
