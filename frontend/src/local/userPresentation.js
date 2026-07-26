const cleanLabel = (value) => String(value || "").trim();
const comparableLabel = (value) => cleanLabel(value).toLocaleLowerCase("en-IN");

export function getUserRoleLabel(user = {}) {
  return cleanLabel(user.role_name || user.role || user.normalized_role) || "User";
}

export function getUserDisplayName(user = {}) {
  const role = getUserRoleLabel(user);
  const fullName = cleanLabel(user.display_name || user.full_name);
  if (fullName && comparableLabel(fullName) !== comparableLabel(role)) {
    return fullName;
  }
  return cleanLabel(user.login_alias)
    || cleanLabel(user.username)
    || cleanLabel(user.canonical_username)
    || fullName
    || role;
}

export function getUserInitial(user = {}) {
  return getUserDisplayName(user).charAt(0).toLocaleUpperCase("en-IN") || "U";
}
