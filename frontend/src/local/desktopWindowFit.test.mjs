import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The app window has to fit the screen it opens on.
 *
 * ## What happened
 *
 * The shop's DELL showed the dashboard with its left edge off the screen: no sidebar, the first
 * column of cards sliced in half, and no way to drag it back. That was not a stylesheet fault --
 * the layout was measured in a real browser at every plausible width from 1366 down to 860 and
 * overflowed at none of them. The window itself was bigger than the display.
 *
 * A 1366x768 laptop at the 125% scaling Windows sets by default on that class of machine offers
 * about 1092x614 logical pixels. The window asked for 1280x800 and declared minWidth 1024,
 * minHeight 700. The height is the part that traps: 700 is larger than 614, so the window could
 * not be resized to fit even by hand. It opened too big and stayed too big.
 *
 * ## The rule
 *
 * The minimum size must fit the smallest screen the app is expected to run on, and the app must
 * open at a size that fits whatever screen it finds. `maximized` does the second part; the
 * assertions below hold the first, because a minimum that is too large is invisible in every
 * test and on every developer's monitor, and only ever shows up on a shop counter.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(
  fs.readFileSync(path.join(here, "..", "..", "..", "src-tauri", "tauri.conf.json"), "utf8"),
);
const windowConfig = config.app.windows[0];

/**
 * Screens the app is expected to run on, in logical pixels -- what CSS sees after Windows applies
 * its scaling, which is what the window manager compares a minimum size against.
 */
const SHOP_SCREENS = [
  { name: "1366x768 at 125% (the shop's DELL)", width: 1092, height: 614 },
  { name: "1366x768 at 100%", width: 1366, height: 768 },
  { name: "1280x720 at 100%", width: 1280, height: 720 },
  { name: "1920x1080 at 150%", width: 1280, height: 720 },
];

test("the window can be made small enough for every screen the shop uses", () => {
  // Room is left for the taskbar and the title bar; a window that is exactly the screen height
  // still cannot be placed on it.
  const CHROME_HEIGHT = 80;
  for (const screen of SHOP_SCREENS) {
    assert.ok(
      windowConfig.minWidth <= screen.width,
      `minWidth ${windowConfig.minWidth} does not fit ${screen.name} (${screen.width} wide)`,
    );
    assert.ok(
      windowConfig.minHeight <= screen.height - CHROME_HEIGHT,
      `minHeight ${windowConfig.minHeight} does not fit ${screen.name} `
        + `(${screen.height} tall, ${CHROME_HEIGHT} for the taskbar and title bar)`,
    );
  }
});

test("the minimum is one the stylesheet actually supports", () => {
  // A minimum smaller than the narrowest breakpoint would let the window reach a width the layout
  // was never written for -- the opposite mistake, and just as invisible from a desk.
  const css = fs.readFileSync(path.join(here, "..", "App.css"), "utf8");
  // Inside `@media (...)` only. A bare `max-width:` search also collects ordinary declarations --
  // `td.primary-cell { max-width: 340px }` among them -- and a stray 340 quietly lowers the floor
  // this test is supposed to enforce, so a minWidth of 400 passed a check written to reject it.
  const breakpoints = [...css.matchAll(/@media[^{]*?max-width:\s*(\d+)px/g)]
    .map(([, value]) => Number(value))
    .sort((a, b) => a - b);
  assert.ok(breakpoints.length, "the stylesheet must still have responsive breakpoints");
  assert.ok(
    windowConfig.minWidth >= breakpoints[0],
    `minWidth ${windowConfig.minWidth} is narrower than the narrowest breakpoint (${breakpoints[0]}px)`,
  );
});

test("the window opens at a size that fits whatever screen it finds", () => {
  // The configured width and height are deliberately larger than the smallest screen -- they are
  // the restore-down size for a real monitor. What keeps that from opening off-screen is
  // maximized, so it is not optional.
  assert.equal(windowConfig.maximized, true, "the window must open maximized to fit small screens");
  assert.equal(windowConfig.center, true, "restored down, it must not open off the edge");
});

test("the window is still revealed deliberately rather than flashing unstyled", () => {
  // `visible: false` is load-order machinery, not sizing, and it is easy to lose while editing
  // neighbouring keys.
  assert.equal(windowConfig.visible, false);
});
