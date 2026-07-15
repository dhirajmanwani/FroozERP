const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const databasePath = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Usage: node audit-local-time-identity.js <sqlite-path>");

const db = new DatabaseSync(databasePath, { readOnly: true });
const timestampNames = new Set([
  "created_at", "updated_at", "deleted_at", "pushed_at", "pulled_at",
  "last_sync_at", "last_push_at", "last_pull_at", "last_successful_sync_at",
  "last_synced_at", "last_attempt_at", "synced_at", "processed_at",
  "received_at", "detected_at", "resolved_at", "last_seen_at",
  "cancelled_at", "movement_time", "posting_time", "transaction_time",
]);
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
const timestampAudit = [];
const recordCounts = {};

for (const { name } of tables) {
  const safeName = String(name).replace(/"/g, '""');
  recordCounts[name] = Number(db.prepare(`SELECT COUNT(*) AS count FROM "${safeName}"`).get().count || 0);
  const columns = db.prepare(`PRAGMA table_info("${safeName}")`).all();
  for (const column of columns.filter((item) => timestampNames.has(item.name))) {
    const safeColumn = String(column.name).replace(/"/g, '""');
    const counts = db.prepare(`
      SELECT
        COUNT("${safeColumn}") AS populated,
        COUNT("${safeColumn}") FILTER (
          WHERE "${safeColumn}" NOT GLOB '????-??-??T??:??:??.???Z'
        ) AS noncanonical
      FROM "${safeName}"
    `).get();
    timestampAudit.push({
      table: name,
      column: column.name,
      populated: Number(counts.populated || 0),
      noncanonical: Number(counts.noncanonical || 0),
    });
  }
}

const offlineProfiles = db.prepare("SELECT key, value FROM local_kv WHERE key LIKE 'offline_user_profile::%'").all().map((row) => {
  const profile = JSON.parse(row.value || "{}");
  return {
    user_id: profile.id || null,
    username: profile.username || null,
    normalized_role: String(profile.role_name || profile.role || "").trim().toUpperCase() || null,
    company_id: profile.company_id || null,
    branch_id: profile.branch_id || null,
    active: profile.active !== false,
    authentication_source: profile.authentication_source || "cached_cloud_profile",
    created_at: profile.created_at || null,
    updated_at: profile.updated_at || null,
  };
});
const devices = db.prepare("SELECT * FROM local_device_identity").all().map((device) => ({
  device_id: device.device_id || null,
  branch_id: device.branch_id || null,
  company_id: device.company_id || null,
  user_id: device.user_id || null,
  role: device.role || null,
  registration_status: device.registration_status || null,
  last_seen_at: device.last_seen_at || null,
  last_sync_at: device.last_sync_at || null,
  updated_at: device.updated_at || null,
}));
const outboxByStatus = db.prepare(
  "SELECT LOWER(status) AS status, COUNT(*) AS count FROM sync_outbox GROUP BY LOWER(status) ORDER BY LOWER(status)"
).all().map((row) => ({ status: row.status, count: Number(row.count || 0) }));
const conflictsByStatus = db.prepare(
  "SELECT LOWER(resolution_status) AS status, COUNT(*) AS count FROM sync_conflicts GROUP BY LOWER(resolution_status) ORDER BY LOWER(resolution_status)"
).all().map((row) => ({ status: row.status, count: Number(row.count || 0) }));
const syncState = db.prepare(`
  SELECT device_id, last_push_at, last_pull_at, last_successful_sync_at,
         current_sync_status, last_server_cursor, last_pull_cursor, updated_at
  FROM sync_state
  ORDER BY updated_at DESC
`).all();

console.log(JSON.stringify({
  databasePath,
  recordCounts,
  timestampSummary: {
    populated: timestampAudit.reduce((sum, item) => sum + item.populated, 0),
    noncanonical: timestampAudit.reduce((sum, item) => sum + item.noncanonical, 0),
    columnsWithNoncanonicalValues: timestampAudit.filter((item) => item.noncanonical > 0),
  },
  offlineProfiles,
  devices,
  outboxByStatus,
  conflictsByStatus,
  syncState,
}, null, 2));

db.close();
