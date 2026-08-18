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

// ---------------------------------------------------------------------------------------------
// Replay of an already-consumed bootstrap credential (§8.2)
// ---------------------------------------------------------------------------------------------

/** Distinct rejection code §8.2 requires: never folded into INVALID_CREDENTIALS. */
export const BOOTSTRAP_CONSUMED_CODE = "BOOTSTRAP_CREDENTIAL_CONSUMED";

export const BOOTSTRAP_CONSUMED_MESSAGE =
  "That temporary activation password has already been used to set up this device. Sign in with the permanent password chosen during setup.";

/**
 * Was this failed sign-in an attempt to reuse the temporary activation password?
 *
 * §8.2 asks for two things that look contradictory until you separate *granting* from
 * *classifying*: "from that point the app never compares against the payload's original verifier
 * again", and "a later attempt is rejected with a distinct BOOTSTRAP_CREDENTIAL_CONSUMED code, not
 * folded into INVALID_CREDENTIALS". Telling the two failures apart is only possible by comparing,
 * so the rule is that the comparison here **never authenticates anyone** — it runs only after
 * authentication has already failed, and its sole output is which error to show. A consumed
 * credential cannot become a way in through this path; `pending` is what gates the setup screen,
 * and consumption clears it permanently.
 *
 * Why it matters: the design describes a maintainer debugging a branch over the phone. "Wrong
 * password" sends them hunting for a typo; "that one was already used, use the new one" ends the
 * call. Same reasoning as every named `RejectReason` in `entitlement.rs`.
 *
 * @param {object} input
 * @param {string} input.username  the username that was attempted.
 * @param {string} input.password  the password that was attempted.
 * @param {object|null} input.bootstrap  `entitlement.bootstrap` as reported by the shell.
 * @returns {Promise<boolean>} true only for a genuine reuse of a consumed credential.
 */
export const isConsumedBootstrapReplay = async ({ username, password, bootstrap } = {}) => {
  if (!bootstrap || bootstrap.consumed !== true) return false;
  const owner = typeof bootstrap.owner_username === "string" ? bootstrap.owner_username.trim() : "";
  const attempted = typeof username === "string" ? username.trim() : "";
  if (!owner || !attempted) return false;
  if (owner.toLowerCase() !== attempted.toLowerCase()) return false;
  const result = await verifyBootstrapCredential({
    username: attempted,
    password,
    saltHex: bootstrap.owner_salt_hex,
    verifierHex: bootstrap.owner_verifier_hex,
  });
  return result.ok === true;
};
