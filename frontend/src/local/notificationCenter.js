/**
 * The notification centre: one place where warnings, errors and updates collect.
 *
 * ## Why this exists
 *
 * Messages in this application are scattered across at least three mechanisms — 186 blocking
 * `alert()` popups, roughly a dozen separate `message`/`notice` state variables, and inline
 * banners. Three consequences follow, and all three have bitten:
 *
 * 1. A blocking `alert()` stops the till until someone clicks it. On a busy counter that is a
 *    queue, not a message.
 * 2. A message written into a local `useState` is gone the moment the view changes. Anything the
 *    operator did not read in that instant is lost, with no way to go back and look.
 * 3. Because there is no shared list, a genuine warning and a routine status update look identical
 *    and compete for the same strip of screen.
 *
 * This module is the shared list. It is **pure**: no React, no timers, no DOM, no storage. It takes
 * a list and returns a new list, which is what makes every rule below directly testable — the
 * reason `CLAUDE.md` asks for logic to live in `frontend/src/local/` rather than in `App.jsx`.
 *
 * ## Rules that are load-bearing
 *
 * - **Nothing is ever silently dropped.** Overflow trims the oldest *dismissable* entries first and
 *   never discards an unread error. A notification centre that loses the one message that mattered
 *   is worse than none, because it is trusted.
 * - **Repeats collapse, they do not stack.** A connectivity check failing every 30 seconds must
 *   produce one entry with a count, not 120 entries burying everything else.
 * - **Severity never decays.** A repeat of the same key at a higher severity upgrades the entry; a
 *   repeat at a lower severity leaves it alone. A problem that got worse must not look calmer.
 */

export const NOTIFICATION_SEVERITY = Object.freeze({
  ERROR: "error",
  WARNING: "warning",
  INFO: "info",
  SUCCESS: "success",
});

/** Higher wins when a repeated notification arrives at a different severity. */
const SEVERITY_RANK = Object.freeze({
  [NOTIFICATION_SEVERITY.SUCCESS]: 0,
  [NOTIFICATION_SEVERITY.INFO]: 1,
  [NOTIFICATION_SEVERITY.WARNING]: 2,
  [NOTIFICATION_SEVERITY.ERROR]: 3,
});

/**
 * How many notifications are retained. Beyond this the oldest read, dismissable entries are
 * dropped. Large enough that a normal day never trims; small enough that the list stays readable
 * and cannot grow without bound in a process that runs for weeks.
 */
export const MAX_NOTIFICATIONS = 100;

const isSeverity = (value) => Object.values(NOTIFICATION_SEVERITY).includes(value);

const text = (value) => (typeof value === "string" ? value.trim() : "");

const rank = (severity) => SEVERITY_RANK[severity] ?? SEVERITY_RANK[NOTIFICATION_SEVERITY.INFO];

/**
 * Build a notification. `dedupeKey` is what makes a repeat a repeat; when absent it falls back to
 * severity + title, so a caller that forgets one still gets sane collapsing rather than a flood.
 */
export const createNotification = ({
  id,
  severity = NOTIFICATION_SEVERITY.INFO,
  title,
  message = "",
  source = "",
  dedupeKey,
  at,
  sticky = false,
} = {}) => {
  const resolvedSeverity = isSeverity(severity) ? severity : NOTIFICATION_SEVERITY.INFO;
  const resolvedTitle = text(title);
  if (!resolvedTitle) {
    // A notification with no title is unreadable, and silently keeping it would put an empty row in
    // front of the operator. Refusing is louder and easier to find than rendering a blank.
    throw new Error("notification requires a title");
  }
  const when = at || new Date().toISOString();
  return {
    id: text(id) || `ntf-${when}-${Math.random().toString(36).slice(2, 10)}`,
    severity: resolvedSeverity,
    title: resolvedTitle,
    message: text(message),
    source: text(source),
    dedupeKey: text(dedupeKey) || `${resolvedSeverity}:${resolvedTitle}`,
    at: when,
    lastAt: when,
    count: 1,
    read: false,
    // Sticky notifications survive "clear all" — reserved for conditions that are still true, so
    // clearing the list cannot hide a problem that has not gone away.
    sticky: Boolean(sticky),
  };
};

const trim = (list) => {
  if (list.length <= MAX_NOTIFICATIONS) return list;
  const keep = [];
  const droppable = [];
  list.forEach((entry) => {
    const protectedEntry = entry.sticky
      || (!entry.read && entry.severity === NOTIFICATION_SEVERITY.ERROR);
    (protectedEntry ? keep : droppable).push(entry);
  });
  // Drop oldest droppable first; `list` is newest-first, so trim from the tail.
  const room = Math.max(MAX_NOTIFICATIONS - keep.length, 0);
  const survivors = new Set(droppable.slice(0, room).map((entry) => entry.id));
  return list.filter((entry) => survivors.has(entry.id)
    || entry.sticky
    || (!entry.read && entry.severity === NOTIFICATION_SEVERITY.ERROR));
};

/**
 * Add a notification, collapsing a repeat of the same `dedupeKey` into the existing entry.
 *
 * A collapsed repeat bumps `count`, refreshes `lastAt`, moves the entry back to the top, and marks
 * it unread again — a recurrence is news even if the first occurrence was read. Severity upgrades
 * but never downgrades.
 */
export const addNotification = (list, notification) => {
  const entries = Array.isArray(list) ? list : [];
  if (!notification || !text(notification.dedupeKey)) return entries;

  const existing = entries.find((entry) => entry.dedupeKey === notification.dedupeKey);
  if (!existing) return trim([notification, ...entries]);

  const upgraded = rank(notification.severity) > rank(existing.severity);
  const merged = {
    ...existing,
    severity: upgraded ? notification.severity : existing.severity,
    // Keep the newest wording: a recurring condition often carries fresher detail.
    message: notification.message || existing.message,
    lastAt: notification.at || existing.lastAt,
    count: existing.count + 1,
    read: false,
    sticky: existing.sticky || Boolean(notification.sticky),
  };
  return [merged, ...entries.filter((entry) => entry.dedupeKey !== notification.dedupeKey)];
};

/** Remove one notification outright. Sticky entries resist `clearAll`, not deliberate dismissal. */
export const dismissNotification = (list, id) => {
  const entries = Array.isArray(list) ? list : [];
  return entries.filter((entry) => entry.id !== id);
};

/** Clear everything the operator is allowed to clear. Sticky entries stay. */
export const clearNotifications = (list) => {
  const entries = Array.isArray(list) ? list : [];
  return entries.filter((entry) => entry.sticky);
};

export const markAllRead = (list) => {
  const entries = Array.isArray(list) ? list : [];
  return entries.map((entry) => (entry.read ? entry : { ...entry, read: true }));
};

export const markRead = (list, id) => {
  const entries = Array.isArray(list) ? list : [];
  return entries.map((entry) => (entry.id === id && !entry.read ? { ...entry, read: true } : entry));
};

export const unreadCount = (list) => {
  const entries = Array.isArray(list) ? list : [];
  return entries.reduce((total, entry) => (entry.read ? total : total + 1), 0);
};

/**
 * The severity the bell should wear: the worst among unread entries, or `null` when nothing is
 * unread. The badge must reflect the most serious thing waiting, not the most recent.
 */
export const highestUnreadSeverity = (list) => {
  const entries = Array.isArray(list) ? list : [];
  let worst = null;
  entries.forEach((entry) => {
    if (entry.read) return;
    if (worst === null || rank(entry.severity) > rank(worst)) worst = entry.severity;
  });
  return worst;
};

/**
 * Retract a notification whose condition has resolved — e.g. connectivity returned, so the
 * "cloud unreachable" entry should go rather than sit there implying a problem that has ended.
 */
export const resolveNotification = (list, dedupeKey) => {
  const entries = Array.isArray(list) ? list : [];
  const key = text(dedupeKey);
  if (!key) return entries;
  return entries.filter((entry) => entry.dedupeKey !== key);
};
