"use strict";

/**
 * Moving a customer order from one branch to another.
 *
 * ## Why this file exists
 *
 * `docs/order-routing-decision.md` names one trap, and it is the reason for almost every assertion
 * below. When an order moves from branch A to branch B, **A's devices have already pulled it**. The
 * pull predicate admits a change row only when its `branch_id` matches the pulling device, so a
 * single change row -- scoped to B, announcing the move -- is invisible to A. A's board would go on
 * showing the order as open work for ever, and two branches would each believe they owed the same
 * customer a delivery.
 *
 * So a transfer must write **two** rows: `TRANSFER_OUT` scoped to A and `UPSERT` scoped to B, same
 * version, same transaction. That is not an implementation detail to be tidied up later; it is the
 * whole feature. A future refactor that "simplifies" this into one write is the bug, and these
 * tests are what stands in front of it.
 *
 * ## How it is tested
 *
 * Driven for real against a scripted client, in the style of `customerOrderSync.test.js`, rather
 * than asserted against source text. Every property here -- how many rows, which branch each is
 * scoped to, which location, which version -- is a property of control flow, and a source-text
 * assertion would pass on a version that got the order of the branches wrong.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadServerApp } = require("./routeAuthCoverage");

loadServerApp();
const { transferCustomerOrderBranch } = require("./server");

const COMPANY_ID = 1;
const BRANCH_MAIN = 4;
const BRANCH_RATANADA = 9;
const LOCATION_MAIN = 40;
const LOCATION_RATANADA = 90;

const ORDER_ID = "ORD-2026-08-29-0007";

/**
 * A client that records every statement and answers the ones a test scripts. Anything unscripted
 * answers zero rows, so each test describes only the rows it depends on.
 */
const scriptedClient = (routes = []) => {
  const statements = [];
  return {
    statements,
    query: async (text, values) => {
      const raw = typeof text === "object" && text ? text.text : String(text || "");
      const sql = raw.replace(/\s+/g, " ").trim();
      statements.push({ sql, values: values || [] });
      for (const [pattern, respond] of routes) {
        if (pattern.test(sql)) return typeof respond === "function" ? respond(sql, values) : respond;
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
};

const orderRow = (overrides = {}) => ({
  global_id: ORDER_ID,
  order_no: "ORD-0007",
  company_id: COMPANY_ID,
  branch_id: BRANCH_MAIN,
  taken_at_branch_id: BRANCH_MAIN,
  operational_location_id: LOCATION_MAIN,
  status: "RECEIVED",
  entity_version: 3,
  deleted_at: null,
  ...overrides,
});

/** The default wiring: the order exists at Main, both branches have an active counter. */
const routes = ({ order = orderRow(), branch, locations } = {}) => [
  [/FROM customer_orders WHERE global_id = \$1 FOR UPDATE/, { rows: order ? [order] : [], rowCount: order ? 1 : 0 }],
  [
    /FROM branches WHERE id = \$1/,
    { rows: [branch || { id: BRANCH_RATANADA, branch_name: "Ratanada", company_id: COMPANY_ID, active: true }], rowCount: 1 },
  ],
  [
    /FROM operational_locations/,
    (sql, values) => {
      const branchId = Number(values[1]);
      const table = locations || { [BRANCH_MAIN]: LOCATION_MAIN, [BRANCH_RATANADA]: LOCATION_RATANADA };
      const id = table[branchId];
      return { rows: id ? [{ id }] : [], rowCount: id ? 1 : 0 };
    },
  ],
  [/UPDATE customer_orders/, { rows: [{ ...orderRow(), branch_id: BRANCH_RATANADA, entity_version: 4 }], rowCount: 1 }],
  [/FROM customer_order_items/, { rows: [{ line_index: 0, product_name: "Alphonso", quantity: "4.000" }], rowCount: 1 }],
  [/INSERT INTO sync_change_log/, { rows: [{ change_id: 900, created_at: "2026-08-29T09:00:00.000Z" }], rowCount: 1 }],
];

const changeLogWrites = (client) =>
  client.statements
    .filter((entry) => /INSERT INTO sync_change_log/.test(entry.sql))
    // logSyncChange's parameter order: branchId, operationalLocationId, assignmentGeneration,
    // entityType, entityId, operationType, version, payload.
    .map(({ values }) => ({
      branchId: values[0],
      locationId: values[1],
      entityType: values[3],
      entityId: values[4],
      operationType: values[5],
      version: values[6],
      payload: JSON.parse(values[7]),
    }));

test("a transfer writes two change-log rows, one for each branch", async () => {
  // The central claim of the whole feature. If this ever asserts one row, an order has been left
  // open on the losing branch's board with nothing anywhere to say so.
  const client = scriptedClient(routes());
  const result = await transferCustomerOrderBranch(client, {
    orderGlobalId: ORDER_ID,
    companyId: COMPANY_ID,
    toBranchId: BRANCH_RATANADA,
    actorUserId: 7,
  });

  assert.equal(result.ok, true, result.message);
  const writes = changeLogWrites(client);
  assert.equal(writes.length, 2, `expected two change rows, saw ${writes.length}`);

  const [out, upsert] = writes;
  assert.equal(out.operationType, "TRANSFER_OUT");
  assert.equal(out.branchId, BRANCH_MAIN, "the removal must be scoped to the branch losing the order");
  assert.equal(out.locationId, LOCATION_MAIN, "scoped to a location the losing branch's devices pull on");
  assert.equal(upsert.operationType, "UPSERT");
  assert.equal(upsert.branchId, BRANCH_RATANADA, "the arrival must be scoped to the branch gaining it");
  assert.equal(upsert.locationId, LOCATION_RATANADA);

  assert.equal(out.entityId, ORDER_ID);
  assert.equal(upsert.entityId, ORDER_ID);
  assert.equal(out.entityType, "customer_order");
  assert.equal(upsert.entityType, "customer_order");
});

test("both rows carry the same version, and it is one past the stored one", async () => {
  // Different versions would let the two devices disagree about which copy is newer, and the
  // version guard on each device would then resolve the same move two different ways.
  const client = scriptedClient(routes());
  await transferCustomerOrderBranch(client, {
    orderGlobalId: ORDER_ID,
    companyId: COMPANY_ID,
    toBranchId: BRANCH_RATANADA,
  });

  const writes = changeLogWrites(client);
  assert.equal(writes[0].version, 4, "stored version was 3");
  assert.equal(writes[1].version, writes[0].version);
});

test("the losing branch is told where the order went, not that it was deleted", async () => {
  // "Cancelled" and "now Ratanada's" are different facts, and a counter told the wrong one rings
  // the wrong customer. The operation type is not DELETE, and the payload names the destination.
  const client = scriptedClient(routes());
  await transferCustomerOrderBranch(client, {
    orderGlobalId: ORDER_ID,
    companyId: COMPANY_ID,
    toBranchId: BRANCH_RATANADA,
    actorUserId: 7,
    note: "customer lives beside Ratanada",
  });

  const [out] = changeLogWrites(client);
  assert.notEqual(out.operationType, "DELETE");
  assert.equal(out.payload.transferred_to_branch_id, BRANCH_RATANADA);
  assert.equal(out.payload.transferred_to_branch_name, "Ratanada");
  assert.equal(out.payload.transfer_note, "customer lives beside Ratanada");
});

test("assigning an unassigned order writes one row, because there is nobody to tell", async () => {
  const client = scriptedClient(routes({ order: orderRow({ branch_id: null, operational_location_id: null }) }));
  const result = await transferCustomerOrderBranch(client, {
    orderGlobalId: ORDER_ID,
    companyId: COMPANY_ID,
    toBranchId: BRANCH_RATANADA,
  });

  assert.equal(result.ok, true, result.message);
  assert.equal(result.movedFrom, null);
  const writes = changeLogWrites(client);
  assert.equal(writes.length, 1, "an unassigned order has no old branch to send a removal to");
  assert.equal(writes[0].operationType, "UPSERT");
  assert.equal(writes[0].branchId, BRANCH_RATANADA);
});

test("a destination with no active counter is refused before anything is written", async () => {
  // A change row scoped to a location that does not exist is pulled by nobody. The order would
  // leave the old board and never reach the new one, with no error raised anywhere -- the silent
  // loss this codebase keeps having to design against.
  const client = scriptedClient(routes({ locations: { [BRANCH_MAIN]: LOCATION_MAIN } }));
  const result = await transferCustomerOrderBranch(client, {
    orderGlobalId: ORDER_ID,
    companyId: COMPANY_ID,
    toBranchId: BRANCH_RATANADA,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "DESTINATION_UNREACHABLE");
  assert.match(result.message, /counter/i);
  assert.equal(changeLogWrites(client).length, 0, "nothing may be written when the move cannot be delivered");
  assert.equal(
    client.statements.filter((entry) => /UPDATE customer_orders/.test(entry.sql)).length,
    0,
    "and the order must not have been moved either",
  );
});

test("an origin with no reachable counter is refused, rather than stranding the order on two boards", async () => {
  // A row written before operational locations existed: it has a branch but no location of its
  // own, and its branch has no active counter to fall back to either.
  const client = scriptedClient(routes({
    order: orderRow({ operational_location_id: null }),
    locations: { [BRANCH_RATANADA]: LOCATION_RATANADA },
  }));
  const result = await transferCustomerOrderBranch(client, {
    orderGlobalId: ORDER_ID,
    companyId: COMPANY_ID,
    toBranchId: BRANCH_RATANADA,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "ORIGIN_UNREACHABLE");
  assert.equal(changeLogWrites(client).length, 0);
});

test("a finished order is not handed over", async () => {
  for (const status of ["DELIVERED", "CANCELLED", "RETURNED"]) {
    const client = scriptedClient(routes({ order: orderRow({ status }) }));
    const result = await transferCustomerOrderBranch(client, {
      orderGlobalId: ORDER_ID,
      companyId: COMPANY_ID,
      toBranchId: BRANCH_RATANADA,
    });
    assert.equal(result.ok, false, `${status} should not be transferable`);
    assert.equal(result.code, "CONFLICT");
    assert.equal(changeLogWrites(client).length, 0);
  }
});

test("moving an order to the branch already holding it changes nothing", async () => {
  const client = scriptedClient(routes());
  const result = await transferCustomerOrderBranch(client, {
    orderGlobalId: ORDER_ID,
    companyId: COMPANY_ID,
    toBranchId: BRANCH_MAIN,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "NO_CHANGE");
  assert.equal(changeLogWrites(client).length, 0, "a no-op must not bump the version or wake every device");
});

test("an order belonging to another company is answered as missing", async () => {
  // Confirming that an id exists in someone else's company is itself a disclosure, so the answer
  // is deliberately the same one a genuinely unknown id gets.
  const client = scriptedClient(routes({ order: orderRow({ company_id: 77 }) }));
  const result = await transferCustomerOrderBranch(client, {
    orderGlobalId: ORDER_ID,
    companyId: COMPANY_ID,
    toBranchId: BRANCH_RATANADA,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "NOT_FOUND");
  assert.match(result.message, /no longer exists/);
});

test("a branch in another company cannot be made the destination", async () => {
  const client = scriptedClient(
    routes({ branch: { id: BRANCH_RATANADA, branch_name: "Someone else's shop", company_id: 77, active: true } }),
  );
  const result = await transferCustomerOrderBranch(client, {
    orderGlobalId: ORDER_ID,
    companyId: COMPANY_ID,
    toBranchId: BRANCH_RATANADA,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "NOT_FOUND");
  assert.equal(changeLogWrites(client).length, 0);
});

test("the order row is locked before it is read", async () => {
  // Two people moving the same order to two different branches at the same moment would otherwise
  // each read version 3, each write version 4, and one of the two destinations would be told
  // nothing at all.
  const client = scriptedClient(routes());
  await transferCustomerOrderBranch(client, {
    orderGlobalId: ORDER_ID,
    companyId: COMPANY_ID,
    toBranchId: BRANCH_RATANADA,
  });

  const read = client.statements.find((entry) => /FROM customer_orders WHERE global_id/.test(entry.sql));
  assert.ok(read, "the order is never read");
  assert.match(read.sql, /FOR UPDATE/);
});

test("the stale assignment generation is cleared on the way out", async () => {
  // It describes a device assignment at the old branch and means nothing at the new one; left in
  // place it would attach a scope from the wrong branch to every future change for this order.
  const client = scriptedClient(routes());
  await transferCustomerOrderBranch(client, {
    orderGlobalId: ORDER_ID,
    companyId: COMPANY_ID,
    toBranchId: BRANCH_RATANADA,
  });

  const update = client.statements.find((entry) => /UPDATE customer_orders/.test(entry.sql));
  assert.match(update.sql, /assignment_generation = NULL/);
});

test("the arriving branch is sent the order's lines, not just its header", async () => {
  // The receiving device packs from these. An upsert carrying no items would arrive as an order
  // for nothing.
  const client = scriptedClient(routes());
  await transferCustomerOrderBranch(client, {
    orderGlobalId: ORDER_ID,
    companyId: COMPANY_ID,
    toBranchId: BRANCH_RATANADA,
  });

  const [, upsert] = changeLogWrites(client);
  assert.ok(Array.isArray(upsert.payload.items), "the upsert payload carries no items array");
  assert.equal(upsert.payload.items.length, 1);
  assert.equal(upsert.payload.items[0].product_name, "Alphonso");
});
