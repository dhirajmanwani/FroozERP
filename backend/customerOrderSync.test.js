"use strict";

/**
 * Customer orders travelling, and the sync dispatch that carries them.
 *
 * Two things are proved here, and they are related.
 *
 * ## The dispatch
 *
 * `processSyncOperation` used to branch on `entity_type === "sync_test"` and then fall through to
 * the POS sale handlers for everything else, with `processPosSaleFoundationOperation` as the final
 * else. A customer order reaching that would be rejected as a malformed invoice - and a rejection
 * is stored by `storeProcessedOperation` under its operation id and replayed verbatim on every
 * retry, because the replay check returns a stored acknowledgement without re-running anything.
 * The order would be poisoned forever, and the retry that should fix it re-sends the same id and
 * gets the same refusal. So the dispatch is keyed on `entity_type` and refuses an unrouted one by
 * name; each handler is identified below by the refusal only it can produce.
 *
 * ## The order handler
 *
 * Driven for real against a scripted client rather than asserted against the source text, because
 * every property here - which branch is stored, which version wins, whether a second write happens
 * - is a property of control flow. A source-text assertion would pass on a version that ordered the
 * branches wrongly, and it stops testing anything at all the day something is renamed. The pos_sale
 * apply path has no behavioural test for exactly that reason; this one is not being added the same
 * way.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  loadServerApp,
  probe,
  setConnectionResponder,
  clearConnectionResponder,
} = require("./routeAuthCoverage");
const { issueDeviceSession } = require("./deviceSession");

// Loads server.js inside the sandbox (stubbed database, blocked egress, no listen). Must happen
// before server.js is required for its exports.
const app = loadServerApp();
const {
  SYNC_ENTITY_TYPES,
  processSyncOperation,
  processCustomerOrderOperation,
} = require("./server");

/** Must match the throwaway key `routeAuthCoverage` pins into the environment before loading. */
const TEST_SIGNING_KEY = "route-auth-coverage-isolated-signing-key-000000";

const SESSION_BRANCH_ID = 4;
const PAYLOAD_BRANCH_ID = 99;

const context = () => ({
  user: { id: 7, full_name: "Counter Staff" },
  device: { device_id: "FZDEV-ORDERS", status: "APPROVED" },
  branch: { id: SESSION_BRANCH_ID, company_id: 1, active: true },
  companyId: 1,
  branchId: SESSION_BRANCH_ID,
  deviceId: "FZDEV-ORDERS",
  operationalLocationId: null,
  assignmentGeneration: null,
});

/**
 * A client that records every statement and answers the ones a test scripts.
 *
 * Anything unscripted answers zero rows, so a handler runs on past reads it does not depend on and
 * the test only has to describe the rows that matter.
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

const statementsMatching = (client, pattern) => client.statements.filter((entry) => pattern.test(entry.sql));
const oneStatement = (client, pattern) => {
  const found = statementsMatching(client, pattern);
  assert.equal(found.length, 1, `expected exactly one statement matching ${pattern}, saw ${found.length}`);
  return found[0];
};

const NO_REPLAY = [/FROM sync_processed_operations/, { rows: [], rowCount: 0 }];
const STORE_ACK = [/INSERT INTO sync_processed_operations/, { rows: [], rowCount: 0 }];

/** The row `RETURNING *` hands back after a successful upsert. */
const storedOrderRow = (overrides = {}) => ({
  id: 11,
  global_id: "ORD-2026-08-27-0001",
  order_no: "ORD-0001",
  status: "PACKED",
  company_id: 1,
  branch_id: SESSION_BRANCH_ID,
  entity_version: 3,
  updated_at: "2026-08-27T06:05:00.000Z",
  ...overrides,
});

const CHANGE_LOG_ROW = {
  rows: [{ change_id: 501, created_at: "2026-08-27T06:05:01.000Z" }],
  rowCount: 1,
};

const orderPayload = (overrides = {}) => ({
  id: "ORD-2026-08-27-0001",
  order_no: "ORD-0001",
  source: "WHATSAPP",
  // The session is scoped to branch 4. This is the payload trying to say otherwise.
  branch_id: PAYLOAD_BRANCH_ID,
  company_id: 77,
  created_by: "someone-else",
  customer_id: "004",
  customer_name: "Rekha Traders",
  customer_mobile: "9876543210",
  delivery_address: "12 Mandi Road",
  status: "PACKED",
  reserved_at: "2026-08-27T05:30:00.000Z",
  packed_at: "2026-08-27T06:00:00.000Z",
  items: [
    {
      id: "ORD-ITEM-1",
      line_index: 0,
      // "004" and 4 are different products. Both are sent, and both must survive as strings.
      product_id: "004",
      product_name: "Alphonso",
      unit: "KG",
      quantity: 2.5005,
      agreed_rate: 80,
    },
    {
      id: "ORD-ITEM-2",
      line_index: 1,
      product_id: "4",
      product_name: "Banana",
      unit: "DOZEN",
      quantity: 3,
      // A legitimately zero rate: a free replacement box. It must stay 0, not become "no rate".
      agreed_rate: 0,
    },
  ],
  ...overrides,
});

const orderOperation = (overrides = {}) => ({
  operation_id: "OP-ORDER-0001",
  entity_type: "customer_order",
  entity_id: "ORD-2026-08-27-0001",
  operation_type: "UPSERT",
  version: 3,
  payload: orderPayload(),
  ...overrides,
});

// ---------------------------------------------------------------------------------------------
// The dispatch
// ---------------------------------------------------------------------------------------------

test("customer_order is a registered sync entity type", () => {
  assert.ok(SYNC_ENTITY_TYPES.has("customer_order"));
  assert.ok(SYNC_ENTITY_TYPES.has("pos_sale"));
  assert.ok(SYNC_ENTITY_TYPES.has("sync_test"));
});

test("each entity type reaches its own handler and no other", async () => {
  // Every handler is identified by a refusal only it can produce, so no database is needed to see
  // which one ran.
  const cases = [
    {
      name: "sync_test",
      operation: { operation_id: "OP-A", entity_type: "sync_test", entity_id: "T-1", operation_type: "UPSERT", payload: {} },
      expected: /sync_test\.value is required/,
    },
    {
      name: "pos_sale",
      operation: { operation_id: "OP-B", entity_type: "pos_sale", entity_id: "INV-1", operation_type: "UPSERT", payload: {} },
      expected: /POS sale requires invoice_global_id and offline_invoice_ref/,
    },
    {
      name: "customer_order",
      operation: { operation_id: "OP-C", entity_type: "customer_order", entity_id: "ORD-1", operation_type: "UPSERT", payload: {} },
      expected: /Customer order requires customer_name/,
    },
  ];
  for (const { name, operation, expected } of cases) {
    const client = scriptedClient([NO_REPLAY, STORE_ACK]);
    const ack = await processSyncOperation(client, operation, context());
    assert.match(ack.message, expected, `${name} did not reach its own handler: ${ack.message}`);
  }
});

test("a customer order is never handed to the POS sale handler", async () => {
  // The bug this file exists for: before the dispatch was re-keyed, anything that was not
  // sync_test fell through to the sale handlers, and the resulting rejection would be stored
  // against the operation id permanently.
  const client = scriptedClient([NO_REPLAY, STORE_ACK]);
  const ack = await processSyncOperation(client, orderOperation({ payload: {} }), context());
  assert.equal(ack.status, "rejected");
  assert.doesNotMatch(ack.message, /invoice/i);
  assert.equal(statementsMatching(client, /FROM sales/).length, 0);
});

test("an unrouted entity type is rejected by name, not by falling through", async () => {
  const client = scriptedClient([NO_REPLAY, STORE_ACK]);
  const ack = await processSyncOperation(
    client,
    { operation_id: "OP-D", entity_type: "vendor_invoice", entity_id: "V-1", operation_type: "UPSERT", payload: {} },
    context()
  );
  assert.equal(ack.status, "rejected");
  assert.equal(ack.error_code, "UNSUPPORTED_ENTITY");
  assert.match(ack.message, /vendor_invoice/);
  // Nothing reached a handler, so nothing was written.
  assert.equal(statementsMatching(client, /INSERT INTO/).length, 0);
});

test("SALE_EDIT and SALE_CANCEL still route inside the pos_sale branch", async () => {
  const client = scriptedClient([NO_REPLAY, STORE_ACK]);
  const editAck = await processSyncOperation(
    client,
    { operation_id: "OP-E", entity_type: "pos_sale", entity_id: "INV-2", operation_type: "SALE_EDIT", payload: {} },
    context()
  );
  assert.match(editAck.message, /Offline sale edit requires a reason/);

  const cancelAck = await processSyncOperation(
    client,
    { operation_id: "OP-F", entity_type: "pos_sale", entity_id: "INV-3", operation_type: "SALE_CANCEL", payload: {} },
    context()
  );
  // The cancel handler checks the user's permission before it looks at the payload, so its own
  // refusal is the one that identifies it.
  assert.match(cancelAck.message, /not allowed to cancel sales/);
});

// ---------------------------------------------------------------------------------------------
// The order handler
// ---------------------------------------------------------------------------------------------

test("an order UPSERT is accepted, stored and logged for the other devices", async () => {
  const client = scriptedClient([
    NO_REPLAY,
    STORE_ACK,
    [/FROM customer_orders WHERE global_id/, { rows: [], rowCount: 0 }],
    [/INSERT INTO customer_orders/, { rows: [storedOrderRow()], rowCount: 1 }],
    [/INSERT INTO sync_change_log/, CHANGE_LOG_ROW],
  ]);
  const ack = await processSyncOperation(client, orderOperation(), context());

  assert.equal(ack.status, "accepted");
  assert.equal(ack.error_code, null);
  assert.equal(ack.server_entity_version, 3);
  assert.deepEqual(ack.result_payload, {
    entity_type: "customer_order",
    order_id: "ORD-2026-08-27-0001",
    order_no: "ORD-0001",
    status: "PACKED",
    entity_version: 3,
    duplicate: false,
  });

  const change = oneStatement(client, /INSERT INTO sync_change_log/);
  assert.equal(change.values[0], SESSION_BRANCH_ID);
  assert.equal(change.values[3], "customer_order");
  assert.equal(change.values[4], "ORD-2026-08-27-0001");
  assert.equal(change.values[5], "UPSERT");
  assert.equal(change.values[6], 3);
});

test("the order is scoped to the session, never to the branch named in the payload", async () => {
  const client = scriptedClient([
    NO_REPLAY,
    STORE_ACK,
    [/FROM customer_orders WHERE global_id/, { rows: [], rowCount: 0 }],
    [/INSERT INTO customer_orders/, { rows: [storedOrderRow()], rowCount: 1 }],
    [/INSERT INTO sync_change_log/, CHANGE_LOG_ROW],
  ]);
  await processSyncOperation(client, orderOperation(), context());

  const insert = oneStatement(client, /INSERT INTO customer_orders/);
  // Positional, in the order the column list declares: company_id is $4, branch_id $5,
  // created_by $26, source_device_id $27, entity_version $28.
  assert.equal(insert.values[3], 1, "company_id must come from the verified context");
  assert.equal(insert.values[4], SESSION_BRANCH_ID, "branch_id must come from the verified context");
  assert.equal(insert.values[25], 7, "created_by must be the session user");
  assert.equal(insert.values[26], "FZDEV-ORDERS", "source_device_id must be the session device");
  assert.equal(insert.values[27], 3);
  assert.ok(!insert.values.includes(PAYLOAD_BRANCH_ID), "the payload's branch_id must not be stored");
  assert.ok(!insert.values.includes(77), "the payload's company_id must not be stored");
});

test("order lines keep opaque ids, three-decimal quantities and a real zero rate", async () => {
  const client = scriptedClient([
    NO_REPLAY,
    STORE_ACK,
    [/FROM customer_orders WHERE global_id/, { rows: [], rowCount: 0 }],
    [/INSERT INTO customer_orders/, { rows: [storedOrderRow()], rowCount: 1 }],
    [/INSERT INTO sync_change_log/, CHANGE_LOG_ROW],
  ]);
  await processSyncOperation(client, orderOperation(), context());

  // The whole record replaces the whole record: the old lines go, the new ones land.
  oneStatement(client, /DELETE FROM customer_order_items/);
  const lines = statementsMatching(client, /INSERT INTO customer_order_items/);
  assert.equal(lines.length, 2);

  // $1 order_global_id, $2 global_id, $3 line_index, $4 product_global_id, $5 product_name,
  // $6 unit, $7 quantity, $8 agreed_rate, $9 line_amount, $10 inventory_lot_global_id.
  const [first, second] = lines;
  assert.strictEqual(first.values[3], "004");
  assert.strictEqual(second.values[3], "4", "\"004\" and 4 are different products and stay different");
  assert.equal(first.values[6], 2.501, "quantities carry three decimals");
  assert.equal(first.values[7], 80);
  assert.equal(first.values[8], 200.08, "money rounds once per line");
  // The `??` trap: a zero rate is a rate. It must not be read as "no rate agreed".
  assert.strictEqual(second.values[7], 0);
  assert.strictEqual(second.values[8], 0);
});

test("a line with no agreed rate has no amount - null, never zero", async () => {
  const client = scriptedClient([
    NO_REPLAY,
    STORE_ACK,
    [/FROM customer_orders WHERE global_id/, { rows: [], rowCount: 0 }],
    [/INSERT INTO customer_orders/, { rows: [storedOrderRow()], rowCount: 1 }],
    [/INSERT INTO sync_change_log/, CHANGE_LOG_ROW],
  ]);
  const payload = orderPayload({
    items: [{ line_index: 0, product_id: "004", product_name: "Alphonso", quantity: 1 }],
  });
  await processSyncOperation(client, orderOperation({ payload }), context());

  const line = oneStatement(client, /INSERT INTO customer_order_items/);
  assert.strictEqual(line.values[7], null, "no agreed rate");
  assert.strictEqual(line.values[8], null, "and therefore no amount - zero would read as free");
});

test("a replay of the same operation id is answered from the stored acknowledgement", async () => {
  const client = scriptedClient([
    [/FROM sync_processed_operations/, {
      rows: [{
        operation_id: "OP-ORDER-0001",
        result_status: "accepted",
        result_payload: { server_entity_version: 3, server_updated_at: "2026-08-27T06:05:01.000Z" },
        processed_at: "2026-08-27T06:05:01.000Z",
      }],
      rowCount: 1,
    }],
    STORE_ACK,
    [/INSERT INTO customer_orders/, { rows: [storedOrderRow()], rowCount: 1 }],
    [/INSERT INTO sync_change_log/, CHANGE_LOG_ROW],
  ]);
  const ack = await processSyncOperation(client, orderOperation(), context());

  assert.equal(ack.status, "accepted");
  assert.equal(ack.server_entity_version, 3);
  // The point of the replay check: the order is not written a second time and no second change-log
  // row goes out to the other devices.
  assert.equal(statementsMatching(client, /customer_orders/).length, 0);
  assert.equal(statementsMatching(client, /customer_order_items/).length, 0);
  assert.equal(statementsMatching(client, /INSERT INTO sync_change_log/).length, 0);
});

test("a lower incoming version does not overwrite a newer stored order", async () => {
  const client = scriptedClient([
    NO_REPLAY,
    STORE_ACK,
    [/FROM customer_orders WHERE global_id/, {
      rows: [storedOrderRow({ entity_version: 5, status: "SENT" })],
      rowCount: 1,
    }],
    [/INSERT INTO customer_orders/, { rows: [storedOrderRow()], rowCount: 1 }],
    [/INSERT INTO sync_change_log/, CHANGE_LOG_ROW],
  ]);
  const ack = await processSyncOperation(client, orderOperation({ version: 2, operation_id: "OP-ORDER-OLD" }), context());

  // Accepted, not rejected: an echo is normal traffic, and a rejection would be stored forever.
  assert.equal(ack.status, "accepted");
  assert.equal(ack.server_entity_version, 5);
  assert.equal(ack.result_payload.duplicate, true);
  assert.equal(ack.result_payload.status, "SENT");
  assert.equal(statementsMatching(client, /INSERT INTO customer_orders/).length, 0);
  assert.equal(statementsMatching(client, /customer_order_items/).length, 0);
  assert.equal(statementsMatching(client, /INSERT INTO sync_change_log/).length, 0);
});

test("an equal incoming version is a duplicate too", async () => {
  const client = scriptedClient([
    NO_REPLAY,
    STORE_ACK,
    [/FROM customer_orders WHERE global_id/, { rows: [storedOrderRow({ entity_version: 3 })], rowCount: 1 }],
    [/INSERT INTO customer_orders/, { rows: [storedOrderRow()], rowCount: 1 }],
    [/INSERT INTO sync_change_log/, CHANGE_LOG_ROW],
  ]);
  const ack = await processSyncOperation(client, orderOperation({ operation_id: "OP-ORDER-SAME" }), context());
  assert.equal(ack.status, "accepted");
  assert.equal(ack.result_payload.duplicate, true);
  assert.equal(statementsMatching(client, /INSERT INTO customer_orders/).length, 0);
});

test("a higher version overwrites - last writer wins", async () => {
  const client = scriptedClient([
    NO_REPLAY,
    STORE_ACK,
    [/FROM customer_orders WHERE global_id/, { rows: [storedOrderRow({ entity_version: 2 })], rowCount: 1 }],
    [/INSERT INTO customer_orders/, { rows: [storedOrderRow({ entity_version: 3 })], rowCount: 1 }],
    [/INSERT INTO sync_change_log/, CHANGE_LOG_ROW],
  ]);
  const ack = await processSyncOperation(client, orderOperation(), context());
  assert.equal(ack.status, "accepted");
  assert.equal(ack.result_payload.duplicate, false);
  assert.equal(ack.server_entity_version, 3);
  oneStatement(client, /INSERT INTO customer_orders/);
  oneStatement(client, /INSERT INTO sync_change_log/);
});

test("an order with no branch is rejected, not thrown", async () => {
  // `logSyncChange` throws without a branch, and the device's branch_id is nullable - so this path
  // is real. A throw here would roll back the whole push and discard the acknowledgements of up to
  // 49 other operations.
  const client = scriptedClient([NO_REPLAY, STORE_ACK]);
  const ack = await processCustomerOrderOperation(client, orderOperation(), { ...context(), branchId: null });

  assert.equal(ack.status, "rejected");
  assert.equal(ack.error_code, "SCOPE_REQUIRED");
  assert.match(ack.message, /branch/i);
  assert.equal(client.statements.length, 0, "nothing may be written without a branch");
});

test("an order id already held by another branch is a conflict, not an overwrite", async () => {
  const client = scriptedClient([
    NO_REPLAY,
    STORE_ACK,
    [/FROM customer_orders WHERE global_id/, {
      rows: [storedOrderRow({ branch_id: 9, entity_version: 1 })],
      rowCount: 1,
    }],
  ]);
  const ack = await processSyncOperation(client, orderOperation(), context());
  assert.equal(ack.status, "conflict");
  assert.equal(ack.error_code, "CONFLICT");
  assert.equal(statementsMatching(client, /INSERT INTO customer_orders/).length, 0);
});

test("malformed orders are named, and never throw", async () => {
  const cases = [
    [{ ...orderPayload(), customer_name: "  " }, /customer_name/],
    [{ ...orderPayload(), items: [] }, /at least one item/],
    [{ ...orderPayload(), status: "SHIPPED" }, /status: SHIPPED/],
    [{ ...orderPayload(), source: "TELEPATHY" }, /source: TELEPATHY/],
    [{ ...orderPayload(), sent_at: "the day before yesterday" }, /sent_at is not a valid timestamp/],
    [{ ...orderPayload(), items: [{ product_id: "004", product_name: "Alphonso", quantity: 0 }] }, /invalid quantity/],
    [{ ...orderPayload(), items: [{ product_name: "Alphonso", quantity: 1 }] }, /missing product_id/],
    [{ ...orderPayload(), items: [{ product_id: "004", quantity: 1 }] }, /missing product_name/],
    [
      { ...orderPayload(), items: [{ product_id: "004", product_name: "A", quantity: 1, agreed_rate: "eighty" }] },
      /invalid agreed_rate/,
    ],
    // Rounded away to nothing, and caught here rather than by the column's CHECK - a Postgres
    // error inside a push is a 500 the device retries forever.
    [
      { ...orderPayload(), items: [{ product_id: "004", product_name: "A", quantity: 0.0001 }] },
      /rounds to zero/,
    ],
    [
      { ...orderPayload(), items: [{ product_id: "004", product_name: "A", quantity: 1e12 }] },
      /out-of-range quantity/,
    ],
  ];
  for (const [payload, expected] of cases) {
    const client = scriptedClient([NO_REPLAY, STORE_ACK]);
    const ack = await processCustomerOrderOperation(client, orderOperation({ payload }), context());
    assert.equal(ack.status, "rejected", `expected a rejection for ${expected}`);
    assert.match(ack.message, expected);
  }
});

test("orders sync as UPSERT only, and another operation type is refused by name", async () => {
  const client = scriptedClient([NO_REPLAY, STORE_ACK]);
  const ack = await processSyncOperation(client, orderOperation({ operation_type: "DELETE" }), context());
  assert.equal(ack.status, "rejected");
  assert.equal(ack.error_code, "UNSUPPORTED_OPERATION");
  assert.match(ack.message, /DELETE/);
});

// ---------------------------------------------------------------------------------------------
// Through the real route
// ---------------------------------------------------------------------------------------------

test("POST /api/sync/push carries a customer order end to end", async () => {
  const client = scriptedClient([
    [/FROM users u/, {
      rows: [{
        id: 7,
        full_name: "Counter Staff",
        company_id: 1,
        branch_id: SESSION_BRANCH_ID,
        active: true,
        session_revocation_version: 0,
        role_name: "Owner",
      }],
      rowCount: 1,
    }],
    [/FROM authorized_devices/, {
      rows: [{
        device_id: "FZDEV-ORDERS",
        status: "APPROVED",
        assigned_branch_id: SESSION_BRANCH_ID,
        company_id: 1,
      }],
      rowCount: 1,
    }],
    [/FROM branches WHERE id/, { rows: [{ id: SESSION_BRANCH_ID, company_id: 1, active: true }], rowCount: 1 }],
    NO_REPLAY,
    STORE_ACK,
    [/FROM customer_orders WHERE global_id/, { rows: [], rowCount: 0 }],
    [/INSERT INTO customer_orders/, { rows: [storedOrderRow()], rowCount: 1 }],
    [/INSERT INTO sync_change_log/, CHANGE_LOG_ROW],
  ]);
  setConnectionResponder(() => client);
  try {
    const token = issueDeviceSession({
      userId: 7,
      deviceId: "FZDEV-ORDERS",
      companyId: 1,
      branchId: SESSION_BRANCH_ID,
      role: "Owner",
      secret: TEST_SIGNING_KEY,
    });
    const response = await probe(
      app,
      "POST",
      "/api/sync/push",
      { authorization: `Bearer ${token}`, "content-type": "application/json" },
      {
        user_id: 7,
        device_id: "FZDEV-ORDERS",
        company_id: 1,
        branch_id: SESSION_BRANCH_ID,
        operations: [orderOperation()],
      }
    );

    assert.equal(response.status, 200, `push failed: ${response.text}`);
    assert.equal(response.body.acknowledgements.length, 1);
    const [ack] = response.body.acknowledgements;
    assert.equal(ack.status, "accepted");
    assert.equal(ack.operation_id, "OP-ORDER-0001");
    assert.equal(ack.result_payload.order_id, "ORD-2026-08-27-0001");
    assert.equal(ack.result_payload.entity_version, 3);
    oneStatement(client, /INSERT INTO customer_orders/);
    oneStatement(client, /INSERT INTO sync_change_log/);
    // The acknowledgement is stored, so the replay above answers the same way next time.
    oneStatement(client, /INSERT INTO sync_processed_operations/);
    assert.ok(client.statements.some((entry) => /COMMIT/.test(entry.sql)), "the batch must commit");
  } finally {
    clearConnectionResponder();
  }
});
