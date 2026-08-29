"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_LIMIT,
  MAX_TRACKED_CALLERS,
  callerKey,
  registerAttempt,
  resetThrottle,
  throttleMessage,
} = require("./publicRouteThrottle");

test.beforeEach(() => resetThrottle());

test("a caller may try up to the limit, then is asked to wait", () => {
  for (let attempt = 1; attempt <= DEFAULT_LIMIT; attempt += 1) {
    assert.equal(registerAttempt({ key: "1.2.3.4" }).allowed, true, `attempt ${attempt}`);
  }
  const blocked = registerAttempt({ key: "1.2.3.4" });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds > 0, "a refusal must say how long to wait");
});

test("one caller's guessing does not block another", () => {
  // The reason this is per caller and not per target: locking the thing being guessed at would let
  // anyone deny service to a real device just by guessing at it.
  for (let attempt = 0; attempt <= DEFAULT_LIMIT; attempt += 1) registerAttempt({ key: "attacker" });
  assert.equal(registerAttempt({ key: "honest-shop" }).allowed, true);
});

test("the window lapses and the caller may try again", () => {
  const start = 1_000_000;
  for (let attempt = 0; attempt <= DEFAULT_LIMIT; attempt += 1) {
    registerAttempt({ key: "1.2.3.4", nowMs: start });
  }
  assert.equal(registerAttempt({ key: "1.2.3.4", nowMs: start }).allowed, false);
  // A limit that never lapses is a ban, and a stranger must not be able to ban a real shop.
  assert.equal(registerAttempt({ key: "1.2.3.4", nowMs: start + 10 * 60 * 1000 + 1 }).allowed, true);
});

test("scopes are counted separately", () => {
  // Guessing activation codes should not use up a shop's recovery attempts: they are different
  // actions with different costs.
  for (let attempt = 0; attempt <= DEFAULT_LIMIT; attempt += 1) registerAttempt({ key: "activate:1.2.3.4" });
  assert.equal(registerAttempt({ key: "recovery:1.2.3.4" }).allowed, true);
});

test("the caller key is the address alone, never anything they supply", () => {
  // Including a device id or username would let a guesser pick a fresh bucket per attempt, which is
  // the same as having no limit.
  const key = callerKey({ ip: "9.9.9.9", body: { device_id: "anything" } }, "activate");
  assert.equal(key, "activate:9.9.9.9");
  assert.doesNotMatch(key, /anything/);
});

test("a missing address still lands in one bucket rather than none", () => {
  assert.equal(callerKey({}, "activate"), "activate:unknown");
  assert.equal(registerAttempt({ key: "" }).allowed, true);
});

test("tracked callers are capped, so a flood cannot exhaust memory", () => {
  // An unbounded map keyed by caller address is a memory leak with an attacker holding the tap.
  const now = 5_000_000;
  for (let index = 0; index < MAX_TRACKED_CALLERS + 500; index += 1) {
    registerAttempt({ key: `caller-${index}`, nowMs: now });
  }
  // Still serving: the most recent caller is tracked and allowed.
  assert.equal(registerAttempt({ key: "caller-fresh", nowMs: now }).allowed, true);
});

test("the wait is described in minutes a person can act on", () => {
  assert.match(throttleMessage(30), /Wait a minute/);
  assert.match(throttleMessage(600), /about 10 minutes/);
});
