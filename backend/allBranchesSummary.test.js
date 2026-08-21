"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MONEY_KEYS,
  RECONCILIATION_TOLERANCE,
  reconcileCompanyTotals,
  summariseBranches,
} = require("./allBranchesSummary");

const branch = (branchId, overrides = {}) => ({
  branchId,
  branchName: `Shop ${branchId}`,
  ok: true,
  cash: 1000,
  bank: 2000,
  inventory: 5000,
  customerReceivable: 300,
  supplierPayable: 800,
  netProfit: 400,
  netPosition: 7500,
  salesRevenue: 9000,
  expenses: 600,
  ...overrides,
});

test("totals add the shops up", () => {
  const totals = summariseBranches([branch(1), branch(2)]);
  assert.equal(totals.cash, 2000);
  assert.equal(totals.inventory, 10000);
  assert.equal(totals.supplierPayable, 1600);
  assert.equal(totals.complete, true);
  assert.equal(totals.branchesLoaded, 2);
  assert.equal(totals.branchesFailed, 0);
});

test("a shop that failed to load is excluded and the total is marked incomplete", () => {
  // The whole reason this module exists. Silently summing the survivors would report 1,000 of cash
  // for a business holding 2,000 and give the reader nothing to notice.
  const totals = summariseBranches([branch(1), { branchId: 2, ok: false, error: "boom" }]);
  assert.equal(totals.cash, 1000);
  assert.equal(totals.complete, false, "a partial sum must never be presented as complete");
  assert.equal(totals.branchesLoaded, 1);
  assert.equal(totals.branchesFailed, 1);
});

test("no shops at all is not 'complete with nothing in it'", () => {
  // An empty list means the load produced nothing, not that the company is worth zero.
  const totals = summariseBranches([]);
  assert.equal(totals.complete, false);
  for (const key of MONEY_KEYS) assert.equal(totals[key], 0);
});

test("a malformed row counts as failed rather than being skipped quietly", () => {
  const totals = summariseBranches([branch(1), null, { branchId: 3 }]);
  assert.equal(totals.branchesFailed, 2);
  assert.equal(totals.complete, false);
});

test("missing money fields on a loaded shop read as zero, not NaN", () => {
  // A zero here is correct — the shop loaded and reported nothing for that line. NaN would
  // propagate into every total and render as a blank, which reads as "no data" for all shops.
  const totals = summariseBranches([branch(1, { cash: undefined, bank: null })]);
  assert.equal(totals.cash, 0);
  assert.equal(totals.bank, 0);
  assert.equal(totals.inventory, 5000);
});

test("reconciliation agrees when the shops sum to the company figure", () => {
  const totals = summariseBranches([branch(1), branch(2)]);
  const result = reconcileCompanyTotals({ totals, companyPayable: 1600, companyReceivable: 600 });
  assert.equal(result.balanced, true);
  assert.equal(result.payableGap, 0);
  assert.equal(result.receivableGap, 0);
});

test("reconciliation reports a real gap instead of hiding it", () => {
  // A purchase with a NULL branch_id is counted once at company scope and never at shop scope.
  const totals = summariseBranches([branch(1), branch(2)]);
  const result = reconcileCompanyTotals({ totals, companyPayable: 2100, companyReceivable: 600 });
  assert.equal(result.balanced, false);
  assert.equal(result.payableGap, 500);
});

test("sub-rupee rounding is not reported as a discrepancy", () => {
  const totals = summariseBranches([branch(1), branch(2)]);
  const result = reconcileCompanyTotals({
    totals,
    companyPayable: 1600 + RECONCILIATION_TOLERANCE,
    companyReceivable: 600,
  });
  assert.equal(result.balanced, true);
});

test("reconciliation is refused when the shop totals are incomplete", () => {
  // Comparing a known-short sum against a complete company figure would report the missing shop as
  // a data discrepancy, sending the reader after a problem that does not exist.
  const totals = summariseBranches([branch(1), { branchId: 2, ok: false, error: "boom" }]);
  assert.equal(reconcileCompanyTotals({ totals, companyPayable: 1600, companyReceivable: 600 }), null);
});

/**
 * The route itself: who is allowed to ask the company-wide question.
 *
 * These drive the real app with a real signed token against the stubbed database, which is enough
 * to prove the one property that matters most here — that a token *claiming* Owner does not open
 * this door on its own.
 */

const {
  loadServerApp,
  probe,
  startQueryRecording,
  stopQueryRecording,
} = require("./routeAuthCoverage");
const { issueDeviceSession } = require("./deviceSession");

/** Must match the throwaway key `routeAuthCoverage` pins into the environment before loading. */
const TEST_SIGNING_KEY = "route-auth-coverage-isolated-signing-key-000000";
const ROUTE = "/api/owner/all-branches-summary";

let app;
/**
 * Drive the route and hand back both the response and the SQL it ran.
 *
 * Recording has to be on around the probe: the stubbed storage adapter only answers queries while
 * it is recording, and rejects them otherwise. Without it the handler's first read throws and every
 * assertion below sees a 500 — a green-looking failure that would say nothing about authorisation.
 */
const ask = async (headers) => {
  if (!app) app = loadServerApp();
  startQueryRecording();
  const response = await probe(app, "GET", ROUTE, { "content-type": "application/json", ...headers });
  return { response, statements: stopQueryRecording() };
};

test("an anonymous caller cannot read every shop's money", async () => {
  const { response } = await ask({});
  assert.equal(response.status, 401);
});

test("a token that claims Owner is not by itself proof of being Owner", async () => {
  // The point of the whole route guard. This token is genuinely signed and its role claim says
  // "Owner", and the route still refuses, because it asks the database who this user is *now*. A
  // token minted before a demotion would otherwise keep working until it expired.
  const token = issueDeviceSession({
    userId: 7,
    deviceId: "FZDEV-OWNER-CLAIM",
    companyId: 1,
    branchId: 1,
    role: "Owner",
    secret: TEST_SIGNING_KEY,
  });
  const { response } = await ask({ authorization: `Bearer ${token}` });
  assert.equal(response.status, 403);
  assert.equal(response.code, "OWNER_ONLY");
});

test("the role check reads the database rather than the token claim", async () => {
  // Guards the mechanism, not just the outcome: a future refactor that "simplifies" this to
  // req.auth.normalizedRole === "OWNER" would still return 403 above under the stub, and would
  // silently reintroduce the stale-token hole. This fails instead.
  const token = issueDeviceSession({
    userId: 7,
    deviceId: "FZDEV-OWNER-CLAIM",
    companyId: 1,
    branchId: 1,
    role: "Owner",
    secret: TEST_SIGNING_KEY,
  });
  const { statements } = await ask({ authorization: `Bearer ${token}` });
  const roleLookup = statements.filter((sql) => /FROM\s+users\s+u\s+JOIN\s+roles\s+r/i.test(sql));
  assert.ok(roleLookup.length > 0, "the route must resolve the caller's role from the database");
});
