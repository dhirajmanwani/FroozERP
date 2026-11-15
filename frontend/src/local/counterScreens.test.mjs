// Phase 3 polish: the counter screens' words and figures (counterScreens.js), and the App.jsx
// wiring that puts them on screen. Display only: nothing here bills, saves or sends.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  billDateHint,
  countPhrase,
  counterQuantity,
  counterQuantityWithUnit,
  invoiceCloseLabel,
  lotShortMessage,
  orderSavedText,
  ordersNeedCheckingText,
  posRateLabel,
  posTileStockLine,
  returnInvoiceOptionLabel,
  returnItemsText,
  shouldShowLotFilters,
} from "./counterScreens.js";

const rupees = (value) => `₹${Number(value).toFixed(2)}`;

test("a count agrees with its noun, and an unknown count is a dash, never 0", () => {
  assert.equal(countPhrase(1, "lot"), "1 lot");
  assert.equal(countPhrase(4, "lot"), "4 lots");
  assert.equal(countPhrase(0, "lot"), "0 lots");
  assert.equal(countPhrase(undefined, "lot"), "— lots");
});

test("a quantity reads up to 3 decimals without trailing zeros, with the unit as people say it", () => {
  assert.equal(counterQuantity(68), "68");
  assert.equal(counterQuantity(0.75), "0.75");
  assert.equal(counterQuantity(1.23456), "1.235");
  assert.equal(counterQuantity("abc"), "—");
  assert.equal(counterQuantityWithUnit(68, "KG"), "68 Kg");
  assert.equal(counterQuantityWithUnit(6, "PCS"), "6 Piece");
  assert.equal(counterQuantityWithUnit(2, ""), "2", "a blank unit is left off, never invented");
  assert.equal(counterQuantityWithUnit(null, "KG"), "—");
});

test("a POS tile says its stock once, with its unit and its lots", () => {
  assert.equal(posTileStockLine({ stock: 68, unit: "KG", lotCount: 4 }), "68 Kg · 4 lots");
  assert.equal(posTileStockLine({ stock: 0.75, unit: "KG", lotCount: 1 }), "0.75 Kg · 1 lot");
  assert.equal(posTileStockLine({ stock: 12, unit: "BOX", lotCount: 2 }), "12 Box · 2 lots");
});

test("a tile's rate is one figure or an en-dash range per unit, and an unknown rate is not ₹0", () => {
  assert.equal(posRateLabel({ min: 30, max: 30, unit: "PCS", format: rupees }), "₹30.00 / Piece");
  assert.equal(posRateLabel({ min: 170, max: 180, unit: "KG", format: rupees }), "₹170.00–₹180.00 / Kg");
  assert.equal(posRateLabel({ min: 180, max: 170, unit: "KG", format: rupees }), "₹170.00–₹180.00 / Kg", "a reversed pair still reads low to high");
  assert.equal(posRateLabel({ min: 0, max: 0, unit: "KG", format: rupees }), "—");
  assert.equal(posRateLabel({ min: undefined, unit: "KG", format: rupees }), "—");
  assert.doesNotMatch(posRateLabel({ min: 1, max: 2, unit: "KG", format: rupees }), / - /);
});

test("the lot picker's filters show only when there is something to choose between", () => {
  assert.equal(shouldShowLotFilters({ sizes: ["Large"], units: ["KG"] }), false);
  assert.equal(shouldShowLotFilters({ sizes: [], units: [] }), false);
  assert.equal(shouldShowLotFilters({ sizes: ["Large", "Small"], units: ["KG"] }), true);
  assert.equal(shouldShowLotFilters({ sizes: ["Large"], units: ["KG", "BOX"] }), true);
  assert.equal(shouldShowLotFilters(), false);
});

test("a lot that cannot take more says how much is left, in its unit, and names the lot", () => {
  assert.equal(lotShortMessage({ more: 0.75, unit: "KG", lotName: "Chiku lot 1" }), "Only 0.75 Kg more is left in lot Chiku lot 1.");
  assert.equal(lotShortMessage({ more: 0, unit: "KG", lotName: "L2" }), "Nothing more is left in lot L2.");
  assert.equal(lotShortMessage({ more: 3, unit: "PCS" }), "Only 3 Piece more is left in this lot.");
  assert.doesNotMatch(lotShortMessage({ more: 0.75, unit: "KG", lotName: "x" }), /units/);
});

test("Orders: the checking line agrees in number, and Save order is confirmed by name", () => {
  assert.equal(ordersNeedCheckingText(1), "1 order needs checking.");
  assert.equal(ordersNeedCheckingText(3), "3 orders need checking.");
  assert.equal(orderSavedText({ orderNo: "ORD-20261115-123456", customerName: "Sunita Sharma" }), "Order ORD-20261115-123456 for Sunita Sharma is saved. Its stock is set aside.");
  assert.equal(orderSavedText({}), "The order is saved. Its stock is set aside.");
});

test("Sale Returns: a bill in the picker reads the Indian way, and history items carry their unit", () => {
  const label = returnInvoiceOptionLabel(
    { id: "s1", invoice_no: "141126-001", sale_date: "2026-11-14", customer_name: "", amount: 540 },
    { formatDate: () => "14/11/2026", formatMoney: rupees },
  );
  assert.equal(label, "141126-001 · 14/11/2026 · Walk-in · ₹540.00");
  assert.equal(returnInvoiceOptionLabel({ id: "7" }), "Bill #7 · Walk-in");
  assert.equal(
    returnItemsText([{ product_name: "Apple", return_quantity: 0.5, unit: "KG" }, { product_name: "Kiwi", return_quantity: 2, unit: "PCS" }]),
    "Apple × 0.5 Kg, Kiwi × 2 Piece",
  );
  assert.equal(returnItemsText(null), "");
});

test("the saved bill's way out says New bill at the till and Close elsewhere", () => {
  assert.equal(invoiceCloseLabel({ fromPos: true }), "New bill");
  assert.equal(invoiceCloseLabel({ fromPos: false }), "Close");
  assert.equal(invoiceCloseLabel(), "Close");
});

test("the bill-date hint speaks only when it helps", () => {
  assert.equal(billDateHint({ canChange: false }), "Bill date is locked for your role.");
  assert.equal(billDateHint({ canChange: true, edited: false }), "");
  assert.match(billDateHint({ canChange: true, edited: true }), /not now/);
});

// ------------------------------------------------------------------------------------------------
// Wiring. These keep the helpers above from silently falling out of App.jsx in a later edit.
// ------------------------------------------------------------------------------------------------

const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
const appCss = readFileSync(new URL("../App.css", import.meta.url), "utf8");
const functionBody = (name) => {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} found`);
  return app.slice(start, app.indexOf("\nfunction ", start + 10));
};
const nativeDialog = /window\.(confirm|prompt|alert)\(|[^.\w](alert|confirm|prompt)\(/;

test("the counter screens use the app's own notices and boxes, never the browser's", () => {
  for (const name of ["PosBilling", "DiscountApprovalModal", "InvoiceModal", "PdfPreviewModal", "SaleEditModal", "SaleReturnModule", "OrdersModule", "DailyPriceListPanel"]) {
    assert.doesNotMatch(functionBody(name), nativeDialog, name);
  }
  // The App-level bill view, print, edit-open and cancel paths.
  const appStart = app.indexOf("  const loadInvoice = async (saleId, options = {}) => {");
  const appEnd = app.indexOf("  const selectPurchaseProduct = ", appStart);
  assert.ok(appStart > 0 && appEnd > appStart);
  assert.doesNotMatch(app.slice(appStart, appEnd), nativeDialog);
  const editOpen = app.slice(app.indexOf("  const openSaleForEditFromReport = async"), app.indexOf("  const openSaleForEditFromReport = async") + 600);
  assert.doesNotMatch(editOpen, nativeDialog);
  assert.match(app, /\{saleActionProblem && \(/, "a bill that could not be opened is said in a window");
});

test("POS: one stock line per tile, the scale panel only with a scale, and lot filters only when useful", () => {
  const pos = functionBody("PosBilling");
  assert.match(pos, /posTileStockLine\(\{ stock, unit: product\.unit, lotCount: activeLots\.length \}\)/);
  assert.match(pos, /posRateLabel\(\{ min: minRate, max: maxRate, unit: product\.unit/);
  assert.match(pos, /\{posSettings\.enable_weighing_scale && \(\s*<div className="pos-mode-panel">/);
  assert.match(pos, /const showLotFilters = shouldShowLotFilters\(\{ sizes: lotSelectorSizeOptions, units: lotSelectorUnitOptions \}\)/);
  assert.match(pos, /lotShortMessage\(\{ more: moreAvailable/);
  assert.match(pos, /billDateHint\(\{ canChange: canPosDateOverride, edited: billDateEdited \}\)/);
  // Net Payable and the checkout buttons stay in sight at the foot of the checkout panel.
  assert.match(pos, /<div className="checkout-footer">/);
  assert.match(appCss, /\.checkout-footer \{[^}]*position: sticky;/);
});

test("the approver's Username has the focus when the discount approval opens", () => {
  assert.match(functionBody("SaleChangeApprovalFields"), /autoFocus=\{autoFocus\}/);
  assert.match(functionBody("DiscountApprovalModal"), /<SaleChangeApprovalFields\s+autoFocus/);
});

test("the saved bill leads with printing, edits as a secondary action, and has a clear way out", () => {
  const modal = functionBody("InvoiceModal");
  assert.match(modal, /className=\{defaultPrintMode === "THERMAL" \? "primary-button" : "secondary-button"\}[^\n]*?<Icon name="print" \/> Thermal Print/);
  assert.match(modal, /\{canEdit && <button className="secondary-button"[^\n]*?onClick=\{onEdit\}>Edit Bill<\/button>\}/);
  assert.match(modal, /className="secondary-button invoice-done-button"[^\n]*?onClick=\{onClose\}>\{closeLabel\}</);
  assert.match(app, /closeLabel=\{invoiceCloseLabel\(\{ fromPos: activeView === "sales" \}\)\}/);
});

test("Sale Returns: Indian dates, a row that says what to do first, and a banner after saving", () => {
  const returns = functionBody("SaleReturnModule");
  assert.match(returns, /Pick an invoice above to see what can be returned\./);
  assert.match(returns, /<td>\{formatDisplayDate\(entry\.return_date\)\}<\/td>/);
  assert.match(returns, /returnItemsText\(entry\.items\)/);
  assert.match(returns, /<SaveNotice className="return-outcome" notice=\{outcome\} \/>/);
  assert.match(returns, /setOutcome\(refreshNote \? warningNotice\(/);
  assert.match(app, /const returnInvoiceLabel = \(sale\) => returnInvoiceOptionLabel\(sale, \{\s*formatDate: formatDisplayDate,/);
});

test("Orders: Save order is confirmed, Cancel order asks why in a box, and buttons sit in rows", () => {
  const orders = functionBody("OrdersModule");
  assert.match(orders, /showOrderNotice\(successNotice\(orderSavedText\(\{ orderNo: saved\.orderNo, customerName: draft\.customer_name \}\)\)\)/);
  assert.match(app, /return \{ ok: true, message: "", orderNo: saved\.order_no \|\| "" \};/);
  assert.match(orders, /ordersNeedCheckingText\(board\.needsAttention\.length\)/);
  // The reason is asked when cancelling, required, and closing the box leaves the order alone.
  assert.match(orders, /const reason = await askCancelReason\(\{[\s\S]*?tone: "danger",\s*\}\);\s*if \(reason === null\) return;/);
  assert.doesNotMatch(orders, /Reason \(if cancelling\)/);
  assert.match(orders, /action\.tone === "danger" \? "danger-text-button"/);
  assert.doesNotMatch(orders, /<p>\s*<button/, "no buttons run together in a bare paragraph");
  assert.match(appCss, /\.order-card \.carrier-top \{[^}]*justify-content: space-between;/);
});

test("Dashboard: the price list keeps to two rows and folds its settings; empty states share one look", () => {
  assert.match(app, /const PRICE_LIST_PREVIEW_ROWS = 6;/);
  assert.match(functionBody("DailyPriceListPanel"), /<details className="price-list-schedule-details">/);
  assert.match(functionBody("DashboardHighlights"), /<div className="empty-inline">No insights for this period yet\.<\/div>/);
});

test("FROST never covers a figure on the counter screens", () => {
  assert.match(app, /<div className="content-area" data-view=\{activeView\}>/);
  assert.match(appCss, /\.content-area:is\(\[data-view="dashboard"\], \[data-view="returns"\], \[data-view="orders"\], \[data-view="discounts"\]\) \{\s*padding-right:/);
  assert.match(appCss, /\.checkout-card \{[^}]*max-height: calc\(100vh - 18px - 106px - var\(--topbar-height, 0px\)\);/);
});
