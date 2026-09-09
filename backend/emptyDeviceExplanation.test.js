"use strict";

/**
 * The report that says why a device syncs successfully and still shows nothing.
 *
 * ## The failure
 *
 * The DELL completed a reference bootstrap with no error -- IDLE sync state, the operational
 * location and device assignment written, the bootstrap meta stored -- and stayed empty. A sync
 * that transfers nothing is indistinguishable, from the device, from a sync that has not happened.
 *
 * It transfers nothing when the device's canonical scope does not match where the rows are, and
 * the bootstrap does not use one filter for everything: products go by company alone, inventory
 * lots by company *and* branch *and* operational location. So a device can be approved, assigned
 * and authenticated, correct in every screen the app shows, and receive zero products because its
 * company id is not the company id on the products.
 *
 * ## What is tested
 *
 * That the report describes the filters the bootstrap actually uses. A diagnostic that explains
 * the wrong thing is worse than no diagnostic, because it is believed and it ends the search.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SCRIPT = path.join(__dirname, "..", "scripts", "cloud", "explain-empty-device.mjs");
const modulePath = pathToFileURL(SCRIPT).href;
const BOOTSTRAP = fs.readFileSync(path.join(__dirname, "syncReferenceBootstrap.js"), "utf8");

/** The chunk of `syncReferenceBootstrap.js` that selects from `table`, and its WHERE clause. */
const queryFor = (table) => {
  const chunks = BOOTSTRAP.split("client.query(").slice(1);
  // `FROM products` appears only in the products query; the other queries reach it as
  // `JOIN products p`. Matching the FROM is what keeps one table's filter from being read off
  // another table's join.
  const chunk = chunks.find((text) => new RegExp(`FROM\\s+${table}\\b`).test(text));
  assert.ok(chunk, `the bootstrap no longer selects FROM ${table}`);
  const where = chunk.slice(chunk.search(/\bWHERE\b/));
  return where.slice(0, where.indexOf("`"));
};

test("each counted table is counted by the filter the bootstrap really uses", async () => {
  const { BOOTSTRAP_SCOPES } = await import(modulePath);
  assert.ok(BOOTSTRAP_SCOPES.length >= 5, "the report must still cover the business tables");

  for (const scope of BOOTSTRAP_SCOPES) {
    const where = queryFor(scope.table);
    const compared = [...new Set(
      [...where.matchAll(/(?:\w+\.)?([a-z_]+)\s*=\s*\$\d/gi)].map(([, column]) => column),
    )];
    assert.deepEqual(
      [...scope.by].sort(),
      compared.sort(),
      `${scope.table} is filtered by ${compared.join(", ") || "nothing"} in the bootstrap, `
        + `but the report groups it by ${scope.by.join(", ")}`,
    );
    assert.equal(
      scope.softDelete,
      /deleted_at IS NULL/.test(where),
      `${scope.table}: the report and the bootstrap disagree about whether deleted rows count`,
    );
  }
});

test("every table the bootstrap reads is either counted or excused in writing", async () => {
  // The failure this prevents: a new entity joins the bootstrap, this report keeps printing a
  // confident RESULT line that silently does not cover it, and the next blank screen is explained
  // away by a diagnostic that never looked.
  const { BOOTSTRAP_SCOPES, NOT_COUNTED } = await import(modulePath);
  const counted = new Set(BOOTSTRAP_SCOPES.map((scope) => scope.table));

  // The SQL only. A first pass scanned the whole module and reported a table called "a", read out
  // of the prose "from a rate the shop retired" -- a diagnostic guard that fails on English is a
  // guard that gets deleted.
  const statements = [...BOOTSTRAP.matchAll(/client\.query\(\s*`([^`]*)`/g)]
    .map(([, sql]) => sql.replace(/--.*$/gm, ""));
  assert.ok(statements.length >= 5, `expected the bootstrap's queries, found ${statements.length}`);

  const read = new Set(
    [...statements.join("\n").matchAll(/FROM\s+([a-z_]+)/gi)].map(([, table]) => table),
  );

  const uncovered = [...read].filter((table) => !counted.has(table) && !NOT_COUNTED[table]);
  assert.deepEqual(
    uncovered,
    [],
    `these tables are read by the bootstrap but neither counted nor excused: ${uncovered.join(", ")}`,
  );
  for (const [table, reason] of Object.entries(NOT_COUNTED)) {
    assert.ok(reason.length > 30, `${table} needs a real reason, not a placeholder`);
  }
});

test("no active assignment is reported as that, not as a scope mismatch", async () => {
  const { explainEmptiness } = await import(modulePath);
  const verdict = explainEmptiness({ assignment: null, sent: {}, available: {} });
  assert.equal(verdict.code, "NO_ACTIVE_ASSIGNMENT");
});

test("an empty cloud is not reported as a scope mismatch", async () => {
  // The two are fixed in opposite ways -- one by posting the device, the other by entering data --
  // so telling them apart is the whole value of the report.
  const { explainEmptiness, BOOTSTRAP_SCOPES } = await import(modulePath);
  const sent = Object.fromEntries(BOOTSTRAP_SCOPES.map(({ entity }) => [entity, 0]));
  const available = Object.fromEntries(BOOTSTRAP_SCOPES.map(({ table }) => [table, 0]));
  assert.equal(explainEmptiness({ assignment: {}, sent, available }).code, "NOTHING_TO_SEND");
});

test("rows that exist and are not sent are reported as a scope mismatch", async () => {
  const { explainEmptiness, BOOTSTRAP_SCOPES } = await import(modulePath);
  const sent = Object.fromEntries(BOOTSTRAP_SCOPES.map(({ entity }) => [entity, 0]));
  const available = Object.fromEntries(BOOTSTRAP_SCOPES.map(({ table }) => [table, 0]));
  available.products = 25;
  assert.equal(explainEmptiness({ assignment: {}, sent, available }).code, "SCOPE_MISMATCH");
});

test("a device receiving everything is not blamed on scope", async () => {
  const { explainEmptiness, BOOTSTRAP_SCOPES } = await import(modulePath);
  const sent = Object.fromEntries(BOOTSTRAP_SCOPES.map(({ entity }) => [entity, 3]));
  const available = Object.fromEntries(BOOTSTRAP_SCOPES.map(({ table }) => [table, 3]));
  assert.equal(explainEmptiness({ assignment: {}, sent, available }).code, "SCOPE_MATCHES");
});

test("the report only reads", async () => {
  // It is run against a live shop's database, always when something is already wrong. Moving
  // business rows between companies or locations is not something a diagnostic may do.
  const source = fs.readFileSync(SCRIPT, "utf8");
  const executed = [...source.matchAll(/client\.query\(\s*(`([^`]*)`|"([^"]*)")/g)]
    .map(([, , backticked, doubleQuoted]) => backticked ?? doubleQuoted ?? "");
  assert.ok(executed.length >= 4, "the report must still run its queries");
  for (const statement of executed) {
    assert.match(
      statement.trim(),
      /^SELECT\b/i,
      `the report may only SELECT, found: ${statement.trim().slice(0, 60)}`,
    );
  }
});
