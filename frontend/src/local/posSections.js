// The POS counter's tabs, and the shop they describe (the owner, 22 Oct 2026):
//
//                      Fruits purchased
//        ________________|________________________________
//       |              |                  |               |
//    Frooz Retail   Frooz Bar        Frooz Moments    Combos & Offers
//    (the fruit)    (juices, cutting) (gift hampers)   (offers)
//
// Every product is a fruit the shop bought, so every product sits on Frooz Retail. Frooz Bar, Frooz
// Moments and Combos & Offers sell things *made from* those fruits -- combos (local/combos.js) -- and
// never a product on its own. Selling a combo takes its fruits out of the same stock Retail sells.
//
// `products.pos_section` (migration 023) is no longer read here: it once filed a product on Bar or
// Moments, which is the mistake this layout replaces. The column stays, forward-only, and is ignored.
//
// Nothing here writes.

import { tintFor } from "./catalogueExport.js";

export const POS_SECTIONS = Object.freeze([
  Object.freeze({ key: "retail", label: "Frooz Retail", blurb: "Loose fruit by weight or piece" }),
  Object.freeze({ key: "bar", label: "Frooz Bar", blurb: "Juices and The Cutting, made from the fruit" }),
  Object.freeze({ key: "moments", label: "Frooz Moments", blurb: "Gift hampers, made from the fruit" }),
]);

export const DEFAULT_POS_SECTION = "retail";

const SECTION_KEYS = new Set(POS_SECTIONS.map((section) => section.key));

export function posSectionLabel(key) {
  return POS_SECTIONS.find((section) => section.key === key)?.label || POS_SECTIONS[0].label;
}

/** A saved choice, or Retail when there is none or it names a shelf that no longer exists. */
export function normalizePosSection(value) {
  const key = String(value ?? "").trim().toLowerCase();
  return SECTION_KEYS.has(key) ? key : DEFAULT_POS_SECTION;
}

export const POS_SECTION_STORAGE_KEY = "froozerp_pos_section";

/**
 * The tabs the POS counter shows. Only Frooz Retail lists products; the other three list combos of
 * their kinds. Those three are `combosOnly`: they exist only where combos are sold (the counter
 * app), so the browser POS, which cannot sell combos, shows Frooz Retail alone.
 */
export const POS_TABS = Object.freeze([
  Object.freeze({ key: "retail", label: "Frooz Retail", blurb: "Loose fruit by weight or piece", products: true, comboKinds: Object.freeze([]), combosOnly: false }),
  Object.freeze({ key: "bar", label: "Frooz Bar", blurb: "Juices and The Cutting, made from the fruit", products: false, comboKinds: Object.freeze(["JUICE", "THE_CUTTING"]), combosOnly: true }),
  Object.freeze({ key: "moments", label: "Frooz Moments", blurb: "Gift hampers, made from the fruit", products: false, comboKinds: Object.freeze(["GIFTING"]), combosOnly: true }),
  Object.freeze({ key: "combos", label: "Combos & Offers", blurb: "Combo offers at one price", products: false, comboKinds: Object.freeze(["COMBO_OFFER"]), combosOnly: true }),
]);

const TAB_KEYS = new Set(POS_TABS.map((tab) => tab.key));

/** The tabs this counter shows: all four where combos are sold, Frooz Retail alone elsewhere. */
export const posTabsFor = ({ combosEnabled = false } = {}) => POS_TABS.filter((tab) => combosEnabled || !tab.combosOnly);

export const posTabFor = (key) => POS_TABS.find((tab) => tab.key === key) || POS_TABS[0];

/** A remembered tab, or Retail; a combos-only tab only where combos are sold. */
export function normalizePosTab(value, { combosEnabled = false } = {}) {
  const key = String(value ?? "").trim().toLowerCase();
  if (!TAB_KEYS.has(key)) return DEFAULT_POS_SECTION;
  if (posTabFor(key).combosOnly && !combosEnabled) return DEFAULT_POS_SECTION;
  return key;
}

export function readPosTab(storage, options) {
  try {
    return normalizePosTab(storage?.getItem?.(POS_SECTION_STORAGE_KEY), options);
  } catch {
    return DEFAULT_POS_SECTION;
  }
}

export function writePosTab(storage, key) {
  try {
    storage?.setItem?.(POS_SECTION_STORAGE_KEY, normalizePosTab(key, { combosEnabled: true }));
  } catch {
    // A counter with storage switched off still works; it just opens on Retail next time.
  }
}

export function readPosSection(storage) {
  try {
    return normalizePosSection(storage?.getItem?.(POS_SECTION_STORAGE_KEY));
  } catch {
    return DEFAULT_POS_SECTION;
  }
}

export function writePosSection(storage, key) {
  try {
    storage?.setItem?.(POS_SECTION_STORAGE_KEY, normalizePosSection(key));
  } catch {
    // A counter with storage switched off still works; it just opens on Retail next time.
  }
}

// WCAG relative luminance, so the letter is always readable on its fruit colour: white on the
// dark tints, near-black on banana and pineapple.
const luminance = (hex) => {
  const value = String(hex).replace("#", "");
  const channels = [0, 2, 4].map((at) => parseInt(value.slice(at, at + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

export const TILE_INK_LIGHT = "#ffffff";
export const TILE_INK_DARK = "#10170f";

/**
 * The picture a tile shows until there are real photographs: the fruit's colour behind the
 * product's first letter. Never fetched from the internet (the app's CSP and LOCAL_ONLY both
 * forbid it); the colour comes from the same name table the website catalogue uses.
 */
export function posTileBadge(name) {
  const text = String(name ?? "").trim();
  const letter = (text.match(/\p{L}|\p{N}/u)?.[0] || "?").toLocaleUpperCase("en-IN");
  const tint = tintFor(text);
  const ink = contrast(tint, TILE_INK_LIGHT) >= contrast(tint, TILE_INK_DARK) ? TILE_INK_LIGHT : TILE_INK_DARK;
  return { letter, tint, ink };
}
