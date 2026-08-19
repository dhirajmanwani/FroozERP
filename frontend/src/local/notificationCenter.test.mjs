/**
 * Rules the notification centre must not lose.
 *
 * The three that matter most, and why:
 *   - a repeat collapses instead of stacking (a check failing every 30s must not bury the list),
 *   - overflow never discards an unread error (the one message that mattered),
 *   - severity upgrades but never decays (a problem that got worse must not look calmer).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addNotification,
  clearNotifications,
  createNotification,
  dismissNotification,
  highestUnreadSeverity,
  markAllRead,
  markRead,
  MAX_NOTIFICATIONS,
  NOTIFICATION_SEVERITY,
  resolveNotification,
  unreadCount,
} from "./notificationCenter.js";

const at = (n) => new Date(Date.UTC(2026, 7, 18, 10, 0, n)).toISOString();

const push = (list, options) => addNotification(list, createNotification(options));

test("a new notification lands unread at the top", () => {
  let list = [];
  list = push(list, { title: "First", at: at(1) });
  list = push(list, { title: "Second", at: at(2) });
  assert.equal(list.length, 2);
  assert.equal(list[0].title, "Second", "newest first");
  assert.equal(unreadCount(list), 2);
});

test("a repeat collapses into one entry with a count, instead of stacking", () => {
  // A connectivity check failing every 30 seconds must not produce 120 rows.
  let list = [];
  for (let i = 0; i < 20; i += 1) {
    list = push(list, {
      title: "Cloud unreachable",
      dedupeKey: "cloud-unreachable",
      severity: NOTIFICATION_SEVERITY.WARNING,
      at: at(i),
    });
  }
  assert.equal(list.length, 1, "twenty occurrences, one row");
  assert.equal(list[0].count, 20);
  assert.equal(list[0].lastAt, at(19), "the entry tracks when it last happened");
});

test("a recurrence becomes unread again even after it was read", () => {
  let list = push([], { title: "Sync failed", dedupeKey: "sync-failed", at: at(1) });
  list = markAllRead(list);
  assert.equal(unreadCount(list), 0);
  list = push(list, { title: "Sync failed", dedupeKey: "sync-failed", at: at(2) });
  assert.equal(unreadCount(list), 1, "it happening again is news");
});

test("severity upgrades on repeat but never decays", () => {
  let list = push([], {
    title: "Device identity",
    dedupeKey: "identity",
    severity: NOTIFICATION_SEVERITY.WARNING,
    at: at(1),
  });
  list = push(list, {
    title: "Device identity",
    dedupeKey: "identity",
    severity: NOTIFICATION_SEVERITY.ERROR,
    at: at(2),
  });
  assert.equal(list[0].severity, NOTIFICATION_SEVERITY.ERROR, "worse must show as worse");

  list = push(list, {
    title: "Device identity",
    dedupeKey: "identity",
    severity: NOTIFICATION_SEVERITY.INFO,
    at: at(3),
  });
  assert.equal(
    list[0].severity,
    NOTIFICATION_SEVERITY.ERROR,
    "a later milder report must not make an unresolved problem look calmer",
  );
});

test("the bell shows the worst unread severity, not the most recent", () => {
  let list = push([], {
    title: "Disk almost full",
    dedupeKey: "disk",
    severity: NOTIFICATION_SEVERITY.ERROR,
    at: at(1),
  });
  list = push(list, {
    title: "Backup finished",
    dedupeKey: "backup",
    severity: NOTIFICATION_SEVERITY.SUCCESS,
    at: at(2),
  });
  assert.equal(highestUnreadSeverity(list), NOTIFICATION_SEVERITY.ERROR);

  list = markAllRead(list);
  assert.equal(highestUnreadSeverity(list), null, "nothing unread means no badge");
});

test("overflow never discards an unread error", () => {
  // The failure this guards against: the one message that mattered scrolling off the end.
  let list = push([], {
    title: "Critical failure",
    dedupeKey: "critical",
    severity: NOTIFICATION_SEVERITY.ERROR,
    at: at(0),
  });
  for (let i = 1; i <= MAX_NOTIFICATIONS + 50; i += 1) {
    list = push(list, {
      title: `Routine ${i}`,
      dedupeKey: `routine-${i}`,
      severity: NOTIFICATION_SEVERITY.INFO,
      at: at(i),
    });
    list = list.map((entry) => (entry.dedupeKey === "critical" ? entry : { ...entry, read: true }));
  }
  assert.ok(list.length <= MAX_NOTIFICATIONS, "the list stays bounded");
  assert.ok(
    list.some((entry) => entry.dedupeKey === "critical"),
    "the unread error survived the flood",
  );
});

test("sticky notifications survive clear-all but can still be dismissed deliberately", () => {
  let list = push([], {
    title: "Activation expired",
    dedupeKey: "entitlement",
    severity: NOTIFICATION_SEVERITY.ERROR,
    sticky: true,
    at: at(1),
  });
  list = push(list, { title: "Report ready", dedupeKey: "report", at: at(2) });

  list = clearNotifications(list);
  assert.equal(list.length, 1, "clearing removes the ordinary entry");
  assert.equal(list[0].dedupeKey, "entitlement", "a condition that is still true stays put");

  list = dismissNotification(list, list[0].id);
  assert.equal(list.length, 0, "explicit dismissal still works");
});

test("a resolved condition is retracted rather than left implying a problem", () => {
  let list = push([], { title: "Cloud unreachable", dedupeKey: "cloud", at: at(1) });
  list = push(list, { title: "Sync failed", dedupeKey: "sync", at: at(2) });
  list = resolveNotification(list, "cloud");
  assert.equal(list.length, 1);
  assert.equal(list[0].dedupeKey, "sync");
});

test("marking one read leaves the others alone", () => {
  let list = push([], { title: "One", dedupeKey: "one", at: at(1) });
  list = push(list, { title: "Two", dedupeKey: "two", at: at(2) });
  list = markRead(list, list.find((entry) => entry.dedupeKey === "one").id);
  assert.equal(unreadCount(list), 1);
});

test("a notification without a title is refused, not rendered blank", () => {
  // An empty row in front of the operator is the "errors must never render as zero" failure.
  assert.throws(() => createNotification({ title: "" }), /requires a title/);
  assert.throws(() => createNotification({ title: "   " }), /requires a title/);
  assert.throws(() => createNotification({}), /requires a title/);
});

test("an unknown severity falls back to info rather than breaking the badge", () => {
  const entry = createNotification({ title: "Odd", severity: "catastrophic" });
  assert.equal(entry.severity, NOTIFICATION_SEVERITY.INFO);
});

test("a missing dedupeKey still collapses sensibly instead of flooding", () => {
  let list = [];
  for (let i = 0; i < 5; i += 1) {
    list = push(list, { title: "Same thing", severity: NOTIFICATION_SEVERITY.WARNING, at: at(i) });
  }
  assert.equal(list.length, 1, "identical title+severity is treated as the same notification");
  assert.equal(list[0].count, 5);
});

test("helpers tolerate a missing or malformed list without throwing", () => {
  assert.deepEqual(addNotification(null, createNotification({ title: "X" })).length, 1);
  assert.equal(unreadCount(null), 0);
  assert.equal(highestUnreadSeverity(undefined), null);
  assert.deepEqual(dismissNotification(null, "x"), []);
  assert.deepEqual(clearNotifications(undefined), []);
  assert.deepEqual(markAllRead(null), []);
});
