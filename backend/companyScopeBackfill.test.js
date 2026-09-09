"use strict";

/**
 * The repair that gives the shop's oldest rows the company they always belonged to.
 *
 * ## Why the refusals are the important half
 *
 * Migration 009 added `company_id` as a nullable column and nothing ever filled it in, so on the
 * shop's cloud 25 products, 13 suppliers and 70 lots have no company. Every company-scoped reader
 * excludes them without a word -- `NULL = 1` is NULL, not false -- which is why a device can
 * bootstrap successfully and stay empty.
 *
 * Adopting them is only safe while the answer is forced. One company: there is exactly one value
 * the rows can take. Two: nothing in the data says which shop a product belonged to, and a wrong
 * guess moves one shop's stock into another shop's books -- a far worse outcome than a blank
 * screen, and one nobody would notice until the numbers were argued about. The same holds for a
 * lot's counter.
 *
 * So the tests below are mostly about what it declines to do.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SCRIPT = path.join(__dirname, "..", "scripts", "cloud", "backfill-company-scope.mjs");
const modulePath = pathToFileURL(SCRIPT).href;

const shopToday = {
  companies: [1],
  locationsByBranch: { 1: [1] },
  orphans: { products: 25, suppliers: 13, inventory_batches: 70, product_categories: 0, customers: 0 },
  orphanLots: { 1: 70 },
};

test("one company, one counter: the answer is forced, so it is taken", async () => {
  const { planBackfill } = await import(modulePath);
  const plan = planBackfill(shopToday);
  assert.equal(plan.refused, undefined);
  assert.equal(plan.companyId, 1);
  assert.deepEqual(
    plan.writes.map(({ table, rows }) => [table, rows]),
    [["products", 25], ["suppliers", 13], ["inventory_batches", 70]],
    "a table with no orphans must not be written to at all",
  );
  assert.deepEqual(plan.locationWrites, [
    { table: "inventory_batches", column: "operational_location_id", value: 1, branch: "1", rows: 70 },
  ]);
});

test("two companies: it refuses rather than picking one", async () => {
  // The failure this prevents cannot be undone by re-running anything: once a product is filed
  // under the wrong company its stock, its rates and its bills follow it there.
  const { planBackfill } = await import(modulePath);
  const plan = planBackfill({ ...shopToday, companies: [1, 2] });
  assert.equal(plan.refused, "MANY_COMPANIES");
  assert.match(plan.message, /1, 2/, "the refusal must name the companies it found");
  assert.equal(plan.writes, undefined, "a refusal must not also carry writes");
});

test("no company at all: there is nothing to adopt into", async () => {
  const { planBackfill } = await import(modulePath);
  assert.equal(planBackfill({ ...shopToday, companies: [] }).refused, "NO_COMPANY");
});

test("a branch with two counters keeps its stock where it is", async () => {
  // A lot records its branch but not its counter, so with two counters the shop's own records do
  // not say which one holds it. Leaving stock invisible is recoverable; moving it to the wrong
  // counter silently is not.
  const { planBackfill } = await import(modulePath);
  const plan = planBackfill({ ...shopToday, locationsByBranch: { 1: [1, 7] } });
  assert.deepEqual(plan.locationWrites, [], "no lot may be placed by guessing");
  assert.equal(plan.locationRefusals.length, 1);
  assert.match(plan.locationRefusals[0].reason, /two|2 operational locations/);
  assert.deepEqual(
    plan.writes.map(({ table }) => table),
    ["products", "suppliers", "inventory_batches"],
    "the company backfill is still forced and must still happen",
  );
});

test("a branch with no counter is refused too, and named", async () => {
  const { planBackfill } = await import(modulePath);
  const plan = planBackfill({ ...shopToday, locationsByBranch: {} });
  assert.deepEqual(plan.locationWrites, []);
  assert.match(plan.locationRefusals[0].reason, /no operational location/);
});

test("a repaired database reports nothing to do", async () => {
  // Re-running must be safe and must say so, rather than reporting a successful repair of nothing.
  const { planBackfill } = await import(modulePath);
  const plan = planBackfill({
    companies: [1], locationsByBranch: { 1: [1] },
    orphans: { products: 0, suppliers: 0, inventory_batches: 0 }, orphanLots: {},
  });
  assert.equal(plan.refused, "NOTHING_TO_DO");
});

test("it writes only to rows that have no company, and only under --apply", async () => {
  const source = fs.readFileSync(SCRIPT, "utf8");
  // Join string concatenation first. The WHERE clause of the lot repair sits in a second string
  // literal, so matching the raw text finds an UPDATE that appears unbounded and is not -- a guard
  // that fails on formatting gets relaxed until it guards nothing.
  const joined = source.replace(/"\s*\+\s*"/g, "");
  const updates = [...joined.matchAll(/UPDATE [^"`]*/g)]
    .map(([text]) => text)
    .filter((text) => text.includes("SET"));
  assert.ok(updates.length >= 2, `expected the two repair statements, found ${updates.length}`);
  for (const statement of updates) {
    assert.match(
      statement,
      /IS NULL/,
      `every write must be bounded to rows that have no value: ${statement.slice(0, 80)}`,
    );
  }
  // A dry run is the default; the flag is what makes it act.
  assert.match(source, /const apply = argv\.includes\("--apply"\)/);
  assert.match(source, /if \(!apply\)/, "the dry run must return before any UPDATE");
  assert.ok(
    source.indexOf('if (!apply)') < source.indexOf('await client.query("BEGIN")'),
    "the dry-run check must come before the transaction that writes",
  );
});

test("it never deletes and never widens what it touches", async () => {
  // It runs against a live shop's cloud. A repair that can remove a row is not a repair.
  const source = fs.readFileSync(SCRIPT, "utf8");
  for (const forbidden of [/\bDELETE\s+FROM\b/i, /\bDROP\s+/i, /\bTRUNCATE\b/i]) {
    assert.ok(!forbidden.test(source), `the repair must not contain ${forbidden}`);
  }
});
