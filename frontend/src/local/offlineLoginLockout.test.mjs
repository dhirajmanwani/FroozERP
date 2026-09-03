import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

import {
  FREE_ATTEMPTS,
  LOCK_STEPS_MS,
  STREAK_WINDOW_MS,
  clearOfflineFailures,
  describeOfflineLockRemaining,
  formatLockCountdown,
  offlineLockMessage,
  readOfflineLockState,
  registerOfflineFailure,
} from "./offlineLoginLockout.js";

const NOW = Date.parse("2026-08-20T12:00:00.000Z");

const fakeLocalStorage = () => {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
};

const withStorage = (impl, fn) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { value: impl, configurable: true });
  try {
    return fn();
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  }
};

const burst = (username, count, startMs = NOW) => {
  let last = null;
  for (let i = 0; i < count; i += 1) last = registerOfflineFailure({ username, nowMs: startMs + i * 1000 });
  return last;
};

test("offline guessing is eventually stopped", () => {
  // Reported from real hardware: six wrong passwords in a row were all accepted for another try,
  // because A-5's lock lives in the cloud backend and offline sign-in never reaches it.
  withStorage(fakeLocalStorage(), () => {
    for (let i = 1; i <= FREE_ATTEMPTS; i += 1) {
      assert.equal(registerOfflineFailure({ username: "owner", nowMs: NOW + i }).locked, false, `${i} must not lock`);
    }
    assert.equal(burst("owner", FREE_ATTEMPTS + 1).locked, true, "the streak must eventually lock");
  });
});

test("a locked device refuses whatever is typed", () => {
  withStorage(fakeLocalStorage(), () => {
    burst("owner", FREE_ATTEMPTS + 1);
    const state = readOfflineLockState({ username: "owner", nowMs: NOW + 1000 });
    assert.equal(state.locked, true);
    assert.ok(state.remainingMs > 0);
  });
});

test("the lock lifts on its own", () => {
  withStorage(fakeLocalStorage(), () => {
    burst("owner", FREE_ATTEMPTS + 1);
    assert.equal(readOfflineLockState({ username: "owner", nowMs: NOW + 61 * 60 * 1000 }).locked, false);
  });
});

test("one person's mistakes never lock out a colleague on the same till", () => {
  // Counters are per user. A shared counter would let one cashier's bad morning stop the whole
  // counter working.
  withStorage(fakeLocalStorage(), () => {
    burst("cashier", FREE_ATTEMPTS + 2);
    assert.equal(readOfflineLockState({ username: "cashier", nowMs: NOW }).locked, true);
    assert.equal(readOfflineLockState({ username: "owner", nowMs: NOW }).locked, false);
  });
});

test("the counter is case-insensitive, matching how sign-in matches usernames", () => {
  // Otherwise typing "Owner" instead of "owner" would silently reset the streak.
  withStorage(fakeLocalStorage(), () => {
    burst("owner", FREE_ATTEMPTS);
    const next = registerOfflineFailure({ username: "OWNER", nowMs: NOW + 5000 });
    assert.equal(next.locked, true, "a different capitalisation must not reset the streak");
  });
});

test("an old failure is forgotten rather than counted", () => {
  withStorage(fakeLocalStorage(), () => {
    burst("owner", FREE_ATTEMPTS);
    const later = registerOfflineFailure({ username: "owner", nowMs: NOW + STREAK_WINDOW_MS + 60_000 });
    assert.equal(later.failedAttempts, 1);
    assert.equal(later.locked, false);
  });
});

test("a successful sign-in ends the streak", () => {
  withStorage(fakeLocalStorage(), () => {
    burst("owner", FREE_ATTEMPTS);
    clearOfflineFailures({ username: "owner" });
    assert.equal(registerOfflineFailure({ username: "owner", nowMs: NOW + 5000 }).failedAttempts, 1);
  });
});

test("the escalation matches the backend exactly, so offline is not stricter than online", () => {
  // A device that punished offline sign-in harder than online would teach people that being
  // offline is broken. Compared by loading the backend module and reading its real values —
  // string-matching the source fails on arithmetic like `2 * 60 * 1000`, and would have passed
  // for the wrong reason.
  const backend = createRequire(import.meta.url)("../../../backend/loginLockout.js");
  assert.equal(backend.FREE_ATTEMPTS, FREE_ATTEMPTS);
  assert.equal(backend.STREAK_WINDOW_MS, STREAK_WINDOW_MS);
  assert.deepEqual([...backend.LOCK_STEPS_MS], [...LOCK_STEPS_MS]);
});

test("missing or hostile storage never blocks a sign-in", () => {
  // This is a speed bump. If it cannot record anything it must let the attempt through, not lock
  // the shop out of its own till.
  withStorage(undefined, () => {
    assert.doesNotThrow(() => registerOfflineFailure({ username: "owner" }));
    assert.equal(readOfflineLockState({ username: "owner" }).locked, false);
    assert.doesNotThrow(() => clearOfflineFailures({ username: "owner" }));
  });
  const hostile = { get getItem() { throw new Error("blocked"); } };
  withStorage(hostile, () => {
    assert.equal(readOfflineLockState({ username: "owner" }).locked, false);
  });
});

test("corrupt stored state is treated as no state", () => {
  const store = fakeLocalStorage();
  store.setItem("froozerp_offline_login_attempts_v1", "not json");
  withStorage(store, () => {
    assert.equal(readOfflineLockState({ username: "owner" }).locked, false);
    assert.doesNotThrow(() => registerOfflineFailure({ username: "owner" }));
  });
});

test("the message states the wait, never the policy", () => {
  const message = offlineLockMessage(5 * 60_000);
  assert.match(message, /about 5 minutes/);
  assert.doesNotMatch(message, new RegExp(String(FREE_ATTEMPTS)));
  assert.equal(describeOfflineLockRemaining(61_000), "about 2 minutes", "the wait rounds up");
});

test("the offline sign-in path consults the lock before checking the password", () => {
  // Ordering is the property. A lock consulted afterwards would let a correct password through.
  const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const lockIndex = app.indexOf("readOfflineLockState({ username })");
  const verifyIndex = app.indexOf("await verifyOfflineSessionRecord(credentialSource.record");
  assert.ok(lockIndex > 0, "the offline path must consult the lock");
  assert.ok(lockIndex < verifyIndex, "and must consult it before verifying the password");
  assert.match(app, /registerOfflineFailure\(\{ username \}\)/, "a failed offline attempt must count");
  assert.match(app, /clearOfflineFailures\(\{ username \}\)/, "success must clear the streak");
});

// -----------------------------------------------------------------------------------------------
// The countdown
//
// A frozen "try again in about a minute" does not change while the user waits, so there is no way
// to tell the app from a hung one — and it is still on screen after the lock lifts, which reads as
// "still locked" and earns another pointless attempt.
// -----------------------------------------------------------------------------------------------

test("the countdown is exact, and counts in units a waiting person can read", () => {
  assert.equal(formatLockCountdown(59_000), "59 seconds");
  assert.equal(formatLockCountdown(1_000), "1 second", "singular, not '1 seconds'");
  assert.equal(formatLockCountdown(60_000), "1:00");
  assert.equal(formatLockCountdown(90_000), "1:30");
  assert.equal(formatLockCountdown(3_600_000), "60:00");
});

test("the countdown never shows a negative or nonsense wait", () => {
  for (const value of [0, -1, -60_000, NaN, null, undefined, "x"]) {
    assert.equal(formatLockCountdown(value), "0 seconds", `failed for ${JSON.stringify(value)}`);
  }
});

test("the countdown rounds up, so it never says 0 while the lock still holds", () => {
  // Showing "0 seconds" a moment before the lock lifts invites an attempt that will still fail.
  assert.equal(formatLockCountdown(1), "1 second");
  assert.equal(formatLockCountdown(999), "1 second");
});

test("the login screen shows the countdown and drops it when the wait ends", () => {
  // Pins the wiring: a ticking message that clears itself, rather than a frozen string left in the
  // startup error.
  const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /offlineLockCountdownMessage\(offlineLockRemainingMs\)/, "the message must be live");
  assert.match(app, /const timer = window\.setInterval\(tick, 1000\)/, "it must tick");
  assert.match(app, /window\.clearInterval\(timer\)/, "and stop ticking when unmounted");
  assert.match(
    app,
    /if \(remaining <= 0\) \{\s*\n\s*setOfflineLockUntilMs\(0\);/,
    "an expired lock must clear itself rather than linger",
  );
  assert.match(app, /setOfflineLockUntilMs\(0\);\s*\n\s*\/\/ Entitlement decides access/, "success must clear it too");
});

test("the one remaining way back keeps the guard the two doors used to need", () => {
  // There were two doors to one action -- a Settings toggle and this banner button -- and the bug
  // was that only one of them was disabled when the action could not succeed, so the other still
  // produced a meaningless error. The Settings toggle is gone with the rest of the mode pickers;
  // the guard has to survive the door that remains, or the original bug simply comes back through
  // the survivor.
  const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /disabled=\{connectivityModeSwitching \|\| bannerAutoBlockedReason !== ""\}/);
  assert.match(app, /describeLocalServiceFailure\(error, "Unable to reconnect this computer"\)/,
    "it must not discard a locally-thrown reason via getErrorMessage");
  assert.doesNotMatch(app, /Return to Auto/, "and the mode vocabulary must not come back with it");
});
