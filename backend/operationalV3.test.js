"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyTransferStockEffect,
  canManageAssignments,
  canUseConsolidatedReports,
  nextTransferStatus,
  registerOperationalV3Routes,
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
  for (const method of ["get", "post", "put"]) {
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
  for (const method of ["get", "post", "put"]) {
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
