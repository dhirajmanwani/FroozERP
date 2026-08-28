/**
 * Which of Light / Dark / System the app is set to, and what that means on screen.
 *
 * The shape is Windows': three choices, where System is not a third palette but the
 * absence of a choice - the OS decides, and it keeps deciding, so a counter that switches
 * to dark at sunset follows without anyone touching the app. `theme.css` implements that
 * by keying the dark values off `prefers-color-scheme` *and* off a `data-theme` attribute,
 * which leaves this module with one job that is easy to get wrong:
 *
 *   **For System, stamp nothing.** `data-theme="light"` and `data-theme="dark"` are how an
 *   explicit choice overrides the OS. Stamping either one for System would pin the app to
 *   whatever the OS happened to say at startup and it would never follow a change again -
 *   a bug that looks exactly like the feature working, until the machine flips at dusk.
 *
 * Two more decisions worth stating, because both were deliberate:
 *
 * - **The OS preference arrives as an argument.** Nothing here calls `matchMedia`, touches
 *   `document` or reads `localStorage` at module scope. The DOM lives in App.jsx; this file
 *   stays a pure function of (stored value, OS preference) so it can be tested without one.
 * - **An unusable stored value resolves to System, and says so.** `readThemePreference`
 *   returns a `source` alongside the mode - STORED, DEFAULT, INVALID or UNAVAILABLE - so a
 *   caller can tell "this device will not remember your choice" from "you have not chosen
 *   yet". Silently landing on a default and calling it the person's setting is the failure
 *   mode this codebase keeps writing rules about.
 *
 * A webview with site data switched off must still render a *themed* app; it just renders
 * an unremembered one. Every storage access below is therefore wrapped, and a throw from
 * storage is a degraded result, never an exception the caller has to catch.
 */

/** The three display modes. `system` is the default and the only one that stamps nothing. */
export const THEME_MODE = Object.freeze({
  LIGHT: "light",
  DARK: "dark",
  SYSTEM: "system",
});

/** In the order a settings control should offer them: the two explicit choices, then the
 *  one that defers. */
export const THEME_MODES = Object.freeze([
  THEME_MODE.LIGHT,
  THEME_MODE.DARK,
  THEME_MODE.SYSTEM,
]);

export const DEFAULT_THEME_MODE = THEME_MODE.SYSTEM;

/** What actually gets painted. There are only two of these - `system` is not a theme. */
export const RESOLVED_THEME = Object.freeze({
  LIGHT: "light",
  DARK: "dark",
});

/** Where the mode a caller is holding came from. Named rather than inferred, so "no choice
 *  yet" and "your choice could not be read back" are distinguishable at the call site. */
export const THEME_SOURCE = Object.freeze({
  STORED: "stored", // read back exactly as it was written
  DEFAULT: "default", // nothing stored yet - the honest default
  INVALID: "invalid", // something was stored, but not a mode this app knows
  UNAVAILABLE: "unavailable", // storage is missing or refused to be read
});

/** The outcome of trying to remember a choice. */
export const THEME_WRITE = Object.freeze({
  SAVED: "saved",
  REJECTED: "rejected", // not a mode - refused rather than written through
  UNAVAILABLE: "unavailable", // storage is missing or refused the write
});

export const THEME_STORAGE_KEY = "frooz.display-mode";

/** The attribute `theme.css` keys its override blocks off. */
export const THEME_ATTRIBUTE = "data-theme";

/** The media query whose result feeds `resolveTheme`. Exported so the caller passing the
 *  OS preference in and the stylesheet reacting to it cannot drift apart. */
export const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

const THEME_MODE_LABELS = Object.freeze({
  [THEME_MODE.LIGHT]: "Light",
  [THEME_MODE.DARK]: "Dark",
  [THEME_MODE.SYSTEM]: "System",
});

/** True only for one of the three modes. Anything else - including "", null, and the
 *  resolved-looking string "auto" - is not a mode. */
export function isThemeMode(value) {
  return typeof value === "string" && THEME_MODES.includes(value);
}

/**
 * Any input to one of the three modes. Unrecognised input becomes System, which is the
 * default rather than a guess: it is the one mode that defers to something outside the app,
 * so landing on it never asserts a preference the person did not express.
 */
export function normaliseThemeMode(value) {
  if (isThemeMode(value)) return value;
  if (typeof value === "string" && isThemeMode(value.trim().toLowerCase())) {
    return value.trim().toLowerCase();
  }
  return DEFAULT_THEME_MODE;
}

/** "Light" / "Dark" / "System", for a settings control. */
export function describeThemeMode(mode) {
  return THEME_MODE_LABELS[normaliseThemeMode(mode)];
}

/**
 * The theme to actually paint, from the mode and what the OS currently says.
 *
 * `systemPrefersDark` must be a real boolean. Anything else means the OS did not report a
 * dark preference, and light is what CSS itself does when `prefers-color-scheme: dark`
 * does not match - so a webview that cannot answer the question lands where the stylesheet
 * would have landed on its own, rather than somewhere this module invented.
 */
export function resolveTheme(mode, systemPrefersDark) {
  const normalised = normaliseThemeMode(mode);
  if (normalised === THEME_MODE.LIGHT) return RESOLVED_THEME.LIGHT;
  if (normalised === THEME_MODE.DARK) return RESOLVED_THEME.DARK;
  return systemPrefersDark === true ? RESOLVED_THEME.DARK : RESOLVED_THEME.LIGHT;
}

/**
 * What belongs in `data-theme`, or null when the attribute must be absent.
 *
 * Null is the whole point of System: with no attribute the media query in `theme.css` is
 * the only thing deciding, which is what makes the app follow the OS live.
 */
export function themeAttributeValue(mode) {
  const normalised = normaliseThemeMode(mode);
  if (normalised === THEME_MODE.LIGHT) return RESOLVED_THEME.LIGHT;
  if (normalised === THEME_MODE.DARK) return RESOLVED_THEME.DARK;
  return null;
}

/**
 * Stamp (or unstamp) the root element. Returns the value written, or null if the attribute
 * was removed - so the caller can assert what happened rather than re-reading the DOM.
 *
 * Tolerant of a missing root because this runs during startup, where the document is not
 * always there yet, and a theme that throws takes the whole app down with it.
 */
export function applyThemeMode(root, mode) {
  const value = themeAttributeValue(mode);
  if (!root || typeof root.setAttribute !== "function") return value;
  if (value === null) {
    if (typeof root.removeAttribute === "function") root.removeAttribute(THEME_ATTRIBUTE);
    return null;
  }
  root.setAttribute(THEME_ATTRIBUTE, value);
  return value;
}

/**
 * The stored mode plus where it came from.
 *
 * Four outcomes, all named: read back cleanly, nothing stored yet, something stored that
 * is not a mode, or storage unusable. All four resolve to a mode the caller can paint with
 * immediately - the app never fails to have a theme because of this function.
 */
export function readThemePreference(storage) {
  if (!storage || typeof storage.getItem !== "function") {
    return { mode: DEFAULT_THEME_MODE, source: THEME_SOURCE.UNAVAILABLE, stored: null };
  }

  let raw;
  try {
    raw = storage.getItem(THEME_STORAGE_KEY);
  } catch {
    // A webview with site data blocked throws here rather than returning null. That is a
    // storage failure, not a preference, and it must not become one.
    return { mode: DEFAULT_THEME_MODE, source: THEME_SOURCE.UNAVAILABLE, stored: null };
  }

  if (raw === null || raw === undefined) {
    return { mode: DEFAULT_THEME_MODE, source: THEME_SOURCE.DEFAULT, stored: null };
  }
  if (isThemeMode(raw)) {
    return { mode: raw, source: THEME_SOURCE.STORED, stored: raw };
  }
  // Something is in there and it is not one of ours - a hand-edited profile, or a value
  // from a future build. Report it back so it can be surfaced or logged instead of
  // disappearing into the default.
  return { mode: DEFAULT_THEME_MODE, source: THEME_SOURCE.INVALID, stored: raw };
}

/** Just the mode, for callers that have nothing to do with the four outcomes. */
export function readThemeMode(storage) {
  return readThemePreference(storage).mode;
}

/**
 * Remember a choice. Returns what was actually stored and why, so "saved" and "this device
 * will not remember it" are distinguishable; the `mode` in the result is the one to apply
 * either way, because a theme that cannot be persisted still has to be shown.
 *
 * System is written explicitly rather than removing the key: "chose System" and "never
 * chose" resolve identically today, and keeping them distinct on disk costs nothing and
 * leaves room for a first-run prompt later.
 */
export function writeThemePreference(storage, mode) {
  if (!isThemeMode(mode)) {
    return { mode: DEFAULT_THEME_MODE, stored: false, reason: THEME_WRITE.REJECTED };
  }
  if (!storage || typeof storage.setItem !== "function") {
    return { mode, stored: false, reason: THEME_WRITE.UNAVAILABLE };
  }
  try {
    storage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Quota, private mode, or site data switched off. The choice still applies for this
    // session; it just will not survive a restart.
    return { mode, stored: false, reason: THEME_WRITE.UNAVAILABLE };
  }
  return { mode, stored: true, reason: THEME_WRITE.SAVED };
}

/** Whether a `MediaQueryList` (or anything shaped like one) is reporting dark. Strictly
 *  boolean out: `resolveTheme` treats anything but `true` as "not dark", and this is where
 *  a `.matches` of `undefined` is turned into that rather than passed along. */
export function systemPrefersDarkFrom(mediaQueryList) {
  return Boolean(mediaQueryList && mediaQueryList.matches === true);
}

/**
 * Subscribe to the OS flipping between light and dark. Returns an unsubscribe function -
 * always callable, even when there was nothing to subscribe to, so a caller's cleanup path
 * has no special case.
 *
 * `addListener` is kept because older WebView2 builds ship a `MediaQueryList` without
 * `addEventListener`, and on those the OS-follow behaviour is the entire feature.
 */
export function watchSystemTheme(mediaQueryList, onChange) {
  if (!mediaQueryList || typeof onChange !== "function") return () => {};

  const handler = (event) => {
    const source = event && typeof event.matches === "boolean" ? event : mediaQueryList;
    onChange(systemPrefersDarkFrom(source));
  };

  if (typeof mediaQueryList.addEventListener === "function") {
    mediaQueryList.addEventListener("change", handler);
    return () => {
      if (typeof mediaQueryList.removeEventListener === "function") {
        mediaQueryList.removeEventListener("change", handler);
      }
    };
  }
  if (typeof mediaQueryList.addListener === "function") {
    mediaQueryList.addListener(handler);
    return () => {
      if (typeof mediaQueryList.removeListener === "function") {
        mediaQueryList.removeListener(handler);
      }
    };
  }
  return () => {};
}

/**
 * Everything a caller needs in one object, so the settings screen and the startup path
 * cannot resolve the same inputs differently.
 */
export function resolveThemeState(storage, systemPrefersDark) {
  const { mode, source, stored } = readThemePreference(storage);
  return {
    mode,
    source,
    stored,
    theme: resolveTheme(mode, systemPrefersDark),
    attribute: themeAttributeValue(mode),
    followsSystem: mode === THEME_MODE.SYSTEM,
    remembered: source === THEME_SOURCE.STORED,
  };
}

/** Light -> Dark -> System -> Light, for a keyboard toggle. Anything unrecognised starts
 *  the cycle at Light rather than staying put, so a toggle always visibly does something. */
export function cycleThemeMode(mode) {
  const index = THEME_MODES.indexOf(normaliseThemeMode(mode));
  return THEME_MODES[(index + 1) % THEME_MODES.length];
}
