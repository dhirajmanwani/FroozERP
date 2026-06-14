use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const CURRENT_SCHEMA_VERSION: &str = "001_local_foundation";
const LOCAL_DB_FILE: &str = "froozerp-local.sqlite3";
const MIGRATION_001: &str = include_str!("../migrations/sqlite/001_local_foundation.sql");

#[derive(Debug, Serialize)]
pub struct LocalDbStatus {
    pub initialized: bool,
    pub database_path: String,
    pub schema_version: String,
    pub pending_operations: i64,
    pub last_successful_sync_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SyncOperation {
    pub id: String,
    pub entity_type: String,
    pub entity_id: String,
    pub operation_type: String,
    pub payload: serde_json::Value,
    pub branch_id: Option<String>,
    pub device_id: Option<String>,
    pub version: Option<i64>,
    pub created_at: Option<String>,
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
            last_successful_sync_at: None,
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
    let payload = serde_json::to_string(&operation.payload).map_err(to_error)?;
    conn.execute(
        "INSERT INTO sync_outbox (
            id, entity_type, entity_id, operation_type, payload,
            branch_id, device_id, version, created_at, status
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, COALESCE(?9, datetime('now')), 'PENDING')",
        params![
            operation.id,
            operation.entity_type,
            operation.entity_id,
            operation.operation_type,
            payload,
            operation.branch_id,
            operation.device_id,
            operation.version.unwrap_or(1),
            operation.created_at
        ],
    )
    .map_err(to_error)?;
    pending_outbox_count_at(conn)
}

pub fn pending_outbox_count(app: &AppHandle) -> Result<i64, String> {
    let path = database_path(app)?;
    initialize_at(&path)?;
    let conn = Connection::open(path).map_err(to_error)?;
    pending_outbox_count_at(conn)
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

    let exists: Option<String> = conn
        .query_row(
            "SELECT version FROM local_schema_migrations WHERE version = ?1 AND status = 'APPLIED'",
            [CURRENT_SCHEMA_VERSION],
            |row| row.get(0),
        )
        .optional()
        .map_err(to_error)?;

    if exists.is_none() {
        let tx = conn.transaction().map_err(to_error)?;
        tx.execute_batch(MIGRATION_001).map_err(to_error)?;
        tx.execute(
            "INSERT INTO local_schema_migrations (version, checksum, status) VALUES (?1, ?2, 'APPLIED')",
            params![CURRENT_SCHEMA_VERSION, checksum(MIGRATION_001)],
        )
        .map_err(to_error)?;
        tx.commit().map_err(to_error)?;
    }
    Ok(())
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
        schema_version: schema_version.unwrap_or_default(),
        pending_operations: pending_outbox_count_at(conn)?,
        last_successful_sync_at: last_sync,
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

fn pending_outbox_count_at(conn: Connection) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM sync_outbox WHERE status IN ('PENDING', 'FAILED')",
        [],
        |row| row.get(0),
    )
    .map_err(to_error)
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
