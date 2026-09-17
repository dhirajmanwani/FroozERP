/**
 * Why a settings change could not be saved, said in words somebody can act on.
 *
 * Settings are written by the cloud backend. The desktop gateway serves `/settings` from local
 * SQLite so a counter keeps working with no internet, but it accepts no writes at all — not for
 * charges, not for tax rules, not for anything. So every settings form fails the same way offline,
 * and every one of them used to fail with its own bare sentence: "Unable to add this charge".
 * That describes the outcome and hides the cause: somebody reads it and goes looking for a mistake
 * in what they typed, and there isn't one.
 *
 * ## Why an answer from the server always wins
 *
 * The first version of this asked `navigator.onLine === false` alongside "there was no response",
 * and said "no connection to the cloud" for either. On 2026-09-17 that cost most of an evening.
 * Adding a charge on the shop's own machine reported no connection — while `/api/cloud/health` on
 * that same machine, seconds earlier, reported `cloudReachable: true`, `appInternetAllowed: true`
 * and the right deployed version. Hours went into looking for a connection fault that did not
 * exist, because the app had described one that was not there.
 *
 * `navigator.onLine` is not a measurement. In a WebView it is a cached guess about an adapter, it
 * is routinely wrong on Windows, and it knows nothing about whether *this* request succeeded. A
 * response does: it is proof that a round trip happened. So the order is fixed — if the server
 * answered, report what it said; only silence may be read as an outage.
 *
 * The three refusals that arrive *as* an answer are named separately, because "no internet", "the
 * Owner switched cloud access off" and "this build has no cloud address" need three different
 * things done about them. Telling somebody to reconnect is useless advice for the last two.
 */

/** What `describeSettingsWriteFailure` decided. Exported so a caller can branch without matching text. */
export const SETTINGS_WRITE_FAILURE = Object.freeze({
  NO_REPLY: "NO_REPLY",
  CLOUD_PAUSED: "CLOUD_PAUSED",
  CLOUD_NOT_CONFIGURED: "CLOUD_NOT_CONFIGURED",
  CLOUD_UNAVAILABLE: "CLOUD_UNAVAILABLE",
  SERVER_REFUSED: "SERVER_REFUSED",
});

const text = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * @param {object} error       The rejected axios error, or anything thrown by a write.
 * @param {string} fallback    What was being attempted, e.g. "Unable to add this charge".
 * @param {object} [options]
 * @param {boolean|null} [options.browserReportsOffline] `navigator.onLine === false`, when known.
 *        Used only to colour the no-reply case; it can never overrule a response.
 * @returns {{reason: string, message: string, status: number|null, code: string}}
 */
export const describeSettingsWriteFailure = (error, fallback, { browserReportsOffline = null } = {}) => {
  const lead = text(fallback) || "That change could not be saved";
  const response = error && typeof error === "object" ? error.response : null;
  const status = response && Number.isFinite(Number(response.status)) ? Number(response.status) : null;
  const code = text(response?.data?.code);
  const serverMessage = text(response?.data?.message);

  if (!response) {
    return {
      reason: SETTINGS_WRITE_FAILURE.NO_REPLY,
      status: null,
      code: text(error?.code),
      message: `${lead} — this machine got no reply at all`
        + (browserReportsOffline === true ? " and Windows reports it is offline" : "")
        + ". Settings are saved in the cloud, so reconnect and try again."
        + " Billing and everything else keep working offline.",
    };
  }

  if (status === 503 && code === "APP_LOCAL_ONLY") {
    return {
      reason: SETTINGS_WRITE_FAILURE.CLOUD_PAUSED,
      status,
      code,
      message: `${lead} — cloud access is switched off for this machine, so nothing was sent.`
        + " Turn it back on in Settings > Sync & Connection, then try again.",
    };
  }
  if (status === 503 && code === "CLOUD_NOT_CONFIGURED") {
    return {
      reason: SETTINGS_WRITE_FAILURE.CLOUD_NOT_CONFIGURED,
      status,
      code,
      message: `${lead} — this installation has no cloud address, so there is nowhere to save`
        + " settings. This one needs the maintainer.",
    };
  }
  if (status === 503) {
    return {
      reason: SETTINGS_WRITE_FAILURE.CLOUD_UNAVAILABLE,
      status,
      code,
      message: `${lead} — the cloud answered that it is unavailable right now. Nothing was saved. `
        + (serverMessage || "Try again in a minute."),
    };
  }

  // Anything else the server said, said back: a 400 naming the field, a 409 naming the duplicate,
  // a 403 naming the permission. Each is the actual answer, and each was previously hidden behind
  // a sentence about the internet.
  return {
    reason: SETTINGS_WRITE_FAILURE.SERVER_REFUSED,
    status,
    code,
    message: serverMessage || lead,
  };
};

/** The sentence only, for call sites that just want something to show. */
export const settingsWriteErrorMessage = (error, fallback, options) =>
  describeSettingsWriteFailure(error, fallback, options).message;
