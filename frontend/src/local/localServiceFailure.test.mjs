import test from "node:test";
import assert from "node:assert/strict";

import {
  LOCAL_SERVICE_OUTCOMES,
  classifyLocalServiceFailure,
  describeLocalServiceFailure,
} from "./localServiceFailure.js";

test("a request that never got an answer is not reported as a refusal", () => {
  // The bug this module exists for. Switching Connectivity Mode showed "Unable to change
  // Connectivity Mode", which reads as "the service considered it and said no". The request had in
  // fact been blocked by the browser before leaving the machine, so nothing ever considered it.
  const networkError = Object.assign(new Error("Network Error"), { code: "ERR_NETWORK", isAxiosError: true });
  const classified = classifyLocalServiceFailure(networkError);

  assert.equal(classified.outcome, LOCAL_SERVICE_OUTCOMES.UNREACHABLE);
  assert.equal(classified.answered, false);
  assert.match(describeLocalServiceFailure(networkError, "Unable to change Connectivity Mode"), /could not reach the local service/);
});

test("the unreachable message names the remedy, because the cause is invisible", () => {
  // The local service is a separate process. A page reload updates the frontend and leaves that
  // process running its old code, so "I updated and it still fails" is both common and impossible
  // to deduce from the screen without being told.
  // Shaped like a real axios transport failure: a bare `new Error("Network Error")` carries none of
  // the markers axios attaches, and is correctly read as our own code throwing rather than the
  // network failing.
  const network = Object.assign(new Error("Network Error"), { code: "ERR_NETWORK", isAxiosError: true });
  const message = describeLocalServiceFailure(network);
  assert.match(message, /Close FroozERP completely and open it again/);
  assert.doesNotMatch(message, /CORS|preflight|header|gateway/i, "the remedy must be actionable, not a diagnosis");
});

test("when the service answers, its own words win over any fallback", () => {
  // It knows why it refused; the frontend does not. Substituting a generic message here would
  // discard the only accurate information available.
  const refusal = { response: { status: 403, data: { code: "OWNER_REQUIRED", message: "Authenticated Owner permission is required." } } };
  const classified = classifyLocalServiceFailure(refusal);

  assert.equal(classified.outcome, LOCAL_SERVICE_OUTCOMES.REFUSED);
  assert.equal(classified.answered, true);
  assert.equal(classified.status, 403);
  assert.equal(
    describeLocalServiceFailure(refusal, "Unable to change Connectivity Mode"),
    "Authenticated Owner permission is required.",
  );
});

test("an answer with no message falls back to the caller's wording", () => {
  // A server did decide, so the caller's description of the operation is accurate even though the
  // server gave no reason.
  const refusal = { response: { status: 500, data: {} } };
  assert.equal(classifyLocalServiceFailure(refusal).outcome, LOCAL_SERVICE_OUTCOMES.REFUSED_WITHOUT_REASON);
  assert.equal(describeLocalServiceFailure(refusal, "Unable to change Connectivity Mode"), "Unable to change Connectivity Mode");
});

test("an answer with no message and no fallback still says something useful", () => {
  const refusal = { response: { status: 500, data: {} } };
  assert.match(describeLocalServiceFailure(refusal), /did not say why/);
});

test("status is read only from a real response, never from message text", () => {
  // A network error whose text happens to contain a status number is still a network error. This is
  // the same structural boundary sessionExpiry.js draws, and for the same reason.
  const misleading = Object.assign(new Error("Request failed with status code 403"), { code: "ERR_NETWORK", isAxiosError: true });
  assert.equal(classifyLocalServiceFailure(misleading).answered, false);
  assert.match(describeLocalServiceFailure(misleading), /could not reach the local service/);
});

test("odd shapes are treated as unreachable rather than throwing", () => {
  for (const failure of [null, undefined, "", 0, "some string", {}, { response: null }, { response: {} }]) {
    assert.doesNotThrow(() => classifyLocalServiceFailure(failure));
    assert.equal(
      classifyLocalServiceFailure(failure).answered,
      false,
      `must not claim a server answered for ${JSON.stringify(failure)}`,
    );
  }
});

test("a bare status without a response object is still an answer", () => {
  // Some call sites throw `{ status, ... }` directly rather than an axios error.
  const classified = classifyLocalServiceFailure({ status: 403 });
  assert.equal(classified.answered, true);
  assert.equal(classified.status, 403);
});

// -----------------------------------------------------------------------------------------------
// A rule the app enforces itself is not a network failure
//
// `startupConnectivityAuthority.confirm()` throws a plain Error when App Mode is pinned to
// LOCAL_ONLY. There is no HTTP response, so an "answered or not?" test alone calls it unreachable
// and tells the user to restart — advice that is wrong for a rule working exactly as designed, and
// which hides the one sentence that would have told them what to actually do.
// -----------------------------------------------------------------------------------------------

test("a rule enforced in the app reports its own reason, not a connection failure", () => {
  const refusal = new Error("API_MODE=LOCAL_ONLY is authoritative; connectivity cannot be enabled at runtime.");
  const classified = classifyLocalServiceFailure(refusal);

  assert.equal(classified.outcome, LOCAL_SERVICE_OUTCOMES.REFUSED_LOCALLY);
  assert.equal(classified.answered, false, "nothing answered, but that does not make it unreachable");

  const message = describeLocalServiceFailure(refusal, "Unable to change Connectivity Mode");
  assert.doesNotMatch(message, /could not reach the local service/, "restarting fixes nothing here");
  assert.match(message, /App Mode/, "it must name the setting that is actually blocking this");
});

test("the developer wording is replaced, not shown to a shop user", () => {
  // The rule is right; only the sentence is written for whoever wrote the code.
  const message = describeLocalServiceFailure(
    new Error("API_MODE=LOCAL_ONLY is authoritative; connectivity cannot be enabled at runtime."),
  );
  assert.doesNotMatch(message, /API_MODE|authoritative|runtime/i);

  const stillLoading = describeLocalServiceFailure(
    new Error("Connectivity policy must be reconciled before it can be changed."),
  );
  assert.doesNotMatch(stillLoading, /reconciled/i);
  assert.match(stillLoading, /Wait a moment/i);
});

test("an axios transport failure is still reported as unreachable", () => {
  // The distinction must not collapse the other way: a genuine network failure carries an Error
  // message too ("Network Error"), and showing that instead of the remedy would be a regression.
  const network = Object.assign(new Error("Network Error"), { code: "ERR_NETWORK", isAxiosError: true });
  assert.equal(classifyLocalServiceFailure(network).outcome, LOCAL_SERVICE_OUTCOMES.UNREACHABLE);
  assert.match(describeLocalServiceFailure(network), /could not reach the local service/);

  const timedOut = Object.assign(new Error("timeout of 8000ms exceeded"), { code: "ECONNABORTED", isAxiosError: true });
  assert.equal(classifyLocalServiceFailure(timedOut).outcome, LOCAL_SERVICE_OUTCOMES.UNREACHABLE);
});

test("an unrecognised local refusal is passed through verbatim rather than swallowed", () => {
  // Only the two known developer-worded throws are rewritten. Anything else is more useful shown
  // as-is than replaced by a generic sentence that discards it.
  const message = describeLocalServiceFailure(new Error("Local backend confirmed LOCAL_ONLY instead of AUTO."));
  assert.equal(message, "Local backend confirmed LOCAL_ONLY instead of AUTO.");
});
