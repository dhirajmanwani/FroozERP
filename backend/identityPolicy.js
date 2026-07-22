const normalizeRole = (value) => String(value || "").trim().toUpperCase();

const isOwnerBootstrapEligible = (user) => (
  user?.active !== false
  && normalizeRole(user?.role_name || user?.role) === "OWNER"
);

const canonicalAliasClaim = ({ canonicalUserId, deviceId, requestedUsername }) => {
  const userId = Number(canonicalUserId);
  const device = String(deviceId || "").trim();
  const alias = String(requestedUsername || "").trim().toLowerCase();
  if (!Number.isInteger(userId) || userId <= 0 || !device || !alias) return null;
  return { userId, deviceId: device, requestedUsername: alias };
};

const unresolvedLoginDeviceGate = ({ device, username, password }) => {
  if (!String(username || "").trim() || !String(password || "")) {
    return { code: "INVALID_CREDENTIALS", status: 401 };
  }
  if (!device?.device_id) {
    return { code: "DEVICE_ID_REQUIRED", status: 403 };
  }
  const deviceStatus = String(device.status || "PENDING").trim().toUpperCase();
  if (deviceStatus === "DISABLED") return { code: "DEVICE_DISABLED", status: 403 };
  if (deviceStatus === "REVOKED") return { code: "DEVICE_REVOKED", status: 403 };
  if (deviceStatus === "PENDING") return { code: "DEVICE_PENDING_APPROVAL", status: 403 };
  return { code: "INVALID_CREDENTIALS", status: 401 };
};

module.exports = {
  canonicalAliasClaim,
  isOwnerBootstrapEligible,
  normalizeRole,
  unresolvedLoginDeviceGate,
};
