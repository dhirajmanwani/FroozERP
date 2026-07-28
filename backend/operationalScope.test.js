"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SCOPE_MODES,
  createOperationalScopeService,
  normalizeScopeMode,
  requiresOperationalProtocolUpgrade,
  validateSubmittedScope,
  validateSyncBatchScope,
} = require("./operationalScope");

const canonical = {
  company_id: 1,
  branch_id: 1,
  operational_location_id: 10,
};

test("scope modes default off and accept only supported values", () => {
  assert.equal(normalizeScopeMode(), SCOPE_MODES.OFF);
  assert.equal(normalizeScopeMode("SHADOW"), SCOPE_MODES.SHADOW);
  assert.equal(normalizeScopeMode("enforce"), SCOPE_MODES.ENFORCE);
  assert.equal(normalizeScopeMode("unsafe"), SCOPE_MODES.OFF);
});

test("strict mode can block unsafe legacy operational routes without blocking v3", () => {
  assert.equal(requiresOperationalProtocolUpgrade("/products"), true);
  assert.equal(requiresOperationalProtocolUpgrade("/sales/42"), true);
  assert.equal(requiresOperationalProtocolUpgrade("/purchase-bill"), true);
  assert.equal(requiresOperationalProtocolUpgrade("/inventory-lots/42"), true);
  assert.equal(requiresOperationalProtocolUpgrade("/api/owner/dashboard-foundation"), true);
  assert.equal(requiresOperationalProtocolUpgrade("/api/v3/inventory"), false);
  assert.equal(requiresOperationalProtocolUpgrade("/api/sync/push"), false);
  assert.equal(requiresOperationalProtocolUpgrade("/api/health"), false);
});

test("frontend scope substitution is rejected", () => {
  assert.equal(validateSubmittedScope(canonical, { branch_id: 1, operational_location_id: 10 }), null);
  assert.equal(validateSubmittedScope(canonical, { operational_location_id: 11 }).code, "SCOPE_SUBSTITUTION_REJECTED");
});

test("mixed-location and duplicate sync batches are rejected", () => {
  const valid = [
    { operation_id: "op-1", ...canonical },
    { operation_id: "op-2", ...canonical },
  ];
  assert.equal(validateSyncBatchScope(valid, canonical), null);
  assert.equal(validateSyncBatchScope([], canonical), null);
  assert.equal(
    validateSyncBatchScope([{ operation_id: "op-1", ...canonical }, { operation_id: "op-2", ...canonical, operational_location_id: 11 }], canonical).code,
    "MIXED_LOCATION_BATCH"
  );
  assert.equal(
    validateSyncBatchScope([{ operation_id: "op-1", ...canonical }, { operation_id: "op-1", ...canonical }], canonical).code,
    "DUPLICATE_OPERATION_IN_BATCH"
  );
});

test("service resolves the intersection of approved user and device assignments", async () => {
  const service = createOperationalScopeService({
    query: async () => ({
      rows: [{
        device_id: "device-1",
        device_status: "APPROVED",
        company_id: 1,
        branch_id: 1,
        operational_location_id: 10,
        assignment_generation: 2,
        fixed_operational: true,
        intended_usage: "POS",
        device_assignment_active: true,
        location_active: true,
        branch_active: true,
        staff_assignment_active: true,
        role_name: "Owner",
        is_default: true,
      }],
    }),
  });
  const result = await service.resolve({
    userId: 1,
    deviceId: "device-1",
    submitted: canonical,
    requireWrite: true,
  });
  assert.deepEqual(result.context, {
    user_id: 1,
    device_id: "device-1",
    company_id: 1,
    branch_id: 1,
    operational_location_id: 10,
    assignment_generation: 2,
    fixed_operational: true,
    intended_usage: "POS",
    device_permissions: {},
    staff_permissions: {},
    role: "Owner",
    is_default: true,
  });
});

test("unassigned devices and All Locations writes are rejected", async () => {
  const unassigned = createOperationalScopeService({ query: async () => ({ rows: [] }) });
  assert.equal((await unassigned.resolve({ userId: 1, deviceId: "new-device" })).error.code, "DEVICE_LOCATION_MISMATCH");

  const assigned = createOperationalScopeService({
    query: async () => ({
      rows: [{
        device_status: "APPROVED",
        company_id: 1,
        branch_id: 1,
        operational_location_id: 10,
        assignment_generation: 1,
        fixed_operational: false,
        device_assignment_active: true,
        location_active: true,
        branch_active: true,
        staff_assignment_active: true,
      }],
    }),
  });
  const result = await assigned.resolve({
    userId: 1,
    deviceId: "owner-device",
    submitted: { ...canonical, scope: "ALL_LOCATIONS" },
    requireWrite: true,
  });
  assert.equal(result.error.code, "CONSOLIDATED_CONTEXT_READ_ONLY");
});
