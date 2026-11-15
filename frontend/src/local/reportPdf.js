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

import { installReportFonts } from "./reportPdfFonts.js";

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
  if (!text || text === "-" || text === "—") return false;
  // "₹1,240.00", "-₹45.00", "−₹1,900.00", "(₹45.00)", "12.5%", and quantities with their unit
  // ("71.500 Kg", "6 Piece") all line up on the right like the figures they are.
  return /^[−–-]?\s*(₹|Rs\.?)?\s*[−–-]?\s*[\d,]+(\.\d+)?\s*%?(\s+[A-Za-z]{1,8})?$/.test(text.replace(/^\((.*)\)$/, "-$1"));
};

// How many columns a cell covers. A day-total row ("Net Purchase Total for 24 Sep", colSpan 3)
// has fewer cells than the header, and the Excel export needs to know where each one sits.
const cellSpan = (cell) => {
  const span = Number(cell?.colSpan ?? cell?.getAttribute?.("colspan") ?? 1);
  return Number.isInteger(span) && span > 1 ? span : 1;
};

// A cell's words with a space where the screen breaks a line. textContent glues a name to the phone
// number under it ("Walk-in Customer9876543210"); the space goes between block and emphasis
// children only, so a figure split across inline spans ("₹" + "400.00") is never pulled apart.
const SEPARATED_TAGS = new Set(["DIV", "P", "SMALL", "BR", "LI", "UL", "OL", "STRONG", "B", "EM", "I"]);
const cellText = (cell) => {
  const walk = (node) => {
    const children = Array.from(node?.childNodes || []);
    if (!children.length) return String(node?.textContent ?? "");
    return children.map((child) => {
      if (child.nodeType === 3) return child.textContent;
      const tag = String(child.tagName || "").toUpperCase();
      // Buttons in a cell ("Show lots") are for the screen, never for the page.
      if (tag === "BUTTON" || (child.classList && child.classList.contains("no-print"))) return "";
      const inner = tag === "BR" ? "" : walk(child);
      return SEPARATED_TAGS.has(tag) ? ` ${inner} ` : inner;
    }).join("");
  };
  return cleanText(walk(cell));
};

const tableModel = (table) => {
  const rowNodes = Array.from(table.querySelectorAll("tr"));
  let columns = [];
  const rows = [];
  // Only rows that contain a spanning cell are listed, by row index, so a plain table's model is
  // unchanged. The PDF ignores it; the Excel export places each cell under its own header.
  const spans = {};
  for (const row of rowNodes) {
    const headerCells = Array.from(row.querySelectorAll("th"));
    if (headerCells.length && !columns.length) {
      columns = headerCells.map((cell) => cleanText(cell.textContent));
      continue;
    }
    const cells = Array.from(row.querySelectorAll("td"));
    if (!cells.length) continue;
    const rowSpans = cells.map(cellSpan);
    if (rowSpans.some((span) => span > 1)) spans[rows.length] = rowSpans;
    rows.push(cells.map(cellText));
  }
  if (!columns.length && rows.length) columns = rows[0].map((_, index) => `Column ${index + 1}`);
  return Object.keys(spans).length ? { type: "table", columns, rows, spans } : { type: "table", columns, rows };
};

export const buildReportPdfModel = (root, { title = "", meta = [] } = {}) => {
  const blocks = [];
  if (!root || typeof root.querySelectorAll !== "function") return { title: cleanText(title), meta, blocks };

  // Besides headings, tiles and tables, a statement drawn as label/amount lines (Profit & Loss)
  // marks each line `data-report-line`, with the label and the amount as its first two children,
  // and each sentence that belongs in the export (its period, "No expenses recorded") as
  // `data-report-note`. Without these the export carried P&L's headings and none of its figures.
  const nodes = Array.from(root.querySelectorAll("h1, h2, h3, h4, .summary-metric, table, [data-report-line], [data-report-note]"));
  let metrics = [];
  let lines = [];
  const flushMetrics = () => {
    if (metrics.length) blocks.push({ type: "metrics", items: metrics });
    metrics = [];
  };
  const flushLines = () => {
    if (lines.length) blocks.push({ type: "table", columns: ["Particulars", "Amount"], rows: lines });
    lines = [];
  };

  for (const node of nodes) {
    if (isHiddenFromPrint(node)) continue;
    const tag = String(node.tagName || "").toUpperCase();

    const isLine = Boolean(node.hasAttribute && node.hasAttribute("data-report-line"));
    if (isLine) {
      flushMetrics();
      const parts = Array.from(node.children || []).map((child) => cleanText(child.textContent));
      lines.push([parts[0] || "", parts[1] || ""]);
      continue;
    }
    flushLines();

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
    const text = cellText(node);
    if (text) blocks.push({ type: "heading", text });
  }
  flushMetrics();
  flushLines();

  return { title: cleanText(title), meta: meta.map(cleanText).filter(Boolean), blocks };
};

export const reportPdfHasContent = (model) => Boolean(
  model && Array.isArray(model.blocks) && model.blocks.some((block) => (
    (block.type === "table" && block.rows.length > 0) || block.type === "metrics"
  ))
);

// ---------------------------------------------------------------------------------------------
// Rendering. One look for every report, ledger and statement that leaves the app as a PDF (saved,
// printed or sent on WhatsApp): the shop's name and logo on top, the report's title and filters,
// figures in cards, and tables with a filled header row, room around every cell, zebra rows, totals
// set apart and negatives in red. Inter is embedded (local/reportPdfFonts.js) because the built-in
// Helvetica cannot draw "₹" or "−" at all.

const INK = [20, 35, 27];
const MUTED = [98, 112, 104];
const GREEN = [16, 47, 32];
const MUSTARD = [234, 180, 63];
const RULE = [226, 222, 205];
const ZEBRA = [248, 247, 241];
const CARD = [250, 248, 240];
const TOTAL_FILL = [239, 234, 219];
const NEGATIVE = [163, 39, 31];
const WHITE = [255, 255, 255];

const NEGATIVE_FIGURE = /^\(?\s*[−–-]\s*(₹|rs\.?)?\s*\d|^\(\s*(₹|rs\.?)?\s*\d[\d,.]*\s*\)$/i;
/** True for a figure that reads below zero ("−₹1,900.00", "-₹45.00", "(₹45.00)"). */
export const isNegativeFigure = (value) => NEGATIVE_FIGURE.test(cleanText(value));

const TOTAL_LABEL = /^(grand\s+)?total\b|\btotals?$|^net\b.*\btotal\b|^closing\b|^balance\b.*\bc\/?f\b/i;
/** A row that sums the rows above it: drawn on a tint, in the heavier weight, with a rule over it. */
export const isTotalRow = (row) => (row || []).slice(0, 3).some((cell) => TOTAL_LABEL.test(cleanText(cell)));

const setColor = (doc, kind, color) => {
  if (kind === "text") doc.setTextColor(...color);
  else if (kind === "fill") doc.setFillColor(...color);
  else doc.setDrawColor(...color);
};

const columnWidths = (doc, columns, rows, available, numeric) => {
  const measure = (text, size) => {
    doc.setFontSize(size);
    return doc.getTextWidth(String(text ?? ""));
  };
  const sample = rows.length > 400 ? rows.slice(0, 400) : rows;
  const natural = columns.map((column, index) => {
    let widest = measure(column, 7.5);
    for (const row of sample) widest = Math.max(widest, measure(row[index] ?? "", 7.8));
    // Text columns stop growing at 62 mm and wrap instead, so one long product name cannot squeeze
    // every figure beside it.
    const cap = numeric[index] ? Infinity : 62;
    return Math.max(numeric[index] ? 16 : 18, Math.min(cap, widest + 4.5));
  });
  const total = natural.reduce((sum, width) => sum + width, 0);
  if (total <= available) {
    const slack = available - total;
    // Spare room goes to the text columns (they read better wide); figures keep their width.
    const textTotal = natural.reduce((sum, width, index) => sum + (numeric[index] ? 0 : width), 0);
    if (textTotal > 0) return natural.map((width, index) => (numeric[index] ? width : width + (slack * width) / textTotal));
    return natural.map((width) => width + slack / natural.length);
  }
  // Too wide: text columns give way first, by wrapping, but never below their longest single word
  // (a date or a bill number broken across two lines reads as two values). Then everything shares.
  const longestWord = (index) => {
    let widest = 0;
    for (const word of String(columns[index] ?? "").split(/\s+/)) widest = Math.max(widest, measure(word, 7.5));
    for (const row of sample) {
      const value = String(row[index] ?? "");
      // A short value ("In stock", "Low stock") stays on one line; a long one may break between words.
      if (value.length <= 14) widest = Math.max(widest, measure(value, 7.8));
      else for (const word of value.split(/\s+/)) widest = Math.max(widest, measure(word, 7.8));
    }
    return widest + 4.5;
  };
  const floor = natural.map((width, index) => (numeric[index] ? width : Math.min(width, Math.max(14, longestWord(index)))));
  const floorTotal = floor.reduce((sum, width) => sum + width, 0);
  if (floorTotal <= available) {
    const give = total - floorTotal;
    const room = available - floorTotal;
    return natural.map((width, index) => floor[index] + (give > 0 ? ((width - floor[index]) / give) * room : 0));
  }
  return floor.map((width) => (width / floorTotal) * available);
};

const imageFormat = (dataUrl) => {
  const match = /^data:image\/(png|jpe?g|webp)/i.exec(String(dataUrl || ""));
  if (!match) return "";
  const kind = match[1].toLowerCase();
  return kind === "jpg" || kind === "jpeg" ? "JPEG" : kind.toUpperCase();
};

export const renderReportPdf = ({
  model,
  jsPDF,
  orientation = "portrait",
  generatedAt = "",
  brand = null,
}) => {
  const page = orientation === "landscape" ? A4.LANDSCAPE : A4.PORTRAIT;
  // Compressed streams: an embedded font writes each character as four hex digits, which would
  // otherwise double a long report.
  const doc = new jsPDF({ orientation: orientation === "landscape" ? "l" : "p", unit: "mm", format: "a4", compress: true });
  const font = installReportFonts(doc);
  const margin = 14;
  const footerSpace = 14;
  const available = page.width - margin * 2;
  const bottom = page.height - footerSpace;
  const title = model.title || "Report";
  const shopName = cleanText(brand?.title);
  let y = margin;

  const pen = (weight, size, color = INK) => {
    doc.setFont(font, weight);
    doc.setFontSize(size);
    setColor(doc, "text", color);
  };
  const runningHeader = () => {
    pen("bold", 8, GREEN);
    doc.text(shopName || title, margin, margin + 2.5);
    pen("normal", 8, MUTED);
    if (shopName) doc.text(title, page.width - margin, margin + 2.5, { align: "right" });
    setColor(doc, "draw", RULE);
    doc.setLineWidth(0.25);
    doc.line(margin, margin + 5, page.width - margin, margin + 5);
    y = margin + 10;
  };
  const newPage = () => {
    doc.addPage();
    runningHeader();
  };
  const ensure = (needed) => {
    if (y + needed > bottom) newPage();
  };

  // --- Masthead: the shop, then the report. ---------------------------------------------------
  let textX = margin;
  if (brand?.logo && imageFormat(brand.logo)) {
    try {
      const props = doc.getImageProperties(brand.logo);
      const height = 13;
      const width = Math.min(40, (props.width / Math.max(1, props.height)) * height);
      doc.addImage(brand.logo, imageFormat(brand.logo), margin, y, width, height, undefined, "FAST");
      textX = margin + width + 4;
    } catch {
      textX = margin;
    }
  }
  if (shopName) {
    pen("bold", 12.5, GREEN);
    doc.text(shopName, textX, y + 5.2);
    const tagline = cleanText(brand?.tagline);
    if (tagline) {
      pen("normal", 7.5, MUTED);
      doc.text(tagline, textX, y + 10);
    }
  }
  if (generatedAt) {
    pen("normal", 7.5, MUTED);
    doc.text("Generated", page.width - margin, y + 5.2, { align: "right" });
    pen("bold", 8, INK);
    doc.text(generatedAt, page.width - margin, y + 10, { align: "right" });
  }
  if (shopName || brand?.logo || generatedAt) y += 16;
  setColor(doc, "fill", GREEN);
  doc.rect(margin, y, available, 0.6, "F");
  setColor(doc, "fill", MUSTARD);
  doc.rect(margin, y - 0.3, 26, 1.2, "F");
  y += 8;

  pen("bold", 17, INK);
  for (const line of doc.splitTextToSize(title, available)) {
    doc.text(line, margin, y + 2);
    y += 7.5;
  }

  // The filters the figures were cut by, as small pills: a reader must see which slice this is.
  if (model.meta && model.meta.length) {
    pen("normal", 7.5, INK);
    let x = margin;
    const pillHeight = 5.6;
    for (const line of model.meta) {
      const text = doc.splitTextToSize(line, available - 6)[0] || "";
      const width = doc.getTextWidth(text) + 5;
      if (x > margin && x + width > page.width - margin) {
        x = margin;
        y += pillHeight + 1.8;
      }
      setColor(doc, "fill", CARD);
      setColor(doc, "draw", RULE);
      doc.setLineWidth(0.2);
      doc.roundedRect(x, y - 1, width, pillHeight, 1.6, 1.6, "FD");
      doc.text(text, x + 2.5, y + 2.85);
      x += width + 2;
    }
    y += pillHeight + 3;
  }
  y += 3;

  for (const block of model.blocks) {
    if (block.type === "heading") {
      // The screen's own card title ("Sales History · 46 rows") repeats the PDF's title; once is enough.
      if (title && cleanText(block.text).toLowerCase().startsWith(title.toLowerCase())) continue;
      // A sentence (a period line, a note under a section) reads as a note, wrapped, not as a heading.
      if (cleanText(block.text).length > 56) {
        pen("normal", 8, MUTED);
        const lines = doc.splitTextToSize(cleanText(block.text), available);
        ensure(lines.length * 3.8 + 3);
        lines.forEach((line) => {
          doc.text(line, margin, y + 3);
          y += 3.8;
        });
        y += 3;
        continue;
      }
      ensure(16);
      y += 2;
      setColor(doc, "fill", MUSTARD);
      doc.rect(margin, y, 1.2, 4.6, "F");
      pen("bold", 10.5, GREEN);
      doc.text(doc.splitTextToSize(block.text, available - 4)[0] || "", margin + 3.2, y + 3.7);
      y += 8.5;
      continue;
    }

    if (block.type === "metrics") {
      // Cards are spread evenly over the rows they need: six figures sit 3 + 3, never 4 + 2.
      const most = orientation === "landscape" ? 5 : 4;
      const rowsNeeded = Math.max(1, Math.ceil(block.items.length / most));
      const perRow = Math.max(1, Math.ceil(block.items.length / rowsNeeded));
      const gap = 3;
      const cardWidth = (available - gap * (perRow - 1)) / perRow;
      const cardHeight = 15;
      for (let index = 0; index < block.items.length; index += perRow) {
        ensure(cardHeight + 2);
        block.items.slice(index, index + perRow).forEach((item, column) => {
          const x = margin + column * (cardWidth + gap);
          setColor(doc, "fill", CARD);
          setColor(doc, "draw", RULE);
          doc.setLineWidth(0.25);
          doc.roundedRect(x, y, cardWidth, cardHeight, 2, 2, "FD");
          pen("normal", 7, MUTED);
          doc.text(doc.splitTextToSize(item.label, cardWidth - 6)[0] || "", x + 3, y + 5);
          // A long value ("191.500 Kg • 32.000 Box") steps down in size to fit before it is cut.
          const value = item.value || "—";
          let size = 11.5;
          pen("bold", size, isNegativeFigure(value) ? NEGATIVE : INK);
          while (size > 7.5 && doc.getTextWidth(value) > cardWidth - 6) {
            size -= 0.5;
            doc.setFontSize(size);
          }
          const fitted = doc.getTextWidth(value) > cardWidth - 6 ? `${doc.splitTextToSize(value, cardWidth - 9)[0]}…` : value;
          doc.text(fitted, x + 3, y + 11.2);
        });
        y += cardHeight + gap;
      }
      y += 3;
      continue;
    }

    if (block.type === "table") {
      // Rows with a cell spanning columns (a day's total under three columns) are left out of the
      // measuring: their values do not sit under their own headers.
      const spanned = block.spans || {};
      const plainRows = block.rows.filter((_, index) => !spanned[index]);
      const numeric = block.columns.map((_, index) => {
        const filled = plainRows.filter((row) => cleanText(row[index]) && cleanText(row[index]) !== "—" && cleanText(row[index]) !== "-");
        return filled.length > 0 && filled.filter((row) => isNumericCell(row[index])).length > filled.length / 2;
      });
      const widths = columnWidths(doc, block.columns, plainRows, available, numeric);
      const padX = 2.2;
      const lineHeight = 3.5;

      const drawHeader = () => {
        pen("bold", 7.5, WHITE);
        const lines = block.columns.map((column, index) => doc.splitTextToSize(column, widths[index] - padX * 2).slice(0, 2));
        const height = Math.max(7.5, 3.6 + Math.max(...lines.map((parts) => parts.length), 1) * 3.2);
        ensure(height + 7);
        setColor(doc, "fill", GREEN);
        doc.rect(margin, y, available, height, "F");
        let x = margin;
        lines.forEach((parts, index) => {
          parts.forEach((part, line) => {
            const top = y + 4.8 + line * 3.2;
            if (numeric[index]) doc.text(part, x + widths[index] - padX, top, { align: "right" });
            else doc.text(part, x + padX, top);
          });
          x += widths[index];
        });
        y += height;
      };

      drawHeader();
      block.rows.forEach((row, rowIndex) => {
        const total = isTotalRow(row);
        pen(total ? "bold" : "normal", 7.8, INK);
        // Each value with the columns it covers: one each, or what its colSpan says.
        const rowSpans = spanned[rowIndex] || null;
        let start = 0;
        const segments = (rowSpans ? row : block.columns).map((_, index) => {
          const span = rowSpans ? Math.max(1, Number(rowSpans[index]) || 1) : 1;
          const first = start;
          start += span;
          const last = Math.min(first + span, block.columns.length) - 1;
          const value = String(row[index] ?? "");
          const width = widths.slice(first, last + 1).reduce((sum, item) => sum + item, 0);
          const right = rowSpans ? numeric[last] && isNumericCell(value) : numeric[first];
          return { first, width, value, right };
        }).filter((segment) => segment.first < block.columns.length);
        const cells = segments.map(({ value, width, right }) => {
          if (right) return [doc.splitTextToSize(value, width - padX * 2)[0] || ""];
          // Up to four lines; a longer note ends in "…" so a cut is visible rather than silent.
          const parts = doc.splitTextToSize(value, width - padX * 2);
          if (parts.length <= 4) return parts;
          return [...parts.slice(0, 3), `${String(parts[3]).replace(/\s*\S{0,3}$/, "")}…`];
        });
        const height = Math.max(6.4, 2.9 + Math.max(...cells.map((parts) => parts.length), 1) * lineHeight);
        if (y + height > bottom) {
          newPage();
          drawHeader();
          pen(total ? "bold" : "normal", 7.8, INK);
        }
        if (total) {
          setColor(doc, "fill", TOTAL_FILL);
          doc.rect(margin, y, available, height, "F");
          setColor(doc, "draw", GREEN);
          doc.setLineWidth(0.35);
          doc.line(margin, y, page.width - margin, y);
        } else if (rowIndex % 2 === 1) {
          setColor(doc, "fill", ZEBRA);
          doc.rect(margin, y, available, height, "F");
        }
        cells.forEach((parts, index) => {
          const { first, width, value, right } = segments[index];
          const x = margin + widths.slice(0, first).reduce((sum, item) => sum + item, 0);
          setColor(doc, "text", right && isNegativeFigure(value) ? NEGATIVE : INK);
          parts.forEach((part, line) => {
            const top = y + 4.3 + line * lineHeight;
            if (right) doc.text(part, x + width - padX, top, { align: "right" });
            else doc.text(part, x + padX, top);
          });
        });
        y += height;
        setColor(doc, "draw", RULE);
        doc.setLineWidth(0.15);
        doc.line(margin, y, page.width - margin, y);
      });
      if (!block.rows.length) {
        ensure(8);
        pen("normal", 8, MUTED);
        doc.text("Nothing to show for these filters.", margin + padX, y + 5);
        y += 8;
      }
      y += 7;
    }
  }

  const pageCount = doc.internal.getNumberOfPages();
  for (let index = 1; index <= pageCount; index += 1) {
    doc.setPage(index);
    setColor(doc, "draw", RULE);
    doc.setLineWidth(0.25);
    doc.line(margin, page.height - 10, page.width - margin, page.height - 10);
    pen("normal", 7, MUTED);
    doc.text([shopName, title].filter(Boolean).join("  ·  "), margin, page.height - 6);
    doc.text(`Page ${index} of ${pageCount}`, page.width - margin, page.height - 6, { align: "right" });
  }
  return doc;
};
