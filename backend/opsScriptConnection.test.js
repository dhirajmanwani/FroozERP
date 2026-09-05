"use strict";

/**
 * Every hand-run ops command accepts the same two ways of naming the database.
 *
 * These commands exist to be run by a person at a keyboard, usually mid-setup and usually when
 * something is already not working. Three of them read only `DATABASE_URL`; the migration runner
 * and the setup inspector read `DATABASE_PUBLIC_URL` first and fall back. A hosted database exposes
 * its outside-reachable string under the public name, so following one document and then the next
 * produced "DATABASE_URL is not set" with the correct value already sitting in the shell under the
 * other name.
 *
 * That happened, to the maintainer, in the middle of setting up the first counter. The fix is not
 * to document it -- documenting a trap leaves the trap -- but to make every command accept both,
 * and to fail this suite if a new one ever accepts only half.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SCRIPTS_DIR = path.join(__dirname, "..", "scripts");

/** Commands that connect to the cloud database and are run by hand. */
const OPS_COMMANDS = [
  "bootstrap-first-counter.mjs",
  "bootstrap-first-owner.mjs",
  "reset-password.mjs",
  "run-cloud-migrations.js",
  "show-setup.mjs",
  "audit-cloud-time-identity.js",
];

const read = (name) => fs.readFileSync(path.join(SCRIPTS_DIR, name), "utf8");

test("every ops command accepts DATABASE_PUBLIC_URL as well as DATABASE_URL", () => {
  for (const name of OPS_COMMANDS) {
    const source = read(name);
    assert.match(
      source,
      /DATABASE_PUBLIC_URL\s*\|\|\s*(process\.)?env\.DATABASE_URL/,
      `${name} must read DATABASE_PUBLIC_URL || DATABASE_URL — a laptop has the public one`,
    );
  }
});

test("no ops command reads DATABASE_URL on its own", () => {
  // The failure this prevents is not a crash. It is a person being told the thing they set is not
  // set, which reads as a fault in the command rather than a mismatch in its name.
  for (const name of OPS_COMMANDS) {
    const code = read(name)
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    // Blank out the guarded form first, then look for what is left. A lookbehind cannot do this:
    // `(?:process\.)?` also matches at the `env.` *inside* `process.env.DATABASE_URL`, where the
    // preceding text is "PUBLIC_URL || process." and the lookbehind no longer applies -- so the
    // correct line reported itself as a bare read.
    const bare = code
      .replace(/DATABASE_PUBLIC_URL\s*\|\|\s*(?:process\.)?env\.DATABASE_URL/g, "<guarded>")
      .match(/(?:process\.)?env\.DATABASE_URL/g) || [];
    assert.deepEqual(bare, [], `${name} reads env.DATABASE_URL without the DATABASE_PUBLIC_URL fallback`);
    assert.ok(
      /DATABASE_PUBLIC_URL\s*\|\|\s*(?:process\.)?env\.DATABASE_URL/.test(code),
      `${name} must actually resolve the connection string from both`,
    );
  }
});

test("the refusal names both variables, so it is actionable", () => {
  for (const name of OPS_COMMANDS) {
    const source = read(name);
    assert.match(
      source,
      /DATABASE_PUBLIC_URL[\s\S]{0,200}DATABASE_URL/,
      `${name} must tell the reader both names when it refuses`,
    );
  }
});

test("every ops command listed here exists", () => {
  // A rename that leaves this list stale would silently stop checking that command.
  const missing = OPS_COMMANDS.filter((name) => !fs.existsSync(path.join(SCRIPTS_DIR, name)));
  assert.deepEqual(missing, [], `listed but missing: ${missing.join(", ")}`);
});

test("no script that connects to a database is missing from the list", () => {
  // The list is the only thing being checked, so a new ops command added outside it would inherit
  // exactly the problem this file exists to stop.
  const candidates = fs
    .readdirSync(SCRIPTS_DIR)
    .filter((name) => /\.(mjs|js)$/.test(name))
    .filter((name) => /new Pool\(|new Client\(/.test(read(name)));
  const unchecked = candidates.filter((name) => !OPS_COMMANDS.includes(name));
  assert.deepEqual(
    unchecked,
    [],
    `these scripts open a database connection but are not checked: ${unchecked.join(", ")}`,
  );
});

/**
 * The rescue command must run against the database as it is, not as the release will leave it.
 *
 * `users` gains its hardening columns from the backend's startup bootstrap, not from a versioned
 * migration. So a database whose deployed backend predates auth-hardening has no
 * `failed_login_attempts`, no `session_revocation_version`, and naming them in the UPDATE made this
 * command fail outright with `column ... does not exist`.
 *
 * It failed in precisely the situation it exists for. The Owner held a retired hash and could not
 * sign in; the deploy that adds those columns is the same deploy that stops the retired hash
 * authenticating; and the tool meant to break that circle refused to run because the circle was
 * still closed. Reported by the maintainer on 2026-09-05, against the real production database,
 * with one Owner account and no other way in.
 */
test("reset-password works on a users table that predates auth hardening", () => {
  const source = read("reset-password.mjs");

  assert.match(source, /information_schema\.columns/, "it must ask which columns exist");
  assert.match(source, /table_name = 'users'/);
  assert.match(
    source,
    /UPDATE users SET password_hash = \$2\$\{applied/,
    "the SET clause must be built from the columns that are actually there",
  );

  // The one column that is not optional: without it there is nothing to write.
  assert.match(source, /if \(!present\.has\("password_hash"\)\) fail\(/);

  // Every hardening column must be in the optional list rather than hardcoded into the statement.
  for (const column of [
    "password_changed_at",
    "session_revocation_version",
    "force_password_change",
    "failed_login_attempts",
    "last_failed_login_at",
    "locked_until",
  ]) {
    assert.match(source, new RegExp(`\\["${column}",`), `${column} must be optional`);
  }
});

test("doing less than promised is said out loud", () => {
  // Skipping `session_revocation_version` means existing sessions are NOT ended. The docblock
  // promises they are. Silently doing less is how somebody believes an account is secured when it
  // is not -- worse than the original failure, because it leaves no error to notice.
  const source = read("reset-password.mjs");
  assert.match(source, /so these were not touched: \$\{skipped\.join/, "skipped columns must be named");
  assert.match(source, /Sessions already issued for this account were NOT ended/);
  assert.match(
    source,
    /present\.has\("session_revocation_version"\)\s*\?\s*"  Every session/,
    "the closing line must not claim sessions ended when the column is absent",
  );
});
