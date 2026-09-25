import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReportPdfModel } from "./reportPdf.js";
import {
  XLSX_FORMATS,
  buildReportWorkbook,
  columnLetter,
  crc32,
  renderXlsx,
  reportCellValue,
  reportWorkbookHasContent,
  reportXlsxFileName,
  sheetNameFor,
} from "./reportXlsx.js";

const here = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(here, "..", "App.jsx"), "utf8");

// Reads a stored zip back: every entry's name and bytes, with the CRC checked against the data.
const readStoredZip = (bytes) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = new Map();
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    assert.equal(view.getUint16(at + 8, true), 0, "stored, not compressed");
    const crc = view.getUint32(at + 14, true);
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLength));
    const data = bytes.subarray(at + 30 + nameLength, at + 30 + nameLength + size);
    assert.equal(crc32(data), crc, `CRC of ${name}`);
    entries.set(name, new TextDecoder().decode(data));
    at += 30 + nameLength + size;
  }
  const centralStart = at;
  let count = 0;
  while (view.getUint32(at, true) === 0x02014b50) {
    count += 1;
    at += 46 + view.getUint16(at + 28, true);
  }
  assert.equal(view.getUint32(at, true), 0x06054b50, "end of central directory");
  assert.equal(view.getUint16(at + 10, true), count);
  assert.equal(view.getUint32(at + 16, true), centralStart, "central directory offset");
  assert.equal(count, entries.size);
  return entries;
};

test("amounts, quantities and percentages become numbers Excel can add up", () => {
  assert.deepEqual(reportCellValue("₹2,82,275.50"), { value: 282275.5, style: XLSX_FORMATS.MONEY });
  assert.deepEqual(reportCellValue("Rs. 90"), { value: 90, style: XLSX_FORMATS.MONEY });
  assert.deepEqual(reportCellValue("-₹450.00"), { value: -450, style: XLSX_FORMATS.MONEY });
  assert.deepEqual(reportCellValue("₹-450.00"), { value: -450, style: XLSX_FORMATS.MONEY });
  assert.deepEqual(reportCellValue("(₹135.00)"), { value: -135, style: XLSX_FORMATS.MONEY });
  assert.deepEqual(reportCellValue("1,183.550"), { value: 1183.55, style: XLSX_FORMATS.QUANTITY });
  assert.deepEqual(reportCellValue("-450.25"), { value: -450.25, style: XLSX_FORMATS.DECIMAL });
  assert.deepEqual(reportCellValue("12.5%"), { value: 0.125, style: XLSX_FORMATS.PERCENT });
  assert.deepEqual(reportCellValue("17"), { value: 17, style: XLSX_FORMATS.INTEGER });
  assert.deepEqual(reportCellValue("0"), { value: 0, style: XLSX_FORMATS.INTEGER });
  assert.deepEqual(reportCellValue("0.50"), { value: 0.5, style: XLSX_FORMATS.DECIMAL });
});

test("identifiers stay text: '004' is not 4, a mobile number is not a quantity, a bill number is not a sum", () => {
  for (const text of ["004", "0012", "9876543210", "24/09/2026", "INV-12", "Kesar", "-", "", "₹1,234.00 Dr", "12 kg"]) {
    assert.equal(reportCellValue(text).style, XLSX_FORMATS.TEXT, text);
    assert.equal(reportCellValue(text).value, text, text);
  }
  assert.equal(reportCellValue("12", { header: "Invoice No" }).value, "12");
  assert.equal(reportCellValue("12", { header: "Lot" }).value, "12");
  assert.equal(reportCellValue("12", { header: "Mobile" }).value, "12");
  // A document word next to an amount word is an amount.
  assert.equal(reportCellValue("500", { header: "Bill Amount" }).value, 500);
  assert.equal(reportCellValue("12.000", { header: "Lot Qty" }).value, 12);
  // A currency mark is an amount whatever the column is called.
  assert.equal(reportCellValue("₹500", { header: "Bill No" }).value, 500);
});

test("the sheet reads top to bottom like the report: title, filters, when, totals, headings, tables", () => {
  const workbook = buildReportWorkbook({
    title: "Sales History",
    meta: ["Range: 01 Sep 2026 to 24 Sep 2026", "Status: ALL"],
    blocks: [
      { type: "metrics", items: [{ label: "Total Sales", value: "₹9,250.00" }, { label: "Bills", value: "17" }] },
      { type: "heading", text: "Item-wise" },
      { type: "table", columns: ["Date", "Invoice No", "Qty", "Amount"], rows: [["24/09/2026", "004", "37.000", "₹9,250.00"]] },
    ],
  }, { generatedAt: "24/9/2026, 3:30:00 pm" });
  const text = (row) => row.map((cell) => (cell ? cell.value : null));
  assert.equal(workbook.sheetName, "Sales History");
  assert.deepEqual(workbook.rows.map(text), [
    ["Sales History"],
    ["Range: 01 Sep 2026 to 24 Sep 2026"],
    ["Status: ALL"],
    ["Generated 24/9/2026, 3:30:00 pm"],
    [],
    ["Total Sales", 9250],
    ["Bills", 17],
    [],
    ["Item-wise"],
    [],
    ["Date", "Invoice No", "Qty", "Amount"],
    ["24/09/2026", "004", 37, 9250],
  ]);
  assert.equal(workbook.rows[0][0].style, XLSX_FORMATS.TITLE);
  assert.ok(workbook.rows[10].every((cell) => cell.style === XLSX_FORMATS.BOLD), "headers are bold");
});

test("a day-total cell spanning three columns leaves the next cells under their own headings", () => {
  const workbook = buildReportWorkbook({
    title: "Purchase History",
    blocks: [{
      type: "table",
      columns: ["Date", "Supplier", "Bill No", "Gross", "Net", "Note"],
      rows: [
        ["24/09/2026", "Ramesh", "B-1", "₹100.00", "₹90.00", ""],
        ["Net Purchase Total for 24 Sep 2026", "₹100.00", "₹90.00", "Cancelled excluded"],
      ],
      spans: { 1: [3, 1, 1, 1] },
    }],
  });
  const total = workbook.rows.at(-1);
  assert.equal(total[0].value, "Net Purchase Total for 24 Sep 2026");
  assert.equal(total[1], null);
  assert.equal(total[2], null);
  assert.deepEqual(total[3], { value: 100, style: XLSX_FORMATS.MONEY }, "under Gross");
  assert.deepEqual(total[4], { value: 90, style: XLSX_FORMATS.MONEY }, "under Net");
  assert.equal(total[5].value, "Cancelled excluded");
});

test("the report model records colSpan only on the rows that have one", () => {
  const cell = (text, colSpan = 1) => ({ textContent: text, colSpan });
  const rows = [
    { querySelectorAll: (s) => (s === "th" ? [cell("Date"), cell("Supplier"), cell("Bill No"), cell("Gross")] : []) },
    { querySelectorAll: (s) => (s === "td" ? [cell("24/09/2026"), cell("Ramesh"), cell("B-1"), cell("₹100.00")] : []) },
    { querySelectorAll: (s) => (s === "td" ? [cell("Total", 3), cell("₹100.00")] : []) },
  ];
  const table = { tagName: "TABLE", textContent: "", classList: { contains: () => false }, getAttribute: () => null, parentElement: null, querySelectorAll: (s) => (s === "tr" ? rows : []) };
  const model = buildReportPdfModel({ querySelectorAll: () => [table] }, { title: "T" });
  assert.deepEqual(model.blocks[0].spans, { 1: [3, 1] });
  const plain = buildReportPdfModel({ querySelectorAll: () => [{ ...table, querySelectorAll: (s) => (s === "tr" ? rows.slice(0, 2) : []) }] }, { title: "T" });
  assert.equal("spans" in plain.blocks[0], false, "a plain table's model is unchanged");
});

test("the .xlsx is a valid stored zip with the five parts Excel needs, and the sheet holds typed cells", () => {
  const workbook = buildReportWorkbook({
    title: "Stock: Inventory [Jodhpur]/Main?*",
    meta: ["Search: Kesar & <Alphonso>"],
    blocks: [{ type: "table", columns: ["Product", "Qty", "Value"], rows: [["=HYPERLINK(\"http://x\")", "37.000", "₹9,250.00"], ["Bad\u0001char\u0008s", "1.000", "₹1.00"]] }],
  });
  const bytes = renderXlsx(workbook);
  const files = readStoredZip(bytes);
  assert.deepEqual([...files.keys()].sort(), ["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]);
  const sheet = files.get("xl/worksheets/sheet1.xml");
  assert.match(files.get("xl/workbook.xml"), /<sheet name="Stock Inventory Jodhpur Main"/);
  assert.match(sheet, /Search: Kesar &amp; &lt;Alphonso&gt;/);
  // Text that looks like a formula is stored as text: there is no formula element anywhere.
  assert.doesNotMatch(sheet, /<f>/);
  assert.match(sheet, /t="inlineStr"><is><t xml:space="preserve">=HYPERLINK\(&quot;http:\/\/x&quot;\)<\/t>/);
  assert.match(sheet, /<t xml:space="preserve">Badchars<\/t>/, "control characters Excel would refuse are dropped");
  assert.match(sheet, new RegExp(`<c r="B5" s="${XLSX_FORMATS.QUANTITY}"><v>37</v></c>`));
  assert.match(sheet, new RegExp(`<c r="C5" s="${XLSX_FORMATS.MONEY}"><v>9250</v></c>`));
  assert.match(files.get("xl/styles.xml"), /<cellXfs count="8">/);
  // The same report gives the same bytes: no clock in the file itself.
  assert.deepEqual(renderXlsx(workbook), bytes);
});

test("helpers: column letters, sheet names, file names, and 'is there anything to export'", () => {
  assert.deepEqual([0, 25, 26, 51, 52, 701, 702].map(columnLetter), ["A", "Z", "AA", "AZ", "BA", "ZZ", "AAA"]);
  assert.equal(sheetNameFor("A".repeat(40)).length, 31);
  assert.equal(sheetNameFor("  "), "Report");
  assert.equal(reportXlsxFileName("Sales_History_01-09-2026_to_24-09-2026.pdf"), "Sales_History_01-09-2026_to_24-09-2026.xlsx");
  assert.equal(reportXlsxFileName("", "Cash Book"), "Cash Book.xlsx");
  assert.equal(reportXlsxFileName("a/b:c.pdf"), "a_b_c.xlsx");
  assert.equal(reportWorkbookHasContent({ blocks: [{ type: "heading", text: "Only a chart" }] }), false);
  assert.equal(reportWorkbookHasContent({ blocks: [{ type: "table", columns: ["A"], rows: [] }] }), false);
  assert.equal(reportWorkbookHasContent({ blocks: [{ type: "metrics", items: [{ label: "A", value: "1" }] }] }), true);
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926, "the standard CRC-32 check value");
});

test("App: every report gets an Excel button fed by the same model as the text PDF", () => {
  assert.match(appSource, /<ReportToolbar canWhatsappSend=\{canWhatsappSend\} exporting=\{exporting\} onExcelExport=\{exportExcel\}/);
  const exporter = appSource.match(/const exportReportExcel = \(\{ element, fileName, title \}\) => \{[\s\S]*?\n\};/);
  assert.ok(exporter);
  assert.match(exporter[0], /buildReportPdfModel\(element, \{ title, meta: reportMetaLines\(element\) \}\)/);
  assert.match(exporter[0], /if \(!reportWorkbookHasContent\(model\)\) return null;/);
  // The PDF reads its filter lines through the same helper, with a working whitespace pattern.
  assert.match(appSource, /const meta = reportMetaLines\(element\);/);
  assert.doesNotMatch(appSource, /replace\(\/s\+\/g/, "the old pattern replaced every letter s with a space");
  // Nothing is ever silent: a missing file says why.
  assert.match(appSource, /This report has no table or totals to put in Excel, so no file was made\./);
  assert.match(appSource, /Saved to your Downloads folder as \$\{result\.fileName\}\./);
});
