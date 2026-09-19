import test from "node:test";
import assert from "node:assert/strict";

import { CONNECTIVITY_MODES } from "./connectivityMode.js";
import {
  AUTO_UPDATE_DEFAULTS,
  describeAutoUpdateNotice,
  resolveInstallDecision,
  shouldCheckForUpdate,
  shouldDownloadUpdate,
} from "./autoUpdate.js";

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
