"use strict";

/**
 * Failed-login lockout — auth-hardening A-5.
 *
 * ## What was already there, and why it never fired
 *
 * `users.locked_until` has existed for a long time, and `/login` already refuses a login while it
 * is in the future. **Nothing ever set it.** The only statement touching the column *clears* it, so
 * the guard was unreachable: a column, a check, and no path between them. Password guessing against
 * `/login` was therefore unlimited, which is the reason `/login` cannot be exposed to the internet
 * even now that A-1 hashes properly.
 *
 * This module is the missing half. It is pure — no database, no clock of its own — so the policy
 * can be tested exhaustively, which matters because every branch of it is a decision about locking
 * a real shopkeeper out of their own till.
 *
 * ## The shape of the policy, and why
 *
 * **A short streak is a typo; a long one is an attack.** Locking on the first mistake would make
 * the product hostile — people mistype passwords at a counter, in a hurry, on a keyboard they are
 * not looking at. So the first few failures cost nothing, and the delay then escalates steeply:
 * cheap for a human who fat-fingered their password twice, brutally expensive for a script.
 *
 * **The streak decays.** Without this, four failures spread across a year would eventually meet a
 * fifth and lock an account that has never been attacked. A failure that is not part of a burst is
 * not evidence of anything, so failures older than the decay window do not count.
 *
 * **A lock refuses the correct password too.** That is the whole point: if the right password
 * lifted the lock early, an attacker who guessed it would never notice the lock existed.
 *
 * **The lock expires by itself.** A permanent lock needing an administrator turns a nuisance attack
 * into a denial of service against a shop that may have no administrator awake.
 */

/**
 * Failures within this window count as one streak. Fifteen minutes is long enough to cover a
 * genuine burst of guessing and short enough that yesterday's typo is forgotten.
 */
const STREAK_WINDOW_MS = 15 * 60 * 1000;

/** Failures allowed before any lock at all. Below this, a mistake costs nothing. */
const FREE_ATTEMPTS = 4;

/**
 * Escalating lock durations, indexed by how far past `FREE_ATTEMPTS` the streak has gone.
 *
 * The curve matters more than the numbers: one minute is barely noticeable to a person who
 * mistyped, and the last step makes an automated attempt cost an hour per ten guesses. The final
 * value is the cap — the sequence deliberately stops rather than growing without bound, because an
 * unbounded lock is a denial of service dressed as security.
 */
const LOCK_STEPS_MS = Object.freeze([
  60 * 1000,        // 5th failure  — 1 minute
  2 * 60 * 1000,    // 6th          — 2 minutes
  5 * 60 * 1000,    // 7th          — 5 minutes
  15 * 60 * 1000,   // 8th          — 15 minutes
  30 * 60 * 1000,   // 9th          — 30 minutes
  60 * 60 * 1000,   // 10th onwards — 1 hour, capped
]);

const finiteNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Epoch milliseconds from a Date, an ISO string, or a number. `null` when unusable. */
const toEpochMs = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
};

/**
 * Is this account locked right now?
 *
 * Called *before* the password is checked, so a locked account is refused whatever it types.
 *
 * @returns {{locked: boolean, unlocksAtMs: number|null, remainingMs: number}}
 */
const resolveLockState = ({ lockedUntil, nowMs = Date.now() } = {}) => {
  const unlocksAtMs = toEpochMs(lockedUntil);
  if (unlocksAtMs === null || unlocksAtMs <= nowMs) {
    return { locked: false, unlocksAtMs: null, remainingMs: 0 };
  }
  return { locked: true, unlocksAtMs, remainingMs: unlocksAtMs - nowMs };
};

/**
 * The account's new state after a failed password attempt.
 *
 * @param {object} input
 * @param {number} input.failedAttempts  the stored streak length before this attempt
 * @param {*} input.lastFailedAt         when the previous failure happened
 * @param {number} input.nowMs
 * @returns {{failedAttempts: number, lockedUntilMs: number|null, lockDurationMs: number}}
 *   `lockedUntilMs` is null when this failure does not warrant a lock. `failedAttempts` is the
 *   value to store, already accounting for a decayed streak.
 */
const registerFailedAttempt = ({ failedAttempts, lastFailedAt, nowMs = Date.now() } = {}) => {
  const previousMs = toEpochMs(lastFailedAt);
  const stored = Math.max(0, Math.floor(finiteNumber(failedAttempts) ?? 0));
  // A failure outside the window is not part of this burst, so the streak starts again at 1. This
  // is what stops four typos across a year from meeting a fifth and locking an untouched account.
  const withinWindow = previousMs !== null && nowMs - previousMs <= STREAK_WINDOW_MS && nowMs >= previousMs;
  const streak = (withinWindow ? stored : 0) + 1;

  if (streak <= FREE_ATTEMPTS) {
    return { failedAttempts: streak, lockedUntilMs: null, lockDurationMs: 0 };
  }
  const stepIndex = Math.min(streak - FREE_ATTEMPTS - 1, LOCK_STEPS_MS.length - 1);
  const lockDurationMs = LOCK_STEPS_MS[stepIndex];
  return { failedAttempts: streak, lockedUntilMs: nowMs + lockDurationMs, lockDurationMs };
};

/**
 * How long is left, in words a shopkeeper would use.
 *
 * Deliberately coarse and rounded *up*: telling someone "try again in 1 minute" when 61 seconds
 * remain earns a second failed attempt and their justified annoyance.
 */
const describeLockRemaining = (remainingMs) => {
  const remaining = finiteNumber(remainingMs) ?? 0;
  if (remaining <= 0) return "a moment";
  const minutes = Math.ceil(remaining / 60000);
  if (minutes <= 1) return "about a minute";
  if (minutes < 60) return `about ${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? "about an hour" : `about ${hours} hours`;
};

/**
 * The message shown to whoever is at the keyboard.
 *
 * It states the wait rather than the policy. Naming the threshold ("locked after 5 attempts") hands
 * an attacker the tuning for free, and tells a legitimate user nothing they can act on.
 */
const lockMessage = (remainingMs) =>
  `Too many failed sign-in attempts. Try again in ${describeLockRemaining(remainingMs)}.`;

module.exports = {
  FREE_ATTEMPTS,
  LOCK_STEPS_MS,
  STREAK_WINDOW_MS,
  describeLockRemaining,
  lockMessage,
  registerFailedAttempt,
  resolveLockState,
};
