"use strict";

/**
 * Request authentication — Stage A-3 of `docs/auth-hardening-plan.md`.
 *
 * ## The hole this closes
 *
 * `server.js` currently establishes identity by reading the `x-user-id` request header and
 * believing it. There is no signature, no password, and no middleware on any route: anyone who can
 * reach the API can claim to be any user, including Owner. That is not a weak check — it is no
 * check, and it is the reason the backend cannot be exposed to the internet.
 *
 * `requireAuth` replaces that with a signed session token. **It never reads `x-user-id`.** A caller
 * cannot influence who the server thinks they are except by presenting a token this server signed.
 *
 * ## Built on `deviceSession.js`, not beside it
 *
 * The HMAC scheme, its version tag, TTL, and — importantly — `rejectDeviceSessionSubstitution`
 * already exist and are already used by the sync routes. Design §12 rules that module *kept*. This
 * extends it rather than introducing a second, subtly different token, because two authentication
 * schemes in one service is how one of them ends up unmaintained and wrong.
 *
 * ## Transport
 *
 * Accepts `Authorization: Bearer <token>` (what A-3 specifies, and what any future mobile or web
 * client will send) **and** the existing `x-froozerp-device-session` header, which the sync path
 * and the desktop already send. Same token, same signature, same verification — only the envelope
 * differs. Rejecting the existing header would break sync for no security gain.
 *
 * ## Fail closed, always
 *
 * Every path that cannot positively establish identity returns 401. There is no fallback to a
 * header, no "if no token then anonymous", and no development bypass — a bypass switch is exactly
 * the thing that survives into production. Absence of proof is never permission.
 */

const {
  rejectDeviceSessionSubstitution,
  verifyDeviceSession,
} = require("./deviceSession");

const AUTH_HEADER = "authorization";
const LEGACY_SESSION_HEADER = "x-froozerp-device-session";
const BEARER_PREFIX = /^bearer\s+/i;

const AUTH_ERRORS = Object.freeze({
  MISSING: {
    status: 401,
    code: "AUTH_SESSION_REQUIRED",
    message: "An authenticated session is required.",
  },
  ROLE_UNKNOWN: {
    status: 403,
    code: "AUTH_ROLE_UNKNOWN",
    message: "This session does not carry a role. Sign in again to continue.",
  },
  ROLE_FORBIDDEN: {
    status: 403,
    code: "AUTH_ROLE_FORBIDDEN",
    message: "This account does not have permission for that action.",
  },
  MISCONFIGURED: {
    status: 500,
    code: "AUTH_NOT_CONFIGURED",
    message: "Server authentication is not configured.",
  },
});

const text = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * Pull the session token out of a request.
 *
 * `Authorization: Bearer` is checked first because it is the standard and what new clients send;
 * the legacy header is the compatibility path. Returns `""` when neither is usable — never `null`
 * or `undefined`, so callers cannot accidentally treat "absent" as truthy.
 */
const extractSessionToken = (req) => {
  const headers = req?.headers || {};
  const authorization = text(headers[AUTH_HEADER]);
  if (authorization && BEARER_PREFIX.test(authorization)) {
    const token = authorization.replace(BEARER_PREFIX, "").trim();
    if (token) return token;
  }
  return text(headers[LEGACY_SESSION_HEADER]);
};

/**
 * Identity a route handler may trust, derived only from verified claims.
 *
 * Field names are deliberately camelCase, unlike the snake_case claims, so that a handler reading
 * `req.auth.userId` is visibly reading verified identity rather than something off the request.
 */
const authContextFromClaims = (claims) => ({
  userId: Number(claims.user_id),
  deviceId: String(claims.device_id),
  companyId: Number(claims.company_id),
  branchId: Number(claims.branch_id),
  role: text(claims.role),
  normalizedRole: text(claims.role).toUpperCase(),
  sessionRevocationVersion: Number(claims.session_revocation_version || 0),
  issuedAt: Number(claims.issued_at) || null,
  expiresAt: Number(claims.expires_at) || null,
});

/**
 * Values a caller supplied that claim to identify them, gathered for the substitution check.
 *
 * A request may legitimately restate its own identity in a body or query — the sync routes do. What
 * it may never do is restate it *differently* from the token, which is an attempt to act as someone
 * else while holding a valid session of their own. `x-user-id` is included here **as a value to be
 * checked against the token**, never as a source of identity: after A-3 it can only ever agree or
 * be rejected.
 */
const submittedIdentityFrom = (req) => {
  const headers = req?.headers || {};
  const body = req?.body && typeof req.body === "object" ? req.body : {};
  const query = req?.query && typeof req.query === "object" ? req.query : {};
  // Every place a field was supplied, not the first one found.
  //
  // `??` picked one and ignored the rest, which only holds if every downstream reader picks the
  // same one. They do not: `aiBusinessAssistantService.js` read the query first while this took the
  // header, so a caller could satisfy the check with an agreeing header and still hand the handler
  // a different id in the query. Collecting all of them makes the check independent of what any
  // handler happens to read.
  return {
    user_id: [headers["x-user-id"], body.user_id, query.user_id],
    device_id: [headers["x-device-id"], body.device_id, query.device_id],
    company_id: [body.company_id, query.company_id],
    branch_id: [body.branch_id, query.branch_id],
  };
};

const sendAuthError = (res, error) => res.status(error.status).json({
  code: error.code,
  message: error.message,
});

/**
 * Build the `requireAuth` middleware.
 *
 * `secret` is read once at construction. `verify` and `now` are injectable so the middleware is
 * testable without a clock or a real signing key.
 */
const createRequireAuth = ({ secret, verify = verifyDeviceSession, now = () => Date.now() } = {}) =>
  (req, res, next) => {
    if (!text(secret)) {
      // A missing secret must never degrade to "allow". It is a server fault, reported as one.
      return sendAuthError(res, AUTH_ERRORS.MISCONFIGURED);
    }

    const token = extractSessionToken(req);
    if (!token) return sendAuthError(res, AUTH_ERRORS.MISSING);

    const result = verify(token, secret, now());
    if (result.error) return sendAuthError(res, result.error);

    const substitution = rejectDeviceSessionSubstitution(result.claims, submittedIdentityFrom(req));
    if (substitution) return sendAuthError(res, substitution);

    req.auth = authContextFromClaims(result.claims);
    return next();
  };

/**
 * Restrict a route to given roles.
 *
 * Must be mounted after `requireAuth`; without `req.auth` it denies rather than assuming. A session
 * carrying no role claim is denied too — a token minted before A-3 proves who someone is but not
 * what they may do, and "unknown role" must not read as "any role".
 */
const requireRole = (...allowed) => {
  const permitted = allowed
    .flat()
    .map((role) => text(role).toUpperCase())
    .filter(Boolean);

  return (req, res, next) => {
    if (!req.auth) return sendAuthError(res, AUTH_ERRORS.MISSING);
    if (!req.auth.normalizedRole) return sendAuthError(res, AUTH_ERRORS.ROLE_UNKNOWN);
    if (permitted.length === 0) return sendAuthError(res, AUTH_ERRORS.ROLE_FORBIDDEN);
    if (!permitted.includes(req.auth.normalizedRole)) {
      return sendAuthError(res, AUTH_ERRORS.ROLE_FORBIDDEN);
    }
    return next();
  };
};

module.exports = {
  AUTH_ERRORS,
  AUTH_HEADER,
  LEGACY_SESSION_HEADER,
  authContextFromClaims,
  createRequireAuth,
  extractSessionToken,
  requireRole,
  submittedIdentityFrom,
};
