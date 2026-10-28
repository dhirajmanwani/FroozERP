import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { checkoutFingerprint, heldApprovalFor, resolveCheckoutRef } from "./checkoutRetry.js";

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
  assert.match(app, /const billFingerprint = checkoutFingerprint\(\{/);
  assert.match(app, /resolveCheckoutRef\(pendingCheckoutRef\.current, billFingerprint, newSyncId\("op"\)\)/);
  const post = app.indexOf("await axios.post(`${API_URL}/api/v3/sales`");
  assert.ok(post > 0);
  assert.match(app.slice(post, post + 300), /pendingCheckoutRef\.current = null;/);
});

test("a cart billed as a combo is a different bill from the same lines billed loose", () => {
  const line = { product_id: "p", inventory_batch_id: "1", quantity: 1, selling_rate: 10, discount_amount: 0 };
  assert.notEqual(
    checkoutFingerprint({ cart: [line] }),
    checkoutFingerprint({ cart: [{ ...line, combo_line_key: "K", combo_id: "combo-1" }] }),
  );
});

test("an approval is reused for the unchanged bill after \"Not yet\", and never for a changed one", () => {
  const fingerprint = checkoutFingerprint(bill);
  const held = { fingerprint, approvalId: "appr-1", saleRef: "op-9" };
  assert.deepEqual(heldApprovalFor(held, checkoutFingerprint({ ...bill })), { approvalId: "appr-1", saleRef: "op-9" });
  assert.equal(heldApprovalFor(held, checkoutFingerprint({ ...bill, cart: [{ ...bill.cart[0], discount_amount: 20 }] })), null);
  assert.equal(heldApprovalFor(null, fingerprint), null);
  assert.equal(heldApprovalFor({ fingerprint, approvalId: "", saleRef: "op-9" }, fingerprint), null);
});

test("POS holds the approval in a ref, reuses it with its own reference, and drops it on save or refusal", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /const heldApprovalRef = useRef\(null\);/);
  assert.match(app, /heldApprovalFor\(heldApprovalRef\.current, billFingerprint\)/);
  assert.match(app, /let saleRef = String\(confirmations\.sale_ref \|\| heldApproval\?\.saleRef \|\| ""\)\.trim\(\);/);
  assert.ok((app.match(/heldApprovalRef\.current = null;/g) || []).length >= 3, "cleared after both saves and on a refused approval");
  assert.match(app, />\{draft\.saving \? "Checking\.\.\." : "Approve"\}</, "the button no longer promises a save");
});
