import { counterMaySell, filterLotsForScope, resolveScopedLots } from "./locationScope.js";
import { canonicalInventoryId, inventoryIdsEqual } from "./stockInventory.js";

const rows = (value) => Array.isArray(value) ? value : [];
const blockedStatuses = new Set(["CANCELLED", "INACTIVE", "EXPIRED", "RESERVED", "BLOCKED", "EXHAUSTED"]);

export const lotAvailableQuantity = (lot, now = new Date()) => {
  const status = String(lot?.batch_status || lot?.status || "ACTIVE").trim().toUpperCase();
  if (blockedStatuses.has(status) || lot?.deleted_at) return 0;
  const expiryValue = lot?.expiry_date || lot?.expires_at || lot?.best_before;
  const expiryTime = expiryValue ? new Date(expiryValue).getTime() : Number.NaN;
  const expiryProhibited = lot?.allow_expired_sale !== true && lot?.sell_after_expiry !== true;
  if (expiryProhibited && Number.isFinite(expiryTime) && expiryTime < now.getTime()) return 0;
  const balance = Number(lot?.remaining_qty ?? lot?.balance_qty ?? 0);
  const reserved = Math.max(Number(lot?.reserved_qty ?? lot?.reserved_quantity ?? 0), 0);
  return Math.max(balance - reserved, 0);
};

export const isSellableLot = (lot, now = new Date()) => lotAvailableQuantity(lot, now) > 0;

/**
 * How much of this product this counter may sell.
 *
 * `scope` is optional and defaults to "no scope supplied", which reproduces the pre-scope behaviour
 * exactly — every caller that has not been given a counter scope yet sees what it saw before.
 * When a scope is supplied, another shop's crates are gone before the arithmetic starts, because a
 * quantity is the thing a cashier acts on and a total that silently includes Main Branch's 20 kg is
 * the wrong-shop sale in numeric form.
 *
 * A number cannot express "this device does not know which shop it is in": an unknown scope admits
 * no lots, so this returns 0. That 0 must never reach a screen on its own — `resolveSellableProducts`
 * is the call that carries the named state, and POS should render from that.
 *
 * The product match is `inventoryIdsEqual`, the same canonical comparison `stockInventory.js` and
 * `reservedStock.js` use, so the scope filter and the product join speak one convention. Mixing
 * `String(id)` on one side with `canonicalInventoryId` on the other is the mismatch CLAUDE.md
 * records as having silently emptied the Inventory table while every summary tile stayed correct.
 */
export const productAvailableQuantity = (productId, inventoryLots, now = new Date(), scope = null) => (
  filterLotsForScope(rows(inventoryLots), scope)
    .filter((lot) => inventoryIdsEqual(lot?.product_id, productId))
    .reduce((total, lot) => total + lotAvailableQuantity(lot, now), 0)
);

/** Products with stock on *this* counter's shelf. An unknown scope yields none — see below. */
export const filterSellableProducts = (products, inventoryLots, now = new Date(), scope = null) => {
  // Filtered once here rather than per product, so every product in one call is judged against the
  // same set of lots. Summary and detail disagreeing is the failure this avoids at POS scale too.
  const scoped = filterLotsForScope(rows(inventoryLots), scope);
  return rows(products).filter((product) => (
    product?.active !== false
    && !product?.deleted_at
    && productAvailableQuantity(product?.id, scoped, now) > 0
  ));
};

export const mergeLocalFirstRows = (localRows, remoteRows, key = "id") => {
  const local = rows(localRows);
  const remote = rows(remoteRows);
  if (!local.length) return remote;
  if (!remote.length) return local;
  const merged = new Map(remote.map((row) => [String(row?.[key] ?? ""), row]));
  for (const row of local) merged.set(String(row?.[key] ?? ""), row);
  return [...merged.values()];
};

/**
 * The POS working set, merged local-first and narrowed to the counter's own shelf.
 *
 * Products are *not* filtered by scope: the catalogue is the company's, and a product with no stock
 * here is a legitimate "0 available" rather than a row that belongs to somebody else. Only lots
 * carry a place, so only lots are filtered — and because `filterSellableProducts` decides
 * sellability from lots, a product whose only stock sits in another shop drops out anyway.
 *
 * The `scope*` fields are additive; existing callers destructuring `products` and `inventoryLots`
 * are unaffected. `scopeUsable === false` means the lot list is empty because the question could
 * not be answered, not because the shelf is empty, and rendering it as "0 in stock" is the bug this
 * whole path exists to prevent.
 */
export const selectLocalPosInventory = (snapshot, current = {}, scope = null) => {
  const resolution = resolveScopedLots(
    mergeLocalFirstRows(snapshot?.inventory_lots, current.inventoryLots),
    scope,
  );
  return {
    products: mergeLocalFirstRows(snapshot?.products, current.products),
    inventoryLots: resolution.lots,
    scopeStatus: resolution.status,
    scopeUsable: counterMaySell(resolution),
    scopeMessage: resolution.message,
    scopeCounts: resolution.counts,
  };
};

/**
 * What POS should actually render: the sellable list, or a reason there is no list.
 *
 * `filterSellableProducts` returns an array, and an array has only one way to say "nothing" — which
 * is precisely the collapse this module must not make. A counter that has not been told which shop
 * it is in has no sellable list *and no zero to report*; it has a sentence for the operator and a
 * `countLabel` of "Unavailable". Same shape as `resolveInventoryPresentation` in `stockInventory.js`
 * so the two screens cannot drift into describing the same condition differently.
 */
export const resolveSellableProducts = ({ products, inventoryLots, now = new Date(), scope = null } = {}) => {
  const resolution = resolveScopedLots(inventoryLots, scope);
  if (!counterMaySell(resolution)) {
    return {
      status: resolution.status,
      usable: false,
      products: [],
      countLabel: "Unavailable",
      message: resolution.message,
      counts: resolution.counts,
    };
  }
  const sellable = filterSellableProducts(products, resolution.lots, now);
  return {
    status: resolution.status,
    usable: true,
    products: sellable,
    countLabel: String(sellable.length),
    message: resolution.message,
    counts: resolution.counts,
  };
};

/**
 * Is there anything on this device this counter could sell?
 *
 * With a scope supplied, "anything" means anything on its own shelf: a device holding nothing but
 * another shop's crates has nothing to sell, and an unknown scope may sell nothing at all. Callers
 * that need to tell those two apart must ask `resolveSellableProducts`, which names them.
 */
export const hasSellableLocalInventory = ({ products, inventoryLots }, scope = null) => {
  const activeProducts = new Set(
    rows(products)
      .filter((product) => product?.active !== false)
      .map((product) => canonicalInventoryId(product?.id))
      .filter(Boolean),
  );
  return filterLotsForScope(rows(inventoryLots), scope).some((lot) => (
    activeProducts.has(canonicalInventoryId(lot?.product_id))
    && isSellableLot(lot)
  ));
};
