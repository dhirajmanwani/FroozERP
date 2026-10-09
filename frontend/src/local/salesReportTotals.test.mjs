import test from "node:test";
import assert from "node:assert/strict";

import { dayBookVoucherLabel, paymentReportTotals, saleGrossAmount, salesHistoryMoneyTotals } from "./salesReportTotals.js";

test("card is bank money, and a mixed bill splits by its payments", () => {
  const totals = salesHistoryMoneyTotals([
    { payment_mode: "CARD", total_amount: 300, gross_amount: 320 },
    { payment_mode: "MIXED", total_amount: 1000, gross_amount: 1000, payments: [{ mode: "CASH", amount: 400 }, { mode: "UPI", amount: 600 }] },
    { payment_mode: "CASH", total_amount: 50 },
  ]);
  assert.equal(totals.cash, 450);
  assert.equal(totals.upiBank, 900);
  assert.equal(totals.gross, 1370, "gross_amount, not the net total");
});

test("a mixed bill without a payments list falls back to its single mode, as before", () => {
  const totals = salesHistoryMoneyTotals([{ payment_mode: "MIXED", total_amount: 500 }]);
  assert.equal(totals.cash + totals.upiBank, 0);
});

test("an invoice shown in part counts only the items shown", () => {
  const row = {
    payment_mode: "CASH", total_amount: 100, gross_amount: 100,
    visible_items: [{ gross: 30 }], all_items: [{ gross: 30 }, { gross: 70 }],
  };
  assert.equal(salesHistoryMoneyTotals([row], { itemGross: (item) => item.gross }).gross, 30);
});

test("gross keeps a real zero", () => {
  assert.equal(saleGrossAmount({ gross_amount: 0, total_amount: 40 }), 0);
  assert.equal(saleGrossAmount({ total_amount: 40 }), 40);
});

test("cancelled payments are not counted as paid", () => {
  const totals = paymentReportTotals([
    { payment_amount: 100, rebate_amount: 5 },
    { payment_amount: 900, rebate_amount: 10, cancelled: true },
  ]);
  assert.deepEqual(totals, { payments: 100, rebates: 5, cancelled: 900, entries: 2 });
});

test("a cancellation is not labelled as the sale it reverses", () => {
  assert.equal(dayBookVoucherLabel({ transaction_type: "Customer Sale Cancellation" }), "Customer Sale Cancellation");
  assert.equal(dayBookVoucherLabel({ transaction_type: "Supplier Purchase Cancellation" }), "Supplier Purchase Cancellation");
  assert.equal(dayBookVoucherLabel({ transaction_type: "Customer Sale" }), "POS Sale");
  assert.equal(dayBookVoucherLabel({ voucher_type: "Sale Return" }), "Sale Return");
  assert.equal(dayBookVoucherLabel({}), "-");
});
