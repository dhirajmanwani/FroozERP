"use strict";

/**
 * What counts as a product photo. See `productPhoto.js` for why each rule exists.
 *
 * The refusals matter more than the acceptances: every photo stored is sent to every device that
 * shows products, so a mislabelled or oversized file is not one bad row, it is a broken image or a
 * slow download on every till in the company.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PRODUCT_PHOTO_MAX_BYTES,
  PRODUCT_PHOTO_CONTENT_TYPES,
  validateProductPhoto,
} = require("./productPhoto");

const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0xe0];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const webpMagic = () => [...Buffer.from("RIFF"), 0x10, 0x00, 0x00, 0x00, ...Buffer.from("WEBP"), ...Buffer.from("VP8 ")];

/** Bytes that start with `magic` and are padded out to `size`. */
const bytesOf = (magic, size = 64) => {
  const buffer = Buffer.alloc(Math.max(size, magic.length), 0x41);
  Buffer.from(magic).copy(buffer, 0);
  return buffer;
};

const dataUrl = (contentType, bytes) => `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;

test("the limit is 200 KB and the three raster formats are the only ones accepted", () => {
  assert.equal(PRODUCT_PHOTO_MAX_BYTES, 200 * 1024);
  assert.deepEqual([...PRODUCT_PHOTO_CONTENT_TYPES].sort(), ["image/jpeg", "image/png", "image/webp"]);
});

for (const [contentType, magic] of [
  ["image/jpeg", JPEG_MAGIC],
  ["image/png", PNG_MAGIC],
  ["image/webp", webpMagic()],
]) {
  test(`a real ${contentType} photo is accepted with its type and decoded size`, () => {
    const bytes = bytesOf(magic, 500);
    const url = dataUrl(contentType, bytes);
    const result = validateProductPhoto(url);
    assert.deepEqual(result, { ok: true, contentType, byteSize: 500, dataUrl: url });
  });
}

test("a photo of exactly 200 KB is accepted, and one byte more is refused", () => {
  const atLimit = validateProductPhoto(dataUrl("image/jpeg", bytesOf(JPEG_MAGIC, PRODUCT_PHOTO_MAX_BYTES)));
  assert.equal(atLimit.ok, true);
  assert.equal(atLimit.byteSize, PRODUCT_PHOTO_MAX_BYTES);

  const over = validateProductPhoto(dataUrl("image/jpeg", bytesOf(JPEG_MAGIC, PRODUCT_PHOTO_MAX_BYTES + 1)));
  assert.equal(over.ok, false);
  assert.equal(over.code, "PHOTO_TOO_LARGE");
  assert.equal(over.message, "The photo is larger than 200 KB. Choose a smaller photo.");
});

test("a very large upload is refused by its length, not decoded", () => {
  const huge = `data:image/png;base64,${"A".repeat(5 * 1024 * 1024)}`;
  const result = validateProductPhoto(huge);
  assert.equal(result.code, "PHOTO_TOO_LARGE");
});

for (const [label, value] of [
  ["undefined", undefined],
  ["null", null],
  ["an empty string", ""],
  ["a number", 42],
  ["an object", { photo: "data:image/png;base64,AAAA" }],
]) {
  test(`${label} is refused as PHOTO_REQUIRED`, () => {
    const result = validateProductPhoto(value);
    assert.equal(result.ok, false);
    assert.equal(result.code, "PHOTO_REQUIRED");
    assert.ok(result.message.length > 10);
  });
}

test("a data URL with no bytes after the prefix is refused, never stored as an empty photo", () => {
  const result = validateProductPhoto("data:image/png;base64,");
  assert.equal(result.ok, false);
  assert.equal(result.code, "PHOTO_REQUIRED");
});

for (const [label, value] of [
  ["an SVG, which can carry script", `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`],
  ["a GIF", dataUrl("image/gif", bytesOf([0x47, 0x49, 0x46, 0x38]))],
  ["a PDF", dataUrl("application/pdf", bytesOf([0x25, 0x50, 0x44, 0x46]))],
  ["an upper-case type", dataUrl("IMAGE/PNG", bytesOf(PNG_MAGIC))],
  ["image/jpg, which is not a registered type", dataUrl("image/jpg", bytesOf(JPEG_MAGIC))],
  ["a web address", "https://example.com/apple.jpg"],
  ["a bare base64 string with no prefix", Buffer.from(bytesOf(PNG_MAGIC)).toString("base64")],
  ["a data URL that is not base64-encoded", "data:image/png,%89PNG"],
  ["a data URL with extra parameters", `data:image/png;charset=utf-8;base64,${Buffer.from(bytesOf(PNG_MAGIC)).toString("base64")}`],
]) {
  test(`${label} is refused as PHOTO_FORMAT_UNSUPPORTED`, () => {
    const result = validateProductPhoto(value);
    assert.equal(result.ok, false);
    assert.equal(result.code, "PHOTO_FORMAT_UNSUPPORTED");
    assert.match(result.message, /JPEG, PNG or WebP/);
  });
}

for (const [label, payload] of [
  ["whitespace inside", "iVBO Rw0K"],
  ["a line break inside", "iVBORw0K\nGgoAAAAN"],
  ["URL-safe characters", "iVBORw0K-_oAAAAN"],
  ["a length that is not a multiple of four", "iVBORw0KG"],
  ["padding in the middle", "iV==Rw0K"],
  ["missing padding", "iVBORw0KGg"],
  ["three padding characters", "iVBORw0KG==="],
  ["non-canonical padding bits", "iVBORw0KGh=="],
  ["a character outside the alphabet", "iVBORw0K!goA"],
]) {
  test(`base64 with ${label} is refused as PHOTO_NOT_BASE64`, () => {
    const result = validateProductPhoto(`data:image/png;base64,${payload}`);
    assert.equal(result.ok, false);
    assert.equal(result.code, "PHOTO_NOT_BASE64");
    assert.ok(result.message.length > 10);
  });
}

for (const [label, contentType, magic, expectedLabel] of [
  ["a PNG labelled as JPEG", "image/jpeg", PNG_MAGIC, "JPEG"],
  ["a JPEG labelled as PNG", "image/png", JPEG_MAGIC, "PNG"],
  ["a JPEG labelled as WebP", "image/webp", JPEG_MAGIC, "WebP"],
  ["a RIFF file that is not WebP (a WAV)", "image/webp", [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WAVE")], "WebP"],
  ["plain text labelled as PNG", "image/png", [...Buffer.from("hello, world")], "PNG"],
]) {
  test(`${label} is refused as PHOTO_CONTENT_MISMATCH`, () => {
    const result = validateProductPhoto(dataUrl(contentType, bytesOf(magic)));
    assert.equal(result.ok, false);
    assert.equal(result.code, "PHOTO_CONTENT_MISMATCH");
    assert.match(result.message, new RegExp(`not a real ${expectedLabel} photo`));
  });
}

test("a file shorter than its format's signature is a mismatch, not a crash", () => {
  // Two bytes cannot hold a JPEG's three-byte signature, and eleven cannot hold WebP's twelve.
  assert.equal(validateProductPhoto(dataUrl("image/jpeg", [0xff, 0xd8])).code, "PHOTO_CONTENT_MISMATCH");
  assert.equal(validateProductPhoto(dataUrl("image/webp", webpMagic().slice(0, 11))).code, "PHOTO_CONTENT_MISMATCH");
});

test("every refusal carries a code and a plain message, and nothing else", () => {
  for (const value of [null, "data:image/gif;base64,AAAA", "data:image/png;base64,@@@@", dataUrl("image/png", bytesOf(JPEG_MAGIC))]) {
    const result = validateProductPhoto(value);
    assert.deepEqual(Object.keys(result).sort(), ["code", "message", "ok"]);
    assert.equal(result.ok, false);
    assert.match(result.code, /^PHOTO_[A-Z0-9_]+$/);
    assert.doesNotMatch(result.message, /base64|data:|magic|MIME/i, "messages are for a shop owner, not a developer");
  }
});
