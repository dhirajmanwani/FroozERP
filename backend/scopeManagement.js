"use strict";

const cleanText = (value, max = 220) => String(value ?? "").trim().slice(0, max);
const positiveId = (value) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};
const jsonObject = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const jsonArray = (value) => Array.isArray(value) ? value : [];
const normalizedRole = (context) => cleanText(context?.role).replace(/[\s_-]+/g, "").toUpperCase();

const managementError = (status, code, message, details) => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details;
  return error;
};

const requireAssignmentOwner = (context) => {
  const deviceAllowed = jsonObject(context?.device_permissions).manage_assignments === true;
  const staffAllowed = jsonObject(context?.staff_permissions).manage_assignments === true;
  if (normalizedRole(context) !== "OWNER" || !deviceAllowed || !staffAllowed) {
    throw managementError(403, "ASSIGNMENT_ADMIN_REQUIRED", "Owner assignment permission is required");
  }
};

const validateLocation = async (database, companyId, branchId, locationId, { allowInactive = false } = {}) => {
  const result = await database.query(
    `SELECT ol.*, b.branch_name, b.active AS branch_active
     FROM operational_locations ol
     JOIN branches b ON b.id = ol.branch_id AND b.company_id = ol.company_id
     WHERE ol.id = $1 AND ol.company_id = $2 AND ol.branch_id = $3`,
    [locationId, companyId, branchId]
  );
  const location = result.rows?.[0];
  if (!location || (!allowInactive && (location.active === false || location.branch_active === false))) {
    throw managementError(422, "INVALID_OPERATIONAL_LOCATION", "Select an active operational location in the selected branch");
  }
  return location;
};

const withTransaction = async (database, work) => {
  const client = typeof database.connect === "function" ? await database.connect() : database;
  try {
    await client.query("BEGIN");
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

const auditScopeChange = (client, context, entityType, entityId, action, oldValue, newValue, reason) =>
  client.query(
    `INSERT INTO operational_scope_audit
      (company_id, entity_type, entity_id, action, old_value, new_value, reason,
       changed_by, changed_by_device_id)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9)`,
    [
      context.company_id,
      entityType,
      String(entityId),
      action,
      oldValue ? JSON.stringify(oldValue) : null,
      newValue ? JSON.stringify(newValue) : null,
      cleanText(reason, 2000) || `${action} ${entityType}`,
      context.user_id,
      context.device_id,
    ]
  );

const locationDeactivationBlockers = async (database, locationId) => {
  const result = await database.query(
    `SELECT
       (SELECT COUNT(*)::int FROM device_assignments WHERE operational_location_id = $1 AND active = TRUE) AS active_devices,
       (SELECT COUNT(*)::int FROM staff_location_assignments WHERE operational_location_id = $1 AND active = TRUE) AS active_staff,
       (SELECT COUNT(*)::int FROM inventory_batches WHERE operational_location_id = $1 AND remaining_qty > 0) AS stocked_lots,
       (SELECT COUNT(*)::int FROM inventory_transfers
        WHERE (source_operational_location_id = $1 OR destination_operational_location_id = $1)
          AND status NOT IN ('CLOSED','CANCELLED','REJECTED')) AS open_transfers,
       (SELECT COUNT(*)::int FROM sync_inbox_operations WHERE operational_location_id = $1
          AND COALESCE(sync_status, 'pending') IN ('pending','failed','conflict')) AS pending_sync`,
    [locationId]
  );
  return result.rows?.[0] || {};
};

const hasBlockers = (blockers) => Object.values(blockers).some((value) => Number(value || 0) > 0);

const registerScopeManagementRoutes = ({ use, database, serverTimePayload = () => ({}) }) => {
  use("get", "/api/v3/admin/scope-management", async (_req, res, context) => {
    requireAssignmentOwner(context);
    const [branches, locations, staffAssignments, deviceAssignments, users, pendingDevices, roles] = await Promise.all([
      database.query("SELECT * FROM branches WHERE company_id = $1 ORDER BY active DESC, branch_name, id", [context.company_id]),
      database.query(`SELECT ol.*, b.branch_name FROM operational_locations ol JOIN branches b ON b.id = ol.branch_id
        WHERE ol.company_id = $1 ORDER BY ol.active DESC, b.branch_name, ol.location_name, ol.id`, [context.company_id]),
      database.query(`SELECT sla.*, u.full_name, u.username, r.role_name, ol.location_name, b.branch_name
        FROM staff_location_assignments sla JOIN users u ON u.id = sla.user_id
        LEFT JOIN roles r ON r.id = sla.role_id JOIN operational_locations ol ON ol.id = sla.operational_location_id
        JOIN branches b ON b.id = sla.branch_id WHERE sla.company_id = $1
        ORDER BY sla.active DESC, u.full_name, sla.is_default DESC, b.branch_name, ol.location_name`, [context.company_id]),
      database.query(`SELECT da.*, d.device_name, d.status, ol.location_name, b.branch_name
        FROM device_assignments da JOIN authorized_devices d ON d.device_id = da.device_id
        JOIN operational_locations ol ON ol.id = da.operational_location_id JOIN branches b ON b.id = da.branch_id
        WHERE da.company_id = $1 ORDER BY da.active DESC, d.device_name, da.assignment_generation DESC`, [context.company_id]),
      database.query(`SELECT u.id, u.full_name, u.username, u.active, u.role_id, r.role_name
        FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.active = TRUE ORDER BY u.full_name, u.id`),
      database.query(`SELECT device_id, device_name, device_type, platform, status, request_time,
        requested_physical_location, requested_intended_usage, requested_user_id, requested_role_id
        FROM authorized_devices WHERE status = 'PENDING' ORDER BY request_time, id`),
      database.query("SELECT id, role_name FROM roles ORDER BY role_name, id"),
    ]);
    return res.json({
      branches: branches.rows,
      operational_locations: locations.rows,
      staff_assignments: staffAssignments.rows,
      device_assignments: deviceAssignments.rows,
      users: users.rows,
      pending_devices: pendingDevices.rows,
      roles: roles.rows,
      ...serverTimePayload(),
    });
  });

  use("post", "/api/v3/admin/branches", async (req, res, context) => {
    requireAssignmentOwner(context);
    const name = cleanText(req.body.branch_name, 180);
    if (!name) throw managementError(400, "BRANCH_NAME_REQUIRED", "Branch name is required");
    const branch = await withTransaction(database, async (client) => {
      const created = await client.query(
        `INSERT INTO branches (company_id, branch_name, address, phone_number, gst_number, active)
         VALUES ($1,$2,$3,$4,$5,TRUE) RETURNING *`,
        [context.company_id, name, cleanText(req.body.address, 2000) || null,
          cleanText(req.body.phone_number, 40) || null, cleanText(req.body.gst_number, 80) || null]
      );
      await auditScopeChange(client, context, "branch", created.rows[0].id, "CREATE", null, created.rows[0], req.body.reason);
      return created.rows[0];
    });
    return res.status(201).json({ branch, ...serverTimePayload() });
  }, { write: true });

  use("put", "/api/v3/admin/branches/:branchId", async (req, res, context) => {
    requireAssignmentOwner(context);
    const branchId = positiveId(req.params.branchId);
    const current = await database.query("SELECT * FROM branches WHERE id = $1 AND company_id = $2", [branchId, context.company_id]);
    if (!current.rows?.[0]) throw managementError(404, "BRANCH_NOT_FOUND", "Branch not found");
    const active = req.body.active !== false;
    if (!active) {
      const blockers = await database.query(
        `SELECT COUNT(*)::int AS active_locations FROM operational_locations
         WHERE company_id = $1 AND branch_id = $2 AND active = TRUE`, [context.company_id, branchId]
      );
      if (Number(blockers.rows[0].active_locations) > 0) {
        throw managementError(409, "BRANCH_DEACTIVATION_BLOCKED", "Deactivate its operational locations before deactivating this branch", blockers.rows[0]);
      }
    }
    const updated = await withTransaction(database, async (client) => {
      const result = await client.query(
        `UPDATE branches SET branch_name = COALESCE(NULLIF($3,''), branch_name), address = $4,
           phone_number = $5, gst_number = $6, active = $7 WHERE id = $1 AND company_id = $2 RETURNING *`,
        [branchId, context.company_id, cleanText(req.body.branch_name, 180), cleanText(req.body.address, 2000) || null,
          cleanText(req.body.phone_number, 40) || null, cleanText(req.body.gst_number, 80) || null, active]
      );
      await auditScopeChange(client, context, "branch", branchId, active ? "UPDATE" : "DEACTIVATE", current.rows[0], result.rows[0], req.body.reason);
      return result.rows[0];
    });
    return res.json({ branch: updated, ...serverTimePayload() });
  }, { write: true });

  use("post", "/api/v3/admin/operational-locations", async (req, res, context) => {
    requireAssignmentOwner(context);
    const branchId = positiveId(req.body.target_branch_id);
    const code = cleanText(req.body.location_code, 80).toUpperCase();
    const name = cleanText(req.body.location_name, 180);
    if (!branchId || !code || !name) throw managementError(400, "LOCATION_FIELDS_REQUIRED", "Branch, location code and location name are required");
    const branch = await database.query("SELECT id FROM branches WHERE id = $1 AND company_id = $2 AND active = TRUE", [branchId, context.company_id]);
    if (!branch.rows?.[0]) throw managementError(422, "INVALID_BRANCH", "Select an active branch in this company");
    const location = await withTransaction(database, async (client) => {
      if (req.body.is_default === true) await client.query("UPDATE operational_locations SET is_default = FALSE WHERE company_id = $1 AND branch_id = $2", [context.company_id, branchId]);
      const created = await client.query(
        `INSERT INTO operational_locations
          (company_id, branch_id, location_code, location_name, location_type, address, timezone, active, is_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,$8) RETURNING *`,
        [context.company_id, branchId, code, name, cleanText(req.body.location_type, 60) || "STORE",
          cleanText(req.body.address, 2000) || null, cleanText(req.body.timezone, 80) || "Asia/Kolkata", req.body.is_default === true]
      );
      await auditScopeChange(client, context, "operational_location", created.rows[0].id, "CREATE", null, created.rows[0], req.body.reason);
      return created.rows[0];
    });
    return res.status(201).json({ operational_location: location, ...serverTimePayload() });
  }, { write: true });

  use("put", "/api/v3/admin/operational-locations/:locationId", async (req, res, context) => {
    requireAssignmentOwner(context);
    const locationId = positiveId(req.params.locationId);
    const branchId = positiveId(req.body.target_branch_id);
    const current = await validateLocation(database, context.company_id, branchId, locationId, { allowInactive: true });
    const active = req.body.active !== false;
    if (!active) {
      const blockers = await locationDeactivationBlockers(database, locationId);
      if (hasBlockers(blockers)) throw managementError(409, "LOCATION_DEACTIVATION_BLOCKED", "Resolve stock, devices, staff, transfers and sync work before deactivation", blockers);
    }
    const updated = await withTransaction(database, async (client) => {
      if (req.body.is_default === true) await client.query("UPDATE operational_locations SET is_default = FALSE WHERE company_id = $1 AND branch_id = $2", [context.company_id, branchId]);
      const result = await client.query(
        `UPDATE operational_locations SET location_code = COALESCE(NULLIF($4,''), location_code),
           location_name = COALESCE(NULLIF($5,''), location_name), location_type = COALESCE(NULLIF($6,''), location_type),
           address = $7, timezone = COALESCE(NULLIF($8,''), timezone), active = $9, is_default = $10,
           updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND company_id = $2 AND branch_id = $3 RETURNING *`,
        [locationId, context.company_id, branchId, cleanText(req.body.location_code, 80).toUpperCase(),
          cleanText(req.body.location_name, 180), cleanText(req.body.location_type, 60), cleanText(req.body.address, 2000) || null,
          cleanText(req.body.timezone, 80), active, req.body.is_default === true]
      );
      await auditScopeChange(client, context, "operational_location", locationId, active ? "UPDATE" : "DEACTIVATE", current, result.rows[0], req.body.reason);
      return result.rows[0];
    });
    return res.json({ operational_location: updated, ...serverTimePayload() });
  }, { write: true });

  use("put", "/api/v3/admin/staff-assignments/:userId", async (req, res, context) => {
    requireAssignmentOwner(context);
    const userId = positiveId(req.params.userId);
    const branchId = positiveId(req.body.target_branch_id);
    const locationId = positiveId(req.body.target_operational_location_id);
    const roleId = positiveId(req.body.role_id);
    await validateLocation(database, context.company_id, branchId, locationId, { allowInactive: req.body.active === false });
    const user = await database.query("SELECT id, active FROM users WHERE id = $1", [userId]);
    if (!user.rows?.[0] || user.rows[0].active === false) throw managementError(404, "USER_NOT_AVAILABLE", "Selected user is not active");
    const assignment = await withTransaction(database, async (client) => {
      const old = await client.query("SELECT * FROM staff_location_assignments WHERE user_id = $1 AND operational_location_id = $2", [userId, locationId]);
      if (req.body.is_default === true) await client.query("UPDATE staff_location_assignments SET is_default = FALSE, updated_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND company_id = $2", [userId, context.company_id]);
      const result = await client.query(
        `INSERT INTO staff_location_assignments
          (user_id, company_id, branch_id, operational_location_id, role_id, permission_set, is_default,
           effective_from, effective_to, active, assigned_by)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)
         ON CONFLICT (user_id, operational_location_id) DO UPDATE SET
           branch_id = EXCLUDED.branch_id, role_id = EXCLUDED.role_id, permission_set = EXCLUDED.permission_set,
           is_default = EXCLUDED.is_default, effective_from = EXCLUDED.effective_from,
           effective_to = EXCLUDED.effective_to, active = EXCLUDED.active, assigned_by = EXCLUDED.assigned_by,
           updated_at = CURRENT_TIMESTAMP RETURNING *`,
        [userId, context.company_id, branchId, locationId, roleId, JSON.stringify(jsonObject(req.body.permission_set)),
          req.body.is_default === true, req.body.effective_from || null, req.body.effective_to || null,
          req.body.active !== false, context.user_id]
      );
      await auditScopeChange(client, context, "staff_assignment", result.rows[0].id, old.rows[0] ? "UPDATE" : "CREATE", old.rows[0], result.rows[0], req.body.reason);
      return result.rows[0];
    });
    return res.json({ staff_assignment: assignment, ...serverTimePayload() });
  }, { write: true });

  use("post", "/api/v3/admin/devices/:deviceId/approve", async (req, res, context) => {
    requireAssignmentOwner(context);
    const deviceId = cleanText(req.params.deviceId, 160);
    const branchId = positiveId(req.body.target_branch_id);
    const locationId = positiveId(req.body.target_operational_location_id);
    const userId = positiveId(req.body.permitted_user_id);
    const roleId = positiveId(req.body.role_id);
    const intendedUsage = cleanText(req.body.intended_usage, 80).toUpperCase();
    const physicalLabel = cleanText(req.body.physical_label, 180);
    if (!deviceId || !branchId || !locationId || !userId || !roleId || !intendedUsage || !physicalLabel) {
      throw managementError(400, "DEVICE_ASSIGNMENT_REQUIRED", "Branch, operational location, physical label, usage, user and role are required before approval");
    }
    await validateLocation(database, context.company_id, branchId, locationId);
    const approved = await withTransaction(database, async (client) => {
      const device = await client.query("SELECT * FROM authorized_devices WHERE device_id = $1 FOR UPDATE", [deviceId]);
      if (!device.rows?.[0]) throw managementError(404, "DEVICE_NOT_FOUND", "Pending device not found");
      if (cleanText(device.rows[0].status).toUpperCase() !== "PENDING") throw managementError(409, "DEVICE_NOT_PENDING", "Only a pending device can be approved through this flow");
      const user = await client.query("SELECT id, active, role_id FROM users WHERE id = $1", [userId]);
      if (!user.rows?.[0] || user.rows[0].active === false) throw managementError(422, "USER_NOT_AVAILABLE", "Permitted user is not active");
      if (Number(user.rows[0].role_id) !== roleId) throw managementError(422, "ROLE_MISMATCH", "Selected role does not match the permitted user");
      const staff = await client.query(`SELECT id FROM staff_location_assignments WHERE user_id = $1 AND company_id = $2
        AND branch_id = $3 AND operational_location_id = $4 AND active = TRUE`, [userId, context.company_id, branchId, locationId]);
      if (!staff.rows?.[0]) throw managementError(409, "STAFF_ASSIGNMENT_REQUIRED", "Assign the permitted user to this operational location before approving the device");
      const result = await client.query(
        `UPDATE authorized_devices SET status = 'APPROVED', assigned_branch_id = $2, approved_by = $3,
          approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
          requested_physical_location = $4, requested_intended_usage = $5,
          requested_user_id = $6, requested_role_id = $7 WHERE device_id = $1 RETURNING *`,
        [deviceId, branchId, context.user_id, physicalLabel, intendedUsage, userId, roleId]
      );
      const generation = await client.query("SELECT COALESCE(MAX(assignment_generation), 0) + 1 AS generation FROM device_assignments WHERE device_id = $1", [deviceId]);
      const assignment = await client.query(
        `INSERT INTO device_assignments
          (device_id, company_id, branch_id, operational_location_id, physical_label, device_type,
           intended_usage, fixed_operational, permission_set, permitted_user_ids, permitted_roles,
           assignment_generation, active, approved_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,TRUE,$13) RETURNING *`,
        [deviceId, context.company_id, branchId, locationId, physicalLabel,
          cleanText(req.body.device_type || device.rows[0].device_type, 80) || "OTHER", intendedUsage,
          req.body.fixed_operational !== false, JSON.stringify(jsonObject(req.body.permission_set)),
          JSON.stringify([userId]), JSON.stringify([roleId]), Number(generation.rows[0].generation), context.user_id]
      );
      await client.query(
        `INSERT INTO device_assignment_history (device_id, assignment_id, action, old_scope, new_scope, reason, changed_by)
         VALUES ($1,$2,'APPROVE',$3::jsonb,$4::jsonb,$5,$6)`,
        [deviceId, assignment.rows[0].id, JSON.stringify({ status: "PENDING" }), JSON.stringify(assignment.rows[0]), cleanText(req.body.reason, 2000) || "Owner approved device assignment", context.user_id]
      );
      await auditScopeChange(client, context, "device_assignment", assignment.rows[0].id, "APPROVE", device.rows[0], assignment.rows[0], req.body.reason);
      return { device: result.rows[0], assignment: assignment.rows[0] };
    });
    return res.json({ ...approved, ...serverTimePayload() });
  }, { write: true });
};

module.exports = {
  hasBlockers,
  locationDeactivationBlockers,
  registerScopeManagementRoutes,
  requireAssignmentOwner,
  validateLocation,
};
