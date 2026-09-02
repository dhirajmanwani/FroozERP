"use strict";

const REFERENCE_BOOTSTRAP_PROTOCOL = "reference-v1";
/**
 * Entity types every device in the company sees, whatever branch or counter it stands at.
 *
 * `charge_type` belongs here for the same reason `sale_rate` does: a price list is not a
 * per-counter thing. Without it a re-priced delivery charge would reach a counter only through a
 * full reference bootstrap, so the counter would keep billing the old rate -- not broken, just
 * confidently wrong, which is worse.
 */
const COMPANY_REFERENCE_ENTITY_TYPES = Object.freeze([
  "product_category", "product", "sale_rate", "supplier", "charge_type",
]);

const visibleChangePredicate = (offset = 1) => `
  company_id = $${offset}
  AND (
    entity_type = ANY($${offset + 3}::TEXT[])
    OR (
      branch_id = $${offset + 1}
      AND operational_location_id = $${offset + 2}
    )
  )
`;

const visibleChangeParameters = (context) => [
  context.companyId,
  context.branchId,
  context.operationalLocationId,
  COMPANY_REFERENCE_ENTITY_TYPES,
];

const lockReferenceBootstrapBoundary = async (client) => {
  await client.query(
    "LOCK TABLE sync_change_log, device_assignments, staff_location_assignments IN SHARE MODE"
  );
};

const readVisibleIncrementalChanges = async (client, context, cursor, limit) => {
  const result = await client.query(
    `
    SELECT change_id, branch_id, operational_location_id, assignment_generation,
           entity_type, entity_id, operation_type,
           entity_version AS version, payload, created_at AS updated_at
    FROM sync_change_log
    WHERE ${visibleChangePredicate(1)}
      AND change_id > $5
    ORDER BY change_id
    LIMIT $6
    `,
    [...visibleChangeParameters(context), cursor, limit + 1]
  );
  return {
    rows: result.rows.slice(0, limit),
    hasMore: result.rows.length > limit,
  };
};

const captureReferenceBootstrap = async (client, context) => {
  const locationResult = await client.query(
    `
    SELECT id, company_id, branch_id, location_code, location_name, location_type,
           timezone, active, is_default, updated_at
    FROM operational_locations
    WHERE id = $1 AND company_id = $2 AND branch_id = $3
    LIMIT 1
    `,
    [context.operationalLocationId, context.companyId, context.branchId]
  );
  const location = locationResult.rows[0];
  if (!location) {
    const error = new Error("The approved operational location is unavailable for bootstrap");
    error.code = "BOOTSTRAP_LOCATION_UNAVAILABLE";
    throw error;
  }
  const assignmentResult = await client.query(
    `
    SELECT device_id, company_id, branch_id, operational_location_id, intended_usage,
           fixed_operational, permission_set, assignment_generation, active
    FROM device_assignments
    WHERE device_id = $1
      AND company_id = $2
      AND branch_id = $3
      AND operational_location_id = $4
      AND assignment_generation = $5
      AND active = TRUE
    LIMIT 1
    `,
    [
      context.deviceId,
      context.companyId,
      context.branchId,
      context.operationalLocationId,
      context.assignmentGeneration,
    ]
  );
  const assignment = assignmentResult.rows[0];
  if (!assignment) {
    const error = new Error("The approved device assignment changed during bootstrap");
    error.code = "BOOTSTRAP_ASSIGNMENT_UNAVAILABLE";
    throw error;
  }

  const highWatermarkResult = await client.query(
    "SELECT COALESCE(MAX(change_id), 0)::BIGINT AS high_watermark FROM sync_change_log"
  );
  const highWatermark = String(highWatermarkResult.rows[0]?.high_watermark || 0);

  const categoriesResult = await client.query(
    `
    SELECT COALESCE(pc.global_id, 'category-' || pc.id::TEXT) AS entity_id,
           pc.entity_version AS version,
           TO_JSONB(pc) AS payload,
           COALESCE(pc.updated_at, pc.created_at) AS updated_at
    FROM product_categories pc
    WHERE pc.company_id = $1 AND pc.deleted_at IS NULL
    ORDER BY pc.id
    `,
    [context.companyId]
  );
  const productsResult = await client.query(
    `
    SELECT COALESCE(p.global_id, 'product-' || p.id::TEXT) AS entity_id,
           p.entity_version AS version,
           TO_JSONB(p) || JSONB_BUILD_OBJECT(
             'category_global_id', COALESCE(pc.global_id, CASE WHEN pc.id IS NULL THEN NULL ELSE 'category-' || pc.id::TEXT END),
             'category_name', COALESCE(pc.category_name, p.category)
           ) AS payload,
           COALESCE(p.selling_rate_updated_at, p.created_at) AS updated_at
    FROM products p
    LEFT JOIN product_categories pc ON pc.id = p.category_id AND pc.company_id = p.company_id
    WHERE p.company_id = $1 AND p.deleted_at IS NULL
    ORDER BY p.id
    `,
    [context.companyId]
  );
  const suppliersResult = await client.query(
    `
    SELECT s.id::TEXT AS entity_id,
           1 AS version,
           JSONB_BUILD_OBJECT(
             'id', s.id,
             'company_id', s.company_id,
             'supplier_name', s.supplier_name,
             'firm_name', s.firm_name,
             'supplier_type', s.supplier_type,
             'active', s.active,
             'created_at', s.created_at,
             'updated_at', s.updated_at
           ) AS payload,
           COALESCE(s.updated_at, s.created_at) AS updated_at
    FROM suppliers s
    WHERE s.company_id = $1
    ORDER BY s.id
    `,
    [context.companyId]
  );
  const locationProductsResult = await client.query(
    `
    SELECT olp.operational_location_id,
           COALESCE(p.global_id, 'product-' || p.id::TEXT) AS product_id,
           olp.enabled, olp.pos_available, olp.selling_rate, olp.reorder_level, olp.updated_at
    FROM operational_location_products olp
    JOIN products p ON p.id = olp.product_id AND p.company_id = olp.company_id
    WHERE olp.company_id = $1
      AND olp.branch_id = $2
      AND olp.operational_location_id = $3
    ORDER BY p.id
    `,
    [context.companyId, context.branchId, context.operationalLocationId]
  );
  const lotsResult = await client.query(
    `
    SELECT COALESCE(ib.global_id, 'inventory-lot-' || ib.id::TEXT) AS entity_id,
           ib.entity_version AS version,
           TO_JSONB(ib) || JSONB_BUILD_OBJECT(
             'product_global_id', COALESCE(p.global_id, 'product-' || p.id::TEXT),
             'product_name', p.product_name
           ) AS payload,
           COALESCE(ib.updated_at, ib.created_at) AS updated_at
    FROM inventory_batches ib
    JOIN products p ON p.id = ib.product_id AND p.company_id = ib.company_id
    WHERE ib.company_id = $1
      AND ib.branch_id = $2
      AND ib.operational_location_id = $3
      AND ib.deleted_at IS NULL
    ORDER BY ib.id
    `,
    [context.companyId, context.branchId, context.operationalLocationId]
  );

  // Charge types travel whole, slabs nested, on the bootstrap as well as the incremental path.
  // A slab is not independently useful: "up to 15 km costs 150" means nothing without the charge it
  // belongs to and the slabs either side of it, because pricing is "the first slab that covers
  // this" -- an answer that depends on the whole ordered list. So a device replaces the set rather
  // than merging rows into a list it cannot verify.
  //
  // Inactive slabs are included deliberately. A device that only ever heard about live slabs could
  // not tell "this slab was withdrawn" from "this slab never reached me", and would keep pricing
  // from a rate the shop retired.
  const chargeTypesResult = await client.query(
    `
    SELECT ct.id, ct.company_id, ct.charge_name, ct.charge_code, ct.basis, ct.measure_unit,
           ct.flat_rate, ct.active, COALESCE(ct.entity_version, 1) AS entity_version,
           ct.updated_by, ct.updated_at,
           COALESCE(
             (
               SELECT JSONB_AGG(TO_JSONB(slab) ORDER BY slab.upto_value, slab.id)
               FROM (
                 SELECT id, charge_type_id, upto_value, rate, active, updated_by, updated_at
                 FROM charge_rate_slabs WHERE charge_type_id = ct.id
               ) AS slab
             ),
             '[]'::JSONB
           ) AS slabs
    FROM charge_types ct
    WHERE ct.company_id IS NULL OR ct.company_id = $1
    ORDER BY ct.id
    `,
    [context.companyId]
  );

  const record = (entityType, row) => ({
    change_id: null,
    branch_id: context.branchId,
    operational_location_id: entityType === "inventory_lot" ? context.operationalLocationId : null,
    assignment_generation: context.assignmentGeneration,
    entity_type: entityType,
    entity_id: row.entity_id,
    operation_type: "UPSERT",
    version: Number(row.version || 1),
    payload: row.payload,
    updated_at: row.updated_at,
  });

  return {
    protocol: REFERENCE_BOOTSTRAP_PROTOCOL,
    high_watermark: highWatermark,
    device_id: context.deviceId,
    company_id: context.companyId,
    branch_id: context.branchId,
    operational_location_id: context.operationalLocationId,
    assignment_generation: context.assignmentGeneration,
    operational_location: location,
    device_assignment: assignment,
    location_products: locationProductsResult.rows,
    charge_types: chargeTypesResult.rows,
    records: [
      ...categoriesResult.rows.map((row) => record("product_category", row)),
      ...productsResult.rows.map((row) => record("product", row)),
      ...suppliersResult.rows.map((row) => record("supplier", row)),
      ...lotsResult.rows.map((row) => record("inventory_lot", row)),
    ],
  };
};

module.exports = {
  COMPANY_REFERENCE_ENTITY_TYPES,
  REFERENCE_BOOTSTRAP_PROTOCOL,
  captureReferenceBootstrap,
  lockReferenceBootstrapBoundary,
  readVisibleIncrementalChanges,
  visibleChangeParameters,
  visibleChangePredicate,
};
