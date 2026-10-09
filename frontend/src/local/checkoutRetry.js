/**
 * The browser checkout's idempotency key across a retry.
 *
 * In the browser POS a bill is saved by one request carrying an idempotency key (`sale_ref`). If
 * the reply is lost — the request reached the server and the bill was saved, but the answer never
 * came back — the cashier presses checkout again. That second press used to mint a new key, so the
 * server saw a new bill and billed the customer twice.
 *
 * The rule, the same one `SaleReturnModule.pendingWrite` keeps: a checkout of an unchanged cart
 * reuses the key of the attempt that did not finish; any change to the cart, customer, payments,
 * date or charges is a different bill and gets a fresh key. The key is dropped once a save is
 * confirmed.
 */

const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((out, key) => {
      if (value[key] !== undefined) out[key] = stable(value[key]);
      return out;
    }, {});
  }
  return value;
};

/** A fingerprint of what is being billed. Equal fingerprints are the same bill. */
export const checkoutFingerprint = ({ cart = [], customer = {}, payments = [], billDate = "", billDateTime = "", charges = [], billDiscount = null } = {}) => JSON.stringify(stable({
  cart: (Array.isArray(cart) ? cart : []).map((item) => ({
    product_id: String(item?.product_id ?? ""),
    inventory_batch_id: String(item?.inventory_batch_id ?? ""),
    quantity: String(item?.quantity ?? ""),
    selling_rate: String(item?.selling_rate ?? ""),
    discount_amount: String(item?.discount_amount ?? ""),
  })),
  customer,
  payments,
  billDate,
  billDateTime,
  charges,
  billDiscount,
}));

/**
 * The key for this attempt. Reuses the pending key when the fingerprint is unchanged; otherwise
 * takes `freshRef`. Returns the key and the pending record to keep until the save is confirmed.
 */
export const resolveCheckoutRef = (pending, fingerprint, freshRef) => {
  if (pending && pending.fingerprint === fingerprint && String(pending.ref || "").trim()) {
    return { ref: pending.ref, pending, reused: true };
  }
  const next = { fingerprint, ref: freshRef };
  return { ref: freshRef, pending: next, reused: false };
};
