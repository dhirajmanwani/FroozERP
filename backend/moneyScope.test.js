"use strict";

/**
 * Which routes answer a company question and which answer a shop question.
 *
 * A-7 Phase 1 originally scoped every money read to the caller's branch. The maintainer corrected
 * that on 2026-08-21 for one class of figure, and the reason is a fact about how the business runs
 * rather than a preference: stock is bought from a supplier once, in bulk, into a warehouse branch,
 * and is then transferred out to the shops beneath it. A per-shop supplier balance would therefore
 * park the whole debt on the warehouse and report zero at every shop that actually sells the goods.
 * Customer balances go the same way — a customer may settle at any counter.
 *
 * The balance sheet and the dashboard tiles stay per shop, deliberately: a shop's payables have to
 * sit against that shop's own cash or the sheet does not balance.
 *
 * So there are now two scopes in the codebase, and the difference between them is invisible in a
 * diff — both are a `branch_id` predicate, one of them wrapped in a subquery over `branches`. That
 * is exactly the kind of distinction that decays silently, which is why it is asserted here against
 * the SQL the routes actually run rather than against the source text.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  loadServerApp,
  probe,
  startQueryRecording,
  stopQueryRecording,
} = require("./routeAuthCoverage");
const { issueDeviceSession } = require("./deviceSession");

/** Must match the throwaway key `routeAuthCoverage` pins into the environment before loading. */
const TEST_SIGNING_KEY = "route-auth-coverage-isolated-signing-key-000000";

/** The company form: a branch predicate resolved through the company's branch list. */
const COMPANY_SCOPED = /branch_id\s+IN\s*\(\s*SELECT\s+id\s+FROM\s+branches\s+WHERE\s+company_id\s*=\s*\$\d+/i;
/** The shop form: a direct equality on the session's own branch. */
const BRANCH_SCOPED = /branch_id\s*=\s*\$\d+/i;

let app;
let token;
const run = async (path) => {
  if (!app) {
    app = loadServerApp();
    token = issueDeviceSession({
      userId: 7,
      deviceId: "FZDEV-MONEY-SCOPE",
      companyId: 1,
      branchId: 1,
      role: "Owner",
      secret: TEST_SIGNING_KEY,
    });
  }
  startQueryRecording();
  await probe(app, "GET", path, {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  });
  return stopQueryRecording();
};

/** Statements that mention money tables at all — the ones whose scope is the question. */
const moneyStatements = (statements) =>
  statements.filter((sql) => /\b(?:from|join)\s+"?(?:purchases|supplier_payments|sales|customer_payments)\b/i.test(sql));

const COMPANY_ROUTES = [
  "/suppliers",
  "/supplier-summary",
  "/customers",
  "/customer-summary",
  "/supplier-payments",
  "/pending-bills/customer",
];

/**
 * `/dashboard-metrics` and `/dashboard-analytics` belong on this list by intent, but cannot be
 * driven here: both check a `dashboard` permission first, and the stubbed database answers that
 * lookup with no rows, so the probe gets a 403 and never reaches a money query. Listing them anyway
 * would produce a test that passes because nothing ran — the assertion below refuses that on
 * purpose. Their scope is covered instead by `getDashboardSummary` taking `branchId` as a required
 * argument, which throws rather than defaulting.
 */
const BRANCH_ROUTES = [
  "/reports/balance-sheet",
  "/sales",
  "/purchases",
];

for (const route of COMPANY_ROUTES) {
  test(`GET ${route} asks the company question`, async () => {
    const money = moneyStatements(await run(route));
    assert.ok(money.length > 0, `${route} ran no money query, so this test proves nothing`);
    const notCompanyScoped = money.filter((sql) => !COMPANY_SCOPED.test(sql));
    assert.deepEqual(
      notCompanyScoped.map((sql) => sql.replace(/\s+/g, " ").slice(0, 120)),
      [],
      `${route} shows a balance, and a balance is a company figure here — see resolveMoneyScope`,
    );
  });
}

for (const route of BRANCH_ROUTES) {
  test(`GET ${route} asks the shop question`, async () => {
    const money = moneyStatements(await run(route));
    assert.ok(money.length > 0, `${route} ran no money query, so this test proves nothing`);
    // Every money statement is scoped to something, and none of them widen to the whole company:
    // a per-shop balance sheet that pulls in company-level payables does not balance.
    const unscoped = money.filter((sql) => !BRANCH_SCOPED.test(sql));
    assert.deepEqual(unscoped.map((sql) => sql.replace(/\s+/g, " ").slice(0, 120)), []);
    const widened = money.filter((sql) => COMPANY_SCOPED.test(sql));
    assert.deepEqual(
      widened.map((sql) => sql.replace(/\s+/g, " ").slice(0, 120)),
      [],
      `${route} is a per-shop report and must not mix in other shops' money`,
    );
  });
}

test("the two scope shapes are actually distinguishable", () => {
  // If these patterns overlapped, every assertion above would pass for the wrong reason.
  const company = "WHERE branch_id IN (SELECT id FROM branches WHERE company_id = $1)";
  const branch = "WHERE branch_id = $1";
  assert.ok(COMPANY_SCOPED.test(company) && !COMPANY_SCOPED.test(branch));
  assert.ok(BRANCH_SCOPED.test(branch));
});
