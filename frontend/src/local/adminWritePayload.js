// What a Branches & Counters write may carry in its body.
//
// The server refuses any write whose body names a user, device, company or branch other than the
// signed-in session's (`rejectDeviceSessionSubstitution` in backend/deviceSession.js), because a
// body is exactly where an impersonation would be smuggled in. Admin screens are about *other*
// people and places, so their drafts naturally hold those ids -- the staff form holds the cashier's
// `user_id` -- and spreading a draft into the body got every staff assignment refused with
// "user_id does not match the authenticated device session", shown at the top of a long screen
// while the button at the bottom appeared to do nothing (25 Sep 2026).
//
// The admin routes read their subject from the URL and from `target_*` fields, never from these
// four, so dropping them loses nothing and the server check stays exactly as strict.

export const SESSION_IDENTITY_FIELDS = Object.freeze(["user_id", "device_id", "company_id", "branch_id"]);

export function adminWritePayload(payload = {}) {
  const body = { ...payload };
  for (const field of SESSION_IDENTITY_FIELDS) delete body[field];
  return body;
}
