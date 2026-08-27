"use strict";

/**
 * A-5, second half — a password stored in a retired format cannot sign anybody in, and says so.
 *
 * `passwordHash.test.js` proves the verifier refuses the retired formats. This proves what `/login`
 * does with that refusal, which is a separate decision and the one a shopkeeper actually meets:
 *
 * - The account is refused with `PASSWORD_RESET_REQUIRED`, not the generic wrong-password answer.
 *   Both refuse; only one leads anywhere. Someone typing the correct password into an account whose
 *   hash is a pre-A-1 digest would otherwise retype it until they gave up, with the server telling
 *   them, truthfully and uselessly, that it was invalid.
 * - No session is issued. The obvious thing to get wrong.
 * - The lockout counters are left alone. Nothing was compared against the supplied password, so
 *   there is no guess to count — and counting it would lock an account that getting the password
 *   right can never unlock, which is a denial of service dressed as a security control.
 *
 * The route is driven for real, with a row underneath it, because every one of those is a property
 * of the handler's control flow rather than of any function it calls. A source-text assertion would
 * pass on a version that ordered the branches wrongly.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  loadServerApp,
  probe,
  setQueryResponder,
  clearQueryResponder,
} = require("./routeAuthCoverage");
const { hashPassword } = require("./passwordHash");

const app = loadServerApp();

/** The retired pre-A-1 hash. Reproduced here because A-5 deleted it from the module. */
const legacySha256 = (password) =>
  crypto.createHash("sha256").update(String(password || ""), "utf8").digest("hex");

const isUserLookup = (sql) => /FROM users u/.test(sql) && /JOIN roles r ON u\.role_id = r\.id/.test(sql);
const isAuditInsert = (sql) => /INSERT INTO auth_audit_log/.test(sql);
const isFailedLoginBookkeeping = (sql) => /UPDATE users/.test(sql) && /failed_login_attempts/.test(sql);

/**
 * Sign in against a `users` row holding `storedHash`, and report what the route did.
 *
 * Every statement the handler issues is captured, so the assertions can be about what the route
 * did *not* do as well as what it answered — which is where the lockout property lives.
 */
const signIn = async ({ storedHash, password }) => {
  const statements = [];
  setQueryResponder((sql) => {
    statements.push(sql);
    if (isUserLookup(sql)) {
      return {
        rows: [{
          id: 7,
          full_name: "Stranded Staff",
          username: "stranded",
          password_hash: storedHash,
          company_id: 1,
          branch_id: 1,
          active: true,
          force_password_change: false,
          session_revocation_version: 0,
          locked_until: null,
          failed_login_attempts: 0,
          last_failed_login_at: null,
          role_name: "Cashier",
          company_name: "Frooz",
          branch_name: "Main",
          branch_active: true,
        }],
        rowCount: 1,
      };
    }
    // Everything else the handler touches on the way out - the audit insert, any bookkeeping -
    // succeeds emptily, so a failure to record cannot be mistaken for the refusal under test.
    return { rows: [], rowCount: 0 };
  });
  try {
    const response = await probe(app, "POST", "/login", {}, {
      username: "stranded",
      password,
      device_id: "test-device-a5",
    });
    return { response, statements };
  } finally {
    clearQueryResponder();
  }
};

test("a pre-A-1 SHA-256 row is refused even when the password is right", async () => {
  // The heart of A-5. Asserted with the *correct* password: a wrong one would be refused by a
  // server that had never removed the legacy path, and would prove nothing.
  const password = "the-real-password";
  const { response } = await signIn({ storedHash: legacySha256(password), password });

  assert.equal(response.status, 401, `expected 401, got ${response.status} (${response.text})`);
  assert.equal(response.code, "PASSWORD_RESET_REQUIRED");
  assert.equal(response.body?.token, undefined, "no session may be issued");
  assert.equal(response.body?.user, undefined, "and no identity handed back");
});

test("a pre-A-2 plaintext row is refused the same way", async () => {
  // The other retired shape. It has been unable to authenticate since A-2, but until A-5 it was
  // refused with the generic wrong-password answer, which is the same dead end.
  const { response } = await signIn({ storedHash: "plaintext-password", password: "plaintext-password" });
  assert.equal(response.status, 401);
  assert.equal(response.code, "PASSWORD_RESET_REQUIRED");
});

test("the refusal names the fix in words a shopkeeper can act on", async () => {
  // The reason this branch exists at all. If the message degrades to a code or to the generic
  // "invalid username or password", the account is stranded again with no way to learn why.
  const { response } = await signIn({ storedHash: legacySha256("x"), password: "x" });
  const message = String(response.body?.message || "");
  assert.match(message, /old format/i, "it must say the saved password is out of date");
  assert.match(message, /forgot password|owner|administrator/i, "and name a way back in");
  assert.doesNotMatch(message, /sha|scrypt|hash/i, "without naming the format, which nobody can act on");
});

test("a retired format never locks the account", async () => {
  // Nothing was compared against the supplied password, so there is no failed guess to record.
  // Counting it would lock an account that no correct password can ever unlock - a lockout the
  // person it hits cannot resolve by remembering.
  const { statements } = await signIn({ storedHash: legacySha256("x"), password: "x" });
  const bookkeeping = statements.filter(isFailedLoginBookkeeping);
  assert.deepEqual(bookkeeping, [], "the lockout counters must not be touched");
});

test("the refusal is still written to the audit trail", async () => {
  // Not counting it toward the lockout must not make it invisible. An operator reading the trail is
  // how a stranded account gets noticed before its owner gives up and stops reporting it.
  const { statements } = await signIn({ storedHash: legacySha256("x"), password: "x" });
  assert.ok(statements.some(isAuditInsert), "the attempt must be recorded");
});

test("a current scrypt row is unaffected: a wrong password is still a wrong password", async () => {
  // The regression that matters in the other direction. If `storedPasswordIsUnusable` widened to
  // cover scrypt, every wrong password in the shop would be answered "reset your account" and the
  // lockout would stop counting - turning a hardening step into an unlimited guessing window.
  const stored = await hashPassword("correct-password");
  const { response, statements } = await signIn({ storedHash: stored, password: "wrong-password" });

  assert.equal(response.code, "INVALID_CREDENTIALS", "a wrong password must stay generic");
  assert.ok(
    statements.some(isFailedLoginBookkeeping),
    "and must still be counted toward the lockout",
  );
});
