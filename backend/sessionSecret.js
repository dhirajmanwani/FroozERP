"use strict";

/**
 * Where the session signing key comes from, and when that source is not good enough.
 *
 * ## The problem this exists for
 *
 * Session tokens are signed with `deviceSessionSecret`, which resolved as:
 *
 *     DEVICE_SESSION_SECRET || DB_PASSWORD || <the database URL> || <the OTP secret>
 *
 * Every entry after the first is a **database credential**. When the signing key is the database
 * password, one leaked credential does two unrelated things: it opens the database *and* it forges
 * a valid session for any user, including Owner. Two failure domains that should be independent
 * become one, and the second one is silent — a forged session looks exactly like a real login.
 *
 * The database URL is worse still: it travels in deploy logs, dashboards, and error messages in
 * ways a password does not, and anyone who has ever seen it can mint Owner sessions indefinitely.
 *
 * ## Why this is not simply "make it required"
 *
 * Requiring `DEVICE_SESSION_SECRET` unconditionally would stop the maintainer's local backend from
 * starting, on a single-maintainer project where local development is the normal case. So the rule
 * is graduated by consequence:
 *
 * - **Anywhere the server is reachable by other people** (production, or a cloud deployment) a
 *   fallback source is **fatal**. Refusing to start is the correct outcome: a server that boots
 *   with a forgeable signing key is worse than one that does not boot, because nobody finds out.
 * - **Locally** it warns, loudly and every time, and keeps working.
 *
 * ## Rotation
 *
 * Changing the secret invalidates every outstanding token, so everyone signs in again. That is a
 * deliberate property — it is also the only revocation mechanism this system currently has.
 */

/** Where the key came from. Anything other than `DEDICATED` is a credential borrowed from elsewhere. */
const SECRET_SOURCES = Object.freeze({
  DEDICATED: "DEVICE_SESSION_SECRET",
  DB_PASSWORD: "DB_PASSWORD",
  DATABASE_URL: "DATABASE_URL",
  OTP_SECRET: "RECOVERY_OTP_SECRET",
  NONE: "NONE",
});

/**
 * Shortest key accepted where the server is exposed.
 *
 * An HMAC key shorter than the 32-byte digest it produces adds no security over a 32-byte one, and
 * a short *human-chosen* key is guessable offline at leisure — an attacker holding one issued token
 * can brute-force the key with no further requests and no rate limit to stop them.
 */
const MIN_EXPOSED_SECRET_LENGTH = 32;

/**
 * Why each fallback is the wrong thing to sign with. Stated per source rather than as one blanket
 * sentence because they fail differently, and an operator acts on the specific reason.
 */
const BORROWED_SOURCE_RISK = Object.freeze({
  [SECRET_SOURCES.DB_PASSWORD]:
    "which is the database password — one leaked credential would then both open the database and " +
    "sign sessions.",
  [SECRET_SOURCES.DATABASE_URL]:
    "which is the database connection string — a value that travels through deploy logs, dashboards " +
    "and error messages far more freely than a password does.",
  [SECRET_SOURCES.OTP_SECRET]:
    "which is the account-recovery hashing secret and itself falls back to the database password — " +
    "so the same value ends up protecting password resets and sessions at once.",
});

const text = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * Resolve the signing key and judge its source.
 *
 * Dependencies are injected rather than read from `process.env` here so the rules are testable
 * without mutating global state — a test that has to set `NODE_ENV=production` to check the
 * production rule tends to leak that setting into whatever runs next.
 *
 * @param {object} input
 * @param {object} input.env                  environment variables
 * @param {string} input.primaryDatabaseUrl   the resolved database URL, if any
 * @param {string} input.recoveryOtpSecret    the OTP hashing secret, the last-resort fallback
 * @param {boolean} input.exposed             true when this server is reachable by other people
 * @returns {{secret: string, source: string, dedicated: boolean, fatal: (null|{code: string, message: string}), warnings: string[]}}
 *   `fatal` non-null means the process must not start. `secret` is still returned so a caller can
 *   log a fingerprint, never the value.
 */
const resolveSessionSecret = ({
  env = {},
  primaryDatabaseUrl = "",
  recoveryOtpSecret = "",
  exposed = false,
} = {}) => {
  const candidates = [
    [SECRET_SOURCES.DEDICATED, text(env.DEVICE_SESSION_SECRET)],
    [SECRET_SOURCES.DB_PASSWORD, text(env.DB_PASSWORD)],
    [SECRET_SOURCES.DATABASE_URL, text(primaryDatabaseUrl)],
    [SECRET_SOURCES.OTP_SECRET, text(recoveryOtpSecret)],
  ];
  const [source, secret] = candidates.find(([, value]) => value) || [SECRET_SOURCES.NONE, ""];

  const dedicated = source === SECRET_SOURCES.DEDICATED;
  const warnings = [];
  let fatal = null;

  if (!secret) {
    // No key at all. `createRequireAuth` already refuses every request in this state; failing at
    // startup instead turns a silent 500-on-every-request into one legible message.
    fatal = {
      code: "SESSION_SECRET_MISSING",
      message:
        "No session signing key is configured. Set DEVICE_SESSION_SECRET to a random value of at " +
        `least ${MIN_EXPOSED_SECRET_LENGTH} characters.`,
    };
    return { secret: "", source, dedicated: false, fatal, warnings };
  }

  if (!dedicated) {
    const complaint =
      `The session signing key is falling back to ${source}, ${BORROWED_SOURCE_RISK[source]} ` +
      "Anyone who learns it can forge a valid session for any user, including Owner, and a forged " +
      "session is indistinguishable from a real login. Set DEVICE_SESSION_SECRET to a dedicated " +
      "random value.";
    if (exposed) {
      fatal = { code: "SESSION_SECRET_NOT_DEDICATED", message: complaint };
    } else {
      warnings.push(`${complaint} (Allowed here because this server is not exposed.)`);
    }
  }

  if (dedicated && secret.length < MIN_EXPOSED_SECRET_LENGTH) {
    const complaint =
      `DEVICE_SESSION_SECRET is ${secret.length} characters; at least ${MIN_EXPOSED_SECRET_LENGTH} ` +
      "are required. A short key can be recovered offline from a single issued token.";
    if (exposed) fatal = { code: "SESSION_SECRET_TOO_SHORT", message: complaint };
    else warnings.push(complaint);
  }

  return { secret, source, dedicated, fatal, warnings };
};

module.exports = {
  MIN_EXPOSED_SECRET_LENGTH,
  SECRET_SOURCES,
  resolveSessionSecret,
};
