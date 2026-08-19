/**
 * Stage A-1 — password hashing.
 *
 * The properties that matter here are the ones whose absence is invisible until a breach: that a
 * hash is salted (so identical passwords do not look identical), that legacy rows still verify (so
 * nobody is locked out by the upgrade), and that `needsRehash` never fires on a failed attempt (so
 * an attacker's guess can never overwrite a stored hash).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const {
  hashPassword,
  hashPasswordSync,
  verifyPassword,
  legacySha256,
  PASSWORD_FORMATS,
  SCRYPT_PARAMS,
} = require("./passwordHash");

test("a hashed password verifies, and a wrong one does not", async () => {
  const stored = await hashPassword("correct horse battery staple");
  assert.equal((await verifyPassword("correct horse battery staple", stored)).ok, true);
  assert.equal((await verifyPassword("wrong password", stored)).ok, false);
});

test("the same password hashes differently every time (it is salted)", async () => {
  const a = await hashPassword("same-password");
  const b = await hashPassword("same-password");
  assert.notEqual(a, b, "identical passwords must not produce identical hashes");
  // Both must still verify — different salts, same password.
  assert.equal((await verifyPassword("same-password", a)).ok, true);
  assert.equal((await verifyPassword("same-password", b)).ok, true);
});

test("the stored hash carries its own algorithm and parameters", async () => {
  // Self-describing, so raising the cost later cannot break hashes written today.
  const stored = await hashPassword("x");
  assert.match(stored, /^scrypt\$v=1\$n=\d+,r=\d+,p=\d+\$[^$]+\$[^$]+$/);
  assert.ok(stored.includes(`n=${SCRYPT_PARAMS.N}`));
});

test("the plaintext password never appears in the stored hash", async () => {
  const password = "UNIQUE-SENTINEL-VALUE-9931";
  const stored = await hashPassword(password);
  assert.ok(!stored.includes(password));
});

test("a legacy SHA-256 row still verifies, and is flagged for upgrade", async () => {
  // The whole point of A-1: no forced reset, nobody locked out.
  const stored = legacySha256("legacy-user-password");
  const result = await verifyPassword("legacy-user-password", stored);
  assert.equal(result.ok, true);
  assert.equal(result.format, PASSWORD_FORMATS.LEGACY_SHA256);
  assert.equal(result.needsRehash, true, "a legacy hash must be upgraded on next login");
});

test("a legacy row rejects the wrong password", async () => {
  const stored = legacySha256("legacy-user-password");
  assert.equal((await verifyPassword("not-it", stored)).ok, false);
});

test("needsRehash is never true for a failed attempt", async () => {
  // Re-hashing on a failure would rewrite the stored hash from an attacker's guess.
  const legacy = legacySha256("real-password");
  const failedLegacy = await verifyPassword("guess", legacy);
  assert.equal(failedLegacy.ok, false);
  assert.equal(failedLegacy.needsRehash, false);

  const plaintext = "still-plaintext";
  const failedPlain = await verifyPassword("guess", plaintext);
  assert.equal(failedPlain.ok, false);
  assert.equal(failedPlain.needsRehash, false);
});

test("a current-parameter scrypt hash does not ask to be rehashed", async () => {
  const stored = await hashPassword("fresh");
  const result = await verifyPassword("fresh", stored);
  assert.equal(result.ok, true);
  assert.equal(result.needsRehash, false, "no pointless re-hashing on every login");
});

test("a scrypt hash made with weaker parameters is upgraded on next login", async () => {
  // Hand-build a hash at a deliberately lower cost, as an older release would have written.
  const salt = crypto.randomBytes(16);
  const weak = { N: 16384, r: 8, p: 1 };
  const derived = crypto.scryptSync("aging-password", salt, 32, { ...weak, maxmem: 192 * 1024 * 1024 });
  const stored = `scrypt$v=1$n=${weak.N},r=${weak.r},p=${weak.p}$${salt.toString("base64")}$${derived.toString("base64")}`;

  const result = await verifyPassword("aging-password", stored);
  assert.equal(result.ok, true, "an older-cost hash must still verify");
  assert.equal(result.needsRehash, true, "and be re-hashed at the current cost");
});

test("the synchronous hash is interchangeable with the async one", async () => {
  // Used by the schema bootstrap, which cannot await inside a SQL template literal.
  const stored = hashPasswordSync("bootstrap-owner");
  assert.equal((await verifyPassword("bootstrap-owner", stored)).ok, true);
  assert.equal((await verifyPassword("wrong", stored)).ok, false);
});

test("an empty or missing stored hash never authenticates", async () => {
  // A user row with no password must not be a way in — including for an empty password.
  for (const stored of ["", "   ", null, undefined]) {
    const result = await verifyPassword("anything", stored);
    assert.equal(result.ok, false);
    assert.equal(result.format, PASSWORD_FORMATS.EMPTY);
  }
  assert.equal((await verifyPassword("", "")).ok, false, "empty password against empty hash");
});

test("a corrupt scrypt hash fails closed instead of throwing", async () => {
  // A malformed row must fail its own login, not take down the request handler.
  const corrupt = [
    "scrypt$v=1$n=65536,r=8,p=1$notenoughparts",
    "scrypt$v=1$$salt$derived",
    "scrypt$v=1$n=0,r=8,p=1$c2FsdA==$ZGVyaXZlZA==",
    "scrypt$v=99$n=65536,r=8,p=1$c2FsdA==$ZGVyaXZlZA==",
    "scrypt$v=1$n=abc,r=8,p=1$c2FsdA==$ZGVyaXZlZA==",
  ];
  for (const stored of corrupt) {
    const result = await verifyPassword("anything", stored);
    assert.equal(result.ok, false, `must not authenticate: ${stored}`);
  }
});

test("a stored hash is compared after trimming, matching the previous behaviour", async () => {
  // The old passwordMatches trimmed the stored column; rows with stray whitespace must not
  // suddenly stop working.
  const stored = legacySha256("padded");
  const result = await verifyPassword("padded", `  ${stored}  `);
  assert.equal(result.ok, true);
});

test("PLAINTEXT is reported distinctly, so A-2 has an exact target", async () => {
  // A-1 keeps this branch working; A-2 deletes it. The format tag is what makes that safe to do.
  const result = await verifyPassword("hunter2", "hunter2");
  assert.equal(result.ok, true);
  assert.equal(result.format, PASSWORD_FORMATS.PLAINTEXT);
  assert.equal(result.needsRehash, true, "a plaintext row must be upgraded the moment it is used");
});

test("a legacy-looking value is treated as a hash, not as a plaintext password", async () => {
  // 64 hex characters is the legacy hash shape. Someone whose literal password is 64 hex chars
  // must not authenticate against a row storing that same string as plaintext.
  const sixtyFourHex = "a".repeat(64);
  const result = await verifyPassword(sixtyFourHex, sixtyFourHex);
  assert.equal(
    result.ok,
    false,
    "the stored value is interpreted as a SHA-256 digest, so it must not match its own text",
  );
  assert.equal(result.format, PASSWORD_FORMATS.LEGACY_SHA256);
});

// -----------------------------------------------------------------------------------------------
// Regression tests for the properties auth-hardening A-1 exists to establish.
//
// `identityPolicy.test.js` asserts these by matching `server.js` source text, which is how this
// repository pins structure — but a renamed call silently turns a source-text assertion into a
// no-op that still passes. These pin the same properties behaviourally, where a rename cannot
// hide a regression.
// -----------------------------------------------------------------------------------------------

test("a newly written hash is never the old unsalted SHA-256", async () => {
  // The core of A-1. If a future change reverts hashPassword, this fails immediately rather than
  // waiting for a breach to reveal it.
  const password = "owner123";
  const stored = await hashPassword(password);
  assert.notEqual(stored, legacySha256(password));
  assert.ok(!/^[0-9a-f]{64}$/.test(stored), "a new hash must not have the legacy shape");
});

test("two users with the same password get different stored hashes", async () => {
  // Unsalted hashing made identical passwords visibly identical across the user table.
  const a = await hashPassword("shared-password");
  const b = await hashPassword("shared-password");
  assert.notEqual(a, b);
});

test("a hash cannot be verified by supplying the hash itself as the password", async () => {
  // Guards the shape of confusion the plaintext fallback made possible.
  const stored = await hashPassword("real-password");
  assert.equal((await verifyPassword(stored, stored)).ok, false);
});

test("verification is exact: near-miss passwords are rejected", async () => {
  const stored = await hashPassword("Password123");
  for (const attempt of ["password123", "Password123 ", " Password123", "Password12", "Password1234"]) {
    assert.equal((await verifyPassword(attempt, stored)).ok, false, `must reject ${JSON.stringify(attempt)}`);
  }
});
