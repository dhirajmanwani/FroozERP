import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  findPurchaseSupplier,
  findSaleCustomer,
  overpaymentWarning,
  paymentBalancePreview,
  resolveOutstandingPresentation,
  supplierLedgerKey,
} from "./accountsPresentation.js";

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

test("an empty outstanding bundle says unavailable, never loading forever", () => {
  assert.equal(resolveOutstandingPresentation({}).kind, "unavailable");
  assert.equal(resolveOutstandingPresentation({ totalReceivable: 10 }).kind, "unavailable");
  assert.equal(resolveOutstandingPresentation(null).kind, "loading");
  assert.equal(resolveOutstandingPresentation({ totalReceivable: 0, totalPayable: 0 }).kind, "ready", "zero is a real balance");
  assert.equal(resolveOutstandingPresentation({ totalReceivable: 0, totalPayable: 0 }, "502").kind, "error");

  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  // The snapshot path hands over `{}` rather than leaving null (which reads as "Loading…"), and a
  // good bundle clears an error left by an earlier failed server read.
  assert.match(app, /setAccountOutstanding\(bundle\.offlineAccountOutstanding \|\| \{\}\);\n\s+if \(resolveOutstandingPresentation\(bundle\.offlineAccountOutstanding\)\.kind === "ready"\) setAccountOutstandingError\(""\);/);
  const loader = app.slice(app.indexOf("const loadAccountOutstanding = async"), app.indexOf("const loadAccountOutstanding = async") + 500);
  assert.match(loader, /setAccountOutstanding\(response\.data\);\n\s+setAccountOutstandingError\(""\);/);
});

test("a purchase finds its supplier by canonical id first, then by name, never by Number()", () => {
  const suppliers = [
    { id: 4, global_id: "supplier-4", supplier_name: "Ravi Traders" },
    { id: "004", supplier_name: "Padded" },
    { id: 12, global_id: "supplier-12", supplier_name: "Mandi Co" },
  ];
  assert.equal(findPurchaseSupplier(suppliers, { supplier_id: "004", supplier_name: "Ravi Traders" }).supplier_name, "Padded",
    "\"004\" is not 4, and the id beats a name match");
  assert.equal(findPurchaseSupplier(suppliers, { supplier_id: "supplier-12" }).id, 12, "a snapshot global id finds the row");
  assert.equal(findPurchaseSupplier(suppliers, { supplier_id: "4" }).id, 4);
  assert.equal(findPurchaseSupplier(suppliers, { supplier_id: "", supplier_name: " mandi co " }).id, 12);
  assert.equal(findPurchaseSupplier(suppliers, { supplier_id: "99" }), null);
  assert.equal(findPurchaseSupplier(null, { supplier_id: 4 }), null);

  assert.equal(supplierLedgerKey(suppliers, { supplier_id: "supplier-12" }), "SUPPLIER-12", "the key uses the server row id");
  assert.equal(supplierLedgerKey(suppliers, { supplier_id: "004" }), "SUPPLIER-004");
  assert.equal(supplierLedgerKey([], { supplier_id: 7 }), "SUPPLIER-7", "a plain server id still works without the list");
  assert.equal(supplierLedgerKey([], { supplier_id: "supplier-7" }), "", "a global id is not guessed into a key");
  assert.equal(supplierLedgerKey([], { supplier_id: "007" }), "", "a padded id is not turned into 7");
  assert.equal(supplierLedgerKey([], { supplier_id: 0 }), "");
  assert.equal(supplierLedgerKey([], {}), "");

  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const opener = app.slice(app.indexOf("const openSupplierLedgerFromReport = async"), app.indexOf("const openCustomerLedgerFromReport = async"));
  assert.doesNotMatch(opener.replace(/\/\/.*$/gm, ""), /Number\(/);
  assert.match(opener, /supplierLedgerKey\(suppliers, purchase\)/);
  assert.match(opener, /!isLocalOnlyConnectivitySelected\(\)/, "Local Only never asks the server for the list");
});
