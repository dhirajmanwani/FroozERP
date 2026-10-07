import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { checkoutFingerprint, resolveCheckoutRef } from "./checkoutRetry.js";

const bill = {
  cart: [{ product_id: "p1", inventory_batch_id: "l1", quantity: "2", selling_rate: "80", discount_amount: 0 }],
  customer: { name: "Asha", mobile: "999" },
  payments: [{ mode: "CASH", amount: 160 }],
  billDate: "2026-10-07",
};

test("a retry of an unchanged cart reuses the key; any change mints a new one", () => {
  const first = resolveCheckoutRef(null, checkoutFingerprint(bill), "op-1");
  assert.equal(first.ref, "op-1");
  const retry = resolveCheckoutRef(first.pending, checkoutFingerprint({ ...bill, customer: { mobile: "999", name: "Asha" } }), "op-2");
  assert.equal(retry.ref, "op-1", "key order does not make a different bill");
  assert.equal(retry.reused, true);
  const changed = resolveCheckoutRef(first.pending, checkoutFingerprint({ ...bill, payments: [{ mode: "UPI", amount: 160 }] }), "op-3");
  assert.equal(changed.ref, "op-3");
  assert.equal(changed.reused, false);
});

test("the browser checkout keeps the key until the save is confirmed", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /const pendingCheckoutRef = useRef\(null\);/);
  assert.match(app, /resolveCheckoutRef\(pendingCheckoutRef\.current, checkoutFingerprint\(\{/);
  const post = app.indexOf("await axios.post(`${API_URL}/api/v3/sales`");
  assert.ok(post > 0);
  assert.match(app.slice(post, post + 300), /pendingCheckoutRef\.current = null;/);
});
