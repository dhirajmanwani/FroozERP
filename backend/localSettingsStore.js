const { DatabaseSync } = require("node:sqlite");

const localSettingsError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

/**
 * Choose the canonical device when more than one identity row exists.
 *
 * This used to throw `DEVICE_IDENTITY_CONFLICT`, which `desktopGateway` turns into an HTTP 503 —
 * so a machine carrying two device records (a restored backup, a copied profile) could not load
 * its settings at all, in LOCAL_ONLY mode, with no cloud to appeal to. That is a metadata problem
 * stopping a shop, which design §2.5 forbids: "fail into the running state, not out of it".
 *
 * It now mirrors `select_identity_under_conflict` in `src-tauri/src/local_db.rs` exactly, so the
 * Rust and Node paths cannot disagree about which device this machine is: approved rows beat
 * unapproved ones, then most recently seen wins (NULL treated as oldest), then `device_id`
 * ascending as a stable final tie-break. Selection is read-only — no row is created or rewritten.
 *
 * The conflict is reported on the returned object rather than thrown, so callers can surface it.
 */
const selectCanonicalDevice = (database) => {
  const identities = database.prepare(`
    SELECT device_id, branch_id, company_id, registration_status, last_seen_at
    FROM local_device_identity
    WHERE LOWER(device_id) <> 'default'
    ORDER BY device_id
  `).all();

  if (identities.length === 0) {
    throw localSettingsError(
      "LOCAL_DEVICE_IDENTITY_MISSING",
      "No established local device identity is available for offline settings."
    );
  }

  const approved = identities.filter((identity) =>
    String(identity.registration_status || "").toLowerCase() === "approved"
  );
  const group = approved.length > 0 ? approved : identities;

  if (group.length === 1 && identities.length === 1) return group[0];
  if (group.length === 1) return group[0];

  const selected = [...group].sort((a, b) => {
    // Most recently seen first; a missing timestamp sorts last, i.e. treated as oldest.
    const seenA = a.last_seen_at || "";
    const seenB = b.last_seen_at || "";
    if (seenA !== seenB) return seenA < seenB ? 1 : -1;
    return String(a.device_id).localeCompare(String(b.device_id));
  })[0];

  return {
    ...selected,
    identity_conflict: true,
    identity_conflict_kind: approved.length > 1 ? "MULTIPLE_APPROVED" : "MULTIPLE_PROVISIONAL",
    identity_conflict_device_ids: group.map((identity) => identity.device_id).sort(),
    identity_conflict_selected: selected.device_id,
  };
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
      // Present only when this machine carries more than one device record. Settings still load —
      // the conflict is reported, not thrown — so callers can surface it without the shop stopping.
      ...(identity.identity_conflict
        ? {
          identityConflict: {
            kind: identity.identity_conflict_kind,
            deviceIds: identity.identity_conflict_device_ids,
            selected: identity.identity_conflict_selected,
          },
        }
        : {}),
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
