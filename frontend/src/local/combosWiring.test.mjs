import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Source-text guards for the Combos & Offers wiring in App.jsx: the parts that only work if they
// stay in a particular place, and that no other suite would notice moving.
const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

const slice = (from, to) => {
  const start = app.indexOf(from);
  assert.ok(start >= 0, `missing: ${from}`);
  const end = app.indexOf(to, start + from.length);
  assert.ok(end > start, `missing after ${from}: ${to}`);
  return app.slice(start, end);
};

test("POS gets combos from their own state, and only on the desktop", () => {
  assert.match(app, /combos=\{isTauriRuntime\(\) \? posCombos : null\}/);
  assert.match(app, /setPosCombos\(readCombos\(snapshot\)\)/);
  // Combos never ride on the shared shelf: the shelf keeps its four writers.
  assert.equal((app.match(/setPosShelf\(/g) || []).length, 4);
});

test("every desktop sale payload carries the eight combo fields from the one mapper", () => {
  assert.match(app, /items: cart\.map\(\(item, index\) => \{[\s\S]{0,4000}?\.\.\.comboLineFields\(item, index\),/);
  assert.match(app, /\.\.\.comboLineFields\(item\),/);
  // The browser POS sends no combo fields (the server refuses them there), only the line's place.
  const browser = slice("const saleWrite = createOperationalWrite(user, {", "customer,");
  assert.doesNotMatch(browser, /comboLineFields|combo_line_key/);
  assert.match(browser, /line_index: index,/);
});

test("the shelf takes off every line sold from a lot, not just the first", () => {
  const take = slice("const takeSold = (rows) => rows.map((lot) => {", "setInventory(takeSold);");
  assert.match(take, /\.filter\(\(item\) => inventoryIdsEqual\(item\.inventory_batch_id, lot\.id\)\)/);
  assert.doesNotMatch(take, /\.find\(/);
});

test("a combo bill is refused for edit before the form opens and again at save", () => {
  const load = slice("const loadSaleForEdit = async (saleId) => {", "const loadChangeHistory = async");
  assert.equal((load.match(/if \(saleHasCombos\([^)]*\)\) \{\s*setSaleEditError\(COMBO_EDIT_REFUSAL\);/g) || []).length, 2);
  const save = slice("const saveChange = async () => {", "const composed = composeSaleChangeReason(");
  assert.match(save, /if \(saleHasCombos\(invoice\)\) \{\s*setChangeError\(COMBO_EDIT_REFUSAL\);\s*return;/);
  assert.match(app, /canEdit=\{canEditSales && selectedInvoice\.sale_status !== "CANCELLED" && !saleHasCombos\(selectedInvoice\)\}/);
  assert.match(app, /\{!canEdit && editRefusal && <span className="form-note invoice-edit-refusal" role="note">\{editRefusal\}<\/span>\}/);
});

test("a combo line's return box is shut, with the reason beside it", () => {
  const table = slice("const inCombo = isComboLine(item);", "</DataTable>");
  assert.match(table, /disabled=\{saving \|\| inCombo \|\|/);
  assert.match(table, /\{COMBO_RETURN_REFUSAL\}/);
});

test("the Combos screen and the Sale Rate combos section never reach the server where they must not", () => {
  const screen = slice("function CombosModule(", "\nfunction SaleRateCombos(");
  const section = slice("function SaleRateCombos(", "\nfunction DiscountManagementModule(");
  for (const body of [screen, section]) {
    assert.match(body, /useEffect\(\(\) => \{\n\s*if \(unavailableReason\) return;/);
    assert.doesNotMatch(body, /\b(alert|confirm|prompt)\(/);
    assert.doesNotMatch(body, /created_by|updated_by|x-user-id/);
    assert.match(body, /buildComboPayload\(/);
  }
  // Local Only, no cloud and offline each make both say why instead of loading.
  assert.match(app, /const comboUnavailableReason = resolveComboAvailability\(\{\s*localOnly: connectivityMode === CONNECTIVITY_MODES\.LOCAL_ONLY,/);
  assert.equal((app.match(/unavailableReason=\{comboUnavailableReason\}/g) || []).length, 2);
});

test("the bill prints a combo once, at its one price, with its items by name and quantity", () => {
  const bill = slice("function InvoiceBill(", "\nfunction InvoiceModal(");
  assert.match(bill, /layout\.blocks/);
  assert.match(bill, /block\.kind === "combo"/);
  const items = slice("{block.components.map((part) => (", "</tbody>");
  assert.doesNotMatch(items, /rateText|amountText/);
});

test("POS prices combo lines and the bill discount the way the server does", () => {
  // The bill discount's room is the loose items' subtotal, and a combo-only bill has none.
  const totals = slice("const slabMeasure = slabBase(cart);", "const manualBillDiscount = manualBill.error ? 0 : manualBill.amount;");
  assert.match(totals, /itemsSubtotal: slabMeasure\.subtotalAfterItems,/);
  assert.match(totals, /value: comboOnlyBill \? "" : billDiscountInput\.value,/);
  assert.match(app, /disabled=\{cart\.length === 0 \|\| saving \|\| cart\.every\(isComboLine\)\}/);
  assert.match(app, /Bill discount is for loose items; combos already have their price\./);
  // A combo line's payload amount is the exact half-up amount; a loose line's is as before.
  assert.match(app, /amount: isComboLine\(item\)\s*\? roundUi\(lineGross\(item\) - Number\(item\.discount_amount \|\| 0\)\)\s*: roundUi\(Number\(item\.quantity\) \* Number\(item\.selling_rate\) - Number\(item\.discount_amount \|\| 0\)\),/);
});

test("combo rows read as one line each, and the badge counts combos once", () => {
  assert.match(app, /itemCount: cartItemCount\(cart\),/);
  const row = slice("const renderComboItemRow = (item) => {", "const renderCartRow = (item) => {");
  assert.match(row, /<td colSpan=\{cartColumnCount\}>/);
  // Only a customer's-choice item has a quantity box.
  assert.match(row, /\{!fixedCombo && \(\s*<span className="cart-combo-item-controls">/);
  // Sale Returns: the refusal is a full-width row under the combo, never inside the quantity cell.
  const returns = slice("const inCombo = isComboLine(item);", "</DataTable>");
  assert.match(returns, /<tr className="return-combo-note">\s*<td colSpan="7">/);
  assert.doesNotMatch(returns, /inCombo && !lineProblem/);
});

test("combos whose fruit is missing ring the bell and are named on POS; the form offers stocked fruit only", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const memo = app.slice(app.indexOf("const comboProblems = useMemo("), app.indexOf("const raisedComboRows"));
  // Unknown is not "all fine": nothing is judged before the shelf and the combos were read.
  assert.match(memo, /posCombos\.status !== "ready" \|\| !posShelf\.loaded\) return null/);
  assert.match(memo, /if \(!shelfState\.usable\) return null/);
  assert.match(memo, /comboStockProblems\(\{ combos: posCombos\.combos/);
  const effect = app.slice(app.indexOf("const raisedComboRows"), app.indexOf("Read today's payments"));
  assert.match(effect, /comboStockNotifications\(comboProblems\)/);
  assert.match(effect, /clearNotice\(key\)/, "a combo that is fixed drops out of the bell");
  assert.match(app, /comboProblems=\{comboProblems\}/);
  assert.match(app, /const productChoices = comboPickableProducts\(products\);/);
  assert.match(app, /emptyComboTabMessage\(\{/);
});

test("combo reminders ring only for the Owner and Admins, and a dismissal is remembered on this computer (BO-9)", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const effect = app.slice(app.indexOf("const raisedComboRows"), app.indexOf("Read today's payments"));
  assert.match(effect, /const comboBellAllowed = isRateManagerRole\(user\?\.role\);/);
  assert.match(effect, /if \(!comboBellAllowed\) \{/);
  assert.match(effect, /if \(dismissed\.has\(row\.dedupeKey\)\) continue;/);
  assert.match(effect, /pruneDismissedStockReminders\(dismissed, \[\.\.\.live\], isComboStockReminderKey\)/);
});
