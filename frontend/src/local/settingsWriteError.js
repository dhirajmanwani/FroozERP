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
    // The underlying reason is named, not swallowed. "No reply" has several very different
    // causes -- the network, a blocked request inside the webview, a bug that threw before the
    // request was ever made -- and they are indistinguishable from the outside. On 2026-09-17 a
    // write that produced no reply could not be told apart from an outage for hours, because the
    // one string that knew the difference was thrown away here. It is shown in brackets, at the
    // end, so it costs a reader nothing and is there when somebody needs it.
    const detail = text(error?.message) || text(error?.code);
    return {
      reason: SETTINGS_WRITE_FAILURE.NO_REPLY,
      status: null,
      code: text(error?.code),
      detail,
      message: `${lead} — this machine got no reply at all`
        + (browserReportsOffline === true ? " and Windows reports it is offline" : "")
        + ". Settings are saved in the cloud, so reconnect and try again."
        + " Billing and everything else keep working offline."
        + (detail ? ` [${detail}]` : ""),
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

/**
 * A refresh that failed after a save that worked.
 *
 * On 2026-09-17 adding a charge rate said "Unable to add this rate — this machine got no reply at
 * all", and the rate was added. So was the next one, when it was tried again; the shop's charge
 * ended up with the same slab listed twice, and deleting one said "Unable to remove this rate"
 * while removing it. The save was never the thing that failed.
 *
 * The cause is a shape, not a typo, and it was in twenty settings handlers:
 *
 *     try {
 *       await axios.post(...);   // this worked
 *       await onReload();        // this did not
 *     } catch (error) {
 *       alert("Unable to add this rate");   // and this blamed the wrong one
 *     }
 *
 * `onReload` was `Promise.all([loadSettingsData(), loadPurchaseRules(), loadDiscountRules()])`, so
 * any one of three unrelated reads could fail a charge save that had already been committed. The
 * message was accurate about a failure and wrong about which one, which is worse than saying
 * nothing: it sends somebody to do the save again, and a second save is a duplicate row.
 *
 * What a person needs to know here is exactly two things: what you saved is saved, and this screen
 * may be showing yesterday's version of it.
 */
export const refreshAfterSaveMessage = (error) => {
  const detail = text(error?.message) || text(error?.code);
  return "This screen could not refresh itself, so it may be showing old information."
    + " Anything you just saved is saved — reopen Settings to see the latest."
    + (detail ? ` [${detail}]` : "");
};
