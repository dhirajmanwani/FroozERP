import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PRODUCT_NOT_IN_CLOUD_MESSAGE,
  findDuplicateProductName,
  isServerProductId,
  productGlobalIdFrom,
  productIdentityKeys,
  resolveServerProductId,
} from "./productIdentity.js";

const cloudApple = { id: 5, global_id: "product-276", product_name: "Apple", active: true };
const cloudMango = { id: 6, global_id: "product-277", product_name: "Mango", active: true };
const deviceApple = { id: "product-276", product_name: "Apple", active: true };
const deviceMango = { id: "product-277", product_name: "Mango", active: true };

test("server ids are positive integers written in digits, nothing else", () => {
  assert.equal(isServerProductId(5), true);
  assert.equal(isServerProductId("42"), true);
  assert.equal(isServerProductId("product-276"), false);
  assert.equal(isServerProductId("004"), false);
  assert.equal(isServerProductId(0), false);
  assert.equal(isServerProductId(""), false);
  assert.equal(isServerProductId(null), false);
});

test("a product is known by its id and its global id", () => {
  assert.deepEqual(productIdentityKeys(cloudApple), ["5", "product-276"]);
  assert.deepEqual(productIdentityKeys(deviceApple), ["product-276"]);
  assert.deepEqual(productIdentityKeys(null), []);
});

test("editing a device-list product is not its own duplicate (the 25 Sep report)", () => {
  const keys = productIdentityKeys(deviceApple);
  assert.equal(findDuplicateProductName([deviceApple, deviceMango], "Apple", keys), null);
});

test("editing is not its own duplicate after the list swaps form between Edit and Save", () => {
  assert.equal(findDuplicateProductName([deviceApple, deviceMango], "Apple", productIdentityKeys(cloudApple)), null);
  assert.equal(findDuplicateProductName([cloudApple, cloudMango], "apple ", productIdentityKeys(deviceApple)), null);
});

test("a real duplicate is still refused, in either list form", () => {
  assert.equal(findDuplicateProductName([deviceApple, deviceMango], "mango", productIdentityKeys(deviceApple)), deviceMango);
  assert.equal(findDuplicateProductName([cloudApple, cloudMango], "Mango", productIdentityKeys(cloudApple)), cloudMango);
  assert.equal(findDuplicateProductName([cloudApple], "Apple", []), cloudApple);
});

test("an inactive product's name is free, as the server allows", () => {
  const retired = { ...cloudMango, active: false };
  assert.equal(findDuplicateProductName([cloudApple, retired], "Mango", productIdentityKeys(cloudApple)), null);
});

test("the numeric id is used directly when the row carries one", () => {
  assert.deepEqual(resolveServerProductId(productIdentityKeys(cloudApple), []), { ok: true, id: "5" });
});

test("a device-list row is matched to its cloud id through the global id", () => {
  assert.deepEqual(
    resolveServerProductId(productIdentityKeys(deviceApple), [cloudMango, cloudApple]),
    { ok: true, id: "5" }
  );
});

test("a product the cloud does not have is refused in words, never guessed", () => {
  const unsynced = { id: "product-999", product_name: "Kiwi" };
  assert.deepEqual(
    resolveServerProductId(productIdentityKeys(unsynced), [cloudApple, cloudMango]),
    { ok: false, message: PRODUCT_NOT_IN_CLOUD_MESSAGE }
  );
  assert.equal(resolveServerProductId([], [cloudApple]).ok, false);
});

test("the global id is found from either form", () => {
  assert.equal(productGlobalIdFrom(productIdentityKeys(cloudApple), []), "product-276");
  assert.equal(productGlobalIdFrom(productIdentityKeys(deviceApple), []), "product-276");
  assert.equal(productGlobalIdFrom(["5"], [cloudApple]), "product-276");
  assert.equal(productGlobalIdFrom(["5"], []), null);
});

test("App.jsx no longer compares product ids with Number()", () => {
  const source = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Number\(product\.id\)\s*!==\s*Number\(editingProductId/);
  assert.match(source, /findDuplicateProductName\(products, productName, editingKeys\)/);
  assert.match(source, /\/api\/v3\/products\/\$\{serverProductId\}`/);
});
