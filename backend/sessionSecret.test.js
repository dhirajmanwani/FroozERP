"use strict";

/**
 * The session signing key's provenance.
 *
 * The property worth testing here is not "does it pick a value" but "does it refuse the values that
 * quietly couple two failure domains". A server that boots with a forgeable signing key is worse
 * than one that does not boot, because nobody finds out.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MIN_EXPOSED_SECRET_LENGTH,
  SECRET_SOURCES,
  resolveSessionSecret,
} = require("./sessionSecret");

const STRONG = "x".repeat(MIN_EXPOSED_SECRET_LENGTH);

test("a dedicated secret is used and is not complained about", () => {
  const result = resolveSessionSecret({ env: { DEVICE_SESSION_SECRET: STRONG }, exposed: true });
  assert.equal(result.secret, STRONG);
  assert.equal(result.source, SECRET_SOURCES.DEDICATED);
  assert.equal(result.dedicated, true);
  assert.equal(result.fatal, null);
  assert.deepEqual(result.warnings, []);
});

test("an exposed server refuses to start on a borrowed database credential", () => {
  // The whole point. Signing sessions with the database password means one leak does two jobs.
  for (const input of [
    { env: { DB_PASSWORD: STRONG } },
    { env: {}, primaryDatabaseUrl: "postgres://user:pass@host/db" },
    { env: {}, recoveryOtpSecret: STRONG },
  ]) {
    const result = resolveSessionSecret({ ...input, exposed: true });
    assert.notEqual(result.fatal, null, `must refuse ${result.source}`);
    assert.equal(result.fatal.code, "SESSION_SECRET_NOT_DEDICATED");
    assert.equal(result.dedicated, false);
  }
});

test("the same borrowed credential only warns on a server nobody else can reach", () => {
  // Local development is the normal case for a single maintainer; breaking it to improve a
  // production property would just get the check removed.
  const result = resolveSessionSecret({ env: { DB_PASSWORD: STRONG }, exposed: false });
  assert.equal(result.fatal, null);
  assert.equal(result.secret, STRONG);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /DEVICE_SESSION_SECRET/);
});

test("the fallback order is preferred-first, and a dedicated secret always wins", () => {
  const all = {
    env: { DEVICE_SESSION_SECRET: "dedicated", DB_PASSWORD: "db" },
    primaryDatabaseUrl: "postgres://url",
    recoveryOtpSecret: "otp",
  };
  assert.equal(resolveSessionSecret(all).secret, "dedicated");

  const withoutDedicated = { ...all, env: { DB_PASSWORD: "db" } };
  assert.equal(resolveSessionSecret(withoutDedicated).source, SECRET_SOURCES.DB_PASSWORD);

  const urlOnly = { env: {}, primaryDatabaseUrl: "postgres://url", recoveryOtpSecret: "otp" };
  assert.equal(resolveSessionSecret(urlOnly).source, SECRET_SOURCES.DATABASE_URL);
});

test("no key at all is fatal everywhere, exposed or not", () => {
  // Without a key every request already fails inside requireAuth. Failing at startup turns a silent
  // 500-on-everything into one legible message.
  for (const exposed of [true, false]) {
    const result = resolveSessionSecret({ env: {}, exposed });
    assert.equal(result.fatal.code, "SESSION_SECRET_MISSING");
    assert.equal(result.secret, "");
  }
});

test("blank and whitespace-only values are not keys", () => {
  const result = resolveSessionSecret({
    env: { DEVICE_SESSION_SECRET: "   ", DB_PASSWORD: "" },
    exposed: false,
  });
  assert.equal(result.fatal.code, "SESSION_SECRET_MISSING");
});

test("a short dedicated secret is refused on an exposed server", () => {
  // A short HMAC key is recoverable offline from one issued token, with no rate limit in the way.
  const result = resolveSessionSecret({ env: { DEVICE_SESSION_SECRET: "short" }, exposed: true });
  assert.equal(result.fatal.code, "SESSION_SECRET_TOO_SHORT");
});

test("a short dedicated secret warns rather than blocking local work", () => {
  const result = resolveSessionSecret({ env: { DEVICE_SESSION_SECRET: "short" }, exposed: false });
  assert.equal(result.fatal, null);
  assert.equal(result.secret, "short");
  assert.equal(result.warnings.length, 1);
});

test("no message ever contains the key itself", () => {
  // Startup output lands in logs and screenshots. A diagnostic that prints the signing key would
  // leak, through the very channel that exists to report the problem, the thing being protected.
  const secret = "SUPER-SECRET-SENTINEL-VALUE-0001";
  const cases = [
    resolveSessionSecret({ env: { DB_PASSWORD: secret }, exposed: true }),
    resolveSessionSecret({ env: { DB_PASSWORD: secret }, exposed: false }),
    resolveSessionSecret({ env: { DEVICE_SESSION_SECRET: "shrt" }, exposed: true }),
    resolveSessionSecret({ env: {}, primaryDatabaseUrl: `postgres://u:${secret}@h/d`, exposed: true }),
  ];
  for (const result of cases) {
    const emitted = [result.fatal?.message || "", ...result.warnings].join("\n");
    assert.ok(!emitted.includes(secret), `a message leaked the key: ${emitted}`);
    assert.ok(!emitted.includes("shrt"), `a message leaked the key: ${emitted}`);
  }
});

test("a fatal result still reports the source, so the operator knows what to change", () => {
  const result = resolveSessionSecret({ env: { DB_PASSWORD: STRONG }, exposed: true });
  assert.equal(result.source, SECRET_SOURCES.DB_PASSWORD);
  assert.match(result.fatal.message, /DB_PASSWORD/);
  assert.match(result.fatal.message, /DEVICE_SESSION_SECRET/, "and what to set instead");
});
