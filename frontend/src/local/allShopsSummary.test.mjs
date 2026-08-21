import test from "node:test";
import assert from "node:assert/strict";

import {
  ALL_SHOPS_STATUS,
  allShopsHasFigures,
  resolveAllShopsPresentation,
} from "./allShopsSummary.js";

const shop = (branchId, overrides = {}) => ({
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

const payload = (overrides = {}) => ({
  companyId: 1,
  asAtDate: "2026-08-21",
  branches: [shop(1), shop(2)],
  totals: {
    complete: true,
    branchesLoaded: 2,
    branchesFailed: 0,
    cash: 2000,
    bank: 4000,
    inventory: 10000,
    customerReceivable: 600,
    supplierPayable: 1600,
    netProfit: 800,
    netPosition: 15000,
    salesRevenue: 18000,
    expenses: 1200,
  },
  reconciliation: { companyPayable: 1600, companyReceivable: 600, payableGap: 0, receivableGap: 0, balanced: true },
  ...overrides,
});

const loaded = (body) => resolveAllShopsPresentation({ loadState: "loaded", payload: body });

test("a clean response is ready and carries its totals", () => {
  const view = loaded(payload());
  assert.equal(view.status, ALL_SHOPS_STATUS.READY);
  assert.equal(view.totals.cash, 2000);
  assert.equal(view.shops.length, 2);
  assert.deepEqual(view.warnings, []);
  assert.equal(allShopsHasFigures(view), true);
});

test("offline shows no figures at all, because no device holds another shop's books", () => {
  const view = resolveAllShopsPresentation({ loadState: "loaded", offline: true, payload: payload() });
  assert.equal(view.status, ALL_SHOPS_STATUS.OFFLINE);
  assert.equal(view.totals, null, "offline must not surface stale or partial company figures");
  assert.match(view.message, /connection/i);
});

test("offline wins over a payload that happens to be present", () => {
  // The cached payload could be hours old and is company-wide, so it cannot be revalidated from
  // this device. Showing it while disconnected would present stale money as current.
  const view = resolveAllShopsPresentation({ loadState: "loaded", offline: true, payload: payload() });
  assert.equal(allShopsHasFigures(view), false);
});

test("a failed request never renders figures", () => {
  const view = resolveAllShopsPresentation({ loadState: "error", loadError: "Network down" });
  assert.equal(view.status, ALL_SHOPS_STATUS.ERROR);
  assert.equal(view.totals, null);
  assert.equal(view.message, "Network down");
});

test("loading is not an empty company", () => {
  const view = resolveAllShopsPresentation({ loadState: "loading" });
  assert.equal(view.status, ALL_SHOPS_STATUS.LOADING);
  assert.equal(view.totals, null);
});

test("a malformed reply is an error, not a company worth nothing", () => {
  // The failure this guards: reading totals off a bad body yields undefined, which renders as a
  // blank cell that a reader takes for zero.
  for (const bad of [null, {}, { branches: [] }, { totals: {} }, { branches: "nope", totals: {} }]) {
    const view = loaded(bad);
    assert.equal(view.status, ALL_SHOPS_STATUS.ERROR, `expected error for ${JSON.stringify(bad)}`);
    assert.equal(view.totals, null);
  }
});

test("no shops configured is empty, and still shows no totals", () => {
  const view = loaded(payload({ branches: [], totals: { complete: true, branchesLoaded: 0, branchesFailed: 0 } }));
  assert.equal(view.status, ALL_SHOPS_STATUS.EMPTY);
  assert.equal(view.totals, null);
});

test("a shop that failed is named, kept in the list, and flagged in the totals", () => {
  const view = loaded(payload({
    branches: [shop(1), { branchId: 2, branchName: "Sardarpura", ok: false, error: "timed out" }],
    totals: { complete: false, branchesLoaded: 1, branchesFailed: 1, cash: 1000, supplierPayable: 800 },
  }));
  assert.equal(view.status, ALL_SHOPS_STATUS.PARTIAL);
  assert.equal(view.totals.complete, false);
  assert.equal(view.shops.length, 2, "the failed shop stays visible rather than disappearing");
  assert.equal(view.shops[1].ok, false);
  assert.match(view.warnings[0], /Sardarpura/);
  assert.match(view.warnings[0], /leave them out/);
});

test("the client does not trust its own failure count over the server's", () => {
  // Every shop reports ok, but the server says the totals are short. Believing the shop list would
  // present an incomplete total as complete.
  const view = loaded(payload({ totals: { ...payload().totals, complete: false } }));
  assert.equal(view.status, ALL_SHOPS_STATUS.PARTIAL);
  assert.equal(view.totals.complete, false);
  assert.match(view.warnings[0], /incomplete/i);
});

test("a reconciliation gap is reported with the amount, not just a shrug", () => {
  const view = loaded(payload({
    reconciliation: { companyPayable: 2100, companyReceivable: 600, payableGap: 500, receivableGap: 0, balanced: false },
  }));
  assert.equal(view.status, ALL_SHOPS_STATUS.READY, "the figures are still shown; they just carry a warning");
  assert.equal(view.warnings.length, 1);
  assert.match(view.warnings[0], /500\.00/);
  assert.match(view.warnings[0], /not be linked to any shop/);
});

test("a balanced reconciliation raises nothing", () => {
  assert.deepEqual(loaded(payload()).warnings, []);
});

test("a missing reconciliation block is not treated as a discrepancy", () => {
  // The server omits it when the totals are incomplete. Absence is not evidence of a gap.
  const view = loaded(payload({ reconciliation: null }));
  assert.deepEqual(view.warnings, []);
});

test("a shop reporting a genuine zero is kept as zero", () => {
  // The mirror of the rule: a real zero is data. Only failures are withheld.
  const view = loaded(payload({
    branches: [shop(1, { cash: 0, inventory: 0 })],
    totals: { ...payload().totals, branchesLoaded: 1 },
  }));
  assert.equal(view.status, ALL_SHOPS_STATUS.READY);
  assert.equal(view.shops[0].cash, 0);
  assert.equal(view.shops[0].ok, true);
});

test("non-numeric money from the server reads as zero rather than NaN", () => {
  const view = loaded(payload({ branches: [shop(1, { cash: null, bank: "abc" })] }));
  assert.equal(view.shops[0].cash, 0);
  assert.equal(view.shops[0].bank, 0);
  assert.ok(!Number.isNaN(view.shops[0].bank));
});
