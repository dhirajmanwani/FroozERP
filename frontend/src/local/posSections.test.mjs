import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEFAULT_POS_SECTION,
  POS_SECTIONS,
  POS_SECTION_STORAGE_KEY,
  TILE_INK_DARK,
  TILE_INK_LIGHT,
  chosenPosSection,
  normalizePosSection,
  posSectionAutomatic,
  posSectionCounts,
  posSectionFor,
  posSectionLabel,
  posTileBadge,
  readPosSection,
  writePosSection,
} from "./posSections.js";

const product = (product_name, category_name = "Fruit") => ({ product_name, category_name });

test("the three shelves are the owner's names, in his order", () => {
  assert.deepEqual(POS_SECTIONS.map((section) => section.label), ["Frooz Retail", "Frooz Bar", "Frooz Moments"]);
  assert.equal(DEFAULT_POS_SECTION, "retail");
});

test("a category named after a shelf puts every product in it on that shelf", () => {
  assert.deepEqual(posSectionFor(product("Alphonso Mango", "Frooz Bar")), { key: "bar", basis: "category", category: "Frooz Bar" });
  assert.equal(posSectionFor(product("Alphonso Mango", "Frooz Moments")).key, "moments");
  assert.equal(posSectionFor(product("Kesar Mango", "Juices")).key, "bar");
  assert.equal(posSectionFor(product("Premium Box", "Gift Baskets")).key, "moments");
  assert.equal(posSectionFor(product("Apple", "Frooz Retail")).key, "retail");
});

test("the category wins over the name, so the owner can always move a product", () => {
  // Under the default "Fruit" category the name decides; a category naming a shelf overrides it.
  assert.equal(posSectionFor(product("Mango Juice", "Fruit")).key, "bar");
  assert.equal(posSectionFor(product("Mango Juice", "Frooz Retail")).key, "retail");
  assert.equal(posSectionFor(product("Fruit Chaat Cup", "Frooz Moments")).key, "moments");
});

test("a product in a plain category is placed by its own name", () => {
  assert.equal(posSectionFor(product("Fruit Chaat")).key, "bar");
  assert.equal(posSectionFor(product("Watermelon Juice 300ml Bottle")).key, "bar");
  assert.equal(posSectionFor(product("Kids Lunch Box")).key, "bar");
  assert.equal(posSectionFor(product("Diwali Gift Hamper")).key, "moments");
  assert.equal(posSectionFor(product("Fruit Basket Large")).key, "moments");
  assert.equal(posSectionFor(product("Juice Gift Hamper")).key, "moments", "a gift of juice is a gift");
  assert.deepEqual(posSectionFor(product("Alphonso Mango")), { key: "retail", basis: "default", category: "Fruit" });
});

test("only whole words count, so fruit names never trip a shelf", () => {
  assert.equal(posSectionFor(product("Barbados Cherry")).key, "retail");
  assert.equal(posSectionFor(product("Custard Apple")).key, "retail");
  assert.equal(posSectionFor(product("Cupid Grapes")).key, "retail");
  assert.equal(posSectionFor(product("Bar Mango")).key, "retail", "\"bar\" names a shelf in a category, not an item in a name");
  assert.equal(posSectionFor(product("Lunch Special Box")).key, "retail", "\"lunch box\" is a phrase, not two loose words");
});

test("the category may arrive as category or category_name", () => {
  assert.equal(posSectionFor({ product_name: "Apple", category: "Frooz Bar" }).key, "bar");
  assert.equal(posSectionFor({ product_name: "Apple" }).key, "retail");
  assert.equal(posSectionFor(null).key, "retail");
});

test("a chosen POS section beats both the category and the name", () => {
  // A Retail product that landed on Bar by its name, moved back by the owner, and the reverse.
  assert.deepEqual(posSectionFor({ ...product("Mango Juice", "Fruit"), pos_section: "retail" }), { key: "retail", basis: "chosen", category: "Fruit" });
  assert.equal(posSectionFor({ ...product("Alphonso Mango", "Frooz Retail"), pos_section: "bar" }).key, "bar");
  assert.equal(posSectionFor({ ...product("Fruit Chaat", "Frooz Bar"), pos_section: "moments" }).key, "moments");
  assert.equal(posSectionFor({ product_name: "Apple", category: "Juices", pos_section: "retail" }).category, "Juices");
  // Automatic ignores the choice: it is what the form offers as "Automatic (now: ...)".
  assert.deepEqual(posSectionAutomatic({ ...product("Mango Juice", "Fruit"), pos_section: "retail" }), { key: "bar", basis: "name", category: "Fruit" });
  assert.deepEqual(
    posSectionCounts([{ ...product("Mango Juice"), pos_section: "retail" }, product("Apple")]),
    { retail: 2, bar: 0, moments: 0 },
  );
});

test("the chosen section is case-insensitive, and an invalid or empty one falls through to automatic", () => {
  assert.equal(posSectionFor({ ...product("Apple"), pos_section: " BAR " }).key, "bar");
  assert.equal(posSectionFor({ ...product("Apple"), pos_section: "Moments" }).basis, "chosen");
  for (const value of [null, undefined, "", "   ", "juices", "automatic", 0]) {
    // Not pinned to Retail the way normalizePosSection would: the name still decides.
    assert.deepEqual(posSectionFor({ ...product("Fruit Chaat"), pos_section: value }), { key: "bar", basis: "name", category: "Fruit" }, String(value));
    assert.equal(chosenPosSection({ pos_section: value }), null);
  }
  assert.equal(chosenPosSection(null), null);
  assert.equal(chosenPosSection({ pos_section: "Retail" }), "retail");
});

test("Product Master lets the owner choose the POS section and sends it with the product", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const save = app.slice(app.indexOf("const addProduct = async () =>"), app.indexOf("const resetProductForm = () =>"));
  assert.match(save, /pos_section: productPosSection \|\| null/);
  const reset = app.slice(app.indexOf("const resetProductForm = () =>"), app.indexOf("const saveProductCategory = async () =>"));
  assert.match(reset, /setProductPosSection\(""\)/);
  const edit = app.slice(app.indexOf("const editProduct = (product) =>"), app.indexOf("const cancelProductEdit = () =>"));
  assert.match(edit, /setProductPosSection\(chosenPosSection\(product\) \|\| ""\)/);
  assert.match(app, /<Field label="POS section">\s*<select value=\{productPosSection\}/);
  assert.match(app, /Automatic \(now: \$\{posSectionLabel\(posSectionAutomatic\(/);
  // The empty-shelf hint no longer tells the owner to rename a category to move a product.
  assert.doesNotMatch(app, /its category is named/);
});

test("counts carry every shelf, zero included", () => {
  assert.deepEqual(posSectionCounts([]), { retail: 0, bar: 0, moments: 0 });
  assert.deepEqual(
    posSectionCounts([product("Apple"), product("Mango"), product("Fruit Chaat"), product("Gift Basket")]),
    { retail: 2, bar: 1, moments: 1 },
  );
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

test("POS wires the shelves in without widening the counter's stock scope", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /from "\.\/local\/posSections"/);
  assert.match(app, /POS_SECTIONS\.map\(\(section\) =>/);
  assert.match(app, /posMatches\.filter\(\(option\) => option\.section\.key === posSection\)/);
  assert.match(app, /posTileBadge\(product\.product_name\)/);
  // The shelf is still cut from the counter-scoped sellable list, never from raw products.
  const memo = app.slice(app.indexOf("const posMatches = useMemo("), app.indexOf("const posSearching ="));
  assert.match(memo, /filterSellableProducts\(products, inventory, new Date\(\), counterScope\)/);
});

test("saving a product on the desktop pulls it at once, so POS shows the new section", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const start = app.indexOf('const savedMessage = wasEditing ? "Product Updated" : "Product Added";');
  assert.ok(start > 0, "product save message not found");
  const after = app.slice(start, start + 900);
  assert.match(after, /shouldSyncAfterPurchaseSave\(\{ tauriRuntime: isTauriRuntime\(\), queuedOffline: false \}\)/);
  assert.match(after, /runSyncNow\(\{ force: true \}\)\.catch/);
});
