import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hexToBytes,
  bytesToBase64,
  deriveBootstrapVerifier,
  verifyBootstrapCredential,
  isConsumedBootstrapReplay,
  BOOTSTRAP_CONSUMED_CODE,
  BOOTSTRAP_CONSUMED_MESSAGE,
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

// -----------------------------------------------------------------------------------------------
// Replay of a consumed bootstrap credential (§8.2)
//
// The gap these close was found by asking, after the Windows walkthrough, whether a replayed
// temporary password actually produced its own code. It did not: it fell through to the generic
// INVALID_CREDENTIALS, which §8.2 names explicitly as the thing not to do.
// -----------------------------------------------------------------------------------------------

const bootstrapFixture = async ({ consumed, username = "dhirajmanwani", password = "TEMP-PASS-1234" }) => {
  const saltBytes = new Uint8Array(16).fill(0x5a);
  const verifierBase64 = await referenceVerifierBase64({ username, password, saltBytes });
  const verifierBytes = Uint8Array.from(atob(verifierBase64), (c) => c.charCodeAt(0));
  return {
    bootstrap: {
      consumed,
      pending: !consumed,
      owner_username: username,
      owner_salt_hex: bytesToHex(saltBytes),
      owner_verifier_hex: bytesToHex(verifierBytes),
    },
    username,
    password,
  };
};

test("reusing a consumed temporary password is recognised as a replay, not a typo", async () => {
  const { bootstrap, username, password } = await bootstrapFixture({ consumed: true });
  assert.equal(await isConsumedBootstrapReplay({ username, password, bootstrap }), true);
});

test("a genuinely wrong password is not reported as a replay", async () => {
  const { bootstrap, username } = await bootstrapFixture({ consumed: true });
  assert.equal(
    await isConsumedBootstrapReplay({ username, password: "SOMETHING-ELSE", bootstrap }),
    false,
    "only the real temporary password may produce the consumed code",
  );
});

test("an unconsumed credential is never a replay, however correct the password", async () => {
  // While pending, the setup screen owns this password; classifying it as a replay here would
  // mislabel the ordinary activation flow.
  const { bootstrap, username, password } = await bootstrapFixture({ consumed: false });
  assert.equal(await isConsumedBootstrapReplay({ username, password, bootstrap }), false);
});

test("a different user's sign-in is never attributed to the Owner's consumed credential", async () => {
  const { bootstrap, password } = await bootstrapFixture({ consumed: true });
  assert.equal(await isConsumedBootstrapReplay({ username: "cashier", password, bootstrap }), false);
});

test("username comparison is case- and whitespace-insensitive, matching the KDF", async () => {
  const { bootstrap, password } = await bootstrapFixture({ consumed: true });
  assert.equal(await isConsumedBootstrapReplay({ username: "  DHIRAJMANWANI ", password, bootstrap }), true);
});

test("a missing or malformed bootstrap block is never a replay", async () => {
  const password = "TEMP-PASS-1234";
  assert.equal(await isConsumedBootstrapReplay({ username: "x", password, bootstrap: null }), false);
  assert.equal(await isConsumedBootstrapReplay({ username: "x", password, bootstrap: {} }), false);
  assert.equal(await isConsumedBootstrapReplay({}), false);
  assert.equal(
    await isConsumedBootstrapReplay({
      username: "x",
      password,
      bootstrap: { consumed: true, owner_username: "x", owner_salt_hex: "zz", owner_verifier_hex: "zz" },
    }),
    false,
    "unparseable hex must not throw or be treated as a match",
  );
});

test("the consumed code is distinct from the generic credential failure", () => {
  // §8.2: "not folded into INVALID_CREDENTIALS -- a maintainer debugging a branch by phone needs
  // to know which of the two happened."
  assert.equal(BOOTSTRAP_CONSUMED_CODE, "BOOTSTRAP_CREDENTIAL_CONSUMED");
  assert.notEqual(BOOTSTRAP_CONSUMED_CODE, "INVALID_CREDENTIALS");
  assert.ok(BOOTSTRAP_CONSUMED_MESSAGE.trim().length > 0);
  assert.match(BOOTSTRAP_CONSUMED_MESSAGE, /already been used/);
});
