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

export const productAvailableQuantity = (productId, inventoryLots, now = new Date()) => rows(inventoryLots)
  .filter((lot) => String(lot?.product_id) === String(productId))
  .reduce((total, lot) => total + lotAvailableQuantity(lot, now), 0);

export const filterSellableProducts = (products, inventoryLots, now = new Date()) => rows(products).filter((product) => (
  product?.active !== false
  && !product?.deleted_at
  && productAvailableQuantity(product?.id, inventoryLots, now) > 0
));

export const mergeLocalFirstRows = (localRows, remoteRows, key = "id") => {
  const local = rows(localRows);
  const remote = rows(remoteRows);
  if (!local.length) return remote;
  if (!remote.length) return local;
  const merged = new Map(remote.map((row) => [String(row?.[key] ?? ""), row]));
  for (const row of local) merged.set(String(row?.[key] ?? ""), row);
  return [...merged.values()];
};

export const selectLocalPosInventory = (snapshot, current = {}) => ({
  products: mergeLocalFirstRows(snapshot?.products, current.products),
  inventoryLots: mergeLocalFirstRows(snapshot?.inventory_lots, current.inventoryLots),
});

export const hasSellableLocalInventory = ({ products, inventoryLots }) => {
  const activeProducts = new Set(rows(products).filter((product) => product?.active !== false).map((product) => String(product.id)));
  return rows(inventoryLots).some((lot) => (
    activeProducts.has(String(lot?.product_id))
    && isSellableLot(lot)
  ));
};
