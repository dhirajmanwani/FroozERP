/**
 * Which product a stock lot belongs to, for the Waste screen's "Stock" figure, and the product id
 * a waste entry is sent with.
 *
 * A product and its lots can each carry either form of id. The cloud list has the server's numeric
 * id beside a `global_id` ("product-12"); the device's SQLite snapshot carries only the global id,
 * and carries it as `id` — and a lot's `product_id` is whichever form its own loader had. Keyed on
 * one form only, the Waste dropdown showed "Stock 0" for a product whose lots named it the other
 * way, and the save sent `Number("product-12")`, which is NaN.
 */
import { canonicalInventoryId } from "./stockInventory.js";
import { productIdentityKeys } from "./productIdentity.js";

/**
 * A function from a lot to the canonical id of the product row it belongs to (that row's own
 * `id`), or "" when no listed product claims it. Matched through every identity the product row
 * is known by, so "12", "product-12" and the snapshot's global id all land on the same row.
 */
export const productStockKeyResolver = (products = []) => {
  const index = new Map();
  for (const product of Array.isArray(products) ? products : []) {
    const own = canonicalInventoryId(product?.id);
    if (!own) continue;
    for (const key of productIdentityKeys(product)) {
      if (!index.has(key)) index.set(key, own);
    }
  }
  return (lot) => {
    for (const value of [lot?.product_id, lot?.product_global_id]) {
      const key = canonicalInventoryId(value);
      if (key && index.has(key)) return index.get(key);
    }
    return "";
  };
};

/** The waste entry's product id: exactly the id picked, as an opaque string. Never `Number()`. */
export const wasteEntryProductId = (value) => canonicalInventoryId(value);
