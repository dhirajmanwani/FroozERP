"use strict";

const SCOPE_MODES = Object.freeze({
  OFF: "off",
  SHADOW: "shadow",
  ENFORCE: "enforce",
});

const normalizeId = (value) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const normalizeScopeMode = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  return Object.values(SCOPE_MODES).includes(normalized) ? normalized : SCOPE_MODES.OFF;
};

const scopeError = (status, code, message) => ({ status, code, message });

const validateSubmittedScope = (canonical, submitted = {}) => {
  const fields = ["company_id", "branch_id", "operational_location_id"];
  for (const field of fields) {
    const supplied = normalizeId(submitted[field]);
    if (supplied && supplied !== canonical[field]) {
      return scopeError(403, "SCOPE_SUBSTITUTION_REJECTED", `${field} does not match the approved device scope`);
    }
  }
  return null;
};

const validateSyncBatchScope = (operations, canonical) => {
  if (!Array.isArray(operations)) {
    return scopeError(400, "INVALID_SYNC_BATCH", "Sync operations must be an array");
  }
  if (operations.length === 0) return null;
  const operationIds = new Set();
  for (const operation of operations) {
    const operationId = String(operation?.operation_id || operation?.idempotency_key || "").trim();
    if (!operationId) {
      return scopeError(400, "IDEMPOTENCY_KEY_REQUIRED", "Every sync operation requires an operation_id");
    }
    if (operationIds.has(operationId)) {
      return scopeError(409, "DUPLICATE_OPERATION_IN_BATCH", `Duplicate operation_id ${operationId}`);
    }
    operationIds.add(operationId);
    const mismatch = validateSubmittedScope(canonical, operation);
    if (mismatch) return scopeError(422, "MIXED_LOCATION_BATCH", mismatch.message);
  }
  return null;
};

const LEGACY_OPERATIONAL_ROUTE = /^\/(?:api\/owner\/dashboard-foundation|dashboard|products?|product-categories|inventory|lots?|purchases?|purchase-returns?|sales?|sale-returns?|waste|customers?|suppliers?|payments?|accounts?|expenses?|contra|reports?)(?:\/|$)/i;

const requiresOperationalProtocolUpgrade = (requestPath) => {
  const normalized = String(requestPath || "").split("?")[0];
  if (normalized.startsWith("/api/v3/") || normalized.startsWith("/api/sync/")) return false;
  return LEGACY_OPERATIONAL_ROUTE.test(normalized);
};

const createOperationalScopeService = (database) => {
  if (!database || typeof database.query !== "function") {
    throw new TypeError("Operational scope service requires a database query adapter");
  }

  const resolve = async ({ userId, deviceId, submitted = {}, requireWrite = false }) => {
    const parsedUserId = normalizeId(userId);
    const canonicalDeviceId = String(deviceId || "").trim();
    if (!parsedUserId || !canonicalDeviceId) {
      return { error: scopeError(401, "OPERATIONAL_CONTEXT_REQUIRED", "A canonical user and device are required") };
    }

    const result = await database.query(
      `
      SELECT
        d.device_id,
        d.status AS device_status,
        da.company_id,
        da.branch_id,
        da.operational_location_id,
        da.assignment_generation,
        da.fixed_operational,
        da.intended_usage,
        da.permission_set AS device_permissions,
        da.active AS device_assignment_active,
        ol.active AS location_active,
        b.active AS branch_active,
        sla.role_id,
        sla.is_default,
        sla.permission_set AS staff_permissions,
        sla.active AS staff_assignment_active,
        COALESCE(r.role_name, '') AS role_name
      FROM authorized_devices d
      JOIN device_assignments da
        ON da.device_id = d.device_id
       AND da.active = TRUE
      JOIN operational_locations ol
        ON ol.id = da.operational_location_id
       AND ol.company_id = da.company_id
       AND ol.branch_id = da.branch_id
      JOIN branches b
        ON b.id = da.branch_id
       AND b.company_id = da.company_id
      JOIN staff_location_assignments sla
        ON sla.user_id = $1
       AND sla.company_id = da.company_id
       AND sla.branch_id = da.branch_id
       AND sla.operational_location_id = da.operational_location_id
       AND sla.active = TRUE
       AND (sla.effective_from IS NULL OR sla.effective_from <= CURRENT_DATE)
       AND (sla.effective_to IS NULL OR sla.effective_to >= CURRENT_DATE)
      LEFT JOIN roles r ON r.id = sla.role_id
      WHERE d.device_id = $2
      ORDER BY sla.is_default DESC, da.assignment_generation DESC
      LIMIT 1
      `,
      [parsedUserId, canonicalDeviceId]
    );
    const row = result.rows?.[0];
    if (!row) {
      return { error: scopeError(403, "DEVICE_LOCATION_MISMATCH", "User and device do not share an approved operational location") };
    }
    if (String(row.device_status).toUpperCase() !== "APPROVED") {
      return { error: scopeError(403, "DEVICE_NOT_APPROVED", "Device is not approved") };
    }
    if (row.device_assignment_active === false || row.location_active === false || row.branch_active === false || row.staff_assignment_active === false) {
      return { error: scopeError(403, "OPERATIONAL_SCOPE_INACTIVE", "The approved operational scope is inactive") };
    }

    const context = {
      user_id: parsedUserId,
      device_id: canonicalDeviceId,
      company_id: normalizeId(row.company_id),
      branch_id: normalizeId(row.branch_id),
      operational_location_id: normalizeId(row.operational_location_id),
      assignment_generation: Number(row.assignment_generation || 1),
      fixed_operational: row.fixed_operational !== false,
      intended_usage: row.intended_usage || null,
      device_permissions: row.device_permissions || {},
      staff_permissions: row.staff_permissions || {},
      role: row.role_name || null,
      is_default: row.is_default === true,
    };
    if (!context.company_id || !context.branch_id || !context.operational_location_id) {
      return { error: scopeError(409, "OPERATIONAL_LOCATION_REQUIRED", "Approved device assignment is incomplete") };
    }
    const mismatch = validateSubmittedScope(context, submitted);
    if (mismatch) return { error: mismatch };
    if (requireWrite && String(submitted.scope || "").toUpperCase() === "ALL_LOCATIONS") {
      return { error: scopeError(403, "CONSOLIDATED_CONTEXT_READ_ONLY", "All Locations is read-only") };
    }
    return { context };
  };

  return { resolve };
};

module.exports = {
  SCOPE_MODES,
  createOperationalScopeService,
  normalizeId,
  normalizeScopeMode,
  requiresOperationalProtocolUpgrade,
  validateSubmittedScope,
  validateSyncBatchScope,
};
