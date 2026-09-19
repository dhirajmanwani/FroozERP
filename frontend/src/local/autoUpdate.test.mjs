import test from "node:test";
import assert from "node:assert/strict";

import { CONNECTIVITY_MODES } from "./connectivityMode.js";
import {
  AUTO_UPDATE_DEFAULTS,
  AUTO_UPDATE_DEFAULT_SCHEDULE,
  WEEKDAY_NAMES,
  describeAutoUpdateNotice,
  formatMinuteOfDay,
  normalizeInstallSchedule,
  resolveInstallDecision,
  shouldCheckForUpdate,
  shouldDownloadUpdate,
  withinInstallWindow,
} from "./autoUpdate.js";

// Start and end on the same minute means "any hour of these days". The install tests below are
// about the idle and busy rules, so they open the window fully and leave the hours to their own
// tests further down.
const ALWAYS = { days: [0, 1, 2, 3, 4, 5, 6], startMinute: 0, endMinute: 0 };

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-09-19T10:00:00.000Z");

const checkable = (overrides = {}) => ({
  enabled: true,
  feedConfigured: true,
  updaterAvailable: true,
  online: true,
  connectivityMode: CONNECTIVITY_MODES.AUTO,
  phase: "idle",
  lastCheckedAt: null,
  now: NOW,
  ...overrides,
});

test("a device switched on and never checked checks straight away", () => {
  const decision = shouldCheckForUpdate(checkable());
  assert.equal(decision.check, true);
  assert.equal(decision.reason, "FIRST_CHECK");
});

test("a device that has not been switched on never checks", () => {
  // The switch is the whole consent model. Without it the app must behave exactly as it did
  // before this module existed.
  const decision = shouldCheckForUpdate(checkable({ enabled: false }));
  assert.equal(decision.check, false);
  assert.equal(decision.reason, "AUTO_UPDATE_OFF");
});

test("LOCAL_ONLY is refused before anything else that could reach the network", () => {
  // LOCAL_ONLY promises zero outbound connections. An update check is an outbound connection, so
  // it is refused here rather than being left to a lower layer to block.
  const decision = shouldCheckForUpdate(checkable({ connectivityMode: CONNECTIVITY_MODES.LOCAL_ONLY }));
  assert.equal(decision.check, false);
  assert.equal(decision.reason, "LOCAL_ONLY");
});

test("LOCAL_ONLY is refused even when the app believes it is online", () => {
  const decision = shouldCheckForUpdate(checkable({
    connectivityMode: CONNECTIVITY_MODES.LOCAL_ONLY,
    online: true,
    lastCheckedAt: null,
  }));
  assert.equal(decision.check, false);
  assert.equal(decision.reason, "LOCAL_ONLY");
});

test("an offline device does not check", () => {
  const decision = shouldCheckForUpdate(checkable({ online: false }));
  assert.equal(decision.check, false);
  assert.equal(decision.reason, "OFFLINE");
});

test("a browser tab with no desktop shell does not check", () => {
  const decision = shouldCheckForUpdate(checkable({ updaterAvailable: false }));
  assert.equal(decision.check, false);
  assert.equal(decision.reason, "NOT_DESKTOP_APP");
});

test("no feed means no check, and says so rather than looking up to date", () => {
  const decision = shouldCheckForUpdate(checkable({ feedConfigured: false }));
  assert.equal(decision.check, false);
  assert.equal(decision.reason, "FEED_NOT_CONFIGURED");
});

test("a check already in flight is not started twice", () => {
  for (const phase of ["checking", "downloading", "installing"]) {
    const decision = shouldCheckForUpdate(checkable({ phase }));
    assert.equal(decision.check, false, `phase ${phase} must not start a second check`);
    assert.equal(decision.reason, "ALREADY_RUNNING");
  }
});

test("a check just done is not repeated", () => {
  const decision = shouldCheckForUpdate(checkable({ lastCheckedAt: NOW - HOUR }));
  assert.equal(decision.check, false);
  assert.equal(decision.reason, "NOT_DUE");
  assert.ok(decision.dueAt, "the caller must be able to say when the next one is");
});

test("a check becomes due after the interval", () => {
  const decision = shouldCheckForUpdate(checkable({ lastCheckedAt: NOW - (5 * HOUR) }));
  assert.equal(decision.check, true);
  assert.equal(decision.reason, "DUE");
});

test("a failed check retries sooner than a successful one", () => {
  const twentyMinutesAgo = NOW - (20 * 60 * 1000);
  assert.equal(shouldCheckForUpdate(checkable({ lastCheckedAt: twentyMinutesAgo })).check, false);
  const retry = shouldCheckForUpdate(checkable({ lastCheckedAt: twentyMinutesAgo, lastCheckFailed: true }));
  assert.equal(retry.check, true);
  assert.equal(retry.reason, "RETRY_DUE");
});

test("timestamps may arrive as ISO strings or Date objects", () => {
  // The shell stores these as ISO strings; tests and timers hand over numbers. All three have to
  // mean the same instant or the interval silently becomes "every render".
  const iso = shouldCheckForUpdate(checkable({ lastCheckedAt: new Date(NOW - HOUR).toISOString() }));
  const date = shouldCheckForUpdate(checkable({ lastCheckedAt: new Date(NOW - HOUR) }));
  const ms = shouldCheckForUpdate(checkable({ lastCheckedAt: NOW - HOUR }));
  assert.deepEqual([iso.check, date.check, ms.check], [false, false, false]);
});

test("an unreadable timestamp is treated as never checked, not as just checked", () => {
  // Falling the other way would park a device forever on a corrupt value with nothing on screen.
  const decision = shouldCheckForUpdate(checkable({ lastCheckedAt: "not a date" }));
  assert.equal(decision.check, true);
  assert.equal(decision.reason, "FIRST_CHECK");
});

const downloadable = (overrides = {}) => ({
  enabled: true,
  phase: "update_available",
  updateAvailable: true,
  alreadyDownloaded: false,
  online: true,
  connectivityMode: CONNECTIVITY_MODES.AUTO,
  ...overrides,
});

test("an available update downloads itself", () => {
  const decision = shouldDownloadUpdate(downloadable());
  assert.equal(decision.download, true);
  assert.equal(decision.reason, "UPDATE_AVAILABLE");
});

test("nothing is downloaded twice", () => {
  assert.equal(shouldDownloadUpdate(downloadable({ alreadyDownloaded: true })).download, false);
});

test("LOCAL_ONLY and offline block the download as well as the check", () => {
  assert.equal(shouldDownloadUpdate(downloadable({ connectivityMode: CONNECTIVITY_MODES.LOCAL_ONLY })).download, false);
  assert.equal(shouldDownloadUpdate(downloadable({ online: false })).download, false);
});

const installable = (overrides = {}) => ({
  enabled: true,
  readyToInstall: true,
  signatureVerified: true,
  phase: "ready_to_install",
  busyReasons: [],
  lastActivityAt: NOW - (10 * 60 * 1000),
  schedule: ALWAYS,
  now: NOW,
  ...overrides,
});

test("an idle machine with a verified update installs it", () => {
  const decision = resolveInstallDecision(installable());
  assert.equal(decision.install, true);
  assert.equal(decision.reason, "IDLE");
});

test("a machine in the middle of a bill is never restarted", () => {
  // The rule this module exists for. A restart mid-sale loses the counter's work and the customer
  // is standing there.
  const decision = resolveInstallDecision(installable({
    busyReasons: [{ id: "bill", label: "a bill in progress" }],
  }));
  assert.equal(decision.install, false);
  assert.equal(decision.reason, "DEVICE_BUSY");
  assert.deepEqual(decision.waitingFor, ["a bill in progress"]);
});

test("being busy beats an explicit Install now, and the screen is told what it is waiting on", () => {
  const decision = resolveInstallDecision(installable({
    requestedByUser: true,
    busyReasons: [{ id: "print", label: "a bill printing" }, { id: "sync", label: "sync in progress" }],
  }));
  assert.equal(decision.install, false);
  assert.deepEqual(decision.waitingFor, ["a bill printing", "sync in progress"]);
});

test("an unverified signature is never installed, however it was asked for", () => {
  // No override exists for this one on purpose. A payload that will not verify is either corrupt
  // or tampered with, and installing it quietly on every counter is the worst thing this file
  // could do.
  for (const extra of [{}, { requestedByUser: true }, { busyReasons: [] }, { lastActivityAt: null }]) {
    const decision = resolveInstallDecision(installable({ signatureVerified: false, ...extra }));
    assert.equal(decision.install, false);
    assert.equal(decision.reason, "SIGNATURE_NOT_VERIFIED");
  }
});

test("a machine still in use waits, and says how long it has been idle", () => {
  const decision = resolveInstallDecision(installable({ lastActivityAt: NOW - (30 * 1000) }));
  assert.equal(decision.install, false);
  assert.equal(decision.reason, "IN_USE");
  assert.equal(decision.idleForMs, 30 * 1000);
});

test("a person pressing Install now does not have to wait out the idle window", () => {
  const decision = resolveInstallDecision(installable({ lastActivityAt: NOW, requestedByUser: true }));
  assert.equal(decision.install, true);
  assert.equal(decision.reason, "REQUESTED_BY_USER");
});

test("a device with the switch off still installs when a person asks", () => {
  // Switching automatic updates off is about the machine acting on its own. It was never meant to
  // take the manual buttons away from the person standing at it.
  const decision = resolveInstallDecision(installable({ enabled: false, requestedByUser: true }));
  assert.equal(decision.install, true);
});

test("a device with the switch off never installs by itself", () => {
  const decision = resolveInstallDecision(installable({ enabled: false }));
  assert.equal(decision.install, false);
  assert.equal(decision.reason, "AUTO_UPDATE_OFF");
});

test("a machine nobody has touched since it started counts as idle", () => {
  const decision = resolveInstallDecision(installable({ lastActivityAt: null }));
  assert.equal(decision.install, true);
  assert.equal(decision.reason, "IDLE");
});

test("malformed busy entries are dropped rather than rendering as blanks", () => {
  const decision = resolveInstallDecision(installable({
    busyReasons: [null, { label: "no id" }, { id: "bill", label: "a bill in progress" }],
  }));
  assert.deepEqual(decision.waitingFor, ["a bill in progress"]);
});

test("a busy entry with no label still names itself", () => {
  const decision = resolveInstallDecision(installable({ busyReasons: [{ id: "backup" }] }));
  assert.deepEqual(decision.waitingFor, ["backup"]);
});

test("an up-to-date counter carries no badge", () => {
  assert.equal(describeAutoUpdateNotice({ enabled: true, phase: "up_to_date" }), null);
});

test("a waiting install says what it is waiting for", () => {
  const notice = describeAutoUpdateNotice({
    enabled: true,
    phase: "ready_to_install",
    latestVersion: "1.0.73",
    decision: { install: false, reason: "DEVICE_BUSY", waitingFor: ["a bill in progress"] },
  });
  assert.match(notice.text, /1\.0\.73/);
  assert.match(notice.text, /a bill in progress/);
});

test("a ready update offers to be installed now", () => {
  const notice = describeAutoUpdateNotice({ enabled: true, phase: "ready_to_install", latestVersion: "1.0.73" });
  assert.equal(notice.actionLabel, "Install now");
});

test("a failed signature is said out loud, not retried in silence", () => {
  const notice = describeAutoUpdateNotice({
    enabled: true,
    phase: "ready_to_install",
    decision: { install: false, reason: "SIGNATURE_NOT_VERIFIED", waitingFor: [] },
  });
  assert.equal(notice.tone, "warning");
  assert.match(notice.text, /signature could not be verified/i);
});

test("one failed check is bad luck, two in a row is worth saying", () => {
  // A shop that silently stops checking looks exactly like a shop that is up to date, and that is
  // how a counter ends up months behind without anybody noticing.
  assert.equal(describeAutoUpdateNotice({ enabled: true, phase: "error", consecutiveFailures: 1 }), null);
  const notice = describeAutoUpdateNotice({
    enabled: true,
    phase: "error",
    consecutiveFailures: 2,
    failureMessage: "the update feed could not be reached",
  });
  assert.equal(notice.tone, "warning");
  assert.match(notice.text, /could not be reached/);
});

test("an unnamed version still reads as a sentence", () => {
  const notice = describeAutoUpdateNotice({ enabled: true, phase: "ready_to_install", latestVersion: "" });
  assert.match(notice.text, /^An update is ready/);
});

test("the intervals are the ones the comments describe", () => {
  assert.equal(AUTO_UPDATE_DEFAULTS.checkIntervalMs, 4 * HOUR);
  assert.equal(AUTO_UPDATE_DEFAULTS.retryIntervalMs, 15 * 60 * 1000);
  assert.equal(AUTO_UPDATE_DEFAULTS.idleBeforeInstallMs, 5 * 60 * 1000);
});

// --- the hours each device was given ------------------------------------------------------------
//
// Every Date below is built with the local-time constructor on purpose. The window is the
// device's own wall clock -- somebody choosing "Saturday night" means night where the counter
// stands -- so a test written in UTC would pass or fail depending on where it ran.
//
// 19 Sep 2026 is a Saturday, 20 Sep a Sunday, 21 Sep a Monday.

const at = (day, hour, minute = 0) => new Date(2026, 8, day, hour, minute, 0, 0);

test("the default window is every night from ten to six", () => {
  assert.deepEqual([...AUTO_UPDATE_DEFAULT_SCHEDULE.days], [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(formatMinuteOfDay(AUTO_UPDATE_DEFAULT_SCHEDULE.startMinute), "22:00");
  assert.equal(formatMinuteOfDay(AUTO_UPDATE_DEFAULT_SCHEDULE.endMinute), "06:00");
});

test("a working afternoon is outside the default window", () => {
  const window = withinInstallWindow({ now: at(19, 15) });
  assert.equal(window.within, false);
  assert.equal(window.reason, "OUTSIDE_WINDOW");
  assert.equal(new Date(window.nextOpensAt).getHours(), 22);
  assert.equal(new Date(window.nextOpensAt).getDate(), 19, "tonight, not tomorrow night");
});

test("late at night and early morning are both inside a window that crosses midnight", () => {
  assert.equal(withinInstallWindow({ now: at(19, 23, 30) }).within, true);
  assert.equal(withinInstallWindow({ now: at(20, 5, 30) }).within, true);
  assert.equal(withinInstallWindow({ now: at(20, 6, 0) }).within, false, "six o'clock is the end, not still inside");
  assert.equal(withinInstallWindow({ now: at(19, 21, 59) }).within, false);
});

test("a weekend-only device ignores weeknights", () => {
  // The whole point of the per-device setting: one counter on Saturday, another on Sunday, so a
  // bad release arrives in waves instead of everywhere at once.
  const saturdayNights = { days: ["SAT"], startMinute: 22 * 60, endMinute: 6 * 60 };
  assert.equal(withinInstallWindow({ now: at(21, 23), schedule: saturdayNights }).within, false, "Monday night");
  assert.equal(withinInstallWindow({ now: at(19, 23), schedule: saturdayNights }).within, true, "Saturday night");
});

test("a window that crosses midnight belongs to the day it starts on", () => {
  // Somebody picking Saturday means Saturday night into Sunday morning. Sunday's own small hours
  // are not Sunday's window.
  const saturdayNights = { days: ["SAT"], startMinute: 22 * 60, endMinute: 6 * 60 };
  assert.equal(withinInstallWindow({ now: at(20, 3), schedule: saturdayNights }).within, true, "Sunday 3am is Saturday's window");
  const sundayNights = { days: ["SUN"], startMinute: 22 * 60, endMinute: 6 * 60 };
  assert.equal(withinInstallWindow({ now: at(20, 3), schedule: sundayNights }).within, false, "Sunday 3am is not Sunday's own window");
  assert.equal(withinInstallWindow({ now: at(20, 23), schedule: sundayNights }).within, true);
});

test("a window inside one day does not wrap around", () => {
  const lunchtime = { days: [6], startMinute: 13 * 60, endMinute: 14 * 60 };
  assert.equal(withinInstallWindow({ now: at(19, 13, 30), schedule: lunchtime }).within, true);
  assert.equal(withinInstallWindow({ now: at(19, 3), schedule: lunchtime }).within, false);
  assert.equal(withinInstallWindow({ now: at(19, 23), schedule: lunchtime }).within, false);
});

test("the next opening is found on a later day when today has none", () => {
  const sundayNights = { days: ["SUN"], startMinute: 22 * 60, endMinute: 6 * 60 };
  const window = withinInstallWindow({ now: at(19, 15), schedule: sundayNights });
  assert.equal(window.within, false);
  const opens = new Date(window.nextOpensAt);
  assert.equal(opens.getDay(), 0);
  assert.equal(opens.getDate(), 20);
  assert.equal(opens.getHours(), 22);
});

test("start and end on the same minute means the whole of those days", () => {
  const allSaturday = { days: ["SAT"], startMinute: 0, endMinute: 0 };
  assert.equal(withinInstallWindow({ now: at(19, 4), schedule: allSaturday }).within, true);
  assert.equal(withinInstallWindow({ now: at(19, 16), schedule: allSaturday }).within, true);
  assert.equal(withinInstallWindow({ now: at(20, 16), schedule: allSaturday }).within, false);
});

test("day names and day numbers mean the same thing", () => {
  const byName = normalizeInstallSchedule({ days: ["sat", "Sunday", "MON"] });
  assert.deepEqual(byName.days, [0, 1, 6]);
  assert.deepEqual(normalizeInstallSchedule({ days: [0, 1, 6] }).days, [0, 1, 6]);
  assert.deepEqual(WEEKDAY_NAMES[6], "SAT");
});

test("times may be stored as \"22:00\" or as a minute count", () => {
  assert.equal(normalizeInstallSchedule({ start: "22:00", end: "06:00" }).startMinute, 22 * 60);
  assert.equal(normalizeInstallSchedule({ start: "22:00:00" }).startMinute, 22 * 60);
  assert.equal(normalizeInstallSchedule({ startMinute: 90 }).startMinute, 90);
});

test("an unreadable setting falls back to the default, never to \"any time\"", () => {
  // A corrupt value must not widen when this device is allowed to restart itself.
  const plan = normalizeInstallSchedule({ days: ["nonsense"], start: "99:99", end: "" });
  assert.deepEqual(plan.days, [...AUTO_UPDATE_DEFAULT_SCHEDULE.days]);
  assert.equal(plan.startMinute, AUTO_UPDATE_DEFAULT_SCHEDULE.startMinute);
  assert.equal(plan.endMinute, AUTO_UPDATE_DEFAULT_SCHEDULE.endMinute);
  assert.deepEqual(normalizeInstallSchedule(null).days, [...AUTO_UPDATE_DEFAULT_SCHEDULE.days]);
});

test("an empty day list is not read as \"never\"", () => {
  // A device that can never install looks exactly like the feature being broken, and nobody chose
  // it on purpose.
  assert.deepEqual(normalizeInstallSchedule({ days: [] }).days, [...AUTO_UPDATE_DEFAULT_SCHEDULE.days]);
});

test("an install outside this device's hours waits, and says when it will happen", () => {
  const decision = resolveInstallDecision(installable({
    schedule: { days: ["SUN"], startMinute: 22 * 60, endMinute: 6 * 60 },
    now: at(19, 15).getTime(),
    lastActivityAt: at(19, 10).getTime(),
  }));
  assert.equal(decision.install, false);
  assert.equal(decision.reason, "OUTSIDE_WINDOW");
  assert.ok(decision.nextWindowAt, "the screen has to be able to say when");
  assert.equal(new Date(decision.nextWindowAt).getDay(), 0);
});

test("inside the hours and idle, it installs", () => {
  const decision = resolveInstallDecision(installable({
    schedule: { days: ["SAT"], startMinute: 22 * 60, endMinute: 6 * 60 },
    now: at(19, 23).getTime(),
    lastActivityAt: at(19, 22).getTime(),
  }));
  assert.equal(decision.install, true);
  assert.equal(decision.reason, "IDLE");
});

test("Install now works outside the device's hours", () => {
  // The hours govern the machine acting on its own. A person standing at it has already decided.
  const decision = resolveInstallDecision(installable({
    schedule: { days: ["SUN"], startMinute: 22 * 60, endMinute: 6 * 60 },
    now: at(19, 15).getTime(),
    requestedByUser: true,
  }));
  assert.equal(decision.install, true);
});

test("a bill in progress still wins inside the hours", () => {
  const decision = resolveInstallDecision(installable({
    schedule: { days: ["SAT"], startMinute: 22 * 60, endMinute: 6 * 60 },
    now: at(19, 23).getTime(),
    busyReasons: [{ id: "bill", label: "a bill in progress" }],
  }));
  assert.equal(decision.install, false);
  assert.equal(decision.reason, "DEVICE_BUSY");
});

test("waiting for the hours is said on screen, with when", () => {
  const notice = describeAutoUpdateNotice({
    enabled: true,
    phase: "ready_to_install",
    latestVersion: "1.0.74",
    decision: { install: false, reason: "OUTSIDE_WINDOW", waitingFor: [], nextWindowAt: at(20, 22).toISOString() },
  });
  assert.match(notice.text, /1\.0\.74/);
  assert.match(notice.text, /update hours/i);
  assert.equal(notice.actionLabel, "Install now");
  assert.equal(new Date(notice.nextWindowAt).getHours(), 22);
});

test("an unreadable clock does not count as inside the window", () => {
  const window = withinInstallWindow({ now: new Date("not a date") });
  assert.equal(window.within, false);
  assert.equal(window.reason, "UNREADABLE_TIME");
});

// --- the LOCAL_ONLY promise ---------------------------------------------------------------------

test("the unattended runner refuses LOCAL_ONLY before it can reach anything", async () => {
  // This is the one that matters most in this file. A device held in LOCAL_ONLY must make no
  // outbound connection at all, and the updater's own `check()` reaches github.com from inside
  // Rust where no JavaScript guard can see it. So the authority has to be asked before the plugin
  // is even imported -- not after, and not from React state, which is one render behind it.
  const fs = await import("node:fs");
  const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("function AutoUpdateRunner");
  assert.ok(start > 0, "the unattended runner must exist");
  const runner = app.slice(start, app.indexOf("\nfunction ", start + 1));

  const guard = runner.indexOf("isLocalOnlyConnectivitySelected()");
  const pluginImport = runner.indexOf('import("@tauri-apps/plugin-updater")');
  assert.ok(guard > 0, "the runner must ask the startup connectivity authority");
  assert.ok(pluginImport > 0, "the runner must be the thing that loads the updater plugin");
  assert.ok(guard < pluginImport, "LOCAL_ONLY must be refused before the updater plugin is loaded");

  // And it must be an early return, not a condition wrapped around the check only.
  assert.match(runner, /if \(isLocalOnlyConnectivitySelected\(\)\) return;/);
  // The runner must never reach the feed over HTTP itself; the plugin is the only route out.
  assert.doesNotMatch(runner, /axios\./, "the runner must not make its own HTTP calls");
});

test("the unattended install never asks a question nobody is there to answer", async () => {
  const fs = await import("node:fs");
  const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("function AutoUpdateRunner");
  const runner = app.slice(start, app.indexOf("\nfunction ", start + 1));
  assert.doesNotMatch(runner, /window\.confirm/, "a confirm dialog on an unattended machine is a counter stuck on a modal");
  // It must still run the same preflight the manual path runs.
  assert.match(runner, /sync_outbox_count/);
  assert.match(runner, /prepare_update_installation/);
});

test("a download outliving one beat is not thrown away", async () => {
  // The runner's effect re-runs every minute. A per-run cancellation flag would therefore be set
  // on a download started a minute ago -- and a download takes longer than a minute. Its answer
  // would be dropped with the phase left on "downloading", which refuses every later step and
  // parks that device there for good. Only unmounting may drop an answer.
  const fs = await import("node:fs");
  const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("function AutoUpdateRunner");
  const runner = app.slice(start, app.indexOf("\nfunction ", start + 1));
  assert.match(runner, /mountedRef/, "results must be dropped on unmount, not on re-run");
  assert.doesNotMatch(runner, /let abandoned/, "a per-effect-run cancellation flag strands the download");
  assert.match(runner, /installingRef/, "the unattended install must not be startable twice");
});
