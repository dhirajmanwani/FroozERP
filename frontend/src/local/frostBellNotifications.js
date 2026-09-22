/**
 * FROST's alerts and reminders, as rows for the bell in the header.
 *
 * ## What this fixes
 *
 * FROST already works out what matters — `runAlertRules` raises `CUSTOMER_PAYMENT_OVERDUE` and its
 * siblings into `ai_alerts`, and `ai_reminders` holds everything the owner asked to be reminded of,
 * including the ones typed at the FROST composer ("remind me to pay my suppliers"). All of it is
 * then shown in exactly one place: inside the FROST panel, which somebody has to decide to open.
 * The maintainer's ask on 2026-09-22 was one line — *"reminders notification bell me dikh jane
 * chahiye"* — and it is really a complaint about that: the app knows, and never says.
 *
 * This module is the translation layer. It takes the two lists as the server sends them and returns
 * the notification-centre entries that **should currently be ringing**. It raises nothing and
 * retracts nothing itself; `App.jsx` does both, the same way it does for `orderNotifications.js`.
 *
 * ## Three rules this module exists to keep
 *
 * 1. **Stable keys.** The panel re-fetches on a timer. `notificationCenter.js` collapses repeats on
 *    `dedupeKey`, so a key that changes between two fetches turns one overdue customer into a fresh
 *    bell row every refresh, and a bell that grows while nothing changes is a bell that gets
 *    ignored — which costs more than never having built it. Every key here is derived from the
 *    underlying row's own identity and from nothing else: not the time, not the severity, not the
 *    row's position in the list.
 * 2. **No clock inside.** `nowMs` is a parameter. Whether a reminder is due, and whether a snooze
 *    has run out, are both decided against it. A `new Date()` in here would make every cutoff
 *    untestable and the suite time-of-day dependent — a bug this repo has already paid for.
 * 3. **A failed load never looks like a quiet shop.** The return carries a `status`, and the caller
 *    switches on that rather than on `items.length`. CLAUDE.md: errors must never render as zero,
 *    and "no alerts" beside a dead backend is that pitfall with the bell as its victim.
 *
 * ## The shapes this reads, and where they are defined
 *
 * `ai_alerts` and `ai_reminders` are declared in `backend/server.js` (`initializeDatabase`), and
 * served by `GET /api/ai/alerts` and `GET /api/ai/reminders` in
 * `backend/aiBusinessAssistantService.js`. What matters here:
 *
 * - **status** is `OPEN` (the column default), `ACKNOWLEDGED`, `SNOOZED` or `RESOLVED` — those four
 *   and no others; they are written only by `buildStatusChange`, which accepts `ACKNOWLEDGE`,
 *   `SNOOZE` and `RESOLVE`. There is no `DISMISSED` or `DONE` in this schema today, which is why
 *   the sets below list them as *also* meaning finished rather than pretending they are the truth.
 * - **alerts** carry `severity` — `CRITICAL`, `HIGH`, `ATTENTION` or `INFO` (see `severityFromRisk`).
 * - **reminders** carry `priority` from the same four-word vocabulary, and `due_at`, which is very
 *   often `NULL`: the reminders `POST` takes `req.body.due_at || null`, and the FROST composer in
 *   `App.jsx` sends no `due_at` at all. See {@link REMINDER_WITHOUT_DUE_DATE_RINGS}.
 * - The alerts route already hides resolved and still-snoozed rows; the reminders route hides only
 *   resolved ones, so **a reminder snoozed into next week arrives here looking ordinary**. Filtering
 *   it is this module's job, and skipping that would make the panel's Snooze button a lie.
 *
 * Everything above crosses a network before it arrives, so every field may be missing, null or the
 * wrong type, and nothing here may throw on any of it — an exception thrown while building a bell
 * row would take down the header that renders the bell. The rule `frostChats.js` follows applies
 * here too: tolerate anything, invent nothing.
 */

import { NOTIFICATION_SEVERITY } from "./notificationCenter.js";
import { canonicalInventoryId } from "./stockInventory.js";

/** Shown as the notification's source, so a bell row says which part of the app is talking. */
export const FROST_BELL_SOURCE = "FROST";

/** What a FROST bell row can be about. Part of the dedupe key, so these strings are stored. */
export const FROST_BELL_KIND = Object.freeze({
  ALERT: "ALERT",
  REMINDER: "REMINDER",
  FROST_UNREADABLE: "FROST_UNREADABLE",
});

/**
 * Whether the two lists were read at all.
 *
 * The caller switches on this, never on `items.length`, because an empty `items` is the *normal*
 * answer — most of the day nothing is overdue and nothing is due — and it is also what a broken
 * fetch would otherwise produce. Those two must never be told apart by counting.
 */
export const FROST_BELL_STATUS = Object.freeze({
  OK: "ok",
  UNREADABLE: "unreadable",
});

/**
 * Whether a reminder with no due date rings.
 *
 * It does, and that is the single most arguable decision in this file. An undated reminder is
 * neither "due now" nor "due later" — nobody set a later date for it. More to the point, the
 * reminders the owner creates by talking to FROST carry no `due_at` whatsoever: the composer in
 * `App.jsx` posts `reminder_type`, `priority`, `title` and `message`, and the route stores
 * `req.body.due_at || null`. Staying quiet for undated reminders would therefore silence exactly
 * the reminders the owner asked for by name, which is the feature request inverted.
 */
export const REMINDER_WITHOUT_DUE_DATE_RINGS = true;

/**
 * FROST's four-word severity vocabulary mapped onto the centre's.
 *
 * The centre has four levels but only three of them are problems — `SUCCESS` says something went
 * *right*, so it can never be the home of an alert. Four FROST levels into three slots means one
 * collapse, and the collapse belongs at the **top**: `CRITICAL` and `HIGH` both already mean "act
 * today" (a customer seriously overdue, a product at zero stock), so merging them loses a shade of
 * bad news that the FROST panel still shows in full. Collapsing at the bottom instead — folding
 * `ATTENTION` into `INFO` — would demote a thing that needs attention into a thing that does not,
 * and the bell's whole job is to be the thing that says which is which.
 *
 * An unrecognised severity becomes `WARNING`, never `INFO`: a severity this app does not know is a
 * contract violation, and rendering a violation at the quietest level available is the
 * "errors must never render as zero" pitfall wearing a different hat.
 */
export const FROST_SEVERITY_TO_NOTIFICATION = Object.freeze({
  CRITICAL: NOTIFICATION_SEVERITY.ERROR,
  HIGH: NOTIFICATION_SEVERITY.ERROR,
  ATTENTION: NOTIFICATION_SEVERITY.WARNING,
  INFO: NOTIFICATION_SEVERITY.INFO,
});

const UNKNOWN_FROST_SEVERITY = NOTIFICATION_SEVERITY.WARNING;

/**
 * Statuses that mean the work is over. `RESOLVED` is the only one this schema writes today; the
 * rest are the words a later hand would reach for to mean the same thing, and treating an
 * unrecognised "finished" word as open would ring the bell for something the owner already closed.
 */
const SETTLED_STATUSES = Object.freeze([
  "RESOLVED",
  "DONE",
  "COMPLETED",
  "CLOSED",
  "DISMISSED",
  "CANCELLED",
  "CANCELED",
]);

/**
 * Seen, therefore silent.
 *
 * `ACKNOWLEDGED` is written by the panel's "Review" button — the owner looking at the row and
 * saying so. The bell exists to carry what has *not* been seen yet, so an acknowledged row leaves
 * it. The work is not lost by this: the row is still `status <> 'RESOLVED'`, so it is still sitting
 * in FROST's own Alerts and Reminders lists where the owner put it.
 */
const ACKNOWLEDGED_STATUS = "ACKNOWLEDGED";

const SNOOZED_STATUS = "SNOOZED";

/**
 * Which row wins when two are equally severe.
 *
 * An alert before a reminder, because an alert is something the shop did not know until FROST
 * worked it out, while a reminder is something the owner already decided to do and simply has to be
 * handed back at the right moment. New bad news outranks a kept promise.
 */
const KIND_ORDER = Object.freeze({
  [FROST_BELL_KIND.FROST_UNREADABLE]: 0,
  [FROST_BELL_KIND.ALERT]: 1,
  [FROST_BELL_KIND.REMINDER]: 2,
});

const SEVERITY_ORDER = Object.freeze({
  [NOTIFICATION_SEVERITY.ERROR]: 3,
  [NOTIFICATION_SEVERITY.WARNING]: 2,
  [NOTIFICATION_SEVERITY.INFO]: 1,
  [NOTIFICATION_SEVERITY.SUCCESS]: 0,
});

const text = (value) => (typeof value === "string" ? value.trim() : "");

/** The first of several spellings that carries anything, so a renamed field degrades to the old one. */
const firstText = (...values) => {
  for (const value of values) {
    const found = text(value);
    if (found) return found;
  }
  return "";
};

const upper = (value) => text(value).toUpperCase();

/**
 * A timestamp in whichever shape it arrived: epoch number, ISO string, `Date`, or missing.
 *
 * Returns `null` when there is nothing usable — never a guess. A guessed due date is a reminder
 * that rings on the wrong day, and `pg` hands timestamps over as `Date` objects while the same
 * rows, once they have been through JSON, arrive as strings, so both have to be read the same way.
 */
const asTime = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const fromDate = value.getTime();
    return Number.isFinite(fromDate) ? fromDate : null;
  }
  if (typeof value !== "string") return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * A short, stable fingerprint of some text.
 *
 * Only ever used for a row that arrived with no id and no `dedup_key` at all. The alternative for
 * such a row is its position in the list, and a positional key is the exact thing this module is
 * built to avoid: the lists are ordered by severity and due date, so a row's position changes the
 * moment anything else changes, and a key built from it would re-ring on the next fetch.
 */
const fingerprint = (value) => {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (((hash << 5) + hash) ^ value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
};

/**
 * The key a repeat collapses onto, and the id of the row.
 *
 * Exported so `App.jsx` can retract an entry with `resolveNotification` once FROST stops returning
 * the row behind it — a payment collected should clear its own bell row rather than sit there
 * implying the customer still owes.
 *
 * `scope` says *which* identity the key was built from, and it is in the key rather than beside it
 * so that two namespaces cannot collide: an alert whose `dedup_key` happens to be the string "7"
 * and an alert whose id is `7` are different rows and must keep different keys.
 */
export const frostBellKey = (kind, scope, value) => (
  `frost:${String(kind).toLowerCase()}:${scope}:${canonicalInventoryId(value)}`
);

/**
 * How a row is identified, best first.
 *
 * `dedup_key` before `id`, because `dedup_key` names the *condition* — `upsertAlert` writes
 * `ON CONFLICT (dedup_key)`, so one overdue customer keeps one key for as long as they are overdue,
 * even across a row being rebuilt by a restore or a re-import that would hand the same condition a
 * brand new serial id. Ids are read as opaque strings and never coerced with `Number()`: "004" and
 * 4 are different rows, and this module's whole value is that two fetches of one row agree.
 */
const rowIdentity = (row) => {
  const dedup = firstText(row?.dedup_key, row?.dedupKey);
  if (dedup) return { scope: "dedup", value: dedup };
  const id = canonicalInventoryId(row?.id);
  if (id) return { scope: "row", value: id };
  // Nothing identifying at all. The words are the only stable thing left on the row, and they are
  // stable: the same underlying condition produces the same title and message on every fetch.
  const words = `${firstText(row?.title)}|${firstText(row?.message)}`;
  if (words === "|") return null;
  return { scope: "text", value: fingerprint(words) };
};

/** A gap in words. Whole units only — "2 days" reads faster than "2.4 days". */
const describeGap = (ms) => {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
};

/**
 * Has this row been put away, by any of the means the panel offers?
 *
 * Applied to alerts as well as reminders even though the alerts route already filters both cases in
 * SQL. The duplication is deliberate: the same filter written twice costs nothing, and the day
 * somebody serves these rows from the local snapshot instead of Postgres, the bell keeps its
 * promises without waiting for a second fix.
 */
const isPutAway = (row, nowMs) => {
  const status = upper(row?.status);
  if (SETTLED_STATUSES.includes(status)) return true;
  if (status === ACKNOWLEDGED_STATUS) return true;
  const snoozedUntil = asTime(row?.snoozed_until ?? row?.snoozedUntil);
  if (status === SNOOZED_STATUS) {
    // A snooze with no readable end is honoured rather than ignored. The route stores
    // `CURRENT_TIMESTAMP + INTERVAL '1 day'` when none was given, so an unreadable one here means
    // the field did not survive the trip — and ringing through a snooze the owner set is the one
    // thing that would make them stop trusting the button.
    return snoozedUntil === null || snoozedUntil > nowMs;
  }
  // A future snooze with the status left behind — an older client, or a partial write. The end date
  // is the owner's instruction; the status word is only bookkeeping about it.
  return snoozedUntil !== null && snoozedUntil > nowMs;
};

const severityFor = (value) => FROST_SEVERITY_TO_NOTIFICATION[upper(value)] || UNKNOWN_FROST_SEVERITY;

const buildItem = ({ kind, identity, severity, title, message, at, sticky, overdueMs, rowId }) => {
  const key = frostBellKey(kind, identity.scope, identity.value);
  return {
    id: key,
    dedupeKey: key,
    severity,
    title,
    message,
    source: FROST_BELL_SOURCE,
    at,
    sticky,
    // Carried for the screen and used as sort keys. `createNotification` reads only the fields
    // above and ignores these, so an item can be handed to it unchanged.
    kind,
    frostId: rowId ?? null,
    overdueMs,
  };
};

/**
 * One alert, or `null` when it should not ring.
 *
 * `INFO` alerts do not ring. They are FROST noticing something rather than FROST asking for
 * anything, they have no action attached, and a bell that carries them is a bell with a permanent
 * unread badge — at which point the badge means nothing and the overdue customer underneath it goes
 * unread too. They remain in the panel's Alerts list, which is where browsing belongs.
 */
const alertItem = (row, nowMs, at) => {
  if (!row || typeof row !== "object") return null;
  if (isPutAway(row, nowMs)) return null;
  const identity = rowIdentity(row);
  if (!identity) return null;
  const severity = severityFor(row.severity);
  if (severity === NOTIFICATION_SEVERITY.INFO) return null;

  const module = firstText(row.source_module, row.sourceModule);
  const body = firstText(row.message, row.title);
  const detectedAt = asTime(row.detected_at ?? row.detectedAt);
  return buildItem({
    kind: FROST_BELL_KIND.ALERT,
    identity,
    severity,
    // Never blank: `createNotification` throws on an empty title, and a row that made it this far
    // has *something* worth saying even when its title did not survive the trip.
    title: firstText(row.title, row.message) || "FROST raised an alert",
    message: module ? `${body} Raised from ${module}.` : body,
    at,
    // Still true until somebody acts, and clearing the bell must not hide an overdue customer.
    // Only the loud ones: a warning that survives "clear all" is a warning that outstays its use.
    sticky: severity === NOTIFICATION_SEVERITY.ERROR,
    overdueMs: detectedAt === null ? 0 : Math.max(0, nowMs - detectedAt),
    rowId: row.id,
  });
};

/** One reminder, or `null` when it should not ring. */
const reminderItem = (row, nowMs, at) => {
  if (!row || typeof row !== "object") return null;
  if (isPutAway(row, nowMs)) return null;
  const identity = rowIdentity(row);
  if (!identity) return null;

  const dueAt = asTime(row.due_at ?? row.dueAt);
  // Due next week is not due. The bell is for now; the panel is for the diary.
  if (dueAt !== null && dueAt > nowMs) return null;

  const overdueMs = dueAt === null ? 0 : Math.max(0, nowMs - dueAt);
  // `message` before `draft_message`: the draft is wording aimed at a *customer*, which reads
  // strangely in a bell row addressed to the owner, and it is only a fallback when the reminder
  // carries no explanation of its own.
  const body = firstText(row.message, row.draft_message, row.draftMessage);
  const timing = dueAt === null
    ? "No due date was set on it."
    : (overdueMs < 60000 ? "It is due now." : `It was due ${describeGap(overdueMs)} ago.`);
  return buildItem({
    kind: FROST_BELL_KIND.REMINDER,
    identity,
    severity: severityFor(row.priority),
    title: firstText(row.title, row.message) || "A FROST reminder is due",
    message: body ? `${body} ${timing}` : timing,
    at,
    // A reminder is something the owner asked for and can put away in the panel with one click, so
    // it does not need to resist "clear all" the way an unpaid customer does.
    sticky: false,
    overdueMs,
    rowId: row.id,
  });
};

/**
 * Worst first, and the same order every time.
 *
 * Severity, then kind (see {@link KIND_ORDER}), then how long the thing has been true, and finally
 * the dedupe key as a plain string compare. That last step is what makes the sort *total*: two rows
 * that tie on everything else still cannot swap places between two fetches, so the bell does not
 * reshuffle itself while somebody is reading it.
 */
const compareItems = (left, right) => (
  (SEVERITY_ORDER[right.severity] ?? 0) - (SEVERITY_ORDER[left.severity] ?? 0)
  || (KIND_ORDER[left.kind] ?? 99) - (KIND_ORDER[right.kind] ?? 99)
  || right.overdueMs - left.overdueMs
  || (left.dedupeKey < right.dedupeKey ? -1 : left.dedupeKey > right.dedupeKey ? 1 : 0)
);

/** The key the "FROST could not be read" row always occupies, so it collapses instead of stacking. */
export const FROST_UNREADABLE_KEY = frostBellKey(FROST_BELL_KIND.FROST_UNREADABLE, "all", "all");

const unreadable = (message, at) => ({
  status: FROST_BELL_STATUS.UNREADABLE,
  message,
  items: [{
    id: FROST_UNREADABLE_KEY,
    dedupeKey: FROST_UNREADABLE_KEY,
    severity: NOTIFICATION_SEVERITY.ERROR,
    title: "FROST alerts and reminders could not be read",
    message,
    source: FROST_BELL_SOURCE,
    at,
    // Sticky, because the condition is still true and clearing the bell would leave the owner
    // believing FROST is watching when it is not.
    sticky: true,
    kind: FROST_BELL_KIND.FROST_UNREADABLE,
    frostId: null,
    overdueMs: 0,
  }],
  keys: [FROST_UNREADABLE_KEY],
  skipped: 0,
});

/**
 * The FROST rows that should be ringing in the bell right now.
 *
 * ## Why an object and not an array
 *
 * `buildOrderNotifications` returns a bare array because the Orders screen holds the orders itself
 * and knows whether they loaded. These two lists arrive over the network from a route that can fail
 * on its own, and "nothing is wrong" and "I could not look" both end in zero rows. So the verdict
 * is in the return, as `status`, and the caller switches on it. `items` on a failure is not empty
 * either — it carries one loud error row — but a caller must not have to infer the difference from
 * a length.
 *
 * ## What the caller does with `keys`
 *
 * `keys` is every dedupe key this call is claiming. `App.jsx` raises each item with
 * `createNotification` + `addNotification`, then retracts any FROST key it raised previously that
 * is **not** in `keys`, so a resolved alert leaves the bell by itself. That retraction is only
 * correct when `status` is `ok`: on an unreadable fetch this module knows nothing about the rows it
 * raised last time, and retracting them would quietly delete real warnings because a request timed
 * out.
 *
 * @param {object} input
 * @param {Array<object>} input.alerts    rows from `GET /api/ai/alerts` (`data.alerts`)
 * @param {Array<object>} input.reminders rows from `GET /api/ai/reminders` (`data.reminders`)
 * @param {number} input.nowMs            current time in epoch milliseconds. Required: every cutoff
 *                                        here is measured against it, and reading a clock inside
 *                                        would make all of them untestable.
 * @param {string} [input.failure]        the load error, when the fetch failed. Any non-empty
 *                                        string makes the whole answer `unreadable`.
 * @returns {{status: string, items: Array<object>, keys: Array<string>, message: string, skipped: number}}
 */
export const buildFrostBellNotifications = ({ alerts, reminders, nowMs, failure = "" } = {}) => {
  // One guard around everything. A getter that throws, a Proxy, a string with a hostile `length` —
  // none of it may reach the header, because the bell is rendered by the same component tree as the
  // rest of the top bar and an exception here would take the whole application down with it.
  try {
    const stamp = asTime(nowMs);
    // `new Date(0)` rather than the device clock: with no readable time there is nothing honest to
    // stamp this with, and inventing one would put a wrong "when" on a row about a broken clock.
    const at = new Date(stamp === null ? 0 : stamp).toISOString();

    if (stamp === null) {
      return unreadable("The app could not read the current time, so FROST cannot tell which reminders are due. Close and reopen FroozERP.", at);
    }
    const failureMessage = text(failure);
    if (failureMessage) {
      return unreadable(`FROST alerts and reminders could not be loaded, so the bell is not watching them. ${failureMessage}`, at);
    }
    // Either list being the wrong shape is a failure of the whole answer, not a half-answer. A
    // caller that got one list and lost the other would be shown a bell that is confidently silent
    // about half of what FROST knows, which is worse than a bell that admits it cannot see.
    if (!Array.isArray(alerts) || !Array.isArray(reminders)) {
      return unreadable("FROST sent alerts or reminders in a shape this app could not read, so the bell cannot show them. Reopen FROST, and restart the app if it stays empty.", at);
    }

    const items = [];
    let skipped = 0;
    const take = (row, build) => {
      const item = build(row, stamp, at);
      if (item) items.push(item);
      // A row that is not an object, or one with no id, no dedup key and no words at all, cannot be
      // given a key that survives the next fetch, so it is dropped rather than rung once per
      // refresh forever. Counted, never silent: `skipped` is how the caller can log that FROST sent
      // something unusable. A row that is merely put away or not yet due is not counted — it was
      // read perfectly well and the answer was "no".
      else if (!row || typeof row !== "object" || !rowIdentity(row)) skipped += 1;
    };
    alerts.forEach((row) => take(row, alertItem));
    reminders.forEach((row) => take(row, reminderItem));
    items.sort(compareItems);

    // Two rows claiming one key would be raised twice and retracted once. It cannot happen for rows
    // that carry ids, but two id-less rows with identical words fingerprint the same, and the
    // second is a duplicate of the first by definition.
    const keys = [];
    const deduped = items.filter((item) => {
      if (keys.includes(item.dedupeKey)) return false;
      keys.push(item.dedupeKey);
      return true;
    });

    return { status: FROST_BELL_STATUS.OK, items: deduped, keys, message: "", skipped };
  } catch {
    return unreadable("FROST alerts and reminders could not be read, so the bell is not watching them. Reopen FROST, and restart the app if it stays empty.", new Date(0).toISOString());
  }
};
