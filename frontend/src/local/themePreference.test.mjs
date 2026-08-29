import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { approvedColours, brandRgb, isBrandColour } from "./brandPalette.js";
import {
  DEFAULT_THEME_MODE,
  RESOLVED_THEME,
  SYSTEM_DARK_QUERY,
  THEME_ATTRIBUTE,
  THEME_MODE,
  THEME_MODES,
  THEME_SOURCE,
  THEME_STORAGE_KEY,
  THEME_WRITE,
  applyThemeMode,
  cycleThemeMode,
  describeThemeMode,
  isThemeMode,
  normaliseThemeMode,
  readThemeMode,
  readThemePreference,
  resolveTheme,
  resolveThemeState,
  systemPrefersDarkFrom,
  themeAttributeValue,
  watchSystemTheme,
  writeThemePreference,
} from "./themePreference.js";

/**
 * Two halves, and the second half is the one that catches the bug this feature is famous
 * for.
 *
 * The first half is the preference logic: three modes, an OS preference, storage that is
 * allowed to be missing or hostile. The property that matters throughout is that there is
 * no input - no stored garbage, no throwing localStorage, no absent matchMedia - that
 * leaves the app without a theme or that silently converts a failure into a preference the
 * person never expressed.
 *
 * The second half parses `theme.css`. A theme file is three near-identical blocks of the
 * same token names, which is exactly the shape a human eye skims: a token defined in the
 * dark blocks and forgotten in `:root` is invisible in review and renders as the other
 * theme's text on this theme's background, on one of the three settings only. The same
 * goes for the two dark blocks drifting apart, which makes the in-app toggle and the
 * Windows setting disagree, and for the missing `:not([data-theme="light"])` guard, which
 * makes an explicit Light choice do nothing on a dark machine. None of the three is
 * catchable by looking; all three are trivially catchable by parsing.
 */

const here = dirname(fileURLToPath(import.meta.url));
const themeCssPath = join(here, "..", "theme.css");
const themeCss = readFileSync(themeCssPath, "utf8");
// Structure is parsed with comments stripped. The header comment in theme.css quotes the
// three selectors verbatim, and a parser that finds the documentation instead of the rule
// would happily report a guard that is only ever written down.
const themeRules = themeCss.replace(/\/\*[\s\S]*?\*\//g, "");

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A localStorage-shaped object backed by a Map. */
const fakeStorage = (seed = {}) => {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    // Test-only window on what was actually persisted.
    _data: data,
  };
};

/** Storage that throws, which is what a webview with site data blocked really does - it
 *  does not politely return null. */
const hostileStorage = ({ onRead = false, onWrite = false } = {}) => ({
  getItem: () => {
    if (onRead) throw new DOMException("The operation is insecure.", "SecurityError");
    return null;
  },
  setItem: () => {
    if (onWrite) throw new DOMException("The operation is insecure.", "SecurityError");
  },
});

/** Just enough of an Element to see what was stamped. */
const fakeRoot = () => {
  const attrs = new Map();
  return {
    setAttribute: (name, value) => attrs.set(name, String(value)),
    removeAttribute: (name) => attrs.delete(name),
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
    hasAttribute: (name) => attrs.has(name),
  };
};

// ---------------------------------------------------------------------------
// The modes themselves
// ---------------------------------------------------------------------------

test("there are exactly three modes and System is the default", () => {
  assert.deepEqual([...THEME_MODES], ["light", "dark", "system"]);
  assert.equal(DEFAULT_THEME_MODE, THEME_MODE.SYSTEM);
  // Frozen because a fourth mode added at runtime would be a mode `theme.css` has no block
  // for, and the app would render untokenised.
  assert.ok(Object.isFrozen(THEME_MODE));
  assert.ok(Object.isFrozen(THEME_MODES));
});

test("only the three modes are modes", () => {
  for (const mode of THEME_MODES) assert.ok(isThemeMode(mode));
  for (const notAMode of ["", "auto", "Light", "SYSTEM", null, undefined, 0, 1, {}, []]) {
    assert.ok(!isThemeMode(notAMode), `${String(notAMode)} must not pass as a mode`);
  }
});

test("normalising an unrecognised value lands on System, not on a guess", () => {
  // System is the only mode that defers to something outside the app, so falling back to
  // it never asserts a preference nobody expressed. Falling back to Light or Dark would.
  for (const junk of ["", "auto", "blue", null, undefined, 42, {}, ["dark"]]) {
    assert.equal(normaliseThemeMode(junk), THEME_MODE.SYSTEM);
  }
  // Casing and stray whitespace are a stored value being sloppy, not a different mode.
  assert.equal(normaliseThemeMode(" Dark "), THEME_MODE.DARK);
  assert.equal(normaliseThemeMode("LIGHT"), THEME_MODE.LIGHT);
});

test("every mode has a label", () => {
  assert.equal(describeThemeMode(THEME_MODE.LIGHT), "Light");
  assert.equal(describeThemeMode(THEME_MODE.DARK), "Dark");
  assert.equal(describeThemeMode(THEME_MODE.SYSTEM), "System");
  // An unlabelled mode would render as an empty settings row - a blank where a choice is.
  assert.equal(describeThemeMode("nonsense"), "System");
});

// ---------------------------------------------------------------------------
// Resolution: mode + OS -> what gets painted
// ---------------------------------------------------------------------------

test("System follows the operating system, in both directions", () => {
  assert.equal(resolveTheme(THEME_MODE.SYSTEM, true), RESOLVED_THEME.DARK);
  assert.equal(resolveTheme(THEME_MODE.SYSTEM, false), RESOLVED_THEME.LIGHT);
});

test("an explicit choice beats the operating system, in both directions", () => {
  // The whole reason `theme.css` needs a guard and an attribute block rather than a media
  // query alone. Light on a dark machine, and dark on a light one.
  assert.equal(resolveTheme(THEME_MODE.LIGHT, true), RESOLVED_THEME.LIGHT);
  assert.equal(resolveTheme(THEME_MODE.DARK, false), RESOLVED_THEME.DARK);
  // And an explicit choice that happens to agree with the OS still resolves to itself.
  assert.equal(resolveTheme(THEME_MODE.LIGHT, false), RESOLVED_THEME.LIGHT);
  assert.equal(resolveTheme(THEME_MODE.DARK, true), RESOLVED_THEME.DARK);
});

test("an OS preference that is not a boolean means 'not dark', which is what CSS does", () => {
  // A webview that cannot answer `prefers-color-scheme` leaves the media query unmatched,
  // and the light block applies. Resolving anywhere else would put the app in a theme the
  // stylesheet is not in.
  for (const unknown of [undefined, null, "dark", 1, {}]) {
    assert.equal(resolveTheme(THEME_MODE.SYSTEM, unknown), RESOLVED_THEME.LIGHT);
  }
});

test("resolveTheme never returns 'system'", () => {
  // `system` is a preference, not a paint colour. Leaking it out of here would put the
  // string "system" into a data-theme attribute that no CSS block matches.
  for (const mode of [...THEME_MODES, "junk", null]) {
    for (const os of [true, false]) {
      const theme = resolveTheme(mode, os);
      assert.ok(
        theme === RESOLVED_THEME.LIGHT || theme === RESOLVED_THEME.DARK,
        `resolveTheme(${String(mode)}, ${os}) returned ${theme}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// The stamp
// ---------------------------------------------------------------------------

test("System stamps nothing at all", () => {
  // This is the single most load-bearing assertion in the file. Stamping data-theme for
  // System would pin the app to whatever the OS said at startup: it would look correct on
  // launch and then never follow the machine again.
  assert.equal(themeAttributeValue(THEME_MODE.SYSTEM), null);
  assert.equal(themeAttributeValue("garbage"), null, "an unusable value is System, so it also stamps nothing");

  const root = fakeRoot();
  root.setAttribute(THEME_ATTRIBUTE, "dark");
  assert.equal(applyThemeMode(root, THEME_MODE.SYSTEM), null);
  assert.ok(!root.hasAttribute(THEME_ATTRIBUTE), "switching back to System must remove the attribute, not blank it");
});

test("an explicit mode stamps its own name", () => {
  assert.equal(themeAttributeValue(THEME_MODE.LIGHT), "light");
  assert.equal(themeAttributeValue(THEME_MODE.DARK), "dark");

  const root = fakeRoot();
  assert.equal(applyThemeMode(root, THEME_MODE.DARK), "dark");
  assert.equal(root.getAttribute(THEME_ATTRIBUTE), "dark");
  assert.equal(applyThemeMode(root, THEME_MODE.LIGHT), "light");
  assert.equal(root.getAttribute(THEME_ATTRIBUTE), "light");
});

test("stamping survives a missing root", () => {
  // Startup ordering: a theme that throws because the document is not there yet takes the
  // whole app with it, and the app is the till.
  for (const root of [null, undefined, {}, 0]) {
    assert.doesNotThrow(() => applyThemeMode(root, THEME_MODE.DARK));
    assert.equal(applyThemeMode(root, THEME_MODE.DARK), "dark");
  }
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

test("a stored mode is read back as stored", () => {
  for (const mode of THEME_MODES) {
    const result = readThemePreference(fakeStorage({ [THEME_STORAGE_KEY]: mode }));
    assert.equal(result.mode, mode);
    assert.equal(result.source, THEME_SOURCE.STORED);
  }
});

test("nothing stored is DEFAULT, not INVALID", () => {
  const result = readThemePreference(fakeStorage());
  assert.equal(result.mode, THEME_MODE.SYSTEM);
  // A first run and a corrupted profile are different situations and must stay
  // distinguishable, even though both paint the same theme.
  assert.equal(result.source, THEME_SOURCE.DEFAULT);
  assert.equal(result.stored, null);
});

test("garbage in storage resolves to System and reports itself", () => {
  for (const junk of ["", "auto", "midnight", "{}", "DARK"]) {
    const result = readThemePreference(fakeStorage({ [THEME_STORAGE_KEY]: junk }));
    assert.equal(result.mode, DEFAULT_THEME_MODE, `${junk} must not become a mode`);
    assert.equal(result.source, THEME_SOURCE.INVALID);
    // The offending value comes back rather than vanishing - an error that renders as a
    // silent default is the failure this codebase keeps rewriting rules about.
    assert.equal(result.stored, junk);
  }
});

test("storage that throws on read still yields a theme", () => {
  const result = readThemePreference(hostileStorage({ onRead: true }));
  assert.equal(result.mode, DEFAULT_THEME_MODE);
  // UNAVAILABLE, not INVALID: nothing was wrong with the preference, the device refused to
  // hand it over. A settings screen should say "this device will not remember your choice".
  assert.equal(result.source, THEME_SOURCE.UNAVAILABLE);
});

test("no storage at all still yields a theme", () => {
  for (const storage of [null, undefined, {}, { getItem: "not a function" }]) {
    const result = readThemePreference(storage);
    assert.equal(result.mode, DEFAULT_THEME_MODE);
    assert.equal(result.source, THEME_SOURCE.UNAVAILABLE);
  }
  assert.equal(readThemeMode(null), DEFAULT_THEME_MODE);
});

test("writing a mode stores exactly that string", () => {
  for (const mode of THEME_MODES) {
    const storage = fakeStorage();
    const result = writeThemePreference(storage, mode);
    assert.deepEqual(result, { mode, stored: true, reason: THEME_WRITE.SAVED });
    assert.equal(storage._data.get(THEME_STORAGE_KEY), mode);
    // Round-trips: what is written is what is read.
    assert.equal(readThemeMode(storage), mode);
  }
});

test("System is written explicitly, not by clearing the key", () => {
  // So that "chose System" and "never chose" stay distinguishable on disk even though they
  // paint identically today.
  const storage = fakeStorage({ [THEME_STORAGE_KEY]: THEME_MODE.DARK });
  writeThemePreference(storage, THEME_MODE.SYSTEM);
  assert.equal(storage._data.get(THEME_STORAGE_KEY), THEME_MODE.SYSTEM);
  assert.equal(readThemePreference(storage).source, THEME_SOURCE.STORED);
});

test("writing something that is not a mode is refused, and does not overwrite", () => {
  const storage = fakeStorage({ [THEME_STORAGE_KEY]: THEME_MODE.DARK });
  const result = writeThemePreference(storage, "midnight");
  assert.equal(result.stored, false);
  assert.equal(result.reason, THEME_WRITE.REJECTED);
  assert.equal(result.mode, DEFAULT_THEME_MODE);
  // The existing good value is still there. Writing junk through would turn one bad call
  // into a permanently broken profile.
  assert.equal(storage._data.get(THEME_STORAGE_KEY), THEME_MODE.DARK);
});

test("storage that throws on write does not break the choice", () => {
  const result = writeThemePreference(hostileStorage({ onWrite: true }), THEME_MODE.LIGHT);
  // The mode still comes back so the caller can apply it: an unremembered theme is fine,
  // an unapplied one is not.
  assert.equal(result.mode, THEME_MODE.LIGHT);
  assert.equal(result.stored, false);
  assert.equal(result.reason, THEME_WRITE.UNAVAILABLE);
});

test("no storage at all does not break the choice", () => {
  for (const storage of [null, undefined, {}]) {
    const result = writeThemePreference(storage, THEME_MODE.DARK);
    assert.equal(result.mode, THEME_MODE.DARK);
    assert.equal(result.stored, false);
    assert.equal(result.reason, THEME_WRITE.UNAVAILABLE);
  }
});

// ---------------------------------------------------------------------------
// The OS media query
// ---------------------------------------------------------------------------

test("the query string this module documents is the one the stylesheet keys off", () => {
  assert.equal(SYSTEM_DARK_QUERY, "(prefers-color-scheme: dark)");
  assert.ok(
    themeRules.includes(`@media ${SYSTEM_DARK_QUERY}`),
    "theme.css must react to the same query App.jsx is told to watch",
  );
});

test("a MediaQueryList is read strictly", () => {
  assert.equal(systemPrefersDarkFrom({ matches: true }), true);
  assert.equal(systemPrefersDarkFrom({ matches: false }), false);
  // `matches: undefined` on an unsupported query must be "not dark", never truthy-adjacent.
  assert.equal(systemPrefersDarkFrom({}), false);
  assert.equal(systemPrefersDarkFrom(null), false);
  assert.equal(systemPrefersDarkFrom({ matches: "true" }), false);
});

test("watching the OS delivers both directions and unsubscribes cleanly", () => {
  const listeners = new Set();
  const mql = {
    matches: false,
    addEventListener: (type, fn) => type === "change" && listeners.add(fn),
    removeEventListener: (type, fn) => listeners.delete(fn),
  };
  const seen = [];
  const stop = watchSystemTheme(mql, (dark) => seen.push(dark));
  for (const fn of listeners) fn({ matches: true });
  for (const fn of listeners) fn({ matches: false });
  assert.deepEqual(seen, [true, false]);
  stop();
  assert.equal(listeners.size, 0, "the listener must actually come off");
  for (const fn of listeners) fn({ matches: true });
  assert.deepEqual(seen, [true, false], "no deliveries after unsubscribe");
});

test("watching falls back to the legacy addListener API", () => {
  // Older WebView2 ships a MediaQueryList without addEventListener, and on those builds
  // following the OS *is* the feature.
  let handler = null;
  const mql = {
    matches: true,
    addListener: (fn) => (handler = fn),
    removeListener: () => (handler = null),
  };
  const seen = [];
  const stop = watchSystemTheme(mql, (dark) => seen.push(dark));
  assert.equal(typeof handler, "function");
  handler({ matches: false });
  assert.deepEqual(seen, [false]);
  stop();
  assert.equal(handler, null);
});

test("watching something unwatchable returns a callable unsubscribe", () => {
  // So the caller's cleanup path has no special case, in a webview that has no matchMedia.
  for (const mql of [null, undefined, {}, { matches: true }]) {
    const stop = watchSystemTheme(mql, () => {});
    assert.equal(typeof stop, "function");
    assert.doesNotThrow(stop);
  }
  assert.doesNotThrow(() => watchSystemTheme({ addEventListener() {} }, null)());
});

test("a change event without its own matches falls back to the list", () => {
  let handler = null;
  const mql = { matches: true, addEventListener: (_t, fn) => (handler = fn), removeEventListener: () => {} };
  const seen = [];
  watchSystemTheme(mql, (dark) => seen.push(dark));
  handler({});
  assert.deepEqual(seen, [true]);
});

// ---------------------------------------------------------------------------
// The one-call summary
// ---------------------------------------------------------------------------

test("resolveThemeState answers every question a caller has at once", () => {
  const stored = resolveThemeState(fakeStorage({ [THEME_STORAGE_KEY]: "light" }), true);
  assert.deepEqual(stored, {
    mode: "light",
    source: THEME_SOURCE.STORED,
    stored: "light",
    theme: RESOLVED_THEME.LIGHT, // beats the dark OS
    attribute: "light",
    followsSystem: false,
    remembered: true,
  });

  const fresh = resolveThemeState(fakeStorage(), true);
  assert.equal(fresh.mode, THEME_MODE.SYSTEM);
  assert.equal(fresh.theme, RESOLVED_THEME.DARK);
  assert.equal(fresh.attribute, null, "System stamps nothing");
  assert.equal(fresh.followsSystem, true);
  assert.equal(fresh.remembered, false);

  const broken = resolveThemeState(hostileStorage({ onRead: true }), false);
  assert.equal(broken.source, THEME_SOURCE.UNAVAILABLE);
  assert.equal(broken.theme, RESOLVED_THEME.LIGHT);
  assert.equal(broken.remembered, false, "a device that cannot store must not claim it did");
});

test("cycling visits all three modes and always moves", () => {
  assert.equal(cycleThemeMode(THEME_MODE.LIGHT), THEME_MODE.DARK);
  assert.equal(cycleThemeMode(THEME_MODE.DARK), THEME_MODE.SYSTEM);
  assert.equal(cycleThemeMode(THEME_MODE.SYSTEM), THEME_MODE.LIGHT);
  // An unrecognised current mode normalises to System, so the cycle still advances rather
  // than appearing stuck to somebody pressing the key.
  assert.equal(cycleThemeMode("junk"), THEME_MODE.LIGHT);
});

// ---------------------------------------------------------------------------
// theme.css: structure
// ---------------------------------------------------------------------------

/** The body of the first block whose header matches `header`, brace-balanced. */
function blockBody(source, header) {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `theme.css must contain a \`${header}\` block`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(source.indexOf("{", start) + 1, i);
    }
  }
  throw new Error(`unbalanced braces after ${header}`);
}

/** Custom-property declarations in a block body, as name -> value. */
function tokens(body) {
  const found = new Map();
  for (const match of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    found.set(match[1], match[2].trim());
  }
  return found;
}

const MEDIA_HEADER = '@media (prefers-color-scheme: dark)';
const ATTRIBUTE_HEADER = ':root[data-theme="dark"]';

const lightTokens = tokens(blockBody(themeRules, ":root {"));
const mediaDarkTokens = tokens(blockBody(themeRules, MEDIA_HEADER));
const attributeDarkTokens = tokens(blockBody(themeRules, ATTRIBUTE_HEADER));

test("the light palette is complete and is what :root holds", () => {
  // A guard that reads an empty file passes forever.
  assert.ok(lightTokens.size >= 50, `expected a full token set in :root, found ${lightTokens.size}`);
  for (const [name, value] of lightTokens) {
    assert.ok(value.length > 0, `${name} has no value`);
  }
  // The roles the conversion stage is going to reach for first. Named individually so that
  // deleting one fails here rather than three stages later in a half-converted stylesheet.
  for (const required of [
    "--ground", "--panel", "--card", "--raised", "--raised-high", "--track", "--scrim",
    "--ink", "--ink-body", "--ink-muted", "--ink-faint", "--ink-on-accent",
    "--line", "--line-strong",
    "--accent", "--accent-bright", "--accent-soft", "--accent-deep",
    "--danger", "--danger-soft", "--success", "--success-soft",
    "--info", "--info-soft", "--warning", "--warning-soft",
  ]) {
    assert.ok(lightTokens.has(required), `:root must define ${required}`);
  }
});

test("every token the dark blocks define is also defined in :root", () => {
  // The classic unreadable-theme bug: a token that exists only in a dark block is undefined
  // in the light state, so it resolves to nothing - which is not "no colour", it is the
  // other theme's value inherited from wherever the property came from. It shows up on one
  // of the three settings only, which is exactly how it reaches a shop counter.
  for (const [label, block] of [["the media block", mediaDarkTokens], ["the attribute block", attributeDarkTokens]]) {
    const orphans = [...block.keys()].filter((name) => !lightTokens.has(name));
    assert.deepEqual(orphans, [], `${label} defines tokens :root never does: ${orphans.join(", ")}`);
  }
});

test("the two dark blocks are identical, token for token and value for value", () => {
  // They have to be duplicated - CSS cannot share a declaration list across a media-query
  // boundary - so the only thing keeping the in-app Dark toggle and the Windows dark
  // setting showing the same app is this assertion.
  assert.deepEqual(
    [...mediaDarkTokens.keys()].sort(),
    [...attributeDarkTokens.keys()].sort(),
    "the two dark blocks define different token sets",
  );
  for (const [name, value] of mediaDarkTokens) {
    assert.equal(
      attributeDarkTokens.get(name),
      value,
      `${name} differs between the media block and the attribute block`,
    );
  }
  assert.ok(mediaDarkTokens.size >= 50, "the dark blocks look suspiciously small");
});

test("the prefers-color-scheme block is guarded against an explicit Light choice", () => {
  // Without :not([data-theme="light"]), a person on a dark machine who picks Light gets the
  // dark palette straight back: :root has already been overwritten by the time their
  // attribute is considered, and the attribute selector has nothing left to beat.
  const media = themeRules.slice(themeRules.indexOf(MEDIA_HEADER));
  const selector = media.slice(0, media.indexOf("{", media.indexOf("{") + 1));
  assert.ok(
    /:root:not\(\[data-theme="light"\]\)/.test(selector),
    `the dark media query must be scoped to :root:not([data-theme="light"]), got: ${selector.trim()}`,
  );
});

test("the three blocks are in the order the cascade needs", () => {
  const rootAt = themeRules.indexOf(":root {");
  const mediaAt = themeRules.indexOf(MEDIA_HEADER);
  const attributeAt = themeRules.indexOf(ATTRIBUTE_HEADER);
  assert.ok(rootAt < mediaAt, ":root must come before the dark media query");
  assert.ok(
    mediaAt < attributeAt,
    'the explicit :root[data-theme="dark"] block must come last, or the media query would beat it at equal specificity',
  );
});

test("there is no prefers-color-scheme: light block", () => {
  // The light values are the unconditional ones. Putting them behind a media query would
  // leave a browser that reports no preference with no palette at all.
  assert.ok(!/prefers-color-scheme:\s*light/.test(themeRules));
});

test("print colours are stated once and never re-themed", () => {
  // An invoice is white paper in both themes. A dark-themed invoice is an unreadable bill
  // and a wasted cartridge, so these deliberately live only in :root.
  for (const name of ["--paper", "--paper-ink", "--paper-line", "--accent-deep"]) {
    assert.ok(lightTokens.has(name), `:root must define ${name}`);
    assert.ok(!mediaDarkTokens.has(name), `${name} must not be re-themed for dark`);
    assert.ok(!attributeDarkTokens.has(name), `${name} must not be re-themed for dark`);
  }
  assert.equal(lightTokens.get("--paper"), "#ffffff");
});

test("both themes set color-scheme, so native controls follow", () => {
  // Scrollbars, date pickers and the pre-paint flash are drawn by the webview, not by us.
  // Without this they stay light under a dark theme and flash white on every launch.
  assert.ok(/color-scheme:\s*light/.test(blockBody(themeRules, ":root {")));
  assert.ok(/color-scheme:\s*dark/.test(blockBody(themeRules, MEDIA_HEADER)));
  assert.ok(/color-scheme:\s*dark/.test(blockBody(themeRules, ATTRIBUTE_HEADER)));
});

// ---------------------------------------------------------------------------
// theme.css: colours
// ---------------------------------------------------------------------------

test("theme.css uses only approved palette colours", () => {
  // The same guard brandPalette.test.mjs puts on App.css. A colour invented here would be
  // invented in the one file every other file is about to inherit from.
  const offenders = [];
  themeCss.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      if (!isBrandColour(match[0])) offenders.push(`  line ${index + 1}: ${match[0]}`);
    }
  });
  assert.deepEqual(offenders, [], `off-palette colours in theme.css:\n${offenders.join("\n")}`);
});

test("theme.css builds translucent layers out of approved colours", () => {
  // The approved triple set is built from the palette itself rather than restated, so a
  // colour added there is usable here without a second edit.
  const approved = new Set();
  for (const colour of approvedColours()) {
    const rgb = brandRgb(colour);
    if (rgb) approved.add(`${rgb.r},${rgb.g},${rgb.b}`);
  }
  const offenders = [];
  themeCss.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)) {
      const triple = `${match[1]},${match[2]},${match[3]}`;
      if (!approved.has(triple)) offenders.push(`  line ${index + 1}: ${match[0]}...)`);
    }
  });
  assert.deepEqual(offenders, [], `off-palette rgba() bases in theme.css:\n${offenders.join("\n")}`);
});

// ---------------------------------------------------------------------------
// theme.css: contrast
// ---------------------------------------------------------------------------

const relativeLuminance = (hex) => {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const channel = (v) => {
    const c = parseInt(v, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)].map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a, b) => {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const SURFACES = ["--ground", "--panel", "--card", "--raised", "--raised-high"];

/** Worst-case contrast of one token against every surface in a theme, opaque values only. */
function worstAgainstSurfaces(theme, name) {
  const fg = theme.get(name);
  assert.ok(fg && fg.startsWith("#"), `${name} must be an opaque colour to be measured`);
  return SURFACES.reduce((worst, surface) => {
    const bg = theme.get(surface);
    assert.ok(bg && bg.startsWith("#"), `${surface} must be an opaque colour`);
    return Math.min(worst, contrast(fg, bg));
  }, Infinity);
}

for (const [themeName, theme] of [["light", lightTokens], ["dark", mediaDarkTokens]]) {
  test(`${themeName}: reading text clears 7:1 on every surface`, () => {
    // 4.5:1 is the AA floor; 7:1 is what this app aims for on text somebody reads for a
    // whole shift at a counter. Measured against the worst of the five surfaces, because a
    // card is a surface a paragraph really does land on.
    for (const name of ["--ink", "--ink-strong", "--ink-strong-warm", "--ink-body", "--ink-body-warm"]) {
      const ratio = worstAgainstSurfaces(theme, name);
      assert.ok(ratio >= 7, `${themeName} ${name} is ${ratio.toFixed(2)}:1 at worst, below 7:1`);
    }
  });

  test(`${themeName}: secondary text and signals clear 4.5:1 on every surface`, () => {
    for (const name of [
      "--ink-muted", "--ink-muted-warm", "--accent",
      "--danger", "--success", "--info", "--warning", "--attention",
    ]) {
      const ratio = worstAgainstSurfaces(theme, name);
      assert.ok(ratio >= 4.5, `${themeName} ${name} is ${ratio.toFixed(2)}:1 at worst, below 4.5:1`);
    }
  });

  test(`${themeName}: --ink-faint is dimmer than --ink-muted and is not a reading colour`, () => {
    // Deliberately not held to 4.5:1 - it is the disabled/placeholder step, and on light it
    // measures 4.37:1 against --ground. What must hold is that the ramp is still a ramp: a
    // faint step that is not fainter than muted means one of them is doing the other's job.
    const faint = worstAgainstSurfaces(theme, "--ink-faint");
    const muted = worstAgainstSurfaces(theme, "--ink-muted");
    assert.ok(faint < muted, `${themeName} --ink-faint (${faint.toFixed(2)}:1) must be dimmer than --ink-muted (${muted.toFixed(2)}:1)`);
    assert.ok(faint >= 2.5, `${themeName} --ink-faint is ${faint.toFixed(2)}:1 - too dim even for a placeholder`);
  });

  test(`${themeName}: text on an accent fill is readable`, () => {
    // --accent is a background here, not text: this is the label on a gold button. The dark
    // theme's gold is far too light to take light text and the light theme's is far too
    // dark to take dark text, which is why --ink-on-accent is themed at all.
    const ratio = contrast(theme.get("--ink-on-accent"), theme.get("--accent"));
    assert.ok(ratio >= 4.5, `${themeName} --ink-on-accent on --accent is ${ratio.toFixed(2)}:1`);
  });

  test(`${themeName}: --line-control is perceivable as a boundary`, () => {
    // WCAG 1.4.11 wants 3:1 for a non-text boundary that carries meaning. --line and
    // --line-strong are hairlines and do not reach it, which is exactly why this token
    // exists as a separate one rather than as an alias.
    const ratio = worstAgainstSurfaces(theme, "--line-control");
    assert.ok(ratio >= 3, `${themeName} --line-control is ${ratio.toFixed(2)}:1 at worst, below 3:1`);
  });

  test(`${themeName}: text on a signal's soft surface is readable`, () => {
    // Only where both are opaque - the dark theme builds its soft surfaces translucently on
    // purpose, so that one value works over all five grounds, and those cannot be measured
    // without compositing.
    for (const signal of ["danger", "success", "info", "warning", "attention"]) {
      const surface = theme.get(`--${signal}-soft`);
      const ink = theme.get(`--${signal}-ink`);
      if (!surface || !surface.startsWith("#") || !ink || !ink.startsWith("#")) continue;
      const ratio = contrast(ink, surface);
      assert.ok(ratio >= 4.5, `${themeName} --${signal}-ink on --${signal}-soft is ${ratio.toFixed(2)}:1`);
    }
  });
}

test("the dark theme's surfaces are the palette's own ground ramp", () => {
  // Not "near enough". If these drift, the themed app and the parts of App.css that have
  // not been converted yet stop matching, and the seam is visible.
  //
  // `--ground` was `#082116` until the contrast pass moved it one step deeper to `GROUND.abyss`.
  // The seam this test guards against needs a literal painting the *same role*: a background of
  // the old value sitting beside a background of the new one. Every remaining `#082116` in
  // App.css is a `color:` -- text, and mostly invoice text that is deliberately never themed --
  // so there is nothing left to disagree with. Checked before the value was changed, not assumed.
  assert.equal(mediaDarkTokens.get("--ground"), "#03110b");
  assert.equal(mediaDarkTokens.get("--panel"), "#092318");
  assert.equal(mediaDarkTokens.get("--card"), "#123623");
  assert.equal(mediaDarkTokens.get("--ink"), "#f6f3ea");
  assert.equal(mediaDarkTokens.get("--accent"), "#d9ac52");
});

test("no remaining literal paints a surface that a moved token also paints", () => {
  // The rule behind the test above, stated so it keeps working when the next token moves. A
  // leftover literal is only a seam when it fills a *flat* background, border or shadow -- the
  // same job a surface token does. As `color:` it is text and cannot disagree with anything.
  //
  // Gradient stops are excluded, and that is a rule rather than an exception for the one case that
  // prompted it. A stop is a point in a blend, not a plane that meets the page along an edge; the
  // Frost launcher's conic ring holds two of these values and cannot seam against anything,
  // because nothing else is that colour anywhere near it.
  const appCss = readFileSync(new URL("../App.css", import.meta.url), "utf8");
  const surfacePainted = (appCss.match(
    /(background|border|box-shadow|outline)[^;{}]*#(082116|1e4a34|2c5d43|4a7a61)\b/gi,
  ) || []).filter((declaration) => !/gradient\(/i.test(declaration));
  assert.deepEqual(
    surfacePainted,
    [],
    "a surface still hardcodes a colour a token has moved away from, which shows as a patch of the "
    + "old theme. Convert it to the token before moving the token.",
  );
});

test("the light theme does not reuse the dark theme's gold", () => {
  // #d9ac52 measures 2.87:1 on white. ACCENT.deep exists precisely so that the light theme
  // has a gold that survives paper, and reaching for the dark one here is the single
  // easiest way to ship an unreadable light theme.
  assert.notEqual(lightTokens.get("--accent"), mediaDarkTokens.get("--accent"));
  // `ACCENT.deepStrong`, not `deep`. #8a6520 clears 4.5:1 on a white card and only 3.6:1 on the
  // light theme's sidebar -- and gold labels sit on the sidebar. The working accent has to survive
  // every light surface, not just the lightest one, so `deep` stays available as `--accent-deep`
  // for the places that are always on white.
  assert.equal(lightTokens.get("--accent"), "#6b4d18");
  assert.ok(contrast("#d9ac52", "#ffffff") < 4.5, "the premise of this test still holds");
});


// -------------------------------------------------------------------------------------------
// The guard that was missing.
//
// Thirteen veil tokens were added with their DARK values inside the `:root` light block, and never
// added to the dark blocks at all. Every existing structural test passed: "dark tokens are also in
// :root" held vacuously because the tokens were not in the dark blocks, and "both dark blocks agree"
// held because both were equally empty. Dark mode looked right, inheriting the values from :root by
// accident, while light mode painted a 96%-opaque dark green over every card.
//
// A value can be in the correct block and still be the wrong value. So this asserts the property
// nothing else did: the light theme has to actually be light.
// -------------------------------------------------------------------------------------------

/** A translucent layer as it lands on the surface below it - which is the only way to judge it. */
const overSurface = (token, surface) => {
  const value = String(token).trim();
  if (!value.startsWith("rgba(")) return relativeLuminance(value);
  const parts = value.replace(/rgba\(|\)/g, "").split(",").map((part) => Number(part.trim()));
  const alpha = parts[3];
  const base = [1, 3, 5].map((i) => parseInt(surface.slice(i, i + 2), 16));
  const mixed = parts.slice(0, 3).map((c, i) => Math.round(c * alpha + base[i] * (1 - alpha)));
  const toHex = (n) => n.toString(16).padStart(2, "0");
  return relativeLuminance(`#${mixed.map(toHex).join("")}`);
};

test("every light surface is actually light", () => {
  // Composited on white, because that is what a veil sits on in the light theme. A dark value here
  // is not a subtle mismatch: it is a dark panel in a light app, which is what shipped.
  const surfaces = ["--ground", "--panel", "--card", "--raised", "--raised-high",
    "--veil-faint", "--veil-subtle", "--veil", "--veil-strong", "--veil-heavy", "--veil-solid",
    "--card-veil-soft", "--card-veil", "--card-veil-solid"];
  const tooDark = surfaces
    .filter((token) => lightTokens.has(token))
    .map((token) => [token, overSurface(lightTokens.get(token), "#ffffff")])
    .filter(([, luminance]) => luminance < 0.5);
  assert.deepEqual(tooDark, [], "these light-theme surfaces are dark; a dark value is in the light block");
});

test("every dark surface is actually dark", () => {
  // The mirror, so the same mistake in the other direction is caught too.
  const surfaces = ["--ground", "--panel", "--card", "--raised", "--raised-high",
    "--veil-subtle", "--veil", "--veil-strong", "--veil-heavy", "--veil-solid",
    "--card-veil", "--card-veil-solid"];
  const tooLight = surfaces
    .filter((token) => mediaDarkTokens.has(token))
    .map((token) => [token, overSurface(mediaDarkTokens.get(token), "#03110b")])
    .filter(([, luminance]) => luminance > 0.3);
  assert.deepEqual(tooLight, [], "these dark-theme surfaces are light");
});

test("every token App.css uses has a value in the light theme", () => {
  // The other half of the same bug: a token defined only in a dark block would fall back to
  // nothing in light, and the declaration using it would be dropped silently.
  // Comments stripped first. A comment explaining that `var(--text)` was broken counts as a use of
  // `--text` otherwise, and the test fails on its own documentation -- which is exactly how the
  // structure tests in this file first went wrong, finding a rule quoted in a header comment
  // instead of the rule.
  const appCss = readFileSync(new URL("../App.css", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const used = new Set([...appCss.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1]));
  // Font sizing lives in index.css, not the colour theme.
  const colourTokens = [...used].filter((token) => !/^--font/.test(token) && token !== "--font-scale");
  const undefinedInLight = colourTokens.filter((token) => !lightTokens.has(token)).sort();
  assert.deepEqual(undefinedInLight, [], "App.css uses these tokens but the light theme never defines them");
});


test("the mark has no tile of its own", () => {
  // Ruled by the maintainer, after two attempts at a badge: no box behind the symbol. It sits
  // directly on whatever it is placed on and carries its own colour. Both earlier versions -- a
  // gold wash, then a solid tile -- were a container the logo never asked for, and the second was
  // competing with it. Asserted on the rule rather than on a token, because the failure mode is
  // somebody adding a background back to make it "stand out".
  const appCss = readFileSync(new URL("../App.css", import.meta.url), "utf8");
  const start = appCss.indexOf(".brand-monogram {");
  assert.ok(start > 0, "the mark's wrapper must still exist");
  const rule = appCss.slice(start, appCss.indexOf("}", start)).replace(/\/\*[\s\S]*?\*\//g, "");
  for (const property of ["background", "border", "box-shadow"]) {
    assert.doesNotMatch(
      rule,
      new RegExp(`\\b${property}\\s*:`),
      `the mark must not paint a ${property}; it sits on the app, not in a box`,
    );
  }
});

test("each cut of the mark reads on the ground it is shown against", () => {
  // With no tile, the surface behind the mark is the app itself -- so the cut has to suit the
  // theme, and the theme switch is the only thing making it legible. The cream cut on a light page
  // would be a mark nobody can see, which is what shipped before the switch existed.
  const darkGround = mediaDarkTokens.get("--ground");
  const lightSurfaces = [lightTokens.get("--ground"), lightTokens.get("--panel"), lightTokens.get("--card")];
  assert.ok(contrast("#f6f3ea", darkGround) >= 7, "the cream cut must read on the dark page");
  for (const surface of lightSurfaces) {
    assert.ok(contrast("#0a2d1c", surface) >= 7, `the green cut must read on ${surface}`);
  }
});
