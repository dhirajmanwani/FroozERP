/**
 * Password hashing and verification.
 *
 * Stage A-1 of `docs/auth-hardening-plan.md` replaced the unsalted single-round SHA-256
 * (`hashPassword` in `server.js`) with a real password KDF. It kept verifying every legacy hash so
 * that nobody was locked out by the upgrade, and re-hashed each one on its next successful login.
 *
 * A-5 finished the job: only scrypt authenticates now. The two retired shapes — the unsalted digest
 * and the pre-migration plaintext column — are still recognised, but only so the account can be
 * told to reset. See "The plaintext fallback is gone (A-2)" and "The legacy SHA-256 verify path is
 * gone too (A-5)" below for what that costs and how an affected account gets back in.
 *
 * ## Why scrypt rather than argon2id
 *
 * The plan names "argon2id (preferred) or bcrypt". This ships Node's built-in `crypto.scrypt`
 * instead, and the reason is deployment reality rather than cryptography:
 *
 * - Both `argon2` and `bcrypt` are **native modules**. They need node-gyp and a C++ toolchain at
 *   install time, or a prebuilt binary matching the exact platform and Node ABI.
 * - `npm --prefix backend test` runs on the maintainer's **Windows** machine. A native dependency
 *   would require Visual Studio Build Tools there, or silently fall back to a prebuilt that may
 *   not exist for the installed Node version. Breaking the maintainer's own test command to
 *   improve password storage is a bad trade for a single-maintainer project.
 * - `crypto.scrypt` is memory-hard, purpose-built for password storage, needs no dependency, and
 *   behaves identically on Windows and Linux. It is a recognised choice for this job — weaker
 *   than argon2id in theory, overwhelmingly stronger than what it replaces in practice.
 *
 * **This is not a one-way door.** Hashes are self-describing (algorithm and parameters are stored
 * in the string), and `verifyPassword` dispatches on that prefix. Adding argon2id later means
 * teaching the dispatcher one more prefix and changing what `hashPassword` emits — existing hashes
 * keep verifying, and re-hash-on-login migrates them with no reset. Raising the scrypt cost later
 * works the same way.
 *
 * ## Stored format
 *
 *     scrypt$v=1$n=65536,r=8,p=1$<salt-base64>$<derived-base64>
 *
 * Parameters live in the hash rather than in code on purpose: a hash written today must stay
 * verifiable after the cost is raised, and that is impossible if the verifier can only assume
 * today's constants.
 *
 * ## The plaintext fallback is gone (A-2)
 *
 * The original `passwordMatches` ended with `|| stored === String(password || "")`, so any row
 * whose password column held a plaintext value authenticated on that plaintext. It existed for
 * migration compatibility and was a permanent bypass while it stayed. It is removed: a stored
 * value that is neither a scrypt hash nor a legacy SHA-256 digest now reports `UNRECOGNIZED` and
 * never authenticates.
 *
 * **Operational consequence, stated plainly:** any account whose password is still stored as
 * plaintext can no longer sign in and needs an administrative password reset. See the A-2 record
 * in `docs/auth-hardening-plan.md` for the query that finds such rows.
 *
 * ## The legacy SHA-256 verify path is gone too (A-5)
 *
 * A-1 kept verifying unsalted single-round SHA-256 digests so that nobody was locked out by the
 * upgrade, and re-hashed them to scrypt on the next successful login. That migration is one-way and
 * self-completing — the population of legacy rows only ever shrinks — but while the verifier still
 * accepted them, the weakest hash in the table was still a working credential. An unsalted
 * single-round digest falls to a rainbow table in seconds, so anyone who obtained a copy of `users`
 * (a leaked backup, a restored dump, a stolen laptop) could recover those passwords and sign in
 * with them. Re-hash-on-login does not help there: the attacker never needs to log in as that user
 * first.
 *
 * So a legacy digest no longer authenticates anyone. It is still *recognised*, by shape, so callers
 * can say "this account's password is stored in a retired format, reset it" instead of the flat
 * "invalid username or password" that would send a real shopkeeper round in circles. What the
 * verifier no longer does is compute the legacy digest of the supplied password and compare it —
 * the retired algorithm is not run at all, on any input, so there is no path by which it can grant
 * access.
 *
 * **Operational consequence, stated plainly:** any account that has not signed in since A-1 shipped
 * can no longer sign in and needs a password reset. Three routes exist and none of them depend on
 * the old hash: self-service OTP recovery (`/auth/recovery/*`), an Owner or Admin resetting the
 * account (`/users/:id/recovery-action`), and `scripts/reset-password.mjs` for whoever holds
 * database access — the backstop that covers an Owner with no verified recovery contact.
 *
 * `reportLegacyPasswordHashes` in `server.js` counts the affected accounts at every startup.
 */

const crypto = require("crypto");

/** Scrypt cost. 64 MiB, ~350ms on the development container; measured, not guessed. */
const SCRYPT_PARAMS = Object.freeze({ N: 65536, r: 8, p: 1 });

/** `crypto.scrypt` refuses to allocate past `maxmem` (default 32 MiB), which N=65536 exceeds. */
const SCRYPT_MAXMEM = 192 * 1024 * 1024;

const SALT_BYTES = 16;
const KEY_BYTES = 32;
const PREFIX = "scrypt";
const FORMAT_VERSION = 1;

/** Hash formats `verifyPassword` can encounter, reported so callers can act on provenance. */
const PASSWORD_FORMATS = Object.freeze({
  SCRYPT: "SCRYPT",
  /**
   * The stored value has the shape of the pre-A-1 unsalted SHA-256 digest. Retired in A-5: it is
   * reported so the account can be told to reset, and it never authenticates (see the module
   * docblock). Reported by *shape* only — the supplied password is not hashed and not compared,
   * so this branch cannot confirm a guess to whoever made it.
   */
  LEGACY_SHA256: "LEGACY_SHA256",
  /**
   * The stored value is neither a scrypt hash nor a legacy SHA-256 digest — so it is not a
   * credential this system can verify, and never authenticates (A-2).
   *
   * In practice this is a row whose password column still holds a plaintext value from before the
   * migration. It is reported by *shape* rather than by comparing against the supplied password,
   * so an operator can diagnose "this row was never migrated" without the check itself confirming
   * a guess to whoever made it.
   */
  UNRECOGNIZED: "UNRECOGNIZED",
  UNKNOWN: "UNKNOWN",
  EMPTY: "EMPTY",
});

const cleanText = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * The exact shape of the retired hash: 64 lowercase hex characters, unsalted single-round SHA-256.
 *
 * A-5 deleted the function that produced it. This pattern is all that remains, and it is used only
 * to *recognise* such a row so the account can be told to reset — never to verify one. There is
 * deliberately no way left in this module to compute a legacy digest.
 */
const LEGACY_SHA256_PATTERN = /^[0-9a-f]{64}$/;

const encodeHash = (salt, derived, params = SCRYPT_PARAMS) =>
  [
    PREFIX,
    `v=${FORMAT_VERSION}`,
    `n=${params.N},r=${params.r},p=${params.p}`,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");

/**
 * Parse a stored scrypt hash. Returns `null` for anything malformed rather than throwing, because
 * a corrupt row must fail the login it belongs to — not take down the request handler.
 */
const decodeHash = (stored) => {
  const parts = String(stored).split("$");
  if (parts.length !== 5) return null;
  const [prefix, version, params, saltB64, derivedB64] = parts;
  if (prefix !== PREFIX) return null;
  if (version !== `v=${FORMAT_VERSION}`) return null;

  const parsed = {};
  for (const pair of params.split(",")) {
    const [key, rawValue] = pair.split("=");
    const value = Number(rawValue);
    if (!Number.isInteger(value) || value <= 0) return null;
    parsed[key] = value;
  }
  if (!parsed.n || !parsed.r || !parsed.p) return null;

  let salt;
  let derived;
  try {
    salt = Buffer.from(saltB64, "base64");
    derived = Buffer.from(derivedB64, "base64");
  } catch {
    return null;
  }
  if (salt.length === 0 || derived.length === 0) return null;

  return { N: parsed.n, r: parsed.r, p: parsed.p, salt, derived };
};

const scryptAsync = (password, salt, keylen, options) =>
  new Promise((resolve, reject) => {
    crypto.scrypt(String(password ?? ""), salt, keylen, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });

/**
 * Hash a password for storage. Async so the KDF runs on the threadpool rather than blocking the
 * event loop — several branches logging in at once must not stall the server.
 *
 * @returns {Promise<string>} the self-describing hash
 */
const hashPassword = async (password) => {
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password, salt, KEY_BYTES, {
    ...SCRYPT_PARAMS,
    maxmem: SCRYPT_MAXMEM,
  });
  return encodeHash(salt, derived);
};

/**
 * Synchronous hash, for the one caller that cannot await: the schema bootstrap in `server.js`,
 * which interpolates the default Owner hash into a SQL template literal at startup. Blocking the
 * event loop there is irrelevant — it happens once, before the server accepts requests.
 *
 * Do not use this on a request path.
 */
const hashPasswordSync = (password) => {
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = crypto.scryptSync(String(password ?? ""), salt, KEY_BYTES, {
    ...SCRYPT_PARAMS,
    maxmem: SCRYPT_MAXMEM,
  });
  return encodeHash(salt, derived);
};

/**
 * Verify a password against a stored hash of any supported format.
 *
 * @returns {Promise<{ok: boolean, format: string, needsRehash: boolean}>}
 *   `needsRehash` is true whenever the stored value is not a current-parameter scrypt hash — the
 *   signal for re-hash-on-login. It is only meaningful when `ok` is true; a caller must never
 *   re-hash on a failed attempt, which would rewrite a hash from an attacker's guess.
 */
const verifyPassword = async (password, storedHash) => {
  const stored = cleanText(storedHash);
  if (!stored) {
    return { ok: false, format: PASSWORD_FORMATS.EMPTY, needsRehash: false };
  }

  if (stored.startsWith(`${PREFIX}$`)) {
    const decoded = decodeHash(stored);
    if (!decoded) {
      return { ok: false, format: PASSWORD_FORMATS.UNKNOWN, needsRehash: false };
    }
    let derived;
    try {
      derived = await scryptAsync(password, decoded.salt, decoded.derived.length, {
        N: decoded.N,
        r: decoded.r,
        p: decoded.p,
        maxmem: SCRYPT_MAXMEM,
      });
    } catch {
      // Parameters that no longer fit within maxmem, or are otherwise unusable on this host.
      return { ok: false, format: PASSWORD_FORMATS.UNKNOWN, needsRehash: false };
    }
    const ok = derived.length === decoded.derived.length
      && crypto.timingSafeEqual(derived, decoded.derived);
    // A hash made with weaker parameters than today's is upgraded on next successful login.
    const currentCost = decoded.N === SCRYPT_PARAMS.N
      && decoded.r === SCRYPT_PARAMS.r
      && decoded.p === SCRYPT_PARAMS.p;
    return { ok, format: PASSWORD_FORMATS.SCRYPT, needsRehash: ok && !currentCost };
  }

  if (LEGACY_SHA256_PATTERN.test(stored)) {
    // A-5: the retired unsalted digest is recognised but never verified. `password` is not hashed
    // here and not compared to anything — the algorithm this branch used to run no longer exists in
    // this module. Reporting the format lets `/login` say "reset this account" instead of "invalid
    // password"; it cannot say "your guess was right", because nothing checked.
    return { ok: false, format: PASSWORD_FORMATS.LEGACY_SHA256, needsRehash: false };
  }

  // A-2: a stored value that is neither a scrypt hash nor a legacy SHA-256 digest is not a
  // credential, and never authenticates.
  //
  // This branch previously compared the stored value directly against the supplied password, so
  // any row whose password column held a plaintext value authenticated on that plaintext. It
  // existed for migration compatibility and was a permanent bypass while it stayed.
  //
  // It deliberately does NOT compare against the supplied password, even to report a more precise
  // error. That comparison would tell a caller "your guess matched, but you may not come in",
  // which leaks the exact fact the rejection exists to protect. The stored value's *shape* is
  // enough for an operator to diagnose "this row was never migrated" without revealing anything
  // about the password itself.
  return { ok: false, format: PASSWORD_FORMATS.UNRECOGNIZED, needsRehash: false };
};

module.exports = {
  hashPassword,
  hashPasswordSync,
  verifyPassword,
  PASSWORD_FORMATS,
  SCRYPT_PARAMS,
};
