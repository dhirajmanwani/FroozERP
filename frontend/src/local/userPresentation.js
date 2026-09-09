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

/**
 * The titles the user form offers, in the order they are shown.
 *
 * Deliberately shorter than `HONORIFICS`: that set is what the app *recognises* in a name somebody
 * already typed, this is what it *offers*. A stored title outside this list is still preserved --
 * `splitPersonName` returns it and the form adds it as an option -- so nobody's "Dr." is silently
 * turned into a blank by opening the edit form.
 */
export const NAME_TITLES = Object.freeze(["Mr.", "Mrs.", "Miss"]);

/**
 * Split a stored name into the title in front of it and the name itself.
 *
 * `full_name` is one column and stays one column; the split exists only so the form can offer a
 * title as a choice instead of asking somebody to type it correctly every time.
 *
 * A name that is *only* a title keeps it as the name. Returning `{title: "Mr.", name: ""}` would
 * let the form save an empty name over a real row, which is a worse outcome than an odd one.
 */
export function splitPersonName(fullName = "") {
  const whole = cleanLabel(fullName);
  const words = whole.split(/\s+/).filter(Boolean);
  if (words.length < 2) return { title: "", name: whole };
  const leading = words[0].replace(/\.+$/, "").toLocaleLowerCase("en-IN");
  if (!HONORIFICS.has(leading)) return { title: "", name: whole };
  return { title: words[0], name: words.slice(1).join(" ") };
}

/** Put a chosen title back in front of a name, for storing in `full_name`. */
export function joinPersonName(title, name) {
  const cleanTitle = cleanLabel(title);
  const cleanName = cleanLabel(name);
  if (!cleanTitle) return cleanName;
  if (!cleanName) return cleanTitle;
  return `${cleanTitle} ${cleanName}`;
}

export function getUserInitial(user = {}) {
  return getUserGreetingName(user).charAt(0).toLocaleUpperCase("en-IN") || "U";
}
