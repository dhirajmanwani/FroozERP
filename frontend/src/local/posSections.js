// The POS counter's three shelves: Frooz Retail (loose fruit), Frooz Bar (juices, bottles, lunch
// boxes, fruit chaat) and Frooz Moments (baskets, gifting, occasions).
//
// There is no "section" field on a product, and adding one would mean a column in Postgres, a
// cloud migration, a SQLite migration and the Rust snapshot, all before a single tile moved. The
// product's category already exists everywhere a product does, so it decides first: a category
// named "Frooz Bar" (or anything with Bar, Juice, Chaat... in it) puts every product in it on the
// Bar shelf, and one named "Frooz Retail" keeps its products on Retail whatever they are called. Only a product left in a plain category such as the default "Fruit" is placed by its
// own name, so "Mango Shake" and "Fruit Chaat" land on the Bar shelf without anyone re-filing
// them. Everything else is Retail, which is what the counter sold before there were sections.
//
// The owner moves a product by changing its category in Product Master. Nothing here writes.

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
 * Which shelf a product sits on, and why: `basis` is "category", "name" or "default", so the
 * screen can say where a surprising placement came from.
 */
export function posSectionFor(product) {
  const category = String(product?.category_name || product?.category || "").trim();
  // A category that names the Retail shelf keeps a "Mango Shake" there on purpose.
  const byCategory = sectionOfText(category, BAR_CATEGORY_WORDS) || (hasAny(category, ["retail"]) ? "retail" : null);
  if (byCategory) return { key: byCategory, basis: "category", category };
  const byName = sectionOfText(product?.product_name, BAR_ITEM_WORDS);
  if (byName) return { key: byName, basis: "name", category };
  return { key: DEFAULT_POS_SECTION, basis: "default", category };
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
