"use strict";

/**
 * A hosted deployment must not start on a database that is behind the code.
 *
 * ## What this replaces
 *
 * `verifyRequiredDatabaseSchema` checked a short list of required tables and nothing else, while
 * `initializeDatabase()` declares 88 tables and 268 added columns -- and does not run on a hosted
 * deployment at all. So the server booted clean and every other absence waited for whichever route
 * read it first. Two were found that way, each after weeks of healthy-looking service:
 *
 *     column u.failed_login_attempts does not exist   -> every cloud sign-in answered 500
 *     relation "charge_types" does not exist          -> no device could ever be filled from cloud
 *
 * Both were visible in a two-query comparison the whole time. Nobody ran it, because running it was
 * a separate act that only happened after something already hurt.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SERVER = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const contract = require("./schemaContract");

test("the startup check runs the same comparison the ops script does", () => {
  // One definition of "what the schema should be". Two copies is the failure this area keeps
  // producing -- migration 015 against the bootstrap, the drift report against the real filters --
  // so the script and the server must import, not restate.
  const script = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "cloud", "check-schema-drift.mjs"), "utf8",
  );
  assert.match(script, /require\("\.\/schemaContract\.js"\)/, "the script must use the shared module");
  assert.ok(
    !/export const bootstrapSql = \(source\) => \{/.test(script),
    "the script must not carry its own copy of the parser",
  );
  assert.match(SERVER, /require\("\.\/schemaContract"\)/, "the server must use it too");
});

test("a hosted deployment refuses to start on a drifted database", () => {
  const check = SERVER.slice(SERVER.indexOf("const verifyDeclaredSchema"));
  const body = check.slice(0, check.indexOf("\n};"));

  assert.match(body, /if \(!hostedCloudDeployment\) return;/, "only where the bootstrap is off");
  assert.match(body, /findSchemaDrift/, "it must actually compare");
  assert.match(body, /throw new Error\(description\)/, "drift must stop the deployment");

  // The refusal has to come before the server listens, or it is a log line rather than a gate.
  //
  // The existence check is not decoration: `indexOf` answers -1 when the call is gone, and
  // `-1 < anything` is true -- so an ordering assertion on its own passes most loudly at the exact
  // moment the call has been deleted.
  const callAt = SERVER.indexOf("await verifyDeclaredSchema();");
  const listenAt = SERVER.indexOf("app.listen(PORT");
  assert.notEqual(callAt, -1, "the startup chain must actually call verifyDeclaredSchema");
  assert.notEqual(listenAt, -1, "sanity: app.listen must still be findable");
  assert.ok(callAt < listenAt, "the check must run before the server accepts requests");
});

test("the escape hatch exists, is off by default, and is loud", () => {
  // A refusal that cannot be overridden becomes a reason to delete the check the first night it is
  // inconvenient. One that can be overridden silently is not a refusal at all.
  const check = SERVER.slice(SERVER.indexOf("const verifyDeclaredSchema"));
  const body = check.slice(0, check.indexOf("\n};"));
  assert.match(body, /FROOZERP_ALLOW_SCHEMA_DRIFT/);
  assert.match(body, /readOptionalBoolean\(process\.env\.FROOZERP_ALLOW_SCHEMA_DRIFT, false\)/,
    "it must default to refusing");
  assert.match(body, /console\.error\(`\[schema-drift\] STARTING ANYWAY/,
    "overriding must say so at error level, naming the drift");
});

test("the refusal names what is missing and what to do", async () => {
  // A message that says only "schema drift" sends somebody back to the script this check exists to
  // replace.
  const description = contract.describeSchemaDrift({
    missingTables: ["charge_types"],
    missingColumns: ["users.failed_login_attempts"],
    declaredTables: 88,
    declaredColumns: 268,
  });
  assert.match(description, /charge_types/);
  assert.match(description, /users\.failed_login_attempts/);
  assert.match(description, /backend\/migrations\/cloud/, "it must say where a migration goes");
  assert.match(description, /run-cloud-migrations/, "and how it gets applied");
});

test("a database that matches is not reported as drift", () => {
  // The shape of a false alarm: a gate that always fires gets an env var set permanently, and then
  // it is a comment.
  const sql = contract.bootstrapSql(SERVER);
  const tables = contract.declaredTables(sql);
  const columns = contract.declaredColumns(sql);
  const result = contract.compareSchema({ tables, columns, liveTables: tables, liveColumns: columns });
  assert.deepEqual(result.missingTables, []);
  assert.deepEqual(result.missingColumns, []);
});

test("the two failures that motivated this are both caught", () => {
  const sql = contract.bootstrapSql(SERVER);
  const tables = contract.declaredTables(sql);
  const columns = contract.declaredColumns(sql);

  // A database exactly like the shop's cloud before migrations 014 and 015.
  const result = contract.compareSchema({
    tables,
    columns,
    liveTables: tables.filter((name) => name !== "charge_types"),
    liveColumns: columns.filter(([table, column]) => !(table === "users" && column === "failed_login_attempts")),
  });
  assert.ok(result.missingTables.includes("charge_types"));
  assert.ok(result.missingColumns.includes("users.failed_login_attempts"));
});

test("the check reads only", () => {
  // It runs at startup against a live shop's database. Repairing drift automatically is exactly
  // what `runStartupSchemaBootstrap` is switched off to prevent.
  const source = fs.readFileSync(path.join(__dirname, "schemaContract.js"), "utf8");
  const executed = [...source.matchAll(/client\.query\(\s*"([^"]*)"/g)].map(([, sql]) => sql);
  assert.ok(executed.length >= 2, "the two catalogue queries must still be there");
  for (const statement of executed) {
    assert.match(statement.trim(), /^SELECT\b/i, `may only SELECT, found: ${statement.slice(0, 60)}`);
  }
});
