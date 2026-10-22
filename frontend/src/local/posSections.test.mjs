import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEFAULT_POS_SECTION,
  POS_SECTIONS,
  POS_SECTION_STORAGE_KEY,
  POS_TABS,
  TILE_INK_DARK,
  TILE_INK_LIGHT,
  normalizePosSection,
  normalizePosTab,
  posSectionLabel,
  posTileBadge,
  posTabsFor,
  readPosSection,
  readPosTab,
  writePosSection,
  writePosTab,
} from "./posSections.js";

const app = () => readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

test("the three shelves are the owner's names, in his order", () => {
  assert.deepEqual(POS_SECTIONS.map((section) => section.label), ["Frooz Retail", "Frooz Bar", "Frooz Moments"]);
  assert.equal(DEFAULT_POS_SECTION, "retail");
});

// ---------------------------------------------------------------------------------------------
// Fruits purchased -> Retail, Juices, Gift hampers, Offers (the owner, 22 Oct 2026)
// ---------------------------------------------------------------------------------------------

test("only Frooz Retail lists products; the other tabs list combos of their kinds", () => {
  assert.deepEqual(POS_TABS.map((tab) => tab.label), ["Frooz Retail", "Frooz Bar", "Frooz Moments", "Combos & Offers"]);
  assert.deepEqual(POS_TABS.filter((tab) => tab.products).map((tab) => tab.key), ["retail"]);
  assert.deepEqual(POS_TABS.find((tab) => tab.key === "retail").comboKinds, []);
  assert.deepEqual(POS_TABS.find((tab) => tab.key === "bar").comboKinds, ["JUICE", "THE_CUTTING"]);
  assert.deepEqual(POS_TABS.find((tab) => tab.key === "moments").comboKinds, ["GIFTING"]);
  assert.deepEqual(POS_TABS.find((tab) => tab.key === "combos").comboKinds, ["COMBO_OFFER"]);
});

test("the counter app shows four tabs; the browser, which cannot sell combos, shows Retail alone", () => {
  assert.deepEqual(posTabsFor({ combosEnabled: true }).map((tab) => tab.key), ["retail", "bar", "moments", "combos"]);
  assert.deepEqual(posTabsFor({ combosEnabled: false }).map((tab) => tab.key), ["retail"]);
});

test("POS puts every sellable product on Retail, whatever its stored pos_section, name or category", () => {
  const source = app();
  const results = source.slice(source.indexOf("const searchResults = useMemo("), source.indexOf("const choosePosSection ="));
  assert.match(results, /posTabFor\(posSection\)\.products \? posMatches : \[\]/);
  // The placement rules that filed a product on Bar or Moments are gone, not just unused.
  assert.doesNotMatch(source, /posSectionFor|posSectionAutomatic|chosenPosSection|posSectionCounts|option\.section/);
  assert.match(source, /posTileBadge\(product\.product_name\)/);
  // The shelf is still cut from the counter-scoped sellable list, never from raw products.
  const memo = source.slice(source.indexOf("const posMatches = useMemo("), source.indexOf("const posSearching ="));
  assert.match(memo, /filterSellableProducts\(products, inventory, new Date\(\), counterScope\)/);
});

test("Product Master no longer offers a POS section, and a save no longer sends one", () => {
  const source = app();
  assert.doesNotMatch(source, /<Field label="POS section">/);
  assert.doesNotMatch(source, /productPosSection/);
  const save = source.slice(source.indexOf("const addProduct = async () =>"), source.indexOf("const resetProductForm = () =>"));
  // Left out entirely, so the server keeps whatever an older build stored (PUT without the key).
  assert.doesNotMatch(save, /pos_section/);
  assert.match(source, /Every product is sold on the Frooz Retail tab\./);
});

test("an empty combo tab points at Combos & Offers, never at a product setting", () => {
  const source = app();
  assert.doesNotMatch(source, /its POS section is/);
  assert.match(source, /are set up yet\. The Owner or an Admin adds them in Combos & Offers\./);
});

test("a stored shelf that is not Retail is just a remembered value; normalising never invents one", () => {
  assert.equal(normalizePosSection("combos"), "retail");
  assert.equal(normalizePosSection(" MOMENTS "), "moments");
});

test("the remembered shelf survives bad or missing storage", () => {
  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  assert.equal(readPosSection(storage), "retail");
  writePosSection(storage, "bar");
  assert.equal(store.get(POS_SECTION_STORAGE_KEY), "bar");
  assert.equal(readPosSection(storage), "bar");
  store.set(POS_SECTION_STORAGE_KEY, "juices-old");
  assert.equal(readPosSection(storage), "retail");
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.equal(readPosSection(broken), "retail");
  assert.doesNotThrow(() => writePosSection(broken, "bar"));
  assert.equal(normalizePosSection(" MOMENTS "), "moments");
  assert.equal(posSectionLabel("nope"), "Frooz Retail");
});

test("a tile shows the fruit's colour and first letter, readable on either", () => {
  assert.deepEqual(posTileBadge("Alphonso Mango"), { letter: "A", tint: "#c8862f", ink: TILE_INK_DARK });
  assert.deepEqual(posTileBadge("pomegranate"), { letter: "P", tint: "#96233a", ink: TILE_INK_LIGHT });
  assert.equal(posTileBadge("Rambutan").tint, "#2f5a41", "an unknown fruit gets the neutral green, not a wrong colour");
  assert.equal(posTileBadge("  (Special) kiwi").letter, "S");
  assert.equal(posTileBadge("अनार").letter, "अ");
  assert.equal(posTileBadge("").letter, "?");
});

test("saving a product on the desktop pulls it at once, so POS shows the new section", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const start = app.indexOf('const savedMessage = wasEditing ? "Product Updated" : "Product Added";');
  assert.ok(start > 0, "product save message not found");
  const after = app.slice(start, start + 900);
  assert.match(after, /shouldSyncAfterPurchaseSave\(\{ tauriRuntime: isTauriRuntime\(\), queuedOffline: false \}\)/);
  assert.match(after, /runSyncNow\(\{ force: true \}\)\.catch/);
});

test("a combos-only tab is remembered only where combos are sold", () => {
  assert.equal(normalizePosTab("combos", { combosEnabled: true }), "combos");
  assert.equal(normalizePosTab("combos", { combosEnabled: false }), "retail");
  assert.equal(normalizePosTab("bar", { combosEnabled: true }), "bar");
  assert.equal(normalizePosTab("bar"), "retail", "the browser has no Bar tab: it sells no combos");
  assert.equal(normalizePosTab("moments", { combosEnabled: false }), "retail");
  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  writePosTab(storage, "combos");
  assert.equal(readPosTab(storage, { combosEnabled: true }), "combos");
  assert.equal(readPosTab(storage, { combosEnabled: false }), "retail");
  assert.equal(readPosTab({ getItem: () => { throw new Error("blocked"); } }), "retail");
});
