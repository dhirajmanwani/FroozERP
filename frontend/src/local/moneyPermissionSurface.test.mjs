import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/**
 * Auth-hardening A-4c put a permission check on the money routes. These pin the frontend half —
 * without it the enforcement is real but unusable: a key that cannot be seen cannot be granted, and
 * a button that cannot succeed should not invite the click.
 */

const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

test("the two permission keys A-4c added are editable in Settings", () => {
  // A key enforced on the server and absent from this list is the worst of both worlds: it denies
  // people, and the maintainer has no way to grant it.
  const labels = app.slice(app.indexOf("const permissionLabels = ["), app.indexOf("const permissionLabels = [") + 2200);
  assert.match(labels, /\["expenses", "Expenses"\]/);
  assert.match(labels, /\["contra_entries", "Cash \/ Bank Transfer"\]/);
});

test("the Cancel buttons are disabled without cancellation permission, not left to fail", () => {
  // A-4c requires `invoice_cancellation` on the expense-cancel and payment-cancel routes, so an
  // enabled button for a Cashier is a guaranteed 403. Offering an action that cannot succeed is the
  // same failure as rendering an error as an empty result — see autoConnectivityAvailability.js.
  assert.match(app, /disabled=\{status === "CANCELLED" \|\| !canCancel\}/, "expense cancel must be gated");
  assert.match(app, /disabled=\{row\.cancelled \|\| !canCancel\}/, "payment cancel must be gated");
});

test("both cancel buttons say why they are disabled", () => {
  // A disabled control with no explanation is the same dead end with better manners.
  assert.match(app, /Cancelling an expense needs Invoice Cancellation permission\./);
  assert.match(app, /Cancelling a payment needs Invoice Cancellation permission\./);
});

test("the cancel gate is the same permission the server enforces", () => {
  // canCancelSales is `["Owner","Admin"].includes(role) || hasRolePermission("invoice_cancellation")`,
  // which mirrors getPermissionUser(userId, "invoice_cancellation", ["Owner","Admin"]) server-side.
  // If these two ever diverge the UI lies in one direction or the other.
  assert.match(app, /const canCancelSales = \["Owner", "Admin"\]\.includes\(user\.role\) \|\| hasRolePermission\("invoice_cancellation"\)/);
  assert.match(app, /<AccountsModule\s*\n\s*canCancel=\{canCancelSales\}/);
  assert.match(app, /<ExpensesModule\s*\n\s*canCancel=\{canCancelSales\}/);
});

test("canCancel defaults to false, so a caller that forgets it denies rather than permits", () => {
  // The failure mode that matters: a new call site omitting the prop must not silently re-enable
  // the button for everyone.
  assert.match(app, /function ExpensesModule\(\{ canCancel = false,/);
  assert.match(app, /function AccountsModule\(\{[^}]*canCancel = false,/s);
});
