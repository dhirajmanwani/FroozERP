const rows = (value) => Array.isArray(value) ? value : [];

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
    && Number(lot?.remaining_qty ?? lot?.balance_qty ?? 0) > 0
    && !["CANCELLED", "INACTIVE"].includes(String(lot?.batch_status || lot?.status || "ACTIVE").toUpperCase())
  ));
};
