import test from "node:test";
import assert from "node:assert/strict";
import {
  costPerUnitSummary,
  distributionLotOptions,
  distributionStatusClass,
  formatQuantityWithUnit,
  isPendingBillCompletion,
  pendingItemNarration,
  pendingPurchasesPresentation,
  purchaseEntryHeadings,
  purchaseSavedMessage,
  stockLotName,
  wasteProductOptionLabel,
} from "./stockScreens.js";

const rupees = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" });
const money = (value) => rupees.format(value);

test("a quantity carries three decimals and its unit, and an unknown one is a dash", () => {
  assert.equal(formatQuantityWithUnit(71.5, "KG"), "71.500 Kg");
  assert.equal(formatQuantityWithUnit("4", "BOX"), "4.000 Box");
  assert.equal(formatQuantityWithUnit(0, "PIECE"), "0.000 Piece");
  assert.equal(formatQuantityWithUnit(2, ""), "2.000");
  assert.equal(formatQuantityWithUnit(null, "KG"), "—");
  assert.equal(formatQuantityWithUnit("", "KG"), "—");
});

test("cost per unit is shown only when every item is in the same unit (logic C)", () => {
  const sameUnit = costPerUnitSummary([{ quantity: 10, unit: "KG" }, { quantity: 5, unit: "kg" }], 1500);
  assert.equal(sameUnit.known, true);
  assert.equal(sameUnit.value, 100);
  assert.equal(sameUnit.label, "Cost per kg");

  // 10 kg of apples and 4 boxes of kiwi are not "14 units": the old figure divided by 14.
  const mixed = costPerUnitSummary([{ quantity: 10, unit: "KG" }, { quantity: 4, unit: "BOX" }], 1400);
  assert.equal(mixed.known, false);
  assert.equal(mixed.reason, "mixed");
  assert.equal(mixed.value, null);
  assert.match(mixed.label, /mixed units/);

  // Lines with no quantity are not counted, so an empty line does not make a bill "mixed".
  const withBlank = costPerUnitSummary([{ quantity: 3, unit: "BOX" }, { quantity: "", unit: "KG" }], 300);
  assert.equal(withBlank.known, true);
  assert.equal(withBlank.value, 100);
  assert.equal(withBlank.label, "Cost per box");

  assert.equal(costPerUnitSummary([], 100).known, false);
  assert.equal(costPerUnitSummary([{ quantity: 2, unit: "KG" }], null).known, false);
  // A zero net is a real figure, not unknown.
  assert.equal(costPerUnitSummary([{ quantity: 2, unit: "KG" }], 0).value, 0);
});

test("completing a pending bill is recognised, and nothing else is", () => {
  assert.equal(isPendingBillCompletion({ editingPurchaseId: 9, billStatus: "BILL_COMPLETED", originalBillStatus: "BILL_PENDING" }), true);
  assert.equal(isPendingBillCompletion({ editingPurchaseId: "9", billStatus: "BILL_COMPLETED", originalBillStatus: "BILL_COMPLETED" }), false);
  assert.equal(isPendingBillCompletion({ editingPurchaseId: 9, billStatus: "BILL_PENDING", originalBillStatus: "BILL_PENDING" }), false);
  assert.equal(isPendingBillCompletion({ editingPurchaseId: null, billStatus: "BILL_COMPLETED", originalBillStatus: "BILL_PENDING" }), false);
});

test("Purchase Entry's headings say what is being done, in plain words", () => {
  const completing = purchaseEntryHeadings({ completing: true, editing: true, multiFruit: 2, supplierName: "Ramesh Fruits" });
  assert.equal(completing.title, "Complete the bill from Ramesh Fruits");
  assert.equal(completing.itemsTitle, "Final rate for each fruit");
  assert.match(completing.itemsSubtitle, /2 fruits/);
  const editing = purchaseEntryHeadings({ editing: true });
  assert.equal(editing.title, "Correct a saved purchase");
  const fresh = purchaseEntryHeadings({});
  assert.equal(fresh.title, "Purchase entry");
  for (const heading of [completing, editing, fresh]) {
    // No developer words, no internal numbers, sentence case.
    assert.doesNotMatch(Object.values(heading).join(" "), /workflow|Amendment|inventory protection|#\d/);
  }
});

test("a saved purchase is reported with what was saved and for whom", () => {
  assert.equal(purchaseSavedMessage({ supplierName: "Ramesh" }), "Purchase saved for Ramesh.");
  assert.equal(purchaseSavedMessage({ completing: true, editing: true, supplierName: "Ramesh" }), "Bill completed for Ramesh.");
  assert.equal(purchaseSavedMessage({ editing: true, supplierName: "Ramesh" }), "Purchase for Ramesh corrected.");
  assert.match(purchaseSavedMessage({ pending: true, supplierName: "Ramesh" }), /^Stock arrival from Ramesh saved\. The bill is waiting in Pending Bills\.$/);
  assert.match(purchaseSavedMessage({ queuedOffline: true, supplierName: "Ramesh" }), /saved on this computer/);
  assert.equal(purchaseSavedMessage({}), "Purchase saved.");
});

test("Pending Bills never shows a failed load as nothing pending (logic E)", () => {
  assert.deepEqual(pendingPurchasesPresentation({ status: "failed", message: "Network down" }), { kind: "failed", figures: false, message: "Network down" });
  assert.equal(pendingPurchasesPresentation({ status: "failed" }).message, "The purchases could not be loaded.");
  assert.equal(pendingPurchasesPresentation({ status: "loading" }).figures, false);
  assert.equal(pendingPurchasesPresentation({}).kind, "loading");
  assert.equal(pendingPurchasesPresentation({ status: "ready" }).figures, true);
});

test("a pending item reads with its unit and rupees, and an unset rate is said", () => {
  assert.equal(pendingItemNarration({ product_name: "Apple", quantity: 5, unit: "KG" }, 95, money), "Apple 5.000 Kg × ₹95.00 = ₹475.00");
  assert.equal(pendingItemNarration({ product_name: "Kiwi", quantity: 2, unit: "BOX" }, 0, money), "Kiwi 2.000 Box, rate not set");
});

test("consignment badges: waiting is a warning, done is success, cancelled neutral, refused danger", () => {
  assert.equal(distributionStatusClass("APPROVAL_PENDING"), "origin-rate");
  assert.equal(distributionStatusClass("DISPATCHED_IN_TRANSIT"), "origin-rate");
  assert.equal(distributionStatusClass("RECEIVED"), "stock-ok");
  assert.equal(distributionStatusClass("closed"), "stock-ok");
  assert.equal(distributionStatusClass("CANCELLED"), "tag");
  assert.equal(distributionStatusClass("REJECTED"), "stock-low");
  assert.equal(distributionStatusClass("SOMETHING_NEW"), "stock-low");
});

test("the lot picker names lots for people, with unit, oldest first per product", () => {
  const lots = [
    { id: 7, product_id: "p2", lot_name: "Lot B", purchase_date: "2026-11-10", remaining_qty: 4, unit: "BOX" },
    { id: 3, product_id: "p1", lot_name: "", batch_no: "", purchase_date: "2026-11-12T08:00:00Z", remaining_qty: 48.5, unit: "KG" },
    { id: 5, product_id: "p1", lot_name: "Kesar A", purchase_date: "2026-11-01", remaining_qty: 2, unit: "KG" },
  ];
  const names = { p1: "Apple", p2: "Kiwi" };
  const options = distributionLotOptions(lots, {
    available: (lot) => lot.remaining_qty,
    productName: (lot) => names[lot.product_id],
    formatDate: (key) => key.split("-").reverse().join("/"),
  });
  assert.deepEqual(options.map((option) => option.id), [5, 3, 7]);
  assert.equal(options[0].label, "Apple — Kesar A · in 01/11/2026 (2.000 Kg available)");
  assert.equal(options[1].label, "Apple — Lot of 12/11/2026 (48.500 Kg available)");
  assert.equal(options[2].shortLabel, "Lot B · in 10/11/2026 (4.000 Box available)");
  for (const option of options) assert.doesNotMatch(option.label, /— 3 |— 5 |— 7 /, "never the raw lot id");
  assert.equal(stockLotName({}), "Unnamed lot");
});

test("Waste's product list says a dash, not 'Stock 0', when the stock is not known (logic E)", () => {
  assert.equal(wasteProductOptionLabel({ product_name: "Apple", unit: "KG" }, 12.5), "Apple (in stock: 12.500 Kg)");
  assert.equal(wasteProductOptionLabel({ product_name: "Apple", unit: "KG" }, undefined), "Apple (in stock: —)");
  assert.equal(wasteProductOptionLabel({ product_name: "Apple", unit: "KG" }, 0), "Apple (in stock: 0.000 Kg)");
});
