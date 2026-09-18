import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../package.json", import.meta.url));
const { jsPDF } = require("jspdf");

const appJsx = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

// What these are for.
//
// Reports and account ledgers export as real text (see reportPdf.test.mjs). Receipts and invoices
// cannot: they are designed documents with a logo and a fixed layout, so they are captured as an
// image and placed in a PDF. That path lives in `exportElementToPdf` in App.jsx, where it cannot be
// imported from here, and until now nothing tested it at all.
//
// The single thing that decides whether those PDFs are sendable is one argument.

// A real PNG, built here rather than mocked, because the thing under test is what jsPDF does with
// one. Signature, IHDR, a single deflated IDAT and IEND — the smallest file the decoder accepts.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
};
const pngDataUrl = (width, height, pixel) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // truecolour RGB
  const scanlines = Buffer.concat(Array.from({ length: height }, (_, y) => {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      row[1 + x * 3] = r;
      row[2 + x * 3] = g;
      row[3 + x * 3] = b;
    }
    return row;
  }));
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(scanlines)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
};

test("jsPDF stores a bitmap raw unless addImage is told to compress it", () => {
  // The measurement behind the argument, reproduced small enough to run in a test. Ruled paper is
  // the friendliest possible case for compression and still shows the gap; on real rendered text
  // in Chromium it measured 10.7 MB -> 0.4 MB for one page and 135.9 MB -> 6.2 MB for seven.
  // This asserts the behaviour rather than restating the claim.
  const image = pngDataUrl(600, 400, (x, y) => (y % 7 === 0 ? [0x11, 0x11, 0x11] : [0xff, 0xff, 0xff]));

  const sizeWith = (compression) => {
    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    doc.addImage(image, "PNG", 0, 0, 210, 140, undefined, compression);
    return doc.output("arraybuffer").byteLength;
  };

  const uncompressed = sizeWith("NONE");
  const compressed = sizeWith("FAST");
  assert.ok(
    compressed * 4 < uncompressed,
    `compression must be worth having: NONE ${uncompressed} bytes vs FAST ${compressed} bytes`,
  );
});

test("every addImage in the export path asks for compression", () => {
  // The guard on the fix. Dropping the argument does not error and does not change how the PDF
  // looks — the file just silently grows past the backend's 25mb body limit again, and receipts
  // stop sending on WhatsApp. There is no way to see that from the local layer, so the call sites
  // are checked here. Asserted against the source because the function it guards is inside a
  // 22,000-line component and cannot be imported.
  const calls = appJsx.match(/\.addImage\([^)]*\)/g) || [];
  assert.ok(calls.length >= 3, `expected the export path's addImage calls, found ${calls.length}`);
  for (const call of calls) {
    assert.match(
      call,
      /imageCompression|"FAST"|"SLOW"/,
      `an addImage call passes no compression argument, so jsPDF will store the bitmap raw: ${call}`,
    );
  }
});

test("the image is captured as PNG, not JPEG", () => {
  // Measured in Chromium on rendered statements: JPEG came out larger than PNG at every size
  // (0.7 vs 0.5 MB at one page, 17.9 vs 13.4 MB at seven), because these pages are sharp black
  // text on flat white — the case PNG wins and photographic coding loses. Switching to JPEG to
  // "save space" is a plausible-sounding change that makes the file bigger and the text worse.
  assert.match(appJsx, /toDataURL\("image\/png"\)/, "the capture must stay PNG");
  assert.doesNotMatch(appJsx, /toDataURL\("image\/jpeg"/, "JPEG measured larger than PNG on this content");
});
