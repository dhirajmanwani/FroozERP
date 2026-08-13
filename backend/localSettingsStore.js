const { DatabaseSync } = require("node:sqlite");

const localSettingsError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const selectCanonicalDevice = (database) => {
  const identities = database.prepare(`
    SELECT device_id, branch_id, company_id, registration_status
    FROM local_device_identity
    WHERE LOWER(device_id) <> 'default'
    ORDER BY device_id
  `).all();
  const approved = identities.filter((identity) =>
    String(identity.registration_status || "").toLowerCase() === "approved"
  );
  if (approved.length > 1) {
    throw localSettingsError(
      "DEVICE_IDENTITY_CONFLICT",
      "Multiple approved local device identities exist. Reconcile the canonical identity before loading settings."
    );
  }
  if (approved.length === 1) return approved[0];
  if (identities.length > 1) {
    throw localSettingsError(
      "DEVICE_IDENTITY_CONFLICT",
      "Multiple provisional local device identities exist. Reconcile the canonical identity before loading settings."
    );
  }
  if (identities.length === 1) return identities[0];
  throw localSettingsError(
    "LOCAL_DEVICE_IDENTITY_MISSING",
    "No established local device identity is available for offline settings."
  );
};

const parseSettingValue = (row) => {
  try {
    return JSON.parse(row.setting_value);
  } catch {
    throw localSettingsError(
      "LOCAL_SETTINGS_MALFORMED",
      `Saved local setting '${row.setting_key}' is malformed. FroozERP preserved the existing settings and did not replace them.`
    );
  }
};

const readLocalSettingsBundle = (databasePath) => {
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec("PRAGMA query_only = ON;");
    const integrity = database.prepare("PRAGMA quick_check").get();
    if (!integrity || String(integrity.quick_check || "").toLowerCase() !== "ok") {
      throw localSettingsError(
        "LOCAL_SETTINGS_DATABASE_INVALID",
        "The local settings database failed its integrity check. FroozERP did not replace it."
      );
    }
    const identity = selectCanonicalDevice(database);
    const branchId = String(identity.branch_id || "").trim();
    if (!branchId || branchId.toLowerCase() === "unassigned") {
      throw localSettingsError(
        "LOCAL_DEVICE_SCOPE_MISSING",
        "The established local device has no assigned branch for offline settings."
      );
    }
    const rows = database.prepare(`
      SELECT setting_key, setting_value, branch_id
      FROM local_settings
      WHERE deleted_at IS NULL
        AND (branch_id IS NULL OR branch_id = ?)
      ORDER BY CASE WHEN branch_id IS NULL THEN 0 ELSE 1 END, setting_key
    `).all(branchId);
    const settings = {};
    for (const row of rows) settings[row.setting_key] = parseSettingValue(row);
    return {
      settings,
      canonicalDeviceId: identity.device_id,
      companyId: identity.company_id || null,
      branchId,
    };
  } catch (error) {
    if (error?.code) throw error;
    throw localSettingsError(
      "LOCAL_SETTINGS_LOAD_FAILED",
      "Saved local settings could not be loaded. FroozERP preserved the existing database and did not create defaults."
    );
  } finally {
    database?.close();
  }
};

module.exports = { readLocalSettingsBundle };
