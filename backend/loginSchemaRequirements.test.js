const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

/**
 * Every relation `/login` names has to be a table startup refuses to start without.
 *
 * PostgreSQL resolves every relation in a statement at parse time, so a table referenced only
 * inside that query's guarded `EXISTS` subquery still has to exist for anybody to sign in. Several
 * of them arrive with cloud migrations 006 and 009 rather than the startup bootstrap, and
 * REQUIRED_DATABASE_TABLES did not list them.
 *
 * The result, reproduced on 2026-09-19 rehearsing 1.0.73 against a database that had never had the
 * cloud migrations applied: the server starts completely clean -- "schema bootstrap completed",
 * business counts, "Server running" -- and then answers every login with a 500 reading
 * `relation "companies" does not exist`, visible only in the server's own console. A shop in that
 * state has a healthy-looking backend that nobody can sign in to.
 *
 * Written against the query rather than a fixed list, so a join added to `/login` later is caught
 * by this suite instead of by a counter at opening time.
 */

const SERVER = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

const loginQuerySource = () => {
  const route = SERVER.indexOf('app.post("/login"');
  assert.ok(route > 0, "the login route must be findable");
  const from = SERVER.indexOf("FROM users u", route);
  assert.ok(from > route, "the login query must still select from users");
  // To the end of that template literal: the query is one statement and ends at the backtick.
  const end = SERVER.indexOf("`", from);
  assert.ok(end > from, "the login query must be a template literal");
  return SERVER.slice(from, end);
};

const requiredTables = () => {
  const start = SERVER.indexOf("const REQUIRED_DATABASE_TABLES = [");
  assert.ok(start > 0, "REQUIRED_DATABASE_TABLES must exist");
  const body = SERVER.slice(start, SERVER.indexOf("];", start));
  return body
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .flatMap((line) => line.match(/"([a-z_][a-z0-9_]*)"/g) || [])
    .map((quoted) => quoted.replace(/"/g, ""));
};

// \b before the keyword matters: without it `effective_from IS NULL` reads as a FROM clause and
// the extraction reports a table called "is".
const tablesNamedBy = (sql) =>
  [...new Set((sql.match(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi) || [])
    .map((match) => match.split(/\s+/)[1].toLowerCase()))]
    .filter((name) => !["lateral", "unnest", "select"].includes(name));

const bootstrapCreates = (table) =>
  SERVER.includes(`CREATE TABLE IF NOT EXISTS ${table}`);

test("every table the login query names is one startup would refuse to start without", () => {
  const required = requiredTables();
  const named = tablesNamedBy(loginQuerySource());

  assert.ok(named.includes("users"), "sanity: the extraction must find the obvious table");
  assert.ok(named.length >= 5, `sanity: the login query joins several tables, found ${named.length}`);

  const unguarded = named.filter((table) => !required.includes(table) && !bootstrapCreates(table));
  assert.deepEqual(
    unguarded,
    [],
    `login reads ${unguarded.join(", ")}, which neither the startup bootstrap creates nor `
    + "REQUIRED_DATABASE_TABLES demands. A database missing one starts clean and 500s every "
    + "sign-in. Add it to REQUIRED_DATABASE_TABLES.",
  );
});

test("the tables cloud migrations 006 and 009 install are required by name", () => {
  const required = requiredTables();
  // Named individually as well: the query-derived test above stops being able to see these the
  // moment somebody rewrites the login query, and they would still be required.
  for (const table of ["companies", "device_assignments", "operational_locations", "staff_location_assignments"]) {
    assert.ok(required.includes(table), `${table} must be in REQUIRED_DATABASE_TABLES`);
  }
});

test("the required-table check runs even when the startup bootstrap ran", () => {
  const prepare = SERVER.slice(SERVER.indexOf("const prepareDatabaseForStartup"));
  const body = prepare.slice(0, prepare.indexOf("business counts after bootstrap"));
  const bootstrapBranch = body.indexOf("if (runStartupSchemaBootstrap)");
  const verify = body.indexOf("verifyRequiredDatabaseSchema()");
  assert.ok(verify > bootstrapBranch, "verification must come after the bootstrap branch");
  // Not inside the else. A check that only runs when the bootstrap is disabled would not have
  // caught this, because the rehearsal that found it had the bootstrap enabled.
  assert.match(body.slice(verify - 200, verify), /\}\s*(\/\/[^\n]*\n\s*)*await ensureProductEntrySchema\(\);\s*await $/s);
});
