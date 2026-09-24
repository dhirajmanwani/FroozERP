import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { filterSellableProducts, hasSellableLocalInventory, isSellableLot, lotAvailableQuantity, mergeLocalFirstRows, productAvailableQuantity, selectLocalPosInventory } from "./posInventory.js";

const local = {
  products: Array.from({ length: 25 }, (_, index) => ({ id: index + 1, product_name: `Product ${index + 1}`, active: true })),
  inventory_lots: Array.from({ length: 70 }, (_, index) => ({ id: index + 1, product_id: index % 25 + 1, remaining_qty: 5, batch_status: "ACTIVE" })),
};

test("empty cloud data cannot replace local POS products and lots", () => {
  const selected = selectLocalPosInventory(local, { products: [], inventoryLots: [] });
  assert.equal(selected.products.length, 25);
  assert.equal(selected.inventoryLots.length, 70);
  assert.equal(hasSellableLocalInventory(selected), true);
});

test("local rows win over stale cloud rows while cloud-only additions are retained", () => {
  const result = mergeLocalFirstRows([{ id: 1, remaining_qty: 9 }], [{ id: 1, remaining_qty: 0 }, { id: 2, remaining_qty: 4 }]);
  assert.deepEqual(result, [{ id: 1, remaining_qty: 9 }, { id: 2, remaining_qty: 4 }]);
});

test("desktop POS explicitly reloads SQLite on entry and treats an empty search as show all", () => {
  const source = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(source, /refreshPosInventoryFromSQLite\("navigate-local-pos"\)/);
  assert.match(source, /refreshPosInventoryFromSQLite\("navigate-auto-pos"\)/);
  assert.match(source, /if \(!query\) return true/);
  assert.match(source, /preserveVerifiedLocalCollection\(response\.data, current\)/);
});

test("POS hides zero and negative stock while combining positive multi-lot availability", () => {
  const products = [{ id: 1, active: true }, { id: 2, active: true }, { id: 3, active: true }];
  const lots = [
    { id: 11, product_id: 1, balance_qty: 2, status: "ACTIVE" },
    { id: 12, product_id: 1, balance_qty: 3, status: "ACTIVE" },
    { id: 21, product_id: 2, balance_qty: 0, status: "ACTIVE" },
    { id: 31, product_id: 3, balance_qty: -4, status: "ACTIVE" },
  ];
  assert.equal(productAvailableQuantity(1, lots), 5);
  assert.deepEqual(filterSellableProducts(products, lots).map((product) => product.id), [1]);
});

test("POS excludes cancelled, reserved, exhausted and prohibited expired quantities", () => {
  const now = new Date("2026-07-21T00:00:00.000Z");
  assert.equal(lotAvailableQuantity({ balance_qty: 5, reserved_qty: 2, status: "ACTIVE" }, now), 3);
  assert.equal(isSellableLot({ balance_qty: 5, status: "CANCELLED" }, now), false);
  assert.equal(isSellableLot({ balance_qty: 5, status: "RESERVED" }, now), false);
  assert.equal(isSellableLot({ balance_qty: 5, expiry_date: "2026-07-20T00:00:00.000Z" }, now), false);
  assert.equal(isSellableLot({ balance_qty: 5, expiry_date: "2026-07-20T00:00:00.000Z", allow_expired_sale: true }, now), true);
});

test("an empty POS says which of the four emptinesses it is", async () => {
  const { emptyShelfReason } = await import("./posInventory.js");
  const now = new Date("2026-09-24T10:00:00Z");
  assert.match(emptyShelfReason({ products: [], inventoryLots: [], now }), /No products have reached this computer/);
  assert.match(emptyShelfReason({ products: [{ id: 1 }], inventoryLots: [], now }), /knows 1 products but has no stock lots/);
  assert.match(emptyShelfReason({ products: [{ id: 1 }], inventoryLots: [{ product_id: 1, remaining_qty: 0 }], now }), /All 1 stock lots .* sold out/);
  assert.match(
    emptyShelfReason({ products: [{ id: "004" }], inventoryLots: [{ product_id: 4, remaining_qty: 5 }], now }),
    /1 lots with stock, but none of them belongs to the 1 products/,
    "\"004\" and 4 are different products",
  );
  assert.equal(emptyShelfReason({ products: [{ id: 4 }], inventoryLots: [{ product_id: "4", remaining_qty: 5 }], now }), "");
});

test("POS draws from its own shelf, which only the SQLite refresh, a sale and a sign-in change write", () => {
  // 24 Sep 2026: POS filled, then emptied itself a minute later, again and again. It read the
  // `products` and `inventory` every module shares, and some twenty loaders overwrite those (cloud
  // lists with id 1, this device's SQLite with "product-1"). Whichever ran last decided the shelf.
  const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /inventory=\{posShelf\.loaded \? posShelf\.inventoryLots : inventory\}/);
  assert.match(app, /products=\{\(posShelf\.loaded \? posShelf\.products : products\)\.filter/);
  const writers = app.match(/setPosShelf\(/g) || [];
  assert.equal(writers.length, 4, "a new writer of the POS shelf is how it starts emptying itself again");
  const refresh = app.slice(app.indexOf("const refreshPosInventoryFromSQLite"), app.indexOf("const fetchOnlineReferenceSnapshot"));
  assert.equal((refresh.match(/setPosShelf\(\{ loaded: true/g) || []).length, 2);
  assert.match(app, /setPosShelf\(\(shelf\) => \(\{ \.\.\.shelf, inventoryLots: takeSold\(shelf\.inventoryLots\) \}\)\)/);
});
