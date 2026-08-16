// Text-based PDF generation for report exports.
//
// The previous path rasterised the report DOM with html2canvas and embedded the bitmap,
// which produced 27-69 MB image-PDFs with no selectable text. Those exceeded the backend's
// 25 MB JSON body limit once base64-encoded, so WhatsApp sharing failed outright.
// This module emits real text instead: selectable, searchable, and orders of magnitude smaller.
//
// Split deliberately in two so the rendering half is testable under node:test without a DOM:
//   buildReportPdfModel(root)      - DOM in, plain data out
//   renderReportPdf({ model, ... }) - plain data in, jsPDF document out

const A4 = Object.freeze({ PORTRAIT: { width: 210, height: 297 }, LANDSCAPE: { width: 297, height: 210 } });

const cleanText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const isHiddenFromPrint = (node) => {
  for (let current = node; current && current.classList; current = current.parentElement) {
    if (current.classList.contains("no-print")) return true;
  }
  return false;
};

// A cell is treated as numeric when it reads as money or a quantity, so it can be
// right-aligned. Currency, thousands separators and 3-decimal quantities all qualify.
export const isNumericCell = (value) => {
  const text = cleanText(value);
  if (!text || text === "-") return false;
  return /^[₹Rs.\s]*-?[\d,]+(\.\d+)?%?$/.test(text.replace(/^\((.*)\)$/, "-$1"));
};

const tableModel = (table) => {
  const rowNodes = Array.from(table.querySelectorAll("tr"));
  let columns = [];
  const rows = [];
  for (const row of rowNodes) {
    const headerCells = Array.from(row.querySelectorAll("th"));
    if (headerCells.length && !columns.length) {
      columns = headerCells.map((cell) => cleanText(cell.textContent));
      continue;
    }
    const cells = Array.from(row.querySelectorAll("td"));
    if (!cells.length) continue;
    rows.push(cells.map((cell) => cleanText(cell.textContent)));
  }
  if (!columns.length && rows.length) columns = rows[0].map((_, index) => `Column ${index + 1}`);
  return { type: "table", columns, rows };
};

export const buildReportPdfModel = (root, { title = "", meta = [] } = {}) => {
  const blocks = [];
  if (!root || typeof root.querySelectorAll !== "function") return { title: cleanText(title), meta, blocks };

  const nodes = Array.from(root.querySelectorAll("h1, h2, h3, h4, .summary-metric, table"));
  let metrics = [];
  const flushMetrics = () => {
    if (metrics.length) blocks.push({ type: "metrics", items: metrics });
    metrics = [];
  };

  for (const node of nodes) {
    if (isHiddenFromPrint(node)) continue;
    const tag = String(node.tagName || "").toUpperCase();

    if (node.classList && node.classList.contains("summary-metric")) {
      // SummaryMetric renders title={`${label}: ${value}`}, which is the cleanest source.
      const raw = cleanText(node.getAttribute && node.getAttribute("title"));
      const split = raw.indexOf(": ");
      metrics.push(split === -1
        ? { label: raw, value: "" }
        : { label: raw.slice(0, split), value: raw.slice(split + 2) });
      continue;
    }

    flushMetrics();
    if (tag === "TABLE") {
      const model = tableModel(node);
      if (model.rows.length || model.columns.length) blocks.push(model);
      continue;
    }
    const text = cleanText(node.textContent);
    if (text) blocks.push({ type: "heading", text });
  }
  flushMetrics();

  return { title: cleanText(title), meta: meta.map(cleanText).filter(Boolean), blocks };
};

export const reportPdfHasContent = (model) => Boolean(
  model && Array.isArray(model.blocks) && model.blocks.some((block) => (
    (block.type === "table" && block.rows.length > 0) || block.type === "metrics"
  ))
);

const columnWidths = (doc, columns, rows, available) => {
  const measure = (text, size) => {
    doc.setFontSize(size);
    return doc.getTextWidth(String(text ?? ""));
  };
  const natural = columns.map((column, index) => {
    let widest = measure(column, 8);
    for (const row of rows) widest = Math.max(widest, measure(row[index] ?? "", 8));
    return Math.max(14, widest + 4);
  });
  const total = natural.reduce((sum, width) => sum + width, 0);
  if (total <= available) {
    const slack = (available - total) / natural.length;
    return natural.map((width) => width + slack);
  }
  return natural.map((width) => (width / total) * available);
};

export const renderReportPdf = ({
  model,
  jsPDF,
  orientation = "portrait",
  generatedAt = "",
}) => {
  const page = orientation === "landscape" ? A4.LANDSCAPE : A4.PORTRAIT;
  const doc = new jsPDF(orientation === "landscape" ? "l" : "p", "mm", "a4");
  const margin = 12;
  const available = page.width - margin * 2;
  let y = margin;

  const newPage = () => {
    doc.addPage();
    y = margin;
  };
  const ensure = (needed) => {
    if (y + needed > page.height - margin) newPage();
  };

  doc.setTextColor(17, 17, 17);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text(model.title || "Report", margin, y + 4);
  y += 9;

  if (model.meta && model.meta.length) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(90, 90, 90);
    for (const line of model.meta) {
      for (const wrapped of doc.splitTextToSize(line, available)) {
        ensure(4);
        doc.text(wrapped, margin, y + 3);
        y += 4;
      }
    }
    doc.setTextColor(17, 17, 17);
  }
  if (generatedAt) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(120, 120, 120);
    ensure(4);
    doc.text(`Generated ${generatedAt}`, margin, y + 3);
    doc.setTextColor(17, 17, 17);
    y += 5;
  }
  y += 2;
  doc.setDrawColor(30, 30, 30);
  doc.setLineWidth(0.4);
  doc.line(margin, y, page.width - margin, y);
  y += 5;

  for (const block of model.blocks) {
    if (block.type === "heading") {
      ensure(10);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10.5);
      doc.text(block.text, margin, y + 3.5);
      y += 8;
      continue;
    }

    if (block.type === "metrics") {
      doc.setFontSize(8.5);
      const perRow = orientation === "landscape" ? 4 : 3;
      const cellWidth = available / perRow;
      for (let index = 0; index < block.items.length; index += perRow) {
        const slice = block.items.slice(index, index + perRow);
        ensure(11);
        slice.forEach((item, column) => {
          const x = margin + column * cellWidth;
          doc.setFont("helvetica", "normal");
          doc.setTextColor(110, 110, 110);
          doc.text(doc.splitTextToSize(item.label, cellWidth - 3)[0] || "", x, y + 3);
          doc.setFont("helvetica", "bold");
          doc.setTextColor(17, 17, 17);
          doc.text(doc.splitTextToSize(item.value, cellWidth - 3)[0] || "", x, y + 8);
        });
        y += 11;
      }
      y += 2;
      continue;
    }

    if (block.type === "table") {
      const widths = columnWidths(doc, block.columns, block.rows, available);
      const alignRight = block.columns.map((_, index) => (
        block.rows.length > 0 && block.rows.filter((row) => isNumericCell(row[index])).length > block.rows.length / 2
      ));

      const drawHeader = () => {
        ensure(9);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(8);
        doc.setTextColor(17, 17, 17);
        let x = margin;
        block.columns.forEach((column, index) => {
          const text = doc.splitTextToSize(column, widths[index] - 2)[0] || "";
          doc.text(text, alignRight[index] ? x + widths[index] - 2 : x, y + 4, alignRight[index] ? { align: "right" } : undefined);
          x += widths[index];
        });
        y += 6;
        doc.setDrawColor(60, 60, 60);
        doc.setLineWidth(0.3);
        doc.line(margin, y, page.width - margin, y);
        y += 2;
      };

      drawHeader();
      doc.setFont("helvetica", "normal");
      for (const row of block.rows) {
        if (y + 6 > page.height - margin) {
          newPage();
          drawHeader();
          doc.setFont("helvetica", "normal");
        }
        doc.setFontSize(8);
        let x = margin;
        block.columns.forEach((_, index) => {
          const text = doc.splitTextToSize(String(row[index] ?? ""), widths[index] - 2)[0] || "";
          doc.text(text, alignRight[index] ? x + widths[index] - 2 : x, y + 3.6, alignRight[index] ? { align: "right" } : undefined);
          x += widths[index];
        });
        y += 5.4;
        doc.setDrawColor(215, 215, 215);
        doc.setLineWidth(0.1);
        doc.line(margin, y - 1.4, page.width - margin, y - 1.4);
      }
      y += 4;
    }
  }

  const pageCount = doc.internal.getNumberOfPages();
  for (let index = 1; index <= pageCount; index += 1) {
    doc.setPage(index);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(130, 130, 130);
    doc.text(`Page ${index} of ${pageCount}`, page.width - margin, page.height - 6, { align: "right" });
  }
  return doc;
};
