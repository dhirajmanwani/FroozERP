// Bootstrap Owner credential verification (docs/offline-activation-design.md §8.1, §8.2).
//
// The signed activation file may carry a bootstrap Owner credential — `owner_username`,
// `owner_salt` (16 bytes) and `owner_verifier` (32 bytes). Rust exposes them via
// `entitlement_status` as hex strings (`owner_salt_hex`, `owner_verifier_hex`). The user types the
// temporary bootstrap password; this module verifies it locally, with no network and no storage.
//
// The verifier is computed by the SAME PBKDF2 scheme as offlineSession.deriveVerifier so a
// bootstrap password verifies byte-identically to a normal offline session. The one convention:
// the salt STRING fed to PBKDF2 is the base64 of the salt bytes (offlineSession stores its salt as
// a base64 string, so the bootstrap path must feed base64(saltBytes) as the salt string to match).
//
// Maintainer signing recipe (mirror of the below):
//   saltBytes    = random 16 bytes
//   verifierBits = PBKDF2(UTF8(username.toLowerCase() + "::" + tempPassword),
//                         UTF8(base64(saltBytes)), SHA-256, 150000, 256 bits)
//   sign hex(saltBytes) as owner_salt_hex and hex(base64decode... )  ->
//   owner_verifier_hex = hex(rawVerifierBits)   // the 32 raw PBKDF2 bytes

const encoder = new TextEncoder();

/** Parse a hex string into bytes. Throws on odd length or non-hex characters. */
export const hexToBytes = (hex) => {
  const text = String(hex == null ? "" : hex).trim();
  if (text.length % 2 !== 0) {
    throw new Error("hex string must have an even number of characters");
  }
  const bytes = new Uint8Array(text.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error("hex string contains a non-hex character");
    }
    bytes[i] = byte;
  }
  return bytes;
};

/** Standard base64 encoding of a byte sequence (Uint8Array or ArrayBuffer). */
export const bytesToBase64 = (bytes) => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  view.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
};

/**
 * Derive the bootstrap verifier, byte-identical to offlineSession.deriveVerifier, where the salt
 * STRING fed to PBKDF2 is base64(saltBytes). Returns the base64 of the 256 derived bits.
 */
export const deriveBootstrapVerifier = async ({ username, password, saltHex }) => {
  const saltString = bytesToBase64(hexToBytes(saltHex));
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(`${String(username || "").toLowerCase()}::${password}`),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: encoder.encode(saltString),
      iterations: 150000,
    },
    material,
    256,
  );
  return bytesToBase64(derived);
};

// Constant-time-ish string comparison — compares every character regardless of early mismatch so
// timing does not leak how much of the verifier matched.
const constantTimeEqual = (a, b) => {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
};

const hasText = (value) => String(value == null ? "" : value).trim().length > 0;

/**
 * Verify a typed bootstrap password against the signed salt/verifier from the activation file.
 * Returns { ok:true, code:"OK" } on match, { ok:false, code:"INVALID_BOOTSTRAP_PASSWORD" } on a
 * mismatch, and { ok:false, code:"MALFORMED_BOOTSTRAP" } when a required field is missing or the
 * hex cannot be parsed. No network, no localStorage.
 */
export const verifyBootstrapCredential = async ({ username, password, saltHex, verifierHex } = {}) => {
  if (!hasText(username) || password == null || password === "" || !hasText(saltHex) || !hasText(verifierHex)) {
    return { ok: false, code: "MALFORMED_BOOTSTRAP" };
  }
  let expectedVerifier;
  let derivedVerifier;
  try {
    expectedVerifier = bytesToBase64(hexToBytes(verifierHex));
    derivedVerifier = await deriveBootstrapVerifier({ username, password, saltHex });
  } catch {
    return { ok: false, code: "MALFORMED_BOOTSTRAP" };
  }
  if (constantTimeEqual(derivedVerifier, expectedVerifier)) {
    return { ok: true, code: "OK" };
  }
  return { ok: false, code: "INVALID_BOOTSTRAP_PASSWORD" };
};
