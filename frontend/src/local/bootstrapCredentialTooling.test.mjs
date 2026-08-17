/**
 * Cross-check: the maintainer's credential generator against the app's verifier.
 *
 * `scripts/make-bootstrap-credential.mjs` derives the bootstrap verifier with `node:crypto`
 * (PBKDF2 via `pbkdf2Sync`); `frontend/src/local/bootstrapCredential.js` derives it with WebCrypto
 * (`crypto.subtle.deriveBits`). The two are **deliberately separate implementations**, for the
 * reason `src-tauri/tools/sign_activation.rs` gives for not sharing its encoder with
 * `entitlement.rs`: if the generator and the verifier were the same code, a test comparing them
 * would prove nothing. Kept apart, their agreement is evidence that a credential minted on the
 * maintainer's machine is the credential the device will actually accept.
 *
 * This suite lives here, rather than beside the script, so it runs in the ordinary
 * `node --test frontend/src/local/*.test.mjs` gate. A tool that decides whether an Owner can log
 * in to a branch should not be the one piece of the path with no gate on it.
 *
 * The failure this is really guarding against: the PBKDF2 salt is the UTF-8 bytes of the base64
 * *string* of the salt bytes, not the salt bytes themselves (an `offlineSession.js` convention).
 * Passing the raw bytes instead produces a perfectly well-formed verifier that simply never
 * matches, and the symptom would surface as "the temporary password is wrong" on a branch machine
 * with no way to debug it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildBootstrapCredential,
  bytesToBase64,
  bytesToHex,
  deriveBootstrapVerifierHex,
  generateTemporaryPassword,
  hexToBytes,
  SALT_LEN,
} from "../../../scripts/make-bootstrap-credential.mjs";
import {
  deriveBootstrapVerifier,
  verifyBootstrapCredential,
} from "./bootstrapCredential.js";

const SALT_HEX = "0123456789abcdef0123456789abcdef";

test("the generator's verifier is the one the app derives (two implementations, one answer)", async () => {
  const username = "dhirajmanwani";
  const password = "TEST-ONLY-PASSWORD";

  const toolVerifierHex = deriveBootstrapVerifierHex({ username, password, saltHex: SALT_HEX });
  const appVerifierBase64 = await deriveBootstrapVerifier({ username, password, saltHex: SALT_HEX });

  assert.equal(
    bytesToBase64(hexToBytes(toolVerifierHex)),
    appVerifierBase64,
    "node:crypto and WebCrypto disagree — a .lic signed with this salt/verifier would be rejected",
  );
  assert.equal(toolVerifierHex.length, 64, "verifier must be 32 bytes of hex");
});

test("a generated credential verifies on the device, and a wrong password does not", async () => {
  const credential = buildBootstrapCredential({ username: "owner" });

  const accepted = await verifyBootstrapCredential({
    username: credential.username,
    password: credential.password,
    saltHex: credential.saltHex,
    verifierHex: credential.verifierHex,
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.code, "OK");

  const refused = await verifyBootstrapCredential({
    username: credential.username,
    password: `${credential.password}X`,
    saltHex: credential.saltHex,
    verifierHex: credential.verifierHex,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "INVALID_BOOTSTRAP_PASSWORD");
});

test("the same username differing only in case still verifies (§8.2 case folding)", async () => {
  const credential = buildBootstrapCredential({ username: "Owner" });
  const result = await verifyBootstrapCredential({
    username: "OWNER",
    password: credential.password,
    saltHex: credential.saltHex,
    verifierHex: credential.verifierHex,
  });
  assert.equal(result.ok, true);
});

test("generation fills in a salt and password, and reuses them when supplied", () => {
  const generated = buildBootstrapCredential({ username: "owner" });
  assert.equal(generated.generatedPassword, true);
  assert.equal(generated.generatedSalt, true);
  assert.equal(hexToBytes(generated.saltHex).length, SALT_LEN);

  const reused = buildBootstrapCredential({
    username: "owner",
    password: generated.password,
    saltHex: generated.saltHex,
  });
  assert.equal(reused.generatedPassword, false);
  assert.equal(reused.generatedSalt, false);
  assert.equal(
    reused.verifierHex,
    generated.verifierHex,
    "same username + password + salt must reproduce the same verifier",
  );
});

test("two generated credentials never share a password or a salt", () => {
  const a = buildBootstrapCredential({ username: "owner" });
  const b = buildBootstrapCredential({ username: "owner" });
  assert.notEqual(a.password, b.password);
  assert.notEqual(a.saltHex, b.saltHex);
});

test("the temporary password is high-entropy and safe to read aloud", () => {
  const password = generateTemporaryPassword();
  // 5 groups of 4 from a 32-symbol alphabet = 20 symbols = 100 bits.
  assert.match(password, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/);
  assert.equal(password.replace(/-/g, "").length, 20);
  // Crockford's excluded characters: I and L look like 1, O looks like 0, U looks like V.
  for (const ambiguous of ["I", "L", "O", "U"]) {
    assert.ok(
      !password.includes(ambiguous),
      `${ambiguous} is ambiguous when dictated and must not appear`,
    );
  }
});

test("malformed inputs are refused by name rather than producing a junk verifier", () => {
  assert.throws(() => buildBootstrapCredential({ username: "" }), /username is required/);
  assert.throws(
    () => buildBootstrapCredential({ username: "x".repeat(25) }),
    /24 bytes or fewer/,
    "entitlement.rs caps owner_username at 24 bytes; a longer name cannot be signed",
  );
  assert.throws(
    () => deriveBootstrapVerifierHex({ username: "owner", password: "p", saltHex: "abcd" }),
    /salt must be 16 bytes/,
  );
  assert.throws(
    () => deriveBootstrapVerifierHex({ username: "owner", password: "p", saltHex: "zz".repeat(16) }),
    /non-hex digit/,
  );
  assert.throws(
    () => deriveBootstrapVerifierHex({ username: "owner", password: "", saltHex: SALT_HEX }),
    /password is required/,
  );
});

test("hex and base64 helpers round-trip", () => {
  const bytes = new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xff]);
  assert.equal(bytesToHex(bytes), "00017f80ff");
  assert.deepEqual(Array.from(hexToBytes("00017F80FF")), Array.from(bytes));
  assert.equal(bytesToBase64(new Uint8Array([0xde, 0xad, 0xbe, 0xef])), "3q2+7w==");
});
