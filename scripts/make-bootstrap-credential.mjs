#!/usr/bin/env node
/**
 * FroozERP bootstrap Owner credential generator — **maintainer-local tool, never shipped.**
 *
 * Stage 5 of `docs/offline-activation-plan.md`. Produces the three values
 * `src-tauri/tools/sign_activation.rs` needs to mint a `.lic` that carries a bootstrap Owner
 * credential (design §8.1):
 *
 *     --bootstrap-username     the Owner username
 *     --bootstrap-salt-hex     16 random bytes, hex
 *     --bootstrap-verifier-hex the PBKDF2 verifier, hex
 *
 * and the temporary password that those two values attest to.
 *
 * ## Why this exists
 *
 * `sign_activation` deliberately takes the salt and verifier as *inputs* rather than deriving
 * them: when it was written no KDF was specified anywhere, and inventing one there would have
 * pre-empted Stage 5, which owns the verification side. Stage 5 has since ruled the KDF — it is
 * the one already used by `frontend/src/local/offlineSession.js`, so a bootstrap password verifies
 * through exactly the same path as an ordinary offline session. This script is the follow-through
 * §8.2 recommended: "the signing CLI auto-generate a high-entropy temporary password ... rather
 * than defaulting to something memorable".
 *
 * ## The KDF, stated exactly
 *
 *     verifier = PBKDF2-SHA256(
 *         password   = UTF8( `${username.toLowerCase()}::${temporaryPassword}` ),
 *         salt       = UTF8( base64(saltBytes) ),      // the base64 STRING's bytes, not saltBytes
 *         iterations = 150000,
 *         length     = 32 bytes )
 *
 * The salt-is-a-base64-string step is not decoration: `offlineSession.deriveVerifier` stores its
 * salt as a base64 string and feeds that string to PBKDF2, so anything that wants to interoperate
 * with a record written by `cacheOfflineSession` has to do the same.
 *
 * This is an **independent implementation** of that derivation (node:crypto here, WebCrypto in
 * `frontend/src/local/bootstrapCredential.js`), on purpose, following the same reasoning
 * `sign_activation.rs` gives for not sharing its encoder with `entitlement.rs`: a test that
 * compares two implementations is evidence, a test that compares one implementation with itself is
 * a tautology. `frontend/src/local/bootstrapCredentialTooling.test.mjs` asserts the two agree and
 * runs in the ordinary local suite.
 *
 * ## Handling of what this prints (§8.2)
 *
 * Signing is not encryption. The salt and verifier travel inside the `.lic` in the clear, so
 * anyone holding the file can attempt an offline guess against them — the credential's real
 * strength is the entropy of the temporary password, which is why this generates 100 bits rather
 * than letting anyone choose something memorable. Relay the password on a channel **separate from
 * the file** (read it aloud on the same phone call that carries the device id); do not put it in
 * the same WhatsApp message as the attachment.
 *
 * No private key is read, written or needed here — this tool does not sign anything.
 *
 * ## Usage
 *
 *   node scripts/make-bootstrap-credential.mjs --username owner
 *   node scripts/make-bootstrap-credential.mjs --username owner --device-id FZDEV-... --serial 42
 *   node scripts/make-bootstrap-credential.mjs --username owner --password 'KNOWN-PASS' --salt-hex <32 hex>
 */

import { pbkdf2Sync, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

/** Matches `offlineSession.deriveVerifier`. Changing any of these breaks every stored record. */
export const PBKDF2_ITERATIONS = 150000;
export const PBKDF2_DIGEST = "sha256";
export const VERIFIER_LEN = 32;
export const SALT_LEN = 16;

/** Design defaults: §8.2 proposes a 7-day bootstrap window. */
export const DEFAULT_BOOTSTRAP_VALID_DAYS = 7;

/**
 * Crockford base32 — no I, L, O or U. The same alphabet §7.2 picks for typed codes, and for the
 * same reason: this password gets dictated over a phone call to a branch, so a character that can
 * be misheard as another character is a support call waiting to happen.
 */
const PASSWORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PASSWORD_GROUPS = 5;
const PASSWORD_GROUP_LEN = 4;

export const bytesToBase64 = (bytes) => Buffer.from(bytes).toString("base64");

export const bytesToHex = (bytes) => Buffer.from(bytes).toString("hex");

export const hexToBytes = (hex) => {
  const clean = String(hex || "").replace(/\s+/g, "");
  if (clean.length % 2 !== 0) throw new Error("hex input has an odd number of digits");
  if (!/^[0-9a-fA-F]*$/.test(clean)) throw new Error("hex input contains a non-hex digit");
  return new Uint8Array(Buffer.from(clean, "hex"));
};

/**
 * 20 characters from a 32-symbol alphabet = 100 bits, printed in dash-separated groups of four.
 *
 * The dashes are part of the password: they are what makes it readable aloud and typeable without
 * losing position, and both this generator and the person typing it treat the grouped string as
 * the literal secret. `256 % 32 === 0`, so masking five bits off a random byte is uniform — no
 * modulo bias to reason about.
 */
export const generateTemporaryPassword = () => {
  const total = PASSWORD_GROUPS * PASSWORD_GROUP_LEN;
  const raw = randomBytes(total);
  const chars = Array.from(raw, (byte) => PASSWORD_ALPHABET[byte & 31]);
  const groups = [];
  for (let i = 0; i < total; i += PASSWORD_GROUP_LEN) {
    groups.push(chars.slice(i, i + PASSWORD_GROUP_LEN).join(""));
  }
  return groups.join("-");
};

/**
 * The verifier, hex-encoded for `sign_activation --bootstrap-verifier-hex`.
 *
 * @param {{username: string, password: string, saltHex: string}} input
 * @returns {string} 64 lowercase hex characters (32 bytes)
 */
export const deriveBootstrapVerifierHex = ({ username, password, saltHex }) => {
  const name = String(username || "").trim().toLowerCase();
  if (!name) throw new Error("username is required");
  if (!password) throw new Error("password is required");
  const saltBytes = hexToBytes(saltHex);
  if (saltBytes.length !== SALT_LEN) {
    throw new Error(`salt must be ${SALT_LEN} bytes (${SALT_LEN * 2} hex digits)`);
  }
  const material = Buffer.from(`${name}::${password}`, "utf8");
  // The PBKDF2 salt is the UTF-8 bytes of the base64 *string*, matching offlineSession.js.
  const saltForKdf = Buffer.from(bytesToBase64(saltBytes), "utf8");
  const derived = pbkdf2Sync(
    material,
    saltForKdf,
    PBKDF2_ITERATIONS,
    VERIFIER_LEN,
    PBKDF2_DIGEST,
  );
  return derived.toString("hex");
};

/**
 * Everything needed to sign a bootstrap `.lic`, generating whatever was not supplied.
 *
 * @returns {{username: string, password: string, saltHex: string, verifierHex: string,
 *            generatedPassword: boolean, generatedSalt: boolean}}
 */
export const buildBootstrapCredential = ({ username, password, saltHex } = {}) => {
  const name = String(username || "").trim();
  if (!name) throw new Error("username is required");
  if (Buffer.byteLength(name, "utf8") > 24) {
    // MAX_OWNER_USERNAME_LEN in entitlement.rs — the payload cannot carry more.
    throw new Error("username must be 24 bytes or fewer");
  }
  const generatedPassword = !password;
  const generatedSalt = !saltHex;
  const finalPassword = password || generateTemporaryPassword();
  const finalSaltHex = saltHex ? bytesToHex(hexToBytes(saltHex)) : bytesToHex(randomBytes(SALT_LEN));
  const verifierHex = deriveBootstrapVerifierHex({
    username: name,
    password: finalPassword,
    saltHex: finalSaltHex,
  });
  return {
    username: name,
    password: finalPassword,
    saltHex: finalSaltHex,
    verifierHex,
    generatedPassword,
    generatedSalt,
  };
};

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const OPTIONS = [
  "username",
  "password",
  "salt-hex",
  "valid-days",
  "device-id",
  "company",
  "branch",
  "serial",
  "key",
  "out",
];

const HELP = `make-bootstrap-credential — FroozERP bootstrap Owner credential generator
                                (maintainer-local; not shipped; signs nothing)

USAGE
  node scripts/make-bootstrap-credential.mjs --username <owner> [options]

OPTIONS
  --username <s>    Owner username, 1..=24 bytes                        (required)
  --password <s>    Use this temporary password instead of generating one
  --salt-hex <hex>  Reuse an existing 16-byte salt (32 hex digits)
  --valid-days <n>  Bootstrap window written into the printed command   [${DEFAULT_BOOTSTRAP_VALID_DAYS}]

  The rest are only used to fill in the sign_activation command line this prints:
  --device-id <s>   Device id read off the activation screen
  --company <n>     company_id                                          [1]
  --branch <n>      branch_id                                           [1]
  --serial <n>      entitlement_serial                                  [1]
  --key <path>      Path to the Ed25519 seed file
  --out <path>      Where sign_activation should write the .lic

NOTES
  Nothing here reads or needs a private key. Relay the temporary password on a channel
  SEPARATE from the .lic file (design §8.2): the salt and verifier travel in the file in
  cleartext, so the credential's strength is the password's entropy alone.
`;

const parseArgs = (argv) => {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "help" || token === "--help" || token === "-h") {
      values.set("help", "1");
      continue;
    }
    if (!token.startsWith("--")) {
      throw new Error(`unexpected argument '${token}' (options start with --)`);
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    let name;
    let value;
    if (eq >= 0) {
      name = body.slice(0, eq);
      value = body.slice(eq + 1);
    } else {
      name = body;
      value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`--${name} needs a value`);
      }
      i += 1;
    }
    // Reject typos rather than ignoring them: a silently dropped --password would mint a
    // credential for a random password nobody was told about. sign_activation does the same.
    if (!OPTIONS.includes(name)) throw new Error(`unknown option --${name}`);
    values.set(name, value);
  }
  return values;
};

const main = (argv) => {
  const args = parseArgs(argv);
  if (args.has("help") || args.size === 0) {
    process.stdout.write(HELP);
    return 0;
  }

  const credential = buildBootstrapCredential({
    username: args.get("username"),
    password: args.get("password"),
    saltHex: args.get("salt-hex"),
  });
  const validDays = args.get("valid-days") || String(DEFAULT_BOOTSTRAP_VALID_DAYS);
  if (!/^\d+$/.test(validDays) || Number(validDays) === 0) {
    throw new Error("--valid-days must be a positive whole number");
  }

  const signCommand = [
    "cargo run --manifest-path src-tauri/Cargo.toml --features signing-cli",
    "  --bin sign_activation -- sign \\",
    `    --key ${args.get("key") || "<path-to-seed-file>"} \\`,
    `    --device-id ${args.get("device-id") || "<device-id-from-activation-screen>"} \\`,
    `    --company ${args.get("company") || "1"} \\`,
    `    --branch ${args.get("branch") || "1"} \\`,
    `    --serial ${args.get("serial") || "1"} \\`,
    `    --bootstrap-username ${credential.username} \\`,
    `    --bootstrap-salt-hex ${credential.saltHex} \\`,
    `    --bootstrap-verifier-hex ${credential.verifierHex} \\`,
    `    --bootstrap-valid-days ${validDays} \\`,
    `    --out ${args.get("out") || "<device>.lic"}`,
  ].join("\n");

  const lines = [
    "",
    "  BOOTSTRAP OWNER CREDENTIAL",
    "  ==========================",
    "",
    `  Owner username      ${credential.username}`,
    `  Temporary password  ${credential.password}${credential.generatedPassword ? "" : "   (supplied)"}`,
    `  Bootstrap window    ${validDays} day(s) from the issue date`,
    "",
    `  salt-hex            ${credential.saltHex}${credential.generatedSalt ? "" : "   (supplied)"}`,
    `  verifier-hex        ${credential.verifierHex}`,
    "",
    "  Sign the .lic with:",
    "",
    signCommand,
    "",
    "  Then, per design §8.2:",
    "    - Send the .lic to the branch (WhatsApp attachment is the expected route).",
    "    - Read the temporary password aloud on a SEPARATE channel — not in the same message.",
    "    - The password stops working the moment the Owner completes the forced change on the",
    "      device, and the window above closes it regardless.",
    "",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
};

const invokedDirectly = process.argv[1]
  && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`make-bootstrap-credential: ${error.message}\n`);
    process.exit(2);
  }
}
