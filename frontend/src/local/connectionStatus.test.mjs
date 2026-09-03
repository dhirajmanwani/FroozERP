import test from "node:test";
import assert from "node:assert/strict";

import {
  CONNECTION_STATE,
  CONNECTION_TONE,
  connectionNeedsAttention,
  describeAge,
  resolveConnectionStatus,
} from "./connectionStatus.js";

/**
 * One behaviour, no choice: use the cloud when it answers, use this computer when it does not.
 *
 * These tests are mostly about *what is said*, which is unusual for a test file and deliberate
 * here. The old design's failure was never that the software did the wrong thing — it was that
 * four settings decided one behaviour and nothing on screen said which was in charge. Replacing
 * them with a sentence only helps if the sentence is true, useful, and does not cry wolf.
 */

const NOW = new Date("2026-09-02T18:00:00.000Z");

test("connected and up to date says so quietly, and stays out of the top bar", () => {
  // A permanent green tick is read for a week and ignored forever after — and then it is worthless
  // on the day it turns red.
  const status = resolveConnectionStatus({ cloudReachable: true, pendingCount: 0, now: NOW });
  assert.equal(status.state, CONNECTION_STATE.SYNCED);
  assert.equal(status.tone, CONNECTION_TONE.CALM);
  assert.equal(status.showsInTopBar, false);
});

test("offline tells the shop it can keep selling, before it mentions anything is wrong", () => {
  // A cashier reads this mid-sale. The first thing they need is whether to carry on, and the
  // answer is yes — this app is built to sell with no internet.
  const status = resolveConnectionStatus({ cloudReachable: false, pendingCount: 3, now: NOW });
  assert.equal(status.state, CONNECTION_STATE.OFFLINE);
  assert.equal(status.headline, "Working offline");
  assert.match(status.detail, /^Billing works normally/);
  assert.match(status.detail, /3 bills/);
  assert.match(status.detail, /by themselves/, "and that nobody has to do anything about it");
  assert.equal(status.showsInTopBar, true);
});

test("offline is a notice, not an alarm", () => {
  // Patchy internet is ordinary in this shop. Making it an alert would train everyone to dismiss
  // alerts, and then the one that matters is dismissed too.
  const status = resolveConnectionStatus({ cloudReachable: false, now: NOW });
  assert.equal(status.tone, CONNECTION_TONE.NOTICE);
  assert.equal(connectionNeedsAttention(status), false);
});

test("a machine deliberately held offline is not described as offline", () => {
  // Offline is weather; this is a decision. Telling somebody to check their internet would send
  // them chasing a fault that does not exist.
  const status = resolveConnectionStatus({ heldOffline: true, cloudReachable: false, pendingCount: 2, now: NOW });
  assert.equal(status.state, CONNECTION_STATE.HELD_OFFLINE);
  assert.match(status.headline, /on purpose/);
  assert.doesNotMatch(status.headline, /Working offline/);
  assert.equal(connectionNeedsAttention(status), true, "this one does need a person");
});

test("a deliberate hold outranks everything, even a reachable cloud", () => {
  // The kill switch is the point: it holds whatever the network happens to be doing.
  const status = resolveConnectionStatus({ heldOffline: true, cloudReachable: true, now: NOW });
  assert.equal(status.state, CONNECTION_STATE.HELD_OFFLINE);
});

test("not checked yet is not offline", () => {
  // Announcing offline during startup would make every launch open with a warning that is usually
  // wrong a second later, which is how a warning becomes furniture.
  const starting = resolveConnectionStatus({ cloudReachable: null, now: NOW });
  assert.equal(starting.state, CONNECTION_STATE.STARTING);
  assert.equal(starting.showsInTopBar, false);

  const serviceStarting = resolveConnectionStatus({ cloudReachable: true, localServiceReady: false, now: NOW });
  assert.equal(serviceStarting.state, CONNECTION_STATE.STARTING);
});

test("catching up says there is nothing to do about it", () => {
  // The natural reading of "3 bills still to send" is that somebody must send them.
  const status = resolveConnectionStatus({ cloudReachable: true, pendingCount: 3, now: NOW });
  assert.equal(status.state, CONNECTION_STATE.CATCHING_UP);
  assert.match(status.detail, /Nothing to do/);
  assert.equal(status.showsInTopBar, true);
});

test("one bill is a bill, not 1 bills", () => {
  const status = resolveConnectionStatus({ cloudReachable: false, pendingCount: 1, now: NOW });
  assert.match(status.detail, /1 bill\b/);
  assert.doesNotMatch(status.detail, /1 bills/);
});

test("a nonsense pending count is treated as none, never shown as a number", () => {
  // The count comes from a queue that can be unreadable. "-2 bills waiting" is worse than silence.
  for (const bad of [null, undefined, "", "many", -4, Number.NaN]) {
    const status = resolveConnectionStatus({ cloudReachable: true, pendingCount: bad, now: NOW });
    assert.equal(status.state, CONNECTION_STATE.SYNCED, `pendingCount ${String(bad)}`);
  }
});

test("no message ever asks the shop to pick a mode or change a setting", () => {
  // The whole point. Every one of these words names something the maintainer said he should never
  // have to think about, and each of them appeared in the screens this replaces.
  const forbidden = /connectivity mode|app mode|cloud production|local single device|branch lan|api url|auto\b/i;
  for (const facts of [
    { cloudReachable: true, pendingCount: 0 },
    { cloudReachable: true, pendingCount: 5 },
    { cloudReachable: false, pendingCount: 0 },
    { cloudReachable: false, pendingCount: 2 },
    { cloudReachable: null },
    { heldOffline: true },
  ]) {
    const status = resolveConnectionStatus({ ...facts, now: NOW });
    assert.doesNotMatch(status.headline, forbidden, JSON.stringify(facts));
    assert.doesNotMatch(status.detail, forbidden, JSON.stringify(facts));
  }
});

test("how long ago is coarse on purpose", () => {
  // Precise enough to reassure, too coarse to invite arithmetic at a counter with a queue.
  assert.equal(describeAge("2026-09-02T17:59:30.000Z", NOW), "just now");
  assert.equal(describeAge("2026-09-02T17:30:00.000Z", NOW), "30 minutes ago");
  assert.equal(describeAge("2026-09-02T16:00:00.000Z", NOW), "2 hours ago");
  assert.equal(describeAge("2026-09-01T18:00:00.000Z", NOW), "1 day ago");
  assert.equal(describeAge("2026-08-30T18:00:00.000Z", NOW), "3 days ago");
});

test("an unusable or future timestamp says nothing rather than something wrong", () => {
  // A clock that disagrees with the server is common on a shop machine. "in -3 minutes" is the kind
  // of detail that makes somebody distrust every other number on the screen.
  assert.equal(describeAge("", NOW), "");
  assert.equal(describeAge("not a date", NOW), "");
  assert.equal(describeAge(null, NOW), "");
  assert.equal(describeAge("2026-09-02T18:30:00.000Z", NOW), "");
});
