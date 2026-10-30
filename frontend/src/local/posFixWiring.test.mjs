/**
 * Source-text pins for the POS fixes of 24 Oct 2026 whose logic is wiring inside App.jsx. The rules
 * themselves are tested where they live (posCheckout, posLeaveGuard, weighingScale, orderBilling,
 * checkoutRetry); these make sure App.jsx keeps calling them in the right place.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
const slice = (from, to) => {
  const start = app.indexOf(from);
  assert.ok(start > 0, `missing: ${from}`);
  const end = app.indexOf(to, start + from.length);
  assert.ok(end > start, `missing end: ${to}`);
  return app.slice(start, end);
};
const pos = slice("function PosBilling(", "\nfunction PosLeaveDialog(");
const checkout = slice("const checkout = async (printAfterSave = false, confirmations = {}) => {", "const handleSearchKeys = ");
const payload = slice("const buildLocalSalePayload = ", "const openDiscountApproval = ");
const saleEdit = slice("function SaleEditModal(", "\nfunction ");

test("POS-1: a desktop credit bill carries its due date and remarks", () => {
  assert.match(payload, /credit_due_date: paymentMode === "CREDIT" \? creditInfo\.due_date \|\| null : null,/);
  assert.match(payload, /credit_remarks: paymentMode === "CREDIT" \? creditInfo\.remarks \|\| customer\.notes \|\| "" : "",/);
});

test("POS-2: the bill is stamped with the time it is saved unless the Owner re-dated it", () => {
  assert.match(checkout, /const effectiveBillDateTime = resolvePosBillDateTime\(\{ typed: billDateTime, edited: billDateEdited, now: currentDateTimeLocal\(\) \}\);/);
  assert.match(payload, /bill_datetime: savedBillDateTime,/);
  assert.doesNotMatch(checkout, /bill_datetime: billDateTime,/);
  assert.match(pos, /setBillDateTime\(event\.target\.value\); setBillDateEdited\(true\);/);
  assert.match(pos, /window\.setInterval\(\(\) => setBillDateTime\(currentDateTimeLocal\(\)\), 30000\)/);
});

test("POS-4: the invoice is shown before the refresh, and a failed refresh is not a failed bill", () => {
  for (const [invoiceCall, savedCall] of [
    ["onInvoice(invoice, { print:", "await onSaved?.({ localSale: invoice"],
    ["onInvoice(response.data.sale, { print:", "await onSaved({ sale: response.data.sale })"],
  ]) {
    const at = checkout.indexOf(invoiceCall);
    const saved = checkout.indexOf(savedCall);
    assert.ok(at > 0 && saved > at, `${invoiceCall} comes before ${savedCall}`);
    const between = checkout.slice(at, saved);
    assert.match(between, /try \{\s*(\/\/[^\n]*\n\s*)*(if \(packingShort[^\n]*\n\s*)?$/, "onSaved sits in its own try");
  }
  assert.match(checkout, /setSaveNotice\(describeSavedBillRefreshFailure\(invoice\.invoice_no, refreshError\)\)/);
  assert.match(saleEdit, /describeSavedBillRefreshFailure\(invoice\.invoice_no, refreshError, \{ edited: true \}\)/);
});

test("POS-5: a charge that could not be priced stops checkout and disables both buttons", () => {
  assert.match(checkout, /chargeRefusalProblem\(totals\.chargeRefusals\)/);
  assert.equal((pos.match(/totals\.chargeRefusals\.length > 0\} onClick=\{\(\) => checkout\((true|false)\)\}/g) || []).length, 2);
});

test("POS-6: choosing Walk-in mid-bill keeps the bill's charges", () => {
  const select = slice("const selectCustomer = (customerId) => {", "const newSyncId = ");
  assert.doesNotMatch(select, /setChargeSelections/);
});

test("POS-7: F6 says the weight was taken only when the line took it", () => {
  const read = slice("const readScaleWeight = () => {", "const selectCustomer = ");
  assert.match(read, /scaleTargetLine\(cart, focusedLineId\)/);
  assert.match(read, /if \(updateCartItem\(target\.line_id, "quantity", kg\) === true\) \{\s*setTakenScaleReading/);
  const update = slice("const updateCartItem = (lineId, field, value) => {", "const completeQuantityEntry = ");
  assert.doesNotMatch(update, /return;\n/, "every refusal returns false");
  assert.match(update, /return true;\n  \};\s*$/);
});

test("POS-8: tapping a fruit again with the scale on sets its line, and stock is checked by the change", () => {
  const add = slice("const addProduct = (product, selectedLot = null) => {", "const updateCartItem = ");
  assert.match(add, /scaleLineQuantity\(\{ existing: currentQuantity, added: addQuantity, fromScale: weighed !== null \}\)/);
  assert.match(add, /const nextLotQuantity = getCartQuantityForLot\(lot\.id\) \+ quantityChange;/);
  assert.doesNotMatch(add, /Number\(currentItem\?\.quantity \|\| 0\) \+ addQuantity/);
});

test("POS-13: packing that could not be counted is said on the bill", () => {
  assert.match(pos, /\{packingEnabled && packingUsage\.message && \(/);
});

test("POS-15: a desktop bill is never stamped with a made-up device id", () => {
  assert.doesNotMatch(payload, /newSyncId\("device"\)/);
  assert.match(checkout, /This computer's device id has not loaded yet\./);
});

test("POS-17 / DT-10: no sale payload coerces a product or lot id with Number()", () => {
  assert.doesNotMatch(payload, /Number\(item\.inventory_batch_id/);
  assert.doesNotMatch(saleEdit, /Number\(item\.inventory_batch_id|Number\(item\.product_id/);
});

test("POS-12 / POS-18: an edit keeps the bill's time and adds up as POS does", () => {
  assert.doesNotMatch(saleEdit, /T00:00`/);
  assert.match(saleEdit, /bill_datetime: editedBillDateTime\(invoice, billDate\),/);
  assert.match(saleEdit, /const \{ gross, itemDiscount \} = saleEditTotals\(items\);/);
  assert.match(saleEdit, /amount: editLineAmount\(item\),/);
});

test("POS-19: POS never prints by itself; the invoice's own print path does", () => {
  assert.doesNotMatch(pos, /window\.print\(/);
  assert.match(app, /setSelectedInvoicePrintMode\(options\.print \? "DEFAULT" : null\);/);
  const modal = slice("function InvoiceModal(", "function PurchaseSummary(");
  assert.match(modal, /if \(upiPayload && upiQrSettledFor !== upiPayload\) return;/, "waits for the UPI QR");
});

test("POS-20..25 polish: -₹0.00, lot left, row total, lot picker, wording", () => {
  assert.match(app, /currency\.format\(value === 0 \? 0 : value\)/);
  assert.match(pos, /left in this lot/);
  assert.match(pos, /currency\.format\(lineGross\(item\) - Number\(item\.discount_amount \|\| 0\)\)/);
  assert.doesNotMatch(pos, /<option value="ACTIVE">Active Lots<\/option>/);
  assert.doesNotMatch(pos, /Sold-out lots are reference-only/);
  assert.doesNotMatch(pos, /"Change packing"/);
  assert.match(pos, /<option value="BANK_TRANSFER">Bank Transfer<\/option>/);
  assert.match(pos, /F4 Checkout & Print/);
});
