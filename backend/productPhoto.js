"use strict";

/**
 * A photo per product: the one decision about what counts as an acceptable photo.
 *
 * Pure on purpose. The routes in `server.js` call this and nothing else to decide whether a photo
 * may be stored, so the whole rule can be tested without a database, the way every other decision
 * in this repository is.
 *
 * ## What is accepted
 *
 * A `data:` URL, exactly as a browser's `FileReader.readAsDataURL` or `canvas.toDataURL` produces
 * it, for one of three raster formats every counter's webview can draw: JPEG, PNG and WebP. SVG
 * is refused deliberately -- it is a document that can carry script, not a picture. The payload
 * must be strict base64 (the canonical encoding and nothing else), must decode to between 1 byte
 * and 200 KB, and must actually *be* the format it claims: the first bytes are checked against the
 * format's signature, so a renamed file or a mislabelled upload is refused rather than stored and
 * later drawn as a broken image on every till.
 *
 * ## Why 200 KB
 *
 * Every photo in a company is sent to every device that shows products. 200 KB is plenty for a
 * product thumbnail the frontend has already resized, and small enough that a catalogue of a few
 * hundred products stays a download a shop connection can finish.
 *
 * ## What a refusal looks like
 *
 * `{ ok: false, code, message }`. The code is stable and machine-readable; the message is written
 * for the shop owner who picked the photo, not for a developer, because the frontend shows it as-is.
 */

const PRODUCT_PHOTO_MAX_BYTES = 200 * 1024;

/** The only three prefixes accepted, and what the decoded bytes must start with for each. */
const PRODUCT_PHOTO_FORMATS = Object.freeze({
  "image/jpeg": {
    label: "JPEG",
    matches: (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  },
  "image/png": {
    label: "PNG",
    matches: (bytes) => bytes.length >= 4
      && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47,
  },
  "image/webp": {
    label: "WebP",
    // "RIFF" <4-byte size> "WEBP"
    matches: (bytes) => bytes.length >= 12
      && bytes.toString("latin1", 0, 4) === "RIFF"
      && bytes.toString("latin1", 8, 12) === "WEBP",
  },
});

const PRODUCT_PHOTO_CONTENT_TYPES = Object.freeze(Object.keys(PRODUCT_PHOTO_FORMATS));

/**
 * The longest base64 text that can decode to `PRODUCT_PHOTO_MAX_BYTES` or fewer.
 *
 * Checked before decoding, so an oversized upload is refused by its length alone and never costs a
 * buffer allocation the size of whatever the caller chose to send.
 */
const MAX_BASE64_LENGTH = Math.ceil(PRODUCT_PHOTO_MAX_BYTES / 3) * 4;

/** Only the base64 alphabet, padding only at the end, and a whole number of 4-character groups. */
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const PREFIX = /^data:([^;,]*);base64,/;

const refuse = (code, message) => ({ ok: false, code, message });

const MESSAGES = Object.freeze({
  PHOTO_REQUIRED: "Choose a photo first. No photo was received.",
  PHOTO_EMPTY: "The photo is empty. Choose a different photo.",
  PHOTO_FORMAT_UNSUPPORTED: "This type of photo is not supported. Use a JPEG, PNG or WebP photo.",
  PHOTO_NOT_BASE64: "The photo could not be read. Choose the photo again.",
  PHOTO_TOO_LARGE: "The photo is larger than 200 KB. Choose a smaller photo.",
});

const mismatchMessage = (label) =>
  `This file is not a real ${label} photo, although it is named like one. Choose a different photo.`;

/**
 * Decide whether `dataUrl` may be stored as a product photo.
 *
 * @param {unknown} dataUrl what the client sent as `photo`
 * @returns {{ ok: true, contentType: string, byteSize: number, dataUrl: string }
 *   | { ok: false, code: string, message: string }}
 */
const validateProductPhoto = (dataUrl) => {
  if (typeof dataUrl !== "string" || dataUrl.length === 0) {
    return refuse("PHOTO_REQUIRED", MESSAGES.PHOTO_REQUIRED);
  }

  const prefix = PREFIX.exec(dataUrl);
  if (!prefix) {
    // Not a base64 data URL at all -- a web address, a file path, a bare base64 string, or a
    // `data:` URL that is not base64-encoded. None of these is a photo this server can keep.
    return refuse("PHOTO_FORMAT_UNSUPPORTED", MESSAGES.PHOTO_FORMAT_UNSUPPORTED);
  }
  const contentType = prefix[1];
  // Exact, case-sensitive: this is how every browser writes these three, and accepting variants
  // would mean storing a prefix the next reader has to normalise.
  const format = Object.prototype.hasOwnProperty.call(PRODUCT_PHOTO_FORMATS, contentType)
    ? PRODUCT_PHOTO_FORMATS[contentType]
    : null;
  if (!format) {
    return refuse("PHOTO_FORMAT_UNSUPPORTED", MESSAGES.PHOTO_FORMAT_UNSUPPORTED);
  }

  const base64 = dataUrl.slice(prefix[0].length);
  if (base64.length === 0) {
    return refuse("PHOTO_REQUIRED", MESSAGES.PHOTO_EMPTY);
  }
  if (base64.length > MAX_BASE64_LENGTH) {
    return refuse("PHOTO_TOO_LARGE", MESSAGES.PHOTO_TOO_LARGE);
  }
  if (!STRICT_BASE64.test(base64)) {
    return refuse("PHOTO_NOT_BASE64", MESSAGES.PHOTO_NOT_BASE64);
  }

  const bytes = Buffer.from(base64, "base64");
  // Node's decoder is lenient; the round trip is what makes this strict. It refuses the
  // non-canonical spellings the pattern above cannot see (non-zero padding bits), so exactly one
  // text is ever stored for a given photo.
  if (bytes.toString("base64") !== base64) {
    return refuse("PHOTO_NOT_BASE64", MESSAGES.PHOTO_NOT_BASE64);
  }
  if (bytes.length === 0) {
    return refuse("PHOTO_REQUIRED", MESSAGES.PHOTO_EMPTY);
  }
  if (bytes.length > PRODUCT_PHOTO_MAX_BYTES) {
    return refuse("PHOTO_TOO_LARGE", MESSAGES.PHOTO_TOO_LARGE);
  }
  if (!format.matches(bytes)) {
    return refuse("PHOTO_CONTENT_MISMATCH", mismatchMessage(format.label));
  }

  return { ok: true, contentType, byteSize: bytes.length, dataUrl };
};

module.exports = {
  PRODUCT_PHOTO_MAX_BYTES,
  PRODUCT_PHOTO_CONTENT_TYPES,
  validateProductPhoto,
};
