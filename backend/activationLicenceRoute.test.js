"use strict";

/**
 * The Owner-only activation routes, and the two places the `activation_licences` table is declared.
 *
 * ## Why so much of this reads source text
 *
 * There is no database in this environment and the signing key is not in this repository, so the
 * happy path -- Owner asks, file comes back -- cannot be run here. `activationLicence.test.js`
 * proves the bytes and `src-tauri/tests/activation_node_encoder.rs` proves the app accepts them.
 * What is left for this file is the wiring, and the wiring is exactly where this feature can fail
 * silently: an Admin let through, a device found across a company boundary, a signing key logged,
 * a table declared two ways.
 *
 * Reading source is a weak proof of behaviour and a strong proof of absence. Each assertion below
 * is written so that the thing it would catch is a real mistake somebody could make in one edit.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { normaliseLicenceRequest, MIN_VALID_DAYS, MAX_VALID_DAYS } = require("./activationLicenceRequest");

const SERVER = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const MIGRATION_PATH = path.join(__dirname, "migrations", "cloud", "017_activation_licences.sql");
const MIGRATION = fs.readFileSync(MIGRATION_PATH, "utf8");

/** The `POST /api/activation/licences` handler, from its registration to the next one. */
const issueRoute = () => {
  const start = SERVER.indexOf('app.post("/api/activation/licences"');
  assert.notEqual(start, -1, "the issue route is not registered");
  const end = SERVER.indexOf('app.get("/api/activation/licences"', start);
  assert.notEqual(end, -1, "the list route is not registered");
  return SERVER.slice(start, end);
};

// ---------------------------------------------------------------------------------------------
// What the Owner asked for, checked before anything is signed
// ---------------------------------------------------------------------------------------------

test("a request with no device names which box to fix", () => {
  for (const body of [{}, { device_id: "" }, { device_id: "   " }, { device_id: null }]) {
    const answer = normaliseLicenceRequest({ ...body, valid_days: 365 });
    assert.equal(answer.ok, false);
    assert.equal(answer.code, "INVALID_DEVICE_ID");
    assert.equal(answer.status, 400);
  }
});

test("a time frame that is not a whole number of days is refused, not coerced", () => {
  // Number("") and Number(null) are both 0, and 0 would encode as valid_days = 0, which the
  // decoder rejects as MalformedField -- on the counter, days later. CLAUDE.md records the same
  // family of bug from the day it emptied the Inventory screen.
  for (const validDays of ["", null, undefined, "  ", "30 days", "thirty", 30.5, [], {}, NaN, true]) {
    const answer = normaliseLicenceRequest({ device_id: "FZDEV-A", valid_days: validDays });
    assert.equal(answer.ok, false, `valid_days ${JSON.stringify(validDays)} was accepted`);
    assert.equal(answer.code, "INVALID_VALID_DAYS");
  }
});

test("zero days and a licence longer than the business are both out of range", () => {
  for (const validDays of [0, -1, MAX_VALID_DAYS + 1, 65535]) {
    const answer = normaliseLicenceRequest({ device_id: "FZDEV-A", valid_days: validDays });
    assert.equal(answer.ok, false, `valid_days ${validDays} was accepted`);
    assert.equal(answer.code, "INVALID_VALID_DAYS");
  }
});

test("the four time frames the screen offers are all accepted, typed or clicked", () => {
  for (const validDays of [30, 90, 365, MIN_VALID_DAYS, MAX_VALID_DAYS]) {
    for (const asSent of [validDays, String(validDays), ` ${validDays} `]) {
      const answer = normaliseLicenceRequest({ device_id: " FZDEV-A ", valid_days: asSent });
      assert.equal(answer.ok, true, `valid_days ${JSON.stringify(asSent)} was refused`);
      assert.equal(answer.validDays, validDays);
      assert.equal(answer.deviceId, "FZDEV-A", "the device id must be trimmed before it is matched");
    }
  }
});

test("a refusal carries its own HTTP status, so a route cannot pair a code with the wrong one", () => {
  const answer = normaliseLicenceRequest({ device_id: "", valid_days: 0 });
  assert.equal(answer.status, 400);
  assert.equal(typeof answer.message, "string");
  assert.ok(answer.message.length > 0, "a refusal must say what to do about it");
});

// ---------------------------------------------------------------------------------------------
// Who may issue
// ---------------------------------------------------------------------------------------------

test("issuing is Owner only, and not through the Owner-or-Admin helper", () => {
  const route = issueRoute();
  assert.match(route, /requireOwnerOnly\(req\.auth\.userId\)/);
  assert.doesNotMatch(
    route,
    /requireRateManager/,
    "requireRateManager is Owner OR Admin; an Admin who can mint entitlements can authorise any machine",
  );
  assert.match(route, /code: "NOT_OWNER"/);
});

test("requireOwnerOnly admits exactly one role", () => {
  const start = SERVER.indexOf("const requireOwnerOnly = async");
  assert.notEqual(start, -1, "requireOwnerOnly is gone");
  const body = SERVER.slice(start, SERVER.indexOf("\n};", start));
  assert.match(body, /user\.role_name === "Owner"/);
  assert.match(body, /u\.active = TRUE/, "a deactivated Owner is not an Owner");
});

test("identity comes from the verified session and never from the request", () => {
  const route = issueRoute();
  assert.doesNotMatch(route, /req\.body\.user_id|req\.body\.company_id|x-user-id/i);
  assert.match(route, /req\.auth\.companyId/);
});

// ---------------------------------------------------------------------------------------------
// The signing key
// ---------------------------------------------------------------------------------------------

test("the signing key is read from the environment and is never sent back or logged", () => {
  const route = issueRoute();
  assert.match(route, /process\.env\[ACTIVATION_SIGNING_KEY_ENV\]/);
  assert.match(route, /code: "SIGNING_KEY_UNAVAILABLE"/, "a server with no key must say so, not fail obscurely");
  // The returned object is the one thing a caller sees. It carries the file and the record, and
  // must never carry the seed under any name.
  const returned = route.slice(route.indexOf("return res.json({"));
  assert.doesNotMatch(returned, /signingKey|signing_key|seed/i);
  assert.doesNotMatch(route, /console\.[a-z]+\([^)]*signingKey/i);
});

test("the key is never written into the record, only its public half", () => {
  const route = issueRoute();
  const insert = route.slice(route.indexOf("INSERT INTO activation_licences"));
  assert.match(insert, /publicKeyHex/);
  assert.doesNotMatch(insert, /signingKeyHex/);
});

test("an unreadable trusted-key table refuses rather than signing unchecked", () => {
  const route = issueRoute();
  assert.match(route, /code: "TRUSTED_KEYS_UNAVAILABLE"/);
  assert.match(route, /trustedKeysSource/, "the check must be given the source, not skipped");
  assert.ok(
    fs.existsSync(path.join(__dirname, "..", "src-tauri", "src", "entitlement.rs")),
    "the decoder source the check reads must exist in the repository",
  );
});

// ---------------------------------------------------------------------------------------------
// Tenancy, and the device
// ---------------------------------------------------------------------------------------------

test("a device is looked up inside the session's company", () => {
  const route = issueRoute();
  const lookup = route.slice(route.indexOf("FROM authorized_devices"));
  assert.match(lookup, /\$2::INTEGER IS NULL OR company_id IS NULL OR company_id = \$2/);
  assert.match(route, /code: "NO_SUCH_DEVICE"/);
});

test("every read of the record is scoped to the session's company", () => {
  const section = SERVER.slice(SERVER.indexOf('app.post("/api/activation/licences"'));
  const routes = section.slice(0, section.indexOf('app.post("/settings/branches"'));
  const reads = [...routes.matchAll(/FROM activation_licences/g)];
  assert.ok(reads.length >= 2, "expected the list and the download to read the table");
  for (const read of reads) {
    // The predicate has to be inside this statement, not merely somewhere in the file: an
    // unscoped read would otherwise pass because a neighbouring route is scoped.
    const statement = routes.slice(read.index, routes.indexOf("`", read.index));
    assert.match(
      statement,
      /company_id IS NULL OR (?:l\.)?company_id = \$/,
      `a read of activation_licences is not company-scoped:\n${statement}`,
    );
  }
});

// ---------------------------------------------------------------------------------------------
// The serial
// ---------------------------------------------------------------------------------------------

test("the serial comes from one global sequence, not from a per-device count", () => {
  const route = issueRoute();
  assert.match(route, /nextval\('activation_licence_serial_seq'\)/);
  assert.doesNotMatch(
    route,
    /MAX\(entitlement_serial\)|COUNT\(\*\)[^)]*activation_licences/i,
    "the device's ledger keys on the serial alone, so two devices must never share one",
  );
  assert.match(route, /Number\.isSafeInteger\(serial\)/);
});

// ---------------------------------------------------------------------------------------------
// One table, declared twice, which must stay one table
// ---------------------------------------------------------------------------------------------

/** The column lines of a `CREATE TABLE IF NOT EXISTS activation_licences (...)` block. */
const columnsOf = (sql, where) => {
  const start = sql.indexOf("CREATE TABLE IF NOT EXISTS activation_licences (");
  assert.notEqual(start, -1, `activation_licences is not declared in ${where}`);
  // The migration ends the block at column 0; the startup declaration is indented inside a
  // template literal. Match the closing line either way.
  const closing = /^[ \t]*\);[ \t]*$/m;
  closing.lastIndex = 0;
  const tail = sql.slice(start);
  const match = tail.match(closing);
  assert.notEqual(match, null, `the declaration in ${where} does not end`);
  const end = start + match.index;
  return sql
    .slice(sql.indexOf("(", start) + 1, end)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("--"))
    .map((line) => line.replace(/,$/, "").replace(/\s+/g, " "));
};

test("the startup declaration and the cloud migration describe the same table", () => {
  // The reason this test exists is written into migration 014: on a hosted deployment
  // `initializeDatabase()` never runs, so the migration is the only thing that creates this table,
  // while `verifyDeclaredSchema` compares the *declaration* against what is live. If the two drift,
  // the server refuses to start -- at the shop, after a deploy, with the app already updated.
  assert.deepEqual(columnsOf(SERVER, "server.js"), columnsOf(MIGRATION, "migration 017"));
});

test("the record has no status column to disagree with the signed dates", () => {
  const columns = columnsOf(MIGRATION, "migration 017").map((line) => line.split(" ")[0]);
  assert.equal(columns.includes("status"), false);
  assert.equal(columns.includes("revoked_at"), false);
  for (const required of ["entitlement_serial", "device_id", "device_name", "expires_on", "grace_until", "lic_text"]) {
    assert.ok(columns.includes(required), `${required} is the record; it may not be dropped`);
  }
});

test("the record does not depend on the device row outliving it", () => {
  // scripts/retire-devices.mjs deletes device rows. A foreign key here would either block that or
  // take the history with it, and the history is the point.
  const columns = columnsOf(MIGRATION, "migration 017");
  const deviceColumn = columns.find((line) => line.startsWith("device_id "));
  assert.doesNotMatch(deviceColumn, /REFERENCES/);
});

test("the serial sequence cannot hand out a number the wire format cannot carry", () => {
  // entitlement_serial is a u32 in entitlement.rs. A sequence allowed past that would wrap or
  // overflow into a collision with a live serial.
  assert.match(MIGRATION, /CREATE SEQUENCE IF NOT EXISTS activation_licence_serial_seq/);
  assert.match(MIGRATION, /MAXVALUE 4294967295/);
  assert.match(MIGRATION, /NO CYCLE/);
  assert.match(SERVER, /MAXVALUE 4294967295/, "the startup declaration must carry the same ceiling");
});

test("migration 017 is registered with the runner that applies it", () => {
  const runner = fs.readFileSync(path.join(__dirname, "..", "scripts", "run-cloud-migrations.js"), "utf8");
  assert.match(runner, /backend\/migrations\/cloud\/017_activation_licences\.sql/);
});

// ---------------------------------------------------------------------------------------------
// D-2: which key the server is allowed to hold
// ---------------------------------------------------------------------------------------------

test("the server signs with the rotation slot, so the root key can stay off the cloud", () => {
  // The design's D-2 says the private key never enters Railway. Issuing from inside the app needs
  // a key the server can reach, so this splits the difference the way rotation was designed for:
  // slot 2 goes online, slot 1 stays on the maintainer's machine, and a compromise of the hosted
  // environment is answered by an app update that drops key id 2.
  assert.match(SERVER, /const ACTIVATION_KEY_ID_DEFAULT = 2;/);
  const route = issueRoute();
  assert.match(route, /process\.env\[ACTIVATION_KEY_ID_ENV\]\) \|\|\s*ACTIVATION_KEY_ID_DEFAULT/);
  assert.doesNotMatch(route, /keyId: 1\b/, "the root slot must not be the default the cloud signs with");
});

test("the trusted-key table still carries the slot the server signs with", () => {
  const entitlement = fs.readFileSync(path.join(__dirname, "..", "src-tauri", "src", "entitlement.rs"), "utf8");
  const table = entitlement.slice(entitlement.indexOf("TRUSTED_ACTIVATION_KEYS"));
  assert.match(
    table.slice(0, table.indexOf("];")),
    /\(0x02,/,
    "a device will refuse anything this server signs if key id 2 is not in the shipped table",
  );
});

test("calendar days leave the server as calendar days", () => {
  // The three date columns are days out of a signed payload. Sent as DATE, the driver hands back a
  // JavaScript Date at the server's midnight, JSON renders that as a timestamp, and the screen has
  // to guess a day back out of it -- in a different time zone, sometimes the wrong one. The screen
  // cross-checks issued_on + valid_days against expires_on, so a one-day slip there does not show
  // as an off-by-one: it shows as "Cannot be read" on a licence that is perfectly fine.
  const section = SERVER.slice(SERVER.indexOf('app.get("/api/activation/licences"'));
  const reads = section.slice(0, section.indexOf('app.post("/settings/branches"'));
  for (const column of ["issued_on", "expires_on", "grace_until"]) {
    assert.equal(
      (reads.match(new RegExp(`to_char\\((?:l\\.)?${column}, 'YYYY-MM-DD'\\) AS ${column}`, "g")) || []).length,
      2,
      `${column} must be read as text by both the list and the download`,
    );
  }
});
