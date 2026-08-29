import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  ACCENT,
  BRAND,
  CREAM,
  CREAM_DIM,
  GROUND,
  INK,
  SIGNAL,
  approvedColours,
  brandRgb,
  isBrandColour,
} from "./brandPalette.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

// index.html and public/favicon.svg are guarded too: the brand leaking into a
// splash screen or a browser tab is exactly as visible as it leaking into the app.
//
// The website is guarded from here rather than from its own suite, so there is one
// list of allowed colours and one place that enforces it. A customer who sees the
// site and an invoice on the same day should not be able to tell they were built by
// different hands.
const GUARDED_FILES = [
  // theme.css first: it is the token layer every other stylesheet is being converted onto,
  // so a colour invented there would spread into all of them under a name that looks
  // official. It is held to exactly the same standard as App.css, and for the same reason.
  "frontend/src/theme.css",
  "frontend/src/App.css",
  "frontend/src/index.css",
  "frontend/index.html",
  "frontend/public/favicon.svg",
  "website/src/tokens.css",
  "website/src/site.css",
];

function read(relative) {
  return readFileSync(join(repoRoot, relative), "utf8");
}

/** Every `#rrggbb` / `#rgb` literal in a stylesheet, with the line it sits on. */
function hexLiterals(source) {
  const found = [];
  source.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      found.push({ value: match[0].toLowerCase(), line: index + 1 });
    }
  });
  return found;
}

/** Every `rgb()` / `rgba()` triple in a stylesheet, with the line it sits on. */
function rgbLiterals(source) {
  const found = [];
  source.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)) {
      found.push({
        r: Number(match[1]),
        g: Number(match[2]),
        b: Number(match[3]),
        text: match[0],
        line: index + 1,
      });
    }
  });
  return found;
}

const approvedTriples = new Set(
  approvedColours()
    .map((colour) => brandRgb(colour))
    .filter(Boolean)
    .map(({ r, g, b }) => `${r},${g},${b}`),
);

test("the palette is built out of the logo's own three colours", () => {
  assert.equal(BRAND.greenDeep, "#0a2d1c");
  assert.equal(BRAND.greenMid, "#123623");
  assert.equal(BRAND.gold, "#c29030");
  // The card surface is the logo's mid green rather than something near it.
  assert.equal(GROUND.card, BRAND.greenMid);
  // The brightest text is the reversed logo's ink.
  assert.equal(INK.brightest, CREAM);
  assert.ok(isBrandColour(BRAND.gold));
  assert.ok(isBrandColour(CREAM_DIM), "the reversed logo's second cream is part of the palette");
  assert.ok(!isBrandColour("#0f172a"), "the old slate ground is not part of this brand");
});

test("error and success colours are not brand-coloured", () => {
  // An error styled in the brand's own green is an error nobody sees.
  for (const signal of [SIGNAL.danger, SIGNAL.dangerBright, SIGNAL.successBright]) {
    assert.ok(
      !Object.values(GROUND).includes(signal) && !Object.values(ACCENT).includes(signal),
      `${signal} must stay distinct from the ground and accent ramps`,
    );
  }
});

for (const relative of GUARDED_FILES) {
  test(`${relative} uses only approved brand colours`, () => {
    const source = read(relative);
    const offenders = hexLiterals(source).filter(({ value }) => !isBrandColour(value));
    assert.deepEqual(
      offenders,
      [],
      offenders.length
        ? `off-palette colours in ${relative}:\n` +
          offenders.map(({ value, line }) => `  line ${line}: ${value}`).join("\n") +
          "\n\nEither use a colour from frontend/src/local/brandPalette.js, or add the new" +
          " colour there with a comment saying what job it does."
        : "",
    );
  });

  test(`${relative} builds translucent layers out of approved colours`, () => {
    const source = read(relative);
    const offenders = rgbLiterals(source).filter(
      ({ r, g, b }) => !approvedTriples.has(`${r},${g},${b}`),
    );
    assert.deepEqual(
      offenders,
      [],
      offenders.length
        ? `off-palette rgba() bases in ${relative}:\n` +
          offenders.map(({ text, line }) => `  line ${line}: ${text}...)`).join("\n") +
          "\n\nA translucent layer must be tinted with a palette colour too - otherwise the" +
          " brand leaks at 12% opacity in a hundred places nobody thinks to check."
        : "",
    );
  });
}

test("the app stylesheet is actually being checked", () => {
  // A guard that silently reads an empty file passes forever. Prove there is
  // something there to guard.
  //
  // This used to demand more than 200 hex literals, which was true when every colour was written
  // where it was used. Converting App.css to theme tokens took it to 154 and tripped the canary --
  // a *successful* change failing the test that exists to prove the file is real. The count was
  // never the point; "this file still carries the app's colour" was.
  //
  // So it now counts colour in either form. A token reference is as much a colour decision as a
  // literal, and the total cannot be eroded by more conversion: every literal that becomes a token
  // moves between the two terms rather than leaving the sum.
  const appCss = read("frontend/src/App.css");
  assert.ok(appCss.length > 50000, "App.css looks unexpectedly small - is the path right?");
  const literals = hexLiterals(appCss).length;
  const tokenUses = (appCss.match(/var\(--/g) || []).length;
  assert.ok(
    literals + tokenUses > 200,
    `expected App.css to carry the app's colour, found ${literals} literals and ${tokenUses} token uses`,
  );
});

test("App.css is mostly themed rather than hardcoded", () => {
  // The direction of travel, pinned so it cannot quietly reverse. Every literal left in App.css is
  // a colour that cannot follow the light theme, so a change that adds them back is a change that
  // un-themes part of the app -- and it would do so silently, since a palette-approved literal
  // passes every other guard in this file.
  const appCss = read("frontend/src/App.css");
  const outsidePrint = appCss.replace(/@media print[\s\S]*?\n\}/g, "");
  const literals = hexLiterals(outsidePrint).length;
  // A ratchet, not a target. 77 at the time of writing, down from 393 before the token conversion
  // and from 80 before the Local Only banner was themed. The ceiling sits just above that so the
  // number can only be driven down; raising it needs a deliberate edit here, which is the
  // conversation this test exists to force.
  assert.ok(
    literals <= 85,
    `${literals} hardcoded colours outside print styles, up from the 77 this ratchet was set at. `
    + "Prefer a token from theme.css: a literal here is a colour that stays dark when the app goes "
    + "light. If the increase is deliberate, raise the ceiling in this test and say why.",
  );
});

test("the Local Only banner follows the theme", () => {
  // This bar was the last piece of the app still painted for a dark screen no matter which theme
  // was on: a `#2b1f06` slab with `#f6ecd3` text, written before light mode existed and skipped by
  // the token conversion because its cream had no matching token. On a light page it read as a
  // black box dropped onto the layout.
  //
  // The rule is checked by name rather than by the file-wide count above, because the file-wide
  // count has 8 spare slots -- these three literals could come back without moving it past the
  // ceiling. A colour written directly into this rule is a colour that cannot follow the theme.
  const appCss = read("frontend/src/App.css");
  const rules = [...appCss.matchAll(/(^|\n)(\.local-only-banner[^{]*)\{([^}]*)\}/g)];
  assert.ok(
    rules.length >= 3,
    `expected the Local Only banner rules in App.css, found ${rules.length} - has it been renamed?`,
  );
  for (const [, , selector, body] of rules) {
    const literals = hexLiterals(body);
    assert.equal(
      literals.length,
      0,
      `${selector.trim()} declares ${literals.join(", ")} directly. Use a token from theme.css: a `
      + "literal here is the dark-slab-on-a-light-page bug coming back.",
    );
  }
});

test("the two content-area banners do not look the same", () => {
  // Local Only ("this device is offline by choice") and Viewing another shop ("these are not this
  // counter's numbers") share a shape and a position, and both can be on screen at once, stacked.
  // Colour is the only thing telling them apart.
  //
  // For a year it was not telling them apart at all: the shop-view override set `border-color` to
  // the same value the base rule already had, so the override did nothing and the two bars were
  // pixel-identical. A no-op override is invisible in review -- it looks like a difference.
  const appCss = read("frontend/src/App.css");
  const declaration = (selector, property) => {
    const rule = appCss.match(
      new RegExp(`(^|\\n)${selector.replace(/[.[\]"^$]/g, "\\$&")}\\s*\\{([^}]*)\\}`),
    );
    assert.ok(rule, `expected a \`${selector}\` rule in App.css`);
    const found = rule[2].match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`));
    return found ? found[1].trim() : "";
  };

  const base = declaration(".local-only-banner", "background");
  const shopView = declaration('.local-only-banner[data-shop-view="OTHER_BRANCH"]', "background");
  assert.ok(base, "the Local Only banner declares no background");
  assert.ok(shopView, "the shop-view banner declares no background of its own");
  assert.notEqual(
    base,
    shopView,
    `both banners fill with ${base}, so they are the same bar wearing the same colour`,
  );
});
