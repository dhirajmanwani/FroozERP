import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The owner looked at the rebuilt FROST panel in a disposable app on 22 Sep 2026 and said: keep it
 * exactly like this. This suite is what "exactly" means in a form a gate can check.
 *
 * It does not try to describe how the panel looks -- a stylesheet's appearance is not assertable in
 * node:test, and pretending otherwise produces a suite that passes while the screen changes. What it
 * does check is the two ways the look has actually broken before:
 *
 *  1. A class name used in App.jsx that App.css never styles. The element still renders, with no
 *     box, no padding and no colour, so one panel quietly loses its shape while every test stays
 *     green. This is a 17.7k-line file and a 200-odd-rule stylesheet edited by different hands.
 *  2. The retired chrome creeping back. The eleven tabs were replaced by one conversation and a
 *     short menu; a merge that restores `.frost-tab` restores the screen he asked us to get rid of.
 *
 * Colours are not checked here. `brandPalette.test.mjs` already holds App.css to the approved
 * palette, and two suites guarding one thing is how they drift apart.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const read = (relative) => readFileSync(join(repoRoot, relative), "utf8");

const appJsx = read("frontend/src/App.jsx");
const appCss = read("frontend/src/App.css");

// Every class name the JSX asks for, from both `className="a b"` and `className={`a ${x}`}`.
// Interpolations are dropped rather than guessed at: a class built at runtime is checked by its
// prefix below instead.
const classNamesUsed = () => {
  const names = new Set();
  const attribute = /className=(?:"([^"]*)"|\{`([^`]*)`\})/g;
  let match = attribute.exec(appJsx);
  while (match) {
    const raw = (match[1] || match[2] || "").replace(/\$\{[^}]*\}/g, " ");
    for (const name of raw.split(/\s+/)) {
      // A trailing hyphen is the stump of a stripped interpolation (`frost-turn-${kind}`). Those
      // are named explicitly further down, because a prefix cannot be looked up in a stylesheet.
      if (name.startsWith("frost-") && !name.endsWith("-")) names.add(name);
    }
    match = attribute.exec(appJsx);
  }
  return [...names].sort();
};

// The class must be the subject of a rule of its own, which is stricter than it looks and
// deliberately so. `\b` is not enough -- a hyphen satisfies it, so `.frost-composer-actions` would
// answer for `.frost-composer`. Nor is a bare mention enough: `.frost-composer textarea` styles the
// box inside, not the box, so a guard that accepted it passed with the rule deleted. Both were
// found by deleting the rule and watching this suite stay green.
const cssDefines = (name) =>
  new RegExp(`\\.${name}(?![\\w-])\\s*(?::{1,2}[\\w-]+(?:\\([^)]*\\))?\\s*)*[,{]`).test(appCss);

test("every FROST class the panel renders is actually styled", () => {
  const unstyled = classNamesUsed().filter((name) => !cssDefines(name));
  assert.deepEqual(
    unstyled,
    [],
    `these render with no styling at all: ${unstyled.join(", ")}. Add a rule in App.css or drop the class.`,
  );
});

// The chrome the owner signed off on, piece by piece. A rename is not forbidden -- it just cannot
// happen by accident, which is the whole point of naming them here.
const APPROVED_CHROME = [
  "frost-strip",          // the one header row: period in words, More, Refresh
  "frost-strip-period",
  "frost-strip-button",
  "frost-menu",           // the nine sections, behind More
  "frost-menu-range",
  "frost-menu-footer",
  "frost-back",
  "frost-conversation",   // the thread itself
  "frost-thread",
  "frost-composer",       // the input row: suggestions, Speak, Ask
  "frost-composer-actions",
  "frost-composer-suggestions",
  "frost-speak-button",
  "frost-chats",          // the sidebar of past chats
  "frost-chats-empty",
  "frost-new-chat",       // the one control always in the same corner
];

for (const name of APPROVED_CHROME) {
  test(`the panel still renders and styles .${name}`, () => {
    assert.match(appJsx, new RegExp(`\\b${name}\\b`), `${name} is no longer rendered by App.jsx`);
    assert.ok(cssDefines(name), `${name} is rendered but App.css no longer styles it`);
  });
}

test("the turn styles the conversation is built from are all present", () => {
  // These are composed at runtime (`frost-turn ${kind}`), so the attribute scan above cannot see
  // them and they would be the easiest ones to delete without noticing.
  for (const name of ["frost-turn", "frost-turn-owner", "frost-turn-frost", "frost-turn-greeting", "frost-turn-brief"]) {
    assert.ok(cssDefines(name), `App.css no longer styles .${name}`);
  }
});

test("the eleven tabs do not come back", () => {
  // `.frost-tab` as a whole word: `.frost-tabs` and `.frost-tab-active` are the same chrome.
  assert.doesNotMatch(appCss, /\.frost-tabs?\b/, "the retired tab strip has reappeared in App.css");
  assert.doesNotMatch(appJsx, /"frost-tabs?[\s"]/, "the retired tab strip has reappeared in App.jsx");
});

test("the boxes elsewhere in the app keep their styles", () => {
  // Not FROST's, but they are what he pointed at -- the dashboard tiles and the module cards in the
  // screenshots he approved. A stylesheet edit that removes one of these is visible on every screen.
  for (const name of ["kpi-card", "metric-value", "module-card", "content-card", "chart-card"]) {
    assert.ok(cssDefines(name), `App.css no longer styles .${name}`);
  }
});
