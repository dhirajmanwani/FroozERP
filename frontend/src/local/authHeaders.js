/**
 * Request headers that carry the signed session token.
 *
 * Auth-hardening A-3 (`docs/auth-hardening-plan.md`). The backend's `requireAuth` accepts the
 * session token as `Authorization: Bearer <token>` — the standard, and what a future mobile or web
 * client will send — **and** as `x-froozerp-device-session`, which the sync routes and the desktop
 * have always sent. Both envelopes carry the same token and get the same verification.
 *
 * This module exists so there is exactly one place that decides how a request proves who it is. The
 * headers were previously written inline at five call sites across `App.jsx` and `syncService.js`;
 * five copies of an authentication decision is how one of them ends up subtly different and wrong.
 *
 * ## Why the legacy header is still sent
 *
 * Dropping it would break sync against any backend built before A-3 for no security gain — the
 * server verifies the same signature either way. It goes when A-4 lands the middleware everywhere
 * and the old header has no remaining reader.
 *
 * ## Why `Authorization` is omitted when there is no token
 *
 * `Authorization: Bearer ` (empty) is a malformed credential, not an absent one, and some proxies
 * and servers treat the two differently. Absent is what "not signed in" actually means. The legacy
 * header keeps its long-standing empty-string behaviour so nothing that reads it changes.
 */

export const SESSION_HEADER = "x-froozerp-device-session";
export const AUTHORIZATION_HEADER = "Authorization";

const tokenText = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * Headers proving the caller's identity.
 *
 * @param {string} token the `device_session_token` returned by `/login`
 * @returns {Record<string, string>} `Authorization` plus the legacy header, or only the legacy
 *   header (empty-valued) when there is no token
 */
export const sessionAuthHeaders = (token) => {
  const value = tokenText(token);
  if (!value) return { [SESSION_HEADER]: "" };
  return {
    [AUTHORIZATION_HEADER]: `Bearer ${value}`,
    [SESSION_HEADER]: value,
  };
};

/**
 * Same headers, but omitted entirely when there is no token.
 *
 * The sync push/pull paths pass `undefined` rather than empty headers when signed out, and that
 * distinction is load-bearing for their existing error handling — an unauthenticated sync must look
 * like "no credentials" rather than "empty credentials".
 *
 * @returns {Record<string, string>|undefined}
 */
export const optionalSessionAuthHeaders = (token) => {
  const value = tokenText(token);
  if (!value) return undefined;
  return sessionAuthHeaders(value);
};
