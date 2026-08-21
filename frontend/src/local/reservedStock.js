/**
 * What the counter may sell, once orders have taken their share.
 *
 * The maintainer ruled on 2026-08-21 that accepting an order reserves stock so it cannot be sold
 * twice. This is the half of that ruling that faces the counter: without it the reservation is a
 * note in another screen, and the fruit gets sold anyway.
 *
 * ## Why this is per product and not per lot
 *
 * An order is taken against a product — "10kg apples" — long before anyone decides which crate it
 * comes out of. A lot is only assigned at packing. So a reservation cannot be subtracted from any
 * particular lot's balance without inventing a fact, and inventing it would put the shortfall on
 * whichever crate happened to sort first.
 *
 * The check therefore sits one level up: the *product* total the counter is about to sell below.
 * POS keeps its own per-lot arithmetic untouched, which matters because that arithmetic is
 * money-critical and this is not the change to disturb it with.
 */

import { reservedQuantityByProduct } from "./orderLifecycle.js";
import { canonicalInventoryId } from "./stockInventory.js";

export const COUNTER_STOCK = Object.freeze({
  FREE: "FREE",
  EATS_RESERVED: "EATS_RESERVED",
  OVERSOLD: "OVERSOLD",
});

const qty = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const format = (value) => Number(value).toLocaleString("en-IN", { maximumFractionDigits: 3 });

/**
 * Reserved quantities, keyed the way the rest of the app keys products.
 *
 * `canonicalInventoryId` on both sides, always. CLAUDE.md records that comparing a raw id against a
 * canonical one silently emptied the Inventory table — the same mistake here would quietly report
 * every product as unreserved, which is the failure that looks like everything working.
 */
export const buildReservedIndex = (orders = [], nowMs = Date.now()) => {
  const raw = reservedQuantityByProduct(orders, nowMs);
  const index = new Map();
  for (const [productId, quantity] of raw) {
    const key = canonicalInventoryId(productId);
    if (!key) continue;
    index.set(key, (index.get(key) || 0) + qty(quantity));
  }
  return index;
};

export const reservedForProduct = (index, productId) =>
  (index instanceof Map ? index.get(canonicalInventoryId(productId)) : 0) || 0;

/**
 * May the counter sell this much of this product?
 *
 * Returns a decision plus a sentence that names the number. "Not enough stock" sends an operator
 * to count crates; "6 kg of this is promised to orders" tells them what is actually happening and
 * lets them decide whether to ring the customer.
 */
export const describeCounterStock = ({ onHand = 0, reserved = 0, requested = 0, unit = "" } = {}) => {
  const stock = qty(onHand);
  const held = qty(reserved);
  const want = qty(requested);
  const free = stock - held;
  const suffix = unit ? ` ${unit}` : "";

  if (held <= 0) return { status: COUNTER_STOCK.FREE, free: stock, reserved: 0, message: "" };
  if (free < 0) {
    // Already promised more than is on the shelf. This is not a counter problem to solve at the
    // till, and it must never present as a plain "out of stock" — somebody has to ring a customer.
    return {
      status: COUNTER_STOCK.OVERSOLD,
      free: 0,
      reserved: held,
      message: `Orders have promised ${format(held)}${suffix} of this but only ${format(stock)}${suffix} is on hand. Check the Orders screen before selling any.`,
    };
  }
  if (want > free) {
    return {
      status: COUNTER_STOCK.EATS_RESERVED,
      free,
      reserved: held,
      message: `Only ${format(free)}${suffix} is free to sell. ${format(held)}${suffix} is set aside for orders that have not gone out yet.`,
    };
  }
  return {
    status: COUNTER_STOCK.FREE,
    free,
    reserved: held,
    message: `${format(held)}${suffix} of this is set aside for orders.`,
  };
};

/** A short note for a product row, or "" when nothing is reserved. */
export const reservedNote = (index, productId, unit = "") => {
  const held = reservedForProduct(index, productId);
  if (held <= 0) return "";
  return `${format(held)}${unit ? ` ${unit}` : ""} promised to orders`;
};
