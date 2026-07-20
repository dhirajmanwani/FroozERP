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
