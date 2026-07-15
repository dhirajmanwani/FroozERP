const normalizeRole = (value) => String(value || "").trim().toUpperCase();

const isOwnerBootstrapEligible = (user) => (
  user?.active !== false
  && normalizeRole(user?.role_name || user?.role) === "OWNER"
);

module.exports = { isOwnerBootstrapEligible, normalizeRole };
