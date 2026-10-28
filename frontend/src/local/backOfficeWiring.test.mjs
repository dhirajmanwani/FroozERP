import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { paginateLots } from "./stockInventory.js";

const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
const between = (start, end) => {
  const from = app.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const to = app.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing ${end}`);
  return app.slice(from, to);
};

test("the Lot View pages say how many they show, and print or export carries every lot (BO-6)", () => {
  const rows = Array.from({ length: 80 }, (_, index) => ({ id: `lot-${index}` }));
  assert.deepEqual({ ...paginateLots(rows, 50), shown: paginateLots(rows, 50).shown.length }, { shown: 50, total: 80, truncated: true });
  assert.equal(paginateLots(rows, 0).shown.length, 80, "All");
  assert.equal(paginateLots(rows, 0).truncated, false);
  assert.equal(paginateLots(rows, 100).truncated, false);
  assert.equal(paginateLots(null, 50).total, 0);
  const report = between("export function StockInventoryReport(", "function ");
  assert.match(report, /const lotPage = paginateLots\(filteredLots, exportingReport \? 0 : pageSize\);/);
  assert.match(report, /Showing \$\{lotPage\.shown\.length\} of \$\{lotPage\.total\} lots/);
  assert.match(report, /<option value="0">All<\/option>/);
  assert.match(app, /<ReportExportContext\.Provider value=\{printTarget\}>\{children\}<\/ReportExportContext\.Provider>/);
});

test("the Inventory Adjustments tile is not 0 when the audit read failed (BO-11)", () => {
  assert.match(app, /label="Inventory Adjustments" value=\{auditUnavailableMessage \? "Local only" : auditLoading \? "Loading" : auditError \? MISSING_VALUE : adjustmentCount\}/);
});

test("Product Master hands Add, Deactivate, categories and sale price only to the Owner and Admins (BO-4)", () => {
  const products = between('{activeView === "products" && (', '{lotPanelProduct && (');
  assert.match(products, /actions=\{canManageRates \? <button className="primary-button" onClick=\{startNewProduct\}/);
  assert.match(products, /productActiveNow && canManageRates && <button className="danger-text-button" onClick=\{\(\) => deactivateProduct\(product\)\}/);
  assert.match(products, /\{canManageRates \? \(\s*<div className="pm-row-actions">\s*<button className="table-action" onClick=\{\(\) => editProductCategory\(category\)\}/);
  assert.match(products, /\{canManageRates && \(\s*<div className="pm-inline-form">/);
  assert.match(products, /readOnly=\{!canManageRates\}/);
  assert.match(products, /\(canManageRates \|\| Boolean\(editingProductId\)\) && \(/);
});

test("deleting a user is asked first, in this screen, by name (BO-7)", () => {
  const users = between("function UserManagementSection(", "Updating without anybody standing at the machine.");
  assert.doesNotMatch(users, /onClick=\{\(\) => userAction\(item, "delete"\)\}/, "one click used to delete");
  assert.match(users, /onClick=\{\(\) => setDeleteTarget\(\{ item, saving: false \}\)\}/);
  assert.match(users, /Delete \$\{deleteTarget\.item\.full_name \|\| deleteTarget\.item\.username\}\?/);
  assert.match(users, /onClick=\{\(\) => userAction\(deleteTarget\.item, "delete"\)\}/);
  assert.doesNotMatch(users, /window\.confirm/);
});

test("Dashboard quick access lists only what the role may open, and Stock Inventory opens inventory (BO-12)", () => {
  assert.match(app, /\["reports", "Stock Inventory", "reports\/inventory"\]\]\.filter\(\(\[view\]\) => hasModuleAccess\(view\)\)/);
  assert.match(app, /navigate\(view\); if \(section\) setPendingSection\(section\);/);
});

test("purchase ids are compared as opaque strings, never Number() (BO-16)", () => {
  assert.doesNotMatch(app, /Number\(purchase\.id\)/);
  assert.equal((app.match(/purchases\.find\(\(purchase\) => inventoryIdsEqual\(purchase\.id, editingPurchaseId\)\)/g) || []).length, 2);
});

test("Frooz Pack movements name a bill by its invoice number (BO-18)", () => {
  assert.match(app, /Bill \$\{row\.invoice_no \|\| row\.sale_id\}/);
});
