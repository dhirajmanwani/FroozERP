const { Pool } = require("../backend/node_modules/pg");

const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");

const pool = new Pool({ connectionString });
const timestampNames = [
  "created_at", "updated_at", "deleted_at", "pushed_at", "pulled_at",
  "last_sync_at", "last_push_at", "last_pull_at", "last_successful_sync_at",
  "last_synced_at", "last_attempt_at", "processed_at", "received_at",
  "detected_at", "resolved_at", "last_seen_at",
];
const businessTables = [
  "product_categories", "products", "inventory_batches", "customers", "sales",
  "sale_items", "stock_movements", "purchases", "purchase_items", "accounts",
  "expenses", "sale_returns", "waste_entries", "business_settings",
  "sync_processed_operations", "sync_change_log", "sync_conflict_log",
];

const quoteIdentifier = (value) => `"${String(value).replace(/"/g, '""')}"`;

async function main() {
  const time = await pool.query(`
    SELECT clock_timestamp() AS server_time,
           current_setting('TIMEZONE') AS session_timezone,
           EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS server_epoch_ms
  `);
  const users = await pool.query(`
    SELECT
      u.id AS user_id,
      u.username,
      UPPER(TRIM(r.role_name)) AS normalized_role,
      (to_jsonb(u)->>'company_id')::integer AS company_id,
      (to_jsonb(u)->>'branch_id')::integer AS branch_id,
      u.active,
      (to_jsonb(u)->>'created_at')::timestamptz AS created_at,
      (to_jsonb(u)->>'updated_at')::timestamptz AS updated_at
    FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE LOWER(u.username) IN ('owner', 'dhirajmanwani')
    ORDER BY LOWER(u.username)
  `);
  const timestampColumns = await pool.query(`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name = ANY($1::text[])
    ORDER BY table_name, ordinal_position
  `, [timestampNames]);
  const existingTables = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY($1::text[])
  `, [businessTables]);
  const recordCounts = {};
  for (const { table_name: tableName } of existingTables.rows) {
    const result = await pool.query(`SELECT COUNT(*)::bigint AS count FROM ${quoteIdentifier(tableName)}`);
    recordCounts[tableName] = Number(result.rows[0].count || 0);
  }
  const deviceId = String(process.argv[2] || "").trim();
  const device = deviceId
    ? await pool.query(`
        SELECT device_id, status,
               (to_jsonb(d)->>'company_id')::integer AS company_id,
               (to_jsonb(d)->>'assigned_branch_id')::integer AS branch_id,
               to_jsonb(d)->>'app_version' AS app_version,
               (to_jsonb(d)->>'last_active_at')::timestamptz AS last_active_at,
               (to_jsonb(d)->>'last_sync_at')::timestamptz AS last_sync_at,
               to_jsonb(d)->>'sync_status' AS sync_status,
               (to_jsonb(d)->>'created_at')::timestamptz AS created_at,
               (to_jsonb(d)->>'updated_at')::timestamptz AS updated_at
        FROM authorized_devices d
        WHERE device_id = $1
      `, [deviceId])
    : { rows: [] };
  console.log(JSON.stringify({
    serverTime: time.rows[0],
    timestampColumns: timestampColumns.rows,
    timestampSummary: {
      total: timestampColumns.rows.length,
      withoutTimeZone: timestampColumns.rows.filter((row) => row.data_type === "timestamp without time zone").length,
      withTimeZone: timestampColumns.rows.filter((row) => row.data_type === "timestamp with time zone").length,
    },
    recordCounts,
    users: users.rows.map((user) => ({ ...user, authentication_source: "cloud_postgresql" })),
    device: device.rows[0] || null,
  }, null, 2));
}

main().finally(() => pool.end());
