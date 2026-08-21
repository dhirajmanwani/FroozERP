"use strict";

/**
 * Adding up several shops without lying about the ones that failed.
 *
 * `GET /api/owner/all-branches-summary` loads each shop's balance-sheet snapshot separately, so any
 * one of them can fail on its own. The dangerous thing to do at that point is sum whatever came
 * back and present it as the company position: a shop whose figures errored then looks exactly like
 * a shop that did no business, and the total is quietly short by however much that shop was worth.
 * CLAUDE.md states the rule this breaks — a failed load must never render as a zero.
 *
 * So the arithmetic lives here, out of the route, where it can be tested against a failed branch
 * without needing a database to fail.
 */

const MONEY_KEYS = Object.freeze([
  "cash",
  "bank",
  "inventory",
  "customerReceivable",
  "supplierPayable",
  "netProfit",
  "netPosition",
  "salesRevenue",
  "expenses",
]);

/** A shop-level rounding difference is not a discrepancy; a rupee or more is. */
const RECONCILIATION_TOLERANCE = 1;

const round = (value) => Math.round((Number(value) || 0) * 100) / 100;

/**
 * Totals across the shops that loaded, plus an honest account of the ones that did not.
 *
 * `complete` is the contract with the client: when it is false the figures are a partial sum and
 * must be presented as such. It is not advisory — a caller that ignores it is displaying a wrong
 * number with no warning on it.
 */
const summariseBranches = (branches = []) => {
  const rows = Array.isArray(branches) ? branches : [];
  const loaded = rows.filter((branch) => branch && branch.ok === true);
  const failed = rows.filter((branch) => !branch || branch.ok !== true);
  const totals = {
    complete: rows.length > 0 && failed.length === 0,
    branchesLoaded: loaded.length,
    branchesFailed: failed.length,
  };
  for (const key of MONEY_KEYS) {
    totals[key] = round(loaded.reduce((sum, branch) => sum + (Number(branch[key]) || 0), 0));
  }
  return totals;
};

/**
 * Does the sum of the shops match the company asked directly?
 *
 * Every purchase and every sale belongs to exactly one branch, so these two figures are computed
 * from the same rows by two different routes and must agree. When they do not, a row has a NULL or
 * a foreign `branch_id` and is being counted once but not the other way. That is a real data
 * problem and it is surfaced, not smoothed over: a total that silently disagrees with its own
 * breakdown is the failure this codebase has already been bitten by.
 *
 * Returns null when the branch totals are incomplete — comparing a known-short sum against a
 * complete one would report a discrepancy that is really just the missing shop.
 */
const reconcileCompanyTotals = ({ totals, companyPayable, companyReceivable } = {}) => {
  if (!totals || totals.complete !== true) return null;
  const payableGap = round(Number(companyPayable || 0) - Number(totals.supplierPayable || 0));
  const receivableGap = round(Number(companyReceivable || 0) - Number(totals.customerReceivable || 0));
  return {
    companyPayable: round(companyPayable),
    companyReceivable: round(companyReceivable),
    payableGap,
    receivableGap,
    balanced: Math.abs(payableGap) <= RECONCILIATION_TOLERANCE
      && Math.abs(receivableGap) <= RECONCILIATION_TOLERANCE,
  };
};

module.exports = {
  MONEY_KEYS,
  RECONCILIATION_TOLERANCE,
  reconcileCompanyTotals,
  summariseBranches,
};
