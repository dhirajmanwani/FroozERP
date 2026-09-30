import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MISSING,
  buildBulkRatePayload,
  buildSaleRateRows,
  collectSaleRateChanges,
  describeSaveResult,
  filterSaleRateRows,
  marginOnCost,
  marginTone,
  rateTone,
  parseTargetMargin,
  readDraftRate,
  resolveSaleRateAvailability,
  roundSuggestedRate,
  saleRateRowKey,
  suggestSaleRate,
  suggestedDrafts,
} from "./saleRateUpdate.js";

// Shaped exactly like GET /sale-rates rows: pg sends NUMERIC as strings.
const apiRows = [
  { id: 11, product_id: 1, inventory_batch_id: 11, product_name: "Apple Shimla", category: "Fruit", origin_type: "IMPORTED", unit: "KG", selling_rate: "180.00", lot_name: "Lot A", lot_size: "Large", current_stock: "20.000", pending_bill_stock: "0", latest_effective_cost: "120.00" },
  { id: 12, product_id: 1, inventory_batch_id: 12, product_name: "Apple Shimla", category: "Fruit", origin_type: "IMPORTED", unit: "KG", selling_rate: "190.00", lot_name: "Lot B", lot_size: "Medium", current_stock: "15.000", pending_bill_stock: "0", latest_effective_cost: "140.00" },
  { id: 13, product_id: 2, inventory_batch_id: 13, product_name: "Banana", category: "Fruit", origin_type: "LOCAL", unit: "DOZEN", selling_rate: "60.00", lot_name: "Lot 1", lot_size: null, current_stock: "30.000", pending_bill_stock: "30.000", latest_effective_cost: "45.00" },
  { id: -3, product_id: 3, inventory_batch_id: null, product_name: "Mango", category: "Seasonal", origin_type: "LOCAL", unit: "KG", selling_rate: "150.00", lot_name: null, lot_size: null, current_stock: "0", pending_bill_stock: 0, latest_effective_cost: "0" },
];

// ---------------------------------------------------------------------------------------------
// The suggestion and the margin share one basis
// ---------------------------------------------------------------------------------------------

test("the suggested rate is cost plus the target margin on cost, rounded like the server", () => {
  assert.equal(suggestSaleRate({ cost: 120, targetMargin: 25, roundingRule: "NEAREST_RUPEE" }), 150);
  assert.equal(suggestSaleRate({ cost: 45, targetMargin: 25, roundingRule: "NEAREST_RUPEE" }), 56);
  assert.equal(suggestSaleRate({ cost: 45, targetMargin: 25, roundingRule: "ROUND_UP_5" }), 60);
  assert.equal(suggestSaleRate({ cost: 45, targetMargin: 25, roundingRule: "ROUND_UP_10" }), 60);
  assert.equal(suggestSaleRate({ cost: 45, targetMargin: 25, roundingRule: "NO_ROUND" }), 56.25);
});

test("the margin shown for a suggested rate is the target it was made from, not 20% for 25%", () => {
  // The bug: suggestion = cost × 1.25, column = (rate − cost) / rate = 20.0%.
  const suggested = suggestSaleRate({ cost: 120, targetMargin: 25, roundingRule: "NO_ROUND" });
  assert.equal(marginOnCost(suggested, 120), 25);
  assert.equal(marginTone(marginOnCost(suggested, 120), 25), "success");
});

test("a suggestion rounded to the rupee is not flagged as under its own target", () => {
  const suggested = suggestSaleRate({ cost: 45, targetMargin: 25, roundingRule: "NEAREST_RUPEE" }); // 56
  const margin = marginOnCost(suggested, 45); // 24.4
  assert.ok(margin < 25);
  assert.equal(rateTone({ rate: suggested, cost: 45, suggestedRate: suggested, targetMargin: 25 }), "success");
  assert.equal(rateTone({ rate: 55, cost: 45, suggestedRate: suggested, targetMargin: 25 }), "warning");
  assert.equal(rateTone({ rate: 40, cost: 45, suggestedRate: suggested, targetMargin: 25 }), "danger");
  assert.equal(rateTone({ rate: 60, cost: null, suggestedRate: null, targetMargin: 25 }), "neutral");
  // Suggestions switched off: compared with the target itself.
  assert.equal(rateTone({ rate: 55, cost: 45, targetMargin: 25 }), "warning");
});

test("rounding up never jumps a whole step because of float noise", () => {
  // 40 × 1.25 = 50 exactly; a stray 1e-14 would ceil to 55.
  assert.equal(suggestSaleRate({ cost: 40, targetMargin: 25, roundingRule: "ROUND_UP_5" }), 50);
  assert.equal(suggestSaleRate({ cost: 8, targetMargin: 25, roundingRule: "ROUND_UP_10" }), 10);
  assert.equal(roundSuggestedRate(50.0000000000001, "ROUND_UP_5"), 50);
  // A real fraction above the step still goes up, as the server's Math.ceil does.
  assert.equal(roundSuggestedRate(50.01, "ROUND_UP_5"), 55);
  assert.equal(roundSuggestedRate(56.5, "UNKNOWN_RULE"), 57);
});

test("no cost means no suggestion and no margin -- never a 100% margin or a ₹0 cost", () => {
  assert.equal(suggestSaleRate({ cost: 0, targetMargin: 25 }), null);
  assert.equal(suggestSaleRate({ cost: null, targetMargin: 25 }), null);
  assert.equal(suggestSaleRate({ cost: "", targetMargin: 25 }), null);
  assert.equal(marginOnCost(150, 0), null);
  assert.equal(marginOnCost(150, null), null);
  assert.equal(marginTone(null, 25), "neutral");
});

test("a rate below cost is a loss, under target is a warning", () => {
  assert.equal(marginTone(marginOnCost(100, 120), 25), "danger");
  assert.equal(marginTone(marginOnCost(130, 120), 25), "warning");
  assert.equal(marginTone(marginOnCost(160, 120), 25), "success");
});

test("a 0% target is kept, not turned into 25%", () => {
  assert.equal(parseTargetMargin("0", 25), 0);
  assert.equal(parseTargetMargin(0, 25), 0);
  assert.equal(parseTargetMargin("", 30), 30);
  assert.equal(parseTargetMargin("-5", 30), 30);
  assert.equal(parseTargetMargin("abc", undefined), 25);
  assert.equal(suggestSaleRate({ cost: 120, targetMargin: 0 }), 120);
});

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

test("rows carry numbers or null, never a 0 standing in for unknown", () => {
  const rows = buildSaleRateRows(apiRows, { targetMargin: 25 });
  const mango = rows.find((row) => row.key === "-3");
  assert.equal(mango.cost, null);
  assert.equal(mango.suggestedRate, null);
  assert.equal(mango.currentMargin, null);
  assert.equal(mango.isLot, false);
  assert.equal(mango.inventoryBatchId, null);
  assert.equal(mango.currentRate, 150);
  assert.match(mango.lotLabel, /product rate/);

  const lotA = rows.find((row) => row.key === "11");
  assert.equal(lotA.cost, 120);
  assert.equal(lotA.currentRate, 180);
  assert.equal(lotA.currentMargin, 50);
  assert.equal(lotA.suggestedRate, 150);
  assert.equal(lotA.lotLabel, "Lot A · Large");
  assert.equal(lotA.stock, 20);
});

test("stock whose bill has not come is marked as an estimated cost", () => {
  const rows = buildSaleRateRows(apiRows);
  assert.equal(rows.find((row) => row.key === "13").costIsEstimate, true);
  assert.equal(rows.find((row) => row.key === "11").costIsEstimate, false);
});

test("suggestions switched off in Settings produce none", () => {
  const rows = buildSaleRateRows(apiRows, { suggestionsEnabled: false });
  assert.ok(rows.every((row) => row.suggestedRate === null));
});

test("the target margin and rounding rule drive the suggestion without a server round trip", () => {
  const at40 = buildSaleRateRows(apiRows, { targetMargin: 40, roundingRule: "ROUND_UP_10" });
  assert.equal(at40.find((row) => row.key === "11").suggestedRate, 170);
});

test("row keys are opaque text: 004 and 4 are different rows", () => {
  assert.equal(saleRateRowKey({ id: "004" }), "004");
  assert.equal(saleRateRowKey({ id: 4 }), "4");
  assert.notEqual(saleRateRowKey({ id: "004" }), saleRateRowKey({ id: 4 }));
  assert.equal(saleRateRowKey(null), "");
});

test("a missing product name reads as a dash", () => {
  const [row] = buildSaleRateRows([{ id: 9, product_id: 9, inventory_batch_id: 9 }]);
  assert.equal(row.productName, MISSING);
  assert.equal(row.currentRate, null);
});

test("filters: search covers product and lot, category and origin are exact", () => {
  const rows = buildSaleRateRows(apiRows);
  assert.deepEqual(filterSaleRateRows(rows, { search: "lot b" }).map((row) => row.key), ["12"]);
  assert.deepEqual(filterSaleRateRows(rows, { origin: "LOCAL" }).map((row) => row.key), ["13", "-3"]);
  assert.deepEqual(filterSaleRateRows(rows, { category: "Seasonal" }).map((row) => row.key), ["-3"]);
  assert.equal(filterSaleRateRows(rows, {}).length, 4);
});

// ---------------------------------------------------------------------------------------------
// Drafts and the save
// ---------------------------------------------------------------------------------------------

test("an input that was typed in and then cleared is not a change and does not block Save", () => {
  const rows = buildSaleRateRows(apiRows);
  const result = collectSaleRateChanges(rows, { 11: "", 12: "  " });
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.invalid, []);
});

test("zero, negative and non-numbers are refused by row, not silently sent", () => {
  assert.equal(readDraftRate("0").state, "invalid");
  assert.equal(readDraftRate("-4").state, "invalid");
  assert.equal(readDraftRate("abc").state, "invalid");
  assert.deepEqual(readDraftRate("12.345"), { state: "valid", rate: 12.35 });
  const rows = buildSaleRateRows(apiRows);
  const result = collectSaleRateChanges(rows, { 11: "0", 12: "200" });
  assert.deepEqual(result.invalid, ["11"]);
  assert.deepEqual(result.changes.map((change) => change.key), ["12"]);
});

test("a rate equal to the current one is not a change", () => {
  const rows = buildSaleRateRows(apiRows);
  assert.deepEqual(collectSaleRateChanges(rows, { 11: "180", 12: "190.00" }).changes, []);
});

test("changes behind the filter are counted, so the owner can see they will be saved", () => {
  const rows = buildSaleRateRows(apiRows);
  const visible = filterSaleRateRows(rows, { origin: "LOCAL" });
  const result = collectSaleRateChanges(rows, { 11: "170", 13: "65" }, visible);
  assert.equal(result.changes.length, 2);
  assert.equal(result.hiddenCount, 1);
  assert.equal(result.changes.find((change) => change.key === "11").hidden, true);
});

test("a new rate under cost is marked, so the confirmation can say so", () => {
  const rows = buildSaleRateRows(apiRows);
  const [change] = collectSaleRateChanges(rows, { 11: "110" }).changes;
  assert.equal(change.belowCost, true);
  assert.equal(change.oldRate, 180);
  assert.equal(change.newRate, 110);
});

test("the payload keeps ids as the server sent them and sends a product row with no lot", () => {
  const rows = buildSaleRateRows([
    ...apiRows,
    { id: "lot-004", product_id: "004", inventory_batch_id: "lot-004", product_name: "Kiwi", selling_rate: "90", latest_effective_cost: "70" },
  ]);
  const { changes } = collectSaleRateChanges(rows, { "-3": "160", "lot-004": "95", 13: "62.5" });
  const payload = buildBulkRatePayload(changes);
  assert.deepEqual(payload, [
    { product_id: 2, inventory_batch_id: 13, new_selling_rate: 62.5 },
    { product_id: 3, inventory_batch_id: null, new_selling_rate: 160 },
    { product_id: "004", inventory_batch_id: "lot-004", new_selling_rate: 95 },
  ]);
  // The old code sent Number(rate.product_id || rate.id): never a negative row id as a product.
  assert.ok(payload.every((entry) => entry.product_id !== -3));
});

test("'use suggested' fills only rows that have a suggestion different from today's rate", () => {
  const rows = buildSaleRateRows(apiRows, { targetMargin: 25 });
  // Lot A 150 (current 180), Lot B 175 (190), Banana 56 (60); Mango has no cost.
  assert.deepEqual(suggestedDrafts(rows), { 11: "150", 12: "175", 13: "56" });
  const same = buildSaleRateRows([{ ...apiRows[0], selling_rate: "150" }], { targetMargin: 25 });
  assert.deepEqual(suggestedDrafts(same), {});
});

test("the success message counts what the server changed, not what was sent", () => {
  assert.equal(describeSaveResult({ updated_count: 3 }, 3), "Saved 3 rates.");
  assert.equal(describeSaveResult({ updated_count: 1 }, 2), "Saved 1 rate. 1 already had that rate.");
  assert.equal(describeSaveResult({}, 2), "Saved 2 rates.");
  assert.match(describeSaveResult({ updated_count: 0 }, 2), /^Nothing changed/);
});

test("Local Only and offline explain themselves instead of showing an empty table", () => {
  assert.match(resolveSaleRateAvailability({ localOnly: true }), /Local Only/);
  assert.match(resolveSaleRateAvailability({ offline: true }), /offline/);
  assert.equal(resolveSaleRateAvailability({}), null);
});

// ---------------------------------------------------------------------------------------------
// Wiring: the screen uses this module and not its old inline math
// ---------------------------------------------------------------------------------------------

const APP = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
const managerSource = (() => {
  const start = APP.indexOf("function SaleRateManager(");
  assert.notEqual(start, -1, "SaleRateManager must still exist");
  const end = APP.indexOf("\nfunction ", start + 10);
  return APP.slice(start, end);
})();

test("the screen takes its rows, drafts and payload from saleRateUpdate.js", () => {
  for (const name of ["buildSaleRateRows", "filterSaleRateRows", "collectSaleRateChanges", "buildBulkRatePayload", "describeSaveResult"]) {
    assert.ok(managerSource.includes(name), `SaleRateManager must use ${name}`);
  }
  assert.match(APP, /from "\.\/local\/saleRateUpdate(\.js)?"/);
});

test("the screen never coerces an id with Number() and never computes margin on the sale price", () => {
  assert.doesNotMatch(managerSource, /Number\(\s*rate\.product_id/);
  assert.doesNotMatch(managerSource, /\/\s*sellingRate\)\s*\*\s*100/);
  assert.doesNotMatch(managerSource, /latest_effective_cost\s*\|\|\s*0/);
});

test("a save whose reload fails is still reported as saved", () => {
  // The POST and the reload are separate: a reload failure must not produce "Unable to update".
  const postAt = managerSource.indexOf("/sale-rates/bulk");
  assert.notEqual(postAt, -1);
  const afterPost = managerSource.slice(postAt);
  const reloadAt = afterPost.indexOf("onSaved");
  assert.notEqual(reloadAt, -1);
  // The POST has its own try/catch that returns, and the reload runs after it with its own catch.
  assert.match(afterPost.slice(0, reloadAt), /catch \(error\)[\s\S]*return;[\s\S]*\}/);
  assert.match(afterPost.slice(reloadAt, reloadAt + 80), /\.catch\(/);
});


test("the save sends no identity: the server takes it from the signed session", () => {
  const post = managerSource.slice(managerSource.indexOf("/sale-rates/bulk"));
  assert.doesNotMatch(post.slice(0, 200), /changed_by|user_id|user\.id/);
  assert.doesNotMatch(managerSource.split("\n")[0], /\buser\b/, "SaleRateManager needs no user prop");
});

test("Local Only or offline shows a notice and no table, no Save and no load", () => {
  // The whole working area sits behind `unavailableReason`, and the load effect returns early on it,
  // so in LOCAL_ONLY this screen makes no request at all.
  assert.match(managerSource, /if \(unavailableReason \|\| typeof onLoad !== "function"\) return;/);
  const noticeAt = managerSource.indexOf("{unavailableReason ? (");
  const saveAt = managerSource.indexOf("onClick={requestSave}");
  assert.ok(noticeAt !== -1 && saveAt > noticeAt, "Save must be inside the available branch");
  assert.match(managerSource, /<div className="warning-note" role="status">\{unavailableReason\}<\/div>/);
  const mount = APP.slice(APP.indexOf("<SaleRateManager"), APP.indexOf("<SaleRateManager") + 2000);
  assert.match(mount, /localOnly: connectivityMode === CONNECTIVITY_MODES\.LOCAL_ONLY/);
  assert.match(mount, /offline: offlineMode/);
});

test("a failed load is an error banner with a retry, and the table is not drawn", () => {
  assert.match(managerSource, /\{failed && \(\s*<div className="error-banner" role="alert">/);
  assert.match(managerSource, /\{!failed && \(\s*<DataTable/);
  const loader = APP.slice(APP.indexOf("const loadSaleRates = async"), APP.indexOf("const loadSupplierData"));
  assert.match(loader, /status: "failed"/);
  assert.match(loader, /Promise\.allSettled/, "the loader never throws into the menu handler");
});

test("after a save POS prices are refreshed too, not only this list", () => {
  const mount = APP.slice(APP.indexOf("<SaleRateManager"), APP.indexOf("<SaleRateManager") + 2000);
  assert.match(mount, /axios\.get\(`\$\{API_URL\}\/inventory`\)/);
  assert.match(mount, /runSyncNow\(\{ force: true \}\)/);
});

test("rows and confirmation lines are keyed by row, never by product (two lots of one product)", () => {
  assert.match(managerSource, /<tr key=\{row\.key\}>/);
  assert.match(managerSource, /<tr key=\{change\.key\}>/);
  assert.doesNotMatch(managerSource, /key=\{update\.product_id\}/);
});

test("the screen has one Save, a labelled target margin, and no second title", () => {
  assert.equal((managerSource.match(/onClick=\{requestSave\}/g) || []).length, 1);
  assert.match(managerSource, /<Field label="Target margin on cost %">/);
  assert.doesNotMatch(managerSource, /title="Sale Rate Update"|Daily Sale Rate Update/);
  assert.doesNotMatch(managerSource, /Select All Suggested Rates|Pending Bill Stock|Updated By/);
});

test("two lots of one product are two changes with their own keys", () => {
  const rows = buildSaleRateRows(apiRows);
  const { changes } = collectSaleRateChanges(rows, { 11: "170", 12: "185" });
  assert.deepEqual(changes.map((change) => change.key), ["11", "12"]);
  assert.deepEqual(buildBulkRatePayload(changes).map((entry) => entry.inventory_batch_id), [11, 12]);
});

test("a row whose current rate is unknown still takes a typed rate", () => {
  const [row] = buildSaleRateRows([{ id: 5, product_id: 5, inventory_batch_id: null, product_name: "Kiwi", selling_rate: null, latest_effective_cost: "70" }]);
  assert.equal(row.currentRate, null);
  assert.equal(row.currentMargin, null);
  const [change] = collectSaleRateChanges([row], { 5: "90" }).changes;
  assert.equal(change.oldRate, null);
  assert.equal(change.newRate, 90);
  assert.equal(marginOnCost(90, row.cost), 28.6);
});
