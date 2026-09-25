import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { buildReportPdfModel, isNumericCell, renderReportPdf, reportPdfHasContent } from "./reportPdf.js";

const require = createRequire(new URL("../../package.json", import.meta.url));
const { jsPDF } = require("jspdf");

// Minimal stand-in for the parts of the DOM the extractor touches, so the model half
// stays testable under node:test without pulling in a DOM implementation.
const el = ({ tag = "DIV", text = "", classes = [], attrs = {}, children = [] }) => {
  const node = {
    tagName: tag,
    textContent: text,
    classList: { contains: (name) => classes.includes(name) },
    getAttribute: (name) => attrs[name] ?? null,
    parentElement: null,
    children,
  };
  for (const child of children) child.parentElement = node;
  return node;
};

const rootWith = (nodes) => ({
  querySelectorAll: (selector) => {
    if (selector === "tr") return [];
    return nodes;
  },
});

const tableNode = (columns, rows) => {
  const trs = [
    { querySelectorAll: (s) => (s === "th" ? columns.map((c) => ({ textContent: c })) : []) },
    ...rows.map((row) => ({
      querySelectorAll: (s) => (s === "td" ? row.map((c) => ({ textContent: c })) : []),
    })),
  ];
  return {
    tagName: "TABLE",
    textContent: "",
    classList: { contains: () => false },
    getAttribute: () => null,
    parentElement: null,
    querySelectorAll: (s) => (s === "tr" ? trs : []),
  };
};

test("numeric cells are detected so money columns can right-align", () => {
  assert.equal(isNumericCell("₹2,82,275.00"), true);
  assert.equal(isNumericCell("1,183.550"), true);
  assert.equal(isNumericCell("-450.25"), true);
  assert.equal(isNumericCell("12%"), true);
  assert.equal(isNumericCell("Alphonso"), false);
  assert.equal(isNumericCell("-"), false);
  assert.equal(isNumericCell(""), false);
});

test("summary metrics are read from the title attribute SummaryMetric already emits", () => {
  const model = buildReportPdfModel(rootWith([
    el({ classes: ["summary-metric"], attrs: { title: "Total Stock Value: ₹2,82,275.00" } }),
    el({ classes: ["summary-metric"], attrs: { title: "Products: 17" } }),
  ]), { title: "Current Stock" });
  assert.equal(model.blocks.length, 1);
  assert.equal(model.blocks[0].type, "metrics");
  assert.deepEqual(model.blocks[0].items[0], { label: "Total Stock Value", value: "₹2,82,275.00" });
  assert.deepEqual(model.blocks[0].items[1], { label: "Products", value: "17" });
});

test("no-print controls never reach the exported document", () => {
  const toolbar = el({ tag: "H3", text: "Filters", classes: ["no-print"] });
  const model = buildReportPdfModel(rootWith([toolbar]));
  assert.equal(model.blocks.length, 0);
});

test("tables keep their header row and every body row", () => {
  const model = buildReportPdfModel(rootWith([
    tableNode(["Product", "Stock", "Value"], [["Alphonso", "101.550", "₹20,310.00"], ["Kesar", "37.000", "₹9,250.00"]]),
  ]));
  const table = model.blocks.find((block) => block.type === "table");
  assert.deepEqual(table.columns, ["Product", "Stock", "Value"]);
  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.rows[1], ["Kesar", "37.000", "₹9,250.00"]);
});

test("a report with no tables or metrics is reported as having no extractable content", () => {
  assert.equal(reportPdfHasContent({ blocks: [{ type: "heading", text: "Chart only" }] }), false);
  assert.equal(reportPdfHasContent({ blocks: [{ type: "table", columns: ["A"], rows: [["1"]] }] }), true);
  assert.equal(reportPdfHasContent(null), false);
});

test("a large report renders as text and stays far below the 25 MB request-body limit", () => {
  const rows = Array.from({ length: 2000 }, (_, index) => [
    `Product ${index}`, "Fruit", `Lot-${index}`, "101.550", "₹185.00", "₹18,786.75", "Active",
  ]);
  const model = {
    title: "Profit & Loss",
    meta: ["Range: 2026-06-01 to 2026-08-15", "Branch: Jodhpur Main"],
    blocks: [
      { type: "metrics", items: [{ label: "Total Stock Value", value: "₹2,82,275.00" }, { label: "Products", value: "17" }] },
      { type: "heading", text: "Stock by product" },
      { type: "table", columns: ["Product", "Category", "Lot", "Stock", "Rate", "Value", "Status"], rows },
    ],
  };
  const doc = renderReportPdf({ model, jsPDF, generatedAt: "2026-08-16 09:00" });
  const bytes = doc.output("arraybuffer").byteLength;
  const base64Bytes = Math.ceil(bytes / 3) * 4;

  assert.ok(doc.internal.getNumberOfPages() > 1, "2000 rows must paginate");
  // The raster path produced 27.5-68.7 MB for comparable reports and was rejected at 25 MB.
  assert.ok(base64Bytes < 25 * 1024 * 1024, `base64 body ${base64Bytes} must fit the 25mb limit`);
  assert.ok(bytes < 2 * 1024 * 1024, `text PDF should stay small, got ${bytes} bytes`);
});

test("an account ledger extracts, so it can never fall back to the picture path", () => {
  // The bug this pins. The ledger's two export buttons used to call the raster exporter directly,
  // with no attempt at text first, so every ledger went to WhatsApp as a 2x lossless PNG - tens of
  // megabytes against a 25mb body limit, which fails on anything but a very short statement. Both
  // now go through the shared helper, and the helper only reaches the raster path when this
  // returns false. So what actually has to hold is that a ledger's own shape extracts: summary
  // metrics read from their `title` attribute, and the statement table read as rows.
  const ledger = rootWith([
    el({ tag: "SPAN", classes: ["summary-metric"], attrs: { title: "Opening Balance: ₹12,480.00" } }),
    el({ tag: "SPAN", classes: ["summary-metric"], attrs: { title: "Closing Balance: ₹1,08,940.50" } }),
    tableNode(
      ["Date", "Invoice Number", "Transaction Type", "Sale Amount", "Payment Mode", "Debit", "Credit", "Balance", "Narration"],
      Array.from({ length: 400 }, (_, index) => [
        "2026-08-15", `INV-${1000 + index}`, "Sale", "₹4,820.00", "Cash",
        "₹4,820.00", "₹0.00", "₹1,08,940.50", "Counter sale",
      ]),
    ),
  ]);

  const model = buildReportPdfModel(ledger, { title: "Rajesh Traders - Ledger Statement", meta: [] });
  assert.ok(reportPdfHasContent(model), "a ledger must have extractable content, or it silently becomes a screenshot");

  const metrics = model.blocks.find((block) => block.type === "metrics");
  assert.deepEqual(metrics.items[0], { label: "Opening Balance", value: "₹12,480.00" });
  const table = model.blocks.find((block) => block.type === "table");
  assert.equal(table.columns.length, 9, "every ledger column must survive, including Narration");
  assert.equal(table.rows.length, 400);

  const doc = renderReportPdf({ model, jsPDF, generatedAt: "2026-09-18 14:00" });
  const bytes = doc.output("arraybuffer").byteLength;
  const base64Bytes = Math.ceil(bytes / 3) * 4;
  assert.ok(base64Bytes < 25 * 1024 * 1024, `base64 body ${base64Bytes} must fit the 25mb limit WhatsApp sends through`);
});

test("an empty report still produces a valid single-page document", () => {
  const doc = renderReportPdf({ model: { title: "Empty", meta: [], blocks: [] }, jsPDF });
  assert.equal(doc.internal.getNumberOfPages(), 1);
  assert.ok(doc.output("arraybuffer").byteLength > 0);
});

test("a statement drawn as lines (Profit & Loss) exports every line with its amount", () => {
  const withAttr = (node, name) => Object.assign(node, { hasAttribute: (attr) => attr === name });
  const line = (label, amount) => withAttr(el({ children: [el({ tag: "SPAN", text: label }), el({ tag: "STRONG", text: amount })] }), "data-report-line");
  const note = (text) => withAttr(el({ tag: "P", text }), "data-report-note");
  const model = buildReportPdfModel(rootWith([
    el({ classes: ["summary-metric"], attrs: { title: "Net Profit/Loss: ₹1,200.00" } }),
    el({ tag: "H2", text: "PROFIT & LOSS STATEMENT" }),
    note("For Period: 2025-09-24 to 2026-09-24"),
    el({ tag: "H3", text: "INCOME" }),
    line("Sales Revenue", "₹5,000.00"),
    line("TOTAL INCOME", "₹5,000.00"),
    el({ tag: "H3", text: "LESS: COST OF GOODS SOLD" }),
    line("Less Supplier Rebate Received", "(₹50.00)"),
    line("NET PROFIT", "₹1,200.00"),
  ]));
  assert.deepEqual(model.blocks.map((block) => block.type), ["metrics", "heading", "heading", "heading", "table", "heading", "table"]);
  assert.equal(model.blocks[2].text, "For Period: 2025-09-24 to 2026-09-24");
  assert.deepEqual(model.blocks[4], { type: "table", columns: ["Particulars", "Amount"], rows: [["Sales Revenue", "₹5,000.00"], ["TOTAL INCOME", "₹5,000.00"]] });
  assert.deepEqual(model.blocks[6].rows, [["Less Supplier Rebate Received", "(₹50.00)"], ["NET PROFIT", "₹1,200.00"]]);
  assert.equal(reportPdfHasContent(model), true);
});
