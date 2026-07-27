const test = require("node:test");
const assert = require("node:assert/strict");

const {
  COMPANY_REFERENCE_ENTITY_TYPES,
  REFERENCE_BOOTSTRAP_PROTOCOL,
  captureReferenceBootstrap,
  lockReferenceBootstrapBoundary,
  readVisibleIncrementalChanges,
} = require("./syncReferenceBootstrap");

const context = {
  companyId: 1,
  branchId: 1,
  operationalLocationId: 1001,
  assignmentGeneration: 2,
  deviceId: "device-a",
  device: {},
};

test("incremental visibility combines company references with canonical location changes", async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ change_id: 5 }, { change_id: 6 }, { change_id: 7 }] };
    },
  };
  const result = await readVisibleIncrementalChanges(client, context, 4, 2);
  assert.equal(result.rows.length, 2);
  assert.equal(result.hasMore, true);
  assert.match(calls[0].sql, /entity_type = ANY/);
  assert.match(calls[0].sql, /operational_location_id = \$3/);
  assert.deepEqual(calls[0].params, [1, 1, 1001, COMPANY_REFERENCE_ENTITY_TYPES, 4, 3]);
});

test("bootstrap captures canonical scope and reference records without writing change history", async () => {
  const statements = [];
  const responses = [
    { rows: [{ id: 1001, company_id: 1, branch_id: 1, location_code: "BAD", location_name: "Badwasiya" }] },
    { rows: [{ device_id: "device-a", company_id: 1, branch_id: 1, operational_location_id: 1001, assignment_generation: 2, active: true }] },
    { rows: [{ high_watermark: "44" }] },
    { rows: [{ entity_id: "category-1", version: 1, payload: { company_id: 1 }, updated_at: "2026-07-27T00:00:00.000Z" }] },
    { rows: [{ entity_id: "product-276", version: 3, payload: { company_id: 1 }, updated_at: "2026-07-27T00:00:00.000Z" }] },
    { rows: [{ operational_location_id: 1001, product_id: "product-276", enabled: true }] },
    { rows: [{ entity_id: "lot-1", version: 2, payload: { company_id: 1, operational_location_id: 1001 }, updated_at: "2026-07-27T00:00:00.000Z" }] },
  ];
  const client = {
    query: async (sql) => {
      statements.push(sql);
      return responses.shift();
    },
  };
  const snapshot = await captureReferenceBootstrap(client, context);
  assert.equal(snapshot.protocol, REFERENCE_BOOTSTRAP_PROTOCOL);
  assert.equal(snapshot.high_watermark, "44");
  assert.equal(snapshot.device_id, "device-a");
  assert.deepEqual(snapshot.records.map((row) => row.entity_type), ["product_category", "product", "inventory_lot"]);
  assert.equal(statements.some((sql) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)), false);
});

test("bootstrap boundary locks assignment and change-log writers", async () => {
  let statement = "";
  await lockReferenceBootstrapBoundary({ query: async (sql) => { statement = sql; return { rows: [] }; } });
  assert.match(statement, /sync_change_log/);
  assert.match(statement, /device_assignments/);
  assert.match(statement, /staff_location_assignments/);
  assert.match(statement, /SHARE MODE/);
});
