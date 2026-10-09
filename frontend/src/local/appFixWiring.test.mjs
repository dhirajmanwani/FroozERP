import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Fixes that live in App.jsx markup, pinned by its source text (the logic they call is tested in
// rolePermissions, accountsPresentation, salesReportTotals and figurePresentation).
const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
const body = (marker) => {
  const start = app.indexOf(marker);
  assert.ok(start > 0, `${marker} must exist`);
  return app.slice(start, app.indexOf("\nfunction ", start + 1));
};

test("module access is decided by the stored permission map", () => {
  const start = app.indexOf("const hasModuleAccess = (view) => {");
  const access = app.slice(start, start + 2000);
  assert.match(access, /return resolveModuleAccess\(\{ view, role: roleName, permissions, defaultPermissions, modulePermissionMap \}\);/);
  assert.doesNotMatch(access, /if \(defaultPermissions\.all \|\| defaultPermissions\[view\]\) return true;/,
    "defaults read before the stored map made unticking a screen do nothing");
});

test("pending purchase bill actions are drawn only for Owner and Admin", () => {
  const pending = body("function PendingPurchaseBillsModule(");
  assert.match(pending, /canManagePending \? \(/);
  assert.match(pending, /PENDING_BILL_MANAGER_NOTE/);
  assert.match(app, /canManagePending=\{canManagePendingPurchaseBills\(user\.role\)\}/);
  assert.match(app, /\{canManagePendingPurchaseBills\(user\.role\) \? \(\s*\n\s*<div className="button-row table-actions-row">\s*\n\s*<button className="table-action" disabled=\{purchase\.purchase_status === "CANCELLED" \|\| Boolean\(changeBlock\)\} onClick=\{\(\) => editPurchase\(purchase\)\}/);
});

test("customer payments follow the permission map, not role names", () => {
  assert.doesNotMatch(app, /\["Owner", "Admin", "Cashier"\]\.includes\(user\.role\)/);
  const accounts = body("function AccountsModule(");
  assert.doesNotMatch(accounts, /user\.role === "Cashier"/);
  assert.match(accounts, /const canUseCustomerPayments = accountPermissions\.customerPayments === true;/);
  assert.match(accounts, /masterTypeOptions\.map/);
  assert.match(accounts, /disabled=\{!canEditAccountRow\(account, accountPermissions\)\}/);
});

test("outstanding and customer pending bills keep their errors instead of zeros", () => {
  assert.match(app, /const \[accountOutstanding, setAccountOutstanding\] = useState\(null\);/);
  assert.doesNotMatch(app, /accountOutstanding\.totalReceivable \|\| 0/);
  assert.match(app, /setCustomerPendingBillsError\(getErrorMessage\(error/);
  assert.match(body("function PendingBillsModule("), /customerPendingBillsError && <div className="error-banner" role="alert">/);
});

test("overpayment shows a signed balance and a warning", () => {
  const accounts = body("function AccountsModule(");
  assert.doesNotMatch(accounts, /Math\.max\(0, roundUi\(outstandingBefore - paymentAmount - rebateAmount\)\)/);
  assert.match(accounts, /overpaymentNote && <div className="warning-note" role="status">/);
});

test("the stock value tile sums the same rows as the table", () => {
  const stock = body("function StockInventoryReport(");
  assert.match(stock, /const totalStockValue = filteredProductRows\.reduce\(\(sum, product\) => sum \+ product\.filtered_stock_value, 0\);/);
  assert.doesNotMatch(stock, /lotStatus\(lot\) === "Active"\)\.reduce/);
});

test("the bill-discount form can switch a slab on and off", () => {
  const slab = body("function DiscountSettings(");
  assert.match(slab, /checked=\{draft\.active !== false\} type="checkbox" onChange=\{\(event\) => setDraft\(\{ \.\.\.draft, active: event\.target\.checked \}\)\}/);
});

test("changing one's own password sends the current one", () => {
  assert.match(app, /current_password: passwordDraft\.current_password,/);
  assert.match(app, /<Field label="Current Password"><PasswordInput /);
});

test("sales history and payment report tiles use the shared totals", () => {
  assert.match(app, /salesHistoryMoneyTotals\(activeInvoices, \{ itemGross: saleItemGross \}\)/);
  assert.match(app, /new Set\(UPI_BANK_PAYMENT_MODES\)/);
  assert.match(app, /const totals = paymentReportTotals\(rows\);/);
  assert.match(app, /const dayBookVoucherType = \(row\) => dayBookVoucherLabel\(row\);/);
});

test("FROST briefing figures go through the unavailable-aware reader", () => {
  assert.match(app, /const cardValue = \(section, key\) => briefingCardFigure\(cards, section, key\);/);
  assert.doesNotMatch(app, /label="Customer Overdue"/);
});

test("Branches & Counters: an Admin gets the screen lock and no scope read", () => {
  const scope = body("function OperationalScopeManagement(");
  assert.match(scope, /if \(!branchesScreenPlan\(scopeUserRef\.current\?\.role \|\| scopeUserRef\.current\?\.role_name\)\.readsScope\) \{/);
  assert.match(scope, /scopePlan\.showsSection\(section\.id\)/);
  assert.match(scope, /\{scopePlan\.readsScope && \(\s*\n\s*<>\s*\n\s*<ModuleCard id=\{scopeSectionDomId\("branches\/shops"\)\}/);
  const load = scope.indexOf("const load = useCallback");
  assert.ok(scope.indexOf("readsScope", load) < scope.indexOf("scope-management", load), "decided before the request");
  assert.match(app, /The Owner or an Admin can reset it in Branches & Counters > Counter screen lock\./);
});

test("loadReports is skipped, before any request, for a role without Reports", () => {
  const start = app.indexOf("const loadReports = async (params = {}) => {");
  const head = app.slice(start, start + 700);
  assert.match(head, /if \(user && !mayReadReports\(\{ role: user\.role, permissions: rolePermissionMap\.get\(user\.role\) \}\)\) \{/);
  assert.ok(head.indexOf("mayReadReports") < head.indexOf("reportRequestGateRef.current.begin()"));
});
