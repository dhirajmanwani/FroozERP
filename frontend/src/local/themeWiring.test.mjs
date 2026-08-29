/**
 * The theme preference, as App.jsx actually uses it.
 *
 * `themePreference.test.mjs` proves the logic; this proves the screen calls it correctly. The two
 * failures worth guarding are both invisible in a passing unit test: stamping an attribute for
 * System, which silently overrides the operating system and breaks the mode it claims to be, and
 * defaulting the preference in an effect rather than on the first render, which shows as a flash
 * of the wrong theme on every launch.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

test("the theme is read from storage on the first render, not corrected afterwards", () => {
  // A default-then-correct opens the app in the wrong theme and switches it a frame later. On a
  // counter machine that is a white flash into a dark room, every single launch.
  const start = app.indexOf("const [themeMode, setThemeMode] = useState(");
  assert.ok(start > 0, "themeMode must be initialised lazily from storage");
  assert.match(app.slice(start, start + 260), /readThemeMode\(window\.localStorage\)/);
});

test("System is applied by removing the attribute, never by stamping one", () => {
  // The whole mechanism. `prefers-color-scheme` only decides the theme when nothing is stamped, so
  // writing `data-theme="light"` for System would pin it and the app would stop following Windows
  // while still calling itself System. App.jsx must delegate that to the module rather than
  // reimplementing the rule inline.
  assert.match(app, /applyThemeMode\(document\.documentElement, themeMode\)/);
  assert.doesNotMatch(
    app,
    /dataset\.theme\s*=|setAttribute\(\s*["']data-theme["']/,
    "App.jsx must not stamp data-theme itself",
  );
});

test("an OS change does not re-stamp anything", () => {
  // When Windows flips while the app is in System mode, CSS has already switched. The listener
  // exists only so the caption can say which way it resolved; if it also stamped an attribute it
  // would convert System into an explicit choice at the first sunset.
  const start = app.indexOf("watchSystemTheme(");
  assert.ok(start > 0, "the app must follow the OS while in System mode");
  const call = app.slice(start, start + 120);
  assert.match(call, /setSystemPrefersDark/, "the OS change updates state, and only state");
  assert.doesNotMatch(call, /applyThemeMode|setThemeMode\b/);
});

test("the picker offers exactly the three modes, from the module", () => {
  // Hardcoding the options here is how a fourth mode gets added to the module and never appears on
  // screen, or a removed one lingers as a dead choice.
  assert.match(app, /THEME_MODES\.map\(\(mode\) =>/);
  assert.match(app, /describeThemeMode\(mode\)\.label/);
});

test("choosing a mode writes it, and a refused write is reported", () => {
  // `writeThemePreference` refuses anything that is not a mode rather than storing it. A refusal
  // means the screen and the stored value disagree, which is a bug here rather than a user action,
  // so it must not pass silently.
  assert.match(app, /writeThemePreference\(window\.localStorage, themeMode\)/);
  assert.match(app, /theme-preference-rejected/);
});

test("the screen says which way System is currently resolving", () => {
  // "System" on its own tells nobody what they are about to get, and the answer changes without
  // them touching anything.
  assert.match(app, /resolveTheme\(themeMode, systemPrefersDark\)/);
  assert.match(app, /Windows is asking for/);
});

test("the picker says printing is unaffected", () => {
  // The obvious worry a display-mode control raises, answered where it is raised: a dark-themed
  // invoice would be unreadable and would empty a cartridge. The tokens already guarantee it; the
  // person choosing the mode has no way to know that unless it is written down.
  assert.match(app, /white paper in every mode/i);
});
