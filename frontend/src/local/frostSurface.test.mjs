import assert from "node:assert/strict";
import test from "node:test";

import {
  FROST_PRIMARY_SECTION,
  FROST_RANGE_LABELS,
  describeFrostRange,
  resolveFrostSurface,
} from "./frostSurface.js";

const owner = { canManageFrost: true, canManageReminders: true };

test("the panel opens onto the conversation and nothing else is primary", () => {
  const surface = resolveFrostSurface(owner);
  assert.equal(surface.primary, FROST_PRIMARY_SECTION);
  assert.equal(surface.activeSection, FROST_PRIMARY_SECTION);
  assert.equal(surface.onConversation, true);
  assert.equal(surface.menu.some((entry) => entry.key === FROST_PRIMARY_SECTION), false);
});

test("the eleven tabs become a conversation plus a short menu", () => {
  // The complaint was the row itself, so the count is the assertion. Voice is absent by design:
  // talking is a control on the composer, not a place to go.
  const surface = resolveFrostSurface(owner);
  const keys = surface.menu.map((entry) => entry.key);
  assert.deepEqual(keys, ["today", "alerts", "reminders", "decision", "predictions", "profit", "memory"]);
  assert.deepEqual(surface.footer.map((entry) => entry.key), ["voice", "settings"]);
  // Live voice is neither deleted nor offered as an equal: it opens a microphone session that is
  // sent no tools, so it cannot read the books. It sits in the footer, labelled for what it is.
  assert.equal(keys.includes("voice"), false);
  assert.equal(surface.shortcuts.some((entry) => entry.key === "voice"), false);
  assert.match(surface.footer[0].blurb, /not connected to your books/i);
  assert.equal(keys.includes("ask"), false, "asking is the surface");
  assert.equal(keys.includes("history"), false, "the thread is the history");
  // The old Briefing tab was two things under one name. Its recommendations open the conversation;
  // its tiles stay a place, renamed to what an owner would call them.
  assert.equal(keys.includes("briefing"), false);
  assert.equal(keys.includes("today"), true);
});

test("the two an owner opens daily are shortcuts, not buried in the menu", () => {
  assert.deepEqual(resolveFrostSurface(owner).shortcuts.map((entry) => entry.key), ["today", "alerts", "reminders"]);
});

test("every menu entry says in plain words what is inside it", () => {
  for (const entry of [...resolveFrostSurface(owner).menu, ...resolveFrostSurface(owner).footer]) {
    assert.ok(entry.label.length > 0, `${entry.key} has no label`);
    assert.ok(entry.blurb.length > 8, `${entry.key} has no usable blurb`);
    assert.doesNotMatch(entry.blurb, /module|endpoint|API|deterministic/i, `${entry.key} reads like a spec`);
  }
});

test("a user who may not manage FROST is not offered its settings or memory", () => {
  // This narrows what is shown. It is not the permission -- the server's own checks are -- and the
  // booleans arrive already computed so that who may manage FROST stays decided in one place.
  const limited = resolveFrostSurface({ canManageFrost: false, canManageReminders: false });
  const keys = [...limited.menu, ...limited.footer].map((entry) => entry.key);
  assert.equal(keys.includes("settings"), false);
  assert.equal(keys.includes("memory"), false);
  assert.equal(keys.includes("reminders"), false);
  assert.deepEqual(limited.shortcuts.map((entry) => entry.key), ["today", "alerts"]);
  assert.deepEqual(keys, ["today", "alerts", "decision", "predictions", "profit"]);
});

test("a section the user cannot reach falls back to the conversation, not to a blank panel", () => {
  // Same class as an error rendering as zero: an empty body where a section used to be reads as
  // lost data rather than as a section that is not theirs.
  const surface = resolveFrostSurface({ canManageFrost: false, canManageReminders: false, activeSection: "settings" });
  assert.equal(surface.activeSection, FROST_PRIMARY_SECTION);
  assert.equal(surface.onConversation, true);

  const unknown = resolveFrostSurface({ ...owner, activeSection: "not-a-section" });
  assert.equal(unknown.activeSection, FROST_PRIMARY_SECTION);
});

test("an open section is marked active, and only that one", () => {
  const surface = resolveFrostSurface({ ...owner, activeSection: "predictions" });
  assert.equal(surface.onConversation, false);
  assert.deepEqual(surface.menu.filter((entry) => entry.active).map((entry) => entry.key), ["predictions"]);
});

test("the alert badge counts, sits only on alerts, and never shows a zero or a guess", () => {
  const badgeFor = (surface, key) => surface.menu.find((entry) => entry.key === key)?.badge;
  assert.equal(badgeFor(resolveFrostSurface({ ...owner, alertCount: 3 }), "alerts"), 3);
  assert.equal(badgeFor(resolveFrostSurface({ ...owner, alertCount: 3 }), "today"), 0);
  for (const alertCount of [0, -2, null, undefined, Number.NaN, "lots"]) {
    assert.equal(badgeFor(resolveFrostSurface({ ...owner, alertCount }), "alerts"), 0, `${alertCount}`);
  }
});

test("the period is said in words, because a hidden filter is the Report Center bug", () => {
  // CLAUDE.md: any effective filter must be visible to the user. The select moves off the front
  // surface, so the thread has to carry the label instead.
  assert.equal(describeFrostRange("today"), "Today");
  assert.equal(describeFrostRange("last_7_days"), "Last 7 days");
  assert.equal(describeFrostRange("this_month"), "This month");
  // An unknown value is named rather than drawn as "Today", which is exactly how a filter goes
  // unnoticed while it is active.
  assert.equal(describeFrostRange("last_quarter"), "Period: last_quarter");
  assert.equal(describeFrostRange(""), "No period selected");
  assert.equal(describeFrostRange(undefined), "No period selected");
  // Every value the picker can produce has a label.
  assert.deepEqual(Object.keys(FROST_RANGE_LABELS), ["today", "yesterday", "last_7_days", "this_month"]);
});
