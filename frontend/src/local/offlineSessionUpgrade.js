/**
 * Turning an offline sign-in back into a cloud session once the cloud answers again.
 *
 * ## The failure (owner, 8 Nov 2026)
 *
 * The cloud was down for a while. A laptop signed in during that time, so `login()` opened an
 * offline session: the cached credential let the person in, and the session carries no cloud token,
 * by construction. The cloud came back, but nothing ever upgraded that session. Every sync cycle
 * afterwards was refused (`401 AUTH_SESSION_REQUIRED POST /api/sync/register-device` in the cloud
 * log), so the laptop never pulled again: bills made on the other laptop never took their stock off
 * this one, and the only cure was to sign out and back in.
 *
 * ## What this decides
 *
 * Whether, right now, the app should try the cloud sign-in again for the person already signed in,
 * and what to do with the answer. The attempt itself (`/login` with the same username and password
 * the person typed at the start of this session) lives in App.jsx; the password never leaves memory
 * and is not stored anywhere new. App.jsx already keeps the typed password in its form state for the
 * life of the window, so retrying with it adds no exposure.
 *
 * ## Rules
 *
 * - Only an offline session, only when the Owner has not chosen Local Only, only when a cloud is
 *   configured. Local Only must stay at zero cloud calls.
 * - Never while a bill is being made: swapping the session re-renders the whole app, and a cashier
 *   mid-bill must not see the screen move. The attempt waits until the cart is empty.
 * - At most one attempt per `retryAfterMs` (a minute by default), and never two at once.
 * - A refusal from the cloud (wrong or changed password, device not approved, locked account) ends
 *   the retries for this session and says so. Retrying a refused password every minute would walk
 *   the account into the login lockout.
 * - The cloud must answer for the same person. A different user id is refused, never adopted.
 */

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

export const OFFLINE_UPGRADE_RETRY_MS = 60_000;

/**
 * @returns {{ attempt: boolean, reason: string }}
 *   reason is one of NOT_OFFLINE, LOCAL_ONLY, NO_CLOUD, NO_PASSWORD, REFUSED, BILL_IN_PROGRESS,
 *   IN_FLIGHT, TOO_SOON, READY.
 */
export const decideOfflineSessionUpgrade = ({
  user,
  localOnly = false,
  cloudConfigured = true,
  hasPassword = false,
  billInProgress = false,
  inFlight = false,
  refused = false,
  lastAttemptAt = 0,
  now = Date.now(),
  retryAfterMs = OFFLINE_UPGRADE_RETRY_MS,
} = {}) => {
  if (!user || user.offline_session !== true) return { attempt: false, reason: "NOT_OFFLINE" };
  if (localOnly) return { attempt: false, reason: "LOCAL_ONLY" };
  if (!cloudConfigured) return { attempt: false, reason: "NO_CLOUD" };
  if (refused) return { attempt: false, reason: "REFUSED" };
  if (!hasPassword) return { attempt: false, reason: "NO_PASSWORD" };
  if (billInProgress) return { attempt: false, reason: "BILL_IN_PROGRESS" };
  if (inFlight) return { attempt: false, reason: "IN_FLIGHT" };
  const last = Number(lastAttemptAt);
  if (Number.isFinite(last) && last > 0 && now - last < retryAfterMs) {
    return { attempt: false, reason: "TOO_SOON" };
  }
  return { attempt: true, reason: "READY" };
};

const statusOf = (error) => {
  const raw = error?.response?.status ?? error?.status;
  const status = Number(raw);
  return Number.isFinite(status) && status > 0 ? status : null;
};

/**
 * What the answer to the retried sign-in means.
 *
 * @returns {{ outcome: "UPGRADED"|"STILL_OFFLINE"|"REFUSED"|"IDENTITY_MISMATCH", user?: object, message: string }}
 *   UPGRADED carries the cloud's user (with its token) to sign in with. STILL_OFFLINE means try
 *   again later; nothing was refused. REFUSED and IDENTITY_MISMATCH stop the retries.
 */
export const resolveOfflineSessionUpgrade = ({ offlineUser, response, error } = {}) => {
  if (error) {
    const status = statusOf(error);
    if (status === null || status >= 500) {
      return { outcome: "STILL_OFFLINE", message: "" };
    }
    const code = text(error?.response?.data?.code);
    const serverMessage = text(error?.response?.data?.message);
    return {
      outcome: "REFUSED",
      message: `The cloud is back but did not accept this sign-in${serverMessage ? ` (${serverMessage})` : code ? ` (${code})` : ""}. Sign out and sign in again so this computer syncs.`,
    };
  }
  const cloudUser = response?.data;
  if (!cloudUser || typeof cloudUser !== "object" || !text(cloudUser.device_session_token)) {
    // A 2xx without a session token cannot sync any better than the offline session it would
    // replace. Treated as "not yet", not as success.
    return { outcome: "STILL_OFFLINE", message: "" };
  }
  const offlineId = text(offlineUser?.canonical_user_id ?? offlineUser?.id);
  const cloudId = text(cloudUser.id);
  if (!offlineId || !cloudId || offlineId !== cloudId) {
    return {
      outcome: "IDENTITY_MISMATCH",
      message: "The cloud answered for a different user than the one signed in here. Sign out and sign in again.",
    };
  }
  return { outcome: "UPGRADED", user: cloudUser, message: "Cloud is back. This computer is syncing again." };
};
