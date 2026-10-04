"use strict";

/**
 * Owner/Admin approval for a cashier's bill cancel or edit.
 *
 * Two halves. The pure rules in `saleChangeApproval.js` are driven directly: who needs approval,
 * what a valid request is, when a stored approval covers a change, and the per-requester attempt
 * limit. Then the wiring in `server.js` is pinned from its source text, because `server.js` cannot
 * be driven against a real database here: all four bill-change paths call the one helper, the
 * approval route takes its requester from the verified session only, the approver's password is
 * checked and never logged, and the approver's own lockout is never bumped.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const approval = require("./saleChangeApproval");

const {
  APPROVAL_STATUS,
  BINDING_DETAILS,
  CODES,
  FAILURE_LIMIT,
  FAILURE_WINDOW_MS,
  APPROVAL_TTL_MS,
  approvalAttemptsLocked,
  approvalRequired,
  canApprove,
  checkApprovalBinding,
  expiresAtFrom,
  missingApproval,
  normalizeApprovalId,
  normalizeApprovalRequest,
  recentFailureCount,
  saleRefsOf,
} = approval;

const SOURCE = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const NOW = Date.parse("2026-09-27T10:00:00.000Z");

const issuedRow = (overrides = {}) => ({
  id: "9d1f3c2e-0000-4000-8000-000000000001",
  status: APPROVAL_STATUS.ISSUED,
  action: "cancel",
  sale_ref: "invoice-abc",
  requester_id: 12,
  approver_id: 1,
  approver_role: "Owner",
  approver_active: true,
  company_id: 1,
  branch_id: 2,
  device_id: "FZDEV-COUNTER-1",
  expires_at: new Date(NOW + 60 * 60 * 1000),
  ...overrides,
});

const binding = (overrides = {}) => ({
  action: "cancel",
  saleRefs: [44, "invoice-abc", "OFF-1"],
  requesterId: 12,
  companyId: 1,
  deviceId: "FZDEV-COUNTER-1",
  nowMs: NOW,
  ...overrides,
});

// ---------------------------------------------------------------------------------------------
// Who needs approval
// ---------------------------------------------------------------------------------------------

test("only Owner and Admin change a bill without approval", () => {
  assert.equal(approvalRequired("Owner"), false);
  assert.equal(approvalRequired("Admin"), false);
  assert.equal(approvalRequired(" Owner "), false, "stray whitespace is not a different role");
  for (const role of ["Cashier", "Purchase Manager", "Inventory Manager", "owner", "", null, undefined]) {
    assert.equal(approvalRequired(role), true, `${String(role)} must need approval`);
  }
});

test("only Owner and Admin can approve", () => {
  assert.equal(canApprove("Owner"), true);
  assert.equal(canApprove("Admin"), true);
  assert.equal(canApprove("Cashier"), false);
  assert.equal(canApprove(undefined), false);
});

// ---------------------------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------------------------

const validBody = (overrides = {}) => ({
  action: "cancel",
  sale_ref: "invoice-abc",
  approver_username: "owner",
  approver_password: " secret with spaces ",
  reason: "Customer refused",
  ...overrides,
});

test("a complete request is accepted and the password is kept exactly as typed", () => {
  const parsed = normalizeApprovalRequest(validBody({ action: " EDIT " }));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, {
    action: "edit",
    saleRef: "invoice-abc",
    approverUsername: "owner",
    approverPassword: " secret with spaces ",
    reason: "Customer refused",
  });
});

test("a numeric sale id is kept as the same opaque string, never re-numbered", () => {
  assert.equal(normalizeApprovalRequest(validBody({ sale_ref: 44 })).value.saleRef, "44");
  assert.equal(normalizeApprovalRequest(validBody({ sale_ref: "004" })).value.saleRef, "004");
});

test("each missing or malformed field is refused by name, without echoing the password", () => {
  const cases = [
    [{ action: "delete" }, /cancelled, edited or returned/],
    [{ action: undefined }, /cancelled, edited or returned/],
    [{ sale_ref: "" }, /which bill/],
    [{ sale_ref: "x".repeat(181) }, /too long/],
    [{ approver_username: "  " }, /username/],
    [{ approver_password: "" }, /password/],
    [{ approver_password: 1234 }, /password/],
    [{ reason: " " }, /reason/i],
  ];
  for (const [override, message] of cases) {
    const parsed = normalizeApprovalRequest(validBody(override));
    assert.equal(parsed.ok, false, JSON.stringify(override));
    assert.equal(parsed.code, CODES.REQUEST_INVALID);
    assert.match(parsed.message, message);
    assert.doesNotMatch(parsed.message, /secret/);
  }
  assert.equal(normalizeApprovalRequest(null).ok, false);
});

test("an approval id is accepted only when it could be one", () => {
  assert.equal(normalizeApprovalId(" abc "), "abc");
  assert.equal(normalizeApprovalId(""), "");
  assert.equal(normalizeApprovalId(undefined), "");
  assert.equal(normalizeApprovalId(42), "", "ids are strings; a number is not coerced into one");
  assert.equal(normalizeApprovalId("x".repeat(65)), "");
});

// ---------------------------------------------------------------------------------------------
// The binding
// ---------------------------------------------------------------------------------------------

test("an issued approval covers exactly the change it was issued for", () => {
  assert.deepEqual(checkApprovalBinding(issuedRow(), binding()), { ok: true });
  // Any of the bill's references will do: the desktop knows it by its offline id, the browser by
  // its row id.
  assert.equal(checkApprovalBinding(issuedRow({ sale_ref: "44" }), binding()).ok, true);
  assert.equal(checkApprovalBinding(issuedRow({ sale_ref: "OFF-1" }), binding()).ok, true);
});

test("every mismatch is refused with its own detail, and always as approval-required", () => {
  const cases = [
    [null, {}, BINDING_DETAILS.NOT_FOUND],
    [issuedRow({ status: APPROVAL_STATUS.CONSUMED }), {}, BINDING_DETAILS.ALREADY_USED],
    [issuedRow({ status: APPROVAL_STATUS.FAILED }), {}, BINDING_DETAILS.NOT_ISSUED],
    [issuedRow({ expires_at: new Date(NOW) }), {}, BINDING_DETAILS.EXPIRED],
    [issuedRow({ expires_at: null }), {}, BINDING_DETAILS.EXPIRED],
    [issuedRow(), { nowMs: undefined }, BINDING_DETAILS.EXPIRED],
    [issuedRow(), { action: "edit" }, BINDING_DETAILS.WRONG_ACTION],
    [issuedRow({ sale_ref: "invoice-other" }), {}, BINDING_DETAILS.WRONG_SALE],
    [issuedRow(), { saleRefs: [] }, BINDING_DETAILS.WRONG_SALE],
    [issuedRow(), { requesterId: 13 }, BINDING_DETAILS.WRONG_REQUESTER],
    [issuedRow(), { requesterId: undefined }, BINDING_DETAILS.WRONG_REQUESTER],
    [issuedRow(), { companyId: 2 }, BINDING_DETAILS.WRONG_COMPANY],
    [issuedRow({ company_id: null }), {}, BINDING_DETAILS.WRONG_COMPANY],
    [issuedRow(), { deviceId: "FZDEV-OTHER" }, BINDING_DETAILS.WRONG_DEVICE],
    [issuedRow({ device_id: null }), {}, BINDING_DETAILS.WRONG_DEVICE],
    [issuedRow({ approver_role: "Cashier" }), {}, BINDING_DETAILS.APPROVER_NO_LONGER_ALLOWED],
    [issuedRow({ approver_active: false }), {}, BINDING_DETAILS.APPROVER_NO_LONGER_ALLOWED],
    [issuedRow({ approver_role: undefined }), {}, BINDING_DETAILS.APPROVER_NO_LONGER_ALLOWED],
  ];
  for (const [row, override, detail] of cases) {
    const result = checkApprovalBinding(row, binding(override));
    assert.equal(result.ok, false, `${detail} must refuse`);
    assert.equal(result.code, CODES.APPROVAL_REQUIRED);
    assert.equal(result.code, "SALE_CHANGE_APPROVAL_REQUIRED");
    assert.equal(result.detail, detail);
    assert.match(result.message, /Owner or Admin approval/);
  }
});

test("ids compare as opaque strings: \"004\" is not bill 4", () => {
  assert.equal(checkApprovalBinding(issuedRow({ sale_ref: "004" }), binding({ saleRefs: [4] })).detail, BINDING_DETAILS.WRONG_SALE);
  assert.equal(checkApprovalBinding(issuedRow({ requester_id: "012" }), binding()).detail, BINDING_DETAILS.WRONG_REQUESTER);
  // The same id arriving as a number from Postgres and as a string from JSON is the same id.
  assert.equal(checkApprovalBinding(issuedRow({ requester_id: "12", company_id: "1" }), binding()).ok, true);
});

test("the device is checked whenever the caller knows it", () => {
  // Neither path omits it today; this pins what an omission would mean rather than inviting one.
  assert.equal(checkApprovalBinding(issuedRow(), binding({ deviceId: "" })).ok, true);
});

test("a change with no approval at all says what it needs", () => {
  const refusal = missingApproval();
  assert.equal(refusal.ok, false);
  assert.equal(refusal.code, "SALE_CHANGE_APPROVAL_REQUIRED");
  assert.equal(refusal.detail, BINDING_DETAILS.MISSING);
});

test("a bill's references are its row id, global id and offline ref, as strings", () => {
  assert.deepEqual(saleRefsOf({ id: 44, global_id: "invoice-abc", offline_invoice_ref: null }), ["44", "invoice-abc"]);
  assert.deepEqual(saleRefsOf(null), []);
});

test("an approval lasts seven days", () => {
  assert.equal(APPROVAL_TTL_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(expiresAtFrom(NOW).getTime(), NOW + APPROVAL_TTL_MS);
});

// ---------------------------------------------------------------------------------------------
// The attempt limit
// ---------------------------------------------------------------------------------------------

test("five failures inside fifteen minutes lock the requester out of asking", () => {
  assert.equal(FAILURE_LIMIT, 5);
  assert.equal(FAILURE_WINDOW_MS, 15 * 60 * 1000);
  assert.equal(approvalAttemptsLocked(4), false);
  assert.equal(approvalAttemptsLocked(5), true);
  assert.equal(approvalAttemptsLocked("5"), true, "COUNT(*) can arrive as text");
  assert.equal(approvalAttemptsLocked(undefined), false);
  assert.equal(approvalAttemptsLocked(0, 9), false, "nine wrong attempts spread over a day still pass");
  assert.equal(approvalAttemptsLocked(0, 10), true, "the tenth wrong attempt in a day locks the requester until tomorrow");
  assert.equal(approvalAttemptsLocked(0, "10"), true);
});

test("only failures inside the window count", () => {
  const minute = 60 * 1000;
  const failures = [
    new Date(NOW - 1 * minute),
    new Date(NOW - 14 * minute),
    new Date(NOW - 15 * minute), // exactly at the edge: out
    new Date(NOW - 60 * minute),
    "not a date",
  ];
  assert.equal(recentFailureCount(failures, NOW), 2);
  assert.equal(recentFailureCount(undefined, NOW), 0);
});

// ---------------------------------------------------------------------------------------------
// The wiring in server.js
// ---------------------------------------------------------------------------------------------

const handlerBody = (marker) => {
  const start = CODE.indexOf(marker);
  assert.ok(start >= 0, `${marker} must exist`);
  const next = CODE.slice(start + marker.length).search(/\nconst [A-Za-z0-9_]+ = async \(/);
  return next < 0 ? CODE.slice(start) : CODE.slice(start, start + marker.length + next);
};

test("all four bill-change paths run the one approval check and record the approver", () => {
  for (const [marker, action] of [
    ["const updateSaleHandler", "edit"],
    ["const cancelSaleHandler", "cancel"],
    ["const processPosSaleEditOperation", "edit"],
    ["const processPosSaleCancelOperation", "cancel"],
  ]) {
    const body = handlerBody(marker);
    assert.match(
      body,
      new RegExp(`await authorizeSaleChange\\(client, \\{ actor: \\w+, action: "${action}"`),
      `${marker} must call authorizeSaleChange for ${action}`,
    );
    assert.match(body, /if \(!approval\.ok\)/, `${marker} must stop when the approval does not hold`);
    assert.match(
      body,
      /INSERT INTO sale_audit_trail \([^)]*edited_by, approved_by\)/,
      `${marker} must write approved_by into its audit row`,
    );
    assert.match(body, /approval\.approverId\]/, `${marker} must pass the approver id into that row`);
    // The check sits after the bill is found, so the binding compares against the real bill.
    assert.ok(
      body.indexOf("authorizeSaleChange(") > body.indexOf("currentSale"),
      `${marker} must check the approval against the locked bill`,
    );
    // And before anything is written.
    assert.ok(
      body.indexOf("authorizeSaleChange(") < body.indexOf("getSaleSnapshot(client"),
      `${marker} must refuse before it touches stock or payments`,
    );
  }
});

test("the sync paths keep their existing refusals first, and refuse as an authorization error", () => {
  for (const marker of ["const processPosSaleEditOperation", "const processPosSaleCancelOperation"]) {
    const body = handlerBody(marker);
    assert.ok(body.indexOf("getSalePermissionUser(") < body.indexOf("authorizeSaleChange("));
    assert.match(body, /rejectOperation\(operation, "AUTHORIZATION_ERROR", approval\.message\)/);
    assert.match(body, /authorizeSaleChange\([^)]*approvalId,/, `${marker} must read the approval from the envelope`);
    assert.match(body, /deviceId: context\.deviceId/, `${marker} must bind to the pushing device`);
  }
  assert.match(handlerBody("const syncSaleEnvelope"), /approvalId: cleanText\(payload\.approval_id\)/);
});

test("the browser paths refuse with 403 SALE_CHANGE_APPROVAL_REQUIRED after rolling back", () => {
  for (const marker of ["const updateSaleHandler", "const cancelSaleHandler"]) {
    const body = handlerBody(marker);
    assert.match(body, /approvalId: req\.body\.approval_id/);
    assert.match(body, /return rejectSaleChange\(client, res, approval\)/);
  }
  const reject = handlerBody("const rejectSaleChange");
  assert.match(reject, /ROLLBACK/);
  assert.match(reject, /status\(403\)/);
});

test("the enforcement helper consumes the approval under a row lock and re-reads the approver", () => {
  const helper = handlerBody("const authorizeSaleChange");
  assert.match(helper, /approvalRequired\(actor\?\.role_name\)/, "the actor's role comes from the database row");
  assert.match(helper, /FOR UPDATE OF a/);
  assert.match(helper, /r\.role_name AS approver_role, u\.active AS approver_active/);
  assert.match(helper, /SET status = 'CONSUMED'[\s\S]*WHERE id = \$1 AND status = 'ISSUED'/);
});

test("the approval route's requester is the verified session and nothing else", () => {
  const route = handlerBody("const createSaleChangeApprovalHandler");
  assert.match(route, /const requesterId = req\.auth\.userId;/);
  assert.match(route, /getSalePermissionUser\(requesterId, request\.action\)/);
  assert.doesNotMatch(route, /req\.body\.(user_id|requester_id|created_by|updated_by)/);
  assert.doesNotMatch(route, /req\.headers/);
  assert.match(
    CODE,
    /app\.post\("\/api\/v3\/sale-change-approvals", rateLimitSyncRequest, v3WriteAdapter\(createSaleChangeApprovalHandler\)\)/,
  );
});

test("the approver's password is checked like a sign-in and never logged or stored", () => {
  const route = handlerBody("const createSaleChangeApprovalHandler");
  assert.match(route, /checkPassword\(request\.approverPassword, approver\.password_hash\)/);
  assert.match(route, /storedPasswordIsUnusable\(verification\)/);
  assert.match(route, /CODES\.PASSWORD_RESET_REQUIRED/);
  assert.match(route, /writeAuthAudit\(/);
  // The password appears in exactly one expression: the comparison.
  assert.equal((route.match(/approverPassword/g) || []).length, 1, "the password must reach checkPassword and nothing else");
  assert.doesNotMatch(route, /console\.[a-z]+\([^)]*request\b/);
  assert.doesNotMatch(route, /password_hash[^\n]*INSERT|INSERT[^;]*password/i);
});

test("a wrong attempt is counted against the requester, never against the approver's login", () => {
  const route = handlerBody("const createSaleChangeApprovalHandler");
  assert.doesNotMatch(route, /registerFailedAttempt|failed_login_attempts|UPDATE users/, "the approver's lockout must not move");
  assert.match(route, /WHERE requester_id = \$1 AND status = 'FAILED'/);
  assert.match(route, /approvalAttemptsLocked\(/);
  assert.match(route, /status\(429\)/);
  assert.match(route, /pg_advisory_xact_lock/);
});

test("the route answers with the contract's codes", () => {
  const route = handlerBody("const createSaleChangeApprovalHandler");
  for (const code of [
    "CREDENTIALS_INVALID",
    "APPROVER_NOT_ALLOWED",
    "REQUESTER_NOT_ALLOWED",
    "ATTEMPTS_LOCKED",
    "PASSWORD_RESET_REQUIRED",
    "NOT_NEEDED",
  ]) {
    assert.match(route, new RegExp(`CODES\\.${code}\\b`), `${code} must be reachable`);
  }
  assert.equal(CODES.CREDENTIALS_INVALID, "APPROVER_CREDENTIALS_INVALID");
  assert.equal(CODES.ATTEMPTS_LOCKED, "APPROVAL_ATTEMPTS_LOCKED");
  assert.match(route, /status\(201\)\.json\(\{\s*approval_id: approvalId,\s*approver_name: approver\.full_name,\s*expires_at:/);
});

test("the change-events report is branch-scoped and Owner/Admin only", () => {
  const start = CODE.indexOf('app.get("/sales-report/change-events"');
  assert.ok(start > 0);
  const route = CODE.slice(start, CODE.indexOf("\napp.", start + 10));
  assert.match(route, /getPermissionUser\(req\.auth\.userId, "reports", \["Owner", "Admin"\]\)/);
  assert.match(route, /RATE_MANAGER_ROLES\.has\(reader\.role_name\)/);
  assert.match(route, /JOIN sales s ON s\.id = sat\.sale_id/);
  assert.match(route, /WHERE s\.branch_id = \$1/);
  assert.match(route, /\[req\.auth\.branchId,/);
  assert.match(route, /approved_by_name/);
});

// ---------------------------------------------------------------------------------------------
// The same machinery for a cashier's discount over 5% (30 Sep 2026)
// ---------------------------------------------------------------------------------------------

const {
  DEFAULT_DISCOUNT_REASON,
  DISCOUNT_APPROVAL_MESSAGE,
  checkDiscountApprovalBinding,
  missingDiscountApproval,
  newSaleRefsOf,
} = approval;

const discountRow = (overrides = {}) => issuedRow({ action: "discount", sale_ref: "bill-op-1", ...overrides });
const discountBinding = (overrides = {}) => ({
  saleRefs: ["bill-op-1"],
  requesterId: 12,
  companyId: 1,
  deviceId: "FZDEV-COUNTER-1",
  nowMs: NOW,
  ...overrides,
});

test("a discount request needs no typed reason; a cancel or edit still does", () => {
  const parsed = normalizeApprovalRequest(validBody({ action: "discount", sale_ref: "bill-op-1", reason: "" }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.action, "discount");
  assert.equal(parsed.value.reason, DEFAULT_DISCOUNT_REASON);
  assert.equal(normalizeApprovalRequest(validBody({ action: "discount", reason: "Regular customer" })).value.reason, "Regular customer");
  for (const action of ["cancel", "edit"]) {
    assert.equal(normalizeApprovalRequest(validBody({ action, reason: "" })).ok, false, `${action} still needs a reason`);
  }
  assert.equal(normalizeApprovalRequest(validBody({ action: "discount", approver_password: "" })).ok, false, "the password is still required");
});

test("a discount approval covers exactly the new bill it was issued for", () => {
  assert.deepEqual(checkDiscountApprovalBinding(discountRow(), discountBinding()), { ok: true });
  assert.equal(checkDiscountApprovalBinding(discountRow({ sale_ref: "OFF-1" }), discountBinding({ saleRefs: ["op-9", "invoice-9", "OFF-1"] })).ok, true);
});

test("a discount approval that does not hold answers DISCOUNT_APPROVAL_REQUIRED with the failed binding", () => {
  const cases = [
    [null, {}, BINDING_DETAILS.NOT_FOUND],
    [discountRow({ status: APPROVAL_STATUS.CONSUMED }), {}, BINDING_DETAILS.ALREADY_USED],
    [discountRow({ expires_at: new Date(NOW - 1) }), {}, BINDING_DETAILS.EXPIRED],
    [discountRow({ action: "edit" }), {}, BINDING_DETAILS.WRONG_ACTION],
    [discountRow({ action: "cancel" }), {}, BINDING_DETAILS.WRONG_ACTION],
    [discountRow(), { saleRefs: ["another-bill"] }, BINDING_DETAILS.WRONG_SALE],
    [discountRow(), { requesterId: 13 }, BINDING_DETAILS.WRONG_REQUESTER],
    [discountRow(), { companyId: 2 }, BINDING_DETAILS.WRONG_COMPANY],
    [discountRow(), { deviceId: "FZDEV-OTHER" }, BINDING_DETAILS.WRONG_DEVICE],
    [discountRow({ approver_active: false }), {}, BINDING_DETAILS.APPROVER_NO_LONGER_ALLOWED],
  ];
  for (const [row, override, detail] of cases) {
    const result = checkDiscountApprovalBinding(row, discountBinding(override));
    assert.equal(result.ok, false, detail);
    assert.equal(result.code, "DISCOUNT_APPROVAL_REQUIRED");
    assert.equal(result.detail, detail);
    assert.equal(result.message, "A discount over 5% needs an Owner or Admin to approve it.");
  }
  assert.deepEqual(missingDiscountApproval(), {
    ok: false, code: "DISCOUNT_APPROVAL_REQUIRED", detail: BINDING_DETAILS.MISSING, message: DISCOUNT_APPROVAL_MESSAGE,
  });
});

test("a discount approval cannot cancel or edit a bill", () => {
  const result = checkApprovalBinding(discountRow({ sale_ref: "44" }), binding({ action: "edit" }));
  assert.equal(result.detail, BINDING_DETAILS.WRONG_ACTION);
});

test("a new bill's references are opaque strings, blanks and repeats dropped", () => {
  assert.deepEqual(newSaleRefsOf("op-1", "op-1", "", undefined, null, " invoice-1 ", 44), ["op-1", "invoice-1", "44"]);
  assert.deepEqual(newSaleRefsOf(), []);
});

test("browser checkout checks the discount approval before the bill is written, against its operation id", () => {
  const body = handlerBody("const createSaleHandler");
  // Lines and the cashier's bill part (1 Oct 2026) are measured together, before the check. With no
  // `manual_bill_discount` the bill part is what the invoice discount gives beyond the slab.
  assert.match(body, /discountRules\.assessBillManualDiscount\(\{ lines: manualDiscountLinesOf\(invoiceItems\), manualBill: manualDiscountBill \}\)/);
  assert.match(body, /manualBillDiscount\.present\s*\?\s*manualBillDiscount\.amount\s*:\s*discountRules\.impliedManualBillDiscount\(/);
  assert.doesNotMatch(body, /discountRules\.assessManualDiscounts\(/, "no browser path skips the bill part");
  assert.ok(body.indexOf("loadBillSlabs(client)") < body.indexOf("impliedManualBillDiscount("), "the slab is known before the bill part is");
  assert.ok(body.indexOf("assessBillManualDiscount(") < body.indexOf("authorizeManualDiscount("));
  assert.match(body, /await authorizeManualDiscount\(client, \{[\s\S]*?actorId: parsedCreatedBy,[\s\S]*?approvalId: req\.body\.discount_approval_id,[\s\S]*?saleRefs: saleChangeApproval\.newSaleRefsOf\(v3OperationKey\(req\)\),/);
  assert.match(body, /if \(!manualDiscountDecision\.ok\) return rejectSaleChange\(client, res, manualDiscountDecision\);/);
  assert.ok(body.indexOf("authorizeManualDiscount(") < body.indexOf("INSERT INTO sales"), "refused before the bill is written");
  assert.ok(body.indexOf("recordManualDiscountDecision(") > body.indexOf("INSERT INTO sales"), "spent once the bill has an id");
  assert.match(body, /lotDiscountOfRecord: verifiedLotDiscount/, "the lot part is the verified lot discount");
  const parsed = body.slice(body.indexOf("const parsedCreatedBy"), body.indexOf("const parsedCreatedBy") + 60);
  assert.match(parsed, /req\.auth\.userId/, "the cashier is the verified session");
});

test("desktop sync never rejects a bill for the discount rule, and records the decision on the bill", () => {
  const body = handlerBody("const processPosSaleFoundationOperation");
  const start = body.indexOf("authorizeManualDiscount(");
  assert.ok(start > 0);
  const after = body.slice(start);
  assert.doesNotMatch(after.slice(0, after.indexOf("INSERT INTO sales")), /rejectOperation|conflict\(/, "nothing between the check and the insert refuses the bill");
  assert.match(body, /approvalId: cleanText\(payload\.discount_approval_id\)/);
  assert.ok(body.indexOf("assessBillManualDiscount(") > 0 && body.indexOf("assessBillManualDiscount(") < start, "the bill part is measured before the check");
  assert.match(body, /actorId: context\.user\.id/);
  assert.match(body, /deviceId: context\.deviceId/);
  assert.match(body, /newSaleRefsOf\(\s*operation\.operation_id,\s*operation\.idempotency_key,\s*payload\.operation_id,\s*invoiceGlobalId,\s*offlineInvoiceRef\s*\)/);
  assert.ok(body.indexOf("recordManualDiscountDecision(") > body.indexOf("INSERT INTO sales"));
});

test("the discount helpers lock and spend the approval like a bill change, and trace without new columns", () => {
  const authorize = handlerBody("const authorizeManualDiscount");
  assert.match(authorize, /getManualDiscountActor\(actorId, client\)/);
  assert.match(authorize, /discountRules\.manualDiscountExempt\(actor\)/);
  assert.match(authorize, /FOR UPDATE OF a/);
  assert.match(authorize, /checkDiscountApprovalBinding\(/);
  const record = handlerBody("const recordManualDiscountDecision");
  assert.match(record, /SET status = 'CONSUMED'[\s\S]*WHERE id = \$1 AND status = 'ISSUED'/);
  assert.match(record, /INSERT INTO sale_audit_trail \(sale_id, action, field_name, old_value, new_value, reason, edited_by, approved_by\)/);
  assert.match(record, /'DISCOUNT_APPROVED'/);
  assert.match(record, /'DISCOUNT_UNAPPROVED'/);
  assert.match(CODE, /const MANUAL_DISCOUNT_UNAPPROVED_REASON = "Discount over 5% without approval";/);
  // Reports that list bill changes read EDIT and CANCEL only; a discount row is not a bill change.
  assert.doesNotMatch(CODE, /sat\.action IN \([^)]*DISCOUNT/);
});

test("the approval route takes a discount requester from the session and asks the 5% rule who is exempt", () => {
  const route = handlerBody("const createSaleChangeApprovalHandler");
  assert.match(route, /getManualDiscountActor\(requesterId\)/);
  assert.match(route, /discountRules\.manualDiscountExempt\(requester\)/);
  const actor = handlerBody("const getManualDiscountActor");
  assert.match(actor, /WHERE u\.id = \$1 AND u\.active = TRUE/);
});

test("a sale return is an approval action of its own (3 Oct 2026)", () => {
  const parsed = normalizeApprovalRequest(validBody({ action: "return", reason: "Soft fruit" }));
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.value.action, "return");
});
