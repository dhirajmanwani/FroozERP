import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { expenseRecordStatus, expenseTotalExcludingCancelled } from "./expenses.js";

const appSource = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
const expensesModule = appSource.slice(
  appSource.indexOf("function ExpensesModule("),
  appSource.indexOf("function AccountsModule("),
);

test("a row stored inactive reads Cancelled, as every report treats it", () => {
  assert.equal(expenseRecordStatus({ status: "ACTIVE", active: false }), "CANCELLED", "it used to say Active while missing from the P&L");
  assert.equal(expenseRecordStatus({ status: "CANCELLED", active: true }), "CANCELLED");
  assert.equal(expenseRecordStatus({ status: "ACTIVE", active: true }), "ACTIVE");
  assert.equal(expenseRecordStatus({}), "ACTIVE");
});

test("the total counts exactly the rows the register calls Active", () => {
  const rows = [
    { amount: "2000", status: "ACTIVE" },
    { amount: 500.255, status: "ACTIVE", active: true },
    { amount: 900, status: "ACTIVE", active: false },
    { amount: 100, status: "CANCELLED" },
    { amount: "", status: "ACTIVE" },
  ];
  assert.equal(expenseTotalExcludingCancelled(rows), 2500.26);
  assert.equal(expenseTotalExcludingCancelled(null), 0);
});

test("the expense form has no Active box; the register's status and total share one rule", () => {
  assert.ok(expensesModule.length > 0);
  assert.doesNotMatch(expensesModule, /draft\.active/, "an unticked Active box saved expenses no report counts");
  assert.doesNotMatch(expensesModule, /active: (true|expense\.active)/);
  assert.match(expensesModule, /const status = expenseRecordStatus\(expense\);/);
  assert.match(expensesModule, /expenseTotalExcludingCancelled\(filteredExpenses\)/);
});

test("a failed Expenses or Waste load is a named error, never ₹0.00 or 'No waste entries yet'", () => {
  assert.match(expensesModule, /loadState\.status === "failed"/);
  assert.match(expensesModule, /className="error-banner" role="alert"/);
  assert.match(expensesModule, /loadFailed \? MISSING_VALUE : currency\.format\(totalActiveExpenses\)/);
  const wasteModule = appSource.slice(appSource.indexOf("function WasteManagementModule("), appSource.indexOf("function DistributionModule("));
  assert.ok(wasteModule.length > 0);
  assert.match(wasteModule, /loadState\.status === "failed"/);
  assert.match(wasteModule, /className="error-banner" role="alert"/);
  assert.match(appSource, /<ExpensesModule[\s\S]{0,200}loadState=\{expensesLoad\}/);
  assert.match(appSource, /<WasteManagementModule[\s\S]{0,200}loadState=\{wasteLoad\}/);
});
