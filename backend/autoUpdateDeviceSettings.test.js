"use strict";

/**
 * Where a counter machine stores its own answer to "when may I restart myself?".
 *
 * The decision logic lives in `frontend/src/local/autoUpdate.js` and is tested there. This suite
 * is about the four columns behind it -- `auto_update_enabled`, `auto_update_days`,
 * `auto_update_start_minute`, `auto_update_end_minute` on `device_control_settings` -- and about
 * the three places they have to travel: the public `GET /settings/device-control` that the login
 * screen reads, the `deviceControlSettings` slice of the settings bundle, and the `PUT` that
 * writes them.
 *
 * ## Why the validation is worth a suite of its own
 *
 * Every other setting in this table is a preference. These four decide when a machine in a shop
 * reboots itself, unattended, with no person present and no easy undo -- the updater installs in
 * `quiet` mode against `latest`. Two failure shapes are therefore tested from several directions,
 * because both are silent:
 *
 *   - **An empty day list.** A device with no days can never install. It throws no error, logs
 *     nothing and looks exactly like the feature being broken, for months. It must not be storable.
 *   - **A minute coerced to 0.** Midnight is a perfectly good setting somebody might choose, so a
 *     bad value quietly becoming 0 is indistinguishable from a deliberate midnight restart. Bad
 *     values are refused instead.
 *
 * And one shape rule: the narrow public route and the settings bundle must return the same object.
 * They are read by the same screen, and a field that exists in one and not the other reads to the
 * frontend as "this device has no schedule", which is the empty-list failure by another route.
 *
 * The routes are driven through `routeAuthCoverage.loadServerApp()`, the same sandbox the other
 * route suites use: a real Express app, a stubbed database, no network, no `app.listen`. The
 * schema assertions are made against the source text, because `initializeDatabase()` needs a real
 * PostgreSQL to run and there is not one here -- see `freshDatabaseBootstrap.test.js` for the same
 * compromise and why.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  loadServerApp,
  probe,
  setQueryResponder,
  clearQueryResponder,
} = require("./routeAuthCoverage");
const { issueDeviceSession } = require("./deviceSession");
const { bootstrapSql, declaredColumns } = require("./schemaContract");

const app = loadServerApp();
const SOURCE = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

/** Must match the throwaway key `routeAuthCoverage` pins into the environment before loading. */
const TEST_SIGNING_KEY = "route-auth-coverage-isolated-signing-key-000000";

const AUTO_UPDATE_COLUMNS = [
  "auto_update_enabled",
  "auto_update_days",
  "auto_update_start_minute",
  "auto_update_end_minute",
];

// -------------------------------------------------------------------------------------------
// The schema: the columns exist, they carry the documented defaults, and a restart is harmless
// -------------------------------------------------------------------------------------------

/** The body of `CREATE TABLE IF NOT EXISTS device_control_settings ( ... )`. */
const createTableBody = () => {
  const start = SOURCE.indexOf("CREATE TABLE IF NOT EXISTS device_control_settings (");
  assert.ok(start > 0, "the device_control_settings table has been renamed or removed");
  const end = SOURCE.indexOf("\n    );", start);
  assert.ok(end > start, "the device_control_settings CREATE TABLE has no visible end");
  return SOURCE.slice(start, end);
};

/** What the table says a column defaults to, as written. */
const declaredDefault = (column) => {
  // To the end of the line, then the trailing comma off: the day list's own default contains
  // commas, so stopping at the first one reports `'0` and the assertion below fails saying the
  // default is wrong when it is the reading of it that is.
  const match = new RegExp(`\\n\\s*${column}\\s+[A-Z]+\\s+DEFAULT\\s+([^\\n]+)`).exec(createTableBody());
  return match ? match[1].trim().replace(/,$/, "") : null;
};

test("the table declares all four auto-update columns", () => {
  const body = createTableBody();
  for (const column of AUTO_UPDATE_COLUMNS) {
    assert.match(body, new RegExp(`\\n\\s*${column}\\s`), `${column} is missing from the table`);
  }
});

test("the declared defaults are the ones autoUpdate.js assumes: on, every day, 22:00 to 06:00", () => {
  assert.equal(declaredDefault("auto_update_enabled"), "TRUE");
  assert.equal(declaredDefault("auto_update_days"), "'0,1,2,3,4,5,6'");
  // Written as minute counts, not as hours, because the columns are INTEGER. 22:00 and 06:00.
  assert.equal(declaredDefault("auto_update_start_minute"), String(22 * 60));
  assert.equal(declaredDefault("auto_update_end_minute"), String(6 * 60));
});

test("an install that already has the table gets the columns too", () => {
  // CREATE TABLE IF NOT EXISTS does nothing on an existing database, so without these every device
  // in the field would be missing all four and every read of them would raise on the first route
  // that touched it -- which is exactly how `u.failed_login_attempts` was found. See schemaContract.js.
  for (const column of AUTO_UPDATE_COLUMNS) {
    assert.match(
      SOURCE,
      new RegExp(`ALTER TABLE device_control_settings ADD COLUMN IF NOT EXISTS ${column}\\s`),
      `${column} has no ALTER TABLE ... ADD COLUMN IF NOT EXISTS`,
    );
  }
});

test("the new columns survive a second startup", () => {
  // Startup runs the whole bootstrap on every boot. `IF NOT EXISTS` on every one of these is what
  // makes the second boot a no-op instead of a failure; a bare ADD COLUMN would raise and take the
  // rest of the bootstrap down with it.
  const alters = [...SOURCE.matchAll(/ALTER TABLE device_control_settings ADD COLUMN([^;]*);/g)]
    .map(([, rest]) => rest.trim());
  assert.equal(alters.length, AUTO_UPDATE_COLUMNS.length, `expected ${AUTO_UPDATE_COLUMNS.length} ALTERs, saw ${alters.length}`);
  for (const rest of alters) {
    assert.ok(rest.startsWith("IF NOT EXISTS "), `not idempotent: ALTER TABLE device_control_settings ADD COLUMN ${rest}`);
  }
});

test("the schema contract sees the four columns, so a database missing them is reported", () => {
  // findSchemaDrift/describeSchemaDrift read the declarations straight out of initializeDatabase().
  // They enumerate nothing themselves, so declaring the ALTERs above is what registers these four.
  const declared = declaredColumns(bootstrapSql(SOURCE))
    .filter(([table]) => table === "device_control_settings")
    .map(([, column]) => column)
    .sort();
  assert.deepEqual(declared, [...AUTO_UPDATE_COLUMNS].sort());
});

// -------------------------------------------------------------------------------------------
// Reading: the public route, the settings bundle, and what an old row reads back as
// -------------------------------------------------------------------------------------------

// Both the reads and the UPDATE's RETURNING, so the PUT gets a row back to present.
const DEVICE_CONTROL_SQL = /device_control_settings/i;
const MANAGER_SQL = /FROM users u\s+JOIN roles r/i;

const MANAGER_ROW = { id: 7, full_name: "Owner", role_name: "Owner" };

const ownerToken = () => issueDeviceSession({
  userId: MANAGER_ROW.id,
  deviceId: "FZDEV-AUTO-UPDATE-SETTINGS",
  companyId: 1,
  branchId: 1,
  role: "Owner",
  secret: TEST_SIGNING_KEY,
});

/**
 * Run one request with `device_control_settings` answering from `row`, and report the statements.
 *
 * Everything else answers empty, which is enough for the settings bundle: with no manager row the
 * bundle simply omits the staff and device half, and none of that is what is being asked here.
 */
const call = async (method, url, { row = {}, body = undefined, authenticated = false, manager = true } = {}) => {
  const statements = [];
  setQueryResponder((sql, values) => {
    statements.push({ sql: sql.replace(/\s+/g, " ").trim(), values: values || [] });
    if (MANAGER_SQL.test(sql)) return { rows: manager ? [MANAGER_ROW] : [], rowCount: manager ? 1 : 0 };
    if (DEVICE_CONTROL_SQL.test(sql)) return { rows: [row], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  try {
    const headers = authenticated ? { authorization: `Bearer ${ownerToken()}` } : {};
    const response = await probe(app, method, url, headers, body);
    return { response, statements };
  } finally {
    clearQueryResponder();
  }
};

/** The UPDATE the PUT issued, or undefined if it never got that far. */
const updateStatement = (statements) => statements.find(({ sql }) => /^UPDATE device_control_settings/i.test(sql));

/**
 * What the UPDATE actually did to one auto-update column.
 *
 * Read out of the statement rather than by counting parameters: three of the bound values are
 * booleans belonging to the older fields, so "how many true booleans are there" answers a
 * different question than it looks like it does. This finds `<column> = CASE WHEN $n ... THEN $m`
 * and reports that column's own pair -- `mentioned` is whether the body named it, `value` is what
 * would be written if it did.
 */
const wroteColumn = (update, column) => {
  const match = new RegExp(`${column} = CASE WHEN \\$(\\d+)(?:::BOOLEAN)? THEN \\$(\\d+)`).exec(update.sql);
  assert.ok(match, `${column} is not written with the preserve-when-absent shape`);
  return { mentioned: update.values[Number(match[1]) - 1], value: update.values[Number(match[2]) - 1] };
};

test("a row written before these columns existed reads back as the documented defaults", async () => {
  // The install-base case. `auto_update_enabled` reading as false here would report every existing
  // device as opted out of a feature nobody has been asked about yet.
  const { response } = await call("GET", "/settings/device-control", { row: { updated_at: "" } });
  assert.equal(response.status, 200);
  const settings = response.body.deviceControlSettings;
  assert.equal(settings.auto_update_enabled, true);
  assert.equal(settings.auto_update_days, "0,1,2,3,4,5,6");
  assert.equal(settings.auto_update_start_minute, 22 * 60);
  assert.equal(settings.auto_update_end_minute, 6 * 60);
});

test("the defaults served are the defaults the table declares", async () => {
  const { response } = await call("GET", "/settings/device-control", { row: {} });
  const settings = response.body.deviceControlSettings;
  assert.equal(String(settings.auto_update_enabled).toUpperCase(), declaredDefault("auto_update_enabled"));
  assert.equal(`'${settings.auto_update_days}'`, declaredDefault("auto_update_days"));
  assert.equal(String(settings.auto_update_start_minute), declaredDefault("auto_update_start_minute"));
  assert.equal(String(settings.auto_update_end_minute), declaredDefault("auto_update_end_minute"));
});

test("a stored schedule is served as stored, including a device switched off", async () => {
  const { response } = await call("GET", "/settings/device-control", {
    row: { auto_update_enabled: false, auto_update_days: "0,6", auto_update_start_minute: 0, auto_update_end_minute: 90 },
  });
  const settings = response.body.deviceControlSettings;
  assert.equal(settings.auto_update_enabled, false);
  assert.equal(settings.auto_update_days, "0,6");
  // 0 is midnight and must survive the round trip as 0, not be mistaken for "unset".
  assert.equal(settings.auto_update_start_minute, 0);
  assert.equal(settings.auto_update_end_minute, 90);
});

test("the public route and the settings bundle return the same object, field for field", async () => {
  const row = {
    fullscreen_lock_enabled: true,
    require_exit_code_to_close: false,
    exit_code_hash: "a".repeat(64),
    auto_update_enabled: false,
    auto_update_days: "2,4",
    auto_update_start_minute: 75,
    auto_update_end_minute: 480,
    updated_at: "2026-09-19T00:00:00.000Z",
  };
  const narrow = await call("GET", "/settings/device-control", { row });
  const bundle = await call("GET", "/settings", { row, authenticated: true });
  assert.equal(narrow.response.status, 200);
  assert.equal(bundle.response.status, 200);

  const fromNarrow = narrow.response.body.deviceControlSettings;
  const fromBundle = bundle.response.body.deviceControlSettings;
  // Keys compared as an ordered list as well as by value: a field present in one shape and absent
  // from the other is the failure this is guarding, and deepEqual on the objects alone would catch
  // that but not tell you which way round it went.
  assert.deepEqual(Object.keys(fromBundle), Object.keys(fromNarrow));
  assert.deepEqual(fromBundle, fromNarrow);
  for (const field of AUTO_UPDATE_COLUMNS) {
    assert.ok(Object.prototype.hasOwnProperty.call(fromNarrow, field), `${field} is missing from the public route`);
  }
  // And the hash still never leaves, on either route.
  assert.equal(fromNarrow.exit_code_hash, undefined);
  assert.equal(fromBundle.exit_code_hash, undefined);
});

// -------------------------------------------------------------------------------------------
// Writing: what is accepted, what is refused, and what an unmentioned field does
// -------------------------------------------------------------------------------------------

const putAs = (body, options = {}) =>
  call("PUT", "/settings/device-control", { authenticated: true, body, ...options });

test("a PUT that mentions one field leaves the other three alone", async () => {
  const { response, statements } = await putAs({ auto_update_days: [6] });
  assert.equal(response.status, 200);
  const update = updateStatement(statements);
  assert.ok(update, "the PUT never reached the UPDATE");

  // The shape that makes this true: each column writes only when its own "was it mentioned" flag
  // is true, and otherwise falls through to itself. Same idiom exit_code_hash already used.
  for (const column of AUTO_UPDATE_COLUMNS) {
    assert.match(update.sql, new RegExp(`ELSE ${column} END`), `${column} does not preserve its stored value`);
  }
  // Only the day list was mentioned, so only the day list is written.
  assert.deepEqual(wroteColumn(update, "auto_update_days"), { mentioned: true, value: "6" });
  for (const column of ["auto_update_enabled", "auto_update_start_minute", "auto_update_end_minute"]) {
    assert.equal(wroteColumn(update, column).mentioned, false, `${column} was written although the body never named it`);
  }
});

test("a PUT that mentions nothing new writes none of the four", async () => {
  // The ordinary kiosk save. It must not reset this counter's update window as a side effect.
  const { response, statements } = await putAs({ fullscreen_lock_enabled: true });
  assert.equal(response.status, 200);
  const update = updateStatement(statements);
  assert.ok(update);
  for (const column of AUTO_UPDATE_COLUMNS) {
    assert.equal(wroteColumn(update, column).mentioned, false, `an unrelated save rewrote ${column}`);
  }
});

test("the stored day list is normalised, de-duplicated and sorted", async () => {
  const { response, statements } = await putAs({ auto_update_days: [6, 1, 1, "3", "SUN"] });
  assert.equal(response.status, 200);
  const update = updateStatement(statements);
  assert.equal(wroteColumn(update, "auto_update_days").value, "0,1,3,6");
});

test("a comma-separated string is accepted as well as an array", async () => {
  const { response, statements } = await putAs({ auto_update_days: " 5 , 2 " });
  assert.equal(response.status, 200);
  assert.equal(wroteColumn(updateStatement(statements), "auto_update_days").value, "2,5");
});

for (const [label, value] of [
  ["an empty array", []],
  ["an empty string", ""],
  ["a string of separators", ",,,"],
  ["a day out of the week", [7]],
  ["a day below zero", [-1]],
  ["nonsense", "whenever"],
  ["null", null],
]) {
  test(`${label} is refused, never stored as an empty day list`, async () => {
    const { response, statements } = await putAs({ auto_update_days: value });
    assert.equal(response.status, 400, `${label} was accepted`);
    assert.equal(response.body.code, "AUTO_UPDATE_DAYS_INVALID");
    // Refused before anything is written: a device left with an empty list can never install, and
    // nothing anywhere would say so.
    assert.equal(updateStatement(statements), undefined, `${label} still reached the UPDATE`);
  });
}

for (const [label, value] of [
  ["a minute past the end of the day", 1440],
  ["a negative minute", -1],
  ["a fraction", 12.5],
  ["a word", "banana"],
  ["an empty string", ""],
  ["null", null],
  ["a boolean", true],
]) {
  test(`${label} is refused as a start minute rather than coerced`, async () => {
    const { response, statements } = await putAs({ auto_update_start_minute: value });
    assert.equal(response.status, 400, `${label} was accepted`);
    assert.equal(response.body.code, "AUTO_UPDATE_WINDOW_INVALID");
    assert.equal(updateStatement(statements), undefined, `${label} still reached the UPDATE`);
  });

  test(`${label} is refused as an end minute rather than coerced`, async () => {
    const { response, statements } = await putAs({ auto_update_end_minute: value });
    assert.equal(response.status, 400, `${label} was accepted`);
    assert.equal(updateStatement(statements), undefined, `${label} still reached the UPDATE`);
  });
}

test("midnight is a real setting and is stored as 0", async () => {
  // The reason a bad minute is refused rather than coerced: 0 has to mean something.
  const { response, statements } = await putAs({ auto_update_start_minute: 0, auto_update_end_minute: 1439 });
  assert.equal(response.status, 200);
  const update = updateStatement(statements);
  assert.equal(wroteColumn(update, "auto_update_start_minute").value, 0);
  assert.equal(wroteColumn(update, "auto_update_end_minute").value, 1439);
});

test("a minute may also be written as a clock time, the way autoUpdate.js spells it", async () => {
  const { response, statements } = await putAs({ auto_update_start_minute: "22:00", auto_update_end_minute: "06:00" });
  assert.equal(response.status, 200);
  const update = updateStatement(statements);
  assert.equal(wroteColumn(update, "auto_update_start_minute").value, 22 * 60);
  assert.equal(wroteColumn(update, "auto_update_end_minute").value, 6 * 60);
});

test("the switch is coerced to a real boolean, and junk is refused", async () => {
  for (const [sent, stored] of [[true, true], ["true", true], [1, true], [false, false], ["false", false], [0, false]]) {
    const { response, statements } = await putAs({ auto_update_enabled: sent });
    assert.equal(response.status, 200, `${JSON.stringify(sent)} was refused`);
    assert.equal(wroteColumn(updateStatement(statements), "auto_update_enabled").value, stored, `${JSON.stringify(sent)} was not stored as ${stored}`);
  }
  for (const sent of ["maybe", 2, null, {}]) {
    const { response, statements } = await putAs({ auto_update_enabled: sent });
    assert.equal(response.status, 400, `${JSON.stringify(sent)} was accepted`);
    assert.equal(response.body.code, "AUTO_UPDATE_ENABLED_INVALID");
    assert.equal(updateStatement(statements), undefined);
  }
});

test("the PUT answers in the same shape the GET does", async () => {
  const row = {
    fullscreen_lock_enabled: false,
    require_exit_code_to_close: true,
    exit_code_hash: null,
    auto_update_enabled: true,
    auto_update_days: "1,2,3,4,5",
    auto_update_start_minute: 1290,
    auto_update_end_minute: 330,
    updated_at: "2026-09-19T00:00:00.000Z",
  };
  const written = await putAs({ auto_update_days: [1, 2, 3, 4, 5] }, { row });
  const read = await call("GET", "/settings/device-control", { row });
  assert.equal(written.response.status, 200);
  assert.deepEqual(Object.keys(written.response.body), Object.keys(read.response.body.deviceControlSettings));
  assert.deepEqual(written.response.body, read.response.body.deviceControlSettings);
});

test("only a rate manager may write the schedule", async () => {
  // The schedule decides when a shop's machine reboots. It is readable before sign-in on purpose;
  // it is not writable by anyone who is not Owner or Admin.
  const { response, statements } = await putAs({ auto_update_enabled: false }, { manager: false });
  assert.equal(response.status, 403);
  assert.equal(updateStatement(statements), undefined);
});

test("a save about update hours does not unlock the counter", async () => {
  // The two kiosk booleans used to be bound as `body.x === true` / `!== false`, so a PUT that did
  // not mention `fullscreen_lock_enabled` switched the fullscreen lock off. That was invisible
  // while the only caller sent both every time; the Update Center screen sends neither.
  const { response, statements } = await putAs({
    auto_update_enabled: true,
    auto_update_days: "6",
    auto_update_start_minute: 1320,
    auto_update_end_minute: 360,
  });
  assert.equal(response.status, 200);
  const update = updateStatement(statements);
  assert.ok(update);
  assert.equal(wroteColumn(update, "fullscreen_lock_enabled").mentioned, false, "the kiosk lock was rewritten by an update-hours save");
  assert.equal(wroteColumn(update, "require_exit_code_to_close").mentioned, false, "close protection was rewritten by an update-hours save");
});

test("the device-control screen still writes both kiosk booleans", async () => {
  // The other half of the same rule: naming a field must still change it, including to false.
  const { response, statements } = await putAs({
    fullscreen_lock_enabled: false,
    require_exit_code_to_close: false,
  });
  assert.equal(response.status, 200);
  const update = updateStatement(statements);
  assert.equal(wroteColumn(update, "fullscreen_lock_enabled").mentioned, true);
  assert.equal(wroteColumn(update, "fullscreen_lock_enabled").value, false);
  assert.equal(wroteColumn(update, "require_exit_code_to_close").mentioned, true);
  assert.equal(wroteColumn(update, "require_exit_code_to_close").value, false);
});
