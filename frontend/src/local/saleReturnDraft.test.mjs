import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildSaleReturnDraft,
  filterReturnInvoices,
  quantityToThousandths,
  refundPerUnit,
  saleReturnFingerprint,
  saleReturnPayload,
} from "./saleReturnDraft.js";

const items = [
  { sale_item_id: 11, product_name: "Apple", sold_quantity: "2.500", returnable_quantity: "0.200", net_amount: "250.00" },
  { sale_item_id: "12", product_name: "Banana", sold_quantity: "12", returnable_quantity: "12", net_amount: "120", refund_per_unit: "9.5" },
];

test("typed quantities become whole thousandths; junk is NaN and an empty box is null", () => {
  assert.equal(quantityToThousandths("0.2"), 200);
  assert.equal(quantityToThousandths("1.005"), 1005);
  assert.equal(quantityToThousandths(".5"), 500);
  assert.equal(quantityToThousandths(3), 3000);
  assert.equal(quantityToThousandths(""), null);
  assert.equal(quantityToThousandths(undefined), null);
  assert.ok(Number.isNaN(quantityToThousandths("1.2345")));
  assert.ok(Number.isNaN(quantityToThousandths("-1")));
  assert.ok(Number.isNaN(quantityToThousandths("abc")));
  assert.ok(Number.isNaN(quantityToThousandths(".")));
});

test("the last 0.2 kg can be returned: no floating point leftover refuses it", () => {
  const draft = buildSaleReturnDraft({ invoiceId: "7", items, quantities: { 11: "0.2" }, reason: "Rotten" });
  assert.equal(draft.canSave, true, draft.problems.join(" "));
  assert.deepEqual(draft.lines.map((line) => line.return_quantity), [0.2]);
  assert.equal(draft.total, 20);
});

test("more than can still be returned is named on the line and blocks saving", () => {
  const draft = buildSaleReturnDraft({ invoiceId: "7", items, quantities: { 11: "0.201" }, reason: "Rotten" });
  assert.equal(draft.canSave, false);
  assert.match(draft.lineProblems["11"], /Only 0\.2 can be returned/);
  assert.match(draft.problems.join(" "), /Apple: only 0\.2 can still be returned/);
});

test("the server's refund per unit wins over net amount / quantity, and a zero refund is kept as zero", () => {
  assert.equal(refundPerUnit(items[1]), 9.5);
  assert.equal(refundPerUnit(items[0]), 100);
  assert.equal(refundPerUnit({ refund_per_unit: 0, net_amount: 50, sold_quantity: 1 }), 0);
  assert.equal(refundPerUnit({ net_amount: 50, sold_quantity: 0 }), null);
  const draft = buildSaleReturnDraft({ invoiceId: "7", items, quantities: { 12: "2" }, reason: "Unripe" });
  assert.equal(draft.total, 19);
});

test("an unknown refund value is unknown, never zero", () => {
  const draft = buildSaleReturnDraft({ invoiceId: "7", items: [{ sale_item_id: 1, returnable_quantity: 1, sold_quantity: 0 }], quantities: { 1: "1" }, reason: "x" });
  assert.equal(draft.total, null);
  assert.equal(draft.lines[0].value, null);
});

test("no invoice, no quantity or no reason each say what is missing", () => {
  assert.match(buildSaleReturnDraft({ items, quantities: {}, reason: "x" }).problems[0], /Pick the invoice/);
  assert.match(buildSaleReturnDraft({ invoiceId: "7", items, quantities: {}, reason: "x" }).problems.join(" "), /at least one item/);
  assert.match(buildSaleReturnDraft({ invoiceId: "7", items, quantities: { 12: "1" }, reason: "  " }).problems.join(" "), /why the goods came back/);
  assert.equal(buildSaleReturnDraft({ invoiceId: "7", items, quantities: { 12: "1" }, reason: "  " }).canSave, false);
});

test("the invoice list skips cancelled bills, searches number, name and mobile, and is capped", () => {
  const sales = [
    { id: 3, invoice_no: "INV-3", customer_name: "Ramesh", customer_mobile: "98765", sale_status: "ACTIVE" },
    { id: 2, invoice_no: "INV-2", customer_name: "Suresh", sale_status: "CANCELLED" },
    { id: "uuid-1", invoice_no: "INV-1", customer_name: "Walk-in", customer_mobile: "11111" },
    { id: "", invoice_no: "broken" },
  ];
  assert.deepEqual(filterReturnInvoices(sales).invoices.map((sale) => sale.id), [3, "uuid-1"]);
  assert.deepEqual(filterReturnInvoices(sales, "ramesh").invoices.map((sale) => sale.id), [3]);
  assert.deepEqual(filterReturnInvoices(sales, "1111").invoices.map((sale) => sale.id), ["uuid-1"]);
  assert.deepEqual(filterReturnInvoices(sales, "suresh").invoices, []);
  const capped = filterReturnInvoices(sales, "", 1);
  assert.equal(capped.invoices.length, 1);
  assert.equal(capped.total, 2);
});

test("the payload keeps the sale id as the server gave it and a retry has the same fingerprint", () => {
  const draft = buildSaleReturnDraft({ invoiceId: "004", items, quantities: { 12: "1" }, reason: " Unripe " });
  const payload = saleReturnPayload({ invoiceId: "004", sale: { customer_name: "A" }, returnDate: "2026-10-03", refundType: "CASH_REFUND", reason: " Unripe ", branchId: 1, userId: 2, draft });
  assert.equal(payload.sale_id, "004");
  assert.equal(payload.return_reason, "Unripe");
  assert.deepEqual(payload.items, [{ sale_item_id: "12", return_quantity: 1 }]);
  assert.equal(saleReturnFingerprint(payload), saleReturnFingerprint({ ...payload }));
  assert.notEqual(saleReturnFingerprint(payload), saleReturnFingerprint({ ...payload, refund_type: "UPI_REFUND" }));
});

test("the Returns screen uses this module, guards double saves and never Number()s the invoice id", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("function SaleReturnModule(");
  const end = app.indexOf("\nfunction ", start + 10);
  const body = app.slice(start, end);
  assert.ok(start > 0);
  assert.match(app, /from "\.\/local\/saleReturnDraft"/);
  assert.match(body, /buildSaleReturnDraft\(/);
  assert.match(body, /saleReturnFingerprint\(/);
  assert.match(body, /disabled=\{saving \|\| !canSave\}/);
  assert.doesNotMatch(body, /Number\(invoiceId\)/);
  assert.doesNotMatch(body, /salesHistory/);
});

test("a Cashier's return asks the Owner or an Admin first, with the same check a bill cancel uses", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("function SaleReturnModule(");
  const body = app.slice(start, app.indexOf("\nfunction ", start + 10));
  assert.match(body, /<SaleChangeApprovalFields/);
  assert.match(body, /requestSaleChangeApproval\(user, \{\s*action: "return",\s*saleRef: invoiceId/);
  assert.match(body, /approval_id: pendingWrite\.current\.approvalId/);
  assert.match(app, /<SaleReturnModule\s+approvalRoute=\{resolveSaleChangeRoute\(\{ user, offlineMode, connectivityMode \}\)\}/);
});
