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

module.exports = { canonicalAliasClaim, isOwnerBootstrapEligible, normalizeRole };
