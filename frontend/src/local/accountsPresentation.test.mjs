import test from "node:test";
import assert from "node:assert/strict";

import { findSaleCustomer, overpaymentWarning, paymentBalancePreview, resolveOutstandingPresentation } from "./accountsPresentation.js";

test("outstanding: not loaded, failed and empty-bundle are never zero", () => {
  assert.equal(resolveOutstandingPresentation(null).kind, "loading");
  const failed = resolveOutstandingPresentation({ totalReceivable: 0, totalPayable: 0 }, "Network Error");
  assert.equal(failed.kind, "error");
  assert.match(failed.message, /Network Error/);
  assert.equal(resolveOutstandingPresentation({}).kind, "unavailable", "an empty offline bundle is not ₹0");
});

test("outstanding: a real answer, zeros included, is shown", () => {
  const ready = resolveOutstandingPresentation({ totalReceivable: 0, totalPayable: "125.5", customerOutstanding: [{}] });
  assert.equal(ready.kind, "ready");
  assert.equal(ready.totalReceivable, 0);
  assert.equal(ready.totalPayable, 125.5);
  assert.equal(ready.customerOutstanding.length, 1);
  assert.deepEqual(ready.supplierOutstanding, []);
});

test("payment preview is signed and warns on overpayment", () => {
  const normal = paymentBalancePreview({ outstandingBefore: 1000, payment: 400, rebate: 100 });
  assert.equal(normal.after, 500);
  assert.equal(normal.overpaid, false);
  assert.equal(overpaymentWarning(normal), "");
  const over = paymentBalancePreview({ outstandingBefore: 1000, payment: "1200.10" });
  assert.equal(over.after, -200.1, "used to clamp to 0");
  assert.equal(over.overpaid, true);
  assert.equal(over.excess, 200.1);
  assert.match(overpaymentWarning(over), /₹200\.10 more than this customer owes/);
  assert.match(overpaymentWarning(over, { supplier: true }), /supplier/);
});

test("ledger lookup: id first, then mobile, then name, never Number()", () => {
  const customers = [
    { id: "4", customer_name: "Ravi", mobile_number: "999" },
    { id: "004", customer_name: "Ravi Kumar", mobile_number: "888" },
    { id: "9", customer_name: "Walk-in Customer", system_account: true },
  ];
  assert.equal(findSaleCustomer(customers, { customer_id: "004", customer_name: "Ravi" }).id, "004",
    "a namesake earlier in the list must not win over the id, and \"004\" is not 4");
  assert.equal(findSaleCustomer(customers, { customer_mobile: "888", customer_name: "Ravi" }).id, "004");
  assert.equal(findSaleCustomer(customers, { customer_name: " ravi " }).id, "4");
  assert.equal(findSaleCustomer(customers, { customer_name: "Walk-in" }).id, "9");
  assert.equal(findSaleCustomer(customers, { customer_id: "77" }), null);
});
