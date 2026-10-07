import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { productStockKeyResolver, wasteEntryProductId } from "./wasteStock.js";

test("a lot naming its product by the other form of id lands on that product", () => {
  const products = [
    { id: "product-12", product_name: "Apple" },
    { id: "13", global_id: "product-13", product_name: "Kiwi" },
  ];
  const keyFor = productStockKeyResolver(products);
  assert.equal(keyFor({ product_id: "product-12" }), "product-12");
  assert.equal(keyFor({ product_id: "product-13" }), "13", "a snapshot lot finds the cloud row");
  assert.equal(keyFor({ product_id: "99", product_global_id: "product-12" }), "product-12");
  assert.equal(keyFor({ product_id: "4" }), "", "unknown stays unknown");
});

test("the waste entry sends the id as picked, never NaN", () => {
  assert.equal(wasteEntryProductId("product-12"), "product-12");
  assert.equal(wasteEntryProductId(" 004 "), "004");
});

test("App wires both into the Waste screen", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("function WasteManagementModule(");
  const body = app.slice(start, app.indexOf("\nfunction ", start + 1));
  assert.match(body, /const productKeyForLot = productStockKeyResolver\(products\);/);
  assert.match(body, /product_id: wasteEntryProductId\(draft\.product_id\)/);
  assert.doesNotMatch(body, /Number\(draft\.product_id\)/);
});
