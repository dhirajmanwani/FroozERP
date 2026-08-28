import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  NAVIGATION_KIND,
  NAVIGATION_LOOKUP,
  canGoBack,
  canGoForward,
  createNavigationHistory,
  currentHistoryEntry,
  findNavigationSection,
  formatShortcut,
  goBack,
  goForward,
  isTypingContext,
  navigationRegistry,
  navigationTargets,
  pushNavigation,
  resolveNavigationTarget,
  resolveShortcutTarget,
  SETTINGS_GROUPS,
} from "./appNavigation.js";

/**
 * The registry restates things that live in `App.jsx`, and restated knowledge goes wrong quietly.
 * Half of this file is therefore read against `App.jsx` source text — the existing convention in
 * this directory for facts that only exist inside that 17k-line file. The other half is the rule
 * that a shortcut must not fire while somebody is typing, which is the one failure here that
 * would be felt by a customer rather than by the maintainer.
 */

const app = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "App.jsx"),
  "utf8",
);

const blockAfter = (source, from) => {
  // Everything up to the next top-level declaration. Anchored on the line start so a nested
  // `function` inside the body cannot end the slice early.
  const rest = source.slice(from);
  const next = rest.search(/\n(?:function|class|const|export) /);
  return next === -1 ? rest : rest.slice(0, next);
};

const functionBody = (name) => {
  const start = app.search(new RegExp(`^function ${name}\\(`, "m"));
  assert.ok(start > 0, `${name} must exist in App.jsx`);
  return blockAfter(app, start + 1);
};

// ---------------------------------------------------------------------------
// Drift guards: the registry against App.jsx
// ---------------------------------------------------------------------------

test("the registry lists exactly the modules the sidebar lists", () => {
  // Both directions. A module in the sidebar and not here has no shortcut and no palette entry;
  // a module here and not in the sidebar is a palette entry that navigates to a view nothing
  // renders, which lands the person on a blank screen with no error.
  const block = app.match(/const navigationItems = \[([\s\S]*?)\n\];/);
  assert.ok(block, "navigationItems must still be a literal array in App.jsx");
  const sidebar = [...block[1].matchAll(/\["([^"]+)", "([^"]+)"\]/g)].map(([, id, label]) => ({ id, label }));
  assert.equal(sidebar.length, 15, "guard against a silently truncated parse");

  assert.deepEqual(
    navigationRegistry.map((item) => item.id),
    sidebar.map((item) => item.id),
    "registry ids must match navigationItems, in the same order the sidebar draws them",
  );
  // The label is what a person searches the palette for. A registry label that has drifted from
  // the sidebar means the same screen has two names in one app.
  assert.deepEqual(
    navigationRegistry.map((item) => item.label),
    sidebar.map((item) => item.label),
  );
});

test("every icon the registry names actually exists", () => {
  // `Icon` renders `{paths[name]}`. An unknown name is `undefined`, which React renders as
  // nothing at all: no crash, no warning, just a nav row with a blank where the glyph should be.
  const paths = app.slice(app.indexOf("function Icon({"), app.indexOf("class ModuleErrorBoundary"));
  const known = new Set([...paths.matchAll(/^\s{4}([a-zA-Z]+): <>/gm)].map(([, name]) => name));
  assert.ok(known.size > 10, "the Icon paths map must have been parsed, not missed");
  for (const item of navigationRegistry) {
    assert.ok(known.has(item.icon), `${item.id} uses icon "${item.icon}", which Icon does not define`);
  }
});

test("the registry uses the same icon the sidebar does", () => {
  // The chip in the palette and the row in the sidebar are the same destination. Two different
  // glyphs for it is the kind of small wrongness that makes a tool feel untrustworthy.
  const block = app.match(/const icons = \{([\s\S]*?)\n\};/);
  assert.ok(block, "the icons map must still be a literal object");
  const sidebarIcons = new Map(
    [...block[1].matchAll(/^\s{2}"?([a-z-]+)"?: "([a-z]+)",/gm)].map(([, id, icon]) => [id, icon]),
  );
  for (const item of navigationRegistry) {
    assert.equal(item.icon, sidebarIcons.get(item.id), `${item.id} icon must match the sidebar's`);
  }
});

test("every Settings section on the page has a registry entry, in page order", () => {
  // Settings is one long scroll of ModuleCards. The drill-down is only honest if it lists the
  // cards that are actually rendered, so the list is rebuilt here from `SettingsModule`'s own
  // children rather than hand-copied a second time.
  const settingsModule = functionBody("SettingsModule");
  const children = [...settingsModule.matchAll(/<([A-Z][A-Za-z0-9]*)/g)]
    .map(([, name]) => name)
    // An error boundary's fallback card is a failure state, not a destination somebody can ask
    // to be taken to.
    .filter((name) => !name.endsWith("ErrorBoundary"))
    .filter((name, index, all) => all.indexOf(name) === index);

  const sections = [];
  for (const name of children) {
    const body = functionBody(name);
    const cards = [...body.matchAll(/<ModuleCard\s+eyebrow="([^"]+)"\s+title="([^"]+)"/g)];
    if (cards.length === 0) continue;
    const eyebrows = new Set(cards.map(([, eyebrow]) => eyebrow));
    assert.equal(eyebrows.size, 1, `${name} renders cards under more than one eyebrow; the registry assumes one group per section component`);
    sections.push({ component: name, eyebrow: cards[0][1], titles: cards.map(([, , title]) => title) });
  }

  assert.ok(sections.length > 10, "the Settings section components must have been found, not missed");
  const registered = navigationRegistry.find((item) => item.id === "settings").sections;
  assert.equal(
    registered.length,
    sections.length,
    "a Settings section was added or removed on the page without being added or removed here",
  );

  sections.forEach((section, index) => {
    const entry = registered[index];
    assert.equal(entry.eyebrow, section.eyebrow, `${section.component} is grouped under "${section.eyebrow}" on the page`);
    // Matched against the titles the component can render rather than a single string, because a
    // section that has a loading placeholder renders two — and a placeholder is not a rename.
    assert.ok(
      section.titles.includes(entry.label),
      `${entry.id} is labelled "${entry.label}", which ${section.component} never renders (it renders ${section.titles.join(" / ")})`,
    );
    assert.match(entry.id, /^settings\//, "a section id must name the module it lives in");
  });
});

test("the Report Center drill-down lists the categories Report Center actually has", () => {
  const anchor = app.indexOf('{ id: "orders", title: "Order Reports"');
  assert.ok(anchor > 0, "the report categories must still be a literal array");
  const start = app.lastIndexOf("const categories = [", anchor);
  const block = app.slice(start, app.indexOf("\n  ];", start));
  const categories = [...block.matchAll(/\{ id: "([^"]+)", title: "([^"]+)"/g)].map(([, id, title]) => ({ id, title }));
  assert.equal(categories.length, 8, "guard against a truncated parse of the category list");

  const registered = navigationRegistry.find((item) => item.id === "reports").sections;
  assert.deepEqual(
    registered.map((section) => ({ id: section.id, title: section.label })),
    categories.map((category) => ({ id: `reports/${category.id}`, title: category.title })),
    "a report category id here must be the id Report Center selects with, or the drill-down opens nothing",
  );
});

test("a module with no drill-down still declares an empty section list", () => {
  // So a consumer can iterate `sections` without testing for undefined first.
  for (const item of navigationRegistry) {
    assert.ok(Array.isArray(item.sections), `${item.id} must have a sections array`);
  }
});

test("keywords never repeat the label", () => {
  // Search already matches the label. Repeating it there costs a match nothing and hides the
  // fact that a destination has no real synonyms — which is what a person searches with.
  for (const target of navigationTargets) {
    for (const keyword of target.keywords) {
      assert.notEqual(
        keyword.toLowerCase(),
        target.label.toLowerCase(),
        `${target.id} repeats its own label as a keyword`,
      );
    }
  }
});

test("no two destinations share an id", () => {
  const seen = new Set();
  for (const target of navigationTargets) {
    assert.ok(!seen.has(target.id), `duplicate navigation id "${target.id}"`);
    seen.add(target.id);
  }
});

// ---------------------------------------------------------------------------
// Shortcuts
// ---------------------------------------------------------------------------

const keyEvent = (overrides = {}) => ({
  altKey: true,
  ctrlKey: false,
  metaKey: false,
  isComposing: false,
  repeat: false,
  code: "Digit1",
  key: "1",
  target: null,
  ...overrides,
});

const digitEvent = (digit, overrides = {}) => keyEvent({ code: `Digit${digit}`, key: String(digit), ...overrides });

test("every assigned shortcut reaches its module", () => {
  const assigned = navigationRegistry.filter((item) => item.shortcut !== null);
  assert.ok(assigned.length > 0, "the whole feature is the shortcuts; some must be assigned");
  for (const item of assigned) {
    const resolved = resolveShortcutTarget(digitEvent(item.shortcut));
    assert.ok(resolved, `Alt+${item.shortcut} resolved to nothing`);
    assert.equal(resolved.id, item.id, `Alt+${item.shortcut} must open ${item.id}`);
  }
});

test("the till has the most reachable key", () => {
  // POS Billing is where the day is spent. If this ever moves, it moved on purpose.
  assert.equal(resolveShortcutTarget(digitEvent(1)).id, "sales");
});

test("Alt+0 is a real shortcut and not swallowed by a falsy check", () => {
  // "0" is the one shortcut a `if (shortcut)` guard silently drops, in the registry, in the chip
  // and in the resolver. It is asserted at all three.
  const dashboard = navigationRegistry.find((item) => item.id === "dashboard");
  assert.equal(dashboard.shortcut, "0");
  assert.equal(formatShortcut(dashboard.shortcut), "Alt 0");
  assert.equal(resolveShortcutTarget(digitEvent(0)).id, "dashboard");
});

test("no two modules claim the same key", () => {
  const used = navigationRegistry.map((item) => item.shortcut).filter((shortcut) => shortcut !== null);
  assert.equal(new Set(used).size, used.length, "a duplicated shortcut makes one of the two unreachable");
});

test("the chip text and the resolver agree about what a shortcut is", () => {
  // They are printed and matched from the same field, so a renamed modifier cannot leave the
  // sidebar promising a chord nothing listens for.
  assert.equal(formatShortcut("1"), "Alt 1");
  assert.equal(formatShortcut(null), "");
  assert.equal(formatShortcut(undefined), "");
  assert.equal(formatShortcut(""), "");
  // A numeric 0 must survive too, in case a caller ever stores digits rather than strings.
  assert.equal(formatShortcut(0), "Alt 0");
});

test("an unassigned key does nothing rather than something", () => {
  // Alt+8 is Sale Returns today; whichever digit is spare must not fall through to a default.
  const spare = "123456789 0".split("").find((digit) => /[0-9]/.test(digit) && !navigationRegistry.some((item) => item.shortcut === digit));
  if (spare) assert.equal(resolveShortcutTarget(digitEvent(spare)), null);
  assert.equal(resolveShortcutTarget(keyEvent({ code: "KeyQ", key: "q" })), null);
  assert.equal(resolveShortcutTarget(keyEvent({ code: "F5", key: "F5" })), null);
  assert.equal(resolveShortcutTarget(null), null);
});

test("a bare digit never navigates", () => {
  // Quantities are typed all day. Without the modifier this feature would fire constantly.
  assert.equal(resolveShortcutTarget(digitEvent(1, { altKey: false })), null);
});

test("AltGr is not Alt", () => {
  // On Indian and European layouts AltGr arrives as Ctrl+Alt while the person is typing an
  // ordinary character. Firing there would throw them across the app mid-word.
  assert.equal(resolveShortcutTarget(digitEvent(1, { ctrlKey: true })), null);
  assert.equal(resolveShortcutTarget(digitEvent(1, { metaKey: true })), null);
});

test("the shortcut is read from the physical key, not the character", () => {
  // Under Alt, `event.key` is unreliable across layouts — a dead key, a composed character or
  // the unmodified letter, depending on the machine. `event.code` does not move.
  assert.equal(resolveShortcutTarget(keyEvent({ code: "Digit1", key: "±" })).id, "sales");
  // The numeric keypad is the same key to the person pressing it.
  assert.equal(resolveShortcutTarget(keyEvent({ code: "Numpad1", key: "1" })).id, "sales");
  // And a browser that reports no `code` at all still works from `key`.
  assert.equal(resolveShortcutTarget(keyEvent({ code: undefined, key: "1" })).id, "sales");
});

/**
 * The group that protects a live sale. A cashier is inside a search box or a quantity field for
 * most of the working day, often with a customer waiting and a half-built bill on screen. A key
 * that jumped screens from there would lose the bill, so suppression is asserted for every kind
 * of field rather than only the one that was easiest to reproduce.
 */
test("a shortcut does not fire while somebody is typing in an input", () => {
  assert.equal(resolveShortcutTarget(digitEvent(1, { target: { tagName: "INPUT" } })), null);
});

test("a shortcut does not fire in a textarea", () => {
  assert.equal(resolveShortcutTarget(digitEvent(1, { target: { tagName: "TEXTAREA" } })), null);
});

test("a shortcut does not fire in a select", () => {
  // Select boxes accept typed characters to jump to an option, so they are typing too.
  assert.equal(resolveShortcutTarget(digitEvent(1, { target: { tagName: "SELECT" } })), null);
});

test("a shortcut does not fire in a contenteditable, or inside one", () => {
  assert.equal(resolveShortcutTarget(digitEvent(1, { target: { tagName: "DIV", isContentEditable: true } })), null);
  assert.equal(
    resolveShortcutTarget(digitEvent(1, {
      target: { tagName: "DIV", getAttribute: (name) => (name === "contenteditable" ? "true" : null) },
    })),
    null,
  );
  // A caret inside a nested span still belongs to the editor around it.
  const nested = { tagName: "SPAN", closest: (selector) => (selector.includes("contenteditable") ? { tagName: "DIV" } : null) };
  assert.equal(resolveShortcutTarget(digitEvent(1, { target: nested })), null);
  // `contenteditable="false"` is not an editor and must not suppress everything under it.
  assert.equal(
    resolveShortcutTarget(digitEvent(1, {
      target: { tagName: "DIV", getAttribute: () => "false", closest: () => null },
    })).id,
    "sales",
  );
});

test("a shortcut does not fire while a modal has focus", () => {
  // A dialog is a question the person has been asked. Navigating out from under it strands the
  // answer and leaves the backdrop behind on some screens.
  const inModal = { tagName: "BUTTON", closest: (selector) => (selector.includes("modal-backdrop") ? { tagName: "DIV" } : null) };
  assert.equal(resolveShortcutTarget(digitEvent(1, { target: inModal })), null);
});

test("a shortcut does not fire mid-IME composition", () => {
  // The keystroke is part of a word being composed, not a command.
  assert.equal(resolveShortcutTarget(digitEvent(1, { isComposing: true })), null);
  assert.equal(resolveShortcutTarget(digitEvent(1, { keyCode: 229 })), null);
});

test("an ordinary button or the page body is not a typing context", () => {
  // The suppression has to be narrow enough that the feature still works. If everything looked
  // like typing this would pass while doing nothing.
  assert.equal(isTypingContext({ tagName: "BUTTON" }), false);
  assert.equal(isTypingContext(null), false);
  assert.equal(resolveShortcutTarget(digitEvent(1, { target: { tagName: "BODY", closest: () => null } })).id, "sales");
});

test("a held key does not repeat-fire navigation", () => {
  assert.equal(resolveShortcutTarget(digitEvent(1, { repeat: true })), null);
});

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

test("a known module resolves to itself", () => {
  const resolved = resolveNavigationTarget("sales");
  assert.equal(resolved.status, NAVIGATION_LOOKUP.FOUND);
  assert.equal(resolved.kind, NAVIGATION_KIND.MODULE);
  assert.equal(resolved.moduleId, "sales");
});

test("a section resolves to the module that must be opened first", () => {
  const resolved = resolveNavigationTarget("settings/business-identity");
  assert.equal(resolved.status, NAVIGATION_LOOKUP.FOUND);
  assert.equal(resolved.kind, NAVIGATION_KIND.SECTION);
  assert.equal(resolved.moduleId, "settings", "a section is useless without the view it lives on");
  assert.equal(resolved.section.eyebrow, "Business Settings");
});

test("an unknown id is named, not guessed", () => {
  // The rule from CLAUDE.md: a failure must be distinguishable. Resolving a stale palette entry
  // to the Dashboard would look exactly like the app working, and nobody would report it.
  const resolved = resolveNavigationTarget("stock-take");
  assert.equal(resolved.status, NAVIGATION_LOOKUP.UNKNOWN);
  assert.equal(resolved.module, null);
  assert.equal(resolved.moduleId, null);
  assert.match(resolved.reason, /stock-take/, "the failure must say which id it could not place");
  assert.equal(resolveNavigationTarget("").status, NAVIGATION_LOOKUP.UNKNOWN);
  assert.equal(resolveNavigationTarget(null).status, NAVIGATION_LOOKUP.UNKNOWN);
});

test("ids are compared as opaque strings", () => {
  // `"004"` and `4` are different entities in this codebase; a `Number()` near an id has already
  // cost a day. A numeric lookup must miss rather than coerce its way to a match.
  assert.equal(resolveNavigationTarget(4).status, NAVIGATION_LOOKUP.UNKNOWN);
  assert.equal(findNavigationSection(4), null);
});

test("the registry cannot be edited by one consumer for another", () => {
  // The sidebar and the palette read the same frozen objects.
  assert.throws(() => { navigationRegistry.push({ id: "x" }); });
  assert.throws(() => { navigationRegistry[0].shortcut = "5"; }, undefined, "module entries must be frozen");
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

test("history starts empty or on the screen it was given", () => {
  assert.equal(currentHistoryEntry(createNavigationHistory()), null);
  assert.equal(currentHistoryEntry(createNavigationHistory("dashboard")), "dashboard");
  assert.equal(canGoBack(createNavigationHistory("dashboard")), false);
  assert.equal(canGoForward(createNavigationHistory("dashboard")), false);
});

test("back and forward walk the trail", () => {
  let state = createNavigationHistory("dashboard");
  state = pushNavigation(state, "sales");
  state = pushNavigation(state, "products");
  assert.equal(currentHistoryEntry(state), "products");
  assert.equal(canGoBack(state), true);
  assert.equal(canGoForward(state), false);

  state = goBack(state);
  assert.equal(currentHistoryEntry(state), "sales");
  assert.equal(canGoForward(state), true);

  state = goForward(state);
  assert.equal(currentHistoryEntry(state), "products");
  assert.equal(canGoForward(state), false);
  // Forward at the end of the trail must be a no-op rather than an error or a wrap-around.
  assert.equal(currentHistoryEntry(goForward(state)), "products");
  assert.equal(currentHistoryEntry(goBack(createNavigationHistory("dashboard"))), "dashboard");
});

test("pushing after going back discards the forward trail", () => {
  // The rule every browser follows. Anything else leaves Forward replaying a branch the person
  // has already abandoned, which reads as the app navigating on its own.
  let state = createNavigationHistory("dashboard");
  state = pushNavigation(state, "sales");
  state = pushNavigation(state, "products");
  state = goBack(state);
  state = pushNavigation(state, "reports");
  assert.equal(currentHistoryEntry(state), "reports");
  assert.equal(canGoForward(state), false);
  assert.deepEqual([...state.entries], ["dashboard", "sales", "reports"]);
});

test("pushing the screen you are already on changes nothing", () => {
  // Otherwise clicking the same sidebar row twice stacks a duplicate and the first press of Back
  // lands on the screen already showing — which reads as Back being broken.
  let state = createNavigationHistory("dashboard");
  state = pushNavigation(state, "sales");
  const before = state;
  state = pushNavigation(state, "sales");
  assert.deepEqual([...state.entries], [...before.entries]);
  assert.equal(canGoBack(state), true);
  assert.equal(currentHistoryEntry(goBack(state)), "dashboard");
});

test("history holds no shared state between callers", () => {
  // Two callers must not be able to push each other's trail around, so every function returns a
  // new frozen state and leaves the one it was given alone.
  const base = pushNavigation(createNavigationHistory("dashboard"), "sales");
  const left = pushNavigation(base, "products");
  const right = pushNavigation(base, "reports");
  assert.equal(currentHistoryEntry(base), "sales");
  assert.equal(currentHistoryEntry(left), "products");
  assert.equal(currentHistoryEntry(right), "reports");
  assert.throws(() => { base.entries.push("waste"); });
});

test("an empty id is not recorded", () => {
  // A failed navigation must not leave a hole in the trail that Back then lands on.
  const state = pushNavigation(createNavigationHistory("dashboard"), "");
  assert.deepEqual([...state.entries], ["dashboard"]);
  assert.deepEqual([...pushNavigation(state, null).entries], ["dashboard"]);
});


// -------------------------------------------------------------------------------------------
// Settings grouping. Settings was one page with seventeen sections stacked on it; the groups are
// what makes it drillable, and a section that quietly loses its group would vanish from the
// screen rather than fail loudly.
// -------------------------------------------------------------------------------------------

test("every Settings section belongs to a group that exists", () => {
  const groupIds = new Set(SETTINGS_GROUPS.map((group) => group.id));
  const sections = navigationRegistry.find((item) => item.id === "settings").sections;
  const orphans = sections.filter((section) => !groupIds.has(section.group));
  assert.deepEqual(
    orphans.map((section) => section.id),
    [],
    "a section with no group is rendered by no group card, so it becomes unreachable on screen",
  );
});

test("every group has at least one section", () => {
  // An empty group card is a promise of something behind it. Opening it to nothing is worse than
  // never offering it.
  const sections = navigationRegistry.find((item) => item.id === "settings").sections;
  const empty = SETTINGS_GROUPS.filter((group) => !sections.some((section) => section.group === group.id));
  assert.deepEqual(empty.map((group) => group.id), []);
});

test("the groups account for every section exactly once", () => {
  // Guards the arithmetic rather than the intent: if a section were counted twice the totals would
  // still look plausible on screen, and only this would say so.
  const sections = navigationRegistry.find((item) => item.id === "settings").sections;
  const counted = SETTINGS_GROUPS.reduce(
    (total, group) => total + sections.filter((section) => section.group === group.id).length,
    0,
  );
  assert.equal(counted, sections.length);
});

test("every registered Settings section is actually rendered by the drill-down", () => {
  // The drill-down moved seventeen sections from one stacked list into a keyed map. A section left
  // out of that map would still appear in the registry, still be counted on its group card, and
  // render nothing when opened - a setting that silently stopped existing, which is the specific
  // way this refactor could have gone wrong.
  const sections = navigationRegistry.find((item) => item.id === "settings").sections;
  const map = app.slice(app.indexOf("const sectionContent = {"), app.indexOf("const banner = ("));
  assert.ok(map.length > 0, "the sectionContent map must exist");
  const missing = sections.filter((section) => !map.includes(`"${section.id}":`));
  assert.deepEqual(missing.map((section) => section.id), [], "these sections would render nothing");
});

test("no Settings section component was dropped in the move", () => {
  // The inverse, and the one that catches a lost *component* rather than a lost id. Each of these
  // rendered on the old stacked page; if one is no longer referenced anywhere in App.jsx, its
  // settings became unreachable without any id going missing.
  const components = [
    "AppearanceAccessibilitySettings", "BusinessSettingsSection", "PosSettingsSection",
    "PaymentSettingsSection", "WhatsAppSettingsSection", "MandiTaxSettings", "RebateSettings",
    "SaleRateSettingsSection", "DiscountSettings", "PermissionSettings", "UserManagementSection",
    "DeviceControlSettingsSection", "OperationalScopeManagement", "UpdateCenterSection",
    "SyncSettingsSection", "BackupSettings", "SystemInfoSection",
  ];
  const dropped = components.filter((name) => !app.includes(`<${name}`));
  assert.deepEqual(dropped, [], "these components are defined but no longer rendered");
});

test("the Update Center keeps its error boundary", () => {
  // It was the one section wrapped in `SettingsSectionErrorBoundary`, because it is the one that
  // talks to the updater. Losing the wrapper in the move would let a failure there take the whole
  // group down with it.
  const start = app.indexOf('"settings/updates":');
  assert.ok(start > 0);
  assert.match(app.slice(start, start + 400), /SettingsSectionErrorBoundary/);
});
