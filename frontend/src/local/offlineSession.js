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
    // Backlog item 5.3, finalised now that Stage 5 has shipped (offline-activation-plan.md).
    //
    // Two different lockouts used to share this one sentence, and it was wrong about both.
    //
    //   A device that was never provisioned at all never reaches here - it is Unprovisioned, and
    //   App.jsx shows the activation screen, where an owner redeems a .lic file with no internet
    //   at all. So "on-device activation is not part of this build yet" is simply false now, and
    //   telling an owner that while a working door stands open is the worst kind of wrong message.
    //
    //   What actually reaches here is the narrower case: the device IS provisioned, but this
    //   particular user has never signed in on it. There is genuinely no offline route for that
    //   one - a .lic provisions a device, not a person - so the message says what is true and
    //   names what still works, rather than inventing a rescue.
    return {
      ok: false,
      code: "NO_SESSION",
      message: "This device has no offline sign-in record for this user. Anyone who has already signed in on it can still sign in with no internet. Adding a new user to this device still needs it to reach FroozERP once.",
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
