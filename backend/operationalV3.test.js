"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyTransferStockEffect,
  canManageAssignments,
  canUseConsolidatedReports,
  nextTransferStatus,
  positiveId,
  readSupplierMasterPayload,
  registerOperationalV3Routes,
  resolveEntityReference,
  supplierReferencePayload,
  validateAssignmentPreview,
  validatePaymentAllocation,
  validateTransferScope,
} = require("./operationalV3");

const ownerContext = {
  user_id: 1,
  device_id: "DEVICE-1",
  company_id: 1,
  branch_id: 1,
  operational_location_id: 10,
  role: "Owner",
  fixed_operational: false,
  device_permissions: { consolidated_reports: true, manage_assignments: true },
  staff_permissions: { consolidated_reports: true, manage_assignments: true },
};

test("transfer state machine rejects shortcuts and permits controlled transitions", () => {
  assert.equal(nextTransferStatus("DRAFT", "submit"), "APPROVAL_PENDING");
  assert.equal(nextTransferStatus("APPROVAL_PENDING", "approve"), "APPROVED_RESERVED");
  assert.equal(nextTransferStatus("APPROVED_RESERVED", "dispatch"), "DISPATCHED_IN_TRANSIT");
  assert.equal(nextTransferStatus("DISPATCHED_IN_TRANSIT", "partial_receive"), "PARTIALLY_RECEIVED");
  assert.equal(nextTransferStatus("PARTIALLY_RECEIVED", "receive"), "RECEIVED");
  assert.equal(nextTransferStatus("RECEIVED", "close"), "CLOSED");
  assert.equal(nextTransferStatus("DISPATCHED_IN_TRANSIT", "cancel"), null);
  assert.equal(nextTransferStatus("DRAFT", "receive"), null);
});

test("consolidated and assignment permissions require Owner plus user/device permission intersection", () => {
  assert.equal(canUseConsolidatedReports(ownerContext), true);
  assert.equal(canManageAssignments(ownerContext), true);
  assert.equal(canUseConsolidatedReports({ ...ownerContext, fixed_operational: true }), false);
  assert.equal(canUseConsolidatedReports({ ...ownerContext, staff_permissions: {} }), false);
  assert.equal(canManageAssignments({ ...ownerContext, role: "Manager" }), false);
  assert.equal(canManageAssignments({ ...ownerContext, device_permissions: {} }), false);
});

test("transfer source comes from canonical context and selected destination is validated", async () => {
  const calls = [];
  const database = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ id: 20, company_id: 1, branch_id: 2, location_name: "Mansarovar", active: true }] };
    },
  };
  const result = await validateTransferScope(database, ownerContext, {
    initiation_mode: "SOURCE_INITIATED",
    destination_branch_id: 2,
    destination_operational_location_id: 20,
  });
  assert.deepEqual(result.source, { branch_id: 1, operational_location_id: 10 });
  assert.deepEqual(result.destination, { branch_id: 2, operational_location_id: 20 });
  assert.deepEqual(calls[0].params, [20, 1, 2]);
});

test("destination-requested transfer binds destination to canonical context", async () => {
  const database = {
    query: async () => ({ rows: [{ id: 30, company_id: 1, branch_id: 3, active: true }] }),
  };
  const result = await validateTransferScope(database, ownerContext, {
    initiation_mode: "DESTINATION_REQUESTED",
    source_branch_id: 3,
    source_operational_location_id: 30,
  });
  assert.deepEqual(result.source, { branch_id: 3, operational_location_id: 30 });
  assert.deepEqual(result.destination, { branch_id: 1, operational_location_id: 10 });
});

test("device assignment preview is read-only and blocks reassignment with pending sync", async () => {
  const responses = [
    { rows: [{ id: 20, company_id: 1, branch_id: 2, location_name: "Mansarovar", active: true }] },
    { rows: [{ device_id: "DEVICE-2", device_name: "Counter", device_type: "laptop", status: "APPROVED" }] },
    { rows: [{ count: 2 }] },
  ];
  let index = 0;
  const database = { query: async () => responses[index++] };
  const preview = await validateAssignmentPreview(database, ownerContext, {
    device_id: "DEVICE-2",
    branch_id: 2,
    operational_location_id: 20,
  }, "device");
  assert.equal(preview.would_write, false);
  assert.equal(preview.pending_sync_count, 2);
  assert.equal(preview.reassignment_allowed, false);
});

test("staff assignment preview rejects non-owner assignment administrators", async () => {
  await assert.rejects(
    validateAssignmentPreview({ query: async () => ({ rows: [] }) }, { ...ownerContext, role: "Staff" }, {}, "staff"),
    (error) => error.code === "ASSIGNMENT_ADMIN_REQUIRED"
  );
});

const fakeResponse = () => ({
  statusCode: 200,
  payload: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.payload = payload;
    return this;
  },
});

test("location product route queries only canonical company, branch, and location", async () => {
  const routes = [];
  const app = {};
  for (const method of ["get", "post", "put", "delete"]) {
    app[method] = (path, ...handlers) => routes.push({ method, path, handler: handlers.at(-1) });
  }
  const calls = [];
  const database = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
  registerOperationalV3Routes({
    app,
    database,
    resolveContext: async () => ({ context: ownerContext }),
    sendScopeError: () => {
      throw new Error("unexpected");
    },
    // A-4d: the supplier master routes declare a permission, and an unwired authorizer refuses with
    // 500 by design so a wiring mistake cannot become a silent bypass. This harness stands in for
    // the real wiring in server.js; the authorization rules themselves are covered by
    // masterDataAuthorization.test.js.
    authorizePermission: async () => ({ id: 1, role_name: "Owner" }),
  });
  const route = routes.find((entry) => entry.method === "get" && entry.path === "/api/v3/location-products");
  const res = fakeResponse();
  await route.handler({ method: "GET", path: route.path, query: {}, body: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls[0].params, [1, 1, 10]);
});

test("consolidated report rejects an unauthorized selected location", async () => {
  const routes = [];
  const app = {};
  for (const method of ["get", "post", "put", "delete"]) {
    app[method] = (path, ...handlers) => routes.push({ method, path, handler: handlers.at(-1) });
  }
  const database = {
    query: async () => ({ rows: [{ id: 10, branch_id: 1, location_name: "Badwasiya", branch_name: "Jodhpur" }] }),
  };
  registerOperationalV3Routes({
    app,
    database,
    resolveContext: async () => ({ context: ownerContext }),
    sendScopeError: () => {
      throw new Error("unexpected");
    },
    // A-4d: the supplier master routes declare a permission, and an unwired authorizer refuses with
    // 500 by design so a wiring mistake cannot become a silent bypass. This harness stands in for
    // the real wiring in server.js; the authorization rules themselves are covered by
    // masterDataAuthorization.test.js.
    authorizePermission: async () => ({ id: 1, role_name: "Owner" }),
  });
  const route = routes.find((entry) => entry.path === "/api/v3/reports/consolidated");
  const res = fakeResponse();
  await route.handler(
    { method: "GET", path: route.path, query: { operational_location_ids: "10,99" }, body: {} },
    res
  );
  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.code, "REPORT_SCOPE_REJECTED");
});

test("transfer approval reserves only available source stock", async () => {
  const queries = [];
  const database = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      // Both fixtures below describe an item that already names its lot, so the "which lines have
      // no lot chosen yet" query must answer empty. Without modelling the predicate this stub
      // answers every inventory_transfer_items query with the same allocated row, and approval then
      // demands lots for a line that already has one.
      if (sql.includes("source_lot_id IS NULL")) {
        return { rows: sql.includes("COUNT(*)") ? [{ pending: 0 }] : [] };
      }
      if (sql.includes("FROM inventory_transfer_items")) {
        return {
          rows: [{
            id: 50,
            source_lot_id: 70,
            product_id: 276,
            requested_quantity: "10",
            remaining_qty: "12",
          }],
        };
      }
      if (sql.includes("FROM stock_reservations")) return { rows: [{ reserved: "2" }] };
      return { rows: [{ id: 1 }] };
    },
  };
  await applyTransferStockEffect(
    database,
    {
      id: 9,
      company_id: 1,
      source_branch_id: 1,
      source_operational_location_id: 10,
      transfer_number: "TR-9",
    },
    "approve",
    { items: [{ item_id: 50, approved_quantity: 10 }] },
    ownerContext,
    "approve-9"
  );
  assert.ok(queries.some((entry) => entry.sql.includes("INSERT INTO stock_reservations")));
  assert.ok(queries.some((entry) => entry.params?.includes("approve-9:reserve:50")));
});

test("transfer approval rejects stock already reserved elsewhere", async () => {
  const database = {
    query: async (sql) => {
      // Both fixtures below describe an item that already names its lot, so the "which lines have
      // no lot chosen yet" query must answer empty. Without modelling the predicate this stub
      // answers every inventory_transfer_items query with the same allocated row, and approval then
      // demands lots for a line that already has one.
      if (sql.includes("source_lot_id IS NULL")) {
        return { rows: sql.includes("COUNT(*)") ? [{ pending: 0 }] : [] };
      }
      if (sql.includes("FROM inventory_transfer_items")) {
        return { rows: [{ id: 50, source_lot_id: 70, product_id: 276, requested_quantity: "10", remaining_qty: "12" }] };
      }
      if (sql.includes("FROM stock_reservations")) return { rows: [{ reserved: "3" }] };
      return { rows: [] };
    },
  };
  await assert.rejects(
    applyTransferStockEffect(
      database,
      { id: 9, company_id: 1, source_branch_id: 1, source_operational_location_id: 10 },
      "approve",
      { items: [{ item_id: 50, approved_quantity: 10 }] },
      ownerContext,
      "approve-9"
    ),
    (error) => error.code === "TRANSFER_STOCK_UNAVAILABLE"
  );
});

test("payment allocation rejects payment over-allocation", async () => {
  const responses = [
    { rows: [{ amount: "100" }] },
    { rows: [{ amount: "200" }] },
    { rows: [{ payment_allocated: "80", target_allocated: "20" }] },
  ];
  let index = 0;
  const database = { query: async () => responses[index++] };
  await assert.rejects(
    validatePaymentAllocation(database, ownerContext, {
      payment_entity_type: "CUSTOMER_PAYMENT",
      payment_entity_id: 1,
      target_entity_type: "SALE",
      target_entity_id: 2,
      allocated_amount: 30,
    }),
    (error) => error.code === "PAYMENT_OVER_ALLOCATION"
  );
});

test("payment source validation uses deployed payment_amount columns", async () => {
  const calls = [];
  const responses = [
    { rows: [{ amount: "100" }] },
    { rows: [{ amount: "100" }] },
    { rows: [{ payment_allocated: "0", target_allocated: "0" }] },
  ];
  const database = {
    query: async (sql) => {
      calls.push(sql);
      return responses.shift();
    },
  };
  const result = await validatePaymentAllocation(database, ownerContext, {
    payment_entity_type: "CUSTOMER_PAYMENT",
    payment_entity_id: 1,
    target_entity_type: "SALE",
    target_entity_id: 2,
    allocated_amount: 40,
  });
  assert.equal(result.amount, 40);
  assert.match(calls[0], /SELECT payment_amount AS amount FROM customer_payments/);
});

test("protocol-v3 stock transactions set canonical publication attribution", async () => {
  const routes = [];
  const app = {};
  for (const method of ["get", "post", "put", "delete"]) {
    app[method] = (path, ...handlers) => routes.push({ method, path, handler: handlers.at(-1) });
  }
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes("FROM purchase_orders") && sql.includes("idempotency_key")) return { rows: [] };
      if (sql.includes("INSERT INTO purchase_orders")) return { rows: [{ id: 1 }] };
      if (sql.includes("INSERT INTO purchase_order_items")) return { rows: [{ id: 2 }] };
      return { rows: [] };
    },
    release() {},
  };
  const database = {
    connect: async () => client,
    query: async (sql, params) => client.query(sql, params),
  };
  registerOperationalV3Routes({
    app,
    database,
    resolveContext: async () => ({ context: ownerContext }),
    sendScopeError: () => {
      throw new Error("unexpected");
    },
    // A-4d: the supplier master routes declare a permission, and an unwired authorizer refuses with
    // 500 by design so a wiring mistake cannot become a silent bypass. This harness stands in for
    // the real wiring in server.js; the authorization rules themselves are covered by
    // masterDataAuthorization.test.js.
    authorizePermission: async () => ({ id: 1, role_name: "Owner" }),
  });
  const route = routes.find(
    (entry) => entry.method === "post" && entry.path === "/api/v3/purchase-orders"
  );
  const res = fakeResponse();
  await route.handler({
    method: "POST",
    path: route.path,
    query: {},
    body: {
      idempotency_key: "po-attribution-1",
      supplier_id: 1,
      items: [{ product_id: 276, ordered_quantity: 1 }],
    },
  }, res);
  const attribution = calls.find((entry) => entry.sql.includes("SET_CONFIG('froozerp.device_id'"));
  assert.deepEqual(attribution.params, ["DEVICE-1", "1", "po-attribution-1"]);
});

test("supplier reference payload excludes financial, banking, contact, and note fields", () => {
  const input = readSupplierMasterPayload({
    account_name: "Safe Supplier",
    account_type: "SUPPLIER",
    opening_balance: 123,
    bank_name: "Private Bank",
    mobile_number: "9999999999",
    notes: "Private note",
  });
  assert.equal(input.supplier_name, "Safe Supplier");
  assert.equal(input.supplier_type, "LOCAL_SUPPLIER");
  const reference = supplierReferencePayload({
    id: 9,
    company_id: 1,
    supplier_name: input.supplier_name,
    firm_name: null,
    supplier_type: input.supplier_type,
    active: true,
    created_at: "2026-07-29T00:00:00.000Z",
    updated_at: "2026-07-29T00:00:00.000Z",
    opening_balance: input.opening_balance,
    bank_name: input.bank_name,
    mobile_number: input.mobile_number,
    notes: input.notes,
  });
  assert.deepEqual(Object.keys(reference), [
    "id",
    "company_id",
    "supplier_name",
    "firm_name",
    "supplier_type",
    "active",
    "created_at",
    "updated_at",
  ]);
});

test("supplier create uses canonical company attribution and one transactional publication", async () => {
  const routes = [];
  const app = {};
  for (const method of ["get", "post", "put", "delete"]) {
    app[method] = (path, ...handlers) => routes.push({ method, path, handler: handlers.at(-1) });
  }
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes("FROM sync_processed_operations")) return { rows: [] };
      if (sql.includes("SELECT id FROM suppliers")) return { rows: [] };
      if (sql.includes("INSERT INTO suppliers")) {
        return {
          rows: [{
            id: 9,
            company_id: 1,
            supplier_name: "Safe Supplier",
            firm_name: "Safe Firm",
            supplier_type: "LOCAL_SUPPLIER",
            active: true,
            created_at: "2026-07-29T00:00:00.000Z",
            updated_at: "2026-07-29T00:00:00.000Z",
          }],
        };
      }
      return { rows: [] };
    },
    release() {},
  };
  registerOperationalV3Routes({
    app,
    database: {
      connect: async () => client,
      query: async (sql, params) => client.query(sql, params),
    },
    resolveContext: async () => ({ context: ownerContext }),
    sendScopeError: () => {
      throw new Error("unexpected");
    },
    // A-4d: the supplier master routes declare a permission, and an unwired authorizer refuses with
    // 500 by design so a wiring mistake cannot become a silent bypass. This harness stands in for
    // the real wiring in server.js; the authorization rules themselves are covered by
    // masterDataAuthorization.test.js.
    authorizePermission: async () => ({ id: 1, role_name: "Owner" }),
  });
  const route = routes.find(
    (entry) => entry.method === "post" && entry.path === "/api/v3/suppliers"
  );
  const res = fakeResponse();
  await route.handler({
    method: "POST",
    path: route.path,
    query: {},
    body: {
      idempotency_key: "supplier-create-1",
      account_name: "Safe Supplier",
      account_type: "SUPPLIER",
      firm_name: "Safe Firm",
      opening_balance: 100,
      bank_name: "Private Bank",
      notes: "Private note",
      company_id: 999,
      operational_location_id: 999,
    },
  }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.payload.supplier.company_id, 1);
  const supplierInsert = calls.find((entry) => entry.sql.includes("INSERT INTO suppliers"));
  assert.equal(supplierInsert.params[0], 1);
  const publication = calls.find((entry) => entry.sql.includes("INSERT INTO sync_change_log"));
  assert.deepEqual(publication.params.slice(0, 3), [1, 1, "9"]);
  const publishedPayload = JSON.parse(publication.params[3]);
  assert.equal("opening_balance" in publishedPayload, false);
  assert.equal("bank_name" in publishedPayload, false);
  assert.equal("notes" in publishedPayload, false);
  assert.equal(calls.filter((entry) => entry.sql.includes("INSERT INTO sync_change_log")).length, 1);
  assert.equal(calls.filter((entry) => entry.sql.includes("INSERT INTO sync_processed_operations")).length, 1);
  assert.ok(calls.some((entry) => entry.sql === "COMMIT"));
});

test("assignment preview separates target scope from authenticated caller scope", async () => {
  const responses = [
    { rows: [{ id: 20, company_id: 1, branch_id: 2, location_name: "Mansarovar", active: true }] },
    { rows: [{ device_id: "DEVICE-2", device_name: "Counter", device_type: "laptop", status: "APPROVED" }] },
    { rows: [{ count: 0 }] },
  ];
  let index = 0;
  const preview = await validateAssignmentPreview(
    { query: async () => responses[index++] },
    ownerContext,
    {
      device_id: ownerContext.device_id,
      target_device_id: "DEVICE-2",
      target_branch_id: 2,
      target_operational_location_id: 20,
    },
    "device"
  );
  assert.equal(preview.subject.device_id, "DEVICE-2");
  assert.equal(preview.reassignment_allowed, true);
});

test("an APPROVED_RESERVED consignment can be cancelled, and nothing past dispatch can", () => {
  // Sales and waste do not consult reservations, so held crates can be sold before dispatch. Without
  // this transition the consignment would refuse dispatch (TRANSFER_STOCK_CHANGED) forever.
  assert.equal(nextTransferStatus("APPROVED_RESERVED", "cancel"), "CANCELLED");
  assert.equal(nextTransferStatus("DRAFT", "cancel"), "CANCELLED");
  for (const status of ["DISPATCHED_IN_TRANSIT", "PARTIALLY_RECEIVED", "RECEIVED", "RETURN_IN_TRANSIT"]) {
    assert.equal(nextTransferStatus(status, "cancel"), null, `${status} must not be cancellable`);
  }
});

test("positiveId accepts only a plain number, never the leading digits of something else", () => {
  assert.equal(positiveId(7), 7);
  assert.equal(positiveId("7"), 7);
  assert.equal(positiveId(" 42 "), 42);
  // The bug: parseInt read `7e1c...` as 7, and a transfer action landed on transfer #7.
  assert.equal(positiveId("7e1c2a90-5b1d-4c3e-9f00-1a2b3c4d5e6f"), null);
  assert.equal(positiveId("12abc"), null);
  assert.equal(positiveId("12.5"), null);
  assert.equal(positiveId(12.5), null);
  assert.equal(positiveId("1e3"), null);
  // Leading zeros are an opaque id, not a number: "004" and 4 are different entities.
  assert.equal(positiveId("004"), null);
  assert.equal(positiveId("product-12"), null);
  assert.equal(positiveId(0), null);
  assert.equal(positiveId("-3"), null);
  assert.equal(positiveId(""), null);
  assert.equal(positiveId(null), null);
});

test("a product or lot reference resolves by global id, then by its alias, within the company", async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      if (sql.includes("WHERE global_id = $1")) {
        return { rows: params[0] === "4d0c-uuid" && params[1] === 1 ? [{ id: 42 }] : [] };
      }
      if (sql.includes("global_id IS NULL")) return { rows: params[0] === 12 && params[1] === 1 ? [{ id: 12 }] : [] };
      return { rows: [] };
    },
  };
  assert.equal(await resolveEntityReference(client, "lot", 70, 1), 70);
  assert.equal(calls.length, 0, "a plain numeric id needs no lookup");
  assert.equal(await resolveEntityReference(client, "lot", "4d0c-uuid", 1), 42);
  assert.equal(await resolveEntityReference(client, "lot", "4d0c-uuid", 2), null, "another company's lot is not found");
  assert.equal(await resolveEntityReference(client, "product", "product-12", 1), 12);
  // The alias of one table does not resolve against the other.
  assert.equal(await resolveEntityReference(client, "lot", "product-12", 1), null);
  assert.equal(await resolveEntityReference(client, "product", "", 1), null);
  assert.ok(calls.every((entry) => entry.params[1] === 1 || entry.params[1] === 2), "every lookup is company-scoped");
  assert.ok(calls.some((entry) => entry.sql.startsWith("SELECT id FROM inventory_batches WHERE global_id")));
  assert.ok(calls.some((entry) => entry.sql.startsWith("SELECT id FROM products WHERE id = $1 AND company_id = $2 AND global_id IS NULL")));
});

/**
 * The transfer routes over a stub client that knows one transfer and answers by id or global id.
 */
const transferRouteHarness = ({ transfers = [], context = ownerContext, extra = () => null } = {}) => {
  const routes = [];
  const app = {};
  for (const method of ["get", "post", "put", "delete"]) {
    app[method] = (path, ...handlers) => routes.push({ method, path, handler: handlers.at(-1) });
  }
  const calls = [];
  const client = {
    query: async (text, params = []) => {
      const sql = String(text).replace(/\s+/g, " ").trim();
      calls.push({ sql, params });
      const answer = extra(sql, params);
      if (answer) return answer;
      if (sql.includes("FROM inventory_transfer_events")) return { rows: [] };
      if (sql.startsWith("SELECT * FROM inventory_transfers WHERE global_id")) {
        return { rows: transfers.filter((row) => row.global_id === params[0] && row.company_id === params[1]) };
      }
      if (sql.startsWith("SELECT * FROM inventory_transfers WHERE id")) {
        return { rows: transfers.filter((row) => row.id === params[0] && row.company_id === params[1]) };
      }
      if (sql.startsWith("UPDATE inventory_transfers")) {
        const row = transfers.find((entry) => entry.id === params[0]);
        return { rows: row ? [{ ...row, status: params[1] }] : [] };
      }
      return { rows: [] };
    },
    release() {},
  };
  registerOperationalV3Routes({
    app,
    database: { connect: async () => client, query: async (sql, params) => client.query(sql, params) },
    resolveContext: async () => ({ context }),
    sendScopeError: () => {
      throw new Error("unexpected");
    },
    authorizePermission: async () => ({ id: 1, role_name: "Owner" }),
  });
  const find = (method, path) => routes.find((entry) => entry.method === method && entry.path === path);
  return {
    calls,
    async act(transferId, action, body = {}) {
      const route = find("post", "/api/v3/transfers/:transferId/actions/:action");
      const res = fakeResponse();
      await route.handler({
        method: "POST",
        path: route.path,
        params: { transferId, action },
        query: {},
        body: { idempotency_key: `act-${transferId}-${action}`, ...body },
      }, res);
      return res;
    },
    async create(body) {
      const route = find("post", "/api/v3/transfers");
      const res = fakeResponse();
      await route.handler({ method: "POST", path: route.path, query: {}, body }, res);
      return res;
    },
  };
};

const transferRow = (overrides = {}) => ({
  id: 55,
  global_id: "7e1c2a90-5b1d-4c3e-9f00-1a2b3c4d5e6f",
  company_id: 1,
  source_branch_id: 1,
  source_operational_location_id: 10,
  destination_branch_id: 2,
  destination_operational_location_id: 20,
  status: "DRAFT",
  state_version: 1,
  transfer_number: "TR-55",
  ...overrides,
});

const quietly = async (work) => {
  const consoleError = console.error;
  console.error = () => {};
  try {
    return await work();
  } finally {
    console.error = consoleError;
  }
};

test("a transfer action addressed by a uuid starting with a digit acts on that transfer, not transfer #7", async () => {
  const target = transferRow();
  const bystander = transferRow({ id: 7, global_id: "other-transfer", transfer_number: "TR-7" });
  const harness = transferRouteHarness({ transfers: [target, bystander] });

  const res = await harness.act(target.global_id, "cancel");
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  assert.equal(res.payload.transfer.id, 55);
  assert.equal(res.payload.transfer.status, "CANCELLED");

  const lookup = harness.calls.find((entry) => entry.sql.includes("FROM inventory_transfers WHERE"));
  assert.match(lookup.sql, /WHERE global_id = \$1 AND company_id = \$2/);
  assert.deepEqual(lookup.params, [target.global_id, 1]);
  assert.equal(
    harness.calls.some((entry) => entry.params.includes(7)),
    false,
    "nothing may be addressed to transfer #7",
  );
  const update = harness.calls.find((entry) => entry.sql.startsWith("UPDATE inventory_transfers"));
  assert.equal(update.params[0], 55);
  const event = harness.calls.find((entry) => entry.sql.startsWith("INSERT INTO inventory_transfer_events"));
  assert.equal(event.params[0], 55);
});

test("an unknown uuid is not found, even when a transfer with its leading digits exists", async () => {
  const harness = transferRouteHarness({ transfers: [transferRow({ id: 7, global_id: "other-transfer" })] });
  const res = await quietly(() => harness.act("7e1c0000-0000-4000-8000-000000000000", "cancel"));
  assert.equal(res.statusCode, 404);
  assert.equal(res.payload.code, "TRANSFER_NOT_FOUND");
  assert.equal(harness.calls.some((entry) => entry.sql.startsWith("UPDATE")), false);
});

test("a plain numeric transfer id still addresses the transfer by id, within the company", async () => {
  const harness = transferRouteHarness({ transfers: [transferRow()] });
  const res = await harness.act("55", "submit");
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  const lookup = harness.calls.find((entry) => entry.sql.includes("FROM inventory_transfers WHERE"));
  assert.match(lookup.sql, /WHERE id = \$1 AND company_id = \$2/);
  assert.deepEqual(lookup.params, [55, 1]);
});

test("the sending counter may cancel a draft, and the receiving counter may not", async () => {
  const source = transferRouteHarness({ transfers: [transferRow()] });
  const allowed = await source.act("55", "cancel");
  assert.equal(allowed.statusCode, 200, JSON.stringify(allowed.payload));
  assert.equal(allowed.payload.transfer.status, "CANCELLED");

  const destination = transferRouteHarness({
    transfers: [transferRow()],
    context: { ...ownerContext, operational_location_id: 20 },
  });
  const refused = await quietly(() => destination.act("55", "cancel"));
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.payload.code, "TRANSFER_ACTION_SCOPE_REJECTED");
});

test("cancelling an approved consignment releases the stock approval held", async () => {
  const harness = transferRouteHarness({ transfers: [transferRow({ status: "APPROVED_RESERVED" })] });
  const res = await harness.act("55", "cancel");
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  assert.equal(res.payload.transfer.status, "CANCELLED");
  const release = harness.calls.find((entry) => entry.sql.startsWith("UPDATE stock_reservations"));
  assert.ok(release, "the reservations must be released");
  assert.match(release.sql, /SET status = 'RELEASED'/);
  assert.match(release.sql, /ti\.transfer_id = \$1 AND sr\.status = 'ACTIVE'/);
  assert.deepEqual(release.params, [55]);
  // Releasing must happen before the status moves, inside the same transaction.
  const order = harness.calls.map((entry) => entry.sql);
  assert.ok(order.findIndex((sql) => sql.startsWith("UPDATE stock_reservations")) <
    order.findIndex((sql) => sql.startsWith("UPDATE inventory_transfers")));
  assert.ok(order.includes("COMMIT"));
});

test("a dispatched consignment cannot be cancelled", async () => {
  const harness = transferRouteHarness({ transfers: [transferRow({ status: "DISPATCHED_IN_TRANSIT" })] });
  const res = await quietly(() => harness.act("55", "cancel"));
  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, "INVALID_TRANSFER_TRANSITION");
  assert.equal(harness.calls.some((entry) => entry.sql.startsWith("UPDATE stock_reservations")), false);
});

test("creating a consignment resolves the desktop's snapshot ids for product and lot", async () => {
  const lotUuid = "4d0c9e1a-0000-4000-8000-000000000042";
  const harness = transferRouteHarness({
    extra: (sql, params) => {
      if (sql.includes("FROM operational_locations")) return { rows: [{ id: 20, branch_id: 2, active: true }] };
      if (sql.startsWith("INSERT INTO inventory_transfers")) return { rows: [{ id: 60 }] };
      if (sql.startsWith("SELECT id FROM products WHERE global_id")) return { rows: [] };
      if (sql.startsWith("SELECT id FROM products WHERE id")) {
        return { rows: params[0] === 12 && params[1] === 1 ? [{ id: 12 }] : [] };
      }
      if (sql.startsWith("SELECT id FROM inventory_batches WHERE global_id")) {
        return { rows: params[0] === lotUuid && params[1] === 1 ? [{ id: 42 }] : [] };
      }
      if (sql.includes("FROM inventory_batches ib")) return { rows: [{ id: 42, product_id: 12, available: "5" }] };
      return null;
    },
  });
  const res = await harness.create({
    idempotency_key: "create-snapshot-ids",
    initiation_mode: "SOURCE_INITIATED",
    destination_branch_id: 2,
    destination_operational_location_id: 20,
    items: [{ product_id: "product-12", source_lot_id: lotUuid, requested_quantity: 3 }],
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
  const availability = harness.calls.find((entry) => entry.sql.includes("FROM inventory_batches ib"));
  assert.deepEqual(availability.params, [42, 12, 1, 1, 10]);
  const line = harness.calls.find((entry) => entry.sql.startsWith("INSERT INTO inventory_transfer_items"));
  assert.deepEqual(line.params, [60, 12, 42, 3]);
});

test("a consignment line naming an unknown product or lot is refused, not guessed", async () => {
  const unknownEverything = (sql) => {
    if (sql.includes("FROM operational_locations")) return { rows: [{ id: 20, branch_id: 2, active: true }] };
    if (sql.startsWith("INSERT INTO inventory_transfers")) return { rows: [{ id: 60 }] };
    if (sql.startsWith("SELECT id FROM")) return { rows: [] };
    return null;
  };
  const base = {
    initiation_mode: "SOURCE_INITIATED",
    destination_branch_id: 2,
    destination_operational_location_id: 20,
  };

  const badProduct = transferRouteHarness({ extra: unknownEverything });
  const productRes = await quietly(() => badProduct.create({
    ...base,
    idempotency_key: "create-bad-product",
    items: [{ product_id: "12-not-a-product", source_lot_id: 42, requested_quantity: 1 }],
  }));
  assert.equal(productRes.statusCode, 400);
  assert.equal(productRes.payload.code, "INVALID_TRANSFER_ITEM");
  assert.equal(
    badProduct.calls.some((entry) => entry.sql.startsWith("SELECT id FROM products WHERE id")),
    false,
    "a reference that is not the product-<n> alias is never parsed for digits",
  );

  const badLot = transferRouteHarness({
    extra: (sql, params) => (sql.startsWith("SELECT id FROM products WHERE global_id")
      ? { rows: [{ id: 12 }] }
      : unknownEverything(sql, params)),
  });
  const lotRes = await quietly(() => badLot.create({
    ...base,
    idempotency_key: "create-bad-lot",
    items: [{ product_id: "product-uuid", source_lot_id: "9f-gone", requested_quantity: 1 }],
  }));
  assert.equal(lotRes.statusCode, 409);
  assert.equal(lotRes.payload.code, "TRANSFER_STOCK_UNAVAILABLE");
  assert.equal(badLot.calls.some((entry) => entry.sql.startsWith("INSERT INTO inventory_transfer_items")), false);
  assert.ok(badLot.calls.some((entry) => entry.sql === "ROLLBACK"));
});

test("receiving compares quantities at three decimals, not on raw floats", async () => {
  // 0.3 dispatched, 0.1 already in: 0.3 - 0.1 is 0.19999999999999998 in floating point, which made a
  // receipt of the remaining 0.2 read as "more than is in transit".
  const statements = [];
  const client = {
    query: async (text, params) => {
      const sql = String(text).replace(/\s+/g, " ").trim();
      statements.push({ sql, params });
      if (sql.includes("COUNT(*)") && sql.includes("source_lot_id IS NULL")) return { rows: [{ pending: 0 }] };
      if (sql.includes("FROM inventory_transfer_items ti")) {
        return {
          rows: [{
            id: 50, source_lot_id: 70, product_id: 276, requested_quantity: "0.3",
            dispatched_quantity: "0.3", received_quantity: "0.1", rejected_quantity: "0",
            damaged_quantity: "0", short_quantity: "0", destination_lot_id: 81,
          }],
        };
      }
      return { rows: [{ id: 1 }] };
    },
  };
  await applyTransferStockEffect(
    client,
    transferRow({ status: "PARTIALLY_RECEIVED" }),
    "receive",
    { items: [{ item_id: 50, received_quantity: 0.2 }] },
    ownerContext,
    "receive-float",
  );
  assert.ok(statements.some((entry) => entry.sql.includes("received_quantity = received_quantity + $2")));
});

test("a requested draft is withdrawn by the shop that asked, not by the shop being asked", async () => {
  const requested = transferRow({ initiation_mode: "DESTINATION_REQUESTED" });

  const asker = transferRouteHarness({
    transfers: [requested],
    context: { ...ownerContext, operational_location_id: 20 },
  });
  const withdrawn = await asker.act("55", "cancel");
  assert.equal(withdrawn.statusCode, 200, JSON.stringify(withdrawn.payload));
  assert.equal(withdrawn.payload.transfer.status, "CANCELLED");

  const asked = transferRouteHarness({ transfers: [requested] });
  const refused = await quietly(() => asked.act("55", "cancel"));
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.payload.code, "TRANSFER_ACTION_SCOPE_REJECTED");
});

test("cancelling an approved consignment stays with the source, however it was initiated", async () => {
  for (const mode of ["SOURCE_INITIATED", "DESTINATION_REQUESTED"]) {
    const approved = transferRow({ status: "APPROVED_RESERVED", initiation_mode: mode });

    const destination = transferRouteHarness({
      transfers: [approved],
      context: { ...ownerContext, operational_location_id: 20 },
    });
    const refused = await quietly(() => destination.act("55", "cancel"));
    assert.equal(refused.statusCode, 403, `${mode}: the destination must not release the source's stock`);
    assert.equal(refused.payload.code, "TRANSFER_ACTION_SCOPE_REJECTED");
    assert.equal(destination.calls.some((entry) => entry.sql.startsWith("UPDATE stock_reservations")), false);

    const source = transferRouteHarness({ transfers: [approved] });
    const allowed = await source.act("55", "cancel");
    assert.equal(allowed.statusCode, 200, `${mode}: ${JSON.stringify(allowed.payload)}`);
    assert.equal(allowed.payload.transfer.status, "CANCELLED");
  }
});

test("a replayed transfer action key returns the transfer only to its own company", async () => {
  const own = transferRow({ status: "CANCELLED" });
  const replay = transferRouteHarness({
    extra: (sql) => (sql.includes("FROM inventory_transfer_events") ? { rows: [own] } : null),
  });
  const ok = await replay.act("55", "cancel");
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.payload));
  assert.equal(ok.payload.transfer.id, 55);
  assert.equal(replay.calls.some((entry) => entry.sql.startsWith("UPDATE")), false, "a replay writes nothing");

  const foreign = transferRouteHarness({
    extra: (sql) => (sql.includes("FROM inventory_transfer_events")
      ? { rows: [transferRow({ company_id: 2, transfer_number: "OTHER-CO" })] }
      : null),
  });
  const refused = await quietly(() => foreign.act("55", "cancel"));
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.payload.code, "IDEMPOTENCY_KEY_CONFLICT");
  assert.equal(JSON.stringify(refused.payload).includes("OTHER-CO"), false, "another company's transfer is never returned");
  assert.equal(foreign.calls.some((entry) => entry.sql.startsWith("UPDATE")), false);
});

test("a replayed transfer create key returns the transfer only to its own company", async () => {
  const body = {
    idempotency_key: "create-replay",
    initiation_mode: "SOURCE_INITIATED",
    destination_branch_id: 2,
    destination_operational_location_id: 20,
    items: [{ product_id: 12, source_lot_id: 42, requested_quantity: 1 }],
  };
  const location = (sql) => (sql.includes("FROM operational_locations") ? { rows: [{ id: 20, branch_id: 2, active: true }] } : null);

  const own = transferRouteHarness({
    extra: (sql, params) => location(sql) ||
      (sql.startsWith("SELECT * FROM inventory_transfers WHERE idempotency_key") ? { rows: [transferRow()] } : null),
  });
  const ok = await own.create(body);
  assert.equal(ok.statusCode, 201, JSON.stringify(ok.payload));
  assert.equal(ok.payload.transfer.id, 55);
  assert.equal(own.calls.some((entry) => entry.sql.startsWith("INSERT")), false, "a replay writes nothing");

  const foreign = transferRouteHarness({
    extra: (sql) => location(sql) ||
      (sql.startsWith("SELECT * FROM inventory_transfers WHERE idempotency_key")
        ? { rows: [transferRow({ company_id: 2, transfer_number: "OTHER-CO" })] }
        : null),
  });
  const refused = await quietly(() => foreign.create(body));
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.payload.code, "IDEMPOTENCY_KEY_CONFLICT");
  assert.equal(JSON.stringify(refused.payload).includes("OTHER-CO"), false);
  assert.equal(foreign.calls.some((entry) => entry.sql.startsWith("INSERT")), false);
});

test("a request line naming another company's product by number is refused", async () => {
  const harness = (ownedProducts) => transferRouteHarness({
    extra: (sql, params) => {
      if (sql.includes("FROM operational_locations")) return { rows: [{ id: 30, branch_id: 3, active: true }] };
      if (sql.startsWith("INSERT INTO inventory_transfers")) return { rows: [{ id: 61 }] };
      if (sql === "SELECT id FROM products WHERE id = $1 AND company_id = $2") {
        return { rows: ownedProducts.includes(params[0]) && params[1] === 1 ? [{ id: params[0] }] : [] };
      }
      return null;
    },
  });
  const request = (key, productId) => ({
    idempotency_key: key,
    initiation_mode: "DESTINATION_REQUESTED",
    source_branch_id: 3,
    source_operational_location_id: 30,
    items: [{ product_id: productId, requested_quantity: 2 }],
  });

  const foreign = harness([12]);
  const refused = await quietly(() => foreign.create(request("request-foreign", 999)));
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.payload.code, "INVALID_TRANSFER_ITEM");
  assert.equal(foreign.calls.some((entry) => entry.sql.startsWith("INSERT INTO inventory_transfer_items")), false);

  const owned = harness([12]);
  const accepted = await owned.create(request("request-owned", "12"));
  assert.equal(accepted.statusCode, 201, JSON.stringify(accepted.payload));
  const line = owned.calls.find((entry) => entry.sql.startsWith("INSERT INTO inventory_transfer_items"));
  assert.deepEqual(line.params, [61, 12, 2]);
  const check = owned.calls.find((entry) => entry.sql === "SELECT id FROM products WHERE id = $1 AND company_id = $2");
  assert.deepEqual(check.params, [12, 1]);
});
