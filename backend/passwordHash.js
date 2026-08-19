/**
 * Password hashing and verification.
 *
 * Stage A-1 of `docs/auth-hardening-plan.md`. Replaces the unsalted single-round SHA-256
 * (`hashPassword` in `server.js`) with a real password KDF, while still verifying every legacy
 * hash so nobody is locked out. No user-visible change: existing passwords keep working and are
 * upgraded silently on next successful login.
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
 * ## What is deliberately NOT here
 *
 * The plaintext fallback (`stored === password`) is kept in `verifyPassword` for now because
 * A-1's contract is "no behaviour change" — removing it is A-2, immediately after. It is marked
 * `PLAINTEXT` in the returned format so A-2 has an exact target and so any caller can already
 * tell the difference.
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
  LEGACY_SHA256: "LEGACY_SHA256",
  PLAINTEXT: "PLAINTEXT",
  UNKNOWN: "UNKNOWN",
  EMPTY: "EMPTY",
});

const cleanText = (value) => (typeof value === "string" ? value.trim() : "");

/** The exact legacy hash: 64 lowercase hex characters, unsalted single-round SHA-256. */
const LEGACY_SHA256_PATTERN = /^[0-9a-f]{64}$/;

const legacySha256 = (password) =>
  crypto.createHash("sha256").update(String(password || ""), "utf8").digest("hex");

/**
 * Compare two strings without leaking their contents through timing.
 *
 * `timingSafeEqual` throws when lengths differ, and the length check itself leaks length — which
 * is harmless here (hash lengths are fixed and public) but would not be for the secret itself, so
 * this is only ever used on digests, never on a raw password.
 */
const timingSafeEqualString = (a, b) => {
  const bufferA = Buffer.from(String(a), "utf8");
  const bufferB = Buffer.from(String(b), "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
};

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
    const ok = timingSafeEqualString(stored, legacySha256(password));
    return { ok, format: PASSWORD_FORMATS.LEGACY_SHA256, needsRehash: ok };
  }

  // A-2 deletes this branch. Until then it preserves A-1's "no behaviour change" contract for any
  // row whose password column still holds a plaintext value.
  const ok = timingSafeEqualString(stored, String(password ?? ""));
  return { ok, format: PASSWORD_FORMATS.PLAINTEXT, needsRehash: ok };
};

module.exports = {
  hashPassword,
  hashPasswordSync,
  verifyPassword,
  legacySha256,
  PASSWORD_FORMATS,
  SCRYPT_PARAMS,
};
