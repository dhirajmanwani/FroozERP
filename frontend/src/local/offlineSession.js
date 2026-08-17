const OFFLINE_SESSION_KEY = "froozerp_offline_session_v1";

const encoder = new TextEncoder();

const toBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
};

const randomSalt = () => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toBase64(bytes.buffer);
};

const deriveVerifier = async ({ username, password, salt }) => {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(`${username.toLowerCase()}::${password}`),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: encoder.encode(salt),
      iterations: 150000,
    },
    material,
    256,
  );
  return toBase64(derived);
};

export const readOfflineSession = () => {
  try {
    const raw = localStorage.getItem(OFFLINE_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

export const clearOfflineSession = () => {
  localStorage.removeItem(OFFLINE_SESSION_KEY);
};

export const buildOfflineSessionRecord = async ({
  username,
  password,
  user,
  deviceId,
  branchId,
  lastSuccessfulSyncAt,
}) => {
  const salt = randomSalt();
  const verifier = await deriveVerifier({ username, password, salt });
  const session = {
    usernameLower: String(username || "").trim().toLowerCase(),
    verifier,
    salt,
    deviceId: deviceId || "",
    branchId: String(branchId || user?.branch_id || 1),
    cachedAt: new Date().toISOString(),
    lastSuccessfulSyncAt: lastSuccessfulSyncAt || "",
    user,
  };
  return session;
};

export const verifyOfflineSessionRecord = async (session, { username, password, deviceId }) => {
  if (!session) {
    // Interim wording (backlog item 5.3). The previous text told the user to "connect to the
    // internet once before offline use", which is unsatisfiable when the backend is gone. The
    // local recovery/activation route lands in stage 5 of docs/offline-activation-plan.md; until
    // then this message states the situation without prescribing an impossible action.
    return {
      ok: false,
      code: "NO_SESSION",
      message: "No offline credential is stored on this device for this user, so offline sign-in is not available. On-device activation is not part of this build yet — contact the FroozERP owner before retrying.",
    };
  }
  if (session.deviceId && deviceId && session.deviceId !== deviceId) {
    return { ok: false, code: "DEVICE_MISMATCH", message: "Offline login is only available on the previously authorised device." };
  }
  const usernameLower = String(username || "").trim().toLowerCase();
  if (!usernameLower || usernameLower !== session.usernameLower) {
    return { ok: false, code: "USER_MISMATCH", message: "Offline login is only available for a previously authorised user on this device." };
  }
  const verifier = await deriveVerifier({ username, password, salt: session.salt });
  if (verifier !== session.verifier) {
    return { ok: false, code: "INVALID_CREDENTIALS", message: "Offline credentials do not match the previously authorised user." };
  }
  return { ok: true, session };
};

export const cacheOfflineSession = async (payload) => {
  const session = await buildOfflineSessionRecord(payload);
  localStorage.setItem(OFFLINE_SESSION_KEY, JSON.stringify(session));
  return session;
};

/**
 * localStorage-only authentication. Do NOT use this on the desktop offline-login path: it ignores
 * the SQLite `offline_auth` credential and will happily authenticate against a stale browser
 * record naming a device that no longer exists (backlog item 5). Desktop callers must resolve the
 * credential through `resolveOfflineCredentialSource` in `offlineCredentialSource.js` first.
 */
export const authenticateOfflineSession = async ({ username, password, deviceId }) => {
  const session = readOfflineSession();
  return verifyOfflineSessionRecord(session, { username, password, deviceId });
};
