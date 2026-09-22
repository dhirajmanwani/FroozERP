/**
 * What the bell must say about FROST, and what it must never say.
 *
 * The three that decide whether this feature is worth having:
 *   - one overdue customer is one bell row, no matter how many times the panel re-fetches,
 *   - a reminder the owner put away stays away, or the Snooze button is a lie,
 *   - a FROST that could not be read is an error, never a quiet bell implying all is well.
 *
 * Every case pins `nowMs` explicitly. Nothing here may depend on the host's clock or timezone.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  FROST_BELL_KIND,
  FROST_BELL_SOURCE,
  FROST_BELL_STATUS,
  FROST_UNREADABLE_KEY,
  buildFrostBellNotifications,
} from "./frostBellNotifications.js";
import { NOTIFICATION_SEVERITY, addNotification, createNotification } from "./notificationCenter.js";

const NOW = Date.UTC(2026, 8, 22, 6, 0, 0);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const isoAt = (ms) => new Date(ms).toISOString();

const alert = (overrides = {}) => ({
  id: 41,
  dedup_key: "customer-overdue:1:7",
  alert_type: "CUSTOMER_PAYMENT_OVERDUE",
  severity: "HIGH",
  status: "OPEN",
  source_module: "Accounts",
  linked_entity_type: "customer",
  linked_entity_id: "7",
  title: "Ram Traders payment overdue",
  message: "Ram Traders has outstanding 12500 from 2026-09-01.",
  detected_at: isoAt(NOW - (2 * HOUR)),
  snoozed_until: null,
  ...overrides,
});

const reminder = (overrides = {}) => ({
  id: 12,
  dedup_key: "OWNER_NOTE:manual::2026-09-22:1",
  reminder_type: "OWNER_NOTE",
  priority: "ATTENTION",
  status: "OPEN",
  due_at: isoAt(NOW - HOUR),
  title: "Pay the supplier for the Nashik grapes",
  message: "Follow up required",
  draft_message: "",
  snoozed_until: null,
  ...overrides,
});

const build = (input) => buildFrostBellNotifications({ alerts: [], reminders: [], nowMs: NOW, ...input });
const kinds = (result) => result.items.map((item) => item.kind);
const titles = (result) => result.items.map((item) => item.title);

test("an overdue customer FROST already knows about reaches the bell, with FROST named as the source", () => {
  // The whole complaint: FROST raises CUSTOMER_PAYMENT_OVERDUE and only the panel ever shows it.
  const result = build({ alerts: [alert()] });
  assert.equal(result.status, FROST_BELL_STATUS.OK);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].kind, FROST_BELL_KIND.ALERT);
  assert.equal(result.items[0].source, FROST_BELL_SOURCE);
  assert.match(result.items[0].title, /Ram Traders/);
  assert.match(result.items[0].message, /Accounts/, "the owner should be told which module noticed");
});

test("the same alert fetched twice keeps one key, so a panel on a timer cannot grow the bell", () => {
  // The failure this pins: a key derived from the fetch (a timestamp, an index, a severity) turns
  // one overdue customer into a new unread row every refresh until the bell is worthless.
  const first = build({ alerts: [alert()], reminders: [reminder()] });
  const second = buildFrostBellNotifications({
    alerts: [alert({ detected_at: isoAt(NOW - HOUR), severity: "CRITICAL" })],
    reminders: [reminder({ due_at: isoAt(NOW - (3 * HOUR)) })],
    // A later fetch, a later clock, a worse alert: none of it may move the key.
    nowMs: NOW + (5 * MINUTE),
  });
  assert.deepEqual(second.keys.sort(), first.keys.sort());
});

test("five ticks of the panel leave two rows in the bell, not ten", () => {
  // The same thing again, but proved through the centre that actually collapses repeats, because
  // that is where a wrong key would do its damage.
  let list = [];
  for (let tick = 0; tick < 5; tick += 1) {
    const result = build({ alerts: [alert()], reminders: [reminder()], nowMs: NOW + (tick * 1000) });
    for (const item of result.items) list = addNotification(list, createNotification(item));
  }
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((entry) => entry.count).sort(), [5, 5]);
  assert.ok(list.every((entry) => entry.id === entry.dedupeKey), "the id the centre keeps is the stable one");
});

test("a row keeps its key when its serial id changes, because the key names the condition", () => {
  // A restore or a re-import hands the same still-overdue customer a brand new SERIAL id. Keying on
  // the id alone would ring that customer a second time for a database event nobody can see.
  const before = build({ alerts: [alert({ id: 41 })] });
  const after = build({ alerts: [alert({ id: 908 })] });
  assert.deepEqual(after.keys, before.keys);
});

test("a resolved or acknowledged reminder does not ring", () => {
  // RESOLVED and ACKNOWLEDGED are the words `buildStatusChange` writes. Acknowledged means the
  // owner pressed Review and looked at it; the bell carries what has not been seen.
  for (const status of ["RESOLVED", "ACKNOWLEDGED", "DONE", "DISMISSED", "resolved"]) {
    const result = build({ reminders: [reminder({ status })] });
    assert.deepEqual(kinds(result), [], `${status} means the owner has dealt with it`);
    assert.equal(result.status, FROST_BELL_STATUS.OK, "put away is not a failure");
  }
});

test("a reminder snoozed into next week stays quiet, and rings once the snooze runs out", () => {
  // The reminders route filters only `status <> 'RESOLVED'`, so a snoozed reminder arrives here
  // looking ordinary. Ringing it anyway would make the panel's Snooze button do nothing at all.
  const snoozed = reminder({ status: "SNOOZED", snoozed_until: isoAt(NOW + (7 * DAY)) });
  assert.deepEqual(kinds(build({ reminders: [snoozed] })), []);

  const expired = buildFrostBellNotifications({ alerts: [], reminders: [snoozed], nowMs: NOW + (8 * DAY) });
  assert.deepEqual(kinds(expired), [FROST_BELL_KIND.REMINDER], "the snooze ended, so the reminder is owed again");
});

test("a snooze whose end date did not survive the trip is honoured rather than ignored", () => {
  const result = build({ reminders: [reminder({ status: "SNOOZED", snoozed_until: null })] });
  assert.deepEqual(kinds(result), [], "an unreadable end date is not permission to ring through a snooze");
});

test("a future snooze silences a row even when the status word was left behind", () => {
  // A partial write, or an older client that set the date and not the status. The date is the
  // owner's instruction; the status word is bookkeeping about it.
  const result = build({
    alerts: [alert({ status: "OPEN", snoozed_until: isoAt(NOW + DAY) })],
    reminders: [reminder({ status: "OPEN", snoozed_until: isoAt(NOW + DAY) })],
  });
  assert.deepEqual(kinds(result), []);
});

test("a reminder due next week does not ring, and one due now does", () => {
  assert.deepEqual(kinds(build({ reminders: [reminder({ due_at: isoAt(NOW + (7 * DAY)) })] })), [], "next week is the diary's job");
  assert.deepEqual(kinds(build({ reminders: [reminder({ due_at: isoAt(NOW + MINUTE) })] })), [], "a minute early is still early");

  const dueNow = build({ reminders: [reminder({ due_at: isoAt(NOW) })] });
  assert.deepEqual(kinds(dueNow), [FROST_BELL_KIND.REMINDER]);
  assert.match(dueNow.items[0].message, /due now/i);

  const overdue = build({ reminders: [reminder({ due_at: isoAt(NOW - (3 * DAY)) })] });
  assert.match(overdue.items[0].message, /3 days ago/, "the owner should be told how late it is");
});

test("a reminder with no due date rings, because that is every reminder the owner dictates to FROST", () => {
  // `POST /api/ai/reminders` stores `req.body.due_at || null`, and the FROST composer in App.jsx
  // sends no due_at at all. Treating undated as "not yet" would silence the exact reminders the
  // maintainer asked to see in the bell.
  const result = build({ reminders: [reminder({ due_at: null })] });
  assert.deepEqual(kinds(result), [FROST_BELL_KIND.REMINDER]);
  assert.match(result.items[0].message, /no due date/i, "and it must say so rather than imply a deadline");
});

test("FROST's four severities land on three notification levels, worst collapsed into worst", () => {
  // Four FROST words into three problem levels means one collapse. It happens at the top, where
  // both members already mean "act today" -- collapsing at the bottom would demote ATTENTION.
  const severityOf = (severity) => build({ alerts: [alert({ severity })] }).items[0]?.severity;
  assert.equal(severityOf("CRITICAL"), NOTIFICATION_SEVERITY.ERROR);
  assert.equal(severityOf("HIGH"), NOTIFICATION_SEVERITY.ERROR);
  assert.equal(severityOf("ATTENTION"), NOTIFICATION_SEVERITY.WARNING);
  assert.equal(severityOf("PURPLE"), NOTIFICATION_SEVERITY.WARNING, "an unknown severity is a contract violation, not the quietest level");
  assert.equal(severityOf(null), NOTIFICATION_SEVERITY.WARNING);
});

test("an INFO alert stays in the panel, so the badge keeps meaning something", () => {
  const result = build({ alerts: [alert({ severity: "INFO" })] });
  assert.deepEqual(kinds(result), [], "a bell that rings for everything is a bell nobody reads");
  assert.equal(result.status, FROST_BELL_STATUS.OK);
});

test("a reminder the owner asked for rings even at the quietest priority", () => {
  // Unlike an INFO alert: nobody asked FROST to notice, but somebody did ask to be reminded.
  const result = build({ reminders: [reminder({ priority: "INFO" })] });
  assert.deepEqual(kinds(result), [FROST_BELL_KIND.REMINDER]);
  assert.equal(result.items[0].severity, NOTIFICATION_SEVERITY.INFO);
});

test("an error-level alert resists clear-all, and a reminder does not", () => {
  const result = build({ alerts: [alert({ severity: "CRITICAL" })], reminders: [reminder()] });
  const byKind = Object.fromEntries(result.items.map((item) => [item.kind, item]));
  assert.equal(byKind[FROST_BELL_KIND.ALERT].sticky, true, "clearing the bell must not hide an overdue customer");
  assert.equal(byKind[FROST_BELL_KIND.REMINDER].sticky, false, "the owner can put a reminder away in the panel");
});

test("a failed load is an error row and says so in the status, never an empty bell", () => {
  const result = build({ alerts: null, reminders: null, failure: "Network Error" });
  assert.equal(result.status, FROST_BELL_STATUS.UNREADABLE, "the caller must not have to infer this from a length");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].kind, FROST_BELL_KIND.FROST_UNREADABLE);
  assert.equal(result.items[0].severity, NOTIFICATION_SEVERITY.ERROR);
  assert.equal(result.items[0].sticky, true);
  assert.match(result.items[0].message, /Network Error/, "the reason the fetch failed has to reach the owner");
  assert.deepEqual(result.keys, [FROST_UNREADABLE_KEY]);
});

test("a quiet shop and a broken FROST are told apart by status, not by counting rows", () => {
  // The pitfall CLAUDE.md names: `Products: 0` beside a non-zero stock value. Here it would be a
  // silent bell beside a dead backend, which is the same bug with more at stake.
  const quiet = build({ alerts: [], reminders: [] });
  assert.equal(quiet.status, FROST_BELL_STATUS.OK);
  assert.deepEqual(quiet.items, []);
  assert.deepEqual(quiet.keys, []);

  const broken = build({ alerts: undefined, reminders: undefined });
  assert.equal(broken.status, FROST_BELL_STATUS.UNREADABLE);
  assert.notDeepEqual(broken.items, [], "an unreadable FROST must be louder than a quiet one");
});

test("half a payload is a whole failure, not a confidently silent bell about the other half", () => {
  for (const half of [{ alerts: [alert()], reminders: "reminders" }, { alerts: {}, reminders: [reminder()] }]) {
    const result = build(half);
    assert.equal(result.status, FROST_BELL_STATUS.UNREADABLE);
    assert.equal(result.items[0].kind, FROST_BELL_KIND.FROST_UNREADABLE);
  }
});

test("malformed input returns a verdict instead of throwing, whatever shape it takes", () => {
  // A throw here happens inside the header that renders the bell, and takes the whole app with it.
  const shapes = [
    undefined,
    { alerts: 7, reminders: 7 },
    { alerts: "[]", reminders: "[]" },
    { alerts: [null, 3, "alert", []], reminders: [undefined, {}, { title: 5, message: {} }] },
    { alerts: [alert()], reminders: [reminder()], nowMs: "not a time" },
    { alerts: [alert({ detected_at: "yesterday" })], reminders: [reminder({ due_at: {} })] },
  ];
  for (const shape of shapes) {
    const result = buildFrostBellNotifications(shape);
    assert.ok(Array.isArray(result.items), `${JSON.stringify(shape)} must still answer`);
    assert.ok(Object.values(FROST_BELL_STATUS).includes(result.status));
  }
});

test("a payload that fights back is caught rather than escaping into the header", () => {
  const hostile = { get title() { throw new Error("no"); } };
  const result = buildFrostBellNotifications({ alerts: [hostile], reminders: [], nowMs: NOW });
  assert.equal(result.status, FROST_BELL_STATUS.UNREADABLE, "unreadable, because a row was lost and this cannot say which");
});

test("an unreadable clock is reported rather than guessed at", () => {
  // Every cutoff in this module is measured against nowMs. Substituting the device clock would make
  // "due" mean something different on a machine whose time is wrong, which is the machine that most
  // needs to be told.
  const result = build({ reminders: [reminder()], nowMs: null });
  assert.equal(result.status, FROST_BELL_STATUS.UNREADABLE);
  assert.match(result.items[0].message, /current time/i);
});

test("a row with nothing to identify it is dropped and counted, never rung once per refresh", () => {
  // A positional key would re-ring the row every time the list re-sorts, which it does on every
  // fetch. Silently dropping it would be worse: `skipped` is how the caller can log it.
  const result = build({ alerts: [{ severity: "HIGH", status: "OPEN" }], reminders: [{ priority: "HIGH" }] });
  assert.deepEqual(result.items, []);
  assert.equal(result.skipped, 2);
  assert.equal(result.status, FROST_BELL_STATUS.OK, "one unusable row is not a failed load");
});

test("a row carrying only words still gets a key, and the same key on the next fetch", () => {
  const bare = { severity: "HIGH", status: "OPEN", title: "Cold room door left open", message: "Since 05:40." };
  const first = build({ alerts: [bare] });
  const second = buildFrostBellNotifications({ alerts: [{ ...bare }], reminders: [], nowMs: NOW + HOUR });
  assert.equal(first.items.length, 1);
  assert.deepEqual(second.keys, first.keys);
  assert.equal(first.skipped, 0);
});

test('ids "004" and 4 are different rows and get a bell row each', () => {
  const result = build({
    alerts: [
      { id: "004", severity: "HIGH", status: "OPEN", title: "Apples low", message: "Reorder." },
      { id: 4, severity: "HIGH", status: "OPEN", title: "Bananas low", message: "Reorder." },
    ],
  });
  assert.equal(result.items.length, 2, "coercing an id with Number() would merge two shops' worth of trouble into one row");
  assert.equal(new Set(result.keys).size, 2);
});

test("an alert and a reminder that share an id do not share a bell row", () => {
  const result = build({
    alerts: [alert({ id: 5, dedup_key: "" })],
    reminders: [reminder({ id: 5, dedup_key: "" })],
  });
  assert.equal(new Set(result.keys).size, 2);
});

test("running twice over the same lists gives identical rows in identical places", () => {
  const alerts = [
    alert({ id: 3, dedup_key: "low-stock:1:9", severity: "ATTENTION", title: "Grapes stock needs attention" }),
    alert({ id: 1, dedup_key: "customer-overdue:1:2", severity: "CRITICAL", title: "Shah Stores payment overdue" }),
  ];
  const reminders = [reminder({ id: 8, dedup_key: "r-8", priority: "HIGH" }), reminder({ id: 9, dedup_key: "r-9" })];
  const first = buildFrostBellNotifications({ alerts, reminders, nowMs: NOW });
  const second = buildFrostBellNotifications({ alerts, reminders, nowMs: NOW });
  assert.deepEqual(second, first, "a bell fed by a timer must not reshuffle while it is being read");

  const reversed = buildFrostBellNotifications({ alerts: [...alerts].reverse(), reminders: [...reminders].reverse(), nowMs: NOW });
  assert.deepEqual(reversed.items, first.items, "the server's ordering must not change the bell's");
});

test("the worst rows come first, and an alert outranks a reminder of equal weight", () => {
  const result = build({
    alerts: [
      alert({ id: 2, dedup_key: "a-attention", severity: "ATTENTION", title: "Grapes stock needs attention" }),
      alert({ id: 1, dedup_key: "a-critical", severity: "CRITICAL", title: "Shah Stores payment overdue" }),
    ],
    reminders: [reminder({ id: 7, dedup_key: "r-7", priority: "ATTENTION", title: "Call the Nashik supplier" })],
  });
  assert.deepEqual(titles(result), [
    "Shah Stores payment overdue",
    "Grapes stock needs attention",
    "Call the Nashik supplier",
  ]);
});

test("every row this module produces is accepted by the real createNotification, unchanged", () => {
  // Including the blank-title case, which `createNotification` throws on -- a row whose title did
  // not survive the network must still become a readable bell entry rather than an exception.
  const result = build({
    alerts: [
      alert(),
      alert({ id: 77, dedup_key: "a-77", title: "", message: "Cold room above 8C for 40 minutes." }),
      alert({ id: 78, dedup_key: "a-78", title: null, message: null }),
    ],
    reminders: [
      reminder(),
      reminder({ id: 88, dedup_key: "r-88", title: "   ", message: "", draft_message: "" }),
      reminder({ id: 89, dedup_key: "r-89", title: 5, message: { text: "no" } }),
    ],
  });
  const failure = build({ alerts: null, reminders: null, failure: "timeout of 12000ms exceeded" });
  const allowed = Object.values(NOTIFICATION_SEVERITY);

  for (const item of [...result.items, ...failure.items]) {
    const notification = createNotification(item);
    assert.ok(allowed.includes(notification.severity), `${item.severity} is not a severity the centre knows`);
    assert.equal(notification.dedupeKey, item.dedupeKey, "the key the centre stores must be the stable one");
    assert.equal(notification.id, item.id);
    assert.equal(notification.source, FROST_BELL_SOURCE);
    assert.ok(notification.title.length > 0);
    assert.equal(notification.at, item.at, "the timestamp must come from nowMs, not from the centre's own clock");
  }
  assert.ok(result.items.length >= 5, "every one of those rows is worth saying, blank fields and all");
});

test("timestamps arrive as ISO text, as numbers and as Date objects, and all three read the same", () => {
  // `pg` hands timestamps back as Date objects; the same rows, once through JSON, arrive as strings.
  const due = NOW - (2 * HOUR);
  const messages = [isoAt(due), due, new Date(due)].map((due_at) => build({ reminders: [reminder({ due_at })] }).items[0].message);
  assert.equal(new Set(messages).size, 1, "one moment, three spellings, one sentence");
  assert.match(messages[0], /2 hours ago/);
});

test("the bell row is written for a shop owner, not for a programmer", () => {
  const result = build({ alerts: [alert()], reminders: [reminder()] });
  for (const item of result.items) {
    assert.doesNotMatch(item.title, /dedup_key|snoozed_until|null|undefined/);
    assert.doesNotMatch(item.message, /dedup_key|snoozed_until|undefined|\[object/);
  }
});

test("the keys are exactly what the caller must retract when a row stops being returned", () => {
  // App.jsx retracts every FROST key it raised that is no longer in `keys`, so the list has to be
  // complete and has to match the items one for one.
  const result = build({ alerts: [alert()], reminders: [reminder(), reminder({ id: 13, dedup_key: "r-13" })] });
  assert.deepEqual(result.keys, result.items.map((item) => item.dedupeKey));
  assert.equal(new Set(result.keys).size, result.keys.length, "two rows claiming one key would be raised twice and retracted once");

  const collected = build({ alerts: [], reminders: [reminder()] });
  assert.ok(!collected.keys.includes(result.items.find((item) => item.kind === FROST_BELL_KIND.ALERT).dedupeKey),
    "an alert FROST no longer returns must fall out of the keys so it can be retracted");
});
