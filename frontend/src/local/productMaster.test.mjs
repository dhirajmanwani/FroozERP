import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MISSING_VALUE,
  filterProductMasterList,
  finiteOrNull,
  formatOptionalCount,
  formatOptionalMoney,
  formatOptionalQuantity,
  isLowStock,
  lotListEmptyMessage,
  lotPanelMatchesEdit,
  pickQuantity,
  pickRate,
  productCountSummary,
  productInCategory,
  productListEmptyMessage,
  unitDisplayName,
} from "./productMaster.js";

const currency = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" });

test("a missing number is missing, and a real zero is still zero", () => {
  for (const missing of [null, undefined, "", "   ", "abc", NaN, Infinity, true, false]) {
    assert.equal(finiteOrNull(missing), null, `${String(missing)} is not a number the row holds`);
  }
  assert.equal(finiteOrNull(0), 0);
  assert.equal(finiteOrNull("0"), 0);
  assert.equal(finiteOrNull("12.5"), 12.5);
  assert.equal(finiteOrNull(-3), -3);
});

test("money shows as the INR figure, or as a dash when the row does not carry it -- never ₹0.00 or ₹NaN", () => {
  assert.equal(formatOptionalMoney(null, currency), MISSING_VALUE);
  assert.equal(formatOptionalMoney(undefined, currency), MISSING_VALUE);
  assert.equal(formatOptionalMoney("", currency), MISSING_VALUE);
  assert.equal(formatOptionalMoney("not a rate", currency), MISSING_VALUE);
  assert.equal(formatOptionalMoney(0, currency), currency.format(0));
  assert.equal(formatOptionalMoney("80", currency), currency.format(80));
  assert.equal(formatOptionalMoney(80.456, currency), currency.format(80.456));
  assert.match(formatOptionalMoney(80.456, currency), /80\.46/);
});

test("quantities carry three decimals; counts are whole; both dash when missing", () => {
  assert.equal(formatOptionalQuantity(null), MISSING_VALUE);
  assert.equal(formatOptionalQuantity(""), MISSING_VALUE);
  assert.equal(formatOptionalQuantity(0), "0.000");
  assert.equal(formatOptionalQuantity("12.5"), "12.500");
  assert.equal(formatOptionalQuantity(1234.5678), "1,234.568");
  assert.equal(formatOptionalCount(undefined), MISSING_VALUE);
  assert.equal(formatOptionalCount(0), "0");
  assert.equal(formatOptionalCount("7"), "7");
});

test("rates keep the screen's old choice for positive values and only differ where the old one invented a zero", () => {
  // purchase_rate || effective_cost_per_unit
  assert.equal(pickRate(40, 42), 40);
  assert.equal(pickRate(0, 42), 42, "a zero first field still falls through, as `||` did");
  assert.equal(pickRate("", "42"), 42);
  assert.equal(pickRate(0, null), 0, "a real zero with nothing better is shown as zero");
  assert.equal(pickRate(null, undefined), null, "nothing at all is missing, not zero");
  assert.equal(pickRate("abc"), null);
});

test("quantities pick the first field that really holds a number, zero included", () => {
  // balance_qty ?? remaining_qty
  assert.equal(pickQuantity(0, 5), 0, "a sold-out lot is 0, not the other field");
  assert.equal(pickQuantity(null, 5), 5);
  assert.equal(pickQuantity("", 5), 5);
  assert.equal(pickQuantity(null, undefined), null);
});

test("units read as words on screen and keep their stored value", () => {
  assert.equal(unitDisplayName("KG"), "Kg");
  assert.equal(unitDisplayName("box"), "Box");
  assert.equal(unitDisplayName("PIECE"), "Piece");
  assert.equal(unitDisplayName("DOZEN"), "Dozen");
  assert.equal(unitDisplayName("CRATE"), "CRATE");
  assert.equal(unitDisplayName(""), MISSING_VALUE);
  assert.equal(unitDisplayName(null), MISSING_VALUE);
});

test("low stock needs both numbers: unknown stock is not called low", () => {
  assert.equal(isLowStock({ current_stock: 2, minimum_stock: 5 }), true);
  assert.equal(isLowStock({ current_stock: 5, minimum_stock: 5 }), true, "at the level counts, as the stock reports do");
  assert.equal(isLowStock({ current_stock: 0, minimum_stock: 0 }), true);
  assert.equal(isLowStock({ current_stock: 6, minimum_stock: 5 }), false);
  assert.equal(isLowStock({ current_stock: null, minimum_stock: 5 }), false);
  assert.equal(isLowStock({ current_stock: 1, minimum_stock: null }), false);
  assert.equal(isLowStock({}), false);
});

const mango = { id: 1, product_name: "Kesar", category_id: 10, category_name: "Mango", active: true, barcode: "8901", unit: "KG", selling_rate: 120 };
const apple = { id: "product-2", product_name: "Shimla", category_id: "cat-apple", category_name: "Apple", active: true, unit: "BOX" };
const legacy = { id: 3, product_name: "Alphonso", category: "Mango", active: false, unit: "DOZEN" };
const orphan = { id: "004", product_name: "Loose", active: true, unit: "PIECE" };
const products = [mango, apple, legacy, orphan];

test("status filter: Active by default, Inactive, All", () => {
  assert.deepEqual(filterProductMasterList(products).map((p) => p.id), [1, "product-2", "004"]);
  assert.deepEqual(filterProductMasterList(products, { status: "inactive" }).map((p) => p.id), [3]);
  assert.equal(filterProductMasterList(products, { status: "all" }).length, 4);
});

test("category filter compares ids as opaque strings and falls back to the name", () => {
  const mangoCategory = { id: "10", category_name: "Mango" };
  assert.equal(productInCategory(mango, mangoCategory), true, "10 and \"10\" are the same id string");
  assert.equal(productInCategory(legacy, mangoCategory), true, "a legacy row with only the name");
  assert.equal(productInCategory(apple, mangoCategory), false);
  assert.equal(productInCategory({ id: 9, category_id: "010", category_name: "" }, mangoCategory), false, "\"010\" is not 10");
  assert.equal(productInCategory(orphan, null), true, "no category chosen shows everything");
  assert.deepEqual(filterProductMasterList(products, { status: "all", category: mangoCategory }).map((p) => p.id), [1, 3]);
});

test("search finds what it found before, plus the unit's display word", () => {
  assert.deepEqual(filterProductMasterList(products, { search: "8901" }).map((p) => p.id), [1]);
  assert.deepEqual(filterProductMasterList(products, { search: "apple" }).map((p) => p.id), ["product-2"]);
  assert.deepEqual(filterProductMasterList(products, { search: "dozen", status: "all" }).map((p) => p.id), [3]);
  assert.deepEqual(filterProductMasterList(products, { search: "  KESAR " }).map((p) => p.id), [1]);
  assert.deepEqual(filterProductMasterList(null), []);
});

test("the empty products table says why it is empty", () => {
  assert.equal(productListEmptyMessage({ totalCount: 0, search: "" }), "No products yet. Add your first product.");
  assert.equal(productListEmptyMessage({ totalCount: 4, search: " kiwi " }), "No products match \"kiwi\".");
  assert.equal(productListEmptyMessage({ totalCount: 0, search: "kiwi" }), "No products match \"kiwi\".");
  assert.equal(productListEmptyMessage({ totalCount: 4, search: "", filtered: true }), "No products match the chosen category and status.");
});

test("the empty lots table says why it is empty", () => {
  assert.equal(lotListEmptyMessage({ totalCount: 0 }), "This product has no stock lots yet.");
  assert.equal(lotListEmptyMessage({ totalCount: 3, search: "A1" }), "No lots match \"A1\".");
  assert.match(lotListEmptyMessage({ totalCount: 3, showSoldOut: false }), /Show sold-out lots/);
});

test("the Products tile counts from the same active rule as the table's default filter", () => {
  const summary = productCountSummary(products);
  assert.deepEqual(summary, { active: 3, total: 4, note: "3 active of 4" });
  assert.equal(summary.active, filterProductMasterList(products).length);
  assert.deepEqual(productCountSummary(undefined), { active: 0, total: 0, note: "0 active of 0" });
});

test("a new lot is offered only on the lots card of the product being edited, if any", () => {
  const deviceMango = { id: "product-1", product_name: "Kesar" };
  const cloudMango = { id: 1, global_id: "product-1", product_name: "Kesar" };
  assert.equal(lotPanelMatchesEdit({ lotPanelProduct: null }), false);
  assert.equal(lotPanelMatchesEdit({ lotPanelProduct: apple }), true, "nothing being edited: the card's own product");
  assert.equal(lotPanelMatchesEdit({ editingProductId: 1, editingProductKeys: ["1", "product-1"], lotPanelProduct: deviceMango }), true);
  assert.equal(lotPanelMatchesEdit({ editingProductId: 1, editingProductKeys: [], lotPanelProduct: cloudMango }), true);
  assert.equal(lotPanelMatchesEdit({ editingProductId: 1, editingProductKeys: ["1", "product-1"], lotPanelProduct: apple }), false,
    "editing Kesar with Shimla's lots open: the lot would be written to Kesar");
  assert.equal(lotPanelMatchesEdit({ editingProductId: "004", editingProductKeys: [], lotPanelProduct: { id: 4 } }), false, "\"004\" is not 4");
});

test("Product Master renders missing values as a dash and says why its tables are empty", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const start = app.indexOf('{activeView === "products" && (');
  const end = app.indexOf('{activeView === "purchase" && (');
  assert.ok(start > 0 && end > start, "the Product Master view is where it was");
  const view = app.slice(start, end);

  assert.match(app, /from "\.\/local\/productMaster"/);
  assert.match(view, /productListEmptyMessage\(\{ totalCount: products\.length, search: productListSearch/);
  assert.match(view, /lotListEmptyMessage\(\{ totalCount: productLots\.length/);
  assert.doesNotMatch(view, /No matching items found/);

  // The zero and NaN fallbacks the audit found must not come back.
  assert.doesNotMatch(view, /minimum_stock \|\| 0/);
  assert.doesNotMatch(view, /current_stock \|\| 0/);
  assert.doesNotMatch(view, /lot_count \|\| 0/);
  assert.doesNotMatch(view, /item_count \|\| 0/);
  assert.doesNotMatch(view, /currency\.format\(Number\(/);
  assert.match(view, /formatOptionalMoney\(product\.selling_rate, currency\)/);
  assert.match(view, /formatOptionalQuantity\(product\.current_stock\)/);
  assert.match(view, /formatOptionalCount\(category\.item_count\)/);

  // One vocabulary: products, never items; no 34px icon square holding text.
  assert.doesNotMatch(view, />[^<{]*\bItems?\b[^<]*</);
  assert.doesNotMatch(view, /className="remove-button"/);
  assert.doesNotMatch(view, /className="cart-empty"/);
  assert.match(view, /className="pm-notice"/);

  // The form keeps its id and the lots card is its own card after it.
  assert.ok(view.indexOf('<ModuleCard id="product-item-form"') < view.indexOf('<ModuleCard id="product-lots-card"'));
});

test("the new danger text button and the item table have styles; .remove-button is untouched", () => {
  const css = readFileSync(new URL("../App.css", import.meta.url), "utf8");
  assert.match(css, /\n\.danger-text-button \{/);
  assert.match(css, /\n\.product-entry-item-table table \{/);
  assert.match(css, /\n\.remove-button \{\n  display: grid;\n  place-items: center;\n  width: 34px;\n  height: 34px;/);
});
