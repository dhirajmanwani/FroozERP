"use strict";

/**
 * The cut-over freeze: a hosted backend that stays up and accepts nothing.
 *
 * ## Why a switch, and why 503
 *
 * Moving the cloud means a window in which the old database must take no more writes, while the
 * counters keep selling. The obvious ways to stop writes are the wrong ones:
 *
 * - Removing the old domain or stopping the service makes every request answer **404** (or fail
 *   DNS). A 404 on the offline-purchase replay path is classified as a business rejection
 *   (`frontend/src/local/syncService.js`, `sessionExpiry.js` maps 404 to OTHER), so queued GRNs are
 *   marked `failed` and leave the automatic queue -- the books stop agreeing and nothing retries.
 * - Leaving it up means a counter still on the old build keeps writing into a database that is
 *   being copied.
 *
 * A **503** is classified as a server fault: the outbox entry is released back to pending and
 * retried with backoff, which is exactly "hold these until the new cloud is ready".
 *
 * ## What stays answered
 *
 * `GET /api/health`, `/health`, `/api/time` and `/api/version` keep answering **200**, so the
 * platform's health check passes and the frozen deployment actually goes live -- a freeze that fails
 * its own health check would be rolled back by the platform and freeze nothing. They report
 * `status: "frozen"` instead of `"ok"`, and every client requires `status === "ok"` before it calls
 * the cloud reachable, so counters treat a frozen cloud as offline and queue locally.
 *
 * Switched by `FROOZERP_CLOUD_FROZEN=true` and nothing else. Pure, so the route table is tested.
 */

const FROZEN_STATUS = "frozen";

/** Routes that answer while frozen. GET (and HEAD, which Express answers from GET) only. */
const FROZEN_EXEMPT_PATHS = Object.freeze(["/api/health", "/health", "/api/time", "/api/version"]);

const FROZEN_RESPONSE = Object.freeze({
  code: "CLOUD_UNAVAILABLE",
  failure_kind: "CLOUD_UNAVAILABLE",
  cloud_connected: false,
  cloud_frozen: true,
  message: "The FroozERP cloud is paused for maintenance. Work continues on this device and syncs when the cloud is back.",
});

/** Retry hint, in seconds, for clients that honour `Retry-After`. */
const FROZEN_RETRY_AFTER_SECONDS = 300;

/**
 * `{ frozen, warning }`. Only the literal `true` (any case) freezes. Anything else that is set is
 * reported as a warning rather than guessed at, because during a cut-over the operator must be able
 * to read from `/api/health` whether the freeze took, not infer it.
 */
const readCloudFreeze = (env = {}) => {
  const raw = String(env.FROOZERP_CLOUD_FROZEN ?? "").trim();
  if (/^true$/i.test(raw)) return { frozen: true, warning: "" };
  if (!raw || /^false$/i.test(raw)) return { frozen: false, warning: "" };
  return {
    frozen: false,
    warning: `FROOZERP_CLOUD_FROZEN is "${raw}", which is neither true nor false; the cloud is NOT frozen.`,
  };
};

const normalizePath = (value) => {
  const text = String(value || "");
  return text.length > 1 ? text.replace(/\/+$/, "") || "/" : text;
};

/** True when a request may pass through a frozen backend. */
const isFrozenExempt = ({ method = "GET", path = "" } = {}) => {
  const verb = String(method).toUpperCase();
  if (verb !== "GET" && verb !== "HEAD") return false;
  return FROZEN_EXEMPT_PATHS.includes(normalizePath(path));
};

/** Express middleware. A no-op unless `frozen`. */
const createCloudFreezeMiddleware = ({ frozen }) => (req, res, next) => {
  if (!frozen || isFrozenExempt({ method: req.method, path: req.path })) return next();
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Retry-After", String(FROZEN_RETRY_AFTER_SECONDS));
  return res.status(503).json(FROZEN_RESPONSE);
};

/** The status field the health, time and version routes report. */
const healthStatus = (frozen) => (frozen ? FROZEN_STATUS : "ok");

module.exports = {
  FROZEN_EXEMPT_PATHS,
  FROZEN_RESPONSE,
  FROZEN_RETRY_AFTER_SECONDS,
  FROZEN_STATUS,
  createCloudFreezeMiddleware,
  healthStatus,
  isFrozenExempt,
  readCloudFreeze,
};
