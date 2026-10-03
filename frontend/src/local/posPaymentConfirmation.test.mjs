import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_UPI_PAYEE_NAME,
  PAYMENT_MISMATCH_ERROR,
  PAYMENT_TOTAL_UNREADABLE_ERROR,
  buildPosPayments,
  buildUpiPayload,
  describePaymentConfirmation,
  formatRupees,
  invoiceUpiNote,
  resolveInvoiceUpiQr,
  upiQrAmount,
} from "./posPaymentConfirmation.js";

const EMPTY_MIXED = { CASH: "", UPI: "", CARD: "", BANK_TRANSFER: "" };
const QR_ON = { enable_upi_qr_on_invoice: true, business_upi_id: "frooz@okaxis" };

// The Checkout code this module replaces, copied from App.jsx, so the two can be compared.
const legacyCheckoutPayments = ({ paymentMode, mixedPayments, total }) => {
  const payments = paymentMode === "MIXED"
    ? Object.entries(mixedPayments)
      .filter(([, amount]) => Number(amount) > 0)
      .map(([mode, amount]) => ({ mode, amount: Number(amount) }))
    : [{ mode: paymentMode, amount: total }];
  const paidAmount = payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
  const error = Math.abs(paidAmount - total) > 0.01 ? "Payment amounts must match the tax-inclusive invoice total." : null;
  return { payments, error };
};

// ---------------------------------------------------------------------------------------------
// buildPosPayments
// ---------------------------------------------------------------------------------------------

test("buildPosPayments: single-mode bill is one row for the whole total", () => {
  for (const paymentMode of ["CASH", "UPI", "CARD", "BANK_TRANSFER", "CREDIT"]) {
    const input = { paymentMode, mixedPayments: EMPTY_MIXED, total: 456 };
    assert.deepEqual(buildPosPayments(input), legacyCheckoutPayments(input));
    assert.deepEqual(buildPosPayments(input), { payments: [{ mode: paymentMode, amount: 456 }], error: null });
  }
});

test("buildPosPayments: balanced mixed matches the old Checkout rows, blank and zero modes dropped", () => {
  const input = { paymentMode: "MIXED", mixedPayments: { CASH: "56", UPI: "400", CARD: "", BANK_TRANSFER: "0" }, total: 456 };
  const result = buildPosPayments(input);
  assert.deepEqual(result, legacyCheckoutPayments(input));
  assert.deepEqual(result.payments, [{ mode: "CASH", amount: 56 }, { mode: "UPI", amount: 400 }]);
  assert.equal(result.error, null);
});

test("buildPosPayments: mixed within the ₹0.01 tolerance is accepted, as before", () => {
  const input = { paymentMode: "MIXED", mixedPayments: { CASH: "56.005", UPI: "400", CARD: "", BANK_TRANSFER: "" }, total: 456 };
  assert.deepEqual(buildPosPayments(input), legacyCheckoutPayments(input));
  assert.equal(buildPosPayments(input).error, null);
});

test("buildPosPayments: unbalanced mixed gives the same error text as the old Checkout", () => {
  for (const mixedPayments of [
    { CASH: "50", UPI: "400", CARD: "", BANK_TRANSFER: "" },
    { CASH: "100", UPI: "400", CARD: "", BANK_TRANSFER: "" },
    EMPTY_MIXED,
  ]) {
    const input = { paymentMode: "MIXED", mixedPayments, total: 456 };
    assert.deepEqual(buildPosPayments(input), legacyCheckoutPayments(input));
    assert.equal(buildPosPayments(input).error, PAYMENT_MISMATCH_ERROR);
  }
  assert.equal(PAYMENT_MISMATCH_ERROR, "Payment amounts must match the tax-inclusive invoice total.");
});

test("buildPosPayments: an unreadable total is refused, never saved as a silent success", () => {
  for (const total of [Number.NaN, undefined, null, Infinity, "abc"]) {
    assert.equal(buildPosPayments({ paymentMode: "CASH", mixedPayments: EMPTY_MIXED, total }).error, PAYMENT_TOTAL_UNREADABLE_ERROR);
  }
  assert.equal(buildPosPayments({ paymentMode: "MIXED", mixedPayments: { CASH: "10" }, total: Number.NaN }).error, PAYMENT_TOTAL_UNREADABLE_ERROR);
});

// ---------------------------------------------------------------------------------------------
// upiQrAmount
// ---------------------------------------------------------------------------------------------

test("upiQrAmount: cash bill has no QR", () => {
  assert.equal(upiQrAmount({ paymentMode: "CASH", payments: [{ mode: "CASH", amount: 456 }] }), null);
});

test("upiQrAmount: UPI bill asks for the full amount", () => {
  assert.equal(upiQrAmount({ paymentMode: "UPI", payments: [{ mode: "UPI", amount: 456 }] }), 456);
  assert.equal(upiQrAmount({ paymentMode: "UPI", payments: [{ mode: "UPI", amount: 100.1 }, { mode: "UPI", amount: 0.2 }] }), 100.3);
});

test("upiQrAmount: mixed 400 UPI + 56 cash asks only for 400", () => {
  const { payments } = buildPosPayments({ paymentMode: "MIXED", mixedPayments: { CASH: "56", UPI: "400", CARD: "", BANK_TRANSFER: "" }, total: 456 });
  const amount = upiQrAmount({ paymentMode: "MIXED", payments });
  assert.equal(amount, 400);
  const payload = buildUpiPayload({ upiId: "frooz@okaxis", amount, note: "FroozERP-Invoice-POS-1" });
  assert.match(payload, /&am=400\.00&/);
  assert.doesNotMatch(payload, /am=456/);
});

test("upiQrAmount: card, bank transfer and credit have no QR", () => {
  assert.equal(upiQrAmount({ paymentMode: "CARD", payments: [{ mode: "CARD", amount: 456 }] }), null);
  assert.equal(upiQrAmount({ paymentMode: "BANK_TRANSFER", payments: [{ mode: "BANK_TRANSFER", amount: 456 }] }), null);
  assert.equal(upiQrAmount({ paymentMode: "CREDIT", payments: [{ mode: "CREDIT", amount: 456 }] }), null);
  assert.equal(upiQrAmount({ paymentMode: "MIXED", payments: [{ mode: "CASH", amount: 56 }, { mode: "CARD", amount: 400 }] }), null);
});

test("upiQrAmount: zero, negative and NaN amounts give no QR", () => {
  for (const amount of [0, -5, Number.NaN, "", null, undefined, "abc"]) {
    assert.equal(upiQrAmount({ paymentMode: "UPI", payments: [{ mode: "UPI", amount }] }), null, `amount ${String(amount)}`);
  }
  assert.equal(upiQrAmount({ paymentMode: "UPI", payments: [] }), null);
  assert.equal(upiQrAmount({ paymentMode: "UPI" }), null);
});

test("upiQrAmount: reads saved-invoice rows (payment_mode) and skips voided rows", () => {
  const payments = [
    { payment_mode: "cash", amount: "56.00" },
    { payment_mode: "UPI", amount: "400.00" },
    { payment_mode: "UPI", amount: "999.00", status: "CANCELLED" },
  ];
  assert.equal(upiQrAmount({ paymentMode: "MIXED", payments }), 400);
  assert.equal(upiQrAmount({ paymentMode: "", payments }), 400);
});

test("upiQrAmount: rounds to 2 decimals", () => {
  assert.equal(upiQrAmount({ paymentMode: "UPI", payments: [{ mode: "UPI", amount: 123.456 }] }), 123.46);
});

// ---------------------------------------------------------------------------------------------
// buildUpiPayload
// ---------------------------------------------------------------------------------------------

test("buildUpiPayload: same field order and encoding as the invoice QR", () => {
  assert.equal(
    buildUpiPayload({ upiId: "frooz@okaxis", amount: 456, note: "FroozERP-Invoice-INV-7" }),
    "upi://pay?pa=frooz%40okaxis&pn=FEEL%20THE%20FREAKIN'%20FROOZ&am=456.00&cu=INR&tn=FroozERP-Invoice-INV-7",
  );
  assert.equal(DEFAULT_UPI_PAYEE_NAME, "FEEL THE FREAKIN' FROOZ");
});

test("buildUpiPayload: matches the old InvoiceModal payload byte for byte", () => {
  const settings = { business_upi_id: "shop@ybl", upi_payee_name: "Frooz & Co" };
  const invoice = { invoice_no: "INV/2026/0042", total_amount: "456" };
  const legacy = [
    "upi://pay?",
    `pa=${encodeURIComponent(settings.business_upi_id)}`,
    `&pn=${encodeURIComponent(settings.upi_payee_name || "FEEL THE FREAKIN' FROOZ")}`,
    `&am=${encodeURIComponent(Number(invoice.total_amount || 0).toFixed(2))}`,
    "&cu=INR",
    `&tn=${encodeURIComponent(`FroozERP-Invoice-${invoice.invoice_no || invoice.id}`)}`,
  ].join("");
  assert.equal(buildUpiPayload({ upiId: settings.business_upi_id, payeeName: settings.upi_payee_name, amount: 456, note: invoiceUpiNote(invoice) }), legacy);
});

test("buildUpiPayload: blank UPI id gives no payload", () => {
  for (const upiId of ["", "   ", null, undefined]) {
    assert.equal(buildUpiPayload({ upiId, amount: 456 }), "");
  }
});

test("buildUpiPayload: zero, negative and non-finite amounts give no payload", () => {
  for (const amount of [0, -1, Number.NaN, Infinity, null, undefined, "", "abc"]) {
    assert.equal(buildUpiPayload({ upiId: "frooz@okaxis", amount }), "", `amount ${String(amount)}`);
  }
});

test("buildUpiPayload: special characters in payee and note are encoded", () => {
  const payload = buildUpiPayload({ upiId: "frooz@okaxis", payeeName: "Frooz & Sons = #1?", amount: 12.5, note: "Bill #7 & more/100%" });
  assert.match(payload, /&pn=Frooz%20%26%20Sons%20%3D%20%231%3F&/);
  assert.match(payload, /&tn=Bill%20%237%20%26%20more%2F100%25$/);
  assert.match(payload, /&am=12\.50&/);
  // Exactly the five fields: nothing in a name or note can add or split a parameter.
  assert.deepEqual(payload.replace("upi://pay?", "").split("&").map((part) => part.split("=")[0]), ["pa", "pn", "am", "cu", "tn"]);
});

// ---------------------------------------------------------------------------------------------
// resolveInvoiceUpiQr
// ---------------------------------------------------------------------------------------------

test("resolveInvoiceUpiQr: cash bill shows no QR (the old always-true clause is gone)", () => {
  const invoice = { payment_mode: "CASH", total_amount: 456, payments: [{ payment_mode: "CASH", amount: 456 }] };
  assert.deepEqual({ ...resolveInvoiceUpiQr({ paymentSettings: QR_ON, invoice }) }, { show: false, amount: null, reason: "NO_UPI_DUE" });
});

test("resolveInvoiceUpiQr: cash bill with show-on-all-bills shows the full total", () => {
  const invoice = { payment_mode: "CASH", total_amount: "456.00", payments: [{ payment_mode: "CASH", amount: "456.00" }] };
  const result = resolveInvoiceUpiQr({ paymentSettings: { ...QR_ON, show_upi_qr_on_all_bills: true }, invoice });
  assert.deepEqual({ ...result }, { show: true, amount: 456, reason: "ALL_BILLS" });
});

test("resolveInvoiceUpiQr: mixed saved invoice (payment_mode rows) asks only for the UPI part", () => {
  const invoice = {
    payment_mode: "MIXED",
    total_amount: "456.00",
    payments: [{ payment_mode: "CASH", amount: "56.00" }, { payment_mode: "UPI", amount: "400.00" }],
  };
  assert.deepEqual({ ...resolveInvoiceUpiQr({ paymentSettings: QR_ON, invoice }) }, { show: true, amount: 400, reason: "UPI_DUE" });
  // Show-on-all-bills does not widen a UPI part to the whole total.
  assert.equal(resolveInvoiceUpiQr({ paymentSettings: { ...QR_ON, show_upi_qr_on_all_bills: true }, invoice }).amount, 400);
});

test("resolveInvoiceUpiQr: UPI bill with no rows falls back to payment_mode and total_amount", () => {
  const invoice = { payment_mode: "UPI", total_amount: 456 };
  assert.deepEqual({ ...resolveInvoiceUpiQr({ paymentSettings: QR_ON, invoice }) }, { show: true, amount: 456, reason: "UPI_DUE" });
});

test("resolveInvoiceUpiQr: mixed bill with no rows does not guess the UPI share", () => {
  const invoice = { payment_mode: "MIXED", total_amount: 456 };
  assert.deepEqual({ ...resolveInvoiceUpiQr({ paymentSettings: QR_ON, invoice }) }, { show: false, amount: null, reason: "UPI_AMOUNT_UNKNOWN" });
});

test("resolveInvoiceUpiQr: QR disabled or missing flag shows nothing", () => {
  const invoice = { payment_mode: "UPI", total_amount: 456, payments: [{ mode: "UPI", amount: 456 }] };
  for (const paymentSettings of [
    { ...QR_ON, enable_upi_qr_on_invoice: false },
    { business_upi_id: "frooz@okaxis" },
    { ...QR_ON, enable_upi_qr_on_invoice: "true" },
    {},
    undefined,
  ]) {
    assert.deepEqual({ ...resolveInvoiceUpiQr({ paymentSettings, invoice }) }, { show: false, amount: null, reason: "QR_DISABLED" });
  }
});

test("resolveInvoiceUpiQr: blank UPI id shows nothing", () => {
  const invoice = { payment_mode: "UPI", total_amount: 456 };
  assert.equal(resolveInvoiceUpiQr({ paymentSettings: { enable_upi_qr_on_invoice: true, business_upi_id: "  " }, invoice }).reason, "NO_UPI_ID");
});

test("resolveInvoiceUpiQr: show-on-all-bills with an unreadable total shows nothing", () => {
  const invoice = { payment_mode: "CASH", total_amount: null };
  assert.deepEqual(
    { ...resolveInvoiceUpiQr({ paymentSettings: { ...QR_ON, show_upi_qr_on_all_bills: true }, invoice }) },
    { show: false, amount: null, reason: "INVALID_TOTAL" },
  );
});

// ---------------------------------------------------------------------------------------------
// describePaymentConfirmation
// ---------------------------------------------------------------------------------------------

test("describePaymentConfirmation: cash bill asks if paid, no QR, no note", () => {
  const result = describePaymentConfirmation({ paymentMode: "CASH", payments: [{ mode: "CASH", amount: 456 }], total: 456, upiConfigured: true });
  assert.equal(result.kind, "PAID");
  assert.equal(result.title, "Has the customer paid ₹456.00?");
  assert.equal(result.qrAmount, null);
  assert.equal(result.note, null);
  assert.equal(result.primaryLabel, "Paid – save bill");
  assert.equal(result.secondaryLabel, "Not yet");
  assert.deepEqual(result.rows.map((row) => ({ ...row })), [{ mode: "CASH", label: "Cash", amount: 456 }]);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.rows));
});

test("describePaymentConfirmation: UPI bill shows a QR for the full amount", () => {
  const result = describePaymentConfirmation({ paymentMode: "UPI", payments: [{ mode: "UPI", amount: 1234.5 }], total: 1234.5, upiConfigured: true });
  assert.equal(result.title, "Has the customer paid ₹1,234.50?");
  assert.equal(result.qrAmount, 1234.5);
  assert.equal(result.note, null);
});

test("describePaymentConfirmation: mixed bill QR covers only the UPI part and lists every row", () => {
  const { payments } = buildPosPayments({ paymentMode: "MIXED", mixedPayments: { CASH: "56", UPI: "400", CARD: "", BANK_TRANSFER: "" }, total: 456 });
  const result = describePaymentConfirmation({ paymentMode: "MIXED", payments, total: 456, upiConfigured: true });
  assert.equal(result.qrAmount, 400);
  assert.deepEqual(result.rows.map((row) => row.label), ["Cash", "UPI"]);
  assert.deepEqual(result.rows.map((row) => row.amount), [56, 400]);
});

test("describePaymentConfirmation: UPI due but no UPI ID says so instead of omitting the QR silently", () => {
  const result = describePaymentConfirmation({ paymentMode: "UPI", payments: [{ mode: "UPI", amount: 400 }], total: 400, upiConfigured: false });
  assert.equal(result.kind, "PAID");
  assert.equal(result.qrAmount, null);
  assert.match(result.note, /UPI ID is not set in Settings > UPI, Payment QR/);
  assert.match(result.note, /no QR can be shown/);
  assert.match(result.note, /₹400\.00/);
});

test("describePaymentConfirmation: unreadable UPI amount is said, not shown as ₹0", () => {
  const result = describePaymentConfirmation({ paymentMode: "UPI", payments: [{ mode: "UPI", amount: "abc" }], total: 400, upiConfigured: true });
  assert.equal(result.qrAmount, null);
  assert.match(result.note, /could not be read/);
  assert.equal(result.rows[0].amount, null);
});

test("describePaymentConfirmation: card-only bill has no QR and no UPI note", () => {
  const result = describePaymentConfirmation({ paymentMode: "CARD", payments: [{ mode: "CARD", amount: 456 }], total: 456, upiConfigured: false });
  assert.equal(result.qrAmount, null);
  assert.equal(result.note, null);
  assert.equal(result.rows[0].label, "Card");
});

test("describePaymentConfirmation: credit (udhaar) bill confirms a credit sale with no QR", () => {
  const result = describePaymentConfirmation({ paymentMode: "CREDIT", payments: [{ mode: "CREDIT", amount: 456 }], total: 456, upiConfigured: true });
  assert.equal(result.kind, "CREDIT");
  assert.equal(result.title, "Save ₹456.00 as a credit (udhaar) bill?");
  assert.equal(result.qrAmount, null);
  assert.equal(result.primaryLabel, "Save credit bill");
  assert.equal(result.secondaryLabel, "Not yet");
  assert.equal(result.rows[0].label, "Credit (pay later)");
});

test("formatRupees: en-IN grouping, 2 decimals, unreadable is not ₹0.00", () => {
  assert.equal(formatRupees(1234.5), "₹1,234.50");
  assert.equal(formatRupees(123456.789), "₹1,23,456.79");
  assert.equal(formatRupees(0), "₹0.00");
  assert.equal(formatRupees(Number.NaN), "₹—");
  assert.equal(formatRupees(undefined), "₹—");
});

// ---------------------------------------------------------------------------------------------
// Wiring: App.jsx asks "paid?" before anything is saved, and the bill's QR follows these rules
// ---------------------------------------------------------------------------------------------

const appSource = (await import("node:fs")).readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
const appCss = (await import("node:fs")).readFileSync(new URL("../App.css", import.meta.url), "utf8");
const checkoutSlice = appSource.slice(
  appSource.indexOf("const checkout = async (printAfterSave = false, confirmations = {}) => {"),
  appSource.indexOf("const handleSearchKeys = "),
);

test("checkout asks whether the customer paid before it saves, prints or sends anything", () => {
  const gate = checkoutSlice.indexOf("if (confirmations.payment_confirmed !== true) {");
  assert.ok(gate > 0, "the paid gate must be inside checkout");
  assert.ok(gate < checkoutSlice.indexOf("setSaving(true);"), "asked before the save starts");
  assert.ok(gate < checkoutSlice.indexOf("completeLocalPosSale(localSale)"), "before the desktop save");
  assert.ok(gate < checkoutSlice.indexOf("window.print()"), "before any print");
  assert.match(checkoutSlice, /buildPosPayments\(\{ paymentMode, mixedPayments, total: totals\.total \}\)/);
});

test("Paid resumes the same checkout with the same bill reference", () => {
  assert.match(checkoutSlice, /setPaymentConfirm\(\{ printAfterSave, confirmations: \{ \.\.\.carriedConfirmations, sale_ref: saleRef \}/);
  assert.match(appSource, /checkout\(draft\.printAfterSave, \{ \.\.\.draft\.confirmations, payment_confirmed: true \}\);/);
  assert.match(appSource, /<PosPaymentConfirmModal\s/);
});

test("the payment dialog draws its QR from buildUpiPayload, for the UPI part only", () => {
  const start = appSource.indexOf("function PosPaymentConfirmModal(");
  const body = appSource.slice(start, appSource.indexOf("\nfunction ", start + 10));
  assert.match(body, /describePaymentConfirmation\(\{/);
  assert.match(body, /buildUpiPayload\(\{ upiId, payeeName: paymentSettings\.upi_payee_name, amount: view\.qrAmount/);
  assert.match(body, /QRCode\.toDataURL\(payload/);
});

test("the printed bill's QR uses the shared rule, not the old always-true test", () => {
  const start = appSource.indexOf("function InvoiceModal(");
  const body = appSource.slice(start, appSource.indexOf("function PurchaseSummary(", start));
  assert.match(body, /resolveInvoiceUpiQr\(\{ paymentSettings, invoice \}\)/);
  assert.doesNotMatch(body, /\|\| isUpiQrEnabled\)/);
});

test("the bill header keeps its close button in view: own row, sticky, actions wrap", () => {
  const start = appSource.indexOf("function InvoiceModal(");
  const body = appSource.slice(start, appSource.indexOf("function PurchaseSummary(", start));
  const head = body.indexOf('className="invoice-toolbar-head"');
  const close = body.indexOf('aria-label="Close invoice"');
  const actions = body.indexOf('className="invoice-actions invoice-actions-bill"');
  assert.ok(head > 0 && close > head && close < actions, "the close button sits in the title row, not at the end of the actions");
  assert.match(appCss, /\.invoice-modal-bill \{[^}]*overflow-x: hidden;/);
  assert.match(appCss, /\.invoice-toolbar-bill \{[^}]*position: sticky;/);
  assert.match(appCss, /\.invoice-actions-bill \{[^}]*flex-wrap: wrap;/);
  assert.match(appCss, /table:not\(\.bill-table\)/, "large text must not force the bill table to 920px");
});
