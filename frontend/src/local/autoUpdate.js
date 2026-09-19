/**
 * When a counter machine is allowed to update itself.
 *
 * Until now every update was driven by hand: somebody with manage rights opened Settings, pressed
 * Check, pressed Download, pressed Install and Restart. On one laptop that is fine. Across a shop
 * full of counters it means most of them never get updated at all, because nobody walks to each
 * machine. This module is what lets the app do it unattended.
 *
 * That convenience is also the danger, and it is worth stating plainly here because this file is
 * where the decision is made. The updater installs in `quiet` mode against the `latest` feed, so a
 * published release reaches every counter silently and there is no easy way to take it back. The
 * person pressing the button used to be the last checkpoint. Automating it removes that
 * checkpoint, so everything below is written to fail towards *not* acting:
 *
 *   - nothing happens unless the device was explicitly switched on for it,
 *   - nothing is downloaded on a device that has chosen to stay off the network,
 *   - nothing is installed that has not verified its signature,
 *   - and nothing is installed while the machine is in the middle of somebody's work.
 *
 * Every decision returns a reason alongside it rather than a bare boolean. A silent "no" is
 * indistinguishable from a broken check, and this app has been bitten by that shape of bug before.
 */

import { CONNECTIVITY_MODES } from "./connectivityMode.js";

export const AUTO_UPDATE_DEFAULTS = Object.freeze({
  // A shop is open for about twelve hours, so this checks roughly three times a day. Often enough
  // that a release lands the same day it is published, rare enough that it is never the reason a
  // counter feels slow.
  checkIntervalMs: 4 * 60 * 60 * 1000,
  // After a failed check, try again sooner than the normal round -- but not so soon that a shop
  // with no internet spends the day retrying.
  retryIntervalMs: 15 * 60 * 1000,
  // How long the machine must be left alone before an update is allowed to restart it. Five
  // minutes is longer than any gap between two customers at a busy counter and shorter than a tea
  // break, which is exactly the window we want.
  idleBeforeInstallMs: 5 * 60 * 1000,
});

/** Phases in which a request is already in flight and a second one would collide. */
const BUSY_PHASES = new Set(["checking", "downloading", "installing"]);

const asTime = (value) => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback);

/**
 * Should the app ask the feed whether there is a newer version?
 *
 * @param {object} input
 * @param {boolean} input.enabled this device has automatic updates switched on
 * @param {boolean} input.feedConfigured an update feed URL exists
 * @param {boolean} input.updaterAvailable running inside the desktop shell, not a browser tab
 * @param {boolean} input.online the app believes it can reach the internet
 * @param {string}  input.connectivityMode AUTO or LOCAL_ONLY
 * @param {string}  input.phase the updater's current phase
 * @param {number|string|Date|null} input.lastCheckedAt when the last check finished
 * @param {boolean} input.lastCheckFailed the last check ended in an error
 * @param {number|string|Date} input.now
 */
export const shouldCheckForUpdate = ({
  enabled = false,
  feedConfigured = false,
  updaterAvailable = false,
  online = false,
  connectivityMode = CONNECTIVITY_MODES.AUTO,
  phase = "idle",
  lastCheckedAt = null,
  lastCheckFailed = false,
  now = Date.now(),
  checkIntervalMs = AUTO_UPDATE_DEFAULTS.checkIntervalMs,
  retryIntervalMs = AUTO_UPDATE_DEFAULTS.retryIntervalMs,
} = {}) => {
  if (!enabled) return { check: false, reason: "AUTO_UPDATE_OFF" };
  if (!updaterAvailable) return { check: false, reason: "NOT_DESKTOP_APP" };
  if (!feedConfigured) return { check: false, reason: "FEED_NOT_CONFIGURED" };
  // LOCAL_ONLY is a promise this app makes about itself: no outbound connections, none at all. An
  // update check is an outbound connection, so it is refused here rather than anywhere further in.
  if (connectivityMode === CONNECTIVITY_MODES.LOCAL_ONLY) return { check: false, reason: "LOCAL_ONLY" };
  if (!online) return { check: false, reason: "OFFLINE" };
  if (BUSY_PHASES.has(phase)) return { check: false, reason: "ALREADY_RUNNING" };

  const last = asTime(lastCheckedAt);
  if (last === null) return { check: true, reason: "FIRST_CHECK" };
  const due = last + positive(lastCheckFailed ? retryIntervalMs : checkIntervalMs, AUTO_UPDATE_DEFAULTS.checkIntervalMs);
  const moment = asTime(now) ?? Date.now();
  if (moment < due) return { check: false, reason: "NOT_DUE", dueAt: new Date(due).toISOString() };
  return { check: true, reason: lastCheckFailed ? "RETRY_DUE" : "DUE" };
};

/**
 * Should the app fetch the update it has found?
 *
 * Downloading is the cheap half and the half that cannot hurt anybody: it writes a file and
 * changes nothing that is running. Doing it early means the install, when it is finally allowed,
 * is quick rather than a counter staring at a progress bar.
 */
export const shouldDownloadUpdate = ({
  enabled = false,
  phase = "idle",
  updateAvailable = false,
  alreadyDownloaded = false,
  online = false,
  connectivityMode = CONNECTIVITY_MODES.AUTO,
} = {}) => {
  if (!enabled) return { download: false, reason: "AUTO_UPDATE_OFF" };
  if (!updateAvailable) return { download: false, reason: "NOTHING_TO_DOWNLOAD" };
  if (alreadyDownloaded) return { download: false, reason: "ALREADY_DOWNLOADED" };
  if (connectivityMode === CONNECTIVITY_MODES.LOCAL_ONLY) return { download: false, reason: "LOCAL_ONLY" };
  if (!online) return { download: false, reason: "OFFLINE" };
  if (BUSY_PHASES.has(phase)) return { download: false, reason: "ALREADY_RUNNING" };
  return { download: true, reason: "UPDATE_AVAILABLE" };
};

/**
 * Is this the moment to install and restart?
 *
 * `busyReasons` is a list of `{ id, label }` handed in by the shell -- an unsaved bill, an open
 * form, a print or a sync in flight. This module deliberately does not know what any of them mean;
 * it only knows that while the list is non-empty the machine belongs to whoever is using it. The
 * labels come back out in `waitingFor` so the screen can say what it is waiting on instead of
 * looking stuck.
 *
 * `requestedByUser` is the one thing that overrides the idle wait, because a person who presses
 * "Install now" has already decided this is a good moment. It does not override a missing
 * signature, and nothing does.
 */
export const resolveInstallDecision = ({
  enabled = false,
  readyToInstall = false,
  signatureVerified = false,
  phase = "idle",
  busyReasons = [],
  lastActivityAt = null,
  requestedByUser = false,
  now = Date.now(),
  idleBeforeInstallMs = AUTO_UPDATE_DEFAULTS.idleBeforeInstallMs,
} = {}) => {
  const blocking = (Array.isArray(busyReasons) ? busyReasons : [])
    .filter((entry) => entry && entry.id)
    .map((entry) => ({ id: String(entry.id), label: String(entry.label || entry.id) }));
  const waitingFor = blocking.map((entry) => entry.label);

  if (!readyToInstall) return { install: false, reason: "NOT_DOWNLOADED", waitingFor: [] };
  // No signature, no install -- whoever asked and however idle the machine is. An unverified
  // payload installing itself quietly on every counter is the worst outcome this file can produce.
  if (!signatureVerified) return { install: false, reason: "SIGNATURE_NOT_VERIFIED", waitingFor: [] };
  if (phase === "installing") return { install: false, reason: "ALREADY_INSTALLING", waitingFor: [] };
  if (blocking.length) return { install: false, reason: "DEVICE_BUSY", waitingFor };
  if (requestedByUser) return { install: true, reason: "REQUESTED_BY_USER", waitingFor: [] };
  if (!enabled) return { install: false, reason: "AUTO_UPDATE_OFF", waitingFor: [] };

  const last = asTime(lastActivityAt);
  const moment = asTime(now) ?? Date.now();
  // No activity ever recorded means nobody has touched this machine since it started, which is as
  // idle as it gets.
  if (last === null) return { install: true, reason: "IDLE", waitingFor: [] };
  const idleFor = moment - last;
  if (idleFor < positive(idleBeforeInstallMs, AUTO_UPDATE_DEFAULTS.idleBeforeInstallMs)) {
    return { install: false, reason: "IN_USE", waitingFor: [], idleForMs: Math.max(0, idleFor) };
  }
  return { install: true, reason: "IDLE", waitingFor: [] };
};

/**
 * The one line the app puts on screen about all this, or nothing.
 *
 * Nothing is the normal state: a counter that is up to date should not carry a badge saying so.
 * But a machine that has downloaded an update and is waiting must say what it is waiting for, and
 * a check that keeps failing must say that too -- a silent failure here reads exactly like "there
 * are no updates", which is how a shop ends up months behind without knowing it.
 */
export const describeAutoUpdateNotice = ({
  enabled = false,
  phase = "idle",
  latestVersion = "",
  decision = null,
  consecutiveFailures = 0,
  failureMessage = "",
} = {}) => {
  const version = String(latestVersion || "").trim();
  const named = version ? `Version ${version}` : "An update";

  if (phase === "installing") {
    return { tone: "info", text: `${named} is installing. FroozERP will restart on its own.`, actionLabel: "" };
  }
  if (decision && decision.install === false && decision.reason === "DEVICE_BUSY") {
    const waiting = decision.waitingFor && decision.waitingFor.length ? decision.waitingFor.join(", ") : "work in progress";
    return {
      tone: "info",
      text: `${named} is ready and will install once this is finished: ${waiting}.`,
      actionLabel: "",
    };
  }
  if (decision && decision.install === false && decision.reason === "SIGNATURE_NOT_VERIFIED") {
    // Loud on purpose. A download that will not verify is either a broken file or a tampered one,
    // and both are worth a person looking rather than a quiet retry forever.
    return {
      tone: "warning",
      text: `${named} was downloaded but its signature could not be verified, so it has not been installed.`,
      actionLabel: "Open Update Center",
    };
  }
  if (phase === "ready_to_install") {
    return { tone: "info", text: `${named} is ready to install.`, actionLabel: "Install now" };
  }
  // Two failures in a row is no longer bad luck with the internet.
  if (consecutiveFailures >= 2) {
    return {
      tone: "warning",
      text: failureMessage
        ? `FroozERP has not been able to check for updates: ${failureMessage}`
        : "FroozERP has not been able to check for updates.",
      actionLabel: "Open Update Center",
    };
  }
  if (!enabled) return null;
  return null;
};
