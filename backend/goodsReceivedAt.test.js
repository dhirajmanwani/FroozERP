"use strict";

/**
 * Where a purchase's stock lands.
 *
 * The maintainer's fruit is bought in bulk and delivered to a warehouse, then distributed to the
 * shops (`docs/stock-distribution-decision.md`). Until this change a purchase always landed at the
 * location of the machine that typed it in -- so a purchase manager working from a shop counter put
 * the entire consignment onto that shop's shelf, silently, and the warehouse never saw it.
 *
 * The trap this feature has to survive is `v3WriteAdapter` (`server.js`), which unconditionally
 * overwrites `company_id`, `branch_id` and `operational_location_id` in the request body with the
 * submitting device's own scope. A destination sent under those names is replaced before the
 * handler ever sees it, and the field simply appears to be ignored -- no error, no clue. That is
 * why the destination travels as `destination_branch_id` / `destination_operational_location_id`,
 * and why a test asserts those exact names.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { loadServerApp } = require("./routeAuthCoverage");

loadServerApp();
const { resolveGoodsReceivedAt } = require("./server");

const SOURCE = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

const COMPANY_ID = 1;
const OWN_BRANCH = 4;
const OWN_LOCATION = 40;
const WAREHOUSE_BRANCH = 2;
const WAREHOUSE_LOCATION = 20;

const context = (overrides = {}) => ({
  company_id: COMPANY_ID,
  branch_id: OWN_BRANCH,
  operational_location_id: OWN_LOCATION,
  ...overrides,
});

const entry = (overrides = {}) => ({
  branchId: OWN_BRANCH,
  destinationBranchId: null,
  destinationLocationId: null,
  ...overrides,
});

const scriptedClient = (rows = []) => ({
  statements: [],
  query: async function (text, values) {
    this.statements.push({ sql: String(text).replace(/\s+/g, " ").trim(), values: values || [] });
    return { rows, rowCount: rows.length };
  },
});

test("with no destination named, stock lands where the machine is", async () => {
  // The back-compatibility guarantee. Every purchase entered before this feature existed, and every
  // one entered at the counter that will hold the fruit, must behave exactly as it did.
  const client = scriptedClient();
  const resolved = await resolveGoodsReceivedAt(client, context(), entry());

  assert.equal(resolved.error, undefined);
  assert.equal(resolved.branchId, OWN_BRANCH);
  assert.equal(resolved.locationId, OWN_LOCATION);
  assert.equal(client.statements.length, 0, "the unnamed case must not cost a database round trip");
});

test("a named destination is used, once it has been checked", async () => {
  const client = scriptedClient([{ id: WAREHOUSE_LOCATION, branch_id: WAREHOUSE_BRANCH }]);
  const resolved = await resolveGoodsReceivedAt(client, context(), entry({
    destinationBranchId: WAREHOUSE_BRANCH,
    destinationLocationId: WAREHOUSE_LOCATION,
  }));

  assert.equal(resolved.error, undefined);
  assert.equal(resolved.branchId, WAREHOUSE_BRANCH, "the warehouse, not the counter that typed it in");
  assert.equal(resolved.locationId, WAREHOUSE_LOCATION);

  // Trusting the submitted ids would let any counter write stock into any location in any company.
  const check = client.statements[0];
  assert.match(check.sql, /FROM operational_locations/);
  assert.match(check.sql, /ol\.company_id = \$3/, "the destination must be checked against this company");
  assert.match(check.sql, /ol\.active = TRUE/);
  assert.deepEqual(check.values, [WAREHOUSE_LOCATION, WAREHOUSE_BRANCH, COMPANY_ID]);
});

test("a destination outside this company is refused, not quietly ignored", async () => {
  // The dangerous shape is not the refusal -- it is a silent fallback to the session's own scope,
  // which would put a whole consignment on the wrong shelf while telling the operator it went where
  // they asked. There is no fallback: the purchase is refused.
  const client = scriptedClient([]);
  const resolved = await resolveGoodsReceivedAt(client, context(), entry({
    destinationBranchId: 77,
    destinationLocationId: 770,
  }));

  assert.ok(resolved.error, "an unusable destination must be an error");
  assert.match(resolved.error, /not an active part of this business/);
  assert.equal(resolved.branchId, undefined, "and must not resolve to a usable location");
  assert.equal(resolved.locationId, undefined);
});

test("half a destination is refused too", async () => {
  // A branch with no location would write a lot the pull predicate can never deliver: it would sit
  // in Postgres reaching no device, with nothing anywhere reporting it.
  const client = scriptedClient([]);
  const branchOnly = await resolveGoodsReceivedAt(client, context(), entry({ destinationBranchId: WAREHOUSE_BRANCH }));
  assert.match(branchOnly.error, /both the shop and the counter/);

  const locationOnly = await resolveGoodsReceivedAt(client, context(), entry({ destinationLocationId: WAREHOUSE_LOCATION }));
  assert.match(locationOnly.error, /both the shop and the counter/);
});

test("the destination travels under names v3WriteAdapter does not overwrite", async () => {
  // The whole feature turns on this. `v3WriteAdapter` replaces company_id, branch_id and
  // operational_location_id in the body with the device's own scope, so a destination sent under
  // those names is gone before the handler runs -- and the symptom is a field that appears to be
  // ignored, with no error to follow.
  assert.match(SOURCE, /destinationBranchId: parsePositiveInteger\(body\.destination_branch_id\)/);
  assert.match(SOURCE, /destinationLocationId: parsePositiveInteger\(body\.destination_operational_location_id\)/);

  const adapter = SOURCE.slice(SOURCE.indexOf("const v3WriteAdapter"), SOURCE.indexOf("const v3WriteAdapter") + 1400);
  assert.doesNotMatch(
    adapter,
    /destination_branch_id|destination_operational_location_id/,
    "v3WriteAdapter must not overwrite the destination, or the field is silently discarded",
  );
});

test("both stock-writing paths land at the resolved destination, not the session's", () => {
  // A purchase writes its lot in two places -- the bill-pending arm and the bill-completed arm --
  // and each writes a paired stock_transactions row. Fixing one and not the others would put the
  // lot at the warehouse while the movement history said the shop, which is the summary-vs-detail
  // disagreement CLAUDE.md records.
  const handler = SOURCE.slice(
    SOURCE.indexOf("const createPurchaseBillHandler"),
    SOURCE.indexOf("const createPurchaseBillHandler") + 30000,
  );
  // Exactly eight: two lot inserts and two stock_transactions rows, each naming a branch and a
  // location. Pinned as an equality rather than a floor, because a floor is what let the first
  // version of this test pass while one of the four writes still used the session's scope -- the
  // lot at the warehouse and the movement history at the shop.
  const resolvedWrites = handler.match(/receivedAt\.(branchId|locationId)/g) || [];
  assert.equal(
    resolvedWrites.length,
    8,
    `expected both lot inserts and both stock_transactions rows to name the destination's branch and `
    + `location -- 8 references, found ${resolvedWrites.length}`,
  );

  // And specifically the movement history, which is the half most easily forgotten: the lot is what
  // somebody looks at, the transaction is what reconciles it.
  const movements = handler.match(/INSERT INTO stock_transactions[\s\S]{0,600}?\]\s*\)/g) || [];
  assert.equal(movements.length, 2, "a purchase writes two stock movements; found a different number");
  for (const movement of movements) {
    assert.match(
      movement,
      /receivedAt\.branchId/,
      "a stock movement recorded at the buying counter contradicts the lot it belongs to",
    );
    assert.match(movement, /receivedAt\.locationId/);
  }
  assert.match(handler, /const receivedAt = await resolveGoodsReceivedAt\(/);
  assert.match(handler, /if \(receivedAt\.error\)/, "an unusable destination must refuse the purchase");
});
