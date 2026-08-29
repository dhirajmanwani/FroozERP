#!/usr/bin/env node
/**
 * Set a new password for one FroozERP user, from the machine that holds the database.
 *
 * This is the backstop for auth-hardening A-5. A-5 stopped the retired password formats — the
 * pre-A-1 unsalted SHA-256 digest and the pre-A-2 plaintext column — from authenticating anybody.
 * An account still holding one of those cannot sign in, and the two ordinary ways back in both have
 * a precondition that can fail:
 *
 * - Self-service recovery (`/auth/recovery/*`) needs a verified recovery email or mobile on the
 *   account, and staff additionally need `staff_self_recovery_enabled`.
 * - An Owner or Admin reset (`/users/:id/recovery-action`, `/users/:id/password`) needs an Owner or
 *   Admin who can sign in.
 *
 * Neither covers the one case that would be unrecoverable: the Owner is the account with the
 * retired hash, and has no verified recovery contact. Without this command that shop is locked out
 * of its own till with nobody able to help. With it, the trust boundary is shell access on the
 * machine holding DATABASE_URL — a boundary the deployment already has and already protects.
 *
 * Usage, on the machine running the backend, with the same DATABASE_URL it uses:
 *
 *   node scripts/reset-password.mjs --username <name>
 *
 * The password is read from the terminal rather than taken as an argument: an argument sits in the
 * shell history and in the process list, where any other user on the box can read it. It is asked
 * for twice, because a typo here is not recoverable by the person it locks out.
 *
 * The reset does three things beyond writing the hash, all of them deliberate:
 *
 * - **`session_revocation_version` is incremented**, so every session already issued for this
 *   account stops working. A password reset that left an attacker's existing session alive would
 *   be a reset in name only.
 * - **The lockout counters are cleared**, so someone who was locked out while trying their old
 *   password can use the new one immediately rather than waiting out a lock they can no longer
 *   resolve by remembering.
 * - **An audit row is written** with action `OPS_PASSWORD_RESET`, so a reset performed off the
 *   network is as visible in the trail as one performed through the app.
 *
 * It never prints the password, and never reveals the old one — there is nothing here that reads
 * the existing hash except to report which retired format it was in.
 */

import { createInterface } from "node:readline";
import { stdin, stdout, argv, env, exit } from "node:process";
import { createRequire } from "node:module";

// Anchored at the backend's own package, not at this file: `pg` is a backend dependency and is not
// resolvable from scripts/. `hashPassword` is required through the same anchor so this command and
// the server write the identical format at the identical cost, rather than growing a second
// opinion about what a stored password looks like.
const require = createRequire(new URL("../backend/package.json", import.meta.url));
const { hashPassword, PASSWORD_FORMATS, verifyPassword } = require("./passwordHash.js");

/** Matches `/users/:id/password`. Kept in step with it deliberately — see the comment at the call. */
const MIN_PASSWORD_LENGTH = 4;

const readFlag = (name) => {
  const index = argv.indexOf(`--${name}`);
  const value = index >= 0 ? argv[index + 1] : "";
  return value && !value.startsWith("--") ? value : "";
};

const fail = (message) => {
  console.error(`\n  ${message}\n`);
  exit(1);
};

/** Read a secret with the echo suppressed, so it is not left on screen or in a scrollback. */
const askHidden = (prompt) => new Promise((resolve) => {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  let armed = false;
  rl._writeToOutput = (chunk) => {
    // Let the prompt itself through once, then swallow every echoed keystroke.
    if (!armed) {
      rl.output.write(chunk);
      armed = true;
    }
  };
  rl.question(prompt, (answer) => {
    rl.close();
    stdout.write("\n");
    resolve(answer);
  });
});

/**
 * Say which retired format the account was in, for the operator's benefit. This runs on a trusted
 * machine and describes the *stored value*, never the password: it cannot confirm a guess, because
 * nothing is compared against the supplied password to produce it.
 */
const describeStoredFormat = async (storedHash) => {
  const { format } = await verifyPassword("", storedHash);
  switch (format) {
    case PASSWORD_FORMATS.SCRYPT:
      return "current format (scrypt)";
    case PASSWORD_FORMATS.LEGACY_SHA256:
      return "retired format: pre-A-1 unsalted SHA-256 — this account could not sign in";
    case PASSWORD_FORMATS.UNRECOGNIZED:
      return "retired format: pre-A-2 plaintext column — this account could not sign in";
    case PASSWORD_FORMATS.EMPTY:
      return "no password stored — this account could not sign in";
    default:
      return "unreadable stored value — this account could not sign in";
  }
};

const main = async () => {
  const username = readFlag("username").trim();

  if (!username) {
    fail("Usage: node scripts/reset-password.mjs --username <name>");
  }
  if (!env.DATABASE_URL) {
    fail("DATABASE_URL is not set. Run this with the same database configuration the backend uses.");
  }

  // Loaded here rather than at the top so the usage message above works on a machine that has not
  // installed the backend's dependencies - which is exactly the machine somebody runs this on by
  // mistake, and the moment they most need a readable error.
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.full_name, u.password_hash, u.active, r.role_name
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
        WHERE LOWER(u.username) = LOWER($1)
        LIMIT 1`,
      [username],
    );
    const user = rows[0];
    if (!user) fail(`No user named ${username}.`);

    // Reported, not refused. A disabled account still needs its password set correctly before it is
    // re-enabled, and refusing here would only push the operator toward editing the row by hand.
    const status = user.active === false ? " (currently disabled)" : "";
    console.log(`\n  ${user.username} — ${user.full_name || "no name"}, ${user.role_name || "no role"}${status}`);
    console.log(`  Stored password: ${await describeStoredFormat(user.password_hash)}\n`);

    // The same floor as `/users/:id/password`. Four characters is low, and raising it is a real
    // improvement — but it has to be raised in both places at once, or this command starts refusing
    // passwords the app accepts and the operator learns to distrust the tool.
    const password = await askHidden(`New password for ${user.username}: `);
    if (password.length < MIN_PASSWORD_LENGTH) {
      fail(`A password needs at least ${MIN_PASSWORD_LENGTH} characters. Nothing was changed.`);
    }
    const confirmation = await askHidden("Type it again: ");
    if (password !== confirmation) fail("Those did not match. Nothing was changed.");

    const hashed = await hashPassword(password);
    await pool.query(
      `UPDATE users
          SET password_hash = $2,
              password_changed_at = CURRENT_TIMESTAMP,
              session_revocation_version = COALESCE(session_revocation_version, 0) + 1,
              force_password_change = FALSE,
              failed_login_attempts = 0,
              last_failed_login_at = NULL,
              locked_until = NULL,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [user.id, hashed],
    );

    // Best-effort: the reset has already happened, and failing to record it must not leave the
    // operator believing it did not. Reported rather than swallowed, so a missing trail is known.
    await pool.query(
      `INSERT INTO auth_audit_log (user_id, username, action, safe_code, details)
            VALUES ($1, $2, 'OPS_PASSWORD_RESET', 'PASSWORD_UPDATED', $3::jsonb)`,
      [user.id, user.username, JSON.stringify({ stage: "ops_command", command: "scripts/reset-password.mjs" })],
    ).catch((error) => {
      console.warn(`  Warning: the reset succeeded but could not be written to the audit log (${error.message}).`);
    });

    console.log(`\n  Password set for ${user.username}.`);
    console.log("  Every session that account already had has been ended; it must sign in again.\n");
  } finally {
    await pool.end().catch(() => {});
  }
};

main().catch((error) => fail(error?.message || String(error)));
