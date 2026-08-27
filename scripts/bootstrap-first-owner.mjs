#!/usr/bin/env node
/**
 * Approve the first owner device on a fresh deployment.
 *
 * This is the replacement for `POST /bootstrap/first-owner-device`, which A-6 Gate 3.3 closed. That
 * route had to authenticate itself, because on a fresh database nobody can sign in - which made it
 * a password-guessing oracle against the Owner account, reachable by anyone who could reach the
 * server, ending in the guesser's own device being approved.
 *
 * Running it here moves that trust boundary to shell access on the server, which is a boundary the
 * deployment already has and already protects. There is nothing to guess at over the network,
 * because there is no longer anything listening.
 *
 * Usage, on the machine running the backend, with the same DATABASE_URL it uses:
 *
 *   node scripts/bootstrap-first-owner.mjs --username <owner> --device-id <id> [--device-name <name>]
 *
 * The password is read from the terminal rather than taken as an argument: an argument sits in the
 * shell history and in the process list, where any other user on the box can read it.
 *
 * It refuses if an approved owner device already exists, which is the same refusal the route made
 * and is what keeps this a first-install action rather than a way to add devices later.
 */

import { createInterface } from "node:readline";
import { stdin, stdout, argv, env, exit } from "node:process";
import { createRequire } from "node:module";

// Anchored at the backend's own package, not at this file: `pg` is a backend dependency and is not
// resolvable from scripts/. The backend's helpers are required through the same anchor so this
// command and the server agree on what a valid password and an eligible owner are, rather than
// growing a second opinion.
const require = createRequire(new URL("../backend/package.json", import.meta.url));
const { verifyPassword, PASSWORD_FORMATS } = require("./passwordHash.js");
const { isOwnerBootstrapEligible } = require("./identityPolicy.js");

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

const main = async () => {
  const username = readFlag("username").trim();
  const deviceId = readFlag("device-id").trim();
  const deviceName = readFlag("device-name").trim() || deviceId;

  if (!username || !deviceId) {
    fail("Usage: node scripts/bootstrap-first-owner.mjs --username <owner> --device-id <id> [--device-name <name>]");
  }
  if (!env.DATABASE_URL) {
    fail("DATABASE_URL is not set. Run this with the same database configuration the backend uses.");
  }

  const password = await askHidden(`Password for ${username}: `);
  if (!password) fail("No password entered.");

  // Loaded here rather than at the top so the usage message above works on a machine that has not
  // installed the backend's dependencies - which is exactly the machine somebody runs this on by
  // mistake, and the moment they most need a readable error.
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.password_hash, u.branch_id, u.active, r.role_name
         FROM users u
         JOIN roles r ON r.id = u.role_id
        WHERE LOWER(u.username) = LOWER($1)
        LIMIT 1`,
      [username],
    );
    const user = rows[0];

    // One message for every way this can fail. On a trusted machine the distinction is not a
    // security matter, but the output gets pasted into places that are less trusted than the
    // terminal it was printed in.
    const verification = user
      ? await verifyPassword(password, user.password_hash)
      : { ok: false, format: PASSWORD_FORMATS.EMPTY };
    const verified = Boolean(
      user
      && user.active !== false
      && isOwnerBootstrapEligible({ username: user.username, role_name: user.role_name, active: user.active })
      && verification.ok,
    );
    // A-5 named this failure separately, because it is the one that no amount of retyping fixes.
    // The owner's stored password is in a format the verifier no longer accepts, so this command
    // would otherwise report "credentials not accepted" forever to someone typing the right
    // password. Saying so reveals nothing about the password - nothing was compared to produce it -
    // and this runs on a machine that already holds the database.
    if (user && verification.format && verification.format !== PASSWORD_FORMATS.SCRYPT) {
      fail(
        `${user.username}'s password is stored in a format FroozERP no longer accepts, so it cannot `
        + "be verified here. Set a new one first:\n"
        + `      node scripts/reset-password.mjs --username ${user.username}`,
      );
    }
    if (!verified) fail("Those owner credentials were not accepted.");

    const existing = await pool.query(
      `SELECT device_id
         FROM device_registry
        WHERE status = 'APPROVED'
          AND LOWER(COALESCE(role_at_approval, '')) = 'owner'
        LIMIT 1`,
    ).catch(() => ({ rows: [] }));
    if (existing.rows.length > 0) {
      fail(`An approved owner device already exists (${existing.rows[0].device_id}). Use normal device approval instead.`);
    }

    const branchId = user.branch_id || 1;
    await pool.query(
      `INSERT INTO device_registry (device_id, device_name, assigned_branch_id, status, requested_at)
            VALUES ($1, $2, $3, 'PENDING', CURRENT_TIMESTAMP)
       ON CONFLICT (device_id) DO UPDATE
            SET device_name = EXCLUDED.device_name,
                assigned_branch_id = EXCLUDED.assigned_branch_id`,
      [deviceId, deviceName, branchId],
    );
    await pool.query(
      `UPDATE device_registry
          SET status = 'APPROVED',
              approved_by = $2,
              approved_at = CURRENT_TIMESTAMP,
              approval_reason = 'First owner device bootstrap (ops command)'
        WHERE device_id = $1`,
      [deviceId, user.id],
    );

    console.log(`\n  Approved ${deviceId} for ${user.username} on branch ${branchId}.`);
    console.log("  Sign in on that device now.\n");
  } finally {
    await pool.end().catch(() => {});
  }
};

main().catch((error) => fail(error?.message || String(error)));
