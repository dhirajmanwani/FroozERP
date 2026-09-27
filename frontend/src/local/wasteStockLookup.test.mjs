import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { canonicalInventoryId } from "./stockInventory.js";

const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
const body = (() => {
  const start = app.indexOf("function WasteManagementModule(");
  assert.ok(start > 0, "WasteManagementModule must exist");
  return app.slice(start, app.indexOf("\nfunction ", start + 1));
})();

test("Waste: stock per product is keyed and read by the canonical id, never Number()", () => {
  // The map used to be keyed with Number(item.product_id) and read with Number(product.id):
  // "004" became 4, and a non-numeric id became NaN, so the dropdown could show another
  // product's stock, or none. CLAUDE.md, "Canonical IDs".
  assert.match(body, /const key = canonicalInventoryId\(item\.product_id\);/);
  assert.match(body, /stockByProduct\.get\(canonicalInventoryId\(product\.id\)\)/);
  assert.doesNotMatch(body, /stockByProduct\.(get|set)\(Number\(/);
});

test("the canonical key keeps ids that Number() would have merged apart", () => {
  assert.notEqual(canonicalInventoryId("004"), canonicalInventoryId(4));
  assert.equal(canonicalInventoryId(" 4 "), canonicalInventoryId(4));
});
