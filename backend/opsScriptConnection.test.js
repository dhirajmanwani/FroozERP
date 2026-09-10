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
  "approve-device.mjs",
  "cloud/check-schema-drift.mjs",
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

/**
 * `scripts/multibranch/` is the other half of the same mistake, pointing the other way.
 *
 * Those are not hand-run ops commands; they are rehearsal harnesses. Several of them start a real
 * backend on `TEST_BACKEND_PORT` and drive writes through it against whatever database they are
 * handed. So for them the name is not a convenience, it is the isolation: `STAGING_DATABASE_URL` is
 * a name nobody sets to the shop's cloud by accident, while `DATABASE_URL` is the name production
 * uses and is routinely already sitting in a shell during ops work -- the same shell someone would
 * run a rehearsal from.
 *
 * `isolated-mixed-version-rollout.js` and `isolated-scope-management-integration.js` both read
 * `DATABASE_URL` while their five siblings read `STAGING_DATABASE_URL`. Nothing invoked them that
 * way, and nothing caught it either: the checks above enumerate `scripts/` without descending, so
 * this whole directory was never looked at. Both now read `STAGING_DATABASE_URL` and refuse without
 * it, and the rules below are directory-driven, so a harness added tomorrow is checked on arrival
 * rather than when somebody remembers to add it to a list.
 *
 * Note the inversion: up there, naming only `DATABASE_URL` is a usability bug. Down here it is a
 * safety one, and the fix is the opposite -- these must not accept that name at all.
 */

const MULTIBRANCH_DIR = path.join(SCRIPTS_DIR, "multibranch");

/**
 * The one harness allowed to name the production variable, because reaching production is its
 * purpose: it exports a snapshot for the rehearsals to run against. It is safe only for as long as
 * it stays read-only, so that is asserted below rather than assumed -- give it a write path or a
 * backend and it stops qualifying for this exemption.
 */
const READ_ONLY_PRODUCTION_SCRIPTS = ["export-production-snapshot-readonly.js"];

/** Source with comment lines removed, so prose about `DATABASE_URL` is not mistaken for a read. */
const readCode = (name) =>
  read(name)
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
    })
    .join("\n");

const multibranchScripts = () =>
  fs
    .readdirSync(MULTIBRANCH_DIR)
    .filter((name) => /\.(mjs|js)$/.test(name))
    .sort();

/** Harnesses subject to the staging-only rule: everything but the read-only production export. */
const rehearsalHarnesses = () =>
  multibranchScripts().filter((name) => !READ_ONLY_PRODUCTION_SCRIPTS.includes(name));

test("no rehearsal harness reads DATABASE_URL", () => {
  // Reading it is what this forbids. Passing it *down* -- `DATABASE_URL: stagingDatabaseUrl` in a
  // spawned backend's env -- is fine and stays matchable only as a write, never as `env.DATABASE_URL`.
  const offenders = rehearsalHarnesses().filter((name) =>
    /(?:process\.)?env\.DATABASE_URL/.test(readCode(path.join("multibranch", name))),
  );
  assert.deepEqual(
    offenders,
    [],
    "these harnesses take the name production uses, so a shell already pointed at the shop would "
    + `run them against live data: ${offenders.join(", ")}`,
  );
});

test("every rehearsal harness that opens a connection takes STAGING_DATABASE_URL", () => {
  const connecting = rehearsalHarnesses().filter((name) =>
    /new Pool\(|new Client\(/.test(readCode(path.join("multibranch", name))),
  );
  assert.ok(connecting.length >= 5, "the harnesses stopped being detected as database clients");

  for (const name of connecting) {
    assert.match(
      readCode(path.join("multibranch", name)),
      /process\.env\.STAGING_DATABASE_URL/,
      `${name} must name the staging variable, which nobody sets to the shop by accident`,
    );
  }
});

test("a rehearsal harness refuses before it connects", () => {
  // An empty variable must not reach `new Pool`. Every one of these guards its connection string
  // first; ordering is the part source text can prove, and moving a pool above its guard breaks it.
  for (const name of rehearsalHarnesses()) {
    const code = readCode(path.join("multibranch", name));
    const connection = code.search(/new Pool\(|new Client\(/);
    if (connection < 0) continue;
    const refusal = code.indexOf("throw new Error(");
    assert.ok(refusal >= 0, `${name} opens a connection and refuses nothing`);
    assert.ok(
      refusal < connection,
      `${name} builds its connection before it refuses a bad one, so an unintended database is `
      + "already open by the time the guard runs",
    );
  }
});

test("the read-only exemption is still read-only", () => {
  for (const name of READ_ONLY_PRODUCTION_SCRIPTS) {
    const relative = path.join("multibranch", name);
    assert.ok(fs.existsSync(path.join(SCRIPTS_DIR, relative)), `${name} is exempted but does not exist`);
    const code = readCode(relative);
    assert.match(
      code,
      /BEGIN READ ONLY/,
      `${name} is allowed production's variable only because the database refuses to let it write`,
    );
    assert.doesNotMatch(
      code,
      /spawn\(/,
      `${name} starts a backend, so it is a harness now and cannot keep the read-only exemption`,
    );
  }
});
