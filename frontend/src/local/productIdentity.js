import { canonicalInventoryId, inventoryIdsEqual } from "./stockInventory.js";

/**
 * Which product the Item form is editing, whichever list the row came from.
 *
 * Product Master reads the shared `products` state, and that state is written by two kinds of
 * loader. The cloud list carries the server's numeric `id` beside a `global_id`
 * ("product-276"). The device's SQLite snapshot carries only the global id, and carries it as
 * `id`. Either can be on screen when Edit is pressed, and the other can replace it before Save.
 *
 * On 25 Sep 2026 that made every edit say "This product already exists.": the duplicate-name
 * check compared `Number(product.id)` with `Number(editingProductId)`, `Number("product-276")` is
 * NaN, NaN never equals NaN, so the product being edited was reported as its own duplicate. And had
 * it got past that, the v3 routes take only the numeric id and would have refused "product-276".
 */

// A server row id: a positive integer written in digits. Never `Number()` an id to decide this --
// "004" and 4 are different entities.
export const isServerProductId = (value) => /^[1-9]\d*$/.test(canonicalInventoryId(value));

// Every id a product row is known by. Held at Edit time so that Save still recognises the row
// after the list under it has been swapped for the other form.
export const productIdentityKeys = (product) => {
  const keys = [product?.id, product?.global_id, product?.product_global_id]
    .map(canonicalInventoryId)
    .filter(Boolean);
  return [...new Set(keys)];
};

export const isSameProduct = (product, keys) => {
  const wanted = Array.isArray(keys) ? keys : [];
  return productIdentityKeys(product).some((key) => wanted.some((other) => inventoryIdsEqual(key, other)));
};

const normalizedName = (value) => String(value ?? "").trim().toLowerCase();

/**
 * Another active product already using this name, or null.
 *
 * Mirrors the server's own check (`LOWER(product_name)`, other id, `active IS DISTINCT FROM
 * FALSE`), so the form refuses exactly what the server would and nothing more. An inactive
 * product's name is free to reuse there, so it is here.
 */
export const findDuplicateProductName = (products, name, editingKeys = []) => {
  const wanted = normalizedName(name);
  if (!wanted) return null;
  return (Array.isArray(products) ? products : []).find((product) => (
    product?.active !== false
    && normalizedName(product?.product_name) === wanted
    && !isSameProduct(product, editingKeys)
  )) || null;
};

export const PRODUCT_NOT_IN_CLOUD_MESSAGE =
  "This item has not reached the cloud yet, so it cannot be changed from here. Wait for sync to finish, then try again.";

/**
 * The numeric id the v3 product routes need, for a product known by `keys`.
 *
 * Uses a server id among the keys when there is one. Otherwise finds the row in the cloud list
 * whose id or global id matches. No match is an answer in words, never a guessed id.
 */
export const resolveServerProductId = (keys, cloudProducts = []) => {
  const known = Array.isArray(keys) ? keys : [];
  const direct = known.find(isServerProductId);
  if (direct) return { ok: true, id: canonicalInventoryId(direct) };
  const match = (Array.isArray(cloudProducts) ? cloudProducts : []).find((product) => (
    isServerProductId(product?.id) && isSameProduct(product, known)
  ));
  if (match) return { ok: true, id: canonicalInventoryId(match.id) };
  return { ok: false, message: PRODUCT_NOT_IN_CLOUD_MESSAGE };
};

// The global id among the keys, for photos, which are indexed by both forms.
export const productGlobalIdFrom = (keys, products = []) => {
  const known = Array.isArray(keys) ? keys : [];
  const row = (Array.isArray(products) ? products : []).find((product) => isSameProduct(product, known));
  const fromRow = canonicalInventoryId(row?.global_id);
  if (fromRow) return fromRow;
  return known.map(canonicalInventoryId).find((key) => key && !isServerProductId(key)) || null;
};
