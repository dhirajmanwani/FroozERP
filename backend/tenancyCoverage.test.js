"use strict";

/**
 * A-7 step 4 — the measurement that makes the rest of the stage finishable.
 *
 * Steps 1 to 3 closed the write half of the branch-isolation failure by reasoning about specific
 * routes. Reasoning is how the original bug got in. This file replaces it with a measurement: every
 * GET route is driven with a real signed session and the SQL it runs is recorded, then checked for
 * a `branch_id` / `company_id` predicate on any statement touching a tenant-owned table.
 *
 * ## What a pass here does NOT mean
 *
 * There is no database in this environment. This proves what the query *said*, not what it
 * returned. A route counted SCOPED could still scope by a value the caller supplied rather than by
 * the session — that needs a live two-branch database and is recorded as still open. What it
 * catches reliably is the commoner and more serious error: **no tenancy predicate at all**, which
 * cannot be right under any reading.
 *
 * The baseline is the point. It turns "119 unscoped routes" from a sentence in a document into a
 * number that fails a test when it grows.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { TENANT_TABLE_PATTERN, SCOPE_PREDICATE_PATTERN, collectTenancyCoverage } = require("./tenancyCoverage");

/**
 * GET routes measured, on 2026-08-21, to run SQL against a tenant-owned table with no tenancy
 * predicate on at least one statement.
 *
 * This list may **shrink** freely — that is the work. It may not grow: a new entry means a route
 * was added that reads every branch's rows, and the failure names it.
 *
 * The count differs from the audit's 119 and both are honest. The audit counted every registration
 * that touches business data, by reading. This counts only GET routes whose handler actually
 * reached SQL against one of the tables named in `TENANT_TABLES`, by running them. A route that
 * throws before its first query, or reads a table not on that list, lands in neither number.
 */
/*
 * Scoped and removed from this list on 2026-08-21 (A-7 Phase 1, first batch):
 *   GET /sales, /purchases, /expenses, /waste-entries, /sale-returns, /contra-entries
 * Second batch, same day:
 *   GET /inventory, /stock, /stock-inventory, /supplier-payments, /accounts/payments
 * Third batch, same day — account balances, the balance sheet and the dashboards:
 *   GET /suppliers, /suppliers/:id, /supplier-summary, /supplier-ledger, /customers,
 *   /customer-summary, /customer-ledger, /reports/balance-sheet,
 *   /reports/balance-sheet/details/:lineKey, /api/owner/dashboard-foundation
 * Fourth batch, same day — product/lot reads, sales history and the two report books:
 *   GET /products, /products/:id/lots, /lot-discounts, /stock-adjustments,
 *   /pending-bills/customer, /sale-returns/options/:saleId, /sales-report/changes,
 *   /sales-history, /sales-history/:id, /sales-history/items, /sales-history/lots,
 *   /reports/cash-book, /reports/day-book
 * Fifth batch, same day — the Report Center:
 *   GET /reports/summary, all 27 of its queries.
 * Each now filters on `branch_id` from the verified session. 37 -> 26 -> 16 -> 3 -> 2.
 */
/*
 * Two entries below cannot be removed by any amount of work in Phase 1, and saying so here stops
 * the next person burning an afternoon on them. `GET /accounts` and `GET /accounts/outstanding`
 * scope both of their money halves already; what keeps them on the list is the third statement,
 * `SELECT * FROM accounts`, and the `accounts` table has no `branch_id` — it is company-wide master
 * data, like `customers` and `suppliers`. They become measurable when Phase 2 backfills
 * `company_id` (see docs/tenancy-backfill-plan.md). They are left on the list rather than
 * reclassified, because moving a table out of TENANT_TABLES to make the number fall would be
 * scoring the exam.
 */
const KNOWN_UNSCOPED_READS = [
  "GET /accounts",
  "GET /accounts/outstanding",
];

let coverage;
const measure = async () => {
  if (!coverage) coverage = await collectTenancyCoverage();
  return coverage;
};

test("no new route reads every branch's rows", async () => {
  // The regression guard, and the reason this file exists. A route added in six months that forgets
  // its branch filter fails here with its own name attached, instead of being discovered by a shop
  // owner reading a report that includes somebody else's shop.
  const { unscoped } = await measure();
  const added = unscoped.filter((route) => !KNOWN_UNSCOPED_READS.includes(route));
  assert.deepEqual(added, [], "these routes read tenant data with no branch or company predicate");
});

test("the baseline shrinks or holds, and never silently grows", async () => {
  const { unscoped } = await measure();
  assert.ok(
    unscoped.length <= KNOWN_UNSCOPED_READS.length,
    `unscoped read routes rose from ${KNOWN_UNSCOPED_READS.length} to ${unscoped.length}`,
  );
});

test("a route that gains scoping is removed from the baseline, not left to rot", async () => {
  // A stale entry is as bad as a missing one: it hides finished work and makes the number
  // meaningless. When a route is fixed, this fails until the list is updated.
  const { unscoped } = await measure();
  const fixed = KNOWN_UNSCOPED_READS.filter((route) => !unscoped.includes(route));
  assert.deepEqual(fixed, [], "these are now scoped — delete them from KNOWN_UNSCOPED_READS");
});

test("the measurement actually ran, rather than passing on an empty result", async () => {
  // Every assertion above passes vacuously if the harness silently fails to load the app. The audit
  // measured ~285 registrations; a GET count in the low hundreds is the shape to expect.
  const { total, unscoped, scoped, noTenantData } = await measure();
  assert.ok(total > 80, `expected a substantial GET surface, measured ${total}`);
  assert.equal(unscoped.length + scoped.length + noTenantData.length, total, "every route must be classified");
  assert.ok(unscoped.length > 0, "a clean sweep here means the harness stopped detecting anything");
});

test("the detector recognises a tenant table and a scope predicate", async () => {
  // Guards the two regexes the whole measurement rests on. If either stopped matching, every route
  // would silently classify as "no tenant data" and the suite would go green while measuring
  // nothing.
  assert.equal(TENANT_TABLE_PATTERN.test("SELECT * FROM sales WHERE id = $1"), true);
  assert.equal(TENANT_TABLE_PATTERN.test('UPDATE "inventory_batches" SET x = 1'), true);
  assert.equal(TENANT_TABLE_PATTERN.test("SELECT 1 FROM roles"), false, "shared tables are not tenant data");

  assert.equal(SCOPE_PREDICATE_PATTERN.test("WHERE branch_id = $2"), true);
  assert.equal(SCOPE_PREDICATE_PATTERN.test("WHERE company_id = $2"), true);
  assert.equal(SCOPE_PREDICATE_PATTERN.test("WHERE id = $1"), false);
});
