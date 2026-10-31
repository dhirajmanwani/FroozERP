import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { billDateCode, billNoFloorKey, billNumbersOf, displayBillNo, nextBillNo, parseBillNo } from "./billNumber.js";

const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

test("the bill's date reads as DDMMYY, and a date that cannot be read gives nothing", () => {
  assert.equal(billDateCode("2026-10-31"), "311026");
  assert.equal(billDateCode("2026-11-01T09:30:00+05:30"), "011126");
  assert.equal(billDateCode("31/10/2026"), "");
  assert.equal(billDateCode("2026-13-01"), "");
  assert.equal(billDateCode(""), "");
  assert.equal(billDateCode(null), "");
});

test("the first bill of a day is 001 and the next one counts on from the highest", () => {
  assert.equal(nextBillNo({ billDate: "2026-10-31" }), "311026-001");
  assert.equal(nextBillNo({ billDate: "2026-10-31", existing: ["311026-001", "311026-002"] }), "311026-003");
  // Out of order, with a cloud copy kept apart as -2, and an old-style reference beside them.
  assert.equal(nextBillNo({ billDate: "2026-10-31", existing: ["311026-004", "311026-001-2", "OFF-20261031093000-1234", "FZ-20261031-000017"] }), "311026-005");
});

test("a new day starts again at 001, whatever yesterday reached", () => {
  assert.equal(nextBillNo({ billDate: "2026-11-01", existing: ["311026-001", "311026-087"] }), "011126-001");
});

test("a bill still being saved is never given the same number again", () => {
  assert.equal(nextBillNo({ billDate: "2026-10-31", existing: ["311026-001"], floor: 3 }), "311026-004");
  assert.equal(nextBillNo({ billDate: "2026-10-31", existing: ["311026-009"], floor: 3 }), "311026-010");
  assert.equal(nextBillNo({ billDate: "2026-10-31", floor: "not a number" }), "311026-001");
});

test("past 999 the number simply grows; an unreadable date gives no number at all", () => {
  assert.equal(nextBillNo({ billDate: "2026-10-31", existing: ["311026-999"] }), "311026-1000");
  assert.equal(nextBillNo({ billDate: "not a date", existing: ["311026-001"] }), "");
});

test("numbers are read from every field a local bill carries", () => {
  assert.deepEqual(parseBillNo("311026-012"), { code: "311026", seq: 12 });
  assert.deepEqual(parseBillNo("311026-012-2"), { code: "311026", seq: 12 });
  assert.equal(parseBillNo("OFF-20261031-1"), null);
  assert.deepEqual(
    billNumbersOf([{ invoice: { bill_no: "311026-001", server_invoice_no: "311026-001" } }, { bill_no: "311026-002" }, null]),
    ["311026-001", "311026-001", "311026-002"],
  );
  assert.equal(billNoFloorKey("2026-10-31"), "froozerp_bill_no_floor:311026");
});

test("a bill shows the cloud's number, else this computer's, else its reference", () => {
  assert.equal(displayBillNo({ server_invoice_no: "311026-001-2", bill_no: "311026-001", offline_invoice_ref: "OFF-1" }), "311026-001-2");
  assert.equal(displayBillNo({ bill_no: "311026-001", offline_invoice_ref: "OFF-1" }), "311026-001");
  assert.equal(displayBillNo({ offline_invoice_ref: "OFF-1" }), "OFF-1");
  assert.equal(displayBillNo({}), "");
});

test("checkout stamps the number on the bill and keeps offline_invoice_ref as the key", () => {
  assert.match(app, /const billNo = await nextLocalBillNo\(selectedBillDate\);/);
  assert.match(app, /\.\.\.\(billNo \? \{ bill_no: billNo \} : \{\}\)/);
  assert.match(app, /offline_invoice_ref: offlineInvoiceRef,/, "the reference the cloud de-duplicates by is untouched");
  assert.match(app, /invoice_no: localSale\.bill_no \|\| localSale\.offline_invoice_ref,/, "the printed bill shows the new number");
  assert.match(app, /invoice_no: displayBillNo\(invoice\),/, "a reopened local bill shows it too");
});
