import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FRUIT_ART_KEYS, fruitArtFor, fruitArtKeyFor } from "./posFruitArt.js";
import { FRUIT_SVGS } from "./posFruitArtShapes.js";

test("every rule has a drawing, so a matched name never shows a blank tile", () => {
  for (const key of FRUIT_ART_KEYS) assert.ok(FRUIT_SVGS[key], `no drawing for ${key}`);
});

test("the drawings are safe to inline many times on one page", () => {
  const allowed = new Set(["svg", "g", "path", "circle", "ellipse", "rect", "polygon", "polyline", "line"]);
  for (const [key, svg] of Object.entries(FRUIT_SVGS)) {
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 64 64">/, `${key}: root`);
    assert.match(svg, /<\/svg>$/, `${key}: closed`);
    // A repeated id would make every tile share one gradient or clip; a url() or href would reach
    // outside the app, which neither the CSP nor LOCAL_ONLY allows.
    assert.doesNotMatch(svg, /\sid=|url\(|href|\son[a-z]+=|<script|<style|style=|class=/i, `${key}: forbidden content`);
    for (const [, tag] of svg.matchAll(/<([a-zA-Z]+)/g)) assert.ok(allowed.has(tag), `${key}: <${tag}> is not allowed`);
    assert.ok(svg.length <= 3072, `${key}: ${svg.length} bytes`);
  }
});

test("a fruit is recognised by its English or Hindi name, or its variety", () => {
  assert.equal(fruitArtKeyFor("Alphonso Mango"), "mango");
  assert.equal(fruitArtKeyFor("Kesar"), "mango");
  assert.equal(fruitArtKeyFor("Aam Langda"), "mango");
  assert.equal(fruitArtKeyFor("Shimla Apple"), "apple");
  assert.equal(fruitArtKeyFor("Anar Bhagwa"), "pomegranate");
  assert.equal(fruitArtKeyFor("Kinnow"), "orange");
  assert.equal(fruitArtKeyFor("Tarbooz"), "watermelon");
  assert.equal(fruitArtKeyFor("Mosambi"), "lemon");
  assert.equal(fruitArtKeyFor("Chiku"), "chikoo");
  assert.equal(fruitArtKeyFor("Robusta Banana"), "banana");
});

test("a phrase beats the word inside it", () => {
  assert.equal(fruitArtKeyFor("Custard Apple"), "custardapple");
  assert.equal(fruitArtKeyFor("Dragon Fruit Red"), "dragonfruit");
  assert.equal(fruitArtKeyFor("Watermelon"), "watermelon");
  assert.equal(fruitArtKeyFor("Melon"), "muskmelon");
});

test("what the item is beats which fruit it is made of", () => {
  assert.equal(fruitArtKeyFor("Mango Juice 250ml Bottle"), "juice_bottle");
  assert.equal(fruitArtKeyFor("Mango Shake"), "shake");
  assert.equal(fruitArtKeyFor("Watermelon Juice"), "juice_glass");
  assert.equal(fruitArtKeyFor("Fruit Chaat"), "chaat_bowl");
  assert.equal(fruitArtKeyFor("Kids Lunch Box"), "lunch_box");
  assert.equal(fruitArtKeyFor("Mango Gift Basket"), "gift_basket");
  assert.equal(fruitArtKeyFor("Diwali Gift Box"), "gift_box");
});

test("an unknown name gets no picture, so the tile keeps its letter", () => {
  assert.equal(fruitArtKeyFor("Rambutan"), null);
  assert.equal(fruitArtKeyFor(""), null);
  assert.equal(fruitArtFor("Rambutan"), null);
  assert.equal(fruitArtKeyFor("Barbados Special"), null);
  const art = fruitArtFor("Pineapple Queen");
  assert.equal(art.key, "pineapple");
  assert.equal(art.svg, FRUIT_SVGS.pineapple);
});

test("POS draws the picture when there is one and the letter otherwise", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /from "\.\/local\/posFruitArt"/);
  assert.match(app, /const art = fruitArtFor\(product\.product_name\);/);
  assert.match(app, /dangerouslySetInnerHTML=\{\{ __html: art\.svg \}\}/);
  assert.match(app, /posTileBadge\(product\.product_name\)/);
});
