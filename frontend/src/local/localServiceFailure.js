/**
 * Tell "the local service refused this" apart from "the local service never answered".
 *
 * ## Why this exists
 *
 * `getErrorMessage(error, fallback)` in `App.jsx` is `error.response?.data?.message || fallback`.
 * That is fine when a server answered and said why. It is actively misleading when nothing
 * answered at all: the caller's generic fallback is displayed as though it were the reason, and two
 * completely different situations render identically.
 *
 * That happened for real. Switching Connectivity Mode from Local Only to Auto showed "Unable to
 * change Connectivity Mode" — which reads like the local service considered the request and
 * declined it. In fact the browser blocked the request before it left the machine (a header the
 * gateway's CORS preflight did not list), so the gateway never saw it. The displayed message
 * pointed at the wrong half of the system, and the actual cause — a stale gateway process still
 * running pre-update code — was invisible.
 *
 * `CLAUDE.md`: "Errors must never render as zero. A failed load, a contract violation or an
 * internal inconsistency has to produce a distinct error state." A request that never arrived is
 * exactly such a distinct state, and it has a distinct remedy: restart the app.
 *
 * ## The boundary
 *
 * Same structural rule as `sessionExpiry.js`: **a failure carries an HTTP status only if a server
 * answered it.** No status means nothing refused us. This never guesses from message text, because
 * a network error whose text happens to contain "403" is still a network error.
 */

/** What the failure tells us about whether the local service was reached. */
export const LOCAL_SERVICE_OUTCOMES = Object.freeze({
  /** A server answered and explained itself. Show its message. */
  REFUSED: "REFUSED",
  /** A server answered but said nothing useful. */
  REFUSED_WITHOUT_REASON: "REFUSED_WITHOUT_REASON",
  /** Nothing answered. The request did not arrive. */
  UNREACHABLE: "UNREACHABLE",
});

const text = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * The local desktop service runs as a **separate process** from the web frontend, started when the
 * app launches. Reloading the page — or hot-reloading during development — updates the frontend
 * while that process keeps running whatever code it started with. So "I updated and it still
 * fails" has a specific, common, and otherwise invisible cause, and the message says so.
 */
const UNREACHABLE_MESSAGE =
  "FroozERP could not reach the local service on this device, so the change was not applied. "
  + "Close FroozERP completely and open it again, then try once more.";

const REFUSED_WITHOUT_REASON_MESSAGE =
  "The local service refused the change but did not say why. Close FroozERP completely and open it "
  + "again, then try once more.";

/**
 * Classify a failed request to the local service.
 *
 * @param {*} failure an axios error, a `{ status, response }`-shaped object, or anything else
 * @returns {{outcome: string, answered: boolean, status: number|null, serverMessage: string}}
 */
export const classifyLocalServiceFailure = (failure) => {
  const response = failure && typeof failure === "object" && failure.response && typeof failure.response === "object"
    ? failure.response
    : null;
  const rawStatus = response ? response.status : (failure && typeof failure === "object" ? failure.status : undefined);
  const status = Number.isFinite(Number(rawStatus)) && Number(rawStatus) > 0 ? Number(rawStatus) : null;

  if (status === null) {
    return { outcome: LOCAL_SERVICE_OUTCOMES.UNREACHABLE, answered: false, status: null, serverMessage: "" };
  }

  const data = response && response.data && typeof response.data === "object" ? response.data : {};
  const serverMessage = text(data.message) || text(data.error);
  return {
    outcome: serverMessage ? LOCAL_SERVICE_OUTCOMES.REFUSED : LOCAL_SERVICE_OUTCOMES.REFUSED_WITHOUT_REASON,
    answered: true,
    status,
    serverMessage,
  };
};

/**
 * A message that points at the right half of the system.
 *
 * When the service answered, its own words are the truth and are shown verbatim — it knows why it
 * refused and the frontend does not. Only when nothing answered does this substitute its own
 * wording, because in that case there is no server message to show and the fallback the caller
 * would otherwise display describes a decision that never happened.
 *
 * @param {*} failure the error that was thrown
 * @param {string} fallback the caller's message, used only when a server answered without one
 */
export const describeLocalServiceFailure = (failure, fallback = "") => {
  const classified = classifyLocalServiceFailure(failure);
  if (classified.outcome === LOCAL_SERVICE_OUTCOMES.UNREACHABLE) return UNREACHABLE_MESSAGE;
  if (classified.serverMessage) return classified.serverMessage;
  return text(fallback) || REFUSED_WITHOUT_REASON_MESSAGE;
};
