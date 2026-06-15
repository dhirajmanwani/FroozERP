use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const CURRENT_SCHEMA_VERSION: &str = "002_sync_engine_foundation";
const LOCAL_DB_FILE: &str = "froozerp-local.sqlite3";
const MIGRATION_001: &str = include_str!("../migrations/sqlite/001_local_foundation.sql");
const MIGRATION_002: &str = include_str!("../migrations/sqlite/002_sync_engine_foundation.sql");

#[derive(Debug, Serialize)]
pub struct LocalDbStatus {
    pub initialized: bool,
    pub database_path: String,
    pub schema_version: String,
    pub pending_operations: i64,
    pub failed_operations: i64,
    pub conflict_operations: i64,
    pub last_successful_sync_at: Option<String>,
    pub last_push_at: Option<String>,
    pub last_pull_at: Option<String>,
    pub current_cursor: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SyncOperation {
    pub id: String,
    pub operation_id: Option<String>,
    pub entity_type: String,
    pub entity_id: String,
    pub operation_type: String,
    pub payload: serde_json::Value,
    pub branch_id: Option<String>,
    pub device_id: Option<String>,
    pub user_id: Option<String>,
    pub version: Option<i64>,
    pub created_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PendingSyncOperation {
    pub id: String,
    pub operation_id: String,
    pub entity_type: String,
    pub entity_id: String,
    pub operation_type: String,
    pub branch_id: Option<String>,
    pub device_id: Option<String>,
    pub user_id: Option<String>,
    pub version: i64,
    pub payload: serde_json::Value,
    pub created_at: Option<String>,
    pub retry_count: i64,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct SyncAck {
    pub operation_id: String,
    pub status: String,
    pub server_entity_version: Option<i64>,
    pub server_updated_at: Option<String>,
    pub error_code: Option<String>,
    pub message: Option<String>,
    pub result_payload: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct PulledChange {
    pub change_id: i64,
    pub entity_type: String,
    pub entity_id: String,
    pub operation_type: String,
    pub version: Option<i64>,
    pub payload: serde_json::Value,
    pub updated_at: Option<String>,
}

pub fn initialize(app: &AppHandle) -> Result<LocalDbStatus, String> {
    let path = database_path(app)?;
    initialize_at(&path)?;
    status_at(&path)
}

pub fn status(app: &AppHandle) -> Result<LocalDbStatus, String> {
    let path = database_path(app)?;
    if !path.exists() {
        return Ok(LocalDbStatus {
            initialized: false,
            database_path: path_to_string(&path),
            schema_version: String::new(),
            pending_operations: 0,
            failed_operations: 0,
            conflict_operations: 0,
            last_successful_sync_at: None,
            last_push_at: None,
            last_pull_at: None,
            current_cursor: None,
            error: None,
        });
    }
    status_at(&path)
}

pub fn set_smoke_value(app: &AppHandle, value: &str) -> Result<(), String> {
    let path = database_path(app)?;
    initialize_at(&path)?;
    set_smoke_value_at(&path, value)
}

pub fn get_smoke_value(app: &AppHandle) -> Result<Option<String>, String> {
    let path = database_path(app)?;
    initialize_at(&path)?;
    get_smoke_value_at(&path)
}

pub fn enqueue_sync_operation(app: &AppHandle, operation: &SyncOperation) -> Result<i64, String> {
    let path = database_path(app)?;
    initialize_at(&path)?;
    let conn = Connection::open(path).map_err(to_error)?;
    enqueue_sync_operation_with_conn(&conn, operation)?;
    pending_outbox_count_at(&conn)
}

pub fn pending_outbox(app: &AppHandle, limit: i64) -> Result<Vec<PendingSyncOperation>, String> {
    let path = database_path(app)?;
    initialize_at(&path)?;
    let conn = Connection::open(path).map_err(to_error)?;
    pending_outbox_at(&conn, limit)
}

pub fn apply_push_acks(app: &AppHandle, acks: &[SyncAck]) -> Result<LocalDbStatus, String> {
    let path = database_path(app)?;
    initialize_at(&path)?;
    let mut conn = Connection::open(&path).map_err(to_error)?;
    let tx = conn.transaction().map_err(to_error)?;
    for ack in acks {
        let status = ack.status.to_lowercase();
        let server_ack = serde_json::to_string(ack).map_err(to_error)?;
        match status.as_str() {
            "accepted" | "success" | "synced" | "duplicate" => {
                tx.execute(
                    "UPDATE sync_outbox
                     SET status = 'synced', synced_at = datetime('now'), last_attempt_at = datetime('now'),
                         last_error = NULL, server_ack = ?2, entity_version = COALESCE(?3, entity_version)
                     WHERE operation_id = ?1",
                    params![ack.operation_id, server_ack, ack.server_entity_version],
                )
                .map_err(to_error)?;
            }
            "conflict" => {
                tx.execute(
                    "UPDATE sync_outbox
                     SET status = 'conflict', last_attempt_at = datetime('now'), last_error = ?2, server_ack = ?3
                     WHERE operation_id = ?1",
                    params![
                        ack.operation_id,
                        ack.message.clone().unwrap_or_else(|| "Conflict".to_string()),
                        server_ack
                    ],
                )
                .map_err(to_error)?;
                record_conflict_with_tx(&tx, ack)?;
            }
            _ => {
                tx.execute(
                    "UPDATE sync_outbox
                     SET status = 'failed', retry_count = retry_count + 1, last_attempt_at = datetime('now'),
                         last_error = ?2, server_ack = ?3
                     WHERE operation_id = ?1",
                    params![
                        ack.operation_id,
                        ack.message.clone().unwrap_or_else(|| "Sync operation failed".to_string()),
                        server_ack
                    ],
                )
                .map_err(to_error)?;
            }
        }
    }
    tx.execute(
        "INSERT INTO sync_state (device_id, last_push_at, last_successful_sync_at, current_sync_status, updated_at)
         VALUES ('default', datetime('now'), datetime('now'), 'IDLE', datetime('now'))
         ON CONFLICT(device_id) DO UPDATE SET
           last_push_at = excluded.last_push_at,
           last_successful_sync_at = excluded.last_successful_sync_at,
           current_sync_status = 'IDLE',
           updated_at = excluded.updated_at",
        [],
    )
    .map_err(to_error)?;
    tx.commit().map_err(to_error)?;
    status_at(&path)
}

pub fn apply_pull_changes(
    app: &AppHandle,
    changes: &[PulledChange],
    next_cursor: &str,
    device_id: Option<String>,
) -> Result<LocalDbStatus, String> {
    let path = database_path(app)?;
    initialize_at(&path)?;
    let mut conn = Connection::open(&path).map_err(to_error)?;
    let tx = conn.transaction().map_err(to_error)?;
    for change in changes {
        apply_change_with_tx(&tx, change)?;
    }
    let state_device = device_id.unwrap_or_else(|| "default".to_string());
    tx.execute(
        "INSERT INTO sync_state (
            device_id, last_server_cursor, last_pull_cursor, last_pull_at,
            last_successful_sync_at, current_sync_status, updated_at
         ) VALUES (?1, ?2, ?2, datetime('now'), datetime('now'), 'IDLE', datetime('now'))
         ON CONFLICT(device_id) DO UPDATE SET
           last_server_cursor = excluded.last_server_cursor,
           last_pull_cursor = excluded.last_pull_cursor,
           last_pull_at = excluded.last_pull_at,
           last_successful_sync_at = excluded.last_successful_sync_at,
           current_sync_status = 'IDLE',
           updated_at = excluded.updated_at",
        params![state_device, next_cursor],
    )
    .map_err(to_error)?;
    tx.commit().map_err(to_error)?;
    status_at(&path)
}

pub fn mark_sync_failed(app: &AppHandle, message: &str) -> Result<LocalDbStatus, String> {
    let path = database_path(app)?;
    initialize_at(&path)?;
    let conn = Connection::open(&path).map_err(to_error)?;
    conn.execute(
        "INSERT INTO sync_state (device_id, current_sync_status, last_error, updated_at)
         VALUES ('default', 'FAILED', ?1, datetime('now'))
         ON CONFLICT(device_id) DO UPDATE SET
           current_sync_status = 'FAILED',
           last_error = excluded.last_error,
           updated_at = excluded.updated_at",
        [message],
    )
    .map_err(to_error)?;
    status_at(&path)
}

pub fn queue_sync_test_entity(
    app: &AppHandle,
    entity_id: &str,
    value: &str,
    branch_id: Option<String>,
    device_id: Option<String>,
    user_id: Option<String>,
) -> Result<i64, String> {
    let path = database_path(app)?;
    initialize_at(&path)?;
    let mut conn = Connection::open(path).map_err(to_error)?;
    let tx = conn.transaction().map_err(to_error)?;
    tx.execute(
        "INSERT INTO local_sync_test_entities (id, branch_id, device_id, value, sync_status, updated_at)
         VALUES (?1, COALESCE(?2, '1'), ?3, ?4, 'pending', datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           value = excluded.value,
           branch_id = excluded.branch_id,
           device_id = excluded.device_id,
           sync_status = 'pending',
           updated_at = excluded.updated_at",
        params![entity_id, branch_id, device_id, value],
    )
    .map_err(to_error)?;
    let payload = serde_json::json!({ "id": entity_id, "value": value });
    let operation = SyncOperation {
        id: format!("op-{entity_id}"),
        operation_id: Some(format!("op-{entity_id}")),
        entity_type: "sync_test".to_string(),
        entity_id: entity_id.to_string(),
        operation_type: "UPSERT".to_string(),
        payload,
        branch_id,
        device_id,
        user_id,
        version: Some(1),
        created_at: None,
    };
    enqueue_sync_operation_with_conn(&tx, &operation)?;
    tx.commit().map_err(to_error)?;
    let conn = Connection::open(database_path(app)?).map_err(to_error)?;
    pending_outbox_count_at(&conn)
}

pub fn retry_failed_operations(app: &AppHandle) -> Result<LocalDbStatus, String> {
    let path = database_path(app)?;
    initialize_at(&path)?;
    let conn = Connection::open(&path).map_err(to_error)?;
    conn.execute(
        "UPDATE sync_outbox SET status = 'pending' WHERE status = 'failed'",
        [],
    )
    .map_err(to_error)?;
    status_at(&path)
}

fn enqueue_sync_operation_with_conn(conn: &Connection, operation: &SyncOperation) -> Result<(), String> {
    let payload = serde_json::to_string(&operation.payload).map_err(to_error)?;
    let operation_id = operation
        .operation_id
        .clone()
        .unwrap_or_else(|| operation.id.clone());
    conn.execute(
        "INSERT INTO sync_outbox (
            id, operation_id, entity_type, entity_id, operation_type, payload, payload_json,
            branch_id, device_id, user_id, version, entity_version, created_at, status
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8, ?9, ?10, ?10, COALESCE(?11, datetime('now')), 'pending')
         ON CONFLICT(operation_id) DO NOTHING",
        params![
            operation.id,
            operation_id,
            operation.entity_type,
            operation.entity_id,
            operation.operation_type,
            payload,
            operation.branch_id,
            operation.device_id,
            operation.user_id,
            operation.version.unwrap_or(1),
            operation.created_at
        ],
    )
    .map_err(to_error)?;
    Ok(())
}

pub fn pending_outbox_count(app: &AppHandle) -> Result<i64, String> {
    let path = database_path(app)?;
    initialize_at(&path)?;
    let conn = Connection::open(path).map_err(to_error)?;
    pending_outbox_count_at(&conn)
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_dir = app.path().app_data_dir().map_err(to_error)?;
    fs::create_dir_all(&app_dir).map_err(to_error)?;
    Ok(app_dir.join(LOCAL_DB_FILE))
}

fn initialize_at(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(to_error)?;
    }
    let mut conn = Connection::open(path).map_err(to_error)?;
    conn.pragma_update(None, "foreign_keys", "ON").map_err(to_error)?;
    conn.pragma_update(None, "journal_mode", "WAL").map_err(to_error)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS local_schema_migrations (
            version TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT (datetime('now')),
            checksum TEXT NOT NULL,
            status TEXT NOT NULL
        );",
    )
    .map_err(to_error)?;

    apply_migration(&mut conn, "001_local_foundation", MIGRATION_001)?;
    apply_migration(&mut conn, "002_sync_engine_foundation", MIGRATION_002)?;
    Ok(())
}

fn apply_migration(conn: &mut Connection, version: &str, sql: &str) -> Result<(), String> {
    let exists: Option<String> = conn
        .query_row(
            "SELECT version FROM local_schema_migrations WHERE version = ?1 AND status = 'APPLIED'",
            [version],
            |row| row.get(0),
        )
        .optional()
        .map_err(to_error)?;
    if exists.is_some() {
        return Ok(());
    }
    let tx = conn.transaction().map_err(to_error)?;
    tx.execute_batch(sql).map_err(to_error)?;
    tx.execute(
        "INSERT INTO local_schema_migrations (version, checksum, status) VALUES (?1, ?2, 'APPLIED')",
        params![version, checksum(sql)],
    )
    .map_err(to_error)?;
    tx.commit().map_err(to_error)
}

fn status_at(path: &Path) -> Result<LocalDbStatus, String> {
    initialize_at(path)?;
    let conn = Connection::open(path).map_err(to_error)?;
    let schema_version: Option<String> = conn
        .query_row(
            "SELECT version FROM local_schema_migrations WHERE status = 'APPLIED' ORDER BY applied_at DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(to_error)?;
    let last_sync: Option<String> = conn
        .query_row(
            "SELECT last_successful_sync_at FROM sync_state ORDER BY last_successful_sync_at DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(to_error)?;

    Ok(LocalDbStatus {
        initialized: true,
        database_path: path_to_string(path),
        schema_version: schema_version.unwrap_or_else(|| CURRENT_SCHEMA_VERSION.to_string()),
        pending_operations: count_outbox_status(&conn, &["pending", "syncing"])?,
        failed_operations: count_outbox_status(&conn, &["failed"])?,
        conflict_operations: count_outbox_status(&conn, &["conflict"])?,
        last_successful_sync_at: last_sync,
        last_push_at: single_optional_string(
            &conn,
            "SELECT last_push_at FROM sync_state ORDER BY updated_at DESC LIMIT 1",
        )?,
        last_pull_at: single_optional_string(
            &conn,
            "SELECT last_pull_at FROM sync_state ORDER BY updated_at DESC LIMIT 1",
        )?,
        current_cursor: single_optional_string(
            &conn,
            "SELECT COALESCE(last_pull_cursor, last_server_cursor) FROM sync_state ORDER BY updated_at DESC LIMIT 1",
        )?,
        error: None,
    })
}

fn set_smoke_value_at(path: &Path, value: &str) -> Result<(), String> {
    let conn = Connection::open(path).map_err(to_error)?;
    conn.execute(
        "INSERT INTO local_kv (key, value, updated_at)
         VALUES ('phase1_smoke_test', ?1, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        [value],
    )
    .map_err(to_error)?;
    Ok(())
}

fn get_smoke_value_at(path: &Path) -> Result<Option<String>, String> {
    let conn = Connection::open(path).map_err(to_error)?;
    conn.query_row(
        "SELECT value FROM local_kv WHERE key = 'phase1_smoke_test'",
        [],
        |row| row.get(0),
    )
    .optional()
    .map_err(to_error)
}

fn pending_outbox_count_at(conn: &Connection) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM sync_outbox WHERE LOWER(status) IN ('pending', 'failed')",
        [],
        |row| row.get(0),
    )
    .map_err(to_error)
}

fn count_outbox_status(conn: &Connection, statuses: &[&str]) -> Result<i64, String> {
    let quoted = statuses
        .iter()
        .map(|status| format!("'{}'", status.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!("SELECT COUNT(*) FROM sync_outbox WHERE LOWER(status) IN ({quoted})");
    conn.query_row(&sql, [], |row| row.get(0)).map_err(to_error)
}

fn single_optional_string(conn: &Connection, sql: &str) -> Result<Option<String>, String> {
    conn.query_row(sql, [], |row| row.get(0)).optional().map_err(to_error)
}

fn pending_outbox_at(conn: &Connection, limit: i64) -> Result<Vec<PendingSyncOperation>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, COALESCE(operation_id, id), entity_type, entity_id, operation_type,
                    branch_id, device_id, user_id, COALESCE(entity_version, version, 1),
                    COALESCE(payload_json, payload), created_at, retry_count
             FROM sync_outbox
             WHERE LOWER(status) IN ('pending', 'failed')
             ORDER BY created_at, id
             LIMIT ?1",
        )
        .map_err(to_error)?;
    let rows = statement
        .query_map([limit.max(1).min(100)], |row| {
            let payload_text: String = row.get(9)?;
            let payload = serde_json::from_str(&payload_text).unwrap_or_else(|_| serde_json::json!({}));
            Ok(PendingSyncOperation {
                id: row.get(0)?,
                operation_id: row.get(1)?,
                entity_type: row.get(2)?,
                entity_id: row.get(3)?,
                operation_type: row.get(4)?,
                branch_id: row.get(5)?,
                device_id: row.get(6)?,
                user_id: row.get(7)?,
                version: row.get(8)?,
                payload,
                created_at: row.get(10)?,
                retry_count: row.get(11)?,
            })
        })
        .map_err(to_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(to_error)
}

fn record_conflict_with_tx(tx: &rusqlite::Transaction, ack: &SyncAck) -> Result<(), String> {
    tx.execute(
        "INSERT INTO sync_conflicts (
            id, entity_type, entity_id, local_payload, server_payload,
            local_version, server_version, reason, status, resolution_status, detected_at
         )
         SELECT
            ?1, entity_type, entity_id, COALESCE(payload_json, payload), ?2,
            entity_version, ?3, ?4, 'open', 'OPEN', datetime('now')
         FROM sync_outbox
         WHERE operation_id = ?5
         ON CONFLICT(id) DO NOTHING",
        params![
            format!("conflict-{}", ack.operation_id),
            serde_json::to_string(&ack.result_payload).map_err(to_error)?,
            ack.server_entity_version,
            ack.message.clone().unwrap_or_else(|| "Server reported conflict".to_string()),
            ack.operation_id,
        ],
    )
    .map_err(to_error)?;
    Ok(())
}

fn apply_change_with_tx(tx: &rusqlite::Transaction, change: &PulledChange) -> Result<(), String> {
    let _change_id = change.change_id;
    let operation = change.operation_type.to_uppercase();
    match change.entity_type.as_str() {
        "product_category" => {
            if operation == "DELETE" {
                tx.execute(
                    "UPDATE local_categories SET deleted_at = COALESCE(?2, datetime('now')), sync_status = 'synced' WHERE id = ?1",
                    params![change.entity_id, change.updated_at],
                )
                .map_err(to_error)?;
            } else {
                tx.execute(
                    "INSERT INTO local_categories (id, cloud_id, branch_id, name, active, updated_at, version, sync_status, deleted_at)
                     VALUES (?1, ?1, ?2, ?3, ?4, COALESCE(?5, datetime('now')), ?6, 'synced', NULL)
                     ON CONFLICT(id) DO UPDATE SET
                       name = excluded.name,
                       active = excluded.active,
                       updated_at = excluded.updated_at,
                       version = excluded.version,
                       sync_status = 'synced',
                       deleted_at = NULL",
                    params![
                        change.entity_id,
                        change.payload.get("branch_id").and_then(|v| v.as_i64()).map(|v| v.to_string()).unwrap_or_else(|| "1".to_string()),
                        change.payload.get("category_name").and_then(|v| v.as_str()).unwrap_or("Unnamed"),
                        if change.payload.get("active").and_then(|v| v.as_bool()).unwrap_or(true) { 1 } else { 0 },
                        change.updated_at,
                        change.version.unwrap_or(1),
                    ],
                )
                .map_err(to_error)?;
            }
        }
        "product" | "sale_rate" => {
            tx.execute(
                "INSERT INTO local_products (
                    id, cloud_id, branch_id, product_name, category_id, category_name, unit,
                    barcode, sale_rate, minimum_stock, active, remarks, updated_at, version, sync_status, deleted_at
                 ) VALUES (?1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, COALESCE(?12, datetime('now')), ?13, 'synced', NULL)
                 ON CONFLICT(id) DO UPDATE SET
                   product_name = excluded.product_name,
                   category_id = excluded.category_id,
                   category_name = excluded.category_name,
                   unit = excluded.unit,
                   barcode = excluded.barcode,
                   sale_rate = excluded.sale_rate,
                   minimum_stock = excluded.minimum_stock,
                   active = excluded.active,
                   remarks = excluded.remarks,
                   updated_at = excluded.updated_at,
                   version = excluded.version,
                   sync_status = 'synced',
                   deleted_at = NULL",
                params![
                    change.entity_id,
                    change.payload.get("branch_id").and_then(|v| v.as_i64()).map(|v| v.to_string()).unwrap_or_else(|| "1".to_string()),
                    change.payload.get("product_name").and_then(|v| v.as_str()).unwrap_or("Unnamed"),
                    change.payload.get("category_id").and_then(|v| v.as_i64()).map(|v| v.to_string()),
                    change.payload.get("category").or_else(|| change.payload.get("category_name")).and_then(|v| v.as_str()),
                    change.payload.get("unit").and_then(|v| v.as_str()),
                    change.payload.get("barcode").and_then(|v| v.as_str()),
                    change.payload.get("selling_rate").or_else(|| change.payload.get("sale_rate")).and_then(|v| v.as_f64()),
                    change.payload.get("minimum_stock").and_then(|v| v.as_f64()),
                    if change.payload.get("active").and_then(|v| v.as_bool()).unwrap_or(true) { 1 } else { 0 },
                    change.payload.get("remarks").and_then(|v| v.as_str()),
                    change.updated_at,
                    change.version.unwrap_or(1),
                ],
            )
            .map_err(to_error)?;
        }
        "sync_test" => {
            tx.execute(
                "INSERT INTO local_sync_test_entities (id, branch_id, device_id, value, server_version, sync_status, updated_at, deleted_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'synced', COALESCE(?6, datetime('now')), NULL)
                 ON CONFLICT(id) DO UPDATE SET
                   value = excluded.value,
                   server_version = excluded.server_version,
                   sync_status = 'synced',
                   updated_at = excluded.updated_at,
                   deleted_at = NULL",
                params![
                    change.entity_id,
                    change.payload.get("branch_id").and_then(|v| v.as_i64()).map(|v| v.to_string()).unwrap_or_else(|| "1".to_string()),
                    change.payload.get("device_id").and_then(|v| v.as_str()),
                    change.payload.get("value").and_then(|v| v.as_str()).unwrap_or(""),
                    change.version.unwrap_or(1),
                    change.updated_at,
                ],
            )
            .map_err(to_error)?;
        }
        _ => {}
    }
    Ok(())
}

fn checksum(input: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in input.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn to_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_db_persists_smoke_value_after_reopen() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-phase1-{}.sqlite3",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);

        initialize_at(&path).expect("initialize local db");
        set_smoke_value_at(&path, "survives-restart").expect("write smoke value");
        drop(Connection::open(&path).expect("open and drop sqlite handle"));

        initialize_at(&path).expect("reinitialize local db");
        let value = get_smoke_value_at(&path).expect("read smoke value");
        assert_eq!(value.as_deref(), Some("survives-restart"));

        let _ = fs::remove_file(&path);
    }
}
