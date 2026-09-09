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

/**
 * Titles that sit in front of a name without being part of it.
 *
 * Written with the Indian forms the shop actually uses alongside the English ones, and matched
 * without the full stop so "Mr" and "Mr." are one entry.
 */
const HONORIFICS = new Set([
  "mr", "mrs", "ms", "miss", "mx", "dr", "prof", "er", "ca", "adv",
  "shri", "sri", "smt", "sh", "kum",
]);

/**
 * The name to greet somebody by, and to take an initial from.
 *
 * `full_name` is what the shop types, and it often begins with a title -- the Owner here is
 * "Mr. Dhiraj Manwani". Taking the first word of that greets him as "Mr." and puts M on his
 * avatar, which reads as a broken screen rather than as a formal one.
 *
 * A name made only of titles is still that person's name: fall back to the first word rather than
 * returning nothing, because an empty greeting is worse than an odd one.
 */
export function getUserGreetingName(user = {}) {
  const words = getUserDisplayName(user).split(/\s+/).filter(Boolean);
  const named = words.find(
    (word) => !HONORIFICS.has(word.replace(/\.+$/, "").toLocaleLowerCase("en-IN")),
  );
  return named || words[0] || "";
}

export function getUserInitial(user = {}) {
  return getUserGreetingName(user).charAt(0).toLocaleUpperCase("en-IN") || "U";
}
