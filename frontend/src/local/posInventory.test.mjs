import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { hasSellableLocalInventory, mergeLocalFirstRows, selectLocalPosInventory } from "./posInventory.js";

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
