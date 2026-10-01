import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  INVOICE_COLUMNS,
  INVOICE_FALLBACK_FOOTER,
  INVOICE_FALLBACK_SHOP_NAME,
  MANUAL_BILL_DISCOUNT_RULE_SUFFIX,
  billDiscountLabel,
  buildInvoiceLayout,
  buildInvoiceText,
  formatBillMoney,
  formatBillNumber,
  formatBillQuantity,
} from "./invoiceLayout.js";

// Test fixtures only. Every figure below is invented for these tests and never leaves this file.

// The shape `GET /sales/:id` returns: sales.* plus one sale_items row per lot allocation.
const serverSale = (overrides = {}) => ({
  id: 41,
  invoice_no: "SAMPLE-0041",
  customer_name: "Sample Customer",
  customer_mobile: "9000000000",
  created_by_name: "Sample Cashier",
  branch_name: "Sample Counter",
  payment_mode: "CASH",
  sale_status: "COMPLETED",
  gross_amount: "480.00",
  item_discount_amount: "24.00",
  invoice_discount_amount: "0.00",
  tax_amount: "0.00",
  taxable_amount: "0.00",
  mandi_tax_rate: "0.000",
  other_charges_amount: "0.00",
  total_amount: "456.00",
  items: [
    {
      id: 1, sale_item_id: 1, product_name: "Alphonso Mango", unit: "KG", quantity: "1.500",
      selling_rate: "160.00", amount: "240.00", discount_amount: "24.00", net_amount: "216.00",
      lot_name: "MANGO-20260901-001", lot_size: "Large", lot_discount_type: "PERCENTAGE", lot_discount_value: "10.00",
    },
    {
      id: 2, sale_item_id: 2, product_name: "Kiwi", unit: "BOX", quantity: "2.000",
      selling_rate: "120.00", amount: "240.00", discount_amount: "0.00", net_amount: "240.00",
      lot_name: "KIWI-20260901-002", lot_size: "", lot_discount_type: null, lot_discount_value: "0",
    },
  ],
  payments: [{ mode: "CASH", amount: "456.00", status: "SUCCESS" }],
  ...overrides,
});

// The shape `localSnapshotToInvoice` produces from the SQLite snapshot: `amount` IS the net.
const localSale = (overrides = {}) => ({
  id: "invoice-sample-1",
  invoice_no: "OFF-SAMPLE-1",
  customer_name: "Walk-in Customer",
  payment_mode: "CASH",
  sale_status: "COMPLETED",
  gross_amount: 300,
  item_discount_amount: 15,
  invoice_discount_amount: 0,
  tax_amount: 0,
  taxable_amount: 0,
  mandi_tax_rate: 0,
  total_amount: 285,
  other_charges_amount: 0,
  items: [
    { id: "line-1", product_name: "Pomegranate", unit: "KG", quantity: 2, selling_rate: 150, rate: 150, discount_amount: 15, discount: 15, amount: 285, net_amount: 285, lot_size: "" },
  ],
  payments: [{ posting_id: "p1", mode: "UPI", amount: 285 }],
  ...overrides,
});

const settings = {
  business_name: "Sample Fruit Shop",
  address: "12 Sample Road\nSample City 000000",
  phone_number: "9000000001",
  gst_number: "00SAMPLE0000Z0",
  invoice_footer_text: "Thank you, come again.",
};

const rowKeys = (layout) => layout.totals.rows.map((row) => row.key);
const row = (layout, key) => layout.totals.rows.find((entry) => entry.key === key);

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------

test("quantities carry at most three decimals with trailing zeros trimmed", () => {
  assert.equal(formatBillQuantity("1.500"), "1.5");
  assert.equal(formatBillQuantity(2), "2");
  assert.equal(formatBillQuantity(0.75), "0.75");
  assert.equal(formatBillQuantity(1.2345), "1.235");
  assert.equal(formatBillQuantity("0.125"), "0.125");
  assert.equal(formatBillQuantity(null), "—");
  assert.equal(formatBillQuantity(""), "—");
});

test("money is INR with two decimals, and missing is a dash, not zero", () => {
  assert.equal(formatBillMoney(1234.5), "₹1,234.50");
  assert.equal(formatBillMoney("125000"), "₹1,25,000.00");
  assert.equal(formatBillMoney(-12), "−₹12.00");
  assert.equal(formatBillMoney(0), "₹0.00");
  assert.equal(formatBillMoney(undefined), "—");
  assert.equal(formatBillMoney(""), "—");
  assert.equal(formatBillNumber(160), "160.00");
  assert.equal(formatBillNumber(null), "—");
});

// ---------------------------------------------------------------------------------------------
// Header and meta
// ---------------------------------------------------------------------------------------------

test("the header comes from business settings, with today's fallbacks", () => {
  const layout = buildInvoiceLayout(serverSale(), settings, { billDate: "27/09/2026", billTime: "10:42 am" });
  assert.equal(layout.header.shopName, "Sample Fruit Shop");
  assert.deepEqual(layout.header.addressLines, ["12 Sample Road", "Sample City 000000"]);
  assert.equal(layout.header.phoneText, "Ph. 9000000001");
  assert.equal(layout.header.gstinText, "GSTIN 00SAMPLE0000Z0");
  assert.equal(layout.meta.billNo, "SAMPLE-0041");
  assert.equal(layout.meta.date, "27/09/2026");
  assert.equal(layout.meta.time, "10:42 am");
  assert.equal(layout.meta.customerName, "Sample Customer");
  assert.equal(layout.meta.cashier, "Sample Cashier");
  assert.equal(layout.meta.counter, "Sample Counter");
  assert.equal(layout.footer.message, "Thank you, come again.");

  const bare = buildInvoiceLayout(localSale({ customer_name: "" }), {});
  assert.equal(bare.header.shopName, INVOICE_FALLBACK_SHOP_NAME);
  assert.deepEqual(bare.header.addressLines, []);
  assert.equal(bare.header.phoneText, "");
  assert.equal(bare.header.gstinText, "");
  assert.equal(bare.meta.customerName, "Walk-in Customer");
  assert.equal(bare.meta.cashier, "");
  assert.equal(bare.meta.date, "—");
  assert.equal(bare.footer.message, INVOICE_FALLBACK_FOOTER);
});

test("the column headings are exactly Product | Qty | Unit | Rate | Amount", () => {
  assert.deepEqual([...INVOICE_COLUMNS], ["Product", "Qty", "Unit", "Rate", "Amount"]);
  assert.deepEqual([...buildInvoiceLayout(serverSale(), settings).columns], ["Product", "Qty", "Unit", "Rate", "Amount"]);
});

test("a cancelled bill says so, with its reason", () => {
  const layout = buildInvoiceLayout(serverSale({ sale_status: "CANCELLED", cancellation_reason: "Sample reason" }), settings);
  assert.equal(layout.meta.status, "Cancelled");
  assert.equal(layout.meta.statusNote, "Sample reason");
  assert.equal(buildInvoiceLayout(serverSale(), settings).meta.status, "");
});

// ---------------------------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------------------------

test("the product is the name only; the grade is a separate note, the lot code is not shown", () => {
  const [mango, kiwi] = buildInvoiceLayout(serverSale(), settings).lines;
  assert.equal(mango.product, "Alphonso Mango");
  assert.equal(mango.note, "Large");
  assert.ok(!JSON.stringify(mango).includes("MANGO-20260901-001"));
  assert.equal(kiwi.note, "");
});

test("a percentage line discount is labelled with its percentage and the stored amount", () => {
  const [mango] = buildInvoiceLayout(serverSale(), settings).lines;
  assert.equal(mango.qtyText, "1.5");
  assert.equal(mango.unit, "Kg");
  assert.equal(mango.rateText, "160.00");
  assert.equal(mango.amountText, "240.00", "the Amount column is the line before its own discount");
  assert.equal(mango.net, 216);
  assert.deepEqual(mango.discount, {
    label: "Discount 10%",
    amount: 24,
    amountText: "−₹24.00",
    text: "Discount 10% · −₹24.00",
  });
});

test("a flat line discount reads Discount with its amount", () => {
  const sale = serverSale({
    gross_amount: "240.00", item_discount_amount: "10.00", total_amount: "230.00",
    items: [{ id: 5, sale_item_id: 5, product_name: "Kiwi", unit: "BOX", quantity: "2", selling_rate: "120.00", amount: "240.00", discount_amount: "10.00", net_amount: "230.00", lot_discount_type: "FIXED_AMOUNT", lot_discount_value: "5.00" }],
    payments: [{ mode: "CASH", amount: "230.00" }],
  });
  const [kiwi] = buildInvoiceLayout(sale, settings).lines;
  assert.equal(kiwi.discount.label, "Discount");
  assert.equal(kiwi.discount.text, "Discount · −₹10.00");
});

test("a percentage that no longer matches the amount taken is not claimed", () => {
  // A discount typed over by hand keeps the lot's type and value on the row.
  const sale = serverSale();
  sale.items[0].discount_amount = "30.00";
  sale.items[0].net_amount = "210.00";
  const [mango] = buildInvoiceLayout(sale, settings).lines;
  assert.equal(mango.discount.label, "Discount");
  assert.equal(mango.discount.amount, 30);
});

test("the local snapshot line reads its discount from `discount` and its gross as net + discount", () => {
  const [line] = buildInvoiceLayout(localSale(), settings).lines;
  assert.equal(line.amountText, "300.00");
  assert.equal(line.net, 285);
  assert.equal(line.discount.text, "Discount · −₹15.00");
});

test("with no stored discount, gross minus net is the discount; a zero difference is none", () => {
  const derived = buildInvoiceLayout(localSale({
    items: [{ id: "l", product_name: "Guava", unit: "KG", quantity: 2, selling_rate: 150, net_amount: 285 }],
  }), settings).lines[0];
  assert.equal(derived.discount.amount, 15);

  const none = buildInvoiceLayout(localSale({
    items: [{ id: "l", product_name: "Guava", unit: "KG", quantity: 2, selling_rate: 150, net_amount: 300 }],
  }), settings).lines[0];
  assert.equal(none.discount, null);
});

test("no discount means no discount line, no discount rows and no savings", () => {
  const sale = serverSale({
    gross_amount: "240.00", item_discount_amount: "0.00", total_amount: "240.00",
    items: [serverSale().items[1]],
    payments: [{ mode: "CASH", amount: "240.00" }],
  });
  const layout = buildInvoiceLayout(sale, settings);
  assert.equal(layout.lines[0].discount, null);
  assert.equal(layout.totals.reconciled, true);
  assert.deepEqual(rowKeys(layout), [], "with nothing between items and grand total, only the grand total prints");
  assert.equal(layout.totals.grandTotalText, "₹240.00");
  assert.equal(layout.savings, null);
});

test("the receipt switch for item discounts hides the line, never the money", () => {
  const layout = buildInvoiceLayout(serverSale(), { ...settings, show_item_discount_column_receipt: false });
  assert.equal(layout.lines[0].discount, null);
  assert.equal(row(layout, "total-discount").amount, -24);
  assert.equal(layout.savings.amount, 24);
});

test("unknown and missing units are words or a dash, never a raw code or blank", () => {
  const sale = localSale({
    gross_amount: 100, item_discount_amount: 0, total_amount: 100,
    items: [
      { id: "a", product_name: "Sample A", unit: "TRAY", quantity: 1, selling_rate: 60, discount: 0, net_amount: 60 },
      { id: "b", product_name: "Sample B", unit: "dozen", quantity: 1, selling_rate: 40, discount: 0, net_amount: 40 },
      { id: "c", product_name: "Sample C", unit: null, quantity: 0, selling_rate: 0, discount: 0, net_amount: 0 },
    ],
    payments: [{ mode: "CASH", amount: 100 }],
  });
  const units = buildInvoiceLayout(sale, settings).lines.map((line) => line.unit);
  assert.deepEqual(units, ["Tray", "Dozen", "—"]);
});

test("a missing rate or quantity renders a dash, not ₹0.00", () => {
  const sale = localSale({ items: [{ id: "x", product_name: "", unit: "KG", quantity: null, selling_rate: null, net_amount: null }] });
  const [line] = buildInvoiceLayout(sale, settings).lines;
  assert.equal(line.product, "—");
  assert.equal(line.qtyText, "—");
  assert.equal(line.rateText, "—");
  assert.equal(line.amountText, "—");
});

test("lot allocations of one sale line are shown as one line", () => {
  const sale = serverSale({
    gross_amount: "300.00", item_discount_amount: "30.00", total_amount: "270.00",
    items: [
      { id: 9, sale_item_id: 9, product_name: "Orange", unit: "KG", quantity: "1.250", selling_rate: "120.00", amount: "150.00", discount_amount: "15.00", net_amount: "135.00", lot_size: "Medium", lot_discount_type: "PERCENTAGE", lot_discount_value: "10" },
      { id: 9, sale_item_id: 9, product_name: "Orange", unit: "KG", quantity: "1.250", selling_rate: "120.00", amount: "150.00", discount_amount: "15.00", net_amount: "135.00", lot_size: "Large", lot_discount_type: "PERCENTAGE", lot_discount_value: "10" },
    ],
    payments: [{ mode: "CASH", amount: "270.00" }],
  });
  const layout = buildInvoiceLayout(sale, settings);
  assert.equal(layout.lines.length, 1);
  assert.equal(layout.lines[0].qtyText, "2.5");
  assert.equal(layout.lines[0].amountText, "300.00");
  assert.equal(layout.lines[0].note, "Medium · Large");
  assert.equal(layout.lines[0].discount.text, "Discount 10% · −₹30.00");
});

// ---------------------------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------------------------

test("item discounts only: Items total, Total discount on items, Grand total, and the saving", () => {
  const layout = buildInvoiceLayout(serverSale(), settings);
  assert.equal(layout.totals.reconciled, true);
  assert.deepEqual(rowKeys(layout), ["items-total", "total-discount"]);
  assert.equal(row(layout, "items-total").amountText, "₹480.00");
  assert.equal(row(layout, "total-discount").amountText, "−₹24.00");
  assert.equal(row(layout, "total-discount").note, "On items");
  assert.equal(layout.totals.grandTotalText, "₹456.00");
  assert.equal(layout.savings.text, "You saved ₹24.00 on this bill");
});

test("a bill discount only", () => {
  const sale = serverSale({
    gross_amount: "240.00", item_discount_amount: "0.00", invoice_discount_amount: "12.00", total_amount: "228.00",
    discount_rule_name: "Sample slab",
    items: [serverSale().items[1]],
    payments: [{ mode: "CASH", amount: "228.00" }],
  });
  const layout = buildInvoiceLayout(sale, settings);
  assert.deepEqual(rowKeys(layout), ["items-total", "total-discount"]);
  assert.equal(row(layout, "total-discount").note, "Bill discount · Sample slab");
  assert.equal(layout.totals.billDiscount, 12);
  assert.equal(layout.lines[0].discount, null);
  assert.equal(layout.savings.text, "You saved ₹12.00 on this bill");
});

test("the bill-discount row prints the whole bill discount; the slab's name only when the slab gave all of it", () => {
  assert.equal(MANUAL_BILL_DISCOUNT_RULE_SUFFIX, " + extra");
  assert.equal(billDiscountLabel({ discount_rule_name: "Sample slab" }), "Bill discount · Sample slab");
  assert.equal(billDiscountLabel({ discount_rule_name: "Sample slab", manual_bill_discount: 0 }), "Bill discount · Sample slab");
  // A cashier's part on top: the slab did not give all of it, so it is not named over the total.
  assert.equal(billDiscountLabel({ discount_rule_name: "Sample slab", manual_bill_discount: 15 }), "Bill discount");
  assert.equal(billDiscountLabel({ discount_rule_name: "Sample slab + extra" }), "Bill discount", "the server's stored mark");
  assert.equal(billDiscountLabel({ discount_rule_name: null, manual_bill_discount: "15.00" }), "Bill discount");
  assert.equal(billDiscountLabel({}), "Bill discount");

  // On a printed bill: slab ₹12 + cashier's ₹8 = ₹20 bill discount, one row, the total, plain label.
  const sale = serverSale({
    gross_amount: "240.00", item_discount_amount: "0.00", invoice_discount_amount: "20.00", total_amount: "220.00",
    discount_rule_name: "Sample slab + extra",
    items: [serverSale().items[1]],
    payments: [{ mode: "CASH", amount: "220.00" }],
  });
  const layout = buildInvoiceLayout(sale, settings);
  assert.deepEqual(rowKeys(layout), ["items-total", "total-discount"]);
  assert.equal(row(layout, "total-discount").note, "Bill discount");
  assert.equal(row(layout, "total-discount").amountText, "−₹20.00");
  assert.equal(layout.totals.billDiscount, 20);

  // With item discounts too, the detail row carries the label and the bill's whole bill discount.
  const both = buildInvoiceLayout(serverSale({
    gross_amount: "480.00", item_discount_amount: "24.00", invoice_discount_amount: "20.00", total_amount: "436.00",
    discount_rule_name: "Sample slab", manual_bill_discount: 8,
    payments: [{ mode: "CASH", amount: "436.00" }],
  }), settings);
  assert.equal(row(both, "bill-discount").label, "Bill discount");
  assert.equal(row(both, "bill-discount").amountText, "₹20.00");
});

test("item and bill discounts together, with tax and charges, all foot to the grand total", () => {
  const sale = serverSale({
    gross_amount: "480.00", item_discount_amount: "24.00", invoice_discount_amount: "20.00",
    taxable_amount: "436.00", mandi_tax_rate: "1.000", tax_amount: "4.36", other_charges_amount: "30.00",
    total_amount: "470.36",
    payments: [{ mode: "UPI", amount: "400.00" }, { mode: "CASH", amount: "70.36" }],
  });
  const layout = buildInvoiceLayout(sale, settings);
  assert.equal(layout.totals.reconciled, true);
  assert.deepEqual(rowKeys(layout), ["items-total", "total-discount", "item-discounts", "bill-discount", "tax", "charges"]);
  assert.equal(row(layout, "total-discount").amountText, "−₹44.00");
  assert.equal(row(layout, "item-discounts").amountText, "₹24.00");
  assert.equal(row(layout, "bill-discount").amountText, "₹20.00");
  assert.equal(row(layout, "tax").label, "Mandi tax (1%)");
  assert.equal(row(layout, "tax").note, "", "taxed on the discounted value, which is already on the bill");
  assert.equal(row(layout, "charges").amountText, "₹30.00");
  assert.equal(layout.savings.amountText, "₹44.00");

  const printed = layout.totals.itemsTotal - layout.totals.totalDiscount + layout.totals.tax + layout.totals.charges;
  assert.equal(Math.round(printed * 100), Math.round(layout.totals.grandTotal * 100));
});

test("tax on a different basis says what it was charged on", () => {
  const sale = serverSale({
    taxable_amount: "480.00", mandi_tax_rate: "1.5", tax_amount: "7.20", total_amount: "463.20",
    payments: [{ mode: "CASH", amount: "463.20" }],
  });
  const tax = row(buildInvoiceLayout(sale, settings), "tax");
  assert.equal(tax.label, "Mandi tax (1.5%)");
  assert.equal(tax.note, "On ₹480.00");
});

test("round-off is printed signed and is part of the reconcile", () => {
  const up = buildInvoiceLayout(serverSale({ round_off: "0.28", total_amount: "456.28", payments: [{ mode: "CASH", amount: "456.28" }] }), settings);
  assert.equal(up.totals.reconciled, true);
  assert.equal(row(up, "round-off").amountText, "+₹0.28");

  const down = buildInvoiceLayout(serverSale({
    tax_amount: "4.56", mandi_tax_rate: "1", taxable_amount: "456.00", round_off: "-0.56", total_amount: "460.00",
    payments: [{ mode: "CASH", amount: "460.00" }],
  }), settings);
  assert.equal(down.totals.reconciled, true);
  assert.equal(row(down, "round-off").amountText, "−₹0.56");

  const wrong = buildInvoiceLayout(serverSale({ round_off: "0.50", total_amount: "456.00" }), settings);
  assert.equal(wrong.totals.reconciled, false);
});

test("a bill whose stored figures do not add up prints only its stored grand total", () => {
  // An old record: gross_amount was added later with DEFAULT 0, so it reads 0 on a bill worth 456.
  const sale = serverSale({ gross_amount: "0.00", item_discount_amount: "0.00" });
  const layout = buildInvoiceLayout(sale, settings);
  assert.equal(layout.totals.reconciled, false);
  assert.deepEqual(layout.totals.rows, [], "no breakdown line that cannot be reconciled");
  assert.equal(layout.totals.itemsTotal, null);
  assert.equal(layout.totals.grandTotalText, "₹456.00", "the stored grand total, not a recomputed one");
  assert.equal(layout.savings, null, "no saving is claimed from figures that do not add up");
  assert.equal(layout.issues.length, 1);
  assert.match(buildInvoiceText(layout), /Grand total: ₹456\.00/);
  assert.doesNotMatch(buildInvoiceText(layout), /Items total|saved/);

  const offByARupee = buildInvoiceLayout(serverSale({ total_amount: "457.00" }), settings);
  assert.equal(offByARupee.totals.reconciled, false);
  assert.equal(offByARupee.totals.grandTotalText, "₹457.00");
});

test("a missing grand total is a dash and an issue, never ₹0.00", () => {
  const layout = buildInvoiceLayout(serverSale({ total_amount: null }), settings);
  assert.equal(layout.totals.reconciled, false);
  assert.equal(layout.totals.grandTotalText, "—");
  assert.deepEqual(layout.totals.rows, []);
  assert.equal(layout.issues.length, 1);
});

test("a locally billed gross carrying fractional paise still reconciles, and the rows foot exactly", () => {
  // qty x rate on weighed fruit: 0.755 x 133 = 100.415 and 0.377 x 133.5 = 50.3295. The till stores
  // the unrounded gross and rounds the total. The printed rows must still add up to the paisa.
  const gross = 0.755 * 133 + 0.377 * 133.5;
  const sale = localSale({
    gross_amount: gross,
    item_discount_amount: 10.04,
    total_amount: Math.round((gross - 10.04) * 100) / 100,
    items: [
      { id: "a", product_name: "Sample A", unit: "KG", quantity: 0.755, selling_rate: 133, discount: 10.04, net_amount: 90.38 },
      { id: "b", product_name: "Sample B", unit: "KG", quantity: 0.377, selling_rate: 133.5, discount: 0, net_amount: 50.33 },
    ],
    payments: [{ mode: "CASH", amount: Math.round((gross - 10.04) * 100) / 100 }],
  });
  const layout = buildInvoiceLayout(sale, settings);
  assert.equal(layout.totals.reconciled, true);
  assert.equal(layout.lines[0].qtyText, "0.755");
  assert.equal(layout.lines[1].qtyText, "0.377");
  const paise = (value) => Math.round(value * 100);
  assert.equal(paise(layout.totals.itemsTotal) - paise(layout.totals.totalDiscount), paise(layout.totals.grandTotal));
});

test("a bill with no stored gross reconciles from its lines, or not at all", () => {
  const good = buildInvoiceLayout(localSale({ gross_amount: null }), settings);
  assert.equal(good.totals.reconciled, true);
  assert.equal(good.totals.itemsTotal, 300);

  const bad = buildInvoiceLayout(localSale({ gross_amount: null, total_amount: 280 }), settings);
  assert.equal(bad.totals.reconciled, false);
});

// ---------------------------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------------------------

test("a single payment reads Paid with its mode", () => {
  const layout = buildInvoiceLayout(localSale(), settings);
  assert.deepEqual(layout.payment.rows.map((entry) => [entry.label, entry.amountText]), [["Paid · UPI", "₹285.00"]]);
});

test("a split payment lists each mode and the paid total", () => {
  const sale = serverSale({ payments: [{ mode: "UPI", amount: "400.00" }, { mode: "CASH", amount: "56.00" }] });
  const layout = buildInvoiceLayout(sale, settings);
  assert.deepEqual(layout.payment.rows.map((entry) => [entry.label, entry.amountText]), [["UPI", "₹400.00"], ["Cash", "₹56.00"], ["Paid", "₹456.00"]]);
});

test("a credit bill shows what was paid and the balance due", () => {
  const sale = serverSale({ payment_mode: "CREDIT", payments: [{ mode: "CREDIT", amount: "456.00" }] });
  const layout = buildInvoiceLayout(sale, settings);
  assert.deepEqual(layout.payment.rows.map((entry) => [entry.label, entry.amountText]), [["Paid", "₹0.00"], ["Balance due", "₹456.00"]]);
});

test("with no payment rows the mode is named and no paid figure is invented", () => {
  const layout = buildInvoiceLayout(serverSale({ payments: [] }), settings);
  assert.deepEqual(layout.payment.rows.map((entry) => [entry.label, entry.amountText]), [["Payment", "Cash"]]);
  assert.equal(layout.payment.paid, null);
});

// ---------------------------------------------------------------------------------------------
// Plain text (WhatsApp)
// ---------------------------------------------------------------------------------------------

test("the text bill has the same structure as the printed one", () => {
  const sale = serverSale({
    invoice_discount_amount: "20.00", total_amount: "436.00",
    payments: [{ mode: "CASH", amount: "436.00" }],
  });
  const message = buildInvoiceText(buildInvoiceLayout(sale, settings, { billDate: "27/09/2026", billTime: "10:42 am" }));
  assert.match(message, /^\*Sample Fruit Shop\*/);
  assert.match(message, /Bill SAMPLE-0041/);
  assert.match(message, /Alphonso Mango \(Large\)\n {2}1\.5 Kg x ₹160\.00 = ₹240\.00\n {2}Discount 10%: -₹24\.00/);
  assert.match(message, /Kiwi\n {2}2 Box x ₹120\.00 = ₹240\.00\n/);
  assert.match(message, /Items total: ₹480\.00/);
  assert.match(message, /Total discount: -₹44\.00/);
  assert.match(message, /\*Grand total: ₹436\.00\*/);
  assert.match(message, /Paid · Cash: ₹436\.00/);
  assert.match(message, /\*You saved ₹44\.00 on this bill\*/);
  assert.match(message, /Thank you, come again\./);
  assert.doesNotMatch(message, /−/, "plain hyphen minus in text, so it copies anywhere");
});

test("a long text bill stays inside WhatsApp's caption limit and keeps its totals", () => {
  const items = Array.from({ length: 60 }, (_, index) => ({
    id: `l${index}`, product_name: `Sample fruit number ${index + 1}`, unit: "KG", quantity: 1, selling_rate: 10, discount: 0, net_amount: 10,
  }));
  const sale = localSale({ gross_amount: 600, item_discount_amount: 0, invoice_discount_amount: 30, total_amount: 570, items, payments: [{ mode: "CASH", amount: 570 }] });
  const message = buildInvoiceText(buildInvoiceLayout(sale, settings));
  assert.ok(message.length <= 1000, `caption is ${message.length} characters`);
  assert.match(message, /\+ \d+ more items \(full bill in the PDF\)/);
  assert.match(message, /\*Grand total: ₹570\.00\*/);
  assert.match(message, /You saved ₹30\.00/);
});

// ---------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------

test("the invoice modal draws from the model, and so does its WhatsApp caption", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /import \{[^}]*buildInvoiceLayout[^}]*\} from "\.\/local\/invoiceLayout";/);
  const modal = app.slice(app.indexOf("function InvoiceModal("), app.indexOf("function PurchaseSummary("));
  assert.ok(modal.length > 0);
  assert.match(modal, /buildInvoiceLayout\(invoice, printSettings, \{/);
  assert.match(modal, /buildInvoiceText\(layout\)/);
  assert.match(modal, /<InvoiceBill\b/);
  // The old renderer read line money straight off the sale; nothing in the modal should now.
  assert.doesNotMatch(modal, /item\.net_amount|item\.discount_amount|invoice\.gross_amount/);
});
