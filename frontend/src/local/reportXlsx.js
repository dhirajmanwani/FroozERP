// Excel (.xlsx) export for the Report Center, asked for by the owner on 20 Sep 2026.
//
// It reads the same model the text PDF reads (`buildReportPdfModel` in reportPdf.js), taken from
// the report as it is on screen. So a sheet carries exactly the figures, filters and rows the PDF
// and the screen carry, for every report at once, including the ones whose totals are only worked
// out while the table is drawn (Sales History, Cash Book, P&L, Balance Sheet, Stock Inventory).
// Two exports built from two sources would eventually disagree, and the disagreement would read as
// lost data.
//
// No library: an .xlsx is a zip of a few XML files, and a stored (uncompressed) zip is a page of
// code. Split like reportPdf.js so all of it runs under node:test:
//   buildReportWorkbook(model)  - report model in, rows of typed cells out
//   renderXlsx(workbook)        - rows in, .xlsx bytes out

const cleanText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

// Numbers only where the text is plainly an amount or a quantity. Anything that merely looks
// numeric but is really a name stays text: "004" and 4 are different entities in this app (see
// canonicalInventoryId), a 10-digit mobile number is not a quantity, and a bill number is not a sum.
const ID_LIKE_HEADER = /\b(id|no\.?|number|code|invoice|bill|receipt|voucher|mobile|phone|contact|gst|gstin|pan|pin|lot|batch|hsn|ref|reference|account no)\b/i;
const MONEY_MARK = /₹|\bRs\.?|\bINR\b/i;
// "Bill Amount" and "Invoice Total" are sums even though "bill" and "invoice" name documents.
const AMOUNT_HEADER = /\b(amount|amt|total|value|balance|qty|quantity|rate|price|paid|due|received|count|cost|profit|margin|discount|tax|sale|sales|purchase|stock|weight|kg)\b/i;

export const XLSX_FORMATS = Object.freeze({
  TEXT: 0,
  BOLD: 1,
  MONEY: 2,
  QUANTITY: 3,
  DECIMAL: 4,
  INTEGER: 5,
  PERCENT: 6,
  TITLE: 7,
});

/**
 * One report cell as Excel should hold it: `{ value: number, style }` for an amount, a quantity
 * or a percentage, and `{ value: string, style: TEXT }` for everything else. `header` is the
 * column's heading, used only to keep identifiers as text.
 */
export const reportCellValue = (raw, { header = "" } = {}) => {
  const text = cleanText(raw);
  const asText = { value: text, style: XLSX_FORMATS.TEXT };
  if (!text || text === "-") return asText;
  if (header && ID_LIKE_HEADER.test(header) && !AMOUNT_HEADER.test(header) && !MONEY_MARK.test(text)) return asText;
  const negativeByBrackets = /^\(.*\)$/.test(text);
  const inner = negativeByBrackets ? text.slice(1, -1).trim() : text;
  const match = /^(-)?\s*(?:₹|Rs\.?|INR)?\s*(-)?\s*(\d{1,3}(?:,\d{2,3})*|\d+)(\.\d+)?\s*(%)?$/i.exec(inner);
  if (!match) return asText;
  const [, signBefore, signAfter, whole, fraction = "", percent] = match;
  const digits = whole.replace(/,/g, "");
  // A leading zero is an identifier's, not an amount's ("004", "0012"). "0" and "0.50" are amounts.
  if (digits.length > 1 && digits.startsWith("0")) return asText;
  // Ten or more bare digits with no decimals and no currency is a phone number or a code.
  if (!fraction && !MONEY_MARK.test(inner) && !whole.includes(",") && digits.length >= 10) return asText;
  const number = Number(`${digits}${fraction}`);
  if (!Number.isFinite(number)) return asText;
  // "-₹450.00", "₹-450.00" and the accountant's "(₹450.00)" are all minus 450.
  const signed = signBefore || signAfter || negativeByBrackets ? -number : number;
  if (percent) return { value: signed / 100, style: XLSX_FORMATS.PERCENT };
  if (MONEY_MARK.test(inner)) return { value: signed, style: XLSX_FORMATS.MONEY };
  const decimals = fraction ? fraction.length - 1 : 0;
  if (decimals === 3) return { value: signed, style: XLSX_FORMATS.QUANTITY };
  if (decimals > 0) return { value: signed, style: XLSX_FORMATS.DECIMAL };
  return { value: signed, style: XLSX_FORMATS.INTEGER };
};

const textCell = (value, style = XLSX_FORMATS.TEXT) => ({ value: cleanText(value), style });

// A table row laid out under its headers: a cell spanning three columns sits in the first of them
// and leaves the next two empty, so the cells after it stay under their own headings.
const placeRow = (cells, spans, columns) => {
  const placed = [];
  cells.forEach((cell, index) => {
    const at = placed.length;
    placed.push(reportCellValue(cell, { header: columns[at] || "" }));
    const span = spans?.[index] || 1;
    for (let extra = 1; extra < span; extra += 1) placed.push(null);
  });
  return placed;
};

/**
 * The workbook for one report: a single sheet, top to bottom as the report reads — title, the
 * filters that were in force, when it was made, then each block (totals, headings, tables).
 * `generatedAt` is passed in so the output is reproducible under test.
 */
export const buildReportWorkbook = (model, { generatedAt = "" } = {}) => {
  const title = cleanText(model?.title) || "Report";
  const rows = [];
  rows.push([textCell(title, XLSX_FORMATS.TITLE)]);
  for (const line of Array.isArray(model?.meta) ? model.meta : []) {
    if (cleanText(line)) rows.push([textCell(line)]);
  }
  if (cleanText(generatedAt)) rows.push([textCell(`Generated ${cleanText(generatedAt)}`)]);
  for (const block of Array.isArray(model?.blocks) ? model.blocks : []) {
    rows.push([]);
    if (block.type === "heading") {
      rows.push([textCell(block.text, XLSX_FORMATS.BOLD)]);
    } else if (block.type === "metrics") {
      for (const item of block.items || []) {
        rows.push([textCell(item.label, XLSX_FORMATS.BOLD), reportCellValue(item.value, { header: item.label })]);
      }
    } else if (block.type === "table") {
      const columns = (block.columns || []).map(cleanText);
      if (columns.length) rows.push(columns.map((column) => textCell(column, XLSX_FORMATS.BOLD)));
      (block.rows || []).forEach((cells, index) => rows.push(placeRow(cells, block.spans?.[index], columns)));
    }
  }
  return { sheetName: sheetNameFor(title), rows };
};

/** Whether a workbook carries anything beyond its title lines. */
export const reportWorkbookHasContent = (model) => Boolean(
  model && Array.isArray(model.blocks) && model.blocks.some((block) => (
    (block.type === "table" && (block.rows || []).length > 0) || (block.type === "metrics" && (block.items || []).length > 0)
  ))
);

/** Excel refuses sheet names over 31 characters or containing : \ / ? * [ ]. */
export const sheetNameFor = (title) => {
  const cleaned = cleanText(title).replace(/[:\\/?*[\]]/g, " ").replace(/\s+/g, " ").trim().replace(/^'+|'+$/g, "");
  return (cleaned || "Report").slice(0, 31).trim() || "Report";
};

/** The PDF's file name with an .xlsx ending. */
export const reportXlsxFileName = (fileName, fallback = "Report") => {
  const base = cleanText(fileName).replace(/\.(pdf|xlsx|xls)$/i, "") || cleanText(fallback) || "Report";
  return `${base.replace(/[<>:"/\\|?*]/g, "_")}.xlsx`;
};

// ---------------------------------------------------------------------------------------------
// The .xlsx file itself.
// ---------------------------------------------------------------------------------------------

// XML 1.0 forbids most control characters outright; a stray one from a pasted narration would
// make Excel refuse the whole file ("We found a problem with some content").
const xmlText = (value) => String(value ?? "")
  .replace(/[^\u0009\u000A\u000D -퟿-�\u{10000}-\u{10FFFF}]/gu, "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

export const columnLetter = (index) => {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
};

const displayLength = (cell) => {
  if (!cell) return 0;
  if (typeof cell.value === "number") {
    const digits = Math.abs(cell.value).toFixed(cell.style === XLSX_FORMATS.QUANTITY ? 3 : 2).length;
    return digits + Math.floor(digits / 3) + 2;
  }
  return String(cell.value).length;
};

const sheetXml = ({ rows }) => {
  const widths = [];
  rows.forEach((row) => row.forEach((cell, index) => {
    // A title or a filter line sits alone in column A and would stretch it; it overflows instead.
    if (row.length === 1 && index === 0) return;
    widths[index] = Math.max(widths[index] || 0, displayLength(cell));
  }));
  const cols = widths.length
    ? `<cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${Math.min(60, Math.max(10, (width || 0) + 2))}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const body = rows.map((row, rowIndex) => {
    const cells = row.map((cell, colIndex) => {
      if (!cell) return "";
      const ref = `${columnLetter(colIndex)}${rowIndex + 1}`;
      const style = cell.style ? ` s="${cell.style}"` : "";
      if (typeof cell.value === "number" && Number.isFinite(cell.value)) return `<c r="${ref}"${style}><v>${cell.value}</v></c>`;
      if (cell.value === "") return style ? `<c r="${ref}"${style}/>` : "";
      // Inline strings: text is never a formula here, whatever it starts with ("=", "+", "@").
      return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlText(cell.value)}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${body}</sheetData></worksheet>`;
};

// Order is the XLSX_FORMATS numbering: cellXfs index = style number.
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="4"><numFmt numFmtId="164" formatCode="&quot;₹&quot;#,##0.00;-&quot;₹&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="#,##0.000"/><numFmt numFmtId="166" formatCode="#,##0.00"/><numFmt numFmtId="167" formatCode="0.00%"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const workbookFiles = (workbook) => [
  ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
  ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
  ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlText(sheetNameFor(workbook.sheetName))}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
  ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
  ["xl/styles.xml", STYLES_XML],
  ["xl/worksheets/sheet1.xml", sheetXml(workbook)],
];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

/** A zip with every entry stored (method 0). Names are ASCII; contents are UTF-8. */
export const storedZip = (entries) => {
  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  // 1 Jan 2026 00:00, fixed, so the same report gives the same bytes.
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const [name, content] of entries) {
    const nameBytes = encoder.encode(name);
    const data = typeof content === "string" ? encoder.encode(content) : content;
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** The .xlsx bytes for a workbook from `buildReportWorkbook`. */
export const renderXlsx = (workbook) => storedZip(workbookFiles(workbook));

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
