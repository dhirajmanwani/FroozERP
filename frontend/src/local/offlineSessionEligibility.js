/**
 * May a failed sign-in fall back to a locally cached session?
 *
 * ## The failure
 *
 * On 2026-09-14 a second counter signed in with a password that had been changed on the cloud weeks
 * earlier. The cloud answered 401. `login()` caught it, opened an offline session against the
 * still-cached old credential, and let the person in -- with no cloud token, so every sync
 * afterwards failed. The screen said "Sync Failed", which was true and useless: the fault was in
 * the sign-in, and the sign-in had reported success.
 *
 * "The cloud could not be reached" and "the cloud said no" are different facts. An offline session
 * answers the first. Letting it answer the second turns a refusal into an approval, and hides the
 * one sentence that would have ended the search in a minute.
 *
 * ## Why this is not `classifySessionFailure`
 *
 * That module answers "is the session I already hold over?", and it deliberately classifies
 * login-attempt codes -- `INVALID_CREDENTIALS` among them -- as *not* authentication failures, so
 * that a wrong password is never repainted as "please sign in again". Its own documentation says to
 * keep it off the login screen. Leaning on it here would have been using it for the one job it
 * disclaims, and the first version of this rule did exactly that: `INVALID_CREDENTIALS` came back
 * `authentication: false` and the hole stayed open.
 *
 * So this reads the status and nothing else, which is all the question needs.
 */

/**
 * @param {unknown} failure an axios-style error, or anything with a `response.status`
 * @returns {{ allowed: boolean, reason: string, status: number|null }}
 */
export const describeOfflineSessionEligibility = (failure) => {
  const response = failure && typeof failure === "object" && failure.response && typeof failure.response === "object"
    ? failure.response
    : null;
  const raw = response ? response.status : (failure && typeof failure === "object" ? failure.status : null);
  const status = Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : null;

  if (status === null) {
    // Nothing answered, so nothing refused. This is what an offline session is for, and the shop
    // bills through it.
    return { allowed: true, reason: "NO_ANSWER", status };
  }
  if (status >= 500) {
    // The cloud is broken rather than refusing this person. Closing a counter over somebody else's
    // outage would be a worse failure than the one this rule exists to stop.
    return { allowed: true, reason: "CLOUD_FAULT", status };
  }
  // Every other answer is the cloud engaging with this attempt and declining it -- a wrong
  // password, a device not approved, a locked account, a rate limit. None of those are made true
  // by a local copy of an old credential.
  return { allowed: false, reason: "CLOUD_REFUSED", status };
};

/** Shorthand for the decision alone. */
export const mayOpenOfflineSession = (failure) => describeOfflineSessionEligibility(failure).allowed;
