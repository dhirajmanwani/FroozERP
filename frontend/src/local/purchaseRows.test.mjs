import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { groupPurchaseBills, pendingItemRate, purchaseChangeBlock, purchaseItemCounts, purchaseRowNet } from "./purchaseRows.js";

const rows = [
  { id: 7, supplier_id: 1, product_name: "Apple", quantity: "10", net_payable: "900.00", item_net_payable: "500.00" },
  { id: 7, supplier_id: 1, product_name: "Banana", quantity: "5", net_payable: "900.00", item_net_payable: "400.00" },
  { id: "8", supplier_id: 1, product_name: "Kiwi", quantity: "2", net_payable: "120.00", item_net_payable: "120.00" },
];

test("rows are grouped into bills by canonical id, in order, keeping every item", () => {
  const bills = groupPurchaseBills(rows);
  assert.equal(bills.length, 2);
  assert.deepEqual(bills.map((bill) => bill.key), ["7", "8"]);
  assert.equal(bills[0].itemCount, 2);
  assert.deepEqual(bills[0].items.map((item) => item.product_name), ["Apple", "Banana"]);
  assert.equal(bills[1].itemCount, 1);
  assert.equal(purchaseItemCounts(rows).get("7"), 2);
  assert.equal(purchaseItemCounts(rows).get("8"), 1);
  assert.deepEqual(groupPurchaseBills(null), []);
});

test("ids are compared as opaque strings, never as numbers", () => {
  const counts = purchaseItemCounts([{ id: "004" }, { id: 4 }]);
  assert.equal(counts.get("004"), 1);
  assert.equal(counts.get("4"), 1);
});

test("Edit and Complete Bill are blocked only for a bill with several items", () => {
  assert.equal(purchaseChangeBlock(1), "");
  assert.equal(purchaseChangeBlock(undefined), "");
  assert.match(purchaseChangeBlock(3), /3 fruits.*Cancel the bill and enter it again/);
});

test("a several-item bill shows each item's own net, never the bill's net on every row", () => {
  assert.equal(purchaseRowNet(rows[0], 2), 500);
  assert.equal(purchaseRowNet(rows[1], 2), 400);
  assert.equal(purchaseRowNet({ ...rows[0], item_net_payable: null }, 2), null);
  assert.equal(purchaseRowNet({ ...rows[0], purchase_bill_status: "BILL_PENDING", item_net_payable: "0" }, 2), null, "a pending item's 0 is not a price");
  assert.equal(purchaseRowNet(rows[2], 1), 120);
  assert.equal(purchaseRowNet({ net_payable: null, total_amount: "75" }, 1), 75, "one-item bills read as before");
});

test("Pending Bills and the amendment table use the grouping and the block", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("function PendingPurchaseBillsModule(");
  const pending = app.slice(start, app.indexOf("\nfunction ", start + 10));
  assert.match(pending, /groupPurchaseBills\(/);
  assert.match(pending, /purchaseChangeBlock\(/);
  assert.doesNotMatch(pending, /key=\{purchase\.id\}/, "one React key per bill, not per item row");
  assert.match(app, /amendmentItemCounts/);
  assert.match(app, /purchaseRowNet\(purchase, /);
});

test("a pending item is priced at its own expected rate, not the bill's average", () => {
  assert.equal(pendingItemRate({ purchase_rate: "40.0000", expected_purchase_rate: "60" }), 40);
  assert.equal(pendingItemRate({ purchase_rate: "100", expected_purchase_rate: "60" }), 100);
  assert.equal(pendingItemRate({ purchase_rate: null, expected_purchase_rate: "60" }), 60);
  assert.equal(pendingItemRate({ purchase_rate: "0", expected_purchase_rate: "60" }), 60);
  assert.equal(pendingItemRate({}), 0);
});
