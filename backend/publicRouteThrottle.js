"use strict";

/**
 * A-6 Gate 3.2 — attempt limits for the routes that answer before anyone has signed in.
 *
 * Three routes on the public allow-list take a guessable value and say whether it was right:
 * `/api/auth/device-bootstrap-status` is a device-id oracle, `/devices/activate` accepts a 48-bit
 * activation code, and `/auth/recovery/send-otp` will post a message to a real person's phone on
 * demand. Each is defensible with a rate limit and indefensible without one — unlimited guessing
 * turns a 48-bit secret into a matter of time, and an unlimited OTP sender into a way to spend the
 * shop's SMS budget and annoy its customers.
 *
 * ## Why this is not the login lockout
 *
 * `loginLockout.js` locks an *account*, which is right when a username identifies the target. These
 * routes have no account to lock: the caller is anonymous, and locking the thing they are guessing
 * would let anyone deny service to a device by guessing at it. So the limit is per caller, over a
 * short window, and it delays rather than locks — enough to make guessing impractical without
 * giving a stranger a way to shut a real device out.
 *
 * ## What it depends on
 *
 * `req.ip`, which is only meaningful because `trust proxy` is set for the hosted deployment
 * (Gate 2.4). Without that every request behind Railway shares one address, and a per-caller limit
 * becomes a global one — one guesser would lock out every real user. The two changes are a pair.
 *
 * In-memory on purpose. A shared store is the right answer for several instances, and this
 * deployment is one; a Redis dependency added now would be a moving part standing between the shop
 * and its own data, for a benefit it cannot yet use. Recorded as a limit, not hidden.
 */

/** Attempts allowed inside the window before a caller is asked to wait. */
const DEFAULT_LIMIT = 10;

/** The window, and also how long a blocked caller waits. */
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;

/**
 * How many entries to keep before dropping the oldest.
 *
 * An unbounded map keyed by caller address is a memory leak with an attacker holding the tap. The
 * cap is far above any real traffic this shop will see, so an honest caller is never evicted.
 */
const MAX_TRACKED_CALLERS = 10000;

const buckets = new Map();

const prune = (nowMs) => {
  for (const [key, entry] of buckets) {
    if (entry.resetAt <= nowMs) buckets.delete(key);
  }
  if (buckets.size <= MAX_TRACKED_CALLERS) return;
  // Oldest first: Map preserves insertion order, and an entry that has been here longest is the one
  // least likely to be mid-attempt.
  const excess = buckets.size - MAX_TRACKED_CALLERS;
  let dropped = 0;
  for (const key of buckets.keys()) {
    buckets.delete(key);
    if (++dropped >= excess) break;
  }
};

/**
 * Record an attempt and say whether it may proceed.
 *
 * @returns {{allowed: boolean, remaining: number, retryAfterSeconds: number}}
 */
const registerAttempt = ({
  key,
  limit = DEFAULT_LIMIT,
  windowMs = DEFAULT_WINDOW_MS,
  nowMs = Date.now(),
} = {}) => {
  const caller = String(key || "").trim() || "unknown";
  prune(nowMs);
  const entry = buckets.get(caller);
  if (!entry || entry.resetAt <= nowMs) {
    buckets.set(caller, { count: 1, resetAt: nowMs + windowMs });
    return { allowed: true, remaining: Math.max(0, limit - 1), retryAfterSeconds: 0 };
  }
  entry.count += 1;
  if (entry.count > limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - nowMs) / 1000)),
    };
  }
  return { allowed: true, remaining: Math.max(0, limit - entry.count), retryAfterSeconds: 0 };
};

/**
 * The caller, for limiting purposes.
 *
 * Address only. Including anything the caller supplies — a device id, a username — would let them
 * pick a fresh bucket for every guess, which is the same as having no limit at all.
 */
const callerKey = (req, scope = "") => `${scope}:${String(req?.ip || "unknown")}`;

/** Reset between tests. Never called by the server. */
const resetThrottle = () => buckets.clear();

const throttleMessage = (retryAfterSeconds) => {
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return minutes <= 1
    ? "Too many attempts. Wait a minute and try again."
    : `Too many attempts. Wait about ${minutes} minutes and try again.`;
};

module.exports = {
  DEFAULT_LIMIT,
  DEFAULT_WINDOW_MS,
  MAX_TRACKED_CALLERS,
  callerKey,
  registerAttempt,
  resetThrottle,
  throttleMessage,
};
