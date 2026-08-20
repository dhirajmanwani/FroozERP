/**
 * What the app should do about the signed session — offline, expiring, or refused.
 *
 * Auth-hardening A-3 gave `/login` a signed session token; A-4 will put `requireAuth` in front of
 * ~219 routes. That flips a switch: today almost nothing returns 401, and afterwards an expired or
 * absent session makes most of the app fail at once. Without a single place that decides what a
 * 401 means, every panel invents its own answer and the user gets a screen of broken tiles.
 *
 * ## The one distinction this module exists for
 *
 * **"The server refused my session" and "I could not reach the server" are different events.**
 * FroozERP is local-first: the desktop app is expected to run for days with no network, and
 * offline sign-in deliberately restores a *cached* user record whose token may already be stale
 * (`offlineSession.js` caches the whole user object, token included). If a network failure were
 * ever classified as "signed out", the app would tell a user with no internet that they have been
 * logged out, throw them at a login screen they cannot use, and strand the sale they were mid-way
 * through. That is worse than the outage.
 *
 * The boundary is drawn structurally, not by pattern-matching text: **a failure carries an HTTP
 * status only if a server answered it.** No status means no refusal was ever issued, so no amount
 * of "401" or "expired" in an error message can produce an authentication verdict here. The
 * `code`/message heuristics below only choose the *label* for a non-auth failure — they can never
 * cross the boundary. That mirrors how `syncClassification.js` already reads axios errors.
 *
 * ## Reading the token is a hint, never a decision
 *
 * The token is `v1.<base64url payload>.<hmac>`. The frontend holds no secret and must not pretend
 * to verify anything: `readSessionTokenPayload` decodes the payload **without checking the
 * signature**, so its claims are attacker-controlled in the general case and are used here for one
 * purpose only — deciding whether to warn the user early. Authorisation is the server's answer and
 * only the server's answer. The local clock can also be wrong (see `serverTime.js`, which tracks a
 * measured offset), so decisions taken from the payload are tagged `evidence: "LOCAL_CLOCK"` and
 * callers may treat them as softer than `evidence: "SERVER"`.
 *
 * ## Queued offline work is never the price of signing out
 *
 * The outbox lives in SQLite, not in React state, and nothing here or on the sign-out path touches
 * it: `App.jsx`'s logout button is `setUser(null)`, and `pushPendingOperations` releases operations
 * back to pending when a push throws (`syncService.js:377`). Every decision this module returns
 * therefore carries `discardQueuedWork: false`, asserted in the tests, so that a future "clean up
 * on sign-out" change has to argue with a failing test before it can delete a shop's sales.
 *
 * Pure by construction: no network, no React, no storage, no globals beyond a clock default.
 * Nothing here can weaken LOCAL_ONLY mode — it issues no calls at all, and an `APP_LOCAL_ONLY`
 * failure is classified as offline rather than as anything that would prompt a retry.
 */

/** Must match `TOKEN_VERSION` in `backend/deviceSession.js`; a different version is unreadable. */
export const SESSION_TOKEN_VERSION = "v1";

/** Mirrors `DEFAULT_TTL_SECONDS` in `backend/deviceSession.js`, for reporting only. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/**
 * How long before expiry the user is told. A 12h token issued at the start of a shift expires
 * mid-evening; fifteen minutes is enough warning to finish a sale and sign in again, and short
 * enough that the warning still means something when it appears.
 */
export const SESSION_EXPIRY_WARNING_SECONDS = 15 * 60;

export const SESSION_FAILURE_KINDS = Object.freeze({
  /** No failure was supplied. */
  NONE: "NONE",
  /** The server was never reached. Normal, and never an authentication verdict. */
  OFFLINE: "OFFLINE",
  /** The request failed before it left the client (a bug, not a server refusal). */
  REQUEST_FAILED: "REQUEST_FAILED",
  /** 401, no credential presented. */
  SESSION_MISSING: "SESSION_MISSING",
  /** 401 `DEVICE_SESSION_EXPIRED`. */
  SESSION_EXPIRED: "SESSION_EXPIRED",
  /** 401, credential present but not accepted. */
  SESSION_INVALID: "SESSION_INVALID",
  /** 403 `AUTH_ROLE_UNKNOWN` — verifies, but predates roles. Signing in again fixes it. */
  SESSION_OUTDATED: "SESSION_OUTDATED",
  /** 403 on grounds of role. Identity is established; the action is not permitted. */
  PERMISSION_DENIED: "PERMISSION_DENIED",
  /** 403 `DEVICE_SESSION_SUBSTITUTION_REJECTED` — submitted identity contradicts the token. */
  IDENTITY_CONFLICT: "IDENTITY_CONFLICT",
  /** 5xx, including `AUTH_NOT_CONFIGURED`. The server's fault, not the user's. */
  SERVER_FAULT: "SERVER_FAULT",
  /** Any other answered request. */
  OTHER: "OTHER",
});

export const SESSION_ACTIONS = Object.freeze({
  CONTINUE: "CONTINUE",
  WORK_OFFLINE: "WORK_OFFLINE",
  WARN_EXPIRING_SOON: "WARN_EXPIRING_SOON",
  RENEW_SILENTLY: "RENEW_SILENTLY",
  SIGN_IN_REQUIRED: "SIGN_IN_REQUIRED",
  BLOCKED_BY_PERMISSION: "BLOCKED_BY_PERMISSION",
  REPORT_ERROR: "REPORT_ERROR",
});

/**
 * Kinds that mean "the server does not know who you are".
 *
 * Deliberately excludes both 403 kinds that are about permission rather than identity. Being told
 * "you may not do that" is not being told "who are you", and answering it with a login prompt
 * teaches users that re-signing-in is how you get past a permission wall — it is not, and the
 * prompt would appear again on the next attempt.
 */
const AUTHENTICATION_KINDS = new Set([
  SESSION_FAILURE_KINDS.SESSION_MISSING,
  SESSION_FAILURE_KINDS.SESSION_EXPIRED,
  SESSION_FAILURE_KINDS.SESSION_INVALID,
  SESSION_FAILURE_KINDS.SESSION_OUTDATED,
]);

/**
 * Transport-level codes that mean the request never got an answer.
 *
 * `APP_LOCAL_ONLY` is in here because the Owner's LOCAL_ONLY policy blocks the call before it
 * leaves the device (`syncService.js` reports it as `lastFailureKind`); to the app that is
 * indistinguishable from being offline, and it must never read as a session problem.
 */
const TRANSPORT_FAILURE_CODES = new Set([
  "APP_LOCAL_ONLY",
  "BACKEND_UNREACHABLE",
  "CLOUD_UNAVAILABLE",
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ERR_INTERNET_DISCONNECTED",
  "ERR_NETWORK",
  "ETIMEDOUT",
  "NETWORK_ERROR",
  "TIMEOUT",
]);

// Widened past the equivalent regex in `syncClassification.js` because this module reads messages
// that module *produces* ("Cloud temporarily unavailable - sync paused until internet returns."),
// and a message that falls through to the non-offline branch would be reported to the user as a
// fault rather than as an outage.
/**
 * Codes `/login` itself returns when a sign-in *attempt* fails.
 *
 * `/login` is not behind `requireAuth` and answers a wrong password with **401
 * `INVALID_CREDENTIALS`** (`server.js:892`), plus 403s for a device awaiting approval. Those say
 * "this attempt did not work", not "your existing sign-in is over", and the login screen already
 * words them precisely. Left uncaught they would repaint a wrong-password message as "please sign
 * in again", which tells the user nothing. Callers should still keep the module off the login
 * screen entirely; this is the second line of defence, not the first.
 */
const LOGIN_ATTEMPT_CODES = new Set([
  "CLOUD_DEVICE_NOT_APPROVED",
  "DEVICE_DISABLED",
  "DEVICE_PENDING_APPROVAL",
  "DEVICE_REVOKED",
  "INVALID_CREDENTIALS",
]);

const OFFLINE_MESSAGE_PATTERN = /network|refused|failed to fetch|timed? ?out|unreachable|unavailable|offline|internet|disconnected|socket hang up|dns/i;

const text = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * A number, or `null` — with no coercion of things that are not numbers.
 *
 * `Number(null)`, `Number("")` and `Number([])` are all `0`, so a plain `Number.isFinite(Number(x))`
 * check turns a missing `expires_at` into "expired at the epoch" and signs the user out. Same
 * family of bug as the `??`-does-not-fall-through-on-`0` pitfall in CLAUDE.md.
 */
const finiteNumber = (value) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const decodeBase64Url = (value) => {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  if (typeof globalThis.atob !== "function") return null;
  const binary = globalThis.atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
};

/**
 * The token's claims, or `null`.
 *
 * **The signature is not checked and cannot be** — the device has no secret. Treat the result as
 * a display hint. Anything that gates access on it is a hole, because a user who edits their own
 * localStorage can put whatever they like in here.
 *
 * Never throws: a truncated, re-encoded or hand-edited token is an ordinary condition on a device
 * whose storage the user can reach, and a parse error thrown from a render path would take the
 * whole app down rather than the one panel.
 */
export const readSessionTokenPayload = (token) => {
  const parts = text(token).split(".");
  if (parts.length !== 3 || parts[0] !== SESSION_TOKEN_VERSION || !parts[1]) return null;
  try {
    const json = decodeBase64Url(parts[1]);
    if (!json) return null;
    const claims = JSON.parse(json);
    return claims && typeof claims === "object" && !Array.isArray(claims) ? claims : null;
  } catch {
    return null;
  }
};

const UNKNOWN_EXPIRY = (reason) => Object.freeze({
  status: "unknown",
  reason,
  known: false,
  issuedAtMs: null,
  expiresAtMs: null,
  secondsRemaining: null,
});

/**
 * How much life the token has left, according to the device clock.
 *
 * "unknown" is a first-class answer and the only safe one for a token we cannot read: an
 * unreadable token must produce "carry on and let the server rule", never a sign-out. Guessing
 * "expired" here would sign out every user the moment the token format changed.
 *
 * @param {string} token
 * @param {number} nowMs epoch ms; pass a server-corrected clock (`serverTime.js`) where one exists
 */
export const describeTokenExpiry = (token, nowMs = Date.now()) => {
  if (!text(token)) return UNKNOWN_EXPIRY("ABSENT");
  const claims = readSessionTokenPayload(token);
  if (!claims) {
    return UNKNOWN_EXPIRY(text(token).split(".")[0] === SESSION_TOKEN_VERSION ? "MALFORMED" : "UNSUPPORTED_VERSION");
  }
  const expiresAt = finiteNumber(claims.expires_at);
  if (expiresAt === null) return UNKNOWN_EXPIRY("NO_EXPIRY");
  const issuedAt = finiteNumber(claims.issued_at);
  const nowSeconds = Math.floor(Number(nowMs) / 1000);
  // `<=` matches `verifyDeviceSession`; a token that expires exactly now is refused there, so
  // treating it as still valid here would only produce a warning the server disagrees with.
  const secondsRemaining = expiresAt - nowSeconds;
  const status = secondsRemaining <= 0
    ? "expired"
    : secondsRemaining <= SESSION_EXPIRY_WARNING_SECONDS ? "expiring" : "active";
  return Object.freeze({
    status,
    reason: "",
    known: true,
    issuedAtMs: issuedAt === null ? null : issuedAt * 1000,
    expiresAtMs: expiresAt * 1000,
    secondsRemaining,
  });
};

/**
 * Everything a failure tells us, gathered from the several shapes this codebase throws.
 *
 * Accepts an axios error, a bare `{ status, code, message }`, a fetch `Response`, or a string.
 * `status` is read **only** from a real response — never parsed out of a message — because that
 * single fact is what separates "refused" from "unreachable".
 */
const normalizeFailure = (failure) => {
  if (failure === null || failure === undefined || failure === false) return null;
  if (typeof failure === "string") {
    return { status: null, code: "", serverMessage: "", message: failure };
  }
  if (typeof failure !== "object") return { status: null, code: "", serverMessage: "", message: String(failure) };

  const response = failure.response && typeof failure.response === "object" ? failure.response : null;
  const data = response && response.data && typeof response.data === "object" ? response.data : {};
  const statusSource = response ? response.status : failure.status;
  const status = Number.isFinite(Number(statusSource)) && Number(statusSource) > 0 ? Number(statusSource) : null;
  const serverMessage = text(data.message) || text(data.error) || text(failure.serverMessage);
  return {
    status,
    code: text(data.code) || text(failure.code) || text(failure.kind),
    serverMessage,
    message: serverMessage || text(failure.message) || "",
  };
};

const classifyAnsweredFailure = ({ status, code }) => {
  if (LOGIN_ATTEMPT_CODES.has(code)) return SESSION_FAILURE_KINDS.OTHER;
  if (status === 401) {
    if (code === "DEVICE_SESSION_EXPIRED") return SESSION_FAILURE_KINDS.SESSION_EXPIRED;
    if (code === "AUTH_SESSION_REQUIRED" || code === "DEVICE_SESSION_REQUIRED") {
      return SESSION_FAILURE_KINDS.SESSION_MISSING;
    }
    // `DEVICE_SESSION_INVALID`, and any other 401 whether coded or not: the credential was seen and
    // rejected. Signing in again is the only remedy, so this errs towards the useful outcome
    // rather than towards "unknown".
    return SESSION_FAILURE_KINDS.SESSION_INVALID;
  }
  if (status === 403) {
    // The server's own message for this one says "Sign in again to continue" — the token verifies
    // but predates the role claim, so a fresh sign-in genuinely fixes it. It is the sole 403 that
    // is about identity rather than permission.
    if (code === "AUTH_ROLE_UNKNOWN") return SESSION_FAILURE_KINDS.SESSION_OUTDATED;
    if (code === "DEVICE_SESSION_SUBSTITUTION_REJECTED") return SESSION_FAILURE_KINDS.IDENTITY_CONFLICT;
    return SESSION_FAILURE_KINDS.PERMISSION_DENIED;
  }
  if (status >= 500) return SESSION_FAILURE_KINDS.SERVER_FAULT;
  return SESSION_FAILURE_KINDS.OTHER;
};

/**
 * Classify a failed request.
 *
 * @returns {{kind: string, status: number|null, code: string, serverMessage: string,
 *   authentication: boolean, offline: boolean, answered: boolean}}
 *   `authentication` is true only for the four kinds that mean the server does not know who the
 *   caller is. `offline` is true only when nothing answered. The two are never both true.
 */
export const classifySessionFailure = (failure) => {
  const normalized = normalizeFailure(failure);
  if (!normalized) {
    return {
      kind: SESSION_FAILURE_KINDS.NONE,
      status: null,
      code: "",
      serverMessage: "",
      authentication: false,
      offline: false,
      answered: false,
    };
  }

  const { status, code, serverMessage, message } = normalized;
  // No status means nothing ever answered, so nothing ever refused us. This is the boundary; the
  // heuristics below only pick a label on the non-auth side of it and can never cross back.
  const kind = status === null
    ? (TRANSPORT_FAILURE_CODES.has(code.toUpperCase()) || OFFLINE_MESSAGE_PATTERN.test(message)
      ? SESSION_FAILURE_KINDS.OFFLINE
      : SESSION_FAILURE_KINDS.REQUEST_FAILED)
    : classifyAnsweredFailure({ status, code });

  return {
    kind,
    status,
    code,
    serverMessage,
    authentication: AUTHENTICATION_KINDS.has(kind),
    offline: kind === SESSION_FAILURE_KINDS.OFFLINE,
    answered: status !== null,
  };
};

/** True only when the server itself refused the caller's identity. */
export const isAuthenticationFailure = (failure) => classifySessionFailure(failure).authentication;

/** True when the request never reached a server — including LOCAL_ONLY, which blocks it locally. */
export const isOfflineFailure = (failure) => classifySessionFailure(failure).offline;

/**
 * A duration a shopkeeper would say out loud. Precision here helps nobody and "in 743 seconds"
 * reads as a machine talking.
 */
export const describeRemainingTime = (seconds) => {
  const value = finiteNumber(seconds);
  if (value === null || value < 90) return "less than a minute";
  if (value < 3600) return `about ${Math.round(value / 60)} minutes`;
  const hours = Math.round(value / 3600);
  return hours === 1 ? "about an hour" : `about ${hours} hours`;
};

/**
 * Plain-language wording.
 *
 * No error codes, no status numbers, no "token", no "session" — the maintainer asked for language
 * a shop user reads once and acts on. Every message that follows a sign-out also says the local
 * work is safe, because the first thing a user fears when thrown to a login screen mid-shift is
 * that the morning's sales went with it. They did not: the outbox is in SQLite and untouched.
 */
const MESSAGES = Object.freeze({
  OFFLINE: "You are working offline. Everything you do is saved on this device and will be sent to the main system when the connection comes back.",
  SIGN_IN_ENDED: "Your sign-in has ended. Please sign in again to continue. Everything saved on this device is safe.",
  SIGN_IN_NEEDED: "Please sign in again to continue. Everything saved on this device is safe.",
  PERMISSION: "Your account does not have permission to do this. Ask the owner if you need access.",
  IDENTITY: "This device is set up for a different account than this action expects. Ask the owner for help before trying again.",
  SERVER_FAULT: "Something went wrong at the other end. Please try again in a moment.",
  REQUEST_FAILED: "That did not go through. Please try again.",
});

const decision = (fields) => Object.freeze({
  status: null,
  code: "",
  serverMessage: "",
  message: "",
  requiresSignIn: false,
  offline: false,
  evidence: "NONE",
  // Never true, in any branch. Signing out is a change of identity, not a reason to destroy a
  // shop's unsent sales; the tests assert this across every outcome.
  discardQueuedWork: false,
  ...fields,
});

/**
 * Decide what the app should do.
 *
 * @param {object} input
 * @param {string} [input.token] the current `device_session_token`
 * @param {*} [input.failure] the failure to react to, in any of the shapes above; omit for a
 *   periodic check with nothing having gone wrong
 * @param {number} [input.nowMs] epoch ms
 * @param {boolean} [input.online] the app's own reachability flag (`offlineMode` inverted)
 * @param {boolean} [input.canRenew] whether a silent renewal path exists. **Today it does not** —
 *   A-3 shipped no refresh route, so `/login` with a password is the only way to get a token and
 *   this stays false until one exists. It is a parameter rather than a `false` constant so that
 *   adding the route later is a wiring change, not a rewrite of this decision.
 * @returns {object} frozen decision: `action`, `kind`, `message`, `requiresSignIn`,
 *   `discardQueuedWork` (always false), `expiry`, `evidence`.
 */
export const resolveSessionAction = ({
  token = "",
  failure = null,
  nowMs = Date.now(),
  online = true,
  canRenew = false,
} = {}) => {
  const expiry = describeTokenExpiry(token, nowMs);
  const classified = classifySessionFailure(failure);
  const base = {
    kind: classified.kind,
    status: classified.status,
    code: classified.code,
    serverMessage: classified.serverMessage,
    expiry,
    secondsRemaining: expiry.secondsRemaining,
  };

  if (classified.authentication) {
    // A refusal we can point at beats every local guess, including a stale `online: false` flag —
    // the branch server can answer while the internet is down, and it just told us who we are not.
    return decision({
      ...base,
      action: SESSION_ACTIONS.SIGN_IN_REQUIRED,
      requiresSignIn: true,
      evidence: "SERVER",
      message: classified.kind === SESSION_FAILURE_KINDS.SESSION_EXPIRED
        ? MESSAGES.SIGN_IN_ENDED
        : MESSAGES.SIGN_IN_NEEDED,
    });
  }

  if (classified.kind === SESSION_FAILURE_KINDS.PERMISSION_DENIED
    || classified.kind === SESSION_FAILURE_KINDS.IDENTITY_CONFLICT) {
    return decision({
      ...base,
      action: SESSION_ACTIONS.BLOCKED_BY_PERMISSION,
      evidence: "SERVER",
      message: classified.kind === SESSION_FAILURE_KINDS.IDENTITY_CONFLICT
        ? MESSAGES.IDENTITY
        : MESSAGES.PERMISSION,
    });
  }

  if (classified.offline) {
    return decision({ ...base, action: SESSION_ACTIONS.WORK_OFFLINE, offline: true, message: MESSAGES.OFFLINE });
  }

  if (classified.kind === SESSION_FAILURE_KINDS.SERVER_FAULT
    || classified.kind === SESSION_FAILURE_KINDS.REQUEST_FAILED
    || classified.kind === SESSION_FAILURE_KINDS.OTHER) {
    return decision({
      ...base,
      action: SESSION_ACTIONS.REPORT_ERROR,
      evidence: classified.answered ? "SERVER" : "NONE",
      message: classified.kind === SESSION_FAILURE_KINDS.SERVER_FAULT
        ? MESSAGES.SERVER_FAULT
        : MESSAGES.REQUEST_FAILED,
    });
  }

  // Nothing failed. From here the only evidence is the unverified payload and the device clock.
  if (online === false) {
    // The load-bearing branch. An expired token on an offline device is expected — offline sign-in
    // restores a cached user record, token and all — and it harms nothing, because no request is
    // going anywhere to be refused. Signing the user out here would strand them with a login form
    // that cannot reach a server.
    return decision({ ...base, action: SESSION_ACTIONS.WORK_OFFLINE, offline: true, message: MESSAGES.OFFLINE });
  }

  if (expiry.status === "expired") {
    // Pre-empting the wave of 401s A-4 will produce: one clear prompt beats twenty broken panels.
    // Tagged LOCAL_CLOCK because a device whose clock has run fast would land here wrongly; a
    // cautious caller can wait for the server's own refusal instead.
    return decision({
      ...base,
      kind: SESSION_FAILURE_KINDS.SESSION_EXPIRED,
      action: SESSION_ACTIONS.SIGN_IN_REQUIRED,
      requiresSignIn: true,
      evidence: "LOCAL_CLOCK",
      message: MESSAGES.SIGN_IN_ENDED,
    });
  }

  if (expiry.status === "expiring") {
    return canRenew
      ? decision({ ...base, action: SESSION_ACTIONS.RENEW_SILENTLY, evidence: "LOCAL_CLOCK" })
      : decision({
        ...base,
        action: SESSION_ACTIONS.WARN_EXPIRING_SOON,
        evidence: "LOCAL_CLOCK",
        message: `Your sign-in ends in ${describeRemainingTime(expiry.secondsRemaining)}. Please sign in again soon so your work is not interrupted.`,
      });
  }

  return decision({ ...base, action: SESSION_ACTIONS.CONTINUE });
};
