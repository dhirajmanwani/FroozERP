/**
 * Whether switching Connectivity Mode to AUTO can possibly succeed on this installation.
 *
 * ## Why this exists
 *
 * The Connectivity Mode control offered an AUTO button unconditionally. On an installation pinned
 * to Local Only it could never work: `startupConnectivityAuthority.confirm()` throws
 * "API_MODE=LOCAL_ONLY is authoritative", by design (D-16). Pressing it produced an error, every
 * time, forever — and the error said nothing useful, so the only signal was that the app appeared
 * broken.
 *
 * `CLAUDE.md` says an error must never render as an ordinary empty result. The mirror of that rule
 * applies here: **an action that cannot succeed must not render as available.** A disabled button
 * beside a sentence explaining why is honest; an enabled button that always fails is not, whatever
 * the error text says afterwards.
 *
 * ## Why "no cloud configured" counts too
 *
 * A cloud-capable App Mode with no cloud URL is the same dead end one step later: AUTO would be
 * accepted, sync would then have nowhere to go, and the failure would surface as a sync error
 * rather than as the configuration gap it is. The maintainer hit exactly this — no hosted backend
 * is running, so there is nothing for AUTO to mean.
 *
 * Pure and free of React so the decision is testable; the caller renders whatever it returns.
 */

import { apiModeUsesCloudBackend, isLocalOnlyApiMode } from "./apiModeResolution.js";

const text = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * Why AUTO is unavailable, or `""` when it is available.
 *
 * Returns the reason rather than a boolean so the caller cannot show a disabled control without
 * also having the sentence that explains it — the two are useless apart.
 *
 * @param {object} input
 * @param {string} input.apiMode      the configured App Mode
 * @param {string} input.cloudApiUrl  the configured cloud backend URL, if any
 * @returns {string} a plain-language reason, or "" when AUTO can be attempted
 */
export const autoConnectivityBlockedReason = ({ apiMode, cloudApiUrl } = {}) => {
  if (isLocalOnlyApiMode(apiMode)) {
    return "App Mode is set to Local Only, which fixes this device offline. Connectivity Mode "
      + "cannot be set to Auto while that is the App Mode.";
  }
  if (apiModeUsesCloudBackend(apiMode) && !text(cloudApiUrl)) {
    return "No cloud backend is configured for this installation, so there is nothing for Auto to "
      + "connect to. Set a Cloud API URL first.";
  }
  return "";
};
