/**
 * Purchase rows as `GET /purchases` sends them: one row per purchase item, each carrying its
 * bill's header fields (4 Oct 2026).
 *
 * A bill from the purchase cart holds several items. Screens that count bills or act on a bill
 * have to group the rows by bill first: counting rows counted every fruit as its own bill, and the
 * bill's net was shown again on every fruit's row.
 *
 * Edit still works on one item only, so the server refuses it for a bill with several items
 * (`PURCHASE_MULTI_ITEM_CHANGE_UNSUPPORTED`). `purchaseChangeBlock` says so before the button is
 * pressed. Complete Bill takes a final rate for every fruit (`pendingCompletionLines` and the
 * helpers after it), and Cancel covers every item; both are always offered.
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

/** The plain reason Edit cannot be used on this bill, or "" when it can. */
export const purchaseChangeBlock = (itemCount) => {
  const count = Number(itemCount);
  if (!Number.isFinite(count) || count <= 1) return "";
  return `This bill has ${count} fruits. Edit works on one fruit only for now. Cancel the bill and enter it again to change it.`;
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

const finiteNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/**
 * One editable line per fruit for completing a pending arrival with several fruits, from that
 * bill's rows as `GET /purchases` sends them. The final rate starts at the rate the fruit arrived
 * at, as the one-fruit Complete Bill does.
 *
 * Returns `{ lines }`, or `{ error }` when a row has no `purchase_item_id` (a server older than
 * this screen): without it the server cannot tell the fruits apart, and guessing would price the
 * wrong one.
 */
export const pendingCompletionLines = (rows = []) => {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return { error: "This arrival's fruits could not be read. Reload Pending Bills and try again." };
  const lines = [];
  for (const row of list) {
    if (row?.purchase_item_id === null || row?.purchase_item_id === undefined || row?.purchase_item_id === "") {
      return { error: "This arrival's fruits could not be told apart, so it cannot be completed from here yet. Reload Pending Bills and try again; if it repeats, the server needs updating." };
    }
    const expectedRate = pendingItemRate(row);
    lines.push({
      purchase_item_id: row.purchase_item_id,
      product_id: row.product_id,
      product_name: row.product_name || "Fruit",
      unit: row.unit || "",
      origin_type: row.item_origin_type || row.origin_type || "LOCAL",
      lot_name: row.item_lot_name || row.lot_name || "",
      lot_size: row.item_lot_size || row.lot_size || "",
      quantity: String(row.quantity ?? ""),
      expected_rate: expectedRate,
      purchase_rate: expectedRate > 0 ? String(expectedRate) : "",
    });
  }
  return { lines };
};

/** The first thing stopping these lines from being saved, in plain words, or "". */
export const completionLinesProblem = (lines = []) => {
  if (!Array.isArray(lines) || lines.length === 0) return "This arrival has no fruits to complete.";
  for (const line of lines) {
    const quantity = finiteNumber(line?.quantity);
    if (quantity === null || quantity <= 0) return `Please enter quantity for ${line?.product_name || "every fruit"}`;
    const rate = finiteNumber(line?.purchase_rate);
    if (rate === null || rate <= 0) return `Please enter final purchase rate for ${line?.product_name || "every fruit"}`;
  }
  return "";
};

/** The `items` the complete-bill route takes: one per fruit, named by its purchase item id. */
export const completionLinesPayload = (lines = []) => (Array.isArray(lines) ? lines : []).map((line) => ({
  purchase_item_id: line.purchase_item_id,
  quantity: line.quantity,
  purchase_rate: line.purchase_rate,
  lot_name: line.lot_name,
  lot_size: line.lot_size,
}));

/**
 * The money one Purchase History row stands for.
 *
 * A one-item bill's row is the bill, so it keeps the bill's figures exactly as before. On a bill
 * with several items every row carries the whole bill's header, so summing rows counted the bill
 * once per fruit. Such a row now shows its own item's gross, charges, rebate and net, and a share
 * of what was paid in proportion to its net, so the rows of one bill add up to that bill.
 */
export const purchaseHistoryAmounts = (row, itemCount) => {
  const amount = (value) => finiteNumber(value) ?? 0;
  if (!(Number(itemCount) > 1)) {
    const charges = amount(row?.mandi_tax_amount) + amount(row?.freight_charges) + amount(row?.labour_charges) + amount(row?.other_charges);
    const basic = amount(row?.item_basic_amount) || amount(row?.quantity) * amount(row?.purchase_rate || row?.expected_purchase_rate);
    return {
      gross: amount(row?.gross_amount) || basic + charges,
      charges,
      rebate: amount(row?.rebate_amount),
      net: Number(row?.net_payable || row?.item_net_payable || 0) || 0,
      paid: amount(row?.paid_amount),
      balance: amount(row?.balance_amount),
    };
  }
  const charges = amount(row?.item_mandi_tax_amount) + amount(row?.item_freight_charges) + amount(row?.item_labour_charges) + amount(row?.item_other_charges);
  const basic = amount(row?.item_basic_amount) || amount(row?.quantity) * amount(row?.purchase_rate);
  const net = amount(row?.item_net_payable);
  const billNet = amount(row?.net_payable);
  const share = billNet > 0 ? net / billNet : 0;
  const paid = amount(row?.paid_amount) * share;
  return {
    gross: basic + charges,
    charges,
    rebate: amount(row?.item_rebate_amount),
    net,
    paid,
    balance: amount(row?.balance_amount) * share,
  };
};
