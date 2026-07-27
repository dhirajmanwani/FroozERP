"use strict";

const crypto = require("crypto");

const TRANSFER_TRANSITIONS = Object.freeze({
  DRAFT: Object.freeze({ submit: "APPROVAL_PENDING", cancel: "CANCELLED" }),
  APPROVAL_PENDING: Object.freeze({ approve: "APPROVED_RESERVED", reject: "REJECTED" }),
  APPROVED_RESERVED: Object.freeze({ dispatch: "DISPATCHED_IN_TRANSIT" }),
  DISPATCHED_IN_TRANSIT: Object.freeze({
    receive: "RECEIVED",
    partial_receive: "PARTIALLY_RECEIVED",
    discrepancy: "DISCREPANCY_RESOLUTION",
  }),
  PARTIALLY_RECEIVED: Object.freeze({
    receive: "RECEIVED",
    discrepancy: "DISCREPANCY_RESOLUTION",
  }),
  DISCREPANCY_RESOLUTION: Object.freeze({
    return: "RETURN_IN_TRANSIT",
    resolve: "CLOSED",
  }),
  RETURN_IN_TRANSIT: Object.freeze({ source_receive: "CLOSED" }),
  RECEIVED: Object.freeze({ close: "CLOSED" }),
});

const cleanText = (value, max = 220) => String(value ?? "").trim().slice(0, max);
const positiveId = (value) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};
const positiveNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};
const jsonValue = (value) => (value && typeof value === "object" ? value : {});
const normalizedRole = (context) => cleanText(context?.role).replace(/[\s_-]+/g, "").toUpperCase();
const isOwner = (context) => normalizedRole(context) === "OWNER";
const permissionEnabled = (permissions, permission) => jsonValue(permissions)[permission] === true;

const canUseConsolidatedReports = (context) =>
  isOwner(context) &&
  context?.fixed_operational === false &&
  permissionEnabled(context.device_permissions, "consolidated_reports") &&
  permissionEnabled(context.staff_permissions, "consolidated_reports");

const canManageAssignments = (context) =>
  isOwner(context) &&
  permissionEnabled(context.device_permissions, "manage_assignments") &&
  permissionEnabled(context.staff_permissions, "manage_assignments");

const nextTransferStatus = (currentStatus, action) =>
  TRANSFER_TRANSITIONS[cleanText(currentStatus).toUpperCase()]?.[cleanText(action).toLowerCase()] || null;

const routeError = (status, code, message, details) => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details;
  return error;
};

const requiredIdempotencyKey = (body) => {
  const key = cleanText(body?.idempotency_key || body?.operation_id);
  if (!key) throw routeError(400, "IDEMPOTENCY_KEY_REQUIRED", "An idempotency key is required");
  return key;
};

const withTransaction = async (database, work, context = null, operationId = null) => {
  const client = typeof database.connect === "function" ? await database.connect() : database;
  try {
    await client.query("BEGIN");
    if (context) {
      await client.query(
        `SELECT
           SET_CONFIG('froozerp.device_id', $1, TRUE),
           SET_CONFIG('froozerp.user_id', $2, TRUE),
           SET_CONFIG('froozerp.operation_id', $3, TRUE)`,
        [
          cleanText(context.device_id, 160),
          String(positiveId(context.user_id) || ""),
          cleanText(operationId, 220),
        ]
      );
    }
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    if (client !== database && typeof client.release === "function") client.release();
  }
};

const validateLocation = async (database, companyId, branchId, locationId) => {
  const result = await database.query(
    `SELECT id, company_id, branch_id, location_name, active
     FROM operational_locations
     WHERE id = $1 AND company_id = $2 AND branch_id = $3`,
    [locationId, companyId, branchId]
  );
  const row = result.rows?.[0];
  if (!row || row.active === false) {
    throw routeError(422, "INVALID_OPERATIONAL_LOCATION", "The operational location is not active in the selected branch");
  }
  return row;
};

const validateTransferScope = async (database, context, body) => {
  const mode = cleanText(body?.initiation_mode).toUpperCase();
  if (!["SOURCE_INITIATED", "DESTINATION_REQUESTED"].includes(mode)) {
    throw routeError(400, "INVALID_INITIATION_MODE", "Transfer initiation_mode must identify source or destination initiation");
  }
  const selectedBranchId = positiveId(
    mode === "SOURCE_INITIATED" ? body.destination_branch_id : body.source_branch_id
  );
  const selectedLocationId = positiveId(
    mode === "SOURCE_INITIATED"
      ? body.destination_operational_location_id
      : body.source_operational_location_id
  );
  if (!selectedBranchId || !selectedLocationId) {
    throw routeError(400, "TRANSFER_LOCATION_REQUIRED", "The other operational location is required");
  }
  await validateLocation(database, context.company_id, selectedBranchId, selectedLocationId);
  const source =
    mode === "SOURCE_INITIATED"
      ? { branch_id: context.branch_id, operational_location_id: context.operational_location_id }
      : { branch_id: selectedBranchId, operational_location_id: selectedLocationId };
  const destination =
    mode === "SOURCE_INITIATED"
      ? { branch_id: selectedBranchId, operational_location_id: selectedLocationId }
      : { branch_id: context.branch_id, operational_location_id: context.operational_location_id };
  if (source.operational_location_id === destination.operational_location_id) {
    throw routeError(422, "TRANSFER_LOCATIONS_IDENTICAL", "Source and destination locations must differ");
  }
  return { mode, source, destination };
};

const validateAssignmentPreview = async (database, context, body, type) => {
  if (!canManageAssignments(context)) {
    throw routeError(403, "ASSIGNMENT_ADMIN_REQUIRED", "Owner assignment permission is required");
  }
  const branchId = positiveId(body?.target_branch_id || body?.branch_id);
  const locationId = positiveId(
    body?.target_operational_location_id || body?.operational_location_id
  );
  if (!branchId || !locationId) {
    throw routeError(400, "ASSIGNMENT_SCOPE_REQUIRED", "Branch and operational location are required");
  }
  const location = await validateLocation(database, context.company_id, branchId, locationId);
  if (type === "staff") {
    const userId = positiveId(body?.target_user_id || body?.user_id);
    if (!userId) throw routeError(400, "USER_REQUIRED", "A user is required");
    const user = await database.query(
      `SELECT u.id, u.username, u.active, r.role_name
       FROM users u LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.id = $1`,
      [userId]
    );
    if (!user.rows?.[0] || user.rows[0].active === false) {
      throw routeError(404, "USER_NOT_AVAILABLE", "The selected user is not active");
    }
    return { type, location, subject: user.rows[0], would_write: false };
  }
  const deviceId = cleanText(body?.target_device_id || body?.device_id, 160);
  if (!deviceId) throw routeError(400, "DEVICE_REQUIRED", "A canonical device ID is required");
  const device = await database.query(
    `SELECT device_id, device_name, device_type, status
     FROM authorized_devices WHERE device_id = $1`,
    [deviceId]
  );
  if (!device.rows?.[0]) throw routeError(404, "DEVICE_NOT_FOUND", "The selected device does not exist");
  if (cleanText(device.rows[0].status).toUpperCase() !== "APPROVED") {
    throw routeError(409, "DEVICE_NOT_APPROVED", "The selected device is not approved");
  }
  const pending = await database.query(
    `SELECT COUNT(*)::int AS count
     FROM sync_inbox_operations
     WHERE source_device_id = $1
       AND COALESCE(sync_status, 'pending') IN ('pending', 'failed', 'conflict')`,
    [deviceId]
  );
  const pendingCount = Number(pending.rows?.[0]?.count || 0);
  return {
    type,
    location,
    subject: device.rows[0],
    pending_sync_count: pendingCount,
    reassignment_allowed: pendingCount === 0,
    would_write: false,
  };
};

const PAYMENT_SOURCES = Object.freeze({
  CUSTOMER_PAYMENT: { table: "customer_payments", amount: "payment_amount" },
  SUPPLIER_PAYMENT: { table: "supplier_payments", amount: "payment_amount" },
  SALE_PAYMENT: { table: "sale_payments", amount: "amount" },
});
const PAYMENT_TARGETS = Object.freeze({
  SALE: { table: "sales", amount: "total_amount" },
  SUPPLIER_BILL: { table: "supplier_bills", amount: "total_amount" },
});

const validatePaymentAllocation = async (database, context, body) => {
  const sourceType = cleanText(body?.payment_entity_type, 40).toUpperCase();
  const targetType = cleanText(body?.target_entity_type, 40).toUpperCase();
  const sourceId = positiveId(body?.payment_entity_id);
  const targetId = positiveId(body?.target_entity_id);
  const amount = positiveNumber(body?.allocated_amount);
  const source = PAYMENT_SOURCES[sourceType];
  const target = PAYMENT_TARGETS[targetType];
  if (!source || !target || !sourceId || !targetId || !amount) {
    throw routeError(400, "PAYMENT_ALLOCATION_INCOMPLETE", "Supported payment, target, and positive allocation amount are required");
  }
  const sourceResult = await database.query(
    `SELECT ${source.amount} AS amount FROM ${source.table}
     WHERE id = $1 AND company_id = $2 AND operational_location_id = $3`,
    [sourceId, context.company_id, context.operational_location_id]
  );
  if (!sourceResult.rows?.[0]) {
    throw routeError(404, "PAYMENT_NOT_FOUND", "Payment does not belong to the active operational location");
  }
  const targetResult = await database.query(
    `SELECT ${target.amount} AS amount FROM ${target.table}
     WHERE id = $1 AND company_id = $2`,
    [targetId, context.company_id]
  );
  if (!targetResult.rows?.[0]) throw routeError(404, "ALLOCATION_TARGET_NOT_FOUND", "Allocation target does not belong to this company");
  const allocated = await database.query(
    `SELECT
       COALESCE(SUM(allocated_amount) FILTER (
         WHERE payment_entity_type = $1 AND payment_entity_id = $2
       ), 0) AS payment_allocated,
       COALESCE(SUM(allocated_amount) FILTER (
         WHERE target_entity_type = $3 AND target_entity_id = $4
       ), 0) AS target_allocated
     FROM payment_allocations WHERE company_id = $5`,
    [sourceType, String(sourceId), targetType, String(targetId), context.company_id]
  );
  if (Number(allocated.rows[0]?.payment_allocated || 0) + amount > Number(sourceResult.rows[0].amount)) {
    throw routeError(409, "PAYMENT_OVER_ALLOCATION", "Allocation exceeds the unallocated payment amount");
  }
  if (Number(allocated.rows[0]?.target_allocated || 0) + amount > Number(targetResult.rows[0].amount)) {
    throw routeError(409, "TARGET_OVER_ALLOCATION", "Allocation exceeds the target amount");
  }
  return { sourceType, targetType, sourceId, targetId, amount };
};

const transferActionItems = (body) => new Map(
  (Array.isArray(body?.items) ? body.items : [])
    .map((item) => [positiveId(item.item_id), item])
    .filter(([itemId]) => itemId)
);

const applyTransferStockEffect = async (client, transfer, action, body, context, idempotencyKey) => {
  if (!["approve", "dispatch", "receive", "partial_receive", "source_receive"].includes(action)) return;
  const itemsResult = await client.query(
    `SELECT ti.*, ib.remaining_qty, ib.purchase_rate, ib.effective_cost_per_unit,
            ib.supplier_id, ib.supplier_name, ib.batch_no
     FROM inventory_transfer_items ti
     JOIN inventory_batches ib ON ib.id = ti.source_lot_id
     WHERE ti.transfer_id = $1 ORDER BY ti.id FOR UPDATE OF ti, ib`,
    [transfer.id]
  );
  const supplied = transferActionItems(body);
  if (itemsResult.rows.length === 0) {
    throw routeError(409, "TRANSFER_ITEMS_MISSING", "Transfer has no stock items");
  }

  for (const item of itemsResult.rows) {
    const requested = Number(item.requested_quantity);
    if (action === "approve") {
      const approved = supplied.has(Number(item.id))
        ? positiveNumber(supplied.get(Number(item.id)).approved_quantity)
        : requested;
      if (!approved || approved > requested) {
        throw routeError(422, "INVALID_APPROVED_QUANTITY", "Approved quantity must be positive and cannot exceed requested quantity");
      }
      const reservations = await client.query(
        `SELECT COALESCE(SUM(quantity), 0) AS reserved
         FROM stock_reservations
         WHERE inventory_batch_id = $1 AND status = 'ACTIVE'`,
        [item.source_lot_id]
      );
      const available = Number(item.remaining_qty) - Number(reservations.rows[0]?.reserved || 0);
      if (available < approved) {
        throw routeError(409, "TRANSFER_STOCK_UNAVAILABLE", "Source stock is no longer available for approval");
      }
      await client.query(
        `UPDATE inventory_transfer_items
         SET approved_quantity = $2, reserved_quantity = $2
         WHERE id = $1`,
        [item.id, approved]
      );
      await client.query(
        `INSERT INTO stock_reservations
          (company_id, branch_id, operational_location_id, inventory_batch_id,
           transfer_item_id, quantity, status, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE',$7)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          transfer.company_id,
          transfer.source_branch_id,
          transfer.source_operational_location_id,
          item.source_lot_id,
          item.id,
          approved,
          `${idempotencyKey}:reserve:${item.id}`,
        ]
      );
      continue;
    }

    if (action === "dispatch") {
      const quantity = Number(item.reserved_quantity || item.approved_quantity);
      if (quantity <= 0) throw routeError(409, "TRANSFER_NOT_RESERVED", "Transfer stock must be reserved before dispatch");
      const reduced = await client.query(
        `UPDATE inventory_batches
         SET remaining_qty = remaining_qty - $2
         WHERE id = $1 AND remaining_qty >= $2
         RETURNING id`,
        [item.source_lot_id, quantity]
      );
      if (!reduced.rows?.[0]) throw routeError(409, "TRANSFER_STOCK_CHANGED", "Source stock changed after approval");
      await client.query(
        `UPDATE inventory_transfer_items SET dispatched_quantity = $2 WHERE id = $1`,
        [item.id, quantity]
      );
      await client.query(
        `UPDATE stock_reservations SET status = 'DISPATCHED', released_at = CURRENT_TIMESTAMP
         WHERE transfer_item_id = $1 AND status = 'ACTIVE'`,
        [item.id]
      );
      await client.query(
        `INSERT INTO stock_transactions
          (product_id, quantity, transaction_type, remarks, user_id, branch_id, company_id, operational_location_id)
         VALUES ($1,$2,'TRANSFER_OUT',$3,$4,$5,$6,$7)`,
        [
          item.product_id,
          -quantity,
          `Transfer ${transfer.transfer_number}`,
          context.user_id,
          transfer.source_branch_id,
          transfer.company_id,
          transfer.source_operational_location_id,
        ]
      );
      continue;
    }

    if (["receive", "partial_receive"].includes(action)) {
      const requestedReceipt = supplied.get(Number(item.id));
      const receivedNow = positiveNumber(requestedReceipt?.received_quantity);
      if (!receivedNow) {
        throw routeError(422, "RECEIVED_QUANTITY_REQUIRED", "Every received transfer item needs a positive received quantity");
      }
      const remainingInTransit = Number(item.dispatched_quantity) -
        Number(item.received_quantity) -
        Number(item.rejected_quantity) -
        Number(item.damaged_quantity) -
        Number(item.short_quantity);
      if (receivedNow > remainingInTransit) {
        throw routeError(422, "TRANSFER_RECEIPT_EXCEEDS_TRANSIT", "Received quantity exceeds unresolved in-transit stock");
      }
      let destinationLotId = positiveId(item.destination_lot_id);
      if (destinationLotId) {
        await client.query(
          `UPDATE inventory_batches
           SET purchase_qty = purchase_qty + $2, remaining_qty = remaining_qty + $2
           WHERE id = $1`,
          [destinationLotId, receivedNow]
        );
      } else {
        const destinationLot = await client.query(
          `INSERT INTO inventory_batches
            (global_id, product_id, batch_no, purchase_qty, remaining_qty, purchase_rate,
             effective_cost_per_unit, supplier_id, supplier_name, branch_id, company_id,
             operational_location_id, purchase_date, batch_status, stock_source)
           VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,CURRENT_DATE,'ACTIVE','TRANSFER')
           RETURNING id`,
          [
            `transfer-${transfer.global_id}-item-${item.id}`,
            item.product_id,
            `TR-${transfer.transfer_number}-${item.id}`,
            receivedNow,
            item.purchase_rate,
            item.effective_cost_per_unit,
            item.supplier_id,
            item.supplier_name,
            transfer.destination_branch_id,
            transfer.company_id,
            transfer.destination_operational_location_id,
          ]
        );
        destinationLotId = Number(destinationLot.rows[0].id);
      }
      await client.query(
        `UPDATE inventory_transfer_items
         SET received_quantity = received_quantity + $2,
             destination_lot_id = $3
         WHERE id = $1`,
        [item.id, receivedNow, destinationLotId]
      );
      await client.query(
        `INSERT INTO stock_transactions
          (product_id, quantity, transaction_type, remarks, user_id, branch_id, company_id, operational_location_id)
         VALUES ($1,$2,'TRANSFER_IN',$3,$4,$5,$6,$7)`,
        [
          item.product_id,
          receivedNow,
          `Transfer ${transfer.transfer_number}`,
          context.user_id,
          transfer.destination_branch_id,
          transfer.company_id,
          transfer.destination_operational_location_id,
        ]
      );
      if (action === "receive" && receivedNow !== remainingInTransit) {
        throw routeError(422, "FULL_RECEIPT_REQUIRED", "Use partial receipt when unresolved in-transit quantity remains");
      }
      continue;
    }

    if (action === "source_receive") {
      const returnedNow = positiveNumber(supplied.get(Number(item.id))?.returned_quantity);
      if (!returnedNow) throw routeError(422, "RETURNED_QUANTITY_REQUIRED", "Returned quantity is required");
      const unresolved = Number(item.dispatched_quantity) - Number(item.received_quantity);
      if (returnedNow > unresolved) throw routeError(422, "RETURN_EXCEEDS_UNRESOLVED", "Returned quantity exceeds unresolved transfer stock");
      await client.query(
        "UPDATE inventory_batches SET remaining_qty = remaining_qty + $2 WHERE id = $1",
        [item.source_lot_id, returnedNow]
      );
      await client.query(
        `UPDATE inventory_transfer_items
         SET rejected_quantity = rejected_quantity + $2 WHERE id = $1`,
        [item.id, returnedNow]
      );
    }
  }
};

const registerOperationalV3Routes = ({
  app,
  database,
  resolveContext,
  middleware = [],
  sendScopeError,
  serverTimePayload = () => ({}),
}) => {
  const guard = (handler, { write = false } = {}) => async (req, res) => {
    try {
      const resolved = await resolveContext(req, { requireWrite: write });
      if (resolved.error) return sendScopeError(res, resolved.error);
      return await handler(req, res, resolved.context);
    } catch (error) {
      console.error(`Protocol v3 ${req.method} ${req.path} failed`, error.code || error.message);
      return res.status(error.status || 500).json({
        code: error.code || "OPERATIONAL_REQUEST_FAILED",
        message: error.status ? error.message : "Operational request failed",
        ...(error.details ? { details: error.details } : {}),
      });
    }
  };
  const use = (method, path, handler, options) =>
    app[method](path, ...middleware, guard(handler, options));

  use("get", "/api/v3/location-products", async (_req, res, context) => {
    const result = await database.query(
      `SELECT p.id AS product_id, p.product_name, p.unit, p.barcode,
              lp.enabled, lp.pos_available, lp.selling_rate, lp.reorder_level,
              COALESCE(SUM(CASE WHEN ib.batch_status <> 'CANCELLED' THEN GREATEST(ib.remaining_qty, 0) ELSE 0 END), 0) AS available_quantity
       FROM operational_location_products lp
       JOIN products p ON p.id = lp.product_id AND p.company_id = lp.company_id
       LEFT JOIN inventory_batches ib
         ON ib.product_id = p.id
        AND ib.company_id = lp.company_id
        AND ib.branch_id = lp.branch_id
        AND ib.operational_location_id = lp.operational_location_id
       WHERE lp.company_id = $1 AND lp.branch_id = $2 AND lp.operational_location_id = $3
       GROUP BY p.id, p.product_name, p.unit, p.barcode, lp.enabled, lp.pos_available, lp.selling_rate, lp.reorder_level
       ORDER BY p.product_name, p.id`,
      [context.company_id, context.branch_id, context.operational_location_id]
    );
    return res.json({ scope: context, products: result.rows, ...serverTimePayload() });
  });

  use("put", "/api/v3/location-products/:productId", async (req, res, context) => {
    const productId = positiveId(req.params.productId);
    if (!productId) throw routeError(400, "PRODUCT_REQUIRED", "A product is required");
    const key = requiredIdempotencyKey(req.body);
    const saved = await withTransaction(database, async (client) => {
      const prior = await client.query(
        `SELECT olp.*
         FROM sync_change_log scl
         JOIN operational_location_products olp
           ON olp.operational_location_id = scl.operational_location_id
          AND scl.entity_id = olp.operational_location_id::TEXT || ':' ||
              (SELECT p.global_id FROM products p WHERE p.id = olp.product_id)
         WHERE scl.company_id = $1
           AND scl.branch_id = $2
           AND scl.operational_location_id = $3
           AND scl.entity_type = 'location_product'
           AND scl.payload->>'source_operation_id' = $4
         ORDER BY scl.change_id DESC
         LIMIT 1`,
        [context.company_id, context.branch_id, context.operational_location_id, key]
      );
      if (prior.rows?.[0]) return prior.rows[0];
      const result = await client.query(
        `INSERT INTO operational_location_products
           (company_id, branch_id, operational_location_id, product_id, enabled, pos_available,
            selling_rate, reorder_level, effective_from, updated_by)
         SELECT $1, $2, $3, p.id, $5, $6, $7, $8, CURRENT_TIMESTAMP, $9
         FROM products p WHERE p.id = $4 AND p.company_id = $1
         ON CONFLICT (operational_location_id, product_id) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           pos_available = EXCLUDED.pos_available,
           selling_rate = EXCLUDED.selling_rate,
           reorder_level = EXCLUDED.reorder_level,
           updated_by = EXCLUDED.updated_by,
           updated_at = CURRENT_TIMESTAMP
         WHERE (
           operational_location_products.enabled,
           operational_location_products.pos_available,
           operational_location_products.selling_rate,
           operational_location_products.reorder_level
         ) IS DISTINCT FROM (
           EXCLUDED.enabled,
           EXCLUDED.pos_available,
           EXCLUDED.selling_rate,
           EXCLUDED.reorder_level
         )
         RETURNING *`,
        [
          context.company_id,
          context.branch_id,
          context.operational_location_id,
          productId,
          req.body.enabled !== false,
          req.body.pos_available !== false,
          req.body.selling_rate == null ? null : Number(req.body.selling_rate),
          Math.max(0, Number(req.body.reorder_level || 0)),
          context.user_id,
        ]
      );
      if (result.rows?.[0]) return result.rows[0];
      const current = await client.query(
        `SELECT * FROM operational_location_products
         WHERE company_id = $1 AND branch_id = $2
           AND operational_location_id = $3 AND product_id = $4`,
        [context.company_id, context.branch_id, context.operational_location_id, productId]
      );
      if (!current.rows?.[0]) {
        throw routeError(404, "PRODUCT_NOT_FOUND", "Product does not belong to this company");
      }
      return current.rows[0];
    }, context, key);
    return res.json({ product: saved, scope: context, ...serverTimePayload() });
  }, { write: true });

  use("get", "/api/v3/purchase-orders", async (_req, res, context) => {
    const result = await database.query(
      `SELECT po.*, COALESCE(json_agg(poi ORDER BY poi.id) FILTER (WHERE poi.id IS NOT NULL), '[]') AS items
       FROM purchase_orders po
       LEFT JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
       WHERE po.company_id = $1 AND po.branch_id = $2 AND po.operational_location_id = $3
       GROUP BY po.id ORDER BY po.order_date DESC, po.id DESC`,
      [context.company_id, context.branch_id, context.operational_location_id]
    );
    return res.json({ scope: context, purchase_orders: result.rows, ...serverTimePayload() });
  });

  use("post", "/api/v3/purchase-orders", async (req, res, context) => {
    const key = requiredIdempotencyKey(req.body);
    const supplierId = positiveId(req.body.supplier_id);
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!supplierId || items.length === 0) {
      throw routeError(400, "PURCHASE_ORDER_INCOMPLETE", "Supplier and at least one item are required");
    }
    const saved = await withTransaction(database, async (client) => {
      const existing = await client.query("SELECT * FROM purchase_orders WHERE idempotency_key = $1", [key]);
      if (existing.rows?.[0]) return existing.rows[0];
      const header = await client.query(
        `INSERT INTO purchase_orders
          (global_id, company_id, branch_id, operational_location_id, supplier_id, order_number,
           order_date, status, created_by, source_device_id, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::date,CURRENT_DATE),$8,$9,$10,$11)
         RETURNING *`,
        [
          cleanText(req.body.global_id) || crypto.randomUUID(),
          context.company_id,
          context.branch_id,
          context.operational_location_id,
          supplierId,
          cleanText(req.body.order_number) || `PO-${Date.now()}`,
          req.body.order_date || null,
          cleanText(req.body.status || "DRAFT").toUpperCase(),
          context.user_id,
          context.device_id,
          key,
        ]
      );
      for (const item of items) {
        const productId = positiveId(item.product_id);
        const quantity = positiveNumber(item.ordered_quantity);
        if (!productId || !quantity) throw routeError(400, "INVALID_PURCHASE_ITEM", "Every purchase item needs a product and positive quantity");
        await client.query(
          `INSERT INTO purchase_order_items
            (purchase_order_id, product_id, ordered_quantity, expected_rate, unit)
           VALUES ($1,$2,$3,$4,$5)`,
          [header.rows[0].id, productId, quantity, item.expected_rate ?? null, cleanText(item.unit, 30) || null]
        );
      }
      return header.rows[0];
    }, context, key);
    return res.status(201).json({ purchase_order: saved, scope: context, ...serverTimePayload() });
  }, { write: true });

  use("get", "/api/v3/goods-receipts", async (_req, res, context) => {
    const result = await database.query(
      `SELECT gr.*, COALESCE(json_agg(gri ORDER BY gri.id) FILTER (WHERE gri.id IS NOT NULL), '[]') AS items
       FROM goods_receipts gr
       LEFT JOIN goods_receipt_items gri ON gri.goods_receipt_id = gr.id
       WHERE gr.company_id = $1 AND gr.branch_id = $2 AND gr.operational_location_id = $3
       GROUP BY gr.id ORDER BY gr.received_at DESC, gr.id DESC`,
      [context.company_id, context.branch_id, context.operational_location_id]
    );
    return res.json({ scope: context, goods_receipts: result.rows, ...serverTimePayload() });
  });

  use("post", "/api/v3/goods-receipts", async (req, res, context) => {
    const key = requiredIdempotencyKey(req.body);
    const supplierId = positiveId(req.body.supplier_id);
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!supplierId || items.length === 0) {
      throw routeError(400, "GOODS_RECEIPT_INCOMPLETE", "Supplier and received items are required");
    }
    const saved = await withTransaction(database, async (client) => {
      const existing = await client.query("SELECT * FROM goods_receipts WHERE idempotency_key = $1", [key]);
      if (existing.rows?.[0]) return existing.rows[0];
      const header = await client.query(
        `INSERT INTO goods_receipts
          (global_id, purchase_order_id, company_id, branch_id, operational_location_id,
           supplier_id, grn_number, received_at, status, received_by, receiving_device_id, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamp,CURRENT_TIMESTAMP),'RECEIVED',$9,$10,$11)
         RETURNING *`,
        [
          cleanText(req.body.global_id) || crypto.randomUUID(),
          positiveId(req.body.purchase_order_id),
          context.company_id,
          context.branch_id,
          context.operational_location_id,
          supplierId,
          cleanText(req.body.grn_number) || `GRN-${Date.now()}`,
          req.body.received_at || null,
          context.user_id,
          context.device_id,
          key,
        ]
      );
      for (const item of items) {
        const productId = positiveId(item.product_id);
        const quantity = positiveNumber(item.received_quantity);
        const lotGlobalId = cleanText(item.lot_global_id) || crypto.randomUUID();
        if (!productId || !quantity) throw routeError(400, "INVALID_RECEIPT_ITEM", "Every receipt item needs a product and positive quantity");
        const receiptItem = await client.query(
          `INSERT INTO goods_receipt_items
            (goods_receipt_id, purchase_order_item_id, product_id, received_quantity, cost_rate, lot_global_id)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [header.rows[0].id, positiveId(item.purchase_order_item_id), productId, quantity, item.cost_rate ?? null, lotGlobalId]
        );
        const lot = await client.query(
          `INSERT INTO inventory_batches
            (global_id, product_id, batch_no, purchase_qty, remaining_qty, purchase_rate,
             effective_cost_per_unit, supplier_id, supplier_name, branch_id, company_id,
             operational_location_id, purchase_date, batch_status, stock_source)
           SELECT $1,$2,$3,$4,$4,$5,$5,$6,s.supplier_name,$7,$8,$9,CURRENT_DATE,'ACTIVE','GRN'
           FROM suppliers s WHERE s.id = $6 AND s.company_id = $8
           RETURNING id`,
          [
            lotGlobalId,
            productId,
            cleanText(item.batch_no) || `GRN-${header.rows[0].id}-${receiptItem.rows[0].id}`,
            quantity,
            item.cost_rate ?? null,
            supplierId,
            context.branch_id,
            context.company_id,
            context.operational_location_id,
          ]
        );
        if (!lot.rows?.[0]) throw routeError(422, "SUPPLIER_SCOPE_MISMATCH", "Supplier does not belong to this company");
        await client.query(
          `INSERT INTO stock_transactions
            (product_id, quantity, transaction_type, remarks, user_id, branch_id, company_id, operational_location_id)
           VALUES ($1,$2,'GRN_RECEIPT',$3,$4,$5,$6,$7)`,
          [productId, quantity, `GRN ${header.rows[0].grn_number}`, context.user_id, context.branch_id, context.company_id, context.operational_location_id]
        );
      }
      return header.rows[0];
    }, context, key);
    return res.status(201).json({ goods_receipt: saved, scope: context, ...serverTimePayload() });
  }, { write: true });

  use("get", "/api/v3/supplier-bills", async (_req, res, context) => {
    const result = await database.query(
      `SELECT * FROM supplier_bills
       WHERE company_id = $1 AND branch_id = $2 AND operational_location_id = $3
       ORDER BY bill_date DESC, id DESC`,
      [context.company_id, context.branch_id, context.operational_location_id]
    );
    return res.json({ scope: context, supplier_bills: result.rows, ...serverTimePayload() });
  });

  use("post", "/api/v3/supplier-bills", async (req, res, context) => {
    const key = requiredIdempotencyKey(req.body);
    const supplierId = positiveId(req.body.supplier_id);
    if (!supplierId || !req.body.bill_date || Number(req.body.total_amount) < 0) {
      throw routeError(400, "SUPPLIER_BILL_INCOMPLETE", "Supplier, bill date, and a non-negative total are required");
    }
    const result = await database.query(
      `INSERT INTO supplier_bills
        (global_id, company_id, branch_id, operational_location_id, supplier_id,
         supplier_invoice_number, bill_date, total_amount, status, idempotency_key, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
       RETURNING *`,
      [
        cleanText(req.body.global_id) || crypto.randomUUID(),
        context.company_id,
        context.branch_id,
        context.operational_location_id,
        supplierId,
        cleanText(req.body.supplier_invoice_number, 120) || null,
        req.body.bill_date,
        Number(req.body.total_amount),
        cleanText(req.body.status || "OPEN").toUpperCase(),
        key,
        context.user_id,
      ]
    );
    return res.status(201).json({ supplier_bill: result.rows[0], scope: context, ...serverTimePayload() });
  }, { write: true });

  use("get", "/api/v3/payment-allocations", async (_req, res, context) => {
    const result = await database.query(
      `SELECT * FROM payment_allocations
       WHERE company_id = $1
         AND (payment_origin_location_id = $2 OR target_operational_location_id = $2)
       ORDER BY created_at DESC, id DESC`,
      [context.company_id, context.operational_location_id]
    );
    return res.json({ scope: context, payment_allocations: result.rows, ...serverTimePayload() });
  });

  use("post", "/api/v3/payment-allocations", async (req, res, context) => {
    const key = requiredIdempotencyKey(req.body);
    const existing = await database.query(
      "SELECT * FROM payment_allocations WHERE idempotency_key = $1",
      [key]
    );
    if (existing.rows?.[0]) {
      return res.json({ payment_allocation: existing.rows[0], scope: context, ...serverTimePayload() });
    }
    const targetBranchId = positiveId(req.body.target_branch_id);
    const targetLocationId = positiveId(req.body.target_operational_location_id);
    if (!targetBranchId || !targetLocationId) {
      throw routeError(400, "PAYMENT_ALLOCATION_INCOMPLETE", "Target branch and location are required");
    }
    await validateLocation(database, context.company_id, targetBranchId, targetLocationId);
    const allocation = await validatePaymentAllocation(database, context, req.body);
    const result = await database.query(
      `INSERT INTO payment_allocations
        (company_id, payment_entity_type, payment_entity_id, payment_origin_branch_id,
         payment_origin_location_id, target_entity_type, target_entity_id, target_branch_id,
         target_operational_location_id, allocated_amount, idempotency_key, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
       RETURNING *`,
      [
        context.company_id,
        allocation.sourceType,
        String(allocation.sourceId),
        context.branch_id,
        context.operational_location_id,
        allocation.targetType,
        String(allocation.targetId),
        targetBranchId,
        targetLocationId,
        allocation.amount,
        key,
        context.user_id,
      ]
    );
    return res.status(201).json({ payment_allocation: result.rows[0], scope: context, ...serverTimePayload() });
  }, { write: true });

  use("post", "/api/v3/transfers", async (req, res, context) => {
    const key = requiredIdempotencyKey(req.body);
    const transferScope = await validateTransferScope(database, context, req.body);
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (items.length === 0) throw routeError(400, "TRANSFER_ITEMS_REQUIRED", "At least one transfer item is required");
    const saved = await withTransaction(database, async (client) => {
      const existing = await client.query("SELECT * FROM inventory_transfers WHERE idempotency_key = $1", [key]);
      if (existing.rows?.[0]) return existing.rows[0];
      const transfer = await client.query(
        `INSERT INTO inventory_transfers
          (global_id, company_id, source_branch_id, source_operational_location_id,
           destination_branch_id, destination_operational_location_id, initiation_mode,
           transfer_number, status, idempotency_key, requested_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'DRAFT',$9,$10) RETURNING *`,
        [
          cleanText(req.body.global_id) || crypto.randomUUID(),
          context.company_id,
          transferScope.source.branch_id,
          transferScope.source.operational_location_id,
          transferScope.destination.branch_id,
          transferScope.destination.operational_location_id,
          transferScope.mode,
          cleanText(req.body.transfer_number) || `TR-${Date.now()}`,
          key,
          context.user_id,
        ]
      );
      for (const item of items) {
        const quantity = positiveNumber(item.requested_quantity);
        const productId = positiveId(item.product_id);
        const lotId = positiveId(item.source_lot_id);
        if (!quantity || !productId || !lotId) {
          throw routeError(400, "INVALID_TRANSFER_ITEM", "Transfer items require product, source lot, and positive quantity");
        }
        const available = await client.query(
          `SELECT ib.id, ib.product_id,
                  GREATEST(ib.remaining_qty - COALESCE(SUM(sr.quantity) FILTER (WHERE sr.status = 'ACTIVE'), 0), 0) AS available
           FROM inventory_batches ib
           LEFT JOIN stock_reservations sr ON sr.inventory_batch_id = ib.id
           WHERE ib.id = $1 AND ib.product_id = $2 AND ib.company_id = $3
             AND ib.branch_id = $4 AND ib.operational_location_id = $5
           GROUP BY ib.id, ib.product_id`,
          [lotId, productId, context.company_id, transferScope.source.branch_id, transferScope.source.operational_location_id]
        );
        if (!available.rows?.[0] || Number(available.rows[0].available) < quantity) {
          throw routeError(409, "TRANSFER_STOCK_UNAVAILABLE", "Requested source stock is not available");
        }
        await client.query(
          `INSERT INTO inventory_transfer_items
            (transfer_id, product_id, source_lot_id, requested_quantity, original_cost_rate)
           SELECT $1,$2,$3,$4,effective_cost_per_unit FROM inventory_batches WHERE id = $3`,
          [transfer.rows[0].id, productId, lotId, quantity]
        );
      }
      return transfer.rows[0];
    }, context, key);
    return res.status(201).json({ transfer: saved, scope: context, ...serverTimePayload() });
  }, { write: true });

  use("post", "/api/v3/transfers/:transferId/actions/:action", async (req, res, context) => {
    const transferId = positiveId(req.params.transferId);
    const action = cleanText(req.params.action).toLowerCase();
    const key = requiredIdempotencyKey(req.body);
    if (!transferId) throw routeError(400, "TRANSFER_REQUIRED", "A transfer is required");
    const saved = await withTransaction(database, async (client) => {
      const existingEvent = await client.query(
        "SELECT transfer_id FROM inventory_transfer_events WHERE idempotency_key = $1",
        [key]
      );
      if (existingEvent.rows?.[0]) {
        const existing = await client.query("SELECT * FROM inventory_transfers WHERE id = $1", [existingEvent.rows[0].transfer_id]);
        return existing.rows[0];
      }
      const locked = await client.query("SELECT * FROM inventory_transfers WHERE id = $1 FOR UPDATE", [transferId]);
      const transfer = locked.rows?.[0];
      if (!transfer || Number(transfer.company_id) !== context.company_id) {
        throw routeError(404, "TRANSFER_NOT_FOUND", "Transfer was not found");
      }
      const sourceActions = ["submit", "approve", "reject", "dispatch", "return", "source_receive", "close"];
      const requiredLocation = sourceActions.includes(action)
        ? Number(transfer.source_operational_location_id)
        : Number(transfer.destination_operational_location_id);
      if (requiredLocation !== context.operational_location_id) {
        throw routeError(403, "TRANSFER_ACTION_SCOPE_REJECTED", "This device location cannot perform the requested transfer action");
      }
      const nextStatus = nextTransferStatus(transfer.status, action);
      if (!nextStatus) {
        throw routeError(409, "INVALID_TRANSFER_TRANSITION", `Cannot ${action} a transfer in ${transfer.status}`);
      }
      await applyTransferStockEffect(client, transfer, action, req.body, context, key);
      const updated = await client.query(
        `UPDATE inventory_transfers SET status = $2, state_version = state_version + 1,
           approved_by = CASE WHEN $3 = 'approve' THEN $4 ELSE approved_by END,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND state_version = $5 RETURNING *`,
        [transferId, nextStatus, action, context.user_id, transfer.state_version]
      );
      if (!updated.rows?.[0]) throw routeError(409, "STALE_TRANSFER_STATE", "Transfer state changed; refresh before retrying");
      await client.query(
        `INSERT INTO inventory_transfer_events
          (transfer_id, event_type, from_status, to_status, quantity_details, notes,
           user_id, device_id, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          transferId,
          action.toUpperCase(),
          transfer.status,
          nextStatus,
          JSON.stringify(jsonValue(req.body.quantity_details)),
          cleanText(req.body.notes, 1000) || null,
          context.user_id,
          context.device_id,
          key,
        ]
      );
      return updated.rows[0];
    }, context, key);
    return res.json({ transfer: saved, scope: context, ...serverTimePayload() });
  }, { write: true });

  use("get", "/api/v3/transfers", async (req, res, context) => {
    const consolidated = String(req.query.scope || "").toUpperCase() === "ALL_LOCATIONS";
    if (consolidated && !canUseConsolidatedReports(context)) {
      throw routeError(403, "CONSOLIDATED_PERMISSION_REQUIRED", "Consolidated transfer access is not permitted");
    }
    const params = consolidated
      ? [context.company_id]
      : [context.company_id, context.operational_location_id];
    const filter = consolidated
      ? "t.company_id = $1"
      : "t.company_id = $1 AND (t.source_operational_location_id = $2 OR t.destination_operational_location_id = $2)";
    const result = await database.query(
      `SELECT t.*, sl.location_name AS source_location_name, dl.location_name AS destination_location_name
       FROM inventory_transfers t
       JOIN operational_locations sl ON sl.id = t.source_operational_location_id
       JOIN operational_locations dl ON dl.id = t.destination_operational_location_id
       WHERE ${filter} ORDER BY t.created_at DESC, t.id DESC`,
      params
    );
    return res.json({ scope: consolidated ? "ALL_LOCATIONS" : context, transfers: result.rows, ...serverTimePayload() });
  });

  use("get", "/api/v3/reports/consolidated", async (req, res, context) => {
    if (!canUseConsolidatedReports(context)) {
      throw routeError(403, "CONSOLIDATED_PERMISSION_REQUIRED", "A permitted Owner reporting device is required");
    }
    const requested = cleanText(req.query.operational_location_ids, 2000)
      .split(",")
      .map(positiveId)
      .filter(Boolean);
    const authorized = await database.query(
      `SELECT DISTINCT ol.id, ol.branch_id, ol.location_name, b.branch_name
       FROM staff_location_assignments sla
       JOIN operational_locations ol ON ol.id = sla.operational_location_id AND ol.active = TRUE
       JOIN branches b ON b.id = ol.branch_id AND b.active = TRUE
       WHERE sla.user_id = $1 AND sla.company_id = $2 AND sla.active = TRUE
       ORDER BY b.branch_name, ol.location_name`,
      [context.user_id, context.company_id]
    );
    const allowed = new Set(authorized.rows.map((row) => Number(row.id)));
    const selected = requested.length ? requested : [...allowed];
    if (selected.length === 0 || selected.some((id) => !allowed.has(id))) {
      throw routeError(403, "REPORT_SCOPE_REJECTED", "Report includes an unauthorized operational location");
    }
    const result = await database.query(
      `SELECT ol.id AS operational_location_id, ol.location_name, b.id AS branch_id, b.branch_name,
              COALESCE(inv.available_quantity, 0) AS available_quantity,
              COALESCE(inv.stock_value, 0) AS stock_value,
              COALESCE(sa.sales_total, 0) AS sales_total,
              COALESCE(pu.purchase_total, 0) AS purchase_total
       FROM operational_locations ol
       JOIN branches b ON b.id = ol.branch_id
       LEFT JOIN (
         SELECT operational_location_id, SUM(GREATEST(remaining_qty, 0)) AS available_quantity,
                SUM(GREATEST(remaining_qty, 0) * COALESCE(effective_cost_per_unit, purchase_rate, 0)) AS stock_value
         FROM inventory_batches WHERE company_id = $1 GROUP BY operational_location_id
       ) inv ON inv.operational_location_id = ol.id
       LEFT JOIN (
         SELECT operational_location_id, SUM(total_amount) AS sales_total
         FROM sales WHERE company_id = $1 GROUP BY operational_location_id
       ) sa ON sa.operational_location_id = ol.id
       LEFT JOIN (
         SELECT operational_location_id, SUM(total_amount) AS purchase_total
         FROM purchases WHERE company_id = $1 GROUP BY operational_location_id
       ) pu ON pu.operational_location_id = ol.id
       WHERE ol.company_id = $1 AND ol.id = ANY($2::int[])
       ORDER BY b.branch_name, ol.location_name`,
      [context.company_id, selected]
    );
    const totals = result.rows.reduce(
      (sum, row) => ({
        available_quantity: sum.available_quantity + Number(row.available_quantity || 0),
        stock_value: sum.stock_value + Number(row.stock_value || 0),
        sales_total: sum.sales_total + Number(row.sales_total || 0),
        purchase_total: sum.purchase_total + Number(row.purchase_total || 0),
      }),
      { available_quantity: 0, stock_value: 0, sales_total: 0, purchase_total: 0 }
    );
    return res.json({
      scope: {
        type: selected.length === allowed.size ? "ALL_LOCATIONS" : "SELECTED_LOCATIONS",
        operational_location_ids: selected,
        label: selected.length === allowed.size ? "All Branches and Locations — Company Consolidated" : "Selected Locations Consolidated",
      },
      locations: result.rows,
      totals,
      ...serverTimePayload(),
    });
  });

  use("post", "/api/v3/admin/staff-assignments/preview", async (req, res, context) => {
    const preview = await validateAssignmentPreview(database, context, req.body, "staff");
    return res.json({ preview, ...serverTimePayload() });
  });

  use("post", "/api/v3/admin/device-assignments/preview", async (req, res, context) => {
    const preview = await validateAssignmentPreview(database, context, req.body, "device");
    return res.json({ preview, ...serverTimePayload() });
  });
};

module.exports = {
  TRANSFER_TRANSITIONS,
  canManageAssignments,
  canUseConsolidatedReports,
  nextTransferStatus,
  applyTransferStockEffect,
  registerOperationalV3Routes,
  validateAssignmentPreview,
  validatePaymentAllocation,
  validateTransferScope,
};
