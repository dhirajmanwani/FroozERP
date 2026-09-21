/**
 * When FROST may load, and what its Provider dropdown is allowed to show.
 *
 * ## The bug this module exists to stop
 *
 * FROST reads eleven endpoints, and in the desktop app every one of them is served by the backend
 * running on this machine against the embedded SQLite database (`server.js` reports
 * `EMBEDDED_SQLITE` whenever it is not the cloud server). Nothing FROST needs comes from the cloud.
 * The loader nevertheless refused to run at all whenever the cloud was unreachable, so a cloud
 * outage silently took FROST's whole data set with it -- including the list of providers that fills
 * the Provider dropdown, which then rendered as a working dropdown offering the single option
 * written into the page. An empty list drawn as a one-item menu is the "errors must never render as
 * zero" pitfall in CLAUDE.md: the owner sees a choice, not a failure, and has no way to tell that
 * the other four options exist and did not arrive.
 *
 * So availability is decided from where FROST's endpoints actually live, and a list that did not
 * load is reported as a list that did not load.
 */

/** FROST's endpoints are on this machine unless the app is pointed at a cloud backend. */
export const resolveFrostDataSource = ({ apiUrl = "", cloudApiMode = false } = {}) => {
  const local = /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::|\/|$)/i.test(String(apiUrl || "").trim());
  return cloudApiMode === true && !local ? "cloud" : "local";
};

/**
 * Whether the loader should run, and what to say when it should not.
 *
 * It only ever refuses for the reason that is actually true: a cloud-hosted FROST with no cloud.
 * A local FROST always attempts its requests, because a request that fails carries evidence --
 * a status, a code, a URL -- and a pre-emptive refusal carries a guess.
 */
export const resolveFrostLoadDecision = ({
  apiUrl = "",
  cloudApiMode = false,
  internetAvailable = true,
  cloudOnline = null,
} = {}) => {
  if (resolveFrostDataSource({ apiUrl, cloudApiMode }) === "local") {
    return { shouldLoad: true, reason: "", source: "local" };
  }
  if (internetAvailable === false || cloudOnline === false) {
    return {
      shouldLoad: false,
      reason: "FROST requires cloud access. Local FroozERP modules remain available.",
      source: "cloud",
    };
  }
  return { shouldLoad: true, reason: "", source: "cloud" };
};

/** The one option the page owns. Every other option has to be read from the backend. */
export const DETERMINISTIC_PROVIDER_OPTION = Object.freeze({ key: "deterministic", label: "Deterministic only" });

export const FROST_PROVIDER_LIST_UNAVAILABLE_MESSAGE =
  "Provider list could not be read from the FroozERP server, so only the built-in option is shown. Refresh FROST to try again.";

/**
 * The options for the Provider dropdown, and whether what is shown is the whole truth.
 *
 * `usable` is false when the backend list is missing. The caller must render `message` -- shipping
 * the options without it puts the owner back in front of a dropdown that looks complete and is not.
 *
 * `selectedKey` is the provider already saved in settings. When the list did not load, that key is
 * carried into the options on its own, because a `<select>` whose value matches no option draws its
 * first option instead: FROST would be configured for a local model and the screen would read
 * "Deterministic only". A setting that is displayed as something other than what is stored is worse
 * than one that is displayed as unavailable.
 */
export const resolveFrostProviderOptions = (providers, selectedKey = "") => {
  const rows = (Array.isArray(providers) ? providers : [])
    .filter((provider) => provider && typeof provider === "object")
    .map((provider) => ({ key: String(provider.key || "").trim(), label: String(provider.label || "").trim() }))
    .filter((provider) => provider.key && provider.label && provider.key !== DETERMINISTIC_PROVIDER_OPTION.key);
  if (rows.length === 0) {
    const selected = String(selectedKey || "").trim();
    const carried = selected && selected !== DETERMINISTIC_PROVIDER_OPTION.key
      ? [{ key: selected, label: `${selected} (saved; list unavailable)` }]
      : [];
    return {
      options: [DETERMINISTIC_PROVIDER_OPTION, ...carried],
      usable: false,
      message: FROST_PROVIDER_LIST_UNAVAILABLE_MESSAGE,
    };
  }
  return { options: [DETERMINISTIC_PROVIDER_OPTION, ...rows], usable: true, message: "" };
};

/**
 * The message for a FROST request that failed before it got a status.
 *
 * `isCloudUnavailableError` counts `ECONNREFUSED` and friends as cloud failures, which is right for
 * a cloud-hosted FROST and wrong for a local one: the same code from a backend on this machine
 * means the local server is not running, and telling the owner to check the cloud sends them to the
 * wrong machine. Returns "" when the failure is not a transport failure, so the caller's existing
 * ladder keeps handling statuses it already explains better.
 */
export const describeFrostTransportFailure = ({ apiUrl = "", cloudApiMode = false, status = null } = {}) => {
  if (Number(status) > 0) return "";
  return resolveFrostDataSource({ apiUrl, cloudApiMode }) === "local"
    ? "FROST could not reach the FroozERP server on this machine. Start the local server, then refresh FROST."
    : "FROST requires cloud access. Local FroozERP modules remain available.";
};
