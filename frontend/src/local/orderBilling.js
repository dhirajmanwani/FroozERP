/**
 * Turning a sent order into a bill, without inventing a second way to take money.
 *
 * The maintainer ruled on 2026-08-21 that sending an order creates its bill. The tempting reading is
 * "write a sale straight from the order rows", and it is wrong: POS already owns lot allocation,
 * discounts, mandi tax, payment mode, the customer record and printing. A second path that wrote
 * sales without those would be a second set of rules about money, and the one nobody exercises
 * daily is the one that quietly gets it wrong.
 *
 * So this builds a **cart seed** instead. Sending hands the operator a POS screen already filled in
 * from the order at the rates the customer was quoted; they confirm payment and save through the
 * path that has always been used. One button for them, one billing path for the code.
 *
 * ## What it must refuse to guess
 *
 * An order is taken against a product; a lot is only chosen when it is billed. Allocation here is
 * oldest-lot-first, which is what the shop does with produce anyway. Where it cannot allocate — the
 * product is gone, or the stock is no longer there — it produces a **problem**, never a short line.
 * Silently billing 6kg of an 8kg order would under-charge the customer and leave the order looking
 * complete, which is worse than refusing.
 */

import { canonicalInventoryId } from "./stockInventory.js";

export const ORDER_BILLING_PROBLEM = Object.freeze({
  PRODUCT_GONE: "PRODUCT_GONE",
  NOT_ENOUGH_STOCK: "NOT_ENOUGH_STOCK",
  NO_LINES: "NO_LINES",
});

const qty = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const format = (value) => Number(value).toLocaleString("en-IN", { maximumFractionDigits: 3 });

/**
 * Lots that can actually be sold, oldest first.
 *
 * Oldest-first because that is what a produce shop does with the crates and what the rest of this
 * app already assumes. Sorting is by purchase date then creation, with id as the final tiebreak so
 * the order is stable — an unstable sort here would allocate differently on each render and make a
 * bug in this function impossible to reproduce.
 */
const sellableLotsFor = (lots, productId) =>
  (Array.isArray(lots) ? lots : [])
    .filter((lot) => canonicalInventoryId(lot?.product_id) === canonicalInventoryId(productId))
    .filter((lot) => qty(lot?.remaining_qty ?? lot?.balance_qty) > 0)
    .sort((left, right) => String(left.purchase_date || left.created_at || "").localeCompare(String(right.purchase_date || right.created_at || ""))
      || String(left.id).localeCompare(String(right.id)));

/**
 * Cart lines for one order, plus everything that stopped it being complete.
 *
 * @returns {{lines: Array, problems: Array<{code: string, message: string}>, complete: boolean}}
 */
export const buildOrderCartSeed = (order, { products = [], lots = [] } = {}) => {
  const orderLines = Array.isArray(order?.items) ? order.items : [];
  if (orderLines.length === 0) {
    return {
      lines: [],
      problems: [{ code: ORDER_BILLING_PROBLEM.NO_LINES, message: "This order has no items to bill." }],
      complete: false,
    };
  }

  const lines = [];
  const problems = [];
  // Allocation is cumulative across the whole order: two lines for the same product must not both
  // be told the same crate is available, or the seed would promise more than exists and the
  // shortfall would only appear when POS refused the second one.
  const taken = new Map();

  for (const orderLine of orderLines) {
    const productId = orderLine?.product_id;
    const product = products.find((candidate) => canonicalInventoryId(candidate.id) === canonicalInventoryId(productId));
    if (!product) {
      problems.push({
        code: ORDER_BILLING_PROBLEM.PRODUCT_GONE,
        message: `${orderLine?.product_name || "An item"} on this order is no longer in the product list. Add it back, or cancel and re-take the order.`,
      });
      continue;
    }

    let outstanding = qty(orderLine?.quantity);
    const rate = Number(orderLine?.agreed_rate);
    for (const lot of sellableLotsFor(lots, productId)) {
      if (outstanding <= 0) break;
      const already = taken.get(String(lot.id)) || 0;
      const free = qty(lot.remaining_qty ?? lot.balance_qty) - already;
      if (free <= 0) continue;
      const use = Math.min(free, outstanding);
      taken.set(String(lot.id), already + use);
      outstanding -= use;
      lines.push({
        product_id: String(product.id),
        product_name: product.product_name,
        inventory_batch_id: lot.id,
        lot_name: lot.lot_name || lot.batch_no || "",
        unit: lot.unit || product.unit || "",
        quantity: use,
        // The rate the customer was quoted when the order was taken, not today's board rate.
        // Produce rates move daily and this is the number the shop promised.
        selling_rate: Number.isFinite(rate) && rate > 0 ? rate : Number(product.selling_rate || 0),
      });
    }

    if (outstanding > 0) {
      problems.push({
        code: ORDER_BILLING_PROBLEM.NOT_ENOUGH_STOCK,
        message: `${format(outstanding)} ${product.unit || ""} of ${product.product_name} is short. The stock held for this order may have been sold while it was waiting.`.replace(/\s+/g, " "),
      });
    }
  }

  return { lines, problems, complete: problems.length === 0 && lines.length > 0 };
};

/** One sentence for the operator, or "" when the seed is complete. */
export const describeOrderBillingProblems = ({ problems = [] } = {}) => {
  if (problems.length === 0) return "";
  if (problems.length === 1) return problems[0].message;
  return `${problems.length} problems with this order: ${problems.map((problem) => problem.message).join(" ")}`;
};
