/**
 * Password hashing — stages A-1 (scrypt), A-2 (no plaintext fallback) and A-5 (no legacy digest).
 *
 * The properties that matter here are the ones whose absence is invisible until a breach: that a
 * hash is salted (so identical passwords do not look identical), that `needsRehash` never fires on
 * a failed attempt (so an attacker's guess can never overwrite a stored hash), and — since A-5 —
 * that neither retired format authenticates anybody, whatever password is supplied with it.
 *
 * The A-5 tests are written as the inverse of the A-1 ones they replace. A-1's contract was "a
 * legacy row still verifies"; A-5's is "a legacy row never verifies, and says so specifically
 * enough that the account can be told to reset". Both halves are asserted, because a change that
 * silently turned the specific refusal back into a generic wrong-password answer would leave a real
 * shopkeeper retyping a correct password with no way to learn why it fails.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  hashPassword,
  hashPasswordSync,
  verifyPassword,
  PASSWORD_FORMATS,
  SCRYPT_PARAMS,
} = require("./passwordHash");

/**
 * The retired pre-A-1 hash, reproduced here rather than imported.
 *
 * A-5 deleted `legacySha256` from the module, and that deletion is the point: production code has
 * no way left to compute this digest. The tests still need to *build* such a row to prove it is
 * refused, so the algorithm lives here, in the only place that should still know it.
 */
const legacySha256 = (password) =>
  crypto.createHash("sha256").update(String(password || ""), "utf8").digest("hex");

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

test("a legacy SHA-256 row no longer authenticates, even with the right password (A-5)", async () => {
  // THE A-5 regression test. An unsalted single-round digest falls to a rainbow table in seconds,
  // so anyone holding a copy of `users` could recover the password and sign in with it. While the
  // verifier accepted this format, the weakest hash in the table was still a working credential.
  //
  // Asserted on the *correct* password on purpose: a test using a wrong password would still pass
  // if the whole branch were restored, and would prove nothing.
  const stored = legacySha256("legacy-user-password");
  const result = await verifyPassword("legacy-user-password", stored);
  assert.equal(result.ok, false, "a retired unsalted digest must never authenticate");
  assert.equal(result.needsRehash, false, "and must never be treated as an upgradable success");
});

test("a legacy row is refused by name, so the account can be told to reset", async () => {
  // The other half of A-5. Refusing is not enough on its own: if this reported UNRECOGNIZED or
  // UNKNOWN, `/login` could not distinguish "old format, reset it" from "wrong password", and the
  // person at the counter would retype a correct password forever.
  const result = await verifyPassword("anything at all", legacySha256("legacy-user-password"));
  assert.equal(result.format, PASSWORD_FORMATS.LEGACY_SHA256);
});

test("a legacy row cannot confirm a guess", async () => {
  // The refusal is by shape, not by comparison — the retired algorithm is not run on the supplied
  // password at all. If it were, the specific `PASSWORD_RESET_REQUIRED` answer would become an
  // oracle: an attacker could learn a password was correct from an account they cannot enter.
  const stored = legacySha256("the-real-one");
  const right = await verifyPassword("the-real-one", stored);
  const wrong = await verifyPassword("nowhere-near-it", stored);
  assert.deepEqual(right, wrong, "correct and incorrect passwords must be reported identically");
});

test("the module offers no way to compute a legacy digest", () => {
  // Deleting the branch but leaving the function exported would let the next caller reintroduce
  // the comparison in a line of code, somewhere with no test watching.
  const passwordHash = require("./passwordHash");
  assert.equal(passwordHash.legacySha256, undefined, "the retired algorithm must not be exported");
  const source = fs.readFileSync(path.join(__dirname, "passwordHash.js"), "utf8");
  assert.doesNotMatch(
    source,
    /createHash\(\s*["']sha256["']\s*\)/,
    "passwordHash.js must not hash anything with plain SHA-256",
  );
});

test("needsRehash is never true for a failed attempt", async () => {
  // Re-hashing on a failure would rewrite the stored hash from an attacker's guess.
  const legacy = legacySha256("real-password");
  const failedLegacy = await verifyPassword("guess", legacy);
  assert.equal(failedLegacy.ok, false);
  assert.equal(failedLegacy.needsRehash, false);

  const unrecognised = "still-plaintext";
  const failedPlain = await verifyPassword("guess", unrecognised);
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
  // suddenly stop working. Written against a scrypt hash since A-5 — the legacy row this used to
  // use no longer verifies whether it is trimmed or not, so it could no longer prove anything.
  const stored = await hashPassword("padded");
  const result = await verifyPassword("padded", `  ${stored}  `);
  assert.equal(result.ok, true);
});

test("a plaintext-valued password column no longer authenticates (A-2)", async () => {
  // THE A-2 regression test. The original passwordMatches ended with
  //   || stored === String(password || "")
  // so any row holding a plaintext password authenticated on that plaintext — a permanent bypass.
  // This must never come back, which is why the assertion is on the exact scenario rather than on
  // the shape of the code.
  const result = await verifyPassword("hunter2", "hunter2");
  assert.equal(result.ok, false, "a plaintext password column must never authenticate");
  assert.equal(result.format, PASSWORD_FORMATS.UNRECOGNIZED);
  assert.equal(result.needsRehash, false);
});

test("the rejection does not reveal whether the plaintext guess was correct", async () => {
  // Reporting "your guess matched the stored plaintext, but you may not come in" would leak the
  // exact fact the rejection exists to protect. A right guess and a wrong one are indistinguishable.
  const right = await verifyPassword("hunter2", "hunter2");
  const wrong = await verifyPassword("not-hunter2", "hunter2");
  assert.deepEqual(right, wrong, "correct and incorrect guesses must be reported identically");
});

test("a legacy-looking value is treated as a hash, not as a plaintext password", async () => {
  // 64 hex characters is the legacy hash shape. Someone whose literal password is 64 hex chars
  // must not authenticate against a row storing that same string as plaintext. Since A-5 nothing
  // with this shape authenticates at all, but the classification still has to be the hash one:
  // falling through to UNRECOGNIZED would lose the specific "reset this account" answer.
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
