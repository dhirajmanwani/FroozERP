import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { formatShortcut, navigationRegistry } from "./appNavigation.js";
import { SHORTCUT_SHEET_STATUS, buildShortcutSheet, isShortcutSheetChord } from "./keyboardShortcuts.js";

/**
 * The one list of shortcuts a person reads. Half of this proves the list matches the registry the
 * keys resolve against; the other half reads `App.jsx` to prove the keys the list names by hand
 * (Ctrl K, Ctrl /, Esc, F2-F4) are still handled there.
 */

const app = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "App.jsx"),
  "utf8",
);
const css = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "App.css"),
  "utf8",
);

const allIds = navigationRegistry.map((item) => item.id);
const group = (sheet, id) => sheet.groups.find((entry) => entry.id === id);

test("every screen is listed once, with the key that opens it", () => {
  const sheet = buildShortcutSheet({ visibleModuleIds: allIds });
  const screens = group(sheet, "screens").rows;
  assert.equal(sheet.status, SHORTCUT_SHEET_STATUS.READY);
  assert.equal(screens.length, navigationRegistry.length);
  for (const item of navigationRegistry) {
    const row = screens.find((entry) => entry.moduleId === item.id);
    assert.ok(row, `${item.label} is missing from the list`);
    assert.equal(row.keys, formatShortcut(item.shortcut));
    assert.equal(row.label, item.label);
  }
});

test("screens are listed in number-row order, then letters", () => {
  const keys = group(buildShortcutSheet({ visibleModuleIds: allIds }), "screens").rows.map((row) => row.keys);
  assert.deepEqual(keys.slice(0, 10), ["Alt 1", "Alt 2", "Alt 3", "Alt 4", "Alt 5", "Alt 6", "Alt 7", "Alt 8", "Alt 9", "Alt 0"]);
  const letters = keys.slice(10);
  assert.deepEqual(letters, [...letters].sort());
});

test("a screen the sidebar hides is left out of the list too", () => {
  const sheet = buildShortcutSheet({ visibleModuleIds: ["dashboard", "sales", "products"] });
  assert.deepEqual(group(sheet, "screens").rows.map((row) => row.moduleId), ["sales", "products", "dashboard"]);
});

test("the POS keys are listed only for somebody who can open POS Billing", () => {
  assert.ok(group(buildShortcutSheet({ visibleModuleIds: ["sales"] }), "pos"));
  assert.equal(group(buildShortcutSheet({ visibleModuleIds: ["reports"] }), "pos"), undefined);
});

test("an unreadable permission list shows every screen rather than none", () => {
  // Hiding all of them would read as "this app has no shortcuts" — an error rendered as zero.
  for (const visibleModuleIds of [undefined, null, "sales"]) {
    const sheet = buildShortcutSheet({ visibleModuleIds });
    assert.equal(group(sheet, "screens").rows.length, navigationRegistry.length);
  }
});

test("nobody-can-open-anything is a named state, not an empty list", () => {
  const sheet = buildShortcutSheet({ visibleModuleIds: [] });
  assert.equal(sheet.status, SHORTCUT_SHEET_STATUS.NO_SCREENS);
  assert.match(app, /sheet\.status === SHORTCUT_SHEET_STATUS\.NO_SCREENS/, "the sheet must say so on screen");
});

test("Ctrl / opens the list, and nothing near it does", () => {
  const base = { ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, code: "Slash", key: "/" };
  assert.equal(isShortcutSheetChord(base), true);
  assert.equal(isShortcutSheetChord({ ...base, ctrlKey: false, metaKey: true }), true);
  assert.equal(isShortcutSheetChord({ ...base, code: "NumpadDivide" }), true);
  assert.equal(isShortcutSheetChord({ ...base, code: "", key: "/" }), true);
  assert.equal(isShortcutSheetChord({ ...base, ctrlKey: false }), false, "a bare / is typed into notes");
  assert.equal(isShortcutSheetChord({ ...base, altKey: true }), false, "Ctrl+Alt is AltGr");
  assert.equal(isShortcutSheetChord({ ...base, shiftKey: true }), false);
  assert.equal(isShortcutSheetChord({ ...base, isComposing: true }), false);
  assert.equal(isShortcutSheetChord({ ...base, code: "KeyK", key: "k" }), false);
  assert.equal(isShortcutSheetChord(null), false);
});

test("the keys the list names by hand are still handled in App.jsx", () => {
  assert.match(app, /\(event\.ctrlKey \|\| event\.metaKey\) && event\.key\.toLowerCase\(\) === "k"/, "Ctrl K");
  assert.match(app, /if \(isShortcutSheetChord\(event\)\)/, "Ctrl /");
  assert.match(app, /event\.key === "Escape"\) \{\s*setFrostDrawerOpen\(false\);\s*setCommandPaletteOpen\(false\);\s*setShortcutSheetOpen\(false\);/, "Esc closes all three");
  for (const key of ["F2", "F3", "F4"]) {
    assert.match(app, new RegExp(`event\\.key === "${key}"`), `${key} inside POS Billing`);
  }
});

test("the list is reachable from the top bar and lists what the sidebar shows", () => {
  assert.match(app, /aria-label="Keyboard shortcuts"\s+aria-pressed=\{shortcutSheetOpen\}/);
  assert.match(app, /buildShortcutSheet\(\{ visibleModuleIds: visibleNavigationItems\.map\(\(\[view\]\) => view\) \}\)/);
  assert.match(app, /\{visibleNavigationItems\.map\(\(\[view, label\]\) =>/, "the sidebar draws from the same list");
});

test("the list is not a dialog, so the Alt keys still work while it is open", () => {
  const start = app.indexOf("function ShortcutSheet(");
  const body = app.slice(start, app.indexOf("\n}\n", start));
  assert.doesNotMatch(body, /role="dialog"|aria-modal|modal-backdrop/);
});

test("the top bar stays on screen while the page scrolls, and sticky panels start below it", () => {
  const topbar = css.match(/\n\.topbar \{([^}]*)\}/);
  assert.ok(topbar);
  assert.match(topbar[1], /position: sticky;/);
  assert.match(topbar[1], /top: 0;/);
  assert.match(css, /\.checkout-card \{[^}]*top: calc\(var\(--topbar-height, 0px\) \+ 18px\);/);
  assert.match(css, /\.sticky-report-filters \{[^}]*top: calc\(var\(--topbar-height, 0px\) \+ 10px\);/);
});
