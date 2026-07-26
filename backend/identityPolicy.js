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

const approvedAliasCredentialFailure = ({ canonicalAliasUsed, device }) => {
  const status = String(device?.status || "").trim().toUpperCase();
  if (!canonicalAliasUsed || status !== "APPROVED" || !device?.approved_by) {
    return null;
  }
  return {
    code: "CANONICAL_CREDENTIALS_REQUIRED",
    status: 401,
    message: "Device approved. Enter the password for the canonical FroozERP account to finish secure provisioning.",
  };
};

module.exports = {
  approvedAliasCredentialFailure,
  canonicalAliasClaim,
  isOwnerBootstrapEligible,
  normalizeRole,
  unresolvedLoginDeviceGate,
};
