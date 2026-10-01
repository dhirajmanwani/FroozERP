/**
 * What the shell says about the connection, and where it says it.
 *
 * The shell used to say it three times, and the three disagreed. The top-bar pill printed one
 * summary, a panel under it printed a second ("Local server connected • Cloud backend connected")
 * and a third line under that ("Local ready - cloud unavailable; sync paused… API mode: Cloud
 * Only"), and then the connection banner printed its own sentence. A person reading all four could
 * not tell whether the shop was online.
 *
 * The rule now:
 *
 *   - The **pill** is always on screen and always says one short thing. It is derived from the same
 *     sentence the banner uses (`local/connectionStatus.js`), so the two cannot disagree.
 *   - The **connection banner** stays exactly as `resolveConnectionStatus` decides: offline, kept
 *     offline on purpose, or catching up.
 *   - The **notice panel** appears only when a person has to do something the banner does not
 *     already cover -- a startup error, the service on this computer not running, the server not
 *     answering, or changes that failed to send. One sentence, in the shop's words. No "API mode",
 *     no "backend", no "Cloud Only".
 *
 * Nothing degraded is ever silent: an offline, kept-offline, failed or stopped state always
 * changes the pill, and every one of them also has a sentence somewhere on screen.
 *
 * Pure and free of React.
 */
import { CONNECTION_STATE } from "./connectionStatus.js";

const counted = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

const changes = (count) => `${count} ${count === 1 ? "change" : "changes"}`;

/** What the pill can be asked to look like. Carried as a data attribute; styling is the stylesheet's. */
export const SHELL_PILL_TONE = Object.freeze({
  CALM: "calm",
  NOTICE: "notice",
  PROBLEM: "problem",
});

/**
 * @param {object} facts
 * @param {object}  facts.connection            the result of `resolveConnectionStatus`
 * @param {string}  facts.startupError          an error the shell already holds, shown as-is
 * @param {boolean} facts.serviceStarting       the service is still coming up
 * @param {boolean} facts.serviceDown           the service the app talks to has answered "no"
 * @param {boolean} facts.cloudMode             that service is the cloud, not this computer
 * @param {number}  facts.pendingCount
 * @param {number}  facts.failedCount           changes that failed to send
 * @param {number}  facts.conflictCount         changes that clash with the cloud's copy
 * @param {boolean} facts.devicePending         cloud answers, this device is not approved yet
 * @returns {{pill: {label: string, tone: string, title: string}, notice: null | {tone: "error"|"warning", message: string, offerRestart: boolean}}}
 */
export const resolveShellStatus = ({
  connection = null,
  startupError = "",
  serviceStarting = false,
  serviceDown = false,
  cloudMode = false,
  pendingCount = 0,
  failedCount = 0,
  conflictCount = 0,
  devicePending = false,
} = {}) => {
  const pending = counted(pendingCount);
  const failed = counted(failedCount);
  const conflicts = counted(conflictCount);
  const state = connection?.state || CONNECTION_STATE.STARTING;
  const down = serviceDown === true && serviceStarting !== true;

  let pill;
  if (serviceStarting) {
    pill = { label: "Starting up", tone: SHELL_PILL_TONE.CALM };
  } else if (down) {
    pill = cloudMode
      ? { label: "Server not answering", tone: SHELL_PILL_TONE.PROBLEM }
      : { label: "Service stopped", tone: SHELL_PILL_TONE.PROBLEM };
  } else if (state === CONNECTION_STATE.HELD_OFFLINE) {
    pill = { label: pending ? `Kept offline · ${pending} to send` : "Kept offline", tone: SHELL_PILL_TONE.PROBLEM };
  } else if (state === CONNECTION_STATE.OFFLINE) {
    pill = { label: pending ? `Offline · ${pending} to send` : "Working offline", tone: SHELL_PILL_TONE.NOTICE };
  } else if (failed) {
    pill = { label: "Sync failed", tone: SHELL_PILL_TONE.PROBLEM };
  } else if (conflicts) {
    pill = { label: "Sync needs a look", tone: SHELL_PILL_TONE.PROBLEM };
  } else if (devicePending) {
    pill = { label: "Waiting for approval", tone: SHELL_PILL_TONE.NOTICE };
  } else if (state === CONNECTION_STATE.CATCHING_UP) {
    pill = { label: `Sending ${pending}`, tone: SHELL_PILL_TONE.CALM };
  } else if (state === CONNECTION_STATE.SYNCED) {
    pill = { label: "Saved to cloud", tone: SHELL_PILL_TONE.CALM };
  } else {
    pill = { label: "Starting up", tone: SHELL_PILL_TONE.CALM };
  }
  // The pill is short by design; its tooltip carries the full sentence the banner would say.
  pill.title = [connection?.headline, connection?.detail].filter(Boolean).join(" — ");

  let notice = null;
  const error = String(startupError || "").trim();
  if (error) {
    notice = { tone: "error", message: error, offerRestart: down && !cloudMode };
  } else if (down && !cloudMode) {
    notice = {
      tone: "error",
      message: "FroozERP has stopped running on this computer. Restart it to carry on working.",
      offerRestart: true,
    };
  } else if (down) {
    notice = {
      tone: "warning",
      message: pending
        ? `The FroozERP server is not answering. ${changes(pending)} saved here will send when it is back.`
        : "The FroozERP server is not answering. Check the internet connection.",
      offerRestart: false,
    };
  } else if (failed) {
    notice = {
      tone: "warning",
      message: `${changes(failed)} could not be sent to the cloud. They are kept on this computer — open Settings, Sync & Connection, and press Retry Failed.`,
      offerRestart: false,
    };
  } else if (conflicts) {
    notice = {
      tone: "warning",
      message: `${changes(conflicts)} clash with the copy in the cloud and were held back. Ask the Owner to open Settings, Sync & Connection, and press Retry Failed.`,
      offerRestart: false,
    };
  }

  return { pill, notice };
};

/** Words the notice must never contain. Exported so the test and any future caller agree. */
export const SHELL_STATUS_FORBIDDEN_WORDS = Object.freeze(["API mode", "Cloud Only", "backend", "SQLite", "Railway"]);
