import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { completionLinesPayload, completionLinesProblem, groupPurchaseBills, pendingCompletionLines, pendingItemRate, purchaseChangeBlock, purchaseHistoryAmounts, purchaseItemCounts, purchaseRowNet } from "./purchaseRows.js";

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

test("Edit is blocked only for a bill with several items, and the note no longer names Complete Bill", () => {
  assert.equal(purchaseChangeBlock(1), "");
  assert.equal(purchaseChangeBlock(undefined), "");
  assert.match(purchaseChangeBlock(3), /3 fruits.*Cancel the bill and enter it again/);
  assert.doesNotMatch(purchaseChangeBlock(3), /Complete/);
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

const pendingRows = [
  { id: 9, purchase_item_id: 31, product_id: 2, product_name: "Apple", unit: "KG", item_origin_type: "OUTSTATION", item_lot_name: "A1", quantity: "10.000", purchase_rate: "40.0000", expected_purchase_rate: "60", purchase_bill_status: "BILL_PENDING" },
  { id: 9, purchase_item_id: 32, product_id: 4, product_name: "Banana", unit: "DOZEN", quantity: "5.000", purchase_rate: "100", expected_purchase_rate: "60", purchase_bill_status: "BILL_PENDING" },
];

test("a pending arrival with several fruits becomes one editable line per fruit, at its arrival rate", () => {
  const { lines, error } = pendingCompletionLines(pendingRows);
  assert.equal(error, undefined);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((line) => line.purchase_item_id), [31, 32]);
  assert.deepEqual(lines.map((line) => line.purchase_rate), ["40", "100"], "each fruit's own rate, not the bill's average");
  assert.equal(lines[0].origin_type, "OUTSTATION");
  assert.equal(lines[1].origin_type, "LOCAL");
  assert.equal(lines[0].lot_name, "A1");
  assert.equal(lines[0].quantity, "10.000");
});

test("rows without a purchase item id are refused rather than guessed", () => {
  const { lines, error } = pendingCompletionLines([{ ...pendingRows[0], purchase_item_id: undefined }, pendingRows[1]]);
  assert.equal(lines, undefined);
  assert.match(error, /could not be told apart/);
  assert.match(pendingCompletionLines([]).error, /could not be read/);
});

test("every fruit needs a quantity and a final rate above zero before saving", () => {
  const { lines } = pendingCompletionLines(pendingRows);
  assert.equal(completionLinesProblem(lines), "");
  assert.match(completionLinesProblem([lines[0], { ...lines[1], purchase_rate: "" }]), /final purchase rate for Banana/);
  assert.match(completionLinesProblem([lines[0], { ...lines[1], purchase_rate: "0" }]), /final purchase rate for Banana/);
  assert.match(completionLinesProblem([{ ...lines[0], quantity: "abc" }, lines[1]]), /quantity for Apple/);
  assert.match(completionLinesProblem([]), /no fruits/);
});

test("the request names each fruit by its purchase item id", () => {
  const { lines } = pendingCompletionLines(pendingRows);
  lines[1].purchase_rate = "95";
  assert.deepEqual(completionLinesPayload(lines), [
    { purchase_item_id: 31, quantity: "10.000", purchase_rate: "40", lot_name: "A1", lot_size: "" },
    { purchase_item_id: 32, quantity: "5.000", purchase_rate: "95", lot_name: "", lot_size: "" },
  ]);
});

test("Purchase History counts a bill with several fruits once, not once per fruit", () => {
  const header = { id: 12, gross_amount: "1000", rebate_amount: "20", net_payable: "980", paid_amount: "490", balance_amount: "490", mandi_tax_amount: "15", freight_charges: "30", labour_charges: "0", other_charges: "0" };
  const apple = { ...header, quantity: "10", purchase_rate: "40", item_basic_amount: "400", item_mandi_tax_amount: "6", item_freight_charges: "12", item_labour_charges: "0", item_other_charges: "0", item_rebate_amount: "8.36", item_net_payable: "409.64" };
  const banana = { ...header, quantity: "5", purchase_rate: "100", item_basic_amount: "500", item_mandi_tax_amount: "9", item_freight_charges: "18", item_labour_charges: "0", item_other_charges: "0", item_rebate_amount: "11.64", item_net_payable: "570.36" };
  const a = purchaseHistoryAmounts(apple, 2);
  const b = purchaseHistoryAmounts(banana, 2);
  assert.equal(a.gross, 418);
  assert.equal(a.charges, 18);
  assert.ok(Math.abs(a.net + b.net - 980) < 1e-9, "the fruits' nets add up to the bill's net");
  assert.ok(Math.abs(a.paid + b.paid - 490) < 1e-9, "what was paid is shared, not repeated");
  assert.ok(Math.abs(a.balance + b.balance - 490) < 1e-9);
  assert.ok(Math.abs(a.rebate + b.rebate - 20) < 1e-9);
  const single = purchaseHistoryAmounts({ ...header, quantity: "10", purchase_rate: "40" }, 1);
  assert.deepEqual(single, { gross: 1000, charges: 45, rebate: 20, net: 980, paid: 490, balance: 490 }, "a one-item bill reads exactly as before");
  assert.equal(purchaseHistoryAmounts({ gross_amount: "0", quantity: "2", purchase_rate: "50", mandi_tax_amount: "1" }, 1).gross, 101);
});

test("the purchase screen completes several fruits together and the reports use the shared helpers", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const complete = app.slice(app.indexOf("const completePendingPurchase = (purchase) => {"), app.indexOf("const cancelPurchase = async"));
  assert.match(complete, /inventoryIdsEqual\(row\.id, purchase\.id\)/);
  assert.match(complete, /pendingCompletionLines\(billRows\)/);
  assert.match(complete, /setCompletionLines\(lines\)/);
  assert.match(app, /items: completionLinesPayload\(completionLines\)/);
  assert.match(app, /completionLinesProblem\(completionLines\)/);
  assert.match(app, /editingPurchaseId && !completionLines \? purchaseSummary : purchaseCartSummary/);
  assert.match(app, /purchaseHistoryAmounts\(row, /);
  assert.doesNotMatch(app, /disabled=\{Boolean\(changeBlock\)\} onClick=\{\(event\) => \{ event\.stopPropagation\(\); onCompletePurchase/, "Complete Bill is offered for a bill with several fruits");
  assert.doesNotMatch(app, /\|\| Boolean\(changeBlock\)\} onClick=\{\(\) => completePendingPurchase/);
});
