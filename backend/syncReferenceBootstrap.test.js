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
    { rows: [{
      entity_id: "5",
      version: 1,
      payload: {
        id: 5,
        company_id: 1,
        supplier_name: "Reference Supplier",
        firm_name: "Reference Firm",
        supplier_type: "LOCAL_SUPPLIER",
        active: true,
      },
      updated_at: "2026-07-27T00:00:00.000Z",
    }] },
    { rows: [{ operational_location_id: 1001, product_id: "product-276", enabled: true }] },
    { rows: [{ entity_id: "lot-1", version: 2, payload: { company_id: 1, operational_location_id: 1001 }, updated_at: "2026-07-27T00:00:00.000Z" }] },
    { rows: [{
      id: 7,
      company_id: 1,
      charge_name: "Delivery charge",
      basis: "SLAB",
      measure_unit: "km",
      flat_rate: null,
      active: true,
      entity_version: 4,
      // The withdrawn slab travels too: a device that only ever heard about live slabs cannot tell
      // "this was withdrawn" from "this never reached me", and keeps pricing from a retired rate.
      slabs: [
        { id: 11, charge_type_id: 7, upto_value: "10.000", rate: "100.00", active: true },
        { id: 12, charge_type_id: 7, upto_value: "15.000", rate: "150.00", active: false },
      ],
    }] },
    { rows: [
      {
        id: 3, global_id: "combo-3", company_id: 1, name: "Fruit Bowl", kind: "COMBO_OFFER", combo_type: "FIXED",
        price: "199.00", extra_charge: "0.00", margin_percent: "35.00", active: true, entity_version: 2,
        items: [
          { product_id: 276, product_global_id: "product-276", product_name: "Apple", unit: "KG", product_active: true, quantity: 0.5, sort_order: 0 },
          { product_id: 277, product_global_id: "product-277", product_name: "Kiwi", unit: "PCS", product_active: false, quantity: 2, sort_order: 1 },
        ],
      },
      // Switched off, and still sent: "withdrawn" must be distinguishable from "never arrived".
      {
        id: 4, global_id: "combo-4", company_id: 1, name: "Diwali Gift Box", kind: "GIFTING", combo_type: "CUSTOM",
        price: null, extra_charge: "50.00", margin_percent: "60.00", active: false, entity_version: 1, items: [],
      },
    ] },
  ];
  const parameters = [];
  const client = {
    query: async (sql, params) => {
      statements.push(sql);
      parameters.push(params);
      return responses.shift();
    },
  };
  const snapshot = await captureReferenceBootstrap(client, context);
  assert.equal(snapshot.protocol, REFERENCE_BOOTSTRAP_PROTOCOL);
  assert.equal(snapshot.high_watermark, "44");
  assert.equal(snapshot.device_id, "device-a");
  assert.deepEqual(snapshot.records.map((row) => row.entity_type), ["product_category", "product", "supplier", "inventory_lot"]);
  assert.equal(COMPANY_REFERENCE_ENTITY_TYPES.includes("supplier"), true);
  assert.equal(snapshot.records[2].entity_id, "5");
  assert.equal(snapshot.records[2].operational_location_id, null);
  assert.equal("opening_balance" in snapshot.records[2].payload, false);
  assert.equal("bank_name" in snapshot.records[2].payload, false);
  assert.equal("notes" in snapshot.records[2].payload, false);
  assert.equal(statements.some((sql) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)), false);

  // A counter with no internet still has to price a crate charge, so the price list travels on the
  // bootstrap. Without this the device would hold the tables and no rows to put in them, and
  // charges would work online only.
  assert.equal(snapshot.charge_types.length, 1);
  assert.equal(snapshot.charge_types[0].charge_name, "Delivery charge");
  assert.equal(snapshot.charge_types[0].slabs.length, 2, "withdrawn slabs travel as well as live ones");
  assert.equal(
    COMPANY_REFERENCE_ENTITY_TYPES.includes("charge_type"),
    true,
    "a price list is company-wide, so a re-priced charge must reach every counter, not just one branch",
  );

  // Combos travel whole on the bootstrap, inactive ones too, items nested, in the shape
  // `GET /api/v3/combos` and the `combo` sync change use -- read with the same SQL, company-scoped.
  const comboStatement = statements.find((sql) => /FROM combos c/.test(sql));
  assert.ok(comboStatement, "the combos were read");
  assert.deepEqual(parameters[statements.indexOf(comboStatement)], [1, null, null], "this company, every combo");
  assert.deepEqual(snapshot.combos.map((combo) => [combo.global_id, combo.active]), [["combo-3", true], ["combo-4", false]]);
  assert.equal(snapshot.combos[0].items.length, 2);
  assert.equal(snapshot.combos[0].items[0].product_global_id, "product-276");
  assert.deepEqual(snapshot.combos[0].unavailable_products, ["Kiwi"], "a component that is off sale is named");
  assert.equal(snapshot.combos[1].extra_charge, "50.00");
  assert.equal(snapshot.combos[1].margin_percent, "60.00");
  assert.equal(COMPANY_REFERENCE_ENTITY_TYPES.includes("combo"), true, "a combo is company-wide master data");
});

test("bootstrap boundary locks assignment and change-log writers", async () => {
  let statement = "";
  await lockReferenceBootstrapBoundary({ query: async (sql) => { statement = sql; return { rows: [] }; } });
  assert.match(statement, /sync_change_log/);
  assert.match(statement, /device_assignments/);
  assert.match(statement, /staff_location_assignments/);
  assert.match(statement, /SHARE MODE/);
});
