"use strict";

/**
 * A-7 — FROST reads one branch, and refuses rather than widening when it is not told which.
 *
 * ## The bug this pins
 *
 * Every fact query in `aiBusinessAssistantService.js` ran with no tenancy predicate. A Cashier with
 * `ai_assistant_view` — the lowest permission floor in the app — could ask FROST about "our sales"
 * and be answered with every branch's sales added together, in fluent prose that reads exactly like
 * a correct answer about their own shop. That is worse than the equivalent bug in a table: a table
 * shows its rows and a wrong total can be noticed; a sentence cannot be audited by looking at it.
 *
 * The module also wrote `company_id = 1` as a literal in four places, so its own audit trail
 * attributed every answer to company 1 regardless of who asked.
 *
 * ## Why these tests are source assertions
 *
 * There is no database here, so "did it return another branch's rows" is not answerable. What is
 * answerable, and is the error that actually occurred, is whether the predicate is present at all
 * and whether an absent scope still widens. `tenancyCoverage.test.js` measures the first by running
 * the routes; this file guards the two properties that measurement cannot see — the refusal, and
 * the absence of the literals that the measurement would happily count as "mentions company_id".
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SOURCE = fs.readFileSync(path.join(__dirname, "aiBusinessAssistantService.js"), "utf8");
const CODE = SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

test("an absent branch refuses instead of widening to every branch", () => {
  // The whole point. `|| 1` here would have been the same bug in a new place: a default that
  // silently picks a branch is indistinguishable, in the response, from a correct answer.
  assert.match(CODE, /const requireBranchScope = \(branchId\) => \{/);
  assert.match(CODE, /if \(!parsed\) throw new Error\("FROST_BRANCH_SCOPE_REQUIRED/);
});

test("no fact query is left binding a hard-coded company or branch", () => {
  // `const filters = ["company_id = 1"]` and `VALUES (1, 1, ...)` were the measured literals.
  assert.doesNotMatch(CODE, /company_id = 1"/, "the frost_memories filter must not pin company 1");
  assert.doesNotMatch(CODE, /VALUES \(1, 1,/, "ai_alerts must not be written into company 1 / branch 1");
  assert.doesNotMatch(
    CODE,
    /user\.branch_id \|\| 1/,
    "a write must take the verified session branch, not the permission row's with a fallback",
  );
});

test("the branch reaching a handler is the verified session claim", () => {
  // `req.auth` is the only identity A-4 allows, and the branch must come from the same place. A
  // `req.body.branch_id` or `req.query.branch_id` here would reintroduce exactly the header-trust
  // bug that requireAiPermission's own comment describes.
  assert.ok(CODE.includes("req.auth.branchId"), "routes must scope from the verified claim");
  assert.doesNotMatch(
    CODE,
    /(?:getCustomerOutstanding|getDailySalesSummary|buildDailyBriefing|getStoredAlerts)\(\s*pool\s*,\s*req\.(?:body|query)\./,
    "a fact producer must never take its branch from the request body or query",
  );
});

test("every fact producer that reads business data demands a branch", () => {
  // A producer that still takes `(pool)` alone cannot have been given a scope, so it is either
  // unscoped or reading a non-tenant table. Listing them by name would rot; deriving the set from
  // the source keeps this true as producers are added.
  const producers = [...CODE.matchAll(/const (get[A-Z]\w+|runAlertRules|buildDailyBriefing) = async \(pool([^)]*)\)/g)];
  assert.ok(producers.length > 30, `expected the fact-producer surface, found ${producers.length}`);

  // The body ends at the next top-level declaration. A fixed-size window instead of this read past
  // the end of short producers and attributed the *next* function's tables to them -- which is how
  // `getAiSettings`, whose only query is `SELECT * FROM ai_settings`, first appeared in this list.
  const readsBusinessData = (name) => {
    const start = CODE.indexOf(`const ${name} = async (pool`);
    if (start === -1) return false;
    const rest = CODE.slice(start + 10);
    const nextDecl = rest.search(/\nconst [A-Za-z_$][\w$]* = /);
    const body = nextDecl === -1 ? rest : rest.slice(0, nextDecl);
    return /\b(?:FROM|JOIN)\s+(sales|purchases|expenses|inventory_batches|waste_entries|customer_payments|supplier_payments|sale_items|sale_payments|purchase_items)\b/i.test(body);
  };

  // Without this floor the test passes by detecting nothing: tighten `readsBusinessData` too far,
  // or rename the tables, and every producer looks harmless. 24 were detected when this was
  // written, and the number should fall only if a producer is deleted.
  const reading = producers.filter(([, name]) => readsBusinessData(name));
  assert.ok(
    reading.length >= 20,
    `the table detector matched only ${reading.length} producers; it has stopped seeing the queries`,
  );

  const unscoped = producers
    .filter(([, name, rest]) => !rest.includes("branchId") && readsBusinessData(name))
    .map(([, name]) => name);
  assert.deepEqual(unscoped, [], "these read business tables without taking a branch");
});

test("the alert and reminder dedup keys cannot collide across branches", () => {
  // `ai_alerts.dedup_key` is the ON CONFLICT target. Branch-blind, the same rule firing in two
  // branches -- the same customer overdue, the same product low -- collapsed onto one row and the
  // second branch's alert silently overwrote the first's.
  assert.match(CODE, /customer-overdue:\$\{branchId\}:/);
  assert.match(CODE, /purchase-pending:\$\{branchId\}:/);
  assert.match(CODE, /low-stock:\$\{branchId\}:/);
  assert.match(CODE, /buildReminderDedupKey\(\{[^}]*branchId: req\.auth\.branchId/);
});
