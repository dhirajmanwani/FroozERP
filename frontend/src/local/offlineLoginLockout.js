/**
 * Failed-attempt lockout for **offline** sign-in.
 *
 * ## Why the backend's lockout does not cover this
 *
 * A-5 put an escalating lock on `/login` and `/bootstrap/first-owner-device`, both of which live in
 * `backend/server.js` — the **cloud** backend. A desktop device signing in offline never reaches
 * it: `verifyOfflineSessionRecord` checks the password against a cached PBKDF2 verifier in the
 * local database, entirely on the device. So the counter A-5 built was never incremented by an
 * offline attempt, and offline guessing stayed unlimited.
 *
 * That is the case that matters most for a shop. The cloud is behind a network; the till is on a
 * counter, and the realistic attacker is someone who has the machine for ten minutes.
 *
 * ## What this is honestly worth
 *
 * **This is a speed bump, not a wall, and it should not be described as one.** The state lives in
 * `localStorage`, which anyone who can open developer tools can clear. Someone who takes the
 * machine away can also copy the database file and attack the verifier offline, where no counter
 * of any kind can reach them.
 *
 * What it does stop is the realistic case: a person with the till for a few minutes trying the
 * passwords they can think of. The real defences against a stolen machine are full-disk encryption
 * and the PBKDF2 iteration count on the stored verifier, both of which are elsewhere. This closes
 * the gap where *nothing at all* pushed back.
 *
 * The policy deliberately mirrors `backend/loginLockout.js` so the two behave the same. A device
 * that is stricter offline than online teaches people that being offline is broken.
 */

const STORAGE_KEY = "froozerp_offline_login_attempts_v1";

/** Failures within this window count as one streak. Matches the backend. */
export const STREAK_WINDOW_MS = 15 * 60 * 1000;

/** Failures allowed before any lock. Matches the backend. */
export const FREE_ATTEMPTS = 4;

/** Escalating lock durations, capped. Matches the backend. */
export const LOCK_STEPS_MS = Object.freeze([
  60 * 1000,
  2 * 60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
]);

const storage = () => {
  try {
    return globalThis.localStorage || null;
  } catch {
    // A locked-down webview can throw on access alone.
    return null;
  }
};

/**
 * Attempts are tracked per username, so one person's mistakes never lock out a colleague sharing
 * the till. The key is lowercased because usernames are matched case-insensitively at sign-in, and
 * a counter that treated "Owner" and "owner" as different accounts would be trivially reset.
 */
const normalizeUser = (username) => String(username || "").trim().toLowerCase();

const readAll = () => {
  const store = storage();
  if (!store) return {};
  try {
    const parsed = JSON.parse(store.getItem(STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const writeAll = (value) => {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Storage full or disabled. The sign-in must still work; this is a speed bump, not a gate.
  }
};

/**
 * Is offline sign-in locked for this user right now?
 *
 * @returns {{locked: boolean, remainingMs: number}}
 */
export const readOfflineLockState = ({ username, nowMs = Date.now() } = {}) => {
  const entry = readAll()[normalizeUser(username)];
  const lockedUntil = Number(entry?.lockedUntilMs);
  if (!Number.isFinite(lockedUntil) || lockedUntil <= nowMs) return { locked: false, remainingMs: 0 };
  return { locked: true, remainingMs: lockedUntil - nowMs };
};

/**
 * Record a failed offline attempt and return the resulting lock, if any.
 *
 * @returns {{failedAttempts: number, locked: boolean, remainingMs: number}}
 */
export const registerOfflineFailure = ({ username, nowMs = Date.now() } = {}) => {
  const key = normalizeUser(username);
  const all = readAll();
  const entry = all[key] || {};
  const lastFailedAt = Number(entry.lastFailedAtMs);
  // A failure outside the window is not part of this burst, so the streak restarts. Without this,
  // four typos spread across months would meet a fifth and lock an untouched account.
  const withinWindow = Number.isFinite(lastFailedAt)
    && nowMs - lastFailedAt <= STREAK_WINDOW_MS
    && nowMs >= lastFailedAt;
  const previous = withinWindow ? Math.max(0, Math.floor(Number(entry.failedAttempts) || 0)) : 0;
  const streak = previous + 1;

  let lockedUntilMs = null;
  if (streak > FREE_ATTEMPTS) {
    const stepIndex = Math.min(streak - FREE_ATTEMPTS - 1, LOCK_STEPS_MS.length - 1);
    lockedUntilMs = nowMs + LOCK_STEPS_MS[stepIndex];
  }
  all[key] = { failedAttempts: streak, lastFailedAtMs: nowMs, lockedUntilMs };
  writeAll(all);
  return {
    failedAttempts: streak,
    locked: lockedUntilMs !== null,
    remainingMs: lockedUntilMs === null ? 0 : lockedUntilMs - nowMs,
  };
};

/** A successful sign-in ends the streak, or the counter would only ever climb. */
export const clearOfflineFailures = ({ username } = {}) => {
  const key = normalizeUser(username);
  const all = readAll();
  if (!(key in all)) return;
  delete all[key];
  writeAll(all);
};

/**
 * The wait, rounded up and in plain words. Rounding down would tell someone to retry a second
 * before the lock lifts, earning them another failure.
 */
export const describeOfflineLockRemaining = (remainingMs) => {
  const remaining = Number(remainingMs);
  if (!Number.isFinite(remaining) || remaining <= 0) return "a moment";
  const minutes = Math.ceil(remaining / 60000);
  if (minutes <= 1) return "about a minute";
  if (minutes < 60) return `about ${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? "about an hour" : `about ${hours} hours`;
};

/** States the wait, never the policy — naming the threshold hands an attacker the tuning. */
export const offlineLockMessage = (remainingMs) =>
  `Too many failed sign-in attempts on this device. Try again in ${describeOfflineLockRemaining(remainingMs)}.`;
