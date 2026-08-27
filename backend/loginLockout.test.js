"use strict";

/**
 * Every branch here is a decision about locking a real shopkeeper out of their own till, so the
 * tests are written from both sides: an attacker must be slowed to uselessness, and a person who
 * mistyped their password must barely notice.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FREE_ATTEMPTS,
  LOCK_STEPS_MS,
  STREAK_WINDOW_MS,
  describeLockRemaining,
  lockMessage,
  registerFailedAttempt,
  resolveLockState,
} = require("./loginLockout");

const NOW = Date.parse("2026-08-20T12:00:00.000Z");

/** Drive N consecutive failures, each one second after the last. */
const burst = (count, startMs = NOW) => {
  let state = { failedAttempts: 0, lastFailedAt: null };
  let last = null;
  for (let i = 0; i < count; i += 1) {
    const at = startMs + i * 1000;
    last = registerFailedAttempt({ ...state, nowMs: at });
    state = { failedAttempts: last.failedAttempts, lastFailedAt: at };
  }
  return last;
};

// ---------------------------------------------------------------------------------------------
// The property the stage exists for
// ---------------------------------------------------------------------------------------------

test("guessing is eventually stopped", () => {
  // Before A-5 nothing ever set locked_until, so /login accepted unlimited guesses. If this fails,
  // password guessing is unlimited again.
  const result = burst(FREE_ATTEMPTS + 1);
  assert.notEqual(result.lockedUntilMs, null, "a sustained streak must produce a lock");
  assert.ok(result.lockDurationMs > 0);
});

test("a locked account refuses the correct password too", () => {
  // The whole point of a lock. If the right password lifted it early, an attacker who guessed it
  // would never learn the lock existed — and the lock would protect nothing at the only moment it
  // mattered. The check runs on `locked_until` alone and never sees the password.
  const state = resolveLockState({ lockedUntil: NOW + 60_000, nowMs: NOW });
  assert.equal(state.locked, true);
  assert.equal(state.remainingMs, 60_000);
});

test("the lock expires on its own", () => {
  // A lock needing an administrator turns a nuisance into a denial of service against a shop that
  // may have nobody awake to unlock it.
  assert.equal(resolveLockState({ lockedUntil: NOW - 1, nowMs: NOW }).locked, false);
  assert.equal(resolveLockState({ lockedUntil: NOW, nowMs: NOW }).locked, false, "expiry is not inclusive");
});

// ---------------------------------------------------------------------------------------------
// The person who simply mistyped
// ---------------------------------------------------------------------------------------------

test("the first few mistakes cost nothing", () => {
  // People mistype passwords at a counter, in a hurry, on a keyboard they are not looking at.
  for (let attempts = 1; attempts <= FREE_ATTEMPTS; attempts += 1) {
    const result = burst(attempts);
    assert.equal(result.lockedUntilMs, null, `${attempts} failures must not lock`);
    assert.equal(result.failedAttempts, attempts);
  }
});

test("the first lock is short enough to wait out", () => {
  const result = burst(FREE_ATTEMPTS + 1);
  assert.ok(result.lockDurationMs <= 60_000, "the first lock must be about a minute, not an hour");
});

test("an old failure is forgotten rather than counted", () => {
  // Without decay, four typos spread across a year would meet a fifth and lock an account that has
  // never been attacked once.
  const result = registerFailedAttempt({
    failedAttempts: FREE_ATTEMPTS,
    lastFailedAt: NOW - STREAK_WINDOW_MS - 1,
    nowMs: NOW,
  });
  assert.equal(result.failedAttempts, 1, "the streak restarts");
  assert.equal(result.lockedUntilMs, null);
});

test("a failure just inside the window still counts", () => {
  const result = registerFailedAttempt({
    failedAttempts: FREE_ATTEMPTS,
    lastFailedAt: NOW - STREAK_WINDOW_MS,
    nowMs: NOW,
  });
  assert.equal(result.failedAttempts, FREE_ATTEMPTS + 1);
  assert.notEqual(result.lockedUntilMs, null);
});

// ---------------------------------------------------------------------------------------------
// The attacker
// ---------------------------------------------------------------------------------------------

test("each further failure costs more than the last, up to a cap", () => {
  // Cheap for a human, brutally expensive for a script — but bounded, because an unbounded lock is
  // a denial of service dressed as security.
  const durations = [];
  for (let i = 1; i <= LOCK_STEPS_MS.length + 3; i += 1) {
    durations.push(burst(FREE_ATTEMPTS + i).lockDurationMs);
  }
  for (let i = 1; i < LOCK_STEPS_MS.length; i += 1) {
    assert.ok(durations[i] > durations[i - 1], `step ${i} must be longer than step ${i - 1}`);
  }
  const cap = LOCK_STEPS_MS[LOCK_STEPS_MS.length - 1];
  for (const duration of durations.slice(LOCK_STEPS_MS.length - 1)) {
    assert.equal(duration, cap, "the escalation must stop at the cap, not grow without bound");
  }
});

test("sustained guessing is slowed to uselessness", () => {
  // The measure that matters: what an attacker gets per hour once the escalation is in force.
  const tenth = burst(FREE_ATTEMPTS + 6);
  assert.ok(tenth.lockDurationMs >= 60 * 60 * 1000, "ten failures should cost an hour");
});

// ---------------------------------------------------------------------------------------------
// Inputs the database will actually hand this
// ---------------------------------------------------------------------------------------------

test("timestamps arrive as Date, ISO string or epoch, and all behave the same", () => {
  // node-postgres returns a Date for TIMESTAMP; an ISO string survives JSON; tests use numbers.
  const at = NOW + 60_000;
  for (const value of [new Date(at), new Date(at).toISOString(), at]) {
    assert.equal(resolveLockState({ lockedUntil: value, nowMs: NOW }).locked, true, `failed for ${typeof value}`);
  }
});

test("a null or unparseable lock is not a lock", () => {
  // A fresh row has locked_until NULL. Reading that as "locked" would refuse every new user.
  for (const value of [null, undefined, "", "not a date", NaN, {}]) {
    assert.equal(resolveLockState({ lockedUntil: value, nowMs: NOW }).locked, false, `failed for ${JSON.stringify(value)}`);
  }
});

test("a missing or corrupt attempt count is treated as zero, not as a lock", () => {
  // A NULL column on an existing row must not lock everyone out on the first upgrade.
  for (const value of [null, undefined, "", NaN, -5, "abc"]) {
    const result = registerFailedAttempt({ failedAttempts: value, lastFailedAt: null, nowMs: NOW });
    assert.equal(result.failedAttempts, 1);
    assert.equal(result.lockedUntilMs, null);
  }
});

test("a clock that moved backwards restarts the streak instead of locking", () => {
  // A future lastFailedAt means the clock changed. Treating it as "within the window" would let a
  // clock correction lock an account.
  const result = registerFailedAttempt({
    failedAttempts: FREE_ATTEMPTS,
    lastFailedAt: NOW + 60_000,
    nowMs: NOW,
  });
  assert.equal(result.failedAttempts, 1);
  assert.equal(result.lockedUntilMs, null);
});

// ---------------------------------------------------------------------------------------------
// What the person at the keyboard is told
// ---------------------------------------------------------------------------------------------

test("the wait is rounded up, never down", () => {
  // "Try again in 1 minute" when 61 seconds remain earns a second failed attempt and justified
  // annoyance.
  assert.equal(describeLockRemaining(61_000), "about 2 minutes");
  assert.equal(describeLockRemaining(60_000), "about a minute");
  assert.equal(describeLockRemaining(1), "about a minute");
  assert.equal(describeLockRemaining(0), "a moment");
  assert.equal(describeLockRemaining(90 * 60_000), "about 2 hours");
});

test("the message states the wait, never the policy", () => {
  // Naming the threshold hands an attacker the tuning for free and tells a legitimate user nothing
  // they can act on.
  const message = lockMessage(5 * 60_000);
  assert.match(message, /about 5 minutes/);
  assert.doesNotMatch(message, new RegExp(String(FREE_ATTEMPTS)), "must not reveal the threshold");
  assert.doesNotMatch(message, /attempts? remaining|locked for|policy/i);
});

// ---------------------------------------------------------------------------------------------
// The wiring
//
// A correct policy that nothing calls is exactly the state A-5 found: `locked_until` had existed
// for a long time, `/login` already refused a login while it was set, and no statement anywhere
// ever set it. These assert the path between the column and the check now exists.
// ---------------------------------------------------------------------------------------------

const fs = require("node:fs");
const path = require("node:path");

const backendSource = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const backendCode = backendSource
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

test("a failed password is counted, and can set the lock", () => {
  assert.match(backendCode, /registerFailedAttempt\(\{\s*failedAttempts: user\.failed_login_attempts/);
  assert.match(
    backendCode,
    /SET failed_login_attempts = \$2,\s*\n\s*last_failed_login_at = CURRENT_TIMESTAMP,\s*\n\s*locked_until = \$3/,
    "the failure path must persist the streak and the lock",
  );
});

test("the lock is consulted before the password is checked, on /login", () => {
  // Ordering is the property: a lock consulted afterwards would let a correct password through and
  // defeat the whole mechanism. Scoped to the /login handler — an earlier `checkPassword` call
  // belongs to /bootstrap/first-owner-device, which has its own lock check asserted below.
  const loginBody = backendCode.slice(backendCode.indexOf('app.post("/login"'));
  const lockIndex = loginBody.indexOf("resolveLockState({ lockedUntil: user.locked_until })");
  const passwordIndex = loginBody.indexOf("await checkPassword(password, user.password_hash)");
  assert.ok(lockIndex > 0, "the lock check must exist in /login");
  assert.ok(passwordIndex > 0, "the password check must exist in /login");
  assert.ok(lockIndex < passwordIndex, "the lock must be checked before the password");
});

test("the public bootstrap route is locked too, or the lockout is theatre", () => {
  // /bootstrap/first-owner-device is on A-4's public allow-list and verifies the Owner's password.
  // Locking only /login would leave an unlimited guessing oracle one route away, against the single
  // most valuable account in the system.
  const bootstrapBody = backendCode.slice(
    backendCode.indexOf('app.post("/bootstrap/first-owner-device"'),
    backendCode.indexOf('app.post("/bootstrap/first-owner-device"') + 4000,
  );
  const lockIndex = bootstrapBody.indexOf("resolveLockState({ lockedUntil: user.locked_until })");
  const passwordIndex = bootstrapBody.indexOf("checkPassword(password, user.password_hash)");
  assert.ok(lockIndex > 0, "the bootstrap route must consult the lock");
  assert.ok(lockIndex < passwordIndex, "and must consult it before checking the password");
  assert.match(bootstrapBody, /registerFailedAttempt\(\{/, "a failed bootstrap must count toward the streak");
});

test("both routes share one counter, so a streak on either locks both", () => {
  // Two independent counters would halve the cost of guessing: an attacker alternates routes and
  // never trips either threshold.
  const counted = backendCode.match(/registerFailedAttempt\(\{\s*\n?\s*failedAttempts: user\.failed_login_attempts/g) || [];
  assert.equal(counted.length, 2, "both password-verifying routes must feed the same counter");
});

test("a successful sign-in clears the streak and the lock", () => {
  // Without this the counter only ever climbs, and a user who mistyped four times last week is
  // locked by their next single slip.
  assert.match(
    backendCode,
    /failed_login_attempts = 0,\s*\n\s*last_failed_login_at = NULL,\s*\n\s*locked_until = NULL/,
    "success must reset the streak",
  );
});

test("the columns the policy needs exist in the schema bootstrap", () => {
  assert.match(backendCode, /ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0/);
  assert.match(backendCode, /ADD COLUMN IF NOT EXISTS last_failed_login_at TIMESTAMP/);
  assert.match(backendCode, /u\.failed_login_attempts/, "login must read the counter it updates");
});

test("bookkeeping failure cannot turn a wrong password into a 500", () => {
  // A 500 on a wrong password tells an attacker their guess was interesting, and breaks sign-in for
  // everyone the moment the counter column is missing.
  // Both password-verifying routes must swallow it, so assert on each rather than on whichever
  // happens to appear first in the file.
  assert.match(backendCode, /catch \(error\) \{\s*\n\s*console\.error\("Failed-login bookkeeping failed"/);
  assert.match(backendCode, /catch \(error\) \{\s*\n\s*console\.error\("Bootstrap failed-login bookkeeping failed"/);
});

test("locking is audited, so a lockout is explicable afterwards", () => {
  assert.match(backendCode, /action: "ACCOUNT_LOCKED"/);
});

test("accounts stranded by A-5 are counted at startup, not left in a document", () => {
  // Before A-5 this number was a precondition: how many accounts removing the legacy verify path
  // would strand. Now the path is gone it is a live fault count — each one is a person who will be
  // told to reset the next time they try to work — so it still has to be measured every boot. A
  // number nobody is watching is a number nobody knows.
  assert.match(backendCode, /const reportLegacyPasswordHashes = async \(\) => \{/);
  assert.match(
    backendCode,
    /NOT LIKE 'scrypt\$%'/,
    "the count must be everything the verifier refuses, not only the legacy digest shape",
  );
  assert.match(backendCode, /await reportLegacyPasswordHashes\(\);/, "it must actually run at startup");
});

test("the legacy-hash report names no accounts and never blocks startup", () => {
  // A startup log naming accounts with weak hashes is a list of targets. And a server refusing to
  // boot because it could not count something is worse than the thing it was counting.
  const report = backendCode.slice(
    backendCode.indexOf("const reportLegacyPasswordHashes"),
    backendCode.indexOf("const prepareDatabaseForStartup"),
  );
  assert.match(report, /COUNT\(\*\)/, "only a count may be selected");
  assert.doesNotMatch(report, /SELECT\s+(u\.)?username|SELECT\s+(u\.)?id\b/, "no account identifiers");
  assert.match(report, /catch \(error\)/, "a counting failure must not be fatal");
});

test("the legacy verify path is gone, and /login refuses it by name", () => {
  // Replaces the test that pinned A-5's deliberate half-completion. The gate was "the legacy
  // SHA-256 verify path is removed", and the two halves of that are: the verifier no longer runs
  // the retired algorithm, and `/login` answers the resulting refusal with something the person
  // reading it can act on. `passwordHash.test.js` proves the first behaviourally; this pins the
  // second, which lives in server.js and has no unit of its own.
  const hashSource = fs.readFileSync(path.join(__dirname, "passwordHash.js"), "utf8");
  assert.doesNotMatch(
    hashSource,
    /createHash\(\s*["']sha256["']\s*\)/,
    "the retired algorithm must not be computable in passwordHash.js",
  );
  assert.match(
    backendCode,
    /if \(storedPasswordIsUnusable\(passwordCheck\)\) \{/,
    "/login must branch on an unusable stored value before the wrong-password path",
  );
  assert.match(backendCode, /code: "PASSWORD_RESET_REQUIRED"/);
  assert.ok(
    backendCode.indexOf("storedPasswordIsUnusable(passwordCheck)")
      < backendCode.indexOf("if (!passwordCheck.ok) {"),
    "it must be checked first, or a retired format is counted as a wrong guess and locks the account",
  );
});
