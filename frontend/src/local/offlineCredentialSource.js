/**
 * Offline credential source precedence.
 *
 * Backlog item 5 (`docs/backlog-1.0.72.md`) and design §11.2: offline login used to prefer
 * `snapshot.offline_auth` but fell back **unconditionally** to the `localStorage` record, so a
 * stale browser-profile session naming a `device_id` that exists in no table shadowed a perfectly
 * valid device-bound credential held in SQLite and produced `DEVICE_MISMATCH`, which reads like a
 * permanent lockout.
 *
 * The rules encoded here, in order:
 *
 *   1. A usable SQLite `offline_auth` record always wins over `localStorage`.
 *   2. A `localStorage` record naming a `device_id` that is absent from the known
 *      `local_device_identity` ids is discarded — never treated as authoritative.
 *   3. A `localStorage` record whose `device_id` is one of the known identities is still honoured
 *      (device binding itself is still enforced afterwards by `verifyOfflineSessionRecord`).
 *
 * When no device identities are known at all (browser runtime, no SQLite), rule 2 cannot be
 * evaluated and the `localStorage` record is honoured exactly as before — this fix must not
 * regress the non-desktop path.
 *
 * Device ids are opaque strings (`CLAUDE.md`): they are compared trimmed and exact, never
 * coerced with `Number()` and never case-folded. The literal placeholder `default` is not a real
 * identity and never validates a record.
 *
 * This function is pure: it reads nothing, writes nothing, and clears nothing. A discarded stale
 * record is left in place so it stays diagnosable on the affected machine.
 */

export const OFFLINE_CREDENTIAL_SOURCES = {
  SQLITE: "SQLITE_OFFLINE_AUTH",
  LOCAL_STORAGE: "LOCAL_STORAGE_SESSION",
  NONE: "NONE",
};

export const OFFLINE_CREDENTIAL_DISCARD_REASONS = {
  MALFORMED: "MALFORMED_RECORD",
  UNKNOWN_DEVICE: "UNKNOWN_DEVICE",
  UNBOUND_DEVICE: "UNBOUND_DEVICE",
  SUPERSEDED_BY_SQLITE: "SUPERSEDED_BY_SQLITE",
};

const PLACEHOLDER_DEVICE_ID = "default";

const readableText = (value) => (typeof value === "string" ? value.trim() : "");

const readDeviceId = (record) => {
  const direct = readableText(record?.deviceId);
  return direct || readableText(record?.device_id);
};

const readUsernameLower = (record) => {
  const direct = readableText(record?.usernameLower);
  return (direct || readableText(record?.username_lower)).toLowerCase();
};

/**
 * A credential record is usable only if it carries everything `verifyOfflineSessionRecord` needs.
 * An empty object — which is what the Rust snapshot emits when no `offline_auth::*` row exists —
 * is not a credential, and neither is a string, an array or a partially written record.
 */
export const isUsableOfflineCredentialRecord = (record) => {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  if (!readUsernameLower(record)) return false;
  if (!readableText(record.verifier)) return false;
  if (!readableText(record.salt)) return false;
  return true;
};

export const normalizeKnownDeviceIds = (knownDeviceIds) => {
  const raw = knownDeviceIds instanceof Set
    ? Array.from(knownDeviceIds)
    : Array.isArray(knownDeviceIds)
      ? knownDeviceIds
      : [knownDeviceIds];
  const normalized = [];
  raw.forEach((value) => {
    const deviceId = readableText(value);
    if (!deviceId) return;
    if (deviceId.toLowerCase() === PLACEHOLDER_DEVICE_ID) return;
    if (!normalized.includes(deviceId)) normalized.push(deviceId);
  });
  return normalized;
};

const buildNotice = (discarded, record) => {
  if (record) return "";
  const deviceDiscards = discarded.filter((entry) => (
    entry.reason === OFFLINE_CREDENTIAL_DISCARD_REASONS.UNKNOWN_DEVICE
    || entry.reason === OFFLINE_CREDENTIAL_DISCARD_REASONS.UNBOUND_DEVICE
  ));
  if (deviceDiscards.length === 0) return "";
  return "A saved sign-in on this device names a device that is not registered locally, so it was ignored.";
};

/**
 * @param {object} input
 * @param {object|null} input.snapshotOfflineAuth  `snapshot.offline_auth` read from SQLite.
 * @param {object|null} input.localStorageSession  `readOfflineSession()` from localStorage.
 * @param {string[]|Set<string>|string} input.knownDeviceIds  device ids known to exist in
 *   `local_device_identity` (the resolved active identity and the snapshot identity).
 * @param {string} input.activeDeviceId  the device id offline login is being attempted on.
 * @returns {{record: object|null, source: string, deviceId: string, discarded: Array, notice: string}}
 */
export const resolveOfflineCredentialSource = ({
  snapshotOfflineAuth = null,
  localStorageSession = null,
  knownDeviceIds = [],
  activeDeviceId = "",
} = {}) => {
  const discarded = [];
  const identities = normalizeKnownDeviceIds([
    ...normalizeKnownDeviceIds(knownDeviceIds),
    activeDeviceId,
  ]);

  const sqliteUsable = isUsableOfflineCredentialRecord(snapshotOfflineAuth);
  if (!sqliteUsable && snapshotOfflineAuth !== null && snapshotOfflineAuth !== undefined) {
    const emptySnapshotRecord = typeof snapshotOfflineAuth === "object"
      && !Array.isArray(snapshotOfflineAuth)
      && Object.keys(snapshotOfflineAuth).length === 0;
    if (!emptySnapshotRecord) {
      discarded.push({
        source: OFFLINE_CREDENTIAL_SOURCES.SQLITE,
        reason: OFFLINE_CREDENTIAL_DISCARD_REASONS.MALFORMED,
        deviceId: readDeviceId(snapshotOfflineAuth),
      });
    }
  }

  const localUsable = isUsableOfflineCredentialRecord(localStorageSession);
  const localDeviceId = localUsable ? readDeviceId(localStorageSession) : "";

  if (sqliteUsable) {
    if (localStorageSession !== null && localStorageSession !== undefined) {
      discarded.push({
        source: OFFLINE_CREDENTIAL_SOURCES.LOCAL_STORAGE,
        reason: localUsable
          ? OFFLINE_CREDENTIAL_DISCARD_REASONS.SUPERSEDED_BY_SQLITE
          : OFFLINE_CREDENTIAL_DISCARD_REASONS.MALFORMED,
        deviceId: localDeviceId,
      });
    }
    return {
      record: snapshotOfflineAuth,
      source: OFFLINE_CREDENTIAL_SOURCES.SQLITE,
      deviceId: readDeviceId(snapshotOfflineAuth),
      discarded,
      notice: "",
    };
  }

  if (!localUsable) {
    if (localStorageSession !== null && localStorageSession !== undefined) {
      discarded.push({
        source: OFFLINE_CREDENTIAL_SOURCES.LOCAL_STORAGE,
        reason: OFFLINE_CREDENTIAL_DISCARD_REASONS.MALFORMED,
        deviceId: "",
      });
    }
    return {
      record: null,
      source: OFFLINE_CREDENTIAL_SOURCES.NONE,
      deviceId: "",
      discarded,
      notice: buildNotice(discarded, null),
    };
  }

  if (identities.length > 0) {
    const reason = !localDeviceId
      ? OFFLINE_CREDENTIAL_DISCARD_REASONS.UNBOUND_DEVICE
      : identities.includes(localDeviceId)
        ? ""
        : OFFLINE_CREDENTIAL_DISCARD_REASONS.UNKNOWN_DEVICE;
    if (reason) {
      discarded.push({
        source: OFFLINE_CREDENTIAL_SOURCES.LOCAL_STORAGE,
        reason,
        deviceId: localDeviceId,
      });
      return {
        record: null,
        source: OFFLINE_CREDENTIAL_SOURCES.NONE,
        deviceId: "",
        discarded,
        notice: buildNotice(discarded, null),
      };
    }
  }

  return {
    record: localStorageSession,
    source: OFFLINE_CREDENTIAL_SOURCES.LOCAL_STORAGE,
    deviceId: localDeviceId,
    discarded,
    notice: "",
  };
};
