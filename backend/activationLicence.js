"use strict";

/**
 * FroozERP offline-activation licence issuer — maintainer/back-office side.
 *
 * This is the **third** implementation of the payload layout in
 * `docs/offline-activation-design.md` §4. The other two are:
 *
 *   * `src-tauri/src/entitlement.rs` — `parse_payload` / `verify`. The decoder, and the
 *     contract. If this file and that file ever disagree, that file is right.
 *   * `src-tauri/tools/sign_activation.rs` — the maintainer-local Rust CLI encoder.
 *
 * Nothing is shared between the three on purpose, so agreement between them is evidence
 * rather than tautology. What stops them drifting is fixtures: this module generates
 * `src-tauri/tests/fixtures/node_*.{payload.bin,sig.bin,lic}`, `activationLicence.test.js`
 * regenerates them in memory and asserts they still equal the committed bytes, and
 * `src-tauri/tests/activation_node_encoder.rs` decodes the committed bytes with the real
 * shipped decoder. A change to any one of the three fails a suite instead of failing on a
 * counter in another town.
 *
 * ## Key material
 *
 * The 32-byte Ed25519 seed is an input. It is never generated here, never written anywhere,
 * never logged, and never returned — `issueLicence` returns the *public* half so a caller can
 * record which key signed a licence. There is deliberately no `console` call in this file.
 *
 * ## Refusal policy
 *
 * A licence signed by a key the app does not trust is indistinguishable from a correct one
 * until it reaches the machine it was made for. So before anything is encoded, the public half
 * of the supplied seed is compared against `TRUSTED_ACTIVATION_KEYS` in `entitlement.rs` for
 * the requested `key_id`, and a mismatch is refused with both halves of the comparison named.
 * Every other refusal is likewise a throw with an actionable message, never a silent default.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// --------------------------------------------------------------------------------------------
// Layout constants — mirrors of `entitlement.rs`. Kept as literals, not imported, because this
// is meant to be an independent implementation (see the module comment).
// --------------------------------------------------------------------------------------------

/** `entitlement::FORMAT_VERSION`. */
const FORMAT_VERSION = 1;
/** `entitlement::DEVICE_BINDING_LEN` — SHA-256(device_id)[..8]. */
const DEVICE_BINDING_LEN = 8;
/** `entitlement::SIGNATURE_LEN`. */
const SIGNATURE_LEN = 64;
/** `entitlement::GRACE_DAYS`, for the human `# grace-until:` header line only. */
const GRACE_DAYS = 60;
/** `activation::LIC_CONTAINER_FORMAT`. Versions the text envelope, not the signed bytes. */
const LIC_CONTAINER_FORMAT = "FRZ-LIC/1";
/**
 * Days from 1970-01-01 to `entitlement::DAY_EPOCH` (2020-01-01). Day-stamps in the payload are
 * relative to DAY_EPOCH; JavaScript's clock is relative to the Unix epoch.
 */
const DAY_EPOCH_FROM_UNIX = 18262;

const U16_MAX = 65535;
const U32_MAX = 4294967295;

/** `flags`. Bit 0 would mean "carries a bootstrap Owner credential" (§8.1); this issuer does
 *  not implement the credential path, so the field is always zero. */
const FLAGS = 0;

/** PKCS#8 DER prefix for a raw 32-byte Ed25519 seed (RFC 8410 §7). */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Default location of the decoder whose trusted-key table this issuer must agree with. */
const DEFAULT_TRUSTED_KEYS_PATH = path.join(
  __dirname,
  "..",
  "src-tauri",
  "src",
  "entitlement.rs"
);

// --------------------------------------------------------------------------------------------
// Errors
// --------------------------------------------------------------------------------------------

/**
 * Every refusal from this module. `code` is for programmatic handling; `message` is written to
 * be read by a person who has to fix the call, and never contains key material.
 */
class ActivationLicenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ActivationLicenceError";
    this.code = code;
  }
}

function refuse(code, message) {
  throw new ActivationLicenceError(code, message);
}

// --------------------------------------------------------------------------------------------
// Primitive encoders
// --------------------------------------------------------------------------------------------

/**
 * LEB128 unsigned varint, matching `entitlement::Reader::varint`.
 *
 * BigInt rather than Number: the field is a u64 on the decoding side and `>>` on a Number is a
 * 32-bit operation, which would silently corrupt anything above 2^31.
 */
function encodeVarint(value) {
  let remaining = BigInt(value);
  const out = [];
  for (;;) {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining !== 0n) {
      byte |= 0x80;
    }
    out.push(byte);
    if (remaining === 0n) {
      return Buffer.from(out);
    }
  }
}

/** Truncated SHA-256 of the device identity string — `entitlement::device_binding_hash`. */
function deviceBindingHash(deviceId) {
  return crypto
    .createHash("sha256")
    .update(Buffer.from(deviceId, "utf8"))
    .digest()
    .subarray(0, DEVICE_BINDING_LEN);
}

/** A payload day-stamp rendered as an ISO date, for the unsigned `.lic` header. */
function dayToIso(day) {
  const ms = (DAY_EPOCH_FROM_UNIX + day) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Today as days since `DAY_EPOCH`, UTC. */
function todayDay() {
  return Math.floor(Date.now() / 86400000) - DAY_EPOCH_FROM_UNIX;
}

// --------------------------------------------------------------------------------------------
// Input validation
// --------------------------------------------------------------------------------------------

function requireInteger(value, label, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    refuse(
      "INVALID_FIELD",
      `${label} must be a number, got ${describeType(value)}.`
    );
  }
  if (!Number.isInteger(value)) {
    refuse("INVALID_FIELD", `${label} must be a whole number, got ${value}.`);
  }
  if (value < min || value > max) {
    refuse(
      "INVALID_FIELD",
      `${label} must be between ${min} and ${max}, got ${value}.`
    );
  }
  return value;
}

function describeType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

/**
 * Decode 64 hex characters into a 32-byte seed.
 *
 * Nothing about the *content* of the input reaches the error message — only its length and, for
 * a bad digit, the offset. A refusal must never be a way to get key material into a log.
 */
function decodeSigningSeed(hex) {
  if (typeof hex !== "string") {
    refuse(
      "INVALID_SIGNING_KEY",
      `signingKeyHex must be a 64-character hex string (a 32-byte Ed25519 seed), got ${describeType(
        hex
      )}.`
    );
  }
  if (hex.length !== 64) {
    refuse(
      "INVALID_SIGNING_KEY",
      `signingKeyHex must be exactly 64 hex characters (a 32-byte Ed25519 seed), got ${hex.length} characters.`
    );
  }
  for (let i = 0; i < hex.length; i += 1) {
    if (!/[0-9a-fA-F]/.test(hex[i])) {
      refuse(
        "INVALID_SIGNING_KEY",
        `signingKeyHex is not hexadecimal: the character at index ${i} is not a hex digit.`
      );
    }
  }
  return Buffer.from(hex, "hex");
}

// --------------------------------------------------------------------------------------------
// Trusted key table
// --------------------------------------------------------------------------------------------

/**
 * Read `TRUSTED_ACTIVATION_KEYS` out of `entitlement.rs` source text.
 *
 * Parsing the Rust source rather than keeping a copy here is deliberate: a copy is a thing that
 * can go stale, and the whole point of the check is to catch a key the *shipped app* will not
 * accept. The table is small, the shape is fixed, and a parse that finds nothing throws.
 */
function parseTrustedKeys(source) {
  const marker = source.indexOf("TRUSTED_ACTIVATION_KEYS");
  if (marker < 0) {
    refuse(
      "TRUSTED_KEYS_UNREADABLE",
      "could not find TRUSTED_ACTIVATION_KEYS in the trusted-keys source; " +
        "pass trustedKeysSource explicitly or check src-tauri/src/entitlement.rs."
    );
  }
  const open = source.indexOf("&[", marker);
  const close = source.indexOf("];", open);
  if (open < 0 || close < 0) {
    refuse(
      "TRUSTED_KEYS_UNREADABLE",
      "TRUSTED_ACTIVATION_KEYS was found but its slice literal is not delimited by '&[' … '];'."
    );
  }

  const body = source.slice(open + 2, close).replace(/\/\/[^\n]*/g, "");
  const entry = /\(\s*(0x[0-9a-fA-F]+|\d+)\s*,\s*\[([^\]]*)\]\s*\)/g;
  const keys = new Map();
  let match = entry.exec(body);
  while (match !== null) {
    const keyId = Number(match[1]);
    const bytes = match[2]
      .split(",")
      .map((piece) => piece.trim())
      .filter((piece) => piece.length > 0)
      .map((piece) => Number(piece));
    if (!Number.isInteger(keyId) || keyId < 0 || keyId > 255) {
      refuse(
        "TRUSTED_KEYS_UNREADABLE",
        `TRUSTED_ACTIVATION_KEYS contains a key_id that is not a u8: ${match[1]}.`
      );
    }
    if (bytes.length !== 32 || bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
      refuse(
        "TRUSTED_KEYS_UNREADABLE",
        `TRUSTED_ACTIVATION_KEYS entry for key_id ${keyId} is not 32 byte literals (found ${bytes.length}).`
      );
    }
    if (keys.has(keyId)) {
      refuse(
        "TRUSTED_KEYS_UNREADABLE",
        `TRUSTED_ACTIVATION_KEYS lists key_id ${keyId} twice; the decoder would use the first and this issuer cannot tell which is meant.`
      );
    }
    keys.set(keyId, Buffer.from(bytes).toString("hex"));
    match = entry.exec(body);
  }

  if (keys.size === 0) {
    refuse(
      "TRUSTED_KEYS_UNREADABLE",
      "TRUSTED_ACTIVATION_KEYS was found but no (key_id, [32 bytes]) entries could be read from it."
    );
  }
  return keys;
}

/**
 * `trustedKeysSource` may be Rust source text (anything containing the table) or a path to a
 * file containing it. Omitted, the shipped decoder's own source is read.
 */
function loadTrustedKeys(trustedKeysSource) {
  if (trustedKeysSource === undefined || trustedKeysSource === null) {
    return parseTrustedKeys(readSourceFile(DEFAULT_TRUSTED_KEYS_PATH));
  }
  if (typeof trustedKeysSource !== "string") {
    refuse(
      "INVALID_FIELD",
      `trustedKeysSource must be Rust source text or a path to it, got ${describeType(
        trustedKeysSource
      )}.`
    );
  }
  if (trustedKeysSource.includes("TRUSTED_ACTIVATION_KEYS")) {
    return parseTrustedKeys(trustedKeysSource);
  }
  return parseTrustedKeys(readSourceFile(trustedKeysSource));
}

function readSourceFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (cause) {
    refuse(
      "TRUSTED_KEYS_UNREADABLE",
      `cannot read the trusted-keys source at ${filePath}: ${cause.message}`
    );
  }
  return "";
}

// --------------------------------------------------------------------------------------------
// Payload codec
// --------------------------------------------------------------------------------------------

function encodePayload(fields) {
  const tail = Buffer.alloc(8);
  tail.writeUInt32LE(fields.serial, 0);
  tail.writeUInt16LE(fields.issuedAtDay, 4);
  tail.writeUInt16LE(fields.validDays, 6);

  return Buffer.concat([
    Buffer.from([FORMAT_VERSION, fields.keyId, FLAGS]),
    encodeVarint(fields.companyId),
    encodeVarint(fields.branchId),
    fields.deviceBinding,
    tail,
  ]);
}

/**
 * The inverse of [`encodePayload`], used only as a self-check before a licence is returned.
 *
 * It exists so that an encoder slip — a field written at the wrong offset, a varint that does
 * not terminate where it should, a stray trailing byte — is caught here rather than by
 * `parse_payload` on a counter. It mirrors the decoder's structure, including its refusal to
 * accept trailing bytes.
 */
function decodePayload(bytes) {
  let pos = 0;
  const need = (n, field) => {
    if (pos + n > bytes.length) {
      refuse(
        "SELF_CHECK_FAILED",
        `the payload this issuer just built is truncated in '${field}'; refusing to issue it.`
      );
    }
    const slice = bytes.subarray(pos, pos + n);
    pos += n;
    return slice;
  };
  const varint = (field) => {
    let value = 0n;
    let shift = 0n;
    for (;;) {
      const byte = need(1, field)[0];
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        return Number(value);
      }
      shift += 7n;
      if (shift >= 64n) {
        refuse(
          "SELF_CHECK_FAILED",
          `the payload this issuer just built has a non-terminating varint in '${field}'; refusing to issue it.`
        );
      }
    }
  };

  const formatVersion = need(1, "format_version")[0];
  const keyId = need(1, "key_id")[0];
  const flags = need(1, "flags")[0];
  const companyId = varint("company_id");
  const branchId = varint("branch_id");
  const deviceBinding = Buffer.from(need(DEVICE_BINDING_LEN, "device_binding"));
  const serial = Buffer.from(need(4, "entitlement_serial")).readUInt32LE(0);
  const issuedAtDay = Buffer.from(need(2, "issued_at")).readUInt16LE(0);
  const validDays = Buffer.from(need(2, "valid_days")).readUInt16LE(0);

  if (pos !== bytes.length) {
    refuse(
      "SELF_CHECK_FAILED",
      `the payload this issuer just built has ${bytes.length - pos} trailing byte(s), which the decoder rejects; refusing to issue it.`
    );
  }

  return {
    formatVersion,
    keyId,
    flags,
    companyId,
    branchId,
    deviceBinding,
    serial,
    issuedAtDay,
    validDays,
  };
}

// --------------------------------------------------------------------------------------------
// `.lic` container
// --------------------------------------------------------------------------------------------

/**
 * Render the `.lic` text envelope read by `activation::parse_lic`.
 *
 * `#` lines are UNSIGNED support metadata: they exist so a human can tell which branch and
 * device a file belongs to over the phone. Nothing a reader acts on may come from them.
 */
function renderLic(header, payload, signature) {
  const expiresDay = header.issuedAtDay + header.validDays;
  return (
    "# FroozERP activation file. '#' lines are UNSIGNED support metadata.\n" +
    `# company: ${header.companyId}\n` +
    `# branch: ${header.branchId}\n` +
    `# device: ${header.deviceId}\n` +
    `# serial: ${header.serial}\n` +
    `# key-id: ${header.keyId}\n` +
    `# issued: ${dayToIso(header.issuedAtDay)}\n` +
    `# expires: ${dayToIso(expiresDay)}\n` +
    `# grace-until: ${dayToIso(expiresDay + GRACE_DAYS)}\n` +
    `format: ${LIC_CONTAINER_FORMAT}\n` +
    `payload: ${payload.toString("base64")}\n` +
    `signature: ${signature.toString("base64")}\n`
  );
}

// --------------------------------------------------------------------------------------------
// Public surface
// --------------------------------------------------------------------------------------------

/**
 * Issue one device-bound activation licence.
 *
 * @param {object} options
 * @param {string} options.deviceId      Device identity string, e.g. "FZDEV-…". Required.
 * @param {number} options.validDays     Time frame in days, 1…65535. Required.
 * @param {number} [options.companyId=1] Tenant id, LEB128 varint on the wire.
 * @param {number} [options.branchId=1]  Branch id, LEB128 varint on the wire.
 * @param {number} [options.serial=1]    Entitlement serial, u32.
 * @param {number} [options.keyId=1]     Which trusted key signs this, u8.
 * @param {string} options.signingKeyHex 64 hex characters: the 32-byte Ed25519 seed.
 * @param {number} [options.issuedAtDay] Days since 2020-01-01 UTC. Defaults to today.
 * @param {string} [options.trustedKeysSource] Rust source text, or a path to it. Defaults to
 *                                       `src-tauri/src/entitlement.rs`.
 * @returns {{lic: string, payload: Buffer, signature: Buffer, issuedAtDay: number,
 *            expiresOnDay: number, keyId: number, publicKeyHex: string}}
 *          `lic` is the full `.lic` file text. The signing seed is never returned.
 * @throws {ActivationLicenceError} on any refusal.
 */
function issueLicence(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    refuse(
      "INVALID_FIELD",
      `issueLicence expects an options object, got ${describeType(options)}.`
    );
  }

  const {
    deviceId,
    validDays,
    companyId = 1,
    branchId = 1,
    serial = 1,
    keyId = 1,
    signingKeyHex,
    issuedAtDay,
    trustedKeysSource,
  } = options;

  // --- structural validation ---------------------------------------------------------------

  if (typeof deviceId !== "string") {
    refuse(
      "INVALID_FIELD",
      `deviceId must be a string such as "FZDEV-…", got ${describeType(deviceId)}.`
    );
  }
  if (deviceId.trim().length === 0) {
    refuse(
      "INVALID_FIELD",
      "deviceId must not be empty — the licence is bound to a device and there is nothing to bind it to."
    );
  }

  requireInteger(validDays, "validDays", 1, U16_MAX);
  requireInteger(companyId, "companyId", 0, Number.MAX_SAFE_INTEGER);
  requireInteger(branchId, "branchId", 0, Number.MAX_SAFE_INTEGER);
  requireInteger(serial, "serial", 0, U32_MAX);
  requireInteger(keyId, "keyId", 0, 255);

  const resolvedIssuedAtDay =
    issuedAtDay === undefined || issuedAtDay === null ? todayDay() : issuedAtDay;
  requireInteger(resolvedIssuedAtDay, "issuedAtDay", 0, U16_MAX);

  const seed = decodeSigningSeed(signingKeyHex);

  // --- would the shipped app trust this key? ------------------------------------------------
  //
  // Done before anything is encoded. A licence signed by an untrusted key looks exactly like a
  // correct one until it reaches the machine it was made for, usually in another town.

  let privateKey;
  try {
    privateKey = crypto.createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
      format: "der",
      type: "pkcs8",
    });
  } catch (cause) {
    refuse(
      "INVALID_SIGNING_KEY",
      `the supplied seed is not a usable Ed25519 private key: ${cause.message}`
    );
  }

  const publicKey = crypto.createPublicKey(privateKey);
  const publicKeyHex = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("hex");

  const trustedKeys = loadTrustedKeys(trustedKeysSource);
  const trustedHex = trustedKeys.get(keyId);
  if (trustedHex === undefined) {
    const known = [...trustedKeys.keys()].sort((a, b) => a - b).join(", ");
    refuse(
      "UNKNOWN_KEY_ID",
      `keyId ${keyId} is not in TRUSTED_ACTIVATION_KEYS, so the app would refuse this licence with UnknownKeyId. Known key ids: ${known}.`
    );
  }
  if (trustedHex.toLowerCase() !== publicKeyHex.toLowerCase()) {
    refuse(
      "UNTRUSTED_SIGNING_KEY",
      `the supplied signing key does not match the trusted key for keyId ${keyId}, so the app would refuse this licence with BadSignature. ` +
        `Expected public key ${trustedHex.toLowerCase()}, the supplied seed derives ${publicKeyHex}.`
    );
  }

  // --- encode, sign, and check our own work ------------------------------------------------

  const deviceBinding = deviceBindingHash(deviceId);
  const fields = {
    keyId,
    companyId,
    branchId,
    deviceBinding,
    serial,
    issuedAtDay: resolvedIssuedAtDay,
    validDays,
  };
  const payload = encodePayload(fields);

  const decoded = decodePayload(payload);
  const disagreement = firstDisagreement(fields, decoded);
  if (disagreement !== null) {
    refuse(
      "SELF_CHECK_FAILED",
      `the payload this issuer just built does not decode back to what was asked for (${disagreement}); refusing to issue it.`
    );
  }

  const signature = crypto.sign(null, payload, privateKey);
  if (signature.length !== SIGNATURE_LEN) {
    refuse(
      "SELF_CHECK_FAILED",
      `the signature is ${signature.length} bytes, not ${SIGNATURE_LEN}; refusing to issue it.`
    );
  }
  if (!crypto.verify(null, payload, publicKey, signature)) {
    refuse(
      "SELF_CHECK_FAILED",
      "the signature this issuer just produced does not verify against its own payload; refusing to issue it."
    );
  }

  const expiresOnDay = resolvedIssuedAtDay + validDays;
  const lic = renderLic(
    {
      companyId,
      branchId,
      deviceId,
      serial,
      keyId,
      issuedAtDay: resolvedIssuedAtDay,
      validDays,
    },
    payload,
    signature
  );

  return {
    lic,
    payload,
    signature,
    issuedAtDay: resolvedIssuedAtDay,
    expiresOnDay,
    keyId,
    publicKeyHex,
  };
}

function firstDisagreement(asked, decoded) {
  if (decoded.formatVersion !== FORMAT_VERSION) {
    return `format_version ${decoded.formatVersion} instead of ${FORMAT_VERSION}`;
  }
  if (decoded.flags !== FLAGS) {
    return `flags ${decoded.flags} instead of ${FLAGS}`;
  }
  const scalars = ["keyId", "companyId", "branchId", "serial", "issuedAtDay", "validDays"];
  for (const name of scalars) {
    if (decoded[name] !== asked[name]) {
      return `${name} ${decoded[name]} instead of ${asked[name]}`;
    }
  }
  if (!decoded.deviceBinding.equals(asked.deviceBinding)) {
    return "device_binding does not round-trip";
  }
  return null;
}

module.exports = {
  issueLicence,
  ActivationLicenceError,
  // Exported for the suite that binds this encoder to the Rust decoder, and for callers that
  // need the same primitives without issuing anything.
  deviceBindingHash,
  encodeVarint,
  dayToIso,
  todayDay,
  parseTrustedKeys,
  FORMAT_VERSION,
  DEVICE_BINDING_LEN,
  SIGNATURE_LEN,
  GRACE_DAYS,
  LIC_CONTAINER_FORMAT,
  DAY_EPOCH_FROM_UNIX,
};
