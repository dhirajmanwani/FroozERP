// The POS counter's three shelves: Frooz Retail (loose fruit), Frooz Bar (juices, bottles, lunch
// boxes, fruit chaat) and Frooz Moments (baskets, gifting, occasions).
//
// A product can carry a chosen shelf, `pos_section` ("retail", "bar" or "moments"), set in Product
// Master. A choice always wins: it is how the owner moves a product the automatic placement got
// wrong, a Frooz Retail product that landed on Frooz Bar or the other way round. A product with no
// choice (null, absent, or a value that is not a shelf) is placed automatically, as before:
//
// The category decides first: a category named "Frooz Bar" (or anything with Bar, Juice, Chaat...
// in it) puts every product in it on the Bar shelf, and one named "Frooz Retail" keeps its
// products on Retail whatever they are called. Only a product left in a plain category such as
// the default "Fruit" is placed by its own name, so "Mango Shake" and "Fruit Chaat" land on the
// Bar shelf without anyone re-filing them. Everything else is Retail, which is what the counter
// sold before there were sections.
//
// Nothing here writes; the choice is saved with the product.

import { tintFor } from "./catalogueExport.js";

export const POS_SECTIONS = Object.freeze([
  Object.freeze({ key: "retail", label: "Frooz Retail", blurb: "Loose fruit by weight or piece" }),
  Object.freeze({ key: "bar", label: "Frooz Bar", blurb: "Juices, bottles, lunch boxes, fruit chaat" }),
  Object.freeze({ key: "moments", label: "Frooz Moments", blurb: "Baskets, gifting, occasions" }),
]);

export const DEFAULT_POS_SECTION = "retail";

const SECTION_KEYS = new Set(POS_SECTIONS.map((section) => section.key));

// Whole words (or two-word phrases) only, so "Barbados Cherry" is not a Bar item and "Custard
// Apple" is not a cup. Moments is checked before Bar: a "Juice Gift Hamper" is a gift.
const MOMENTS_WORDS = ["moment", "moments", "gift", "gifts", "gifting", "basket", "baskets", "hamper", "hampers", "occasion", "occasions", "festive", "bouquet", "diwali", "rakhi"];
const BAR_ITEM_WORDS = ["juice", "juices", "shake", "shakes", "smoothie", "smoothies", "chaat", "bottle", "bottles", "salad", "salads", "bowl", "bowls", "cup", "cups", "lunchbox", "lunch box", "mocktail", "slush"];
// "Bar" alone names a section in a category ("Frooz Bar", "Bar"), never an item in a name.
const BAR_CATEGORY_WORDS = ["bar", ...BAR_ITEM_WORDS];

const wordsOf = (text) => String(text ?? "").toLowerCase().split(/[^a-z]+/).filter(Boolean);

const hasAny = (text, vocabulary) => {
  const words = wordsOf(text);
  const joined = ` ${words.join(" ")} `;
  return vocabulary.some((entry) => (entry.includes(" ") ? joined.includes(` ${entry} `) : words.includes(entry)));
};

const sectionOfText = (text, barWords) => {
  if (hasAny(text, MOMENTS_WORDS)) return "moments";
  if (hasAny(text, barWords)) return "bar";
  return null;
};

/**
 * The shelf a product's category and name give it, ignoring any chosen shelf: what "Automatic"
 * means in Product Master. `basis` is "category", "name" or "default".
 */
export function posSectionAutomatic(product) {
  const category = String(product?.category_name || product?.category || "").trim();
  // A category that names the Retail shelf keeps a "Mango Shake" there on purpose.
  const byCategory = sectionOfText(category, BAR_CATEGORY_WORDS) || (hasAny(category, ["retail"]) ? "retail" : null);
  if (byCategory) return { key: byCategory, basis: "category", category };
  const byName = sectionOfText(product?.product_name, BAR_ITEM_WORDS);
  if (byName) return { key: byName, basis: "name", category };
  return { key: DEFAULT_POS_SECTION, basis: "default", category };
}

/**
 * A product's chosen shelf key, or null when it has none. Unlike normalizePosSection this never
 * turns an unknown value into Retail: an unknown value is "no choice", so the product is placed
 * automatically rather than pinned to Retail.
 */
export function chosenPosSection(product) {
  const key = String(product?.pos_section ?? "").trim().toLowerCase();
  return SECTION_KEYS.has(key) ? key : null;
}

/**
 * Which shelf a product sits on, and why: `basis` is "chosen", "category", "name" or "default",
 * so the screen can say where a surprising placement came from.
 */
export function posSectionFor(product) {
  const chosen = chosenPosSection(product);
  if (chosen) return { key: chosen, basis: "chosen", category: String(product?.category_name || product?.category || "").trim() };
  return posSectionAutomatic(product);
}

export function posSectionLabel(key) {
  return POS_SECTIONS.find((section) => section.key === key)?.label || POS_SECTIONS[0].label;
}

/** How many of `products` sit on each shelf. Every key is present, zero included. */
export function posSectionCounts(products) {
  const counts = Object.fromEntries(POS_SECTIONS.map((section) => [section.key, 0]));
  for (const product of products || []) counts[posSectionFor(product).key] += 1;
  return counts;
}

/** A saved choice, or Retail when there is none or it names a shelf that no longer exists. */
export function normalizePosSection(value) {
  const key = String(value ?? "").trim().toLowerCase();
  return SECTION_KEYS.has(key) ? key : DEFAULT_POS_SECTION;
}

export const POS_SECTION_STORAGE_KEY = "froozerp_pos_section";

/**
 * The tabs the POS counter shows, which are not quite the shelves above (21 Oct 2026, the owner).
 *
 * Frooz Bar and Frooz Moments sell things *made from* products — a juice, a cut-fruit bowl, a gift
 * basket — so each shows its combos (local/combos.js) first and then any product still placed on
 * that shelf. A fourth tab, Combos & Offers, holds the offer combos and **never products**: a
 * product's chosen shelf is still one of `POS_SECTIONS`, so nothing can be filed there.
 *
 * `combosOnly` tabs exist only where combos are sold (the counter app); the browser POS hides them.
 */
export const POS_TABS = Object.freeze([
  Object.freeze({ key: "retail", label: "Frooz Retail", blurb: "Loose fruit by weight or piece", products: true, comboKinds: Object.freeze([]), combosOnly: false }),
  Object.freeze({ key: "bar", label: "Frooz Bar", blurb: "Juices, The Cutting, bottles, fruit chaat", products: true, comboKinds: Object.freeze(["JUICE", "THE_CUTTING"]), combosOnly: false }),
  Object.freeze({ key: "moments", label: "Frooz Moments", blurb: "Gift baskets, gifting, occasions", products: true, comboKinds: Object.freeze(["GIFTING"]), combosOnly: false }),
  Object.freeze({ key: "combos", label: "Combos & Offers", blurb: "Combo offers at one price", products: false, comboKinds: Object.freeze(["COMBO_OFFER"]), combosOnly: true }),
]);

const TAB_KEYS = new Set(POS_TABS.map((tab) => tab.key));

/** The tabs this counter shows: all four where combos are sold, the three shelves elsewhere. */
export const posTabsFor = ({ combosEnabled = false } = {}) => POS_TABS.filter((tab) => combosEnabled || !tab.combosOnly);

export const posTabFor = (key) => POS_TABS.find((tab) => tab.key === key) || POS_TABS[0];

/** A remembered tab, or Retail; the combos tab only where combos are sold. */
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
