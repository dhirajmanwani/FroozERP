/**
 * Every keyboard shortcut in the app, as the one list a person reads.
 *
 * Asked for on 2 Oct 2026: shortcuts existed for some screens only, and the only way to learn one
 * was to spot its chip in the sidebar. The list is built here, from the same registry the
 * keystrokes resolve against (`appNavigation.js`), so it cannot name a key that does nothing or
 * leave out one that works. The keys that are not about navigation (Ctrl K, the POS function
 * keys) are written once below; `keyboardShortcuts.test.mjs` reads `App.jsx` to prove each is
 * still handled.
 */

import { formatShortcut, navigationRegistry } from "./appNavigation.js";

/** Opens the list. Ctrl rather than Alt, and allowed while typing, for the same reason Ctrl K is:
 *  somebody halfway through a product search is exactly who wants to look a key up. */
export const SHORTCUT_SHEET_CHORD = "Ctrl /";

export const isShortcutSheetChord = (event) => {
  if (!event) return false;
  if (event.isComposing === true || event.keyCode === 229) return false;
  if (event.altKey === true || event.shiftKey === true) return false;
  if (event.ctrlKey !== true && event.metaKey !== true) return false;
  const code = typeof event.code === "string" ? event.code : "";
  if (code === "Slash" || code === "NumpadDivide") return true;
  return code === "" && event.key === "/";
};

/** Digits in the order they sit on the number row (1 first, 0 last), then letters A to Z. */
const keyOrder = (shortcut) => {
  const key = String(shortcut);
  if (/^[1-9]$/.test(key)) return Number.parseInt(key, 10);
  if (key === "0") return 10;
  return 11 + key.charCodeAt(0);
};

const ANYWHERE_ROWS = Object.freeze([
  Object.freeze({ keys: "Ctrl K", label: "Search screens and settings" }),
  Object.freeze({ keys: SHORTCUT_SHEET_CHORD, label: "Show this list of shortcuts" }),
  Object.freeze({ keys: "Esc", label: "Close search, this list or FROST" }),
]);

const POS_ROWS = Object.freeze([
  Object.freeze({ keys: "F2", label: "Go to product search" }),
  Object.freeze({ keys: "F3", label: "Go to barcode scan" }),
  Object.freeze({ keys: "F4", label: "Checkout the bill" }),
]);

export const SHORTCUT_SHEET_STATUS = Object.freeze({
  READY: "ready",
  NO_SCREENS: "no-screens",
});

/**
 * The list, grouped.
 *
 * `visibleModuleIds` is what the sidebar shows this person. A screen they cannot open is left out
 * of the list for the same reason it is left out of the sidebar; the key itself still answers
 * with "Your role does not have access", which is the app's existing refusal. When the caller
 * passes something other than an array the list is not filtered at all: hiding every screen
 * because a permission check failed would read as "this app has no shortcuts", which is an error
 * rendered as zero.
 */
export const buildShortcutSheet = ({ visibleModuleIds, registry = navigationRegistry } = {}) => {
  const visible = Array.isArray(visibleModuleIds)
    ? new Set(visibleModuleIds.filter((id) => typeof id === "string").map((id) => id.trim()))
    : null;
  const screens = registry
    .filter((item) => item.shortcut !== null && item.shortcut !== undefined && formatShortcut(item.shortcut) !== "")
    .filter((item) => visible === null || visible.has(item.id))
    .slice()
    .sort((left, right) => keyOrder(left.shortcut) - keyOrder(right.shortcut))
    .map((item) => Object.freeze({ keys: formatShortcut(item.shortcut), label: item.label, moduleId: item.id }));

  const groups = [
    Object.freeze({ id: "screens", title: "Open a screen", rows: Object.freeze(screens) }),
    Object.freeze({ id: "anywhere", title: "Anywhere", rows: ANYWHERE_ROWS }),
  ];
  if (visible === null || visible.has("sales")) {
    groups.push(Object.freeze({ id: "pos", title: "Inside POS Billing", rows: POS_ROWS }));
  }
  return Object.freeze({
    status: screens.length === 0 ? SHORTCUT_SHEET_STATUS.NO_SCREENS : SHORTCUT_SHEET_STATUS.READY,
    groups: Object.freeze(groups),
  });
};
