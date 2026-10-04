/**
 * Purchase rows as `GET /purchases` sends them: one row per purchase item, each carrying its
 * bill's header fields (4 Oct 2026).
 *
 * A bill from the purchase cart holds several items. Screens that count bills or act on a bill
 * have to group the rows by bill first: counting rows counted every fruit as its own bill, and the
 * bill's net was shown again on every fruit's row.
 *
 * Edit and Complete Bill still work on one item only, so the server refuses them for a bill with
 * several items (`PURCHASE_MULTI_ITEM_CHANGE_UNSUPPORTED`). `purchaseChangeBlock` says so before
 * the button is pressed. Cancel covers every item and is always offered.
 */

import { canonicalInventoryId } from "./stockInventory.js";

const billKey = (row) => canonicalInventoryId(row?.id);

/** How many item rows each bill has, by canonical bill id. */
export const purchaseItemCounts = (rows = []) => {
  const counts = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = billKey(row);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
};

/**
 * The rows grouped into bills, in the order their first row appears. Each bill is the first row's
 * header fields plus `items` (every row of that bill) and `itemCount`.
 */
export const groupPurchaseBills = (rows = []) => {
  const bills = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = billKey(row);
    if (!key) continue;
    const bill = bills.get(key);
    if (bill) {
      bill.items.push(row);
      bill.itemCount += 1;
    } else {
      bills.set(key, { ...row, key, items: [row], itemCount: 1 });
    }
  }
  return [...bills.values()];
};

/** The plain reason Edit or Complete Bill cannot be used on this bill, or "" when it can. */
export const purchaseChangeBlock = (itemCount) => {
  const count = Number(itemCount);
  if (!Number.isFinite(count) || count <= 1) return "";
  return `This bill has ${count} fruits. Edit and Complete Bill work on one fruit only for now. Cancel the bill and enter it again to change it.`;
};

/**
 * The net to show on one item row. A one-item bill shows the bill's net as before. On a bill with
 * several items the bill's net would be repeated on every row, so the row shows its own item's net
 * when the server sent one, and nothing (null) when it did not -- never the whole bill's figure.
 */
export const purchaseRowNet = (row, itemCount) => {
  if (Number(itemCount) > 1) {
    // A pending arrival's items are stored with a net of 0 until the bill comes; 0 is not a price.
    if (row?.purchase_bill_status === "BILL_PENDING") return null;
    const itemNet = Number(row?.item_net_payable);
    return row?.item_net_payable !== null && row?.item_net_payable !== undefined && Number.isFinite(itemNet) ? itemNet : null;
  }
  // Unchanged for a one-item bill, including falling back to total_amount when net is 0.
  const net = Number(row?.net_payable || row?.total_amount || 0);
  return Number.isFinite(net) ? net : 0;
};

/**
 * The expected rate of one pending item. Each item row carries its own `purchase_rate` (the
 * expected rate it arrived at), while `expected_purchase_rate` is the bill header's average over
 * every item -- so a 2-fruit arrival at ₹40 and ₹100 showed both fruits "@ ₹60". The header
 * average is used only when the item has no rate of its own.
 */
export const pendingItemRate = (row) => {
  const itemRate = Number(row?.purchase_rate);
  if (row?.purchase_rate !== null && row?.purchase_rate !== undefined && row?.purchase_rate !== "" && Number.isFinite(itemRate) && itemRate > 0) return itemRate;
  const expected = Number(row?.expected_purchase_rate);
  return Number.isFinite(expected) ? expected : 0;
};
