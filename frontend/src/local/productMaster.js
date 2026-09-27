import { canonicalInventoryId, inventoryIdsEqual } from "./stockInventory.js";
import { isSameProduct, productIdentityKeys } from "./productIdentity.js";

/**
 * Presentation rules for the Product Master screen.
 *
 * The screen used to print `product.minimum_stock || 0`, `lot.purchase_rate || 0` and
 * `currency.format(Number(product.selling_rate))`, so a value the list simply did not carry showed
 * up as "0", "₹0.00" or "₹NaN" -- indistinguishable from a real zero, and a real zero is a business
 * fact (a lot sold out, an alert set at nothing). Here a missing value is "—" and a real 0 stays 0.
 */

export const MISSING_VALUE = "—";

// A number the field really holds, or null. `Number("")` and `Number(null)` are 0, so blanks are
// caught before the conversion rather than after it.
export const finiteOrNull = (value) => {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
};

/**
 * The rate to show when a row carries two fields for it (cost: `purchase_rate` then
 * `effective_cost_per_unit`; sale: `temporary_sale_rate` then `selling_rate`).
 *
 * The screen chose between them with `||`, which passes over a 0 to the next field. That choice is
 * kept for positive values, so the figure shown does not change for any row that has one; only when
 * no field is positive does a real 0 win over "missing".
 */
export const pickRate = (...values) => {
  const numbers = values.map(finiteOrNull);
  const positive = numbers.find((number) => number !== null && number > 0);
  if (positive !== undefined) return positive;
  const present = numbers.find((number) => number !== null);
  return present === undefined ? null : present;
};

// First field that holds a number, 0 included -- the `??` choice, made on numbers rather than on
// "not null", so "" or "abc" falls through instead of rendering as 0 or NaN.
export const pickQuantity = (...values) => {
  const present = values.map(finiteOrNull).find((number) => number !== null);
  return present === undefined ? null : present;
};

export const formatOptionalMoney = (value, formatter) => {
  const number = finiteOrNull(value);
  return number === null ? MISSING_VALUE : formatter.format(number);
};

// Quantities carry three decimals everywhere in the ERP; shown with all three so a column lines up.
export const formatOptionalQuantity = (value) => {
  const number = finiteOrNull(value);
  return number === null
    ? MISSING_VALUE
    : number.toLocaleString("en-IN", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
};

// Counts (lots, products in a category) are whole numbers.
export const formatOptionalCount = (value) => {
  const number = finiteOrNull(value);
  return number === null ? MISSING_VALUE : number.toLocaleString("en-IN", { maximumFractionDigits: 0 });
};

export const PRODUCT_UNITS = [
  ["KG", "Kg"],
  ["BOX", "Box"],
  ["PIECE", "Piece"],
  ["DOZEN", "Dozen"],
];

// The stored value stays as it is ("KG"); this is only the word on screen.
export const unitDisplayName = (unit) => {
  const raw = String(unit ?? "").trim();
  if (!raw) return MISSING_VALUE;
  const known = PRODUCT_UNITS.find(([value]) => value === raw.toUpperCase());
  return known ? known[1] : raw;
};

// The rule the stock reports use (`current_stock <= minimum_stock`), but only when both numbers are
// really there: a product the list sent without a stock figure is not "low", it is unknown.
export const isLowStock = (product) => {
  const stock = finiteOrNull(product?.current_stock);
  const minimum = finiteOrNull(product?.minimum_stock);
  return stock !== null && minimum !== null && stock <= minimum;
};

export const isActiveRecord = (record) => record?.active !== false;

const normalizedText = (value) => String(value ?? "").trim().toLowerCase();

export const productCategoryLabel = (product) => (
  String(product?.category_name || product?.category || "").trim()
);

/**
 * Does the product sit in this category?
 *
 * By id when the product carries one (compared as opaque strings, never `Number()`-ed), and by name
 * as well, because a legacy row can carry only the category's name, and the device snapshot and the
 * cloud list number categories differently. Category names are unique (the save refuses a
 * duplicate), so a name match cannot pick up a different category.
 */
export const productInCategory = (product, category) => {
  if (!category) return true;
  if (canonicalInventoryId(product?.category_id) !== "" && inventoryIdsEqual(product.category_id, category.id)) return true;
  const wanted = normalizedText(category.category_name);
  return wanted !== "" && normalizedText(productCategoryLabel(product)) === wanted;
};

export const PRODUCT_STATUS_FILTERS = [
  ["active", "Active"],
  ["inactive", "Inactive"],
  ["all", "All"],
];

const matchesStatus = (product, status) => {
  if (status === "active") return isActiveRecord(product);
  if (status === "inactive") return !isActiveRecord(product);
  return true;
};

// Same fields the list searched before, so a search that found a product still finds it.
const matchesSearch = (product, searchText) => {
  if (!searchText) return true;
  return [
    product.product_name,
    product.category_name,
    product.category,
    product.barcode,
    product.origin_type,
    product.selling_rate,
    isActiveRecord(product) ? "active" : "inactive",
    product.unit,
    unitDisplayName(product.unit),
  ].some((value) => String(value ?? "").toLowerCase().includes(searchText));
};

/**
 * The products table's rows. The header tiles count from the same `products` array with the same
 * `isActiveRecord` test, so the table and the tiles cannot disagree about what "active" means.
 */
export const filterProductMasterList = (products, { search = "", category = null, status = "active" } = {}) => {
  const searchText = String(search ?? "").trim().toLowerCase();
  return (Array.isArray(products) ? products : []).filter((product) => (
    matchesStatus(product, status)
    && productInCategory(product, category)
    && matchesSearch(product, searchText)
  ));
};

/**
 * What the empty products table says. "No matching items found." used to cover every case, so an
 * owner with no products yet was told their search had failed.
 */
export const productListEmptyMessage = ({ totalCount = 0, search = "", filtered = false } = {}) => {
  const searchText = String(search ?? "").trim();
  if (searchText) return `No products match "${searchText}".`;
  if (!totalCount) return "No products yet. Add your first product.";
  if (filtered) return "No products match the chosen category and status.";
  return "No products to show.";
};

export const lotListEmptyMessage = ({ totalCount = 0, search = "", showSoldOut = false } = {}) => {
  const searchText = String(search ?? "").trim();
  if (!totalCount) return "This product has no stock lots yet.";
  if (searchText) return `No lots match "${searchText}".`;
  if (!showSoldOut) return "No lots in stock. Tick \"Show sold-out lots\" to see the rest.";
  return "No lots to show.";
};

export const productCountSummary = (products) => {
  const list = Array.isArray(products) ? products : [];
  const active = list.filter(isActiveRecord).length;
  return { active, total: list.length, note: `${active} active of ${list.length}` };
};

/**
 * May "Add stock lot" save to the lots card that is open?
 *
 * The new-lot save sends to the product being edited when there is one, and to the open lots card
 * only when there is not. Open product B's lots while editing product A and the lot would be written
 * to A while the owner is looking at B. Until the edit is finished or cancelled the card does not
 * offer the button.
 */
export const lotPanelMatchesEdit = ({ editingProductId = null, editingProductKeys = [], lotPanelProduct = null } = {}) => {
  if (!lotPanelProduct) return false;
  if (canonicalInventoryId(editingProductId) === "") return true;
  const keys = Array.isArray(editingProductKeys) && editingProductKeys.length > 0
    ? editingProductKeys
    : productIdentityKeys({ id: editingProductId });
  return isSameProduct(lotPanelProduct, keys);
};
