import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hexToBytes,
  bytesToBase64,
  deriveBootstrapVerifier,
  verifyBootstrapCredential,
} from "./bootstrapCredential.js";

const encoder = new TextEncoder();

const bytesToHex = (bytes) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

// Compute the expected verifier by the documented recipe, independently of the module under test,
// using crypto.subtle directly. This is the maintainer's signing recipe:
//   material = UTF8(username.toLowerCase() + "::" + password)
//   PBKDF2 salt string = UTF8(base64(saltBytes)); SHA-256; 150000; 256 bits
//   verifier = base64(derived bits)
const referenceVerifierBase64 = async ({ username, password, saltBytes }) => {
  const saltString = bytesToBase64(saltBytes);
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(`${username.toLowerCase()}::${password}`),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(saltString), iterations: 150000 },
    material,
    256,
  );
  return bytesToBase64(new Uint8Array(derived));
};

test("hexToBytes and bytesToBase64 on known vectors", () => {
  assert.deepEqual(Array.from(hexToBytes("00ff10")), [0, 255, 16]);
  assert.deepEqual(Array.from(hexToBytes("")), []);
  assert.equal(bytesToBase64(new Uint8Array([0, 255, 16])), "AP8Q");
  // "hello" in ASCII -> base64 "aGVsbG8="
  assert.equal(bytesToBase64(new Uint8Array([104, 101, 108, 108, 111])), "aGVsbG8=");
  // Round-trip hex -> bytes -> base64 matches direct base64.
  assert.equal(bytesToBase64(hexToBytes("68656c6c6f")), "aGVsbG8=");
});

test("hexToBytes rejects malformed hex", () => {
  assert.throws(() => hexToBytes("abc")); // odd length
  assert.throws(() => hexToBytes("zz")); // non-hex
});

test("round-trip: correct password verifies, wrong password is rejected", async () => {
  const username = "Owner";
  const password = "T3mp-Bootstrap-P@ss-9f2a";
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = bytesToHex(saltBytes);

  const verifierBase64 = await referenceVerifierBase64({ username, password, saltBytes });
  const verifierHex = bytesToHex(new Uint8Array(Buffer.from(verifierBase64, "base64")));

  const right = await verifyBootstrapCredential({ username, password, saltHex, verifierHex });
  assert.equal(right.ok, true);
  assert.equal(right.code, "OK");

  const wrong = await verifyBootstrapCredential({
    username,
    password: "not-the-password",
    saltHex,
    verifierHex,
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, "INVALID_BOOTSTRAP_PASSWORD");
});

test("deriveBootstrapVerifier is deterministic and case-folds the username", async () => {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = bytesToHex(saltBytes);
  const password = "same-password";

  const a = await deriveBootstrapVerifier({ username: "Owner", password, saltHex });
  const b = await deriveBootstrapVerifier({ username: "owner", password, saltHex });
  const c = await deriveBootstrapVerifier({ username: "OWNER", password, saltHex });
  assert.equal(a, b);
  assert.equal(b, c);

  // Deterministic across repeated calls with identical input.
  const again = await deriveBootstrapVerifier({ username: "Owner", password, saltHex });
  assert.equal(a, again);
});

test("derived verifier matches the independent reference recipe", async () => {
  const username = "shopkeeper";
  const password = "another-temp-pass";
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = bytesToHex(saltBytes);

  const fromModule = await deriveBootstrapVerifier({ username, password, saltHex });
  const fromReference = await referenceVerifierBase64({ username, password, saltBytes });
  assert.equal(fromModule, fromReference);
});

test("case-folded username also verifies against a verifier signed for the lowercase name", async () => {
  const password = "Bootstrap-XYZ-123";
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = bytesToHex(saltBytes);
  const verifierBase64 = await referenceVerifierBase64({ username: "owner", password, saltBytes });
  const verifierHex = bytesToHex(new Uint8Array(Buffer.from(verifierBase64, "base64")));

  const result = await verifyBootstrapCredential({ username: "Owner", password, saltHex, verifierHex });
  assert.equal(result.ok, true);
  assert.equal(result.code, "OK");
});

test("malformed inputs (missing verifierHex) yield MALFORMED_BOOTSTRAP", async () => {
  const base = {
    username: "owner",
    password: "pw",
    saltHex: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
    verifierHex: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  assert.equal((await verifyBootstrapCredential({ ...base, verifierHex: undefined })).code, "MALFORMED_BOOTSTRAP");
  assert.equal((await verifyBootstrapCredential({ ...base, verifierHex: "" })).code, "MALFORMED_BOOTSTRAP");
  assert.equal((await verifyBootstrapCredential({ ...base, saltHex: "" })).code, "MALFORMED_BOOTSTRAP");
  assert.equal((await verifyBootstrapCredential({ ...base, username: "" })).code, "MALFORMED_BOOTSTRAP");
  assert.equal((await verifyBootstrapCredential({ ...base, password: "" })).code, "MALFORMED_BOOTSTRAP");
  assert.equal((await verifyBootstrapCredential()).code, "MALFORMED_BOOTSTRAP");
  // Unparseable hex is malformed, not "invalid password".
  assert.equal((await verifyBootstrapCredential({ ...base, verifierHex: "zz" })).code, "MALFORMED_BOOTSTRAP");
});
