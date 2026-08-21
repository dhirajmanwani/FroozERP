"use strict";

/**
 * Which routes actually mention the caller's branch in the SQL they run.
 *
 * ## Why this is a different question from route-auth coverage
 *
 * `routeAuthCoverage.js` answers "did this route demand a session". A-4 made that true for 268 of
 * 285 routes. It says nothing about the question the branch-isolation audit asked: **may this
 * authenticated user of branch A read branch B's data?** A route can be perfectly authenticated and
 * return every branch's rows, and the whole point of the audit's finding is that 119 of them do.
 *
 * ## What this can and cannot prove
 *
 * There is no database in this environment, so nothing here proves isolation *works*. What it does
 * is drive each route with a real signed session and record the SQL the handler issues, then ask
 * whether a statement touching a tenant-owned table carried a `branch_id` or `company_id`
 * predicate. That is evidence about the query, not about the rows.
 *
 * **A route reported SCOPED here could still be wrong** — it might scope by a value the caller
 * supplied rather than by the session. That distinction needs a live two-branch database, and is
 * recorded as still-open rather than quietly claimed. What this catches reliably is the opposite
 * and more common error: a query with no tenancy predicate at all, which cannot be right.
 *
 * The value is the baseline. It turns "119 unscoped routes" from a number in a document into a
 * count that fails a test when it grows, so the remaining work stays visible while it is done.
 */

const {
  loadServerApp,
  listRegisteredRoutes,
  probe,
  startQueryRecording,
  stopQueryRecording,
} = require("./routeAuthCoverage");
const { issueDeviceSession } = require("./deviceSession");

/** Must match the throwaway key `routeAuthCoverage` pins into the environment before loading. */
const TEST_SIGNING_KEY = "route-auth-coverage-isolated-signing-key-000000";

/**
 * Tables whose rows belong to one branch or company.
 *
 * Deliberately a list of *tenant-owned* tables rather than every table: `roles`, `users` and the
 * settings tables are shared or global, and demanding a branch predicate on them would report
 * failures that are not failures. A table missing from this list is simply not asked about, which
 * is the safe direction for a baseline — it under-reports rather than crying wolf.
 */
const TENANT_TABLES = [
  "sales", "sale_items", "sale_returns", "purchases", "purchase_items", "purchase_bills",
  "inventory_batches", "inventory_lots", "customer_payments", "supplier_payments", "expenses",
  "contra_entries", "waste_entries", "customers", "suppliers", "accounts", "stock_movements",
];

const TENANT_TABLE_PATTERN = new RegExp(`\\b(?:from|join|into|update)\\s+"?(?:${TENANT_TABLES.join("|")})"?\\b`, "i");
const SCOPE_PREDICATE_PATTERN = /\b(?:branch_id|company_id|operational_location_id)\b/i;

const session = ({ userId = 7, branchId = 1, companyId = 1 } = {}) => issueDeviceSession({
  userId,
  deviceId: "FZDEV-TENANCY-PROBE",
  companyId,
  branchId,
  role: "Owner",
  secret: TEST_SIGNING_KEY,
});

/** A URL a parameterised route will actually match. Ids are opaque strings, so any token works. */
const probeUrl = (routePath) => routePath.replace(/:[A-Za-z0-9_]+/g, "1");

/**
 * Drive one route and classify the SQL it ran.
 *
 * @returns {{route: string, statements: number, touchedTenantTable: boolean, scoped: boolean}}
 */
const inspectRoute = async (app, method, routePath, token) => {
  startQueryRecording();
  await probe(app, method, probeUrl(routePath), {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  });
  const statements = stopQueryRecording();
  const tenantStatements = statements.filter((sql) => TENANT_TABLE_PATTERN.test(sql));
  return {
    route: `${method} ${routePath}`,
    statements: statements.length,
    touchedTenantTable: tenantStatements.length > 0,
    // Every statement that touches tenant data must carry a scope, not merely one of them.
    scoped: tenantStatements.length > 0 && tenantStatements.every((sql) => SCOPE_PREDICATE_PATTERN.test(sql)),
  };
};

/**
 * Classify every registered GET route.
 *
 * Reads only. A write probe against a stubbed database drives handlers into transaction paths whose
 * failures say more about the stub than about scoping, and the audit already separates the write
 * risk — closed in A-7 steps 1 to 3 — from the read exposure this measures.
 */
const collectTenancyCoverage = async () => {
  const app = loadServerApp();
  const token = session();
  const routes = listRegisteredRoutes(app).filter((entry) => entry.method === "GET");

  const scoped = [];
  const unscoped = [];
  const noTenantData = [];
  for (const { method, path: routePath } of routes) {
    let result;
    try {
      result = await inspectRoute(app, method, routePath, token);
    } catch {
      // A handler that throws before issuing SQL tells us nothing either way; counting it as
      // scoped would be a false pass and as unscoped a false alarm.
      noTenantData.push(`${method} ${routePath}`);
      continue;
    }
    if (!result.touchedTenantTable) noTenantData.push(result.route);
    else if (result.scoped) scoped.push(result.route);
    else unscoped.push(result.route);
  }
  return { scoped, unscoped, noTenantData, total: routes.length };
};

module.exports = {
  SCOPE_PREDICATE_PATTERN,
  TENANT_TABLES,
  TENANT_TABLE_PATTERN,
  collectTenancyCoverage,
  inspectRoute,
};
