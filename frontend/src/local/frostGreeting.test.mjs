import test from "node:test";
import assert from "node:assert/strict";

import {
  FROST_GREETING_BANDS,
  FROST_GREETING_FALLBACK,
  resolveFrostGreeting,
  resolveGreetingBand,
} from "./frostGreeting.js";

const at = (hour) => new Date(2026, 8, 20, hour, 30, 0);

test("every hour of the day lands in exactly one band", () => {
  // The bug this prevents is the wrapping one: `night` runs 21:00 to 05:00, and a naive
  // `from <= hour && hour < to` makes that window match nothing. Every hour would then fall back to
  // the neutral greeting, which reads perfectly fine and would never be reported.
  for (let hour = 0; hour < 24; hour += 1) {
    const matches = FROST_GREETING_BANDS.filter(({ from, to }) => (
      from < to ? hour >= from && hour < to : hour >= from || hour < to
    ));
    assert.equal(matches.length, 1, `hour ${hour} matched ${matches.length} bands`);
  }
});

test("the bands are the shop's day", () => {
  assert.equal(resolveGreetingBand(5).id, "morning");
  assert.equal(resolveGreetingBand(11).id, "morning");
  assert.equal(resolveGreetingBand(12).id, "afternoon");
  assert.equal(resolveGreetingBand(16).id, "afternoon");
  assert.equal(resolveGreetingBand(17).id, "evening");
  assert.equal(resolveGreetingBand(20).id, "evening");
  assert.equal(resolveGreetingBand(21).id, "night");
  assert.equal(resolveGreetingBand(23).id, "night");
  assert.equal(resolveGreetingBand(0).id, "night");
  assert.equal(resolveGreetingBand(4).id, "night");
});

test("4am is night and 5am is morning, because the mandi run starts before dawn", () => {
  assert.equal(resolveFrostGreeting({ now: at(4), name: "Dhiraj" }).greeting, "Working late");
  assert.equal(resolveFrostGreeting({ now: at(5), name: "Dhiraj" }).greeting, "Good morning");
});

test("the greeting names the owner", () => {
  assert.equal(resolveFrostGreeting({ now: at(9), name: "Dhiraj" }).line, "Good morning, Dhiraj.");
  assert.equal(resolveFrostGreeting({ now: at(19), name: "Dhiraj" }).line, "Good evening, Dhiraj.");
});

test("a missing name leaves a whole sentence, not a blank or an 'undefined'", () => {
  assert.equal(resolveFrostGreeting({ now: at(9) }).line, "Good morning.");
  assert.equal(resolveFrostGreeting({ now: at(9), name: "   " }).line, "Good morning.");
  assert.equal(resolveFrostGreeting({ now: at(9), name: undefined }).line, "Good morning.");
  assert.equal(resolveFrostGreeting({ now: at(9), name: null }).line, "Good morning.");
});

test("an unreadable clock greets neutrally instead of guessing a time of day", () => {
  // "Good morning" at ten at night is the same mistake as a figure stated from nothing: small,
  // confident, and wrong. The neutral line is true at every hour.
  for (const broken of [new Date("not a date"), NaN, "yesterday", {}]) {
    const result = resolveFrostGreeting({ now: broken, name: "Dhiraj" });
    assert.equal(result.band, null, "a failed clock read must be visible to the caller");
    assert.equal(result.greeting, FROST_GREETING_FALLBACK);
    assert.equal(result.line, "Good to see you, Dhiraj.");
  }
});

test("resolveGreetingBand refuses anything that is not a real hour", () => {
  for (const value of [-1, 24, 9.5, "9", null, undefined, NaN]) {
    assert.equal(resolveGreetingBand(value), null, `${String(value)} is not an hour`);
  }
});

test("called with no arguments at all it still produces a sentence", () => {
  const result = resolveFrostGreeting();
  assert.ok(result.line.endsWith("."), "the greeting is always a whole sentence");
  assert.ok(result.line.length > 3);
});
