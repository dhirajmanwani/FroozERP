import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  INCLUDED_IN_COST_HEADING,
  balanceSheetAsAtInput,
  ledgerWithRunningBalance,
  profitLossCostOfGoods,
  supplierLedgerOpening,
} from "./financialStatements.js";
import { resolveReportDateRange } from "./reportRefresh.js";

const appSource = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
const sum = (lines) => Math.round(lines.reduce((total, line) => total + line.value, 0) * 100) / 100;

// UI-1 ---------------------------------------------------------------------------------------

test("P&L: charges inside the landed cost are listed apart, and the cost lines add up to TOTAL COGS", () => {
  const pl = {
    purchaseCost: 1200,
    mandiTax: 30,
    freightCharges: 50,
    labourCharges: 20,
    otherPurchaseCharges: 10,
    purchaseBillRebate: 15,
    purchaseChargesIncludedInCost: true,
    supplierRebateReceived: 40,
    costOfGoodsSold: 1160,
  };
  const result = profitLossCostOfGoods(pl);
  assert.equal(result.cogs, 1160);
  assert.deepEqual(result.costLines.map((line) => line.label), ["Purchase Cost (landed)", "Less Supplier Rebate Received"]);
  assert.equal(sum(result.costLines), result.cogs, "the visible cost lines reach the total");
  assert.deepEqual(result.includedLines.map((line) => [line.label, line.value]), [
    ["Mandi Tax", 30],
    ["Freight", 50],
    ["Labour", 20],
    ["Other Purchase Charges", 10],
    ["Less Bill Rebate", -15],
  ]);
});

test("P&L: no bill rebate line when the server sent none; a real 0 is still listed", () => {
  const base = { purchaseCost: 100, purchaseChargesIncludedInCost: true };
  assert.equal(profitLossCostOfGoods(base).includedLines.some((line) => line.label === "Less Bill Rebate"), false);
  assert.equal(profitLossCostOfGoods({ ...base, purchaseBillRebate: 0 }).includedLines.some((line) => line.label === "Less Bill Rebate"), true);
  assert.equal(profitLossCostOfGoods(base).cogs, 100, "computed from the landed cost when no total is sent");
});

test("P&L: a server that does not say the charges are included keeps them as cost rows", () => {
  const result = profitLossCostOfGoods({ purchaseCost: 100, mandiTax: 5, freightCharges: 5, supplierRebateReceived: 10 });
  assert.equal(result.includedLines.length, 0);
  assert.equal(result.cogs, 100);
  assert.equal(sum(result.costLines), 100);
});

test("P&L screen and export rows both read profitLossCostOfGoods", () => {
  const statement = appSource.slice(appSource.indexOf("const renderProfitLossStatement = () => {"), appSource.indexOf("const renderFilters = () =>"));
  assert.match(statement, /profitLossCostOfGoods\(pl\)/);
  assert.match(statement, /costOfGoods\.includedLines/);
  assert.doesNotMatch(statement, /profitLossLine\("Mandi Tax"/, "charges are no longer drawn as cost rows");
  const tableRows = appSource.slice(appSource.indexOf("    profitLoss: {\n      title: \"Profit & Loss\""), appSource.indexOf("    balanceSheet: {\n      title: \"Balance Sheet\""));
  assert.match(tableRows, /profitLossCostOfGoods\(data\.profitLoss\)/);
  assert.match(tableRows, /INCLUDED_IN_COST_HEADING/);
  assert.equal(typeof INCLUDED_IN_COST_HEADING, "string");
});

// UI-10 --------------------------------------------------------------------------------------

const opening = [
  { date: "2026-10-05", voucher_no: "B/F", party_name: "Azad Fruits", account_type: "SUPPLIER", credit: 1600, debit: 0, opening_balance: 1600 },
  { date: "2026-10-05", voucher_no: "B/F", party_name: "Bharat Traders", account_type: "SUPPLIER", credit: 0, debit: 200, opening_balance: -200 },
];

test("Supplier Ledger: the chosen supplier's b/f row, or every supplier's", () => {
  const one = supplierLedgerOpening(opening, { accountName: "Azad Fruits" });
  assert.equal(one.status, "ready");
  assert.equal(one.total, 1600);
  assert.deepEqual(one.rows.map((row) => row.party_name), ["Azad Fruits"]);
  const all = supplierLedgerOpening(opening, {});
  assert.equal(all.total, 1400);
  const none = supplierLedgerOpening([], { accountName: "Azad Fruits" });
  assert.deepEqual([none.status, none.total], ["ready", 0], "nothing brought forward is a real 0");
});

test("Supplier Ledger: an unread opening is unavailable, never 0; a narrowing filter is partial", () => {
  for (const value of [null, undefined]) {
    const result = supplierLedgerOpening(value, { accountName: "Azad Fruits" });
    assert.deepEqual([result.status, result.total], ["unavailable", null]);
  }
  for (const filters of [{ voucherType: "Purchase" }, { paymentMode: "CASH" }, { search: "mango" }, { accountType: "CUSTOMER" }]) {
    assert.equal(supplierLedgerOpening(opening, filters).status, "partial", JSON.stringify(filters));
  }
  assert.equal(supplierLedgerOpening(opening, { accountType: "SUPPLIER" }).status, "ready");
});

test("Supplier Ledger: the running balance runs on from the b/f, newest first, b/f last", () => {
  const rows = [
    { date: "2026-10-06", voucher_no: "PUR-2", credit: 500, debit: 0 },
    { date: "2026-10-05", voucher_no: "001", credit: 0, debit: 300 },
  ];
  const { rows: openRows } = supplierLedgerOpening(opening, { accountName: "Azad Fruits" });
  const result = ledgerWithRunningBalance(rows, { mode: "PAYABLE", opening: openRows });
  assert.deepEqual(result.map((row) => [row.voucher_no, row.running_balance]), [
    ["PUR-2", 1800],
    ["001", 1300],
    ["B/F", 1600],
  ], "the b/f counts first even though '001' sorts before 'B/F'");
  const unknown = ledgerWithRunningBalance(rows, { mode: "PAYABLE", opening: [], openingUnavailable: true });
  assert.ok(unknown.every((row) => row.running_balance === null), "unknown opening: no balance is invented");
  const receivable = ledgerWithRunningBalance([{ date: "2026-10-05", debit: 100, credit: 0 }]);
  assert.equal(receivable[0].running_balance, 100);
});

test("Supplier Ledger is wired to the opening balances and shows an unknown balance as a dash", () => {
  assert.match(appSource, /supplierLedgerOpening\(data\.ledgerOpeningBalances,/);
  assert.match(appSource, /openingUnavailable: supplierOpening\.status === "unavailable"/);
  assert.match(appSource, /row\.running_balance === null \? MISSING_VALUE/);
  assert.match(appSource, /\["Opening b\/f", supplierOpeningTile\]/);
});

// UI-9 ---------------------------------------------------------------------------------------

test("Balance Sheet: one date input that always shows the day in force", () => {
  const now = new Date(2026, 9, 28);
  const resolve = (params) => resolveReportDateRange(params, now);
  assert.equal(balanceSheetAsAtInput({ range: "today", resolve }), "2026-10-28");
  assert.equal(balanceSheetAsAtInput({ range: "yesterday", resolve }), "2026-10-27");
  assert.equal(balanceSheetAsAtInput({ range: "month", resolve }), "2026-10-28", "a range is as at its last day");
  assert.equal(balanceSheetAsAtInput({ range: "custom", customRange: { date_from: "2026-10-01", date_to: "2026-10-10" }, resolve }), "2026-10-10");
  assert.equal(balanceSheetAsAtInput({ range: "today", resolve: () => { throw new Error("bad"); } }), "");
});

test("Balance Sheet filter has a single As at date input and names the server's asAtDate", () => {
  const filters = appSource.slice(appSource.indexOf("const renderFilters = () =>"), appSource.indexOf("<Field label=\"Search / Filter\">"));
  const sheet = filters.slice(filters.indexOf('selectedReport === "balanceSheet" ? ('), filters.indexOf(") : (\n        <>"));
  assert.equal((sheet.match(/type="date"/g) || []).length, 1);
  assert.match(sheet, /balanceSheetAsAtInput\(/);
  assert.doesNotMatch(sheet, /<select/);
  assert.match(appSource, /`As at \$\{formatIndianReportDate\(data\.balanceSheet\?\.asAtDate/);
});
