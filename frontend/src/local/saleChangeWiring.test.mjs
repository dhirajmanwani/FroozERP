// How App.jsx wires the sale cancel/edit reason picker, the Owner/Admin approval and the Owner's
// daily bell line. The decisions live in saleChangeReason.js and saleChangeDigest.js (tested there);
// this pins the order App.jsx asks them in, because that order is what keeps LOCAL_ONLY at zero
// cloud calls and a refused approval from writing anything.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

const slice = (startMarker, endMarker) => {
  const start = app.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  const end = app.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing ${endMarker} after ${startMarker}`);
  return app.slice(start, end);
};

const before = (source, first, second) => {
  const a = source.indexOf(first);
  const b = source.indexOf(second);
  assert.notEqual(a, -1, `missing ${first}`);
  assert.notEqual(b, -1, `missing ${second}`);
  assert.ok(a < b, `${first} must come before ${second}`);
};

test("the approval route refuses offline and Local Only before the cloud gate is asked", () => {
  const route = slice("const resolveSaleChangeRoute = ", "const requestSaleChangeApproval = ");
  before(route, "isSaleChangeLocalOnly(connectivityMode)", "guardCloudCall(\"sale-change-approval\"");
  assert.match(route, /!needsApproval \|\| offlineMode \|\| localOnly\s*\?\s*false/);
  assert.match(route, /hasCloudSession\(user\) !== false/);
  const localOnly = slice("const isSaleChangeLocalOnly = ", "const resolveSaleChangeRoute = ");
  assert.match(localOnly, /readConnectivityMode\(\) === CONNECTIVITY_MODES\.LOCAL_ONLY/);
  assert.match(localOnly, /isLocalOnlyConnectivitySelected\(\)/);
});

test("the approval request is made only on the CLOUD route, and before the change is written", () => {
  const cancel = slice("const confirmCancelSale = async () => {", "const selectPurchaseProduct = ");
  before(cancel, "resolveSaleChangeRoute(", "requestSaleChangeApproval(");
  before(cancel, "if (route.mode === SALE_CHANGE_APPROVAL_MODE.CLOUD)", "requestSaleChangeApproval(");
  before(cancel, "requestSaleChangeApproval(", "cancelLocalPosSale(");
  before(cancel, "requestSaleChangeApproval(", "/api/v3/sales/${saleId}/cancel");
  assert.equal((cancel.match(/approval_id: approvalId/g) || []).length, 2, "local payload and v3 body both carry approval_id");
  assert.match(cancel, /approvalErrorCode\(error\) === "SALE_CHANGE_APPROVAL_REQUIRED"/);

  const edit = slice("const saveChange = async () => {", "return (\n    <div className=\"modal-backdrop\">\n      <section className=\"invoice-modal sale-edit-modal\">");
  before(edit, "resolveSaleChangeRoute(", "requestSaleChangeApproval(");
  before(edit, "if (route.mode === SALE_CHANGE_APPROVAL_MODE.CLOUD)", "requestSaleChangeApproval(");
  before(edit, "requestSaleChangeApproval(", "editLocalPosSale(payload)");
  before(edit, "approval_id: approvalId", "editLocalPosSale(payload)");
  assert.match(edit, /approvalErrorCode\(error\) === "SALE_CHANGE_APPROVAL_REQUIRED"/);
});

test("the approver's password is forgotten after every attempt and never autofilled", () => {
  const cancel = slice("const confirmCancelSale = async () => {", "const selectPurchaseProduct = ");
  assert.match(cancel, /finally \{\s*setCancelDraft\(\(current\) => current \? \{ \.\.\.current, approverPassword: "", saving: false \}/);
  const editSave = slice("const save = async () => {", "const saveChange = async () => {");
  assert.match(editSave, /finally \{\s*forgetPassword\(\);/);
  const fields = slice("function SaleChangeApprovalFields(", "function SaleCancelModal(");
  assert.match(fields, /autoComplete="new-password"[^>]*type="password"/);
  assert.match(fields, /route\.mode === SALE_CHANGE_APPROVAL_MODE\.REFUSED/);
});

test("the Owner's bell reads the cloud only when allowed, and this counter otherwise", () => {
  const loader = slice("const loadSaleChangeFeed = useCallback(", "const raisedSaleChangeRows = useRef(");
  assert.match(loader, /user\.role !== "Owner"/);
  before(loader, "const useCloud = !localOnly", "/sales-report/change-events");
  before(loader, "guardCloudCall(\"sale-change-summary\", API_URL).allowed === true", "/sales-report/change-events");
  assert.match(loader, /if \(useCloud\) \{/);
  assert.match(loader, /listLocalPosSales\(\)/);
  assert.match(loader, /SALE_CHANGE_SCOPE\.THIS_COUNTER/);
  assert.match(loader, /if \(!useCloud && !tauri\) return;/);
});

test("the bell keeps its wrapper and the publisher retracts the error row on a good read", () => {
  assert.ok(app.includes('<div className="notification-bell-wrap">'));
  const publisher = slice("const raisedSaleChangeRows = useRef(", "Surface the activation state");
  assert.match(publisher, /bell\.status === SALE_CHANGE_DIGEST_STATUS\.OK/);
  assert.match(publisher, /clearNotice\(SALE_CHANGES_UNREADABLE_KEY\)/);
});
