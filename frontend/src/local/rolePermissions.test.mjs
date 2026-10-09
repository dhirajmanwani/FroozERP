import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  OWNER_ONLY_VIEWS,
  accountMasterTypeOptions,
  allowedPaymentAction,
  branchesScreenPlan,
  mayReadReports,
  canEditAccountRow,
  canManagePendingPurchaseBills,
  defaultAccountMasterType,
  resolveAccountPermissions,
  resolveModuleAccess,
  roleGrants,
} from "./rolePermissions.js";

const modulePermissionMap = {
  dashboard: "dashboard", products: "inventory", purchase: "purchases", "pending-bills": "billing",
  accounts: "supplier_accounts", sales: "billing", reports: "reports", settings: "settings",
};
const defaults = {
  Owner: { all: true },
  Admin: { all: true },
  Cashier: { sales: true, accounts: true, "pending-bills": true },
  "Purchase Manager": { purchase: true, "pending-bills": true, accounts: true, reports: true },
};
const access = (role, view, permissions = null) => resolveModuleAccess({
  view, role, permissions, defaultPermissions: defaults[role] || {}, modulePermissionMap,
});

test("a stored false wins over a built-in default: unticking a screen hides it", () => {
  assert.equal(access("Cashier", "sales", { billing: false }), false, "Cashier's default `sales: true` used to win");
  assert.equal(access("Admin", "purchase", { purchases: false }), false, "Admin's `all: true` used to win");
  assert.equal(access("Admin", "purchase", { purchases: true }), true);
});

test("a key the stored map leaves undefined falls back to the built-in default", () => {
  assert.equal(access("Cashier", "sales", {}), true);
  assert.equal(access("Cashier", "sales", null), true);
  assert.equal(access("Inventory Manager", "sales", {}), false);
  assert.equal(access("Admin", "distribution", { purchases: true }), true, "no key: Admin's all");
});

test("Owner sees everything; All Shops is Owner only", () => {
  assert.equal(access("Owner", "settings", { settings: false }), true);
  for (const view of OWNER_ONLY_VIEWS) {
    assert.equal(access("Owner", view), true);
    assert.equal(access("Admin", view), false, `${view} is refused for Admin by the server`);
  }
});

test("Branches & Counters: Owner gets everything, Admin only the screen lock and no scope read", () => {
  assert.equal(access("Owner", "branches"), true);
  assert.equal(access("Admin", "branches"), true, "Admin resets a forgotten counter exit code here");
  assert.equal(access("Cashier", "branches"), false);
  const owner = branchesScreenPlan("Owner");
  assert.equal(owner.readsScope, true);
  assert.equal(owner.showsSection("branches/shops"), true);
  const admin = branchesScreenPlan("Admin");
  assert.equal(admin.readsScope, false, "the scope read is Owner-only on the server; asking just gets a 403");
  assert.equal(admin.showsSection("branches/screen-lock"), true);
  for (const section of ["branches/shops", "branches/counters", "branches/staff", "branches/computers", "branches/activation-licences"]) {
    assert.equal(admin.showsSection(section), false, section);
  }
  assert.equal(branchesScreenPlan("Cashier").open, false);
});

test("dashboard: stored key decides, else Admin only", () => {
  assert.equal(access("Cashier", "dashboard", { dashboard: true }), true);
  assert.equal(access("Admin", "dashboard", { dashboard: false }), false);
  assert.equal(access("Admin", "dashboard", {}), true);
  assert.equal(access("Cashier", "dashboard", {}), false);
});

test("Accounts opens on any money key; Pending Bills on billing or purchases", () => {
  assert.equal(access("Cashier", "accounts", { customer_payments: true, supplier_payments: false, supplier_accounts: false }), true);
  assert.equal(access("Cashier", "accounts", { customer_payments: false, supplier_payments: false, supplier_accounts: false }), false);
  // The seeded Purchase Manager row has billing:false and purchases:true; Pending Bills stays open.
  assert.equal(access("Purchase Manager", "pending-bills", { billing: false, purchases: true }), true);
  assert.equal(access("Purchase Manager", "pending-bills", { billing: false, purchases: false }), false);
});

test("roleGrants mirrors the server's getPermissionUser", () => {
  assert.equal(roleGrants({ role: "Owner", permissions: { customer_payments: false }, key: "customer_payments" }), true);
  assert.equal(roleGrants({ role: "Cashier", permissions: { customer_payments: true }, key: "customer_payments" }), true);
  assert.equal(roleGrants({ role: "Admin", permissions: { customer_payments: false }, key: "customer_payments" }), false);
  assert.equal(roleGrants({ role: "Admin", permissions: {}, key: "customer_accounts" }), true, "undefined key: default roles");
  assert.equal(roleGrants({ role: "Cashier", permissions: {}, key: "customer_payments" }), false);
});

test("payment and account permissions come from the map, not the role name", () => {
  const cashierWithoutPayments = resolveAccountPermissions({ role: "Cashier", permissions: { customer_payments: false } });
  assert.equal(cashierWithoutPayments.customerPayments, false);
  const storeKeeper = resolveAccountPermissions({ role: "Store Keeper", permissions: { supplier_payments: true } });
  assert.equal(storeKeeper.supplierPayments, true, "a custom role granted the key may pay suppliers");
});

test("pending purchase bills are managed by Owner and Admin only", () => {
  assert.equal(canManagePendingPurchaseBills("Owner"), true);
  assert.equal(canManagePendingPurchaseBills("admin"), true);
  assert.equal(canManagePendingPurchaseBills("Purchase Manager"), false);
});

test("Account Master without customer_accounts starts on Supplier and cannot edit customers", () => {
  const types = [["CUSTOMER", "Customer"], ["SUPPLIER", "Supplier"], ["STAFF", "Staff"]];
  const supplierOnly = { customerAccounts: false, supplierAccounts: true };
  assert.deepEqual(accountMasterTypeOptions(types, supplierOnly).map(([value]) => value), ["SUPPLIER", "STAFF"]);
  assert.equal(defaultAccountMasterType(types, supplierOnly), "SUPPLIER");
  assert.equal(defaultAccountMasterType(types, { customerAccounts: true, supplierAccounts: true }), "CUSTOMER");
  assert.equal(canEditAccountRow({ account_type: "CUSTOMER" }, supplierOnly), false);
  assert.equal(canEditAccountRow({ account_type: "SUPPLIER" }, supplierOnly), true);
  assert.equal(canEditAccountRow({ account_type: "SUPPLIER", system_account: true }, supplierOnly), false);
});

test("Report Center data is not asked for without the Reports permission", () => {
  assert.equal(mayReadReports({ role: "Owner", permissions: { reports: false } }), true);
  assert.equal(mayReadReports({ role: "Admin", permissions: { reports: false } }), true, "the server allows Admin always");
  assert.equal(mayReadReports({ role: "Cashier", permissions: { reports: false } }), false);
  assert.equal(mayReadReports({ role: "Cashier", permissions: {} }), false);
  assert.equal(mayReadReports({ role: "Purchase Manager", permissions: { reports: true } }), true);
  assert.equal(mayReadReports({ role: "Cashier", permissions: undefined }), true, "map not loaded yet: ask, the server decides");
});

test("a held payment action the role may not use moves to the first one it may", () => {
  const both = { customerPayments: true, supplierPayments: true };
  assert.equal(allowedPaymentAction("PAY_SUPPLIER", both), "PAY_SUPPLIER");
  assert.equal(allowedPaymentAction("RECEIVE_CUSTOMER", { customerPayments: false, supplierPayments: true }), "PAY_SUPPLIER");
  assert.equal(allowedPaymentAction("PAY_SUPPLIER", { customerPayments: true, supplierPayments: false }), "RECEIVE_CUSTOMER");
  assert.equal(allowedPaymentAction("", { supplierPayments: true }), "PAY_SUPPLIER");
  assert.equal(allowedPaymentAction("RECEIVE_CUSTOMER", {}), null, "nothing allowed: no action is invented");
  assert.equal(allowedPaymentAction("RECEIVE_CUSTOMER", { customerPayments: "true" }), null, "only a real grant counts");

  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const at = app.indexOf("const next = allowedPaymentAction(payment.payment_action");
  assert.ok(at > 0);
  const effect = app.slice(app.lastIndexOf("useEffect(() => {", at), app.indexOf("]);", at) + 3);
  assert.match(effect, /if \(next && next !== payment\.payment_action\)/);
  assert.match(effect, /\[canUseCustomerPayments, canUseSupplierPayments, payment\.payment_action\]/);
});
