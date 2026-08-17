use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

use crate::entitlement::{self, EntitlementState};

const CURRENT_SCHEMA_VERSION: &str = "018_bootstrap_credential_consumption";
const LOCAL_DB_FILE: &str = "froozerp-local.sqlite3";
const MIGRATION_001: &str = include_str!("../migrations/sqlite/001_local_foundation.sql");
const MIGRATION_002: &str = include_str!("../migrations/sqlite/002_sync_engine_foundation.sql");
const MIGRATION_003: &str = include_str!("../migrations/sqlite/003_local_first_pos.sql");
const MIGRATION_004: &str = include_str!("../migrations/sqlite/004_offline_sale_edit_cancel.sql");
const MIGRATION_005: &str = include_str!("../migrations/sqlite/005_mandi_tax_sale_details.sql");
const MIGRATION_006: &str = include_str!("../migrations/sqlite/006_multibranch_identity_foundation.sql");
const MIGRATION_007: &str = include_str!("../migrations/sqlite/007_cloud_runtime_and_inbox_foundation.sql");
const MIGRATION_009: &str = include_str!("../migrations/sqlite/009_canonical_utc_timestamps.sql");
const MIGRATION_010: &str = include_str!("../migrations/sqlite/010_sync_delivery_state.sql");
const MIGRATION_011: &str = include_str!("../migrations/sqlite/011_connectivity_mode_audit.sql");
const MIGRATION_012: &str = include_str!("../migrations/sqlite/012_connectivity_mode_server_time.sql");
const MIGRATION_013: &str = include_str!("../migrations/sqlite/013_operational_location_foundation.sql");
const MIGRATION_014: &str = include_str!("../migrations/sqlite/014_offline_purchase_grn.sql");
const MIGRATION_015: &str = include_str!("../migrations/sqlite/015_supplier_reference_cache.sql");
const MIGRATION_016: &str = include_str!("../migrations/sqlite/016_purchase_aggregate_reconciliation.sql");
const MIGRATION_017: &str = include_str!("../migrations/sqlite/017_offline_entitlement_foundation.sql");
const MIGRATION_018: &str = include_str!("../migrations/sqlite/018_bootstrap_credential_consumption.sql");

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
    pub last_push_result: Option<String>,
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
    pub status: String,
    pub last_error: Option<String>,
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
    pub change_id: serde_json::Value,
    pub branch_id: Option<i64>,
    pub entity_type: String,
    pub entity_id: String,
    pub operation_type: String,
    pub version: Option<i64>,
    pub payload: serde_json::Value,
    pub updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ReferenceBootstrap {
    pub protocol: String,
    pub high_watermark: String,
    pub device_id: String,
    pub company_id: i64,
    pub branch_id: i64,
    pub operational_location_id: i64,
    pub assignment_generation: i64,
    pub operational_location: serde_json::Value,
    pub device_assignment: serde_json::Value,
    pub location_products: Vec<serde_json::Value>,
    pub records: Vec<PulledChange>,
}

#[derive(Debug, Serialize)]
pub struct LocalPosSaleResult {
    pub invoice: serde_json::Value,
    pub pending_operations: i64,
}

#[derive(Debug, Serialize)]
pub struct LocalPurchaseIntentResult {
    pub intent: serde_json::Value,
    pub pending_operations: i64,
}

pub fn ensure_device_identity(
    app: &AppHandle,
    preferred_device_id: Option<&str>,
) -> Result<serde_json::Value, String> {
    let path = database_path(app)?;
    initialize_at(&path)?;
    ensure_device_identity_with_preference_at(&path, preferred_device_id)
}

pub fn cache_reference_snapshot(app: &AppHandle, snapshot: &serde_json::Value) -> Result<LocalDbStatus, String> {
    let path = database_path(app)?;
    initialize_at(&path)?;
    cache_reference_snapshot_at(&path, snapshot)?;
    status_at(&path)
}

pub fn cache_reference_snapshot_path(path: &Path, snapshot: &serde_json::Value) -> Result<LocalDbStatus, String> {
    initialize_at(path)?;
    cache_reference_snapshot_at(path, snapshot)?;
    status_at(path)
}

pub fn load_reference_snapshot(
    app: &AppHandle,
    username: Option<&str>,
    device_id: Option<&str>,
) -> Result<serde_json::Value, String> {
    let path = database_path(app)?;
    load_reference_snapshot_at(&path, username, device_id)
}

pub fn load_reference_snapshot_path(
    path: &Path,
    username: Option<&str>,
    device_id: Option<&str>,
) -> Result<serde_json::Value, String> {
    load_reference_snapshot_at(path, username, device_id)
}

pub fn initialize(app: &AppHandle) -> Result<LocalDbStatus, String> {
    let path = database_path(app)?;
    initialize_at(&path)?;
    status_at(&path)
}

pub fn initialize_path(path: &Path) -> Result<LocalDbStatus, String> {
    initialize_at(path)?;
    status_at(path)
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
            last_push_result: None,
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

pub fn apply_push_acks(app: &AppHandle, acks: &[SyncAck], device_id: Option<String>, server_time: Option<String>) -> Result<LocalDbStatus, String> {
    let path = database_path(app)?;
    initialize_at(&path)?;
    let mut conn = Connection::open(&path).map_err(to_error)?;
    let tx = conn.transaction().map_err(to_error)?;
    let confirmed_at = require_server_time(server_time)?;
    for ack in acks {
        let status = ack.status.to_lowercase();
        let server_ack = serde_json::to_string(ack).map_err(to_error)?;
        match status.as_str() {
            "accepted" | "success" | "synced" | "duplicate" => {
                tx.execute(
                    "UPDATE sync_outbox
                     SET status = 'synced', synced_at = ?4, last_attempt_at = ?4,
                         last_error = NULL, server_ack = ?2, entity_version = COALESCE(?3, entity_version)
                     WHERE operation_id = ?1",
                    params![ack.operation_id, server_ack, ack.server_entity_version, confirmed_at],
                )
                .map_err(to_error)?;
                tx.execute(
                    "UPDATE local_pos_invoices
                     SET sync_status = 'synced',
                         server_invoice_no = json_extract(?2, '$.result_payload.invoice_no'),
                         server_sale_id = json_extract(?2, '$.result_payload.sale_id'),
                         synced_at = ?4,
                         updated_at = ?4,
                         entity_version = COALESCE(?3, entity_version)
                     WHERE id = (SELECT entity_id FROM sync_outbox WHERE operation_id = ?1 AND entity_type = 'pos_sale')",
                    params![ack.operation_id, server_ack, ack.server_entity_version, confirmed_at],
                )
                .map_err(to_error)?;
                apply_purchase_ack_with_tx(&tx, ack, "completed", &server_ack, &confirmed_at)?;
            }
            "conflict" => {
                tx.execute(
                    "UPDATE sync_outbox
                     SET status = 'conflict', last_attempt_at = ?4, last_error = ?2, server_ack = ?3
                     WHERE operation_id = ?1",
                    params![
                        ack.operation_id,
                        ack.message.clone().unwrap_or_else(|| "Conflict".to_string()),
                        server_ack,
                        confirmed_at
                    ],
                )
                .map_err(to_error)?;
                tx.execute(
                    "UPDATE local_pos_invoices
                     SET sync_status = 'conflict', updated_at = ?2
                     WHERE id = (SELECT entity_id FROM sync_outbox WHERE operation_id = ?1 AND entity_type = 'pos_sale')",
                    params![ack.operation_id, confirmed_at],
                )
                .map_err(to_error)?;
                apply_purchase_ack_with_tx(&tx, ack, "conflict", &server_ack, &confirmed_at)?;
                record_conflict_with_tx(&tx, ack)?;
            }
            _ => {
                tx.execute(
                    "UPDATE sync_outbox
                     SET status = 'failed', retry_count = retry_count + 1, last_attempt_at = ?4,
                         last_error = ?2, server_ack = ?3
                     WHERE operation_id = ?1",
                    params![
                        ack.operation_id,
                        ack.message.clone().unwrap_or_else(|| "Sync operation failed".to_string()),
                        server_ack,
                        confirmed_at
                    ],
                )
                .map_err(to_error)?;
                tx.execute(
                    "UPDATE local_pos_invoices
                     SET sync_status = 'failed', updated_at = ?2
                     WHERE id = (SELECT entity_id FROM sync_outbox WHERE operation_id = ?1 AND entity_type = 'pos_sale')",
                    params![ack.operation_id, confirmed_at],
                )
                .map_err(to_error)?;
                apply_purchase_ack_with_tx(&tx, ack, "failed", &server_ack, &confirmed_at)?;
            }
        }
    }
    tx.execute(
        "INSERT INTO sync_state (device_id, last_push_at, last_push_result, current_sync_status, updated_at)
         VALUES (?1, ?2, 'ACKNOWLEDGED', 'IDLE', ?2)
         ON CONFLICT(device_id) DO UPDATE SET
           last_push_at = excluded.last_push_at,
           last_push_result = excluded.last_push_result,
           current_sync_status = 'IDLE',
           updated_at = excluded.updated_at",
        params![device_id.unwrap_or_else(|| "default".to_string()), confirmed_at],
    )
    .map_err(to_error)?;
    tx.commit().map_err(to_error)?;
    status_at(&path)
}

pub fn database_audit(app: &AppHandle) -> Result<serde_json::Value, String> {
    let path = database_path(app)?;
    initialize_at(&path)?;
    let conn = Connection::open(&path).map_err(to_error)?;
    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |row| row.get(0)).map_err(to_error)?;
    let count = |table: &str| -> Result<i64, String> {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0)).map_err(to_error)
    };
    let sellable_lots: i64 = conn.query_row(
        "SELECT COUNT(*) FROM local_inventory_lots
         WHERE deleted_at IS NULL
           AND balance_qty > 0
           AND UPPER(COALESCE(status, 'ACTIVE')) NOT IN ('CANCELLED', 'INACTIVE')",
        [],
        |row| row.get(0),
    ).map_err(to_error)?;
    let stock_value: f64 = conn.query_row(
        "SELECT COALESCE(SUM(balance_qty * cost_rate), 0) FROM local_inventory_lots WHERE deleted_at IS NULL",
        [],
        |row| row.get(0),
    ).map_err(to_error)?;
    Ok(serde_json::json!({
        "database_path": path_to_string(&path),
        "integrity": integrity,
        "products": count("local_products")?,
        "inventory_lots": count("local_inventory_lots")?,
        "sellable_lots": sellable_lots,
        "categories": count("local_categories")?,
        "customers": count("local_customers")?,
        "invoices": count("local_pos_invoices")?,
        "invoice_items": count("local_pos_invoice_items")?,
        "payments": count("local_payment_postings")?,
        "stock_movements": count("local_stock_movements")?,
        "outbox": count("sync_outbox")?,
        "conflicts": count("sync_conflicts")?,
        "stock_value": stock_value,
    }))
}

pub fn record_connectivity_mode_change(
    app: &AppHandle,
    user_id: &str,
    username: Option<&str>,
    role: &str,
    device_id: &str,
    previous_mode: &str,
    next_mode: &str,
    server_confirmed_at: &str,
    time_source: &str,
) -> Result<(), String> {
    if role.trim().to_uppercase() != "OWNER" {
        return Err("Only Owner may change Connectivity Mode.".to_string());
    }
    let path = database_path(app)?;
    initialize_at(&path)?;
    let conn = Connection::open(path).map_err(to_error)?;
    conn.execute(
        "INSERT INTO local_connectivity_mode_audit (
           id, user_id, username, role, device_id, previous_mode, next_mode,
           changed_at, server_confirmed_at, time_source
         ) VALUES (?1, ?2, ?3, 'OWNER', ?4, ?5, ?6, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?7, ?8)",
        params![unique_local_id("connectivity-mode"), user_id, username, device_id, previous_mode, next_mode, server_confirmed_at, time_source],
    ).map_err(to_error)?;
    Ok(())
}

pub fn record_sync_cycle_completed(app: &AppHandle, device_id: &str, server_time: Option<String>, push_result: &str) -> Result<LocalDbStatus, String> {
    let path = database_path(app)?;
    initialize_at(&path)?;
    let confirmed_at = require_server_time(server_time)?;
    let conn = Connection::open(&path).map_err(to_error)?;
    conn.execute(
        "INSERT INTO sync_state (device_id, last_successful_sync_at, last_push_result, current_sync_status, updated_at)
         VALUES (?1, ?2, ?3, 'IDLE', ?2)
         ON CONFLICT(device_id) DO UPDATE SET
           last_successful_sync_at = excluded.last_successful_sync_at,
           last_push_result = excluded.last_push_result,
           current_sync_status = 'IDLE',
           updated_at = excluded.updated_at",
        params![device_id, confirmed_at, push_result],
    ).map_err(to_error)?;
    status_at(&path)
}

pub fn apply_pull_changes(
    app: &AppHandle,
    changes: &[PulledChange],
    next_cursor: &str,
    device_id: Option<String>,
    server_time: Option<String>,
) -> Result<LocalDbStatus, String> {
    let path = database_path(app)?;
    initialize_at(&path)?;
    apply_pull_changes_at(&path, changes, next_cursor, device_id, server_time)?;
    status_at(&path)
}

fn apply_pull_changes_at(
    path: &Path,
    changes: &[PulledChange],
    next_cursor: &str,
    device_id: Option<String>,
    server_time: Option<String>,
) -> Result<(), String> {
    let mut conn = Connection::open(&path).map_err(to_error)?;
    let tx = conn.transaction().map_err(to_error)?;
    let confirmed_at = require_server_time(server_time)?;
    for change in changes {
        apply_change_with_tx(&tx, change)?;
    }
    let state_device = device_id.unwrap_or_else(|| "default".to_string());
    tx.execute(
        "INSERT INTO sync_state (
            device_id, last_server_cursor, last_pull_cursor, last_pull_at,
            current_sync_status, updated_at
         ) VALUES (?1, ?2, ?2, ?3, 'IDLE', ?3)
         ON CONFLICT(device_id) DO UPDATE SET
           last_server_cursor = excluded.last_server_cursor,
           last_pull_cursor = excluded.last_pull_cursor,
           last_pull_at = excluded.last_pull_at,
           current_sync_status = 'IDLE',
           updated_at = excluded.updated_at",
        params![state_device, next_cursor, confirmed_at],
    )
    .map_err(to_error)?;
    tx.commit().map_err(to_error)
}

pub fn apply_reference_bootstrap(
    app: &AppHandle,
    bootstrap: &ReferenceBootstrap,
    expected_device_id: &str,
    server_time: Option<String>,
) -> Result<LocalDbStatus, String> {
    let path = database_path(app)?;
    initialize_at(&path)?;
    apply_reference_bootstrap_at(&path, bootstrap, expected_device_id, server_time)?;
    status_at(&path)
}

fn apply_reference_bootstrap_at(
    path: &Path,
    bootstrap: &ReferenceBootstrap,
    expected_device_id: &str,
    server_time: Option<String>,
) -> Result<(), String> {
    if bootstrap.protocol != "reference-v1" {
        return Err("Unsupported reference bootstrap protocol".to_string());
    }
    if bootstrap.device_id != expected_device_id {
        return Err("Reference bootstrap device identity does not match this device".to_string());
    }
    if bootstrap.company_id <= 0
        || bootstrap.branch_id <= 0
        || bootstrap.operational_location_id <= 0
        || bootstrap.assignment_generation <= 0
    {
        return Err("Reference bootstrap canonical scope is incomplete".to_string());
    }
    let confirmed_at = require_server_time(server_time)?;
    let mut conn = Connection::open(path).map_err(to_error)?;
    let tx = conn.transaction().map_err(to_error)?;

    let location_id = optional_text(&bootstrap.operational_location, "id")
        .ok_or_else(|| "Reference bootstrap operational location has no identity".to_string())?;
    if location_id != bootstrap.operational_location_id.to_string() {
        return Err("Reference bootstrap operational location does not match canonical scope".to_string());
    }
    tx.execute(
        "INSERT INTO local_operational_locations (
           id, company_id, branch_id, location_code, location_name, location_type,
           timezone, active, is_default, assignment_generation, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET
           company_id = excluded.company_id,
           branch_id = excluded.branch_id,
           location_code = excluded.location_code,
           location_name = excluded.location_name,
           location_type = excluded.location_type,
           timezone = excluded.timezone,
           active = excluded.active,
           is_default = excluded.is_default,
           assignment_generation = excluded.assignment_generation,
           updated_at = excluded.updated_at",
        params![
            location_id,
            bootstrap.company_id.to_string(),
            bootstrap.branch_id.to_string(),
            optional_text(&bootstrap.operational_location, "location_code").unwrap_or_else(|| "LOCATION".to_string()),
            optional_text(&bootstrap.operational_location, "location_name").unwrap_or_else(|| "Operational Location".to_string()),
            optional_text(&bootstrap.operational_location, "location_type").unwrap_or_else(|| "STORE".to_string()),
            optional_text(&bootstrap.operational_location, "timezone").unwrap_or_else(|| "Asia/Kolkata".to_string()),
            if bootstrap.operational_location.get("active").and_then(|value| value.as_bool()).unwrap_or(true) { 1 } else { 0 },
            if bootstrap.operational_location.get("is_default").and_then(|value| value.as_bool()).unwrap_or(false) { 1 } else { 0 },
            bootstrap.assignment_generation,
            optional_text(&bootstrap.operational_location, "updated_at").unwrap_or_else(|| confirmed_at.clone()),
        ],
    )
    .map_err(to_error)?;

    let assignment_device = optional_text(&bootstrap.device_assignment, "device_id")
        .ok_or_else(|| "Reference bootstrap device assignment has no device identity".to_string())?;
    if assignment_device != bootstrap.device_id {
        return Err("Reference bootstrap assignment does not match canonical device".to_string());
    }
    tx.execute(
        "INSERT INTO local_device_assignment (
           device_id, company_id, branch_id, operational_location_id, intended_usage,
           fixed_operational, permission_set_json, assignment_generation, active, server_confirmed_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(device_id) DO UPDATE SET
           company_id = excluded.company_id,
           branch_id = excluded.branch_id,
           operational_location_id = excluded.operational_location_id,
           intended_usage = excluded.intended_usage,
           fixed_operational = excluded.fixed_operational,
           permission_set_json = excluded.permission_set_json,
           assignment_generation = excluded.assignment_generation,
           active = excluded.active,
           server_confirmed_at = excluded.server_confirmed_at",
        params![
            bootstrap.device_id,
            bootstrap.company_id.to_string(),
            bootstrap.branch_id.to_string(),
            bootstrap.operational_location_id.to_string(),
            optional_text(&bootstrap.device_assignment, "intended_usage").unwrap_or_else(|| "GENERAL".to_string()),
            if bootstrap.device_assignment.get("fixed_operational").and_then(|value| value.as_bool()).unwrap_or(true) { 1 } else { 0 },
            serde_json::to_string(bootstrap.device_assignment.get("permission_set").unwrap_or(&serde_json::json!({}))).map_err(to_error)?,
            bootstrap.assignment_generation,
            if bootstrap.device_assignment.get("active").and_then(|value| value.as_bool()).unwrap_or(true) { 1 } else { 0 },
            confirmed_at,
        ],
    )
    .map_err(to_error)?;

    for change in &bootstrap.records {
        let payload_company = change.payload.get("company_id").and_then(json_number).map(|value| value as i64);
        if payload_company != Some(bootstrap.company_id) {
            return Err(format!("Reference record {} has invalid company scope", change.entity_id));
        }
        if change.entity_type == "inventory_lot" {
            let payload_branch = change.payload.get("branch_id").and_then(json_number).map(|value| value as i64);
            let payload_location = change.payload.get("operational_location_id").and_then(json_number).map(|value| value as i64);
            if payload_branch != Some(bootstrap.branch_id)
                || payload_location != Some(bootstrap.operational_location_id)
            {
                return Err(format!("Inventory lot {} is outside the canonical device scope", change.entity_id));
            }
        }
        apply_change_with_tx(&tx, change)?;
    }

    for location_product in &bootstrap.location_products {
        let location_product_location = optional_text(location_product, "operational_location_id")
            .ok_or_else(|| "Location product has no operational location".to_string())?;
        if location_product_location != bootstrap.operational_location_id.to_string() {
            return Err("Location product is outside the canonical device scope".to_string());
        }
        let product_id = optional_text(location_product, "product_id")
            .ok_or_else(|| "Location product has no product identity".to_string())?;
        tx.execute(
            "INSERT INTO local_operational_location_products (
               operational_location_id, product_id, enabled, pos_available,
               selling_rate, reorder_level, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(operational_location_id, product_id) DO UPDATE SET
               enabled = excluded.enabled,
               pos_available = excluded.pos_available,
               selling_rate = excluded.selling_rate,
               reorder_level = excluded.reorder_level,
               updated_at = excluded.updated_at",
            params![
                location_product_location,
                product_id,
                if location_product.get("enabled").and_then(|value| value.as_bool()).unwrap_or(true) { 1 } else { 0 },
                if location_product.get("pos_available").and_then(|value| value.as_bool()).unwrap_or(true) { 1 } else { 0 },
                location_product.get("selling_rate").and_then(json_number),
                location_product.get("reorder_level").and_then(json_number).unwrap_or(0.0),
                optional_text(location_product, "updated_at").unwrap_or_else(|| confirmed_at.clone()),
            ],
        )
        .map_err(to_error)?;
    }

    let bootstrap_meta = serde_json::json!({
        "protocol": bootstrap.protocol,
        "device_id": bootstrap.device_id,
        "company_id": bootstrap.company_id,
        "branch_id": bootstrap.branch_id,
        "operational_location_id": bootstrap.operational_location_id,
        "assignment_generation": bootstrap.assignment_generation,
        "high_watermark": bootstrap.high_watermark,
        "server_confirmed_at": confirmed_at,
    });
    tx.execute(
        "INSERT INTO local_kv (key, value, updated_at)
         VALUES ('reference_bootstrap_meta', ?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![serde_json::to_string(&bootstrap_meta).map_err(to_error)?, confirmed_at],
    )
    .map_err(to_error)?;
    tx.execute(
        "INSERT INTO sync_state (
           device_id, last_server_cursor, last_pull_cursor, last_pull_at,
           operational_location_id, assignment_generation, current_sync_status, updated_at
         ) VALUES (?1, ?2, ?2, ?3, ?4, ?5, 'IDLE', ?3)
         ON CONFLICT(device_id) DO UPDATE SET
           last_server_cursor = excluded.last_server_cursor,
           last_pull_cursor = excluded.last_pull_cursor,
           last_pull_at = excluded.last_pull_at,
           operational_location_id = excluded.operational_location_id,
           assignment_generation = excluded.assignment_generation,
           current_sync_status = 'IDLE',
           last_error = NULL,
           updated_at = excluded.updated_at",
        params![
            bootstrap.device_id,
            bootstrap.high_watermark,
            confirmed_at,
            bootstrap.operational_location_id.to_string(),
            bootstrap.assignment_generation,
        ],
    )
    .map_err(to_error)?;
    tx.commit().map_err(to_error)
}

pub fn mark_sync_failed(app: &AppHandle, message: &str) -> Result<LocalDbStatus, String> {
    let path = database_path(app)?;
    initialize_at(&path)?;
    let conn = Connection::open(&path).map_err(to_error)?;
    conn.execute(
        "INSERT INTO sync_state (device_id, current_sync_status, last_error, updated_at)
         VALUES ('default', 'FAILED', ?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
         VALUES (?1, COALESCE(?2, '1'), ?3, ?4, 'pending', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
    conn.execute(
        "UPDATE local_purchase_intents
         SET state = 'pending', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE state = 'failed'",
        [],
    )
    .map_err(to_error)?;
    status_at(&path)
}

pub fn mark_outbox_syncing(app: &AppHandle, operation_ids: &[String]) -> Result<LocalDbStatus, String> {
    let path = database_path(app)?;
    mark_outbox_syncing_at(&path, operation_ids)
}

fn mark_outbox_syncing_at(path: &Path, operation_ids: &[String]) -> Result<LocalDbStatus, String> {
    initialize_at(&path)?;
    let mut conn = Connection::open(&path).map_err(to_error)?;
    let tx = conn.transaction().map_err(to_error)?;
    for operation_id in operation_ids {
        tx.execute(
            "UPDATE sync_outbox
             SET status = 'syncing', last_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE operation_id = ?1 AND status IN ('pending', 'failed')",
            [operation_id],
        )
        .map_err(to_error)?;
        tx.execute(
            "UPDATE local_purchase_intents
             SET state = 'syncing', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE operation_id = ?1 AND state IN ('pending', 'failed')",
            [operation_id],
        )
        .map_err(to_error)?;
    }
    tx.commit().map_err(to_error)?;
    status_at(&path)
}

pub fn release_syncing_operations(
    app: &AppHandle,
    operation_ids: &[String],
    message: Option<String>,
) -> Result<LocalDbStatus, String> {
    let path = database_path(app)?;
    release_syncing_operations_at(&path, operation_ids, message)
}

fn release_syncing_operations_at(
    path: &Path,
    operation_ids: &[String],
    message: Option<String>,
) -> Result<LocalDbStatus, String> {
    initialize_at(&path)?;
    let mut conn = Connection::open(&path).map_err(to_error)?;
    let tx = conn.transaction().map_err(to_error)?;
    for operation_id in operation_ids {
        tx.execute(
            "UPDATE sync_outbox
             SET status = 'pending', last_error = ?2
             WHERE operation_id = ?1 AND status = 'syncing'",
            params![operation_id, message],
        )
        .map_err(to_error)?;
        tx.execute(
            "UPDATE local_purchase_intents
             SET state = 'pending', last_error = ?2,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE operation_id = ?1 AND state = 'syncing'",
            params![operation_id, message],
        )
        .map_err(to_error)?;
    }
    tx.commit().map_err(to_error)?;
    status_at(&path)
}

pub fn complete_local_pos_sale(app: &AppHandle, sale: serde_json::Value) -> Result<LocalPosSaleResult, String> {
    let path = database_path(app)?;
    complete_local_pos_sale_at(&path, sale)
}

pub fn edit_local_pos_sale(app: &AppHandle, edit: serde_json::Value) -> Result<LocalPosSaleResult, String> {
    let path = database_path(app)?;
    edit_local_pos_sale_at(&path, edit)
}

pub fn cancel_local_pos_sale(app: &AppHandle, cancellation: serde_json::Value) -> Result<LocalPosSaleResult, String> {
    let path = database_path(app)?;
    cancel_local_pos_sale_at(&path, cancellation)
}

pub fn load_local_pos_sale(app: &AppHandle, invoice_id: &str) -> Result<serde_json::Value, String> {
    let path = database_path(app)?;
    initialize_at(&path)?;
    let conn = Connection::open(path).map_err(to_error)?;
    load_invoice_snapshot(&conn, invoice_id)
}

pub fn list_local_pos_sales(app: &AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let path = database_path(app)?;
    initialize_at(&path)?;
    let conn = Connection::open(path).map_err(to_error)?;
    let mut stmt = conn
        .prepare("SELECT id FROM local_pos_invoices ORDER BY bill_datetime DESC, created_at DESC LIMIT 200")
        .map_err(to_error)?;
    let ids = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(to_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_error)?;
    drop(stmt);
    ids.into_iter()
        .map(|id| load_invoice_snapshot(&conn, &id))
        .collect()
}

pub fn queue_local_purchase(app: &AppHandle, purchase: serde_json::Value) -> Result<LocalPurchaseIntentResult, String> {
    let path = database_path(app)?;
    queue_local_purchase_at(&path, purchase)
}

pub fn list_local_purchase_intents(app: &AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let path = database_path(app)?;
    initialize_at(&path)?;
    let conn = Connection::open(path).map_err(to_error)?;
    list_local_purchase_intents_with_conn(&conn)
}

fn queue_local_purchase_at(path: &Path, mut purchase: serde_json::Value) -> Result<LocalPurchaseIntentResult, String> {
    initialize_at(path)?;
    let operation_id = required_text(&purchase, "operation_id")?;
    let provisional_purchase_id = optional_text(&purchase, "purchase_global_id")
        .unwrap_or_else(|| format!("offline-purchase-{operation_id}"));
    purchase
        .as_object_mut()
        .ok_or_else(|| "Offline purchase payload is invalid".to_string())?
        .insert(
            "purchase_global_id".to_string(),
            serde_json::Value::String(provisional_purchase_id.clone()),
        );
    let submitted_payload = serde_json::to_string(&purchase).map_err(to_error)?;
    let intent_checksum = checksum(&submitted_payload);
    let provisional_reference = optional_text(&purchase, "provisional_reference")
        .unwrap_or_else(|| format!("OFF-PUR-{operation_id}"));
    let supplier_id = required_text(&purchase, "supplier_id")?;
    let purchase_date = required_text(&purchase, "purchase_date")?;
    let purchase_bill_status = required_text(&purchase, "purchase_bill_status")?.to_uppercase();
    let purchase_type = required_text(&purchase, "purchase_type")?.to_uppercase();
    let branch_id = required_text(&purchase, "branch_id")?;
    let device_id = required_text(&purchase, "device_id")?;
    let user_id = required_text(&purchase, "user_id")?;
    let company_id = optional_text(&purchase, "company_id");
    let operational_location_id = optional_text(&purchase, "operational_location_id");
    let assignment_generation = purchase.get("assignment_generation").and_then(|value| value.as_i64());
    let raw_items = purchase
        .get("items")
        .and_then(|value| value.as_array())
        .cloned()
        .ok_or_else(|| "Offline purchase requires at least one item".to_string())?;
    if raw_items.is_empty() {
        return Err("Offline purchase requires at least one item".to_string());
    }
    if !matches!(purchase_bill_status.as_str(), "BILL_PENDING" | "BILL_COMPLETED") {
        return Err("Offline purchase bill status is invalid".to_string());
    }
    if purchase_bill_status == "BILL_COMPLETED" && !matches!(purchase_type.as_str(), "CASH" | "CREDIT") {
        return Err("Offline completed purchase must be Cash or Credit".to_string());
    }

    let mut conn = Connection::open(path).map_err(to_error)?;
    conn.pragma_update(None, "foreign_keys", "ON").map_err(to_error)?;
    let tx = conn.transaction().map_err(to_error)?;
    if let Some(existing_checksum) = tx
        .query_row(
            "SELECT intent_checksum FROM local_purchase_intents WHERE operation_id = ?1",
            [&operation_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(to_error)?
    {
        if existing_checksum != intent_checksum {
            return Err("Offline purchase operation already exists with different financial intent".to_string());
        }
        drop(tx);
        let conn = Connection::open(path).map_err(to_error)?;
        let intent = load_local_purchase_intent_with_conn(&conn, &operation_id)?;
        return Ok(LocalPurchaseIntentResult {
            intent,
            pending_operations: pending_outbox_count_at(&conn)?,
        });
    }

    let intent_id = format!("purchase-intent-{operation_id}");
    tx.execute(
        "INSERT INTO local_purchase_intents (
            id, operation_id, provisional_reference, provisional_purchase_id,
            supplier_id, purchase_date, purchase_bill_status, purchase_type,
            intent_checksum, payload_json, state
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'pending')",
        params![
            intent_id,
            operation_id,
            provisional_reference,
            provisional_purchase_id,
            supplier_id,
            purchase_date,
            purchase_bill_status,
            purchase_type,
            intent_checksum,
            submitted_payload,
        ],
    )
    .map_err(to_error)?;
    let mut normalized_items = Vec::with_capacity(raw_items.len());
    for (index, item) in raw_items.iter().enumerate() {
        let supplied_product_id = required_text(item, "product_id")?;
        let product = tx
            .query_row(
                "SELECT id, product_name, unit
                 FROM local_products
                 WHERE id = ?1 OR cloud_id = ?1
                 LIMIT 1",
                [&supplied_product_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?)),
            )
            .optional()
            .map_err(to_error)?
            .ok_or_else(|| format!("Offline purchase product {supplied_product_id} is not available locally"))?;
        let quantity = required_number(item, "quantity")?;
        if quantity <= 0.0 {
            return Err("Offline purchase quantities must be greater than zero".to_string());
        }
        let line_index = index + 1;
        let provisional_line_id = optional_text(item, "line_global_id")
            .or_else(|| optional_text(item, "purchase_global_id"))
            .filter(|value| value != &provisional_purchase_id)
            .unwrap_or_else(|| format!("offline-purchase-line-{operation_id}-{line_index}"));
        let provisional_lot_id = optional_text(item, "lot_global_id")
            .unwrap_or_else(|| format!("offline-lot-{operation_id}-{line_index}"));
        let purchase_rate = item.get("purchase_rate").and_then(json_number);
        let expected_purchase_rate = item.get("expected_purchase_rate").and_then(json_number);
        let temporary_sale_rate = item.get("temporary_sale_rate").and_then(json_number);
        let cost_rate = if purchase_bill_status == "BILL_PENDING" {
            expected_purchase_rate.unwrap_or(0.0)
        } else {
            purchase_rate.unwrap_or(0.0)
        };
        let mut normalized = item.clone();
        let normalized_object = normalized
            .as_object_mut()
            .ok_or_else(|| "Offline purchase item is invalid".to_string())?;
        normalized_object.insert("product_id".to_string(), serde_json::Value::String(product.0.clone()));
        normalized_object.insert("product_global_id".to_string(), serde_json::Value::String(product.0.clone()));
        normalized_object.insert("product_name".to_string(), serde_json::Value::String(product.1.clone()));
        normalized_object.insert("purchase_global_id".to_string(), serde_json::Value::String(provisional_purchase_id.clone()));
        normalized_object.insert("line_global_id".to_string(), serde_json::Value::String(provisional_line_id.clone()));
        normalized_object.insert("lot_global_id".to_string(), serde_json::Value::String(provisional_lot_id.clone()));
        normalized_object.insert("line_index".to_string(), serde_json::json!(line_index));
        if normalized_object.get("unit").and_then(|value| value.as_str()).unwrap_or("").is_empty() {
            normalized_object.insert("unit".to_string(), serde_json::Value::String(product.2.clone().unwrap_or_default()));
        }
        let normalized_json = serde_json::to_string(&normalized).map_err(to_error)?;
        tx.execute(
            "INSERT INTO local_purchase_intent_lines (
                id, intent_id, line_index, provisional_purchase_id, provisional_line_id,
                provisional_lot_id, product_id, quantity, unit, purchase_rate,
                expected_purchase_rate, temporary_sale_rate, lot_name, lot_size, payload_json
             ) VALUES (?1,?2,?3,?4,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            params![
                format!("purchase-intent-line-{operation_id}-{line_index}"),
                intent_id,
                line_index as i64,
                provisional_line_id,
                provisional_lot_id,
                product.0,
                quantity,
                optional_text(&normalized, "unit"),
                purchase_rate,
                expected_purchase_rate,
                temporary_sale_rate,
                optional_text(&normalized, "lot_name"),
                optional_text(&normalized, "lot_size"),
                normalized_json,
            ],
        )
        .map_err(to_error)?;
        tx.execute(
            "INSERT INTO local_inventory_lots (
                id, cloud_id, branch_id, device_id, product_id, product_name, supplier_id,
                lot_no, size_grade, opening_date, opening_qty, purchased_qty, balance_qty,
                cost_rate, sale_rate, status, remarks, created_by, version, sync_status,
                company_id, operational_location_id
             ) VALUES (?1,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10,?10,?11,?12,'ACTIVE',?13,?14,1,'pending',?15,?16)
             ON CONFLICT(id) DO NOTHING",
            params![
                provisional_lot_id,
                branch_id,
                device_id,
                product.0,
                product.1,
                supplier_id,
                optional_text(&normalized, "lot_name").unwrap_or_else(|| format!("Offline GRN {provisional_reference}")),
                optional_text(&normalized, "lot_size"),
                purchase_date,
                quantity,
                cost_rate,
                temporary_sale_rate,
                optional_text(&purchase, "remarks"),
                user_id,
                company_id,
                operational_location_id,
            ],
        )
        .map_err(to_error)?;
        normalized_items.push(normalized);
    }

    purchase
        .as_object_mut()
        .ok_or_else(|| "Offline purchase payload is invalid".to_string())?
        .insert("items".to_string(), serde_json::Value::Array(normalized_items));
    purchase
        .as_object_mut()
        .unwrap()
        .insert("provisional_reference".to_string(), serde_json::Value::String(provisional_reference.clone()));
    let payload_json = serde_json::to_string(&purchase).map_err(to_error)?;
    tx.execute(
        "UPDATE local_purchase_intents SET payload_json = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE operation_id = ?1",
        params![operation_id, payload_json],
    )
    .map_err(to_error)?;
    enqueue_sync_operation_with_conn(
        &tx,
        &SyncOperation {
            id: operation_id.clone(),
            operation_id: Some(operation_id.clone()),
            entity_type: "purchase_grn".to_string(),
            entity_id: intent_id,
            operation_type: "PURCHASE_GRN_CREATE".to_string(),
            payload: purchase,
            branch_id: Some(branch_id),
            device_id: Some(device_id),
            user_id: Some(user_id),
            version: Some(1),
            created_at: None,
        },
    )?;
    tx.execute(
        "UPDATE sync_outbox
         SET company_id = ?2, operational_location_id = ?3, assignment_generation = ?4
         WHERE operation_id = ?1",
        params![operation_id, company_id, operational_location_id, assignment_generation],
    )
    .map_err(to_error)?;
    tx.commit().map_err(to_error)?;
    let conn = Connection::open(path).map_err(to_error)?;
    let intent = load_local_purchase_intent_with_conn(&conn, &operation_id)?;
    Ok(LocalPurchaseIntentResult {
        intent,
        pending_operations: pending_outbox_count_at(&conn)?,
    })
}

fn load_local_purchase_intent_with_conn(conn: &Connection, operation_id: &str) -> Result<serde_json::Value, String> {
    conn.query_row(
        "SELECT operation_id, provisional_reference, supplier_id, purchase_date,
                purchase_bill_status, purchase_type, state, server_purchase_ids_json,
                last_error, retry_count, created_at, updated_at, completed_at
         FROM local_purchase_intents WHERE operation_id = ?1",
        [operation_id],
        |row| {
            let server_ids: Option<String> = row.get(7)?;
            Ok(serde_json::json!({
                "operation_id": row.get::<_, String>(0)?,
                "provisional_reference": row.get::<_, String>(1)?,
                "supplier_id": row.get::<_, String>(2)?,
                "purchase_date": row.get::<_, String>(3)?,
                "purchase_bill_status": row.get::<_, String>(4)?,
                "purchase_type": row.get::<_, String>(5)?,
                "sync_status": row.get::<_, String>(6)?,
                "server_purchase_ids": server_ids
                    .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok())
                    .unwrap_or_else(|| serde_json::json!([])),
                "last_error": row.get::<_, Option<String>>(8)?,
                "retry_count": row.get::<_, i64>(9)?,
                "created_at": row.get::<_, String>(10)?,
                "updated_at": row.get::<_, String>(11)?,
                "completed_at": row.get::<_, Option<String>>(12)?,
            }))
        },
    )
    .map_err(to_error)
}

fn list_local_purchase_intents_with_conn(conn: &Connection) -> Result<Vec<serde_json::Value>, String> {
    let mut statement = conn
        .prepare(
            "SELECT i.operation_id, i.provisional_reference, i.supplier_id, i.purchase_date,
                    i.purchase_bill_status, i.purchase_type, i.state, i.last_error,
                    i.created_at, l.provisional_purchase_id, l.provisional_lot_id,
                    l.product_id, p.product_name, l.quantity, l.unit, l.purchase_rate,
                    l.expected_purchase_rate, l.temporary_sale_rate, l.lot_name, l.lot_size,
                    l.server_purchase_id, l.server_lot_id
             FROM local_purchase_intents i
             JOIN local_purchase_intent_lines l ON l.intent_id = i.id
             LEFT JOIN local_products p ON p.id = l.product_id
             ORDER BY datetime(i.created_at) DESC, l.line_index",
        )
        .map_err(to_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(9)?,
                "global_id": row.get::<_, String>(9)?,
                "operation_id": row.get::<_, String>(0)?,
                "offline_purchase_ref": row.get::<_, String>(1)?,
                "supplier_id": row.get::<_, String>(2)?,
                "purchase_date": row.get::<_, String>(3)?,
                "purchase_bill_status": row.get::<_, String>(4)?,
                "purchase_type": row.get::<_, String>(5)?,
                "sync_status": row.get::<_, String>(6)?,
                "last_error": row.get::<_, Option<String>>(7)?,
                "created_at": row.get::<_, String>(8)?,
                "lot_global_id": row.get::<_, String>(10)?,
                "product_id": row.get::<_, String>(11)?,
                "product_name": row.get::<_, Option<String>>(12)?,
                "quantity": row.get::<_, f64>(13)?,
                "unit": row.get::<_, Option<String>>(14)?,
                "purchase_rate": row.get::<_, Option<f64>>(15)?,
                "expected_purchase_rate": row.get::<_, Option<f64>>(16)?,
                "temporary_sale_rate": row.get::<_, Option<f64>>(17)?,
                "lot_name": row.get::<_, Option<String>>(18)?,
                "lot_size": row.get::<_, Option<String>>(19)?,
                "server_purchase_id": row.get::<_, Option<String>>(20)?,
                "server_lot_id": row.get::<_, Option<String>>(21)?,
                "purchase_status": "ACTIVE",
            }))
        })
        .map_err(to_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(to_error)
}

fn complete_local_pos_sale_at(path: &Path, sale: serde_json::Value) -> Result<LocalPosSaleResult, String> {
    initialize_at(&path)?;
    let mut conn = Connection::open(path).map_err(to_error)?;
    let tx = conn.transaction().map_err(to_error)?;

    let invoice_id = required_text(&sale, "invoice_global_id")?;
    let offline_ref = required_text(&sale, "offline_invoice_ref")?;
    let branch_id = required_text(&sale, "branch_id")?;
    let device_id = required_text(&sale, "device_id")?;
    let user_id = optional_text(&sale, "user_id");
    let bill_datetime = required_text(&sale, "bill_datetime")?;
    let bill_date = optional_text(&sale, "bill_date").unwrap_or_else(|| bill_datetime.chars().take(10).collect());
    let payment_mode = required_text(&sale, "payment_mode")?;
    let gross_total = required_number(&sale, "gross_total")?;
    let item_discount_total = number_or_zero(&sale, "item_discount_total");
    let bill_discount_total = number_or_zero(&sale, "bill_discount_total");
    let taxable_amount = number_or_zero(&sale, "taxable_amount");
    let mandi_tax_rate = number_or_zero(&sale, "mandi_tax_rate");
    let mandi_tax_basis = optional_text(&sale, "mandi_tax_basis");
    let tax_config_snapshot = sale.get("tax_config_snapshot").map(|value| value.to_string());
    let tax_total = number_or_zero(&sale, "tax_total");
    let net_total = required_number(&sale, "net_total")?;
    let entity_version = sale.get("entity_version").and_then(|v| v.as_i64()).unwrap_or(1);
    let customer = sale.get("customer").cloned().unwrap_or_else(|| serde_json::json!({}));
    let customer_id = optional_text(&customer, "account_id").or_else(|| optional_text(&customer, "customer_id"));
    let customer_name = optional_text(&customer, "name");
    let customer_mobile = optional_text(&customer, "mobile");
    let items = sale
        .get("items")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "POS sale requires at least one item".to_string())?;
    if items.is_empty() {
        return Err("POS sale requires at least one item".to_string());
    }
    if net_total < 0.0 || gross_total < 0.0 {
        return Err("POS sale totals must be non-negative".to_string());
    }

    tx.execute(
        "INSERT INTO local_pos_invoices (
            id, offline_invoice_ref, branch_id, device_id, user_id, customer_id,
            customer_name, customer_mobile, bill_date, bill_datetime, payment_mode,
            gross_total, item_discount_total, bill_discount_total, tax_total, net_total,
            taxable_amount, mandi_tax_rate, mandi_tax_basis, tax_config_snapshot,
            status, sync_status, entity_version, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                   ?17, ?18, ?19, ?20, 'COMPLETED', 'pending', ?21, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        params![
            invoice_id,
            offline_ref,
            branch_id,
            device_id,
            user_id,
            customer_id,
            customer_name,
            customer_mobile,
            bill_date,
            bill_datetime,
            payment_mode,
            gross_total,
            item_discount_total,
            bill_discount_total,
            tax_total,
            net_total,
            taxable_amount,
            mandi_tax_rate,
            mandi_tax_basis,
            tax_config_snapshot,
            entity_version,
        ],
    )
    .map_err(to_error)?;

    for item in items {
        let item_id = required_text(item, "item_global_id")?;
        let product_id = required_text(item, "product_id")?;
        let lot_id = required_text(item, "lot_id")?;
        let quantity = required_number(item, "quantity")?;
        let rate = required_number(item, "rate")?;
        let discount = number_or_zero(item, "discount");
        let amount = required_number(item, "amount")?;
        let stock_movement_id = required_text(item, "stock_movement_id")?;
        if quantity <= 0.0 {
            return Err("POS item quantity must be greater than zero".to_string());
        }
        if rate < 0.0 || discount < 0.0 || amount < 0.0 {
            return Err("POS item rate, discount and amount must be non-negative".to_string());
        }

        let existing_balance: Option<f64> = tx
            .query_row(
                "SELECT balance_qty FROM local_inventory_lots
                 WHERE (id = ?1 OR cloud_id = ?1)
                   AND deleted_at IS NULL
                   AND UPPER(COALESCE(status, 'ACTIVE')) NOT IN ('CANCELLED', 'INACTIVE', 'EXPIRED', 'RESERVED', 'BLOCKED', 'EXHAUSTED')
                 LIMIT 1",
                [&lot_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(to_error)?;
        let starting_balance = existing_balance.unwrap_or_else(|| number_or_zero(item, "available_qty"));
        if starting_balance < quantity {
            return Err(format!(
                "Selected lot does not have enough local stock for {}",
                optional_text(item, "product_name").unwrap_or_else(|| product_id.clone())
            ));
        }

        tx.execute(
            "INSERT INTO local_products (id, cloud_id, branch_id, product_name, unit, sale_rate, sync_status, updated_at)
             VALUES (?1, ?1, ?2, ?3, ?4, ?5, 'synced', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ON CONFLICT(id) DO UPDATE SET
               product_name = COALESCE(excluded.product_name, local_products.product_name),
               unit = COALESCE(excluded.unit, local_products.unit),
               sale_rate = COALESCE(excluded.sale_rate, local_products.sale_rate),
               updated_at = excluded.updated_at",
            params![
                product_id,
                branch_id,
                optional_text(item, "product_name").unwrap_or_else(|| "Unnamed Product".to_string()),
                optional_text(item, "unit"),
                rate,
            ],
        )
        .map_err(to_error)?;

        tx.execute(
            "INSERT INTO local_inventory_lots (
                id, cloud_id, branch_id, device_id, product_id, product_name, lot_no, size_grade,
                opening_qty, balance_qty, sale_rate, status, sync_status, updated_at
             ) VALUES (?1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, 'ACTIVE', 'synced', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ON CONFLICT(id) DO NOTHING",
            params![
                lot_id,
                branch_id,
                device_id,
                product_id,
                optional_text(item, "product_name"),
                optional_text(item, "lot_name"),
                optional_text(item, "lot_size"),
                starting_balance,
                rate,
            ],
        )
        .map_err(to_error)?;

        tx.execute(
            "UPDATE local_inventory_lots
             SET sold_qty = sold_qty + ?2,
                 balance_qty = balance_qty - ?2,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 sync_status = CASE WHEN LOWER(sync_status) = 'pending' THEN sync_status ELSE 'synced' END
             WHERE id = ?1
               AND deleted_at IS NULL
               AND UPPER(COALESCE(status, 'ACTIVE')) NOT IN ('CANCELLED', 'INACTIVE', 'EXPIRED', 'RESERVED', 'BLOCKED', 'EXHAUSTED')
               AND balance_qty >= ?2",
            params![lot_id, quantity],
        )
        .map_err(to_error)?;
        if tx.changes() != 1 {
            return Err("Selected lot does not have enough local stock".to_string());
        }

        tx.execute(
            "INSERT INTO local_pos_invoice_items (
                id, invoice_id, product_id, product_name, lot_id, lot_name, lot_size,
                quantity, unit, rate, discount, amount, stock_movement_id, entity_version
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                item_id,
                invoice_id,
                product_id,
                optional_text(item, "product_name"),
                lot_id,
                optional_text(item, "lot_name"),
                optional_text(item, "lot_size"),
                quantity,
                optional_text(item, "unit"),
                rate,
                discount,
                amount,
                stock_movement_id,
                entity_version,
            ],
        )
        .map_err(to_error)?;

        tx.execute(
            "INSERT INTO local_stock_movements (
                id, invoice_id, item_id, product_id, lot_id, branch_id, device_id,
                movement_type, quantity, quantity_delta, movement_time, sync_status
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'SALE_OUT', ?8, ?9, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'pending')",
            params![
                stock_movement_id,
                invoice_id,
                item_id,
                product_id,
                lot_id,
                branch_id,
                device_id,
                quantity,
                -quantity,
            ],
        )
        .map_err(to_error)?;
    }

    let payments = sale
        .get("payments")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "POS sale requires payment postings".to_string())?;
    if payments.is_empty() {
        return Err("POS sale requires payment postings".to_string());
    }
    for payment in payments {
        let posting_id = required_text(payment, "posting_id")?;
        let mode = required_text(payment, "mode")?;
        let amount = required_number(payment, "amount")?;
        if amount <= 0.0 {
            return Err("Payment posting amount must be greater than zero".to_string());
        }
        let posting_type = if mode.eq_ignore_ascii_case("CREDIT") {
            "CUSTOMER_RECEIVABLE"
        } else {
            "PAYMENT_RECEIVED"
        };
        tx.execute(
            "INSERT INTO local_payment_postings (
                id, invoice_id, posting_type, payment_mode, account_id, customer_id,
                amount, branch_id, device_id, posting_time, sync_status
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'pending')",
            params![
                posting_id,
                invoice_id,
                posting_type,
                mode,
                optional_text(payment, "account_id"),
                customer_id,
                amount,
                branch_id,
                device_id,
            ],
        )
        .map_err(to_error)?;
    }

    let operation_id = required_text(&sale, "operation_id")?;
    let operation = SyncOperation {
        id: operation_id.clone(),
        operation_id: Some(operation_id),
        entity_type: "pos_sale".to_string(),
        entity_id: invoice_id.clone(),
        operation_type: "UPSERT".to_string(),
        payload: sale.clone(),
        branch_id: Some(branch_id),
        device_id: Some(device_id),
        user_id,
        version: Some(entity_version),
        created_at: None,
    };
    enqueue_sync_operation_with_conn(&tx, &operation)?;
    tx.commit().map_err(to_error)?;

    let conn = Connection::open(path).map_err(to_error)?;
    Ok(LocalPosSaleResult {
        invoice: sale,
        pending_operations: pending_outbox_count_at(&conn)?,
    })
}

fn unique_local_id(prefix: &str) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{prefix}-{millis}-{}", checksum(&format!("{prefix}-{millis}"))[..8].to_string())
}

fn load_invoice_snapshot(conn: &Connection, invoice_id: &str) -> Result<serde_json::Value, String> {
    let invoice = conn
        .query_row(
            "SELECT id, offline_invoice_ref, branch_id, device_id, user_id, customer_id, customer_name,
                    customer_mobile, bill_date, bill_datetime, payment_mode, gross_total,
                    item_discount_total, bill_discount_total, tax_total, net_total, status,
                    sync_status, server_invoice_no, server_sale_id, entity_version, created_at,
                    updated_at, edit_reason, cancellation_reason, cancelled_by, cancelled_at, base_version,
                    taxable_amount, mandi_tax_rate, mandi_tax_basis, tax_config_snapshot
             FROM local_pos_invoices WHERE id = ?1",
            [invoice_id],
            |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "invoice_global_id": row.get::<_, String>(0)?,
                    "offline_invoice_ref": row.get::<_, String>(1)?,
                    "branch_id": row.get::<_, String>(2)?,
                    "device_id": row.get::<_, String>(3)?,
                    "user_id": row.get::<_, Option<String>>(4)?,
                    "customer_id": row.get::<_, Option<String>>(5)?,
                    "customer_name": row.get::<_, Option<String>>(6)?,
                    "customer_mobile": row.get::<_, Option<String>>(7)?,
                    "bill_date": row.get::<_, String>(8)?,
                    "bill_datetime": row.get::<_, String>(9)?,
                    "payment_mode": row.get::<_, String>(10)?,
                    "gross_total": row.get::<_, f64>(11)?,
                    "item_discount_total": row.get::<_, f64>(12)?,
                    "bill_discount_total": row.get::<_, f64>(13)?,
                    "tax_total": row.get::<_, f64>(14)?,
                    "net_total": row.get::<_, f64>(15)?,
                    "status": row.get::<_, String>(16)?,
                    "sync_status": row.get::<_, String>(17)?,
                    "server_invoice_no": row.get::<_, Option<String>>(18)?,
                    "server_sale_id": row.get::<_, Option<String>>(19)?,
                    "entity_version": row.get::<_, i64>(20)?,
                    "created_at": row.get::<_, String>(21)?,
                    "updated_at": row.get::<_, String>(22)?,
                    "edit_reason": row.get::<_, Option<String>>(23)?,
                    "cancellation_reason": row.get::<_, Option<String>>(24)?,
                    "cancelled_by": row.get::<_, Option<String>>(25)?,
                    "cancelled_at": row.get::<_, Option<String>>(26)?,
                    "base_version": row.get::<_, Option<i64>>(27)?,
                    "taxable_amount": row.get::<_, f64>(28)?,
                    "mandi_tax_rate": row.get::<_, f64>(29)?,
                    "mandi_tax_basis": row.get::<_, Option<String>>(30)?,
                    "tax_config_snapshot": row.get::<_, Option<String>>(31)?,
                }))
            },
        )
        .optional()
        .map_err(to_error)?
        .ok_or_else(|| "Local invoice not found".to_string())?;

    let items = {
        let mut stmt = conn
            .prepare(
                "SELECT id, product_id, product_name, lot_id, lot_name, lot_size, quantity,
                        unit, rate, discount, amount, stock_movement_id, entity_version
                 FROM local_pos_invoice_items WHERE invoice_id = ?1 ORDER BY id",
            )
            .map_err(to_error)?;
        let rows = stmt
            .query_map([invoice_id], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "item_global_id": row.get::<_, String>(0)?,
                    "product_id": row.get::<_, String>(1)?,
                    "product_name": row.get::<_, Option<String>>(2)?,
                    "lot_id": row.get::<_, String>(3)?,
                    "inventory_batch_id": row.get::<_, String>(3)?,
                    "lot_name": row.get::<_, Option<String>>(4)?,
                    "lot_size": row.get::<_, Option<String>>(5)?,
                    "quantity": row.get::<_, f64>(6)?,
                    "unit": row.get::<_, Option<String>>(7)?,
                    "rate": row.get::<_, f64>(8)?,
                    "selling_rate": row.get::<_, f64>(8)?,
                    "discount": row.get::<_, f64>(9)?,
                    "discount_amount": row.get::<_, f64>(9)?,
                    "amount": row.get::<_, f64>(10)?,
                    "net_amount": row.get::<_, f64>(10)?,
                    "stock_movement_id": row.get::<_, String>(11)?,
                    "entity_version": row.get::<_, i64>(12)?,
                }))
            })
            .map_err(to_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(to_error)?
    };

    let payments = {
        let mut stmt = conn
            .prepare(
                "SELECT id, posting_type, payment_mode, account_id, customer_id, amount, posting_time
                 FROM local_payment_postings WHERE invoice_id = ?1 ORDER BY posting_time, id",
            )
            .map_err(to_error)?;
        let rows = stmt
            .query_map([invoice_id], |row| {
                Ok(serde_json::json!({
                    "posting_id": row.get::<_, String>(0)?,
                    "posting_type": row.get::<_, String>(1)?,
                    "mode": row.get::<_, String>(2)?,
                    "account_id": row.get::<_, Option<String>>(3)?,
                    "customer_id": row.get::<_, Option<String>>(4)?,
                    "amount": row.get::<_, f64>(5)?,
                    "posting_time": row.get::<_, String>(6)?,
                }))
            })
            .map_err(to_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(to_error)?
    };

    Ok(serde_json::json!({
        "invoice": invoice,
        "items": items,
        "payments": payments,
    }))
}

fn restore_invoice_stock(tx: &rusqlite::Transaction<'_>, invoice_id: &str, device_id: &str, reason: &str) -> Result<(), String> {
    let mut stmt = tx
        .prepare(
            "SELECT id, item_id, product_id, lot_id, branch_id, quantity
             FROM local_stock_movements
             WHERE invoice_id = ?1 AND movement_type = 'SALE_OUT' AND quantity_delta < 0",
        )
        .map_err(to_error)?;
    let rows = stmt
        .query_map([invoice_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, f64>(5)?,
            ))
        })
        .map_err(to_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_error)?;
    drop(stmt);

    for (movement_id, item_id, product_id, lot_id, branch_id, quantity) in rows {
        tx.execute(
            "UPDATE local_inventory_lots
             SET sold_qty = MAX(sold_qty - ?2, 0),
                 balance_qty = balance_qty + ?2,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1",
            params![lot_id, quantity],
        )
        .map_err(to_error)?;
        if tx.changes() != 1 {
            return Err(format!("Cannot restore stock for lot {lot_id}"));
        }
        tx.execute(
            "INSERT INTO local_stock_movements (
                id, invoice_id, item_id, product_id, lot_id, branch_id, device_id,
                movement_type, quantity, quantity_delta, movement_time, sync_status
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'SALE_REVERSAL', ?8, ?8, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'pending')",
            params![
                unique_local_id("stock-reversal"),
                invoice_id,
                item_id,
                product_id,
                lot_id,
                branch_id,
                device_id,
                quantity,
            ],
        )
        .map_err(to_error)?;
        tx.execute(
            "UPDATE local_stock_movements SET sync_status = 'reversed' WHERE id = ?1",
            [movement_id],
        )
        .map_err(to_error)?;
        let _ = reason;
    }
    Ok(())
}

fn insert_local_sale_items_and_stock(
    tx: &rusqlite::Transaction<'_>,
    invoice_id: &str,
    branch_id: &str,
    device_id: &str,
    entity_version: i64,
    items: &[serde_json::Value],
) -> Result<(), String> {
    for item in items {
        let item_id = optional_text(item, "item_global_id")
            .or_else(|| optional_text(item, "id"))
            .unwrap_or_else(|| unique_local_id("sale-item"));
        let product_id = required_text(item, "product_id")?;
        let lot_id = optional_text(item, "lot_id")
            .or_else(|| optional_text(item, "inventory_batch_id"))
            .ok_or_else(|| "Sale item requires lot_id".to_string())?;
        let quantity = required_number(item, "quantity")?;
        let rate = item
            .get("rate")
            .or_else(|| item.get("selling_rate"))
            .and_then(json_number)
            .ok_or_else(|| "Sale item rate is required".to_string())?;
        let discount = item
            .get("discount")
            .or_else(|| item.get("discount_amount"))
            .and_then(json_number)
            .unwrap_or(0.0);
        let amount = item
            .get("amount")
            .or_else(|| item.get("net_amount"))
            .and_then(json_number)
            .unwrap_or((quantity * rate - discount).max(0.0));
        if quantity <= 0.0 {
            return Err("POS item quantity must be greater than zero".to_string());
        }
        if rate < 0.0 || discount < 0.0 || amount < 0.0 {
            return Err("POS item rate, discount and amount must be non-negative".to_string());
        }
        tx.execute(
            "UPDATE local_inventory_lots
             SET sold_qty = sold_qty + ?2,
                 balance_qty = balance_qty - ?2,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1
               AND deleted_at IS NULL
               AND UPPER(COALESCE(status, 'ACTIVE')) NOT IN ('CANCELLED', 'INACTIVE', 'EXPIRED', 'RESERVED', 'BLOCKED', 'EXHAUSTED')
               AND balance_qty >= ?2",
            params![lot_id, quantity],
        )
        .map_err(to_error)?;
        if tx.changes() != 1 {
            return Err(format!(
                "Selected lot does not have enough local stock for {}",
                optional_text(item, "product_name").unwrap_or_else(|| product_id.clone())
            ));
        }
        let stock_movement_id = optional_text(item, "stock_movement_id").unwrap_or_else(|| unique_local_id("stock-out"));
        tx.execute(
            "INSERT INTO local_pos_invoice_items (
                id, invoice_id, product_id, product_name, lot_id, lot_name, lot_size,
                quantity, unit, rate, discount, amount, stock_movement_id, entity_version
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                item_id,
                invoice_id,
                product_id,
                optional_text(item, "product_name"),
                lot_id,
                optional_text(item, "lot_name"),
                optional_text(item, "lot_size"),
                quantity,
                optional_text(item, "unit"),
                rate,
                discount,
                amount,
                stock_movement_id,
                entity_version,
            ],
        )
        .map_err(to_error)?;
        tx.execute(
            "INSERT INTO local_stock_movements (
                id, invoice_id, item_id, product_id, lot_id, branch_id, device_id,
                movement_type, quantity, quantity_delta, movement_time, sync_status
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'SALE_OUT', ?8, ?9, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'pending')",
            params![
                stock_movement_id,
                invoice_id,
                item_id,
                product_id,
                lot_id,
                branch_id,
                device_id,
                quantity,
                -quantity,
            ],
        )
        .map_err(to_error)?;
    }
    Ok(())
}

fn replace_local_payment_postings(
    tx: &rusqlite::Transaction<'_>,
    invoice_id: &str,
    branch_id: &str,
    device_id: &str,
    customer_id: Option<String>,
    payments: &[serde_json::Value],
    reverse_existing: bool,
) -> Result<(), String> {
    if reverse_existing {
        let mut stmt = tx
            .prepare(
                "SELECT payment_mode, account_id, customer_id, amount
                 FROM local_payment_postings
                 WHERE invoice_id = ?1 AND posting_type IN ('PAYMENT_RECEIVED', 'CUSTOMER_RECEIVABLE')",
            )
            .map_err(to_error)?;
        let existing = stmt
            .query_map([invoice_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, f64>(3)?,
                ))
            })
            .map_err(to_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(to_error)?;
        drop(stmt);
        for (mode, account_id, customer, amount) in existing {
            if amount > 0.0 {
                tx.execute(
                    "INSERT INTO local_payment_postings (
                        id, invoice_id, posting_type, payment_mode, account_id, customer_id,
                        amount, branch_id, device_id, posting_time, sync_status
                     ) VALUES (?1, ?2, 'PAYMENT_REVERSAL', ?3, ?4, ?5, ?6, ?7, ?8, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'pending')",
                    params![unique_local_id("payment-reversal"), invoice_id, mode, account_id, customer, amount, branch_id, device_id],
                )
                .map_err(to_error)?;
            }
        }
    }
    tx.execute("DELETE FROM local_payment_postings WHERE invoice_id = ?1 AND posting_type IN ('PAYMENT_RECEIVED', 'CUSTOMER_RECEIVABLE')", [invoice_id])
        .map_err(to_error)?;
    for payment in payments {
        let posting_id = optional_text(payment, "posting_id").unwrap_or_else(|| unique_local_id("payment"));
        let mode = required_text(payment, "mode")?;
        let amount = required_number(payment, "amount")?;
        if amount <= 0.0 {
            return Err("Payment posting amount must be greater than zero".to_string());
        }
        let posting_type = if mode.eq_ignore_ascii_case("CREDIT") {
            "CUSTOMER_RECEIVABLE"
        } else {
            "PAYMENT_RECEIVED"
        };
        tx.execute(
            "INSERT INTO local_payment_postings (
                id, invoice_id, posting_type, payment_mode, account_id, customer_id,
                amount, branch_id, device_id, posting_time, sync_status
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'pending')",
            params![
                posting_id,
                invoice_id,
                posting_type,
                mode,
                optional_text(payment, "account_id"),
                optional_text(payment, "customer_id").or_else(|| customer_id.clone()),
                amount,
                branch_id,
                device_id,
            ],
        )
        .map_err(to_error)?;
        if mode.eq_ignore_ascii_case("CREDIT") {
            tx.execute(
                "INSERT INTO local_customer_ledger_entries (
                    id, invoice_id, customer_id, branch_id, device_id, transaction_type,
                    debit_amount, credit_amount, balance_delta, remarks, sync_status
                 ) VALUES (?1, ?2, ?3, ?4, ?5, 'SALE_CREDIT', ?6, 0, ?6, 'Offline credit sale/update', 'pending')",
                params![unique_local_id("ledger"), invoice_id, optional_text(payment, "customer_id").or_else(|| customer_id.clone()), branch_id, device_id, amount],
            )
            .map_err(to_error)?;
        }
    }
    Ok(())
}

fn edit_local_pos_sale_at(path: &Path, edit: serde_json::Value) -> Result<LocalPosSaleResult, String> {
    initialize_at(path)?;
    let mut conn = Connection::open(path).map_err(to_error)?;
    let tx = conn.transaction().map_err(to_error)?;
    let invoice_id = required_text(&edit, "invoice_global_id").or_else(|_| required_text(&edit, "id"))?;
    let reason = required_text(&edit, "reason")?;
    let old_snapshot = load_invoice_snapshot(&tx, &invoice_id)?;
    if old_snapshot["invoice"]["status"].as_str().unwrap_or("") == "CANCELLED" {
        return Err("Cancelled sale cannot be edited".to_string());
    }
    let old_version = old_snapshot["invoice"]["entity_version"].as_i64().unwrap_or(1);
    let new_version = old_version + 1;
    let branch_id = required_text(&edit, "branch_id").or_else(|_| required_text(&old_snapshot["invoice"], "branch_id"))?;
    let device_id = required_text(&edit, "device_id").or_else(|_| required_text(&old_snapshot["invoice"], "device_id"))?;
    let user_id = optional_text(&edit, "user_id").or_else(|| optional_text(&old_snapshot["invoice"], "user_id"));
    let customer = edit.get("customer").cloned().unwrap_or_else(|| serde_json::json!({}));
    let customer_id = optional_text(&customer, "account_id").or_else(|| optional_text(&customer, "customer_id"));
    let customer_name = optional_text(&customer, "name");
    let customer_mobile = optional_text(&customer, "mobile");
    let bill_datetime = required_text(&edit, "bill_datetime")?;
    let bill_date = optional_text(&edit, "bill_date").unwrap_or_else(|| bill_datetime.chars().take(10).collect());
    let payment_mode = required_text(&edit, "payment_mode")?;
    let gross_total = required_number(&edit, "gross_total")?;
    let item_discount_total = number_or_zero(&edit, "item_discount_total");
    let bill_discount_total = number_or_zero(&edit, "bill_discount_total");
    let taxable_amount = number_or_zero(&edit, "taxable_amount");
    let mandi_tax_rate = number_or_zero(&edit, "mandi_tax_rate");
    let mandi_tax_basis = optional_text(&edit, "mandi_tax_basis");
    let tax_config_snapshot = edit.get("tax_config_snapshot").map(|value| value.to_string());
    let tax_total = number_or_zero(&edit, "tax_total");
    let net_total = required_number(&edit, "net_total")?;
    let items = edit.get("items").and_then(|value| value.as_array()).ok_or_else(|| "Edited sale requires items".to_string())?;
    if items.is_empty() {
        return Err("Invoice must contain at least one item".to_string());
    }
    let payments = edit.get("payments").and_then(|value| value.as_array()).ok_or_else(|| "Edited sale requires payment postings".to_string())?;
    if payments.is_empty() {
        return Err("Edited sale requires payment postings".to_string());
    }

    restore_invoice_stock(&tx, &invoice_id, &device_id, &reason)?;
    tx.execute("DELETE FROM local_pos_invoice_items WHERE invoice_id = ?1", [invoice_id.as_str()])
        .map_err(to_error)?;
    insert_local_sale_items_and_stock(&tx, &invoice_id, &branch_id, &device_id, new_version, items)?;
    replace_local_payment_postings(&tx, &invoice_id, &branch_id, &device_id, customer_id.clone(), payments, true)?;
    tx.execute(
        "UPDATE local_pos_invoices
         SET customer_id = ?2, customer_name = ?3, customer_mobile = ?4,
             bill_date = ?5, bill_datetime = ?6, payment_mode = ?7,
             gross_total = ?8, item_discount_total = ?9, bill_discount_total = ?10,
             tax_total = ?11, net_total = ?12, taxable_amount = ?13,
             mandi_tax_rate = ?14, mandi_tax_basis = ?15, tax_config_snapshot = ?16,
             status = 'EDITED', sync_status = 'pending', entity_version = ?17, base_version = ?18,
             edit_reason = ?19, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1",
        params![
            invoice_id,
            customer_id,
            customer_name,
            customer_mobile,
            bill_date,
            bill_datetime,
            payment_mode,
            gross_total,
            item_discount_total,
            bill_discount_total,
            tax_total,
            net_total,
            taxable_amount,
            mandi_tax_rate,
            mandi_tax_basis,
            tax_config_snapshot,
            new_version,
            old_version,
            reason,
        ],
    )
    .map_err(to_error)?;
    let new_snapshot = load_invoice_snapshot(&tx, &invoice_id)?;
    let audit_id = unique_local_id("sale-audit");
    tx.execute(
        "INSERT INTO local_sale_audit_log (id, invoice_id, action, user_id, device_id, reason, old_value, new_value, sync_status)
         VALUES (?1, ?2, 'EDIT', ?3, ?4, ?5, ?6, ?7, 'pending')",
        params![
            audit_id,
            invoice_id,
            user_id,
            device_id,
            reason,
            serde_json::to_string(&old_snapshot).map_err(to_error)?,
            serde_json::to_string(&new_snapshot).map_err(to_error)?,
        ],
    )
    .map_err(to_error)?;
    let operation_id = optional_text(&edit, "operation_id").unwrap_or_else(|| unique_local_id("sale-edit-op"));
    let operation_payload = serde_json::json!({
        "operation_kind": "SALE_EDIT",
        "base_version": old_version,
        "new_version": new_version,
        "reason": reason,
        "old_snapshot": old_snapshot,
        "sale": new_snapshot,
    });
    enqueue_sync_operation_with_conn(&tx, &SyncOperation {
        id: operation_id.clone(),
        operation_id: Some(operation_id),
        entity_type: "pos_sale".to_string(),
        entity_id: invoice_id.clone(),
        operation_type: "SALE_EDIT".to_string(),
        payload: operation_payload,
        branch_id: Some(branch_id),
        device_id: Some(device_id),
        user_id,
        version: Some(new_version),
        created_at: None,
    })?;
    tx.commit().map_err(to_error)?;
    let conn = Connection::open(path).map_err(to_error)?;
    Ok(LocalPosSaleResult { invoice: new_snapshot, pending_operations: pending_outbox_count_at(&conn)? })
}

fn cancel_local_pos_sale_at(path: &Path, cancellation: serde_json::Value) -> Result<LocalPosSaleResult, String> {
    initialize_at(path)?;
    let mut conn = Connection::open(path).map_err(to_error)?;
    let tx = conn.transaction().map_err(to_error)?;
    let invoice_id = required_text(&cancellation, "invoice_global_id").or_else(|_| required_text(&cancellation, "id"))?;
    let reason = required_text(&cancellation, "reason")?;
    let old_snapshot = load_invoice_snapshot(&tx, &invoice_id)?;
    if old_snapshot["invoice"]["status"].as_str().unwrap_or("") == "CANCELLED" {
        return Err("Sale is already cancelled".to_string());
    }
    let old_version = old_snapshot["invoice"]["entity_version"].as_i64().unwrap_or(1);
    let new_version = old_version + 1;
    let branch_id = required_text(&old_snapshot["invoice"], "branch_id")?;
    let device_id = optional_text(&cancellation, "device_id").or_else(|| optional_text(&old_snapshot["invoice"], "device_id")).ok_or_else(|| "device_id is required".to_string())?;
    let user_id = optional_text(&cancellation, "user_id").or_else(|| optional_text(&old_snapshot["invoice"], "user_id"));
    restore_invoice_stock(&tx, &invoice_id, &device_id, &reason)?;
    replace_local_payment_postings(&tx, &invoice_id, &branch_id, &device_id, optional_text(&old_snapshot["invoice"], "customer_id"), &[], true)?;
    tx.execute(
        "UPDATE local_pos_invoices
         SET status = 'CANCELLED',
             sync_status = 'pending',
             cancellation_reason = ?2,
             cancelled_by = ?3,
             cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             entity_version = ?4,
             base_version = ?5,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1",
        params![invoice_id, reason, user_id, new_version, old_version],
    )
    .map_err(to_error)?;
    let new_snapshot = load_invoice_snapshot(&tx, &invoice_id)?;
    tx.execute(
        "INSERT INTO local_sale_audit_log (id, invoice_id, action, user_id, device_id, reason, old_value, new_value, sync_status)
         VALUES (?1, ?2, 'CANCEL', ?3, ?4, ?5, ?6, ?7, 'pending')",
        params![
            unique_local_id("sale-audit"),
            invoice_id,
            user_id,
            device_id,
            reason,
            serde_json::to_string(&old_snapshot).map_err(to_error)?,
            serde_json::to_string(&new_snapshot).map_err(to_error)?,
        ],
    )
    .map_err(to_error)?;
    let operation_id = optional_text(&cancellation, "operation_id").unwrap_or_else(|| unique_local_id("sale-cancel-op"));
    let operation_payload = serde_json::json!({
        "operation_kind": "SALE_CANCEL",
        "base_version": old_version,
        "new_version": new_version,
        "reason": reason,
        "old_snapshot": old_snapshot,
        "sale": new_snapshot,
    });
    enqueue_sync_operation_with_conn(&tx, &SyncOperation {
        id: operation_id.clone(),
        operation_id: Some(operation_id),
        entity_type: "pos_sale".to_string(),
        entity_id: invoice_id.clone(),
        operation_type: "SALE_CANCEL".to_string(),
        payload: operation_payload,
        branch_id: Some(branch_id),
        device_id: Some(device_id),
        user_id,
        version: Some(new_version),
        created_at: None,
    })?;
    tx.commit().map_err(to_error)?;
    let conn = Connection::open(path).map_err(to_error)?;
    Ok(LocalPosSaleResult { invoice: new_snapshot, pending_operations: pending_outbox_count_at(&conn)? })
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
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8, ?9, ?10, ?10, COALESCE(?11, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), 'pending')
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
    let default_app_dir = app.path().app_data_dir().map_err(to_error)?;
    let app_dir = resolve_app_data_dir(
        default_app_dir,
        std::env::var("NODE_ENV").ok().as_deref(),
        std::env::var_os("FROOZERP_ISOLATED_SQLITE_DIR").map(PathBuf::from),
    )?;
    fs::create_dir_all(&app_dir).map_err(to_error)?;
    Ok(app_dir.join(LOCAL_DB_FILE))
}

fn resolve_app_data_dir(
    default_app_dir: PathBuf,
    node_env: Option<&str>,
    isolated_dir: Option<PathBuf>,
) -> Result<PathBuf, String> {
    if node_env != Some("test") {
        return Ok(default_app_dir);
    }
    let Some(isolated_dir) = isolated_dir else {
        return Ok(default_app_dir);
    };
    if !isolated_dir.is_absolute() {
        return Err("FROOZERP_ISOLATED_SQLITE_DIR must be an absolute path.".to_string());
    }
    Ok(isolated_dir)
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
            applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            checksum TEXT NOT NULL,
            status TEXT NOT NULL
        );",
    )
    .map_err(to_error)?;

    apply_migration(&mut conn, "001_local_foundation", MIGRATION_001)?;
    apply_migration(&mut conn, "002_sync_engine_foundation", MIGRATION_002)?;
    apply_migration(&mut conn, "003_local_first_pos", MIGRATION_003)?;
    apply_migration(&mut conn, "004_offline_sale_edit_cancel", MIGRATION_004)?;
    apply_migration(&mut conn, "005_mandi_tax_sale_details", MIGRATION_005)?;
    apply_migration(&mut conn, "006_multibranch_identity_foundation", MIGRATION_006)?;
    apply_migration(&mut conn, "007_cloud_runtime_and_inbox_foundation", MIGRATION_007)?;
    apply_migration(&mut conn, "009_canonical_utc_timestamps", MIGRATION_009)?;
    apply_migration(&mut conn, "010_sync_delivery_state", MIGRATION_010)?;
    apply_migration(&mut conn, "011_connectivity_mode_audit", MIGRATION_011)?;
    apply_migration(&mut conn, "012_connectivity_mode_server_time", MIGRATION_012)?;
    apply_migration(&mut conn, "013_operational_location_foundation", MIGRATION_013)?;
    apply_migration(&mut conn, "014_offline_purchase_grn", MIGRATION_014)?;
    apply_migration(&mut conn, "015_supplier_reference_cache", MIGRATION_015)?;
    apply_migration(&mut conn, "016_purchase_aggregate_reconciliation", MIGRATION_016)?;
    apply_migration(&mut conn, "017_offline_entitlement_foundation", MIGRATION_017)?;
    apply_migration(&mut conn, "018_bootstrap_credential_consumption", MIGRATION_018)?;
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
            "SELECT version FROM local_schema_migrations WHERE status = 'APPLIED' ORDER BY rowid DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(to_error)?;
    let last_sync: Option<String> = conn
        .query_row(
            "SELECT last_successful_sync_at FROM sync_state WHERE last_successful_sync_at IS NOT NULL ORDER BY last_successful_sync_at DESC LIMIT 1",
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
            "SELECT last_push_at FROM sync_state WHERE last_push_at IS NOT NULL ORDER BY last_push_at DESC LIMIT 1",
            &[],
        )?,
        last_pull_at: single_optional_string(
            &conn,
            "SELECT last_pull_at FROM sync_state WHERE last_pull_at IS NOT NULL ORDER BY last_pull_at DESC LIMIT 1",
            &[],
        )?,
        current_cursor: single_optional_string(
            &conn,
            "SELECT COALESCE(last_pull_cursor, last_server_cursor) FROM sync_state WHERE device_id <> 'default' ORDER BY updated_at DESC LIMIT 1",
            &[],
        )?,
        last_push_result: single_optional_string(&conn, "SELECT last_push_result FROM sync_state WHERE device_id <> 'default' ORDER BY updated_at DESC LIMIT 1", &[])?,
        error: None,
    })
}

fn cache_reference_snapshot_at(path: &Path, snapshot: &serde_json::Value) -> Result<(), String> {
    let mut conn = Connection::open(path).map_err(to_error)?;
    let tx = conn.transaction().map_err(to_error)?;

    let branch_id = snapshot
        .get("branch_context")
        .and_then(|value| optional_text(value, "branch_id"))
        .or_else(|| snapshot.get("device_identity").and_then(|value| optional_text(value, "branch_id")))
        .unwrap_or_else(|| "1".to_string());
    let device_identity = snapshot.get("device_identity").cloned().unwrap_or_else(|| serde_json::json!({}));
    let device_id = optional_text(&device_identity, "device_id")
        .filter(|value| value != "default")
        .ok_or_else(|| "Reference snapshot has no canonical device identity".to_string())?;
    let device_name = optional_text(&device_identity, "device_name").unwrap_or_else(|| "FroozERP Device".to_string());
    let platform = optional_text(&device_identity, "platform").unwrap_or_else(|| "tauri-windows".to_string());
    let app_version = optional_text(&device_identity, "app_version").unwrap_or_else(|| "1.0.0".to_string());
    let registration_status = optional_text(&device_identity, "registration_status").unwrap_or_else(|| "approved".to_string());
    let user_profile = snapshot.get("user_profile").cloned().unwrap_or_else(|| serde_json::json!({}));
    let company_id = optional_text(&user_profile, "company_id")
        .or_else(|| optional_text(&device_identity, "company_id"));
    let canonical_user_id = optional_text(&user_profile, "id");
    let canonical_role = optional_text(&user_profile, "role_name")
        .or_else(|| optional_text(&user_profile, "role"));

    tx.execute(
        "INSERT INTO local_device_identity (
            device_id, device_name, platform, app_version, branch_id, registration_status,
            company_id, user_id, role, last_seen_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(device_id) DO UPDATE SET
           device_name = excluded.device_name,
           platform = excluded.platform,
           app_version = excluded.app_version,
           branch_id = excluded.branch_id,
           registration_status = excluded.registration_status,
           company_id = COALESCE(excluded.company_id, local_device_identity.company_id),
           user_id = COALESCE(excluded.user_id, local_device_identity.user_id),
           role = COALESCE(excluded.role, local_device_identity.role),
           last_seen_at = excluded.last_seen_at,
           updated_at = excluded.updated_at",
        params![device_id, device_name, platform, app_version, branch_id, registration_status, company_id, canonical_user_id, canonical_role],
    )
    .map_err(to_error)?;

    if let Some(username) = optional_text(&user_profile, "username") {
        let key = format!("offline_user_profile::{}::{}", device_id, username.to_lowercase());
        tx.execute(
            "INSERT INTO local_kv (key, value, updated_at)
             VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, serde_json::to_string(&user_profile).map_err(to_error)?],
        )
        .map_err(to_error)?;
    }

    if let Some(offline_auth) = snapshot.get("offline_auth").cloned() {
        if let Some(username_lower) = optional_text(&offline_auth, "usernameLower")
            .or_else(|| optional_text(&offline_auth, "username_lower"))
        {
            let key = format!("offline_auth::{}::{}", device_id, username_lower.to_lowercase());
            tx.execute(
                "INSERT INTO local_kv (key, value, updated_at)
                 VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![key, serde_json::to_string(&offline_auth).map_err(to_error)?],
            )
            .map_err(to_error)?;
        }
    }

    tx.execute(
        "INSERT INTO local_kv (key, value, updated_at)
         VALUES ('offline_branch_context', ?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        [serde_json::to_string(snapshot.get("branch_context").unwrap_or(&serde_json::json!({}))).map_err(to_error)?],
    )
    .map_err(to_error)?;

    let reference_meta = serde_json::json!({
        "last_successful_sync_at": snapshot.get("last_successful_sync_at").and_then(|value| value.as_str()).unwrap_or(""),
        "cached_at": snapshot.get("cached_at").and_then(|value| value.as_str()).unwrap_or(""),
        "device_id": device_id,
        "branch_id": branch_id,
    });
    tx.execute(
        "INSERT INTO local_kv (key, value, updated_at)
         VALUES ('offline_reference_meta', ?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        [serde_json::to_string(&reference_meta).map_err(to_error)?],
    )
    .map_err(to_error)?;

    let canonical_scope: Option<(String, String)> = tx
        .query_row(
            "SELECT company_id, operational_location_id
             FROM local_device_assignment
             WHERE device_id = ?1 AND active = 1",
            [device_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(to_error)?;

    tx.execute("DELETE FROM local_inventory_lots WHERE COALESCE(branch_id, '1') = ?1", [branch_id.as_str()])
        .map_err(to_error)?;
    tx.execute("DELETE FROM local_products WHERE COALESCE(branch_id, '1') = ?1", [branch_id.as_str()])
        .map_err(to_error)?;
    tx.execute("DELETE FROM local_categories WHERE COALESCE(branch_id, '1') = ?1", [branch_id.as_str()])
        .map_err(to_error)?;
    tx.execute("DELETE FROM local_customers WHERE COALESCE(branch_id, '1') = ?1", [branch_id.as_str()])
        .map_err(to_error)?;
    tx.execute("DELETE FROM local_settings WHERE COALESCE(branch_id, '1') = ?1", [branch_id.as_str()])
        .map_err(to_error)?;

    let mut category_id_map: HashMap<String, String> = HashMap::new();
    if let Some(categories) = snapshot.get("categories").and_then(|value| value.as_array()) {
        for category in categories {
            let category_checksum = checksum(&serde_json::to_string(category).map_err(to_error)?);
            let category_id = optional_text(category, "global_id")
                .or_else(|| optional_text(category, "id"))
                .unwrap_or_else(|| format!("category-{category_checksum}"));
            for key in [optional_text(category, "global_id"), optional_text(category, "id")] {
                if let Some(key) = key.filter(|value| !value.is_empty()) {
                    category_id_map.insert(key, category_id.clone());
                }
            }
        }
    }

    if let Some(categories) = snapshot.get("categories").and_then(|value| value.as_array()) {
        for category in categories {
            let category_checksum = checksum(&serde_json::to_string(category).map_err(to_error)?);
            let category_id = optional_text(category, "global_id")
                .or_else(|| optional_text(category, "id"))
                .unwrap_or_else(|| format!("category-{category_checksum}"));
            tx.execute(
                "INSERT INTO local_categories (
                    id, cloud_id, branch_id, name, active, created_at, updated_at, version, sync_status, deleted_at
                 ) VALUES (?1, ?1, ?2, ?3, ?4, COALESCE(?5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), COALESCE(?6, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ?7, 'synced', ?8)",
                params![
                    category_id,
                    branch_id,
                    category
                        .get("category_name")
                        .or_else(|| category.get("name"))
                        .and_then(|value| value.as_str())
                        .unwrap_or("Uncategorised"),
                    if category.get("active").and_then(|value| value.as_bool()).unwrap_or(true) { 1 } else { 0 },
                    optional_text(category, "created_at"),
                    optional_text(category, "updated_at"),
                    category.get("entity_version").or_else(|| category.get("version")).and_then(|value| value.as_i64()).unwrap_or(1),
                    optional_text(category, "deleted_at"),
                ],
            )
            .map_err(to_error)?;
        }
    }

    let mut product_id_map: HashMap<String, String> = HashMap::new();
    if let Some(products) = snapshot.get("products").and_then(|value| value.as_array()) {
        for product in products {
            let product_checksum = checksum(&serde_json::to_string(product).map_err(to_error)?);
            let product_id = optional_text(product, "global_id")
                .or_else(|| optional_text(product, "id"))
                .unwrap_or_else(|| format!("product-{product_checksum}"));
            for key in [optional_text(product, "global_id"), optional_text(product, "id")] {
                if let Some(key) = key.filter(|value| !value.is_empty()) {
                    product_id_map.insert(key, product_id.clone());
                }
            }
        }
    }

    if let Some(products) = snapshot.get("products").and_then(|value| value.as_array()) {
        for product in products {
            let product_checksum = checksum(&serde_json::to_string(product).map_err(to_error)?);
            let product_id = optional_text(product, "global_id")
                .or_else(|| optional_text(product, "id"))
                .unwrap_or_else(|| format!("product-{product_checksum}"));
            let resolved_category_id = optional_text(product, "category_global_id")
                .or_else(|| optional_text(product, "category_id"))
                .and_then(|value| category_id_map.get(&value).cloned());
            tx.execute(
                "INSERT INTO local_products (
                    id, cloud_id, branch_id, product_name, category_id, category_name, unit, barcode,
                    sale_rate, minimum_stock, active, remarks, created_at, updated_at, version, sync_status,
                    deleted_at, company_id
                 ) VALUES (?1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, COALESCE(?12, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), COALESCE(?13, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ?14, 'synced', ?15, ?16)",
                params![
                    product_id,
                    branch_id,
                    product.get("product_name").and_then(|value| value.as_str()).unwrap_or("Unnamed Product"),
                    resolved_category_id,
                    product.get("category_name").or_else(|| product.get("category")).and_then(|value| value.as_str()),
                    optional_text(product, "unit"),
                    optional_text(product, "barcode"),
                    product.get("selling_rate").or_else(|| product.get("sale_rate")).and_then(json_number),
                    product.get("minimum_stock").and_then(json_number),
                    if product.get("active").and_then(|value| value.as_bool()).unwrap_or(true) { 1 } else { 0 },
                    optional_text(product, "remarks"),
                    optional_text(product, "created_at"),
                    optional_text(product, "updated_at"),
                    product.get("entity_version").or_else(|| product.get("version")).and_then(|value| value.as_i64()).unwrap_or(1),
                    optional_text(product, "deleted_at"),
                    optional_text(product, "company_id")
                        .or_else(|| canonical_scope.as_ref().map(|scope| scope.0.clone())),
                ],
            )
            .map_err(to_error)?;
        }
    }

    if let Some(lots) = snapshot.get("inventory_lots").and_then(|value| value.as_array()) {
        for lot in lots {
            let lot_checksum = checksum(&serde_json::to_string(lot).map_err(to_error)?);
            let lot_id = optional_text(lot, "global_id")
                .or_else(|| optional_text(lot, "id"))
                .unwrap_or_else(|| format!("lot-{lot_checksum}"));
            let product_id = optional_text(lot, "product_global_id")
                .or_else(|| optional_text(lot, "product_id"))
                .and_then(|value| product_id_map.get(&value).cloned())
                .unwrap_or_default();
            if product_id.is_empty() {
                continue;
            }
            tx.execute(
                "INSERT INTO local_inventory_lots (
                    id, cloud_id, branch_id, product_id, product_name, supplier_id, supplier_name,
                    lot_no, size_grade, opening_date, opening_qty, purchased_qty, sold_qty, returned_qty, waste_qty,
                    adjusted_qty, transfer_in_qty, transfer_out_qty, balance_qty, cost_rate, sale_rate, status,
                    remarks, created_at, updated_at, version, sync_status, deleted_at,
                    company_id, operational_location_id
                 ) VALUES (
                    ?1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19,
                    ?20, ?21, COALESCE(?22, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), COALESCE(?23, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ?24, 'synced', ?25,
                    ?26, ?27
                 )",
                params![
                    lot_id,
                    branch_id,
                    product_id,
                    optional_text(lot, "product_name"),
                    optional_text(lot, "supplier_id"),
                    optional_text(lot, "supplier_name"),
                    optional_text(lot, "lot_no").or_else(|| optional_text(lot, "batch_no")).or_else(|| optional_text(lot, "lot_name")),
                    optional_text(lot, "size_grade").or_else(|| optional_text(lot, "lot_size")),
                    optional_text(lot, "opening_date").or_else(|| optional_text(lot, "purchase_date")),
                    lot.get("opening_qty").or_else(|| lot.get("purchase_qty")).and_then(json_number).unwrap_or(0.0),
                    lot.get("sold_qty").and_then(json_number).unwrap_or_else(|| {
                        let opening = lot.get("purchase_qty").and_then(json_number).unwrap_or(0.0);
                        let balance = lot.get("remaining_qty").or_else(|| lot.get("balance_qty")).and_then(json_number).unwrap_or(0.0);
                        (opening - balance).max(0.0)
                    }),
                    lot.get("returned_qty").and_then(json_number).unwrap_or(0.0),
                    lot.get("waste_qty").and_then(json_number).unwrap_or(0.0),
                    lot.get("adjusted_qty").and_then(json_number).unwrap_or(0.0),
                    lot.get("transfer_in_qty").and_then(json_number).unwrap_or(0.0),
                    lot.get("transfer_out_qty").and_then(json_number).unwrap_or(0.0),
                    lot.get("remaining_qty").or_else(|| lot.get("balance_qty")).and_then(json_number).unwrap_or(0.0),
                    lot.get("effective_cost_per_unit").or_else(|| lot.get("purchase_rate")).and_then(json_number).unwrap_or(0.0),
                    lot.get("temporary_sale_rate").or_else(|| lot.get("sale_rate")).or_else(|| lot.get("selling_rate")).and_then(json_number),
                    optional_text(lot, "batch_status").or_else(|| optional_text(lot, "status")).unwrap_or_else(|| "ACTIVE".to_string()),
                    optional_text(lot, "remarks"),
                    optional_text(lot, "created_at"),
                    optional_text(lot, "updated_at"),
                    lot.get("entity_version").or_else(|| lot.get("version")).and_then(|value| value.as_i64()).unwrap_or(1),
                    optional_text(lot, "deleted_at"),
                    optional_text(lot, "company_id")
                        .or_else(|| canonical_scope.as_ref().map(|scope| scope.0.clone())),
                    optional_text(lot, "operational_location_id")
                        .or_else(|| canonical_scope.as_ref().map(|scope| scope.1.clone())),
                ],
            )
            .map_err(to_error)?;
        }
    }

    if let Some(customers) = snapshot.get("customers").and_then(|value| value.as_array()) {
        for customer in customers {
            let customer_checksum = checksum(&serde_json::to_string(customer).map_err(to_error)?);
            let customer_id = optional_text(customer, "global_id")
                .or_else(|| optional_text(customer, "id"))
                .unwrap_or_else(|| format!("customer-{customer_checksum}"));
            tx.execute(
                "INSERT INTO local_customers (
                    id, cloud_id, branch_id, account_name, mobile_number, account_type,
                    active, system_account, created_at, updated_at, version, sync_status, deleted_at
                 ) VALUES (?1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE(?8, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), COALESCE(?9, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ?10, 'synced', ?11)",
                params![
                    customer_id,
                    branch_id,
                    customer.get("customer_name").or_else(|| customer.get("account_name")).and_then(|value| value.as_str()).unwrap_or("Customer"),
                    optional_text(customer, "mobile_number"),
                    customer.get("customer_type").or_else(|| customer.get("account_type")).and_then(|value| value.as_str()).unwrap_or("Customer"),
                    if customer.get("active").and_then(|value| value.as_bool()).unwrap_or(true) { 1 } else { 0 },
                    if customer.get("system_account").and_then(|value| value.as_bool()).unwrap_or(false) { 1 } else { 0 },
                    optional_text(customer, "created_at"),
                    optional_text(customer, "updated_at"),
                    customer.get("entity_version").or_else(|| customer.get("version")).and_then(|value| value.as_i64()).unwrap_or(1),
                    optional_text(customer, "deleted_at"),
                ],
            )
            .map_err(to_error)?;
        }
    }

    if let Some(sales) = snapshot.get("sales_history").and_then(|value| value.as_array()) {
        for sale in sales {
            let sale_id = optional_text(sale, "global_id")
                .or_else(|| optional_text(sale, "id").map(|id| format!("cloud-sale-{id}")))
                .unwrap_or_else(|| format!("cloud-sale-{}", checksum(&sale.to_string())));
            let offline_ref = optional_text(sale, "offline_invoice_ref")
                .unwrap_or_else(|| format!("CLOUD-{}", sale_id));
            let bill_date = optional_text(sale, "sale_date")
                .or_else(|| optional_text(sale, "transaction_date"))
                .unwrap_or_else(|| "1970-01-01".to_string());
            let bill_datetime = optional_text(sale, "bill_datetime")
                .unwrap_or_else(|| format!("{}T00:00", bill_date));
            let gross_total = sale
                .get("gross_amount")
                .or_else(|| sale.get("gross_total"))
                .and_then(json_number)
                .unwrap_or(0.0);
            let item_discount_total = sale
                .get("item_discount_amount")
                .or_else(|| sale.get("item_discount_total"))
                .and_then(json_number)
                .unwrap_or(0.0);
            let bill_discount_total = sale
                .get("invoice_discount_amount")
                .or_else(|| sale.get("bill_discount_total"))
                .and_then(json_number)
                .unwrap_or(0.0);
            let tax_total = sale
                .get("tax_amount")
                .or_else(|| sale.get("tax_total"))
                .and_then(json_number)
                .unwrap_or(0.0);
            let net_total = sale
                .get("total_amount")
                .or_else(|| sale.get("net_total"))
                .and_then(json_number)
                .unwrap_or(0.0);
            tx.execute(
                "INSERT INTO local_pos_invoices (
                    id, offline_invoice_ref, branch_id, device_id, user_id, customer_id,
                    customer_name, customer_mobile, bill_date, bill_datetime, payment_mode,
                    gross_total, item_discount_total, bill_discount_total, tax_total, net_total,
                    status, sync_status, server_invoice_no, server_sale_id, entity_version,
                    created_at, updated_at, synced_at
                 ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                    ?12, ?13, ?14, ?15, ?16, ?17, 'synced', ?18, ?19, ?20,
                    COALESCE(?21, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), COALESCE(?22, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 )
                 ON CONFLICT(id) DO UPDATE SET
                    customer_id = excluded.customer_id,
                    customer_name = excluded.customer_name,
                    customer_mobile = excluded.customer_mobile,
                    bill_date = excluded.bill_date,
                    bill_datetime = excluded.bill_datetime,
                    payment_mode = excluded.payment_mode,
                    gross_total = excluded.gross_total,
                    item_discount_total = excluded.item_discount_total,
                    bill_discount_total = excluded.bill_discount_total,
                    tax_total = excluded.tax_total,
                    net_total = excluded.net_total,
                    status = excluded.status,
                    sync_status = 'synced',
                    server_invoice_no = excluded.server_invoice_no,
                    server_sale_id = excluded.server_sale_id,
                    entity_version = excluded.entity_version,
                    updated_at = excluded.updated_at,
                    synced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
                params![
                    sale_id,
                    offline_ref,
                    branch_id,
                    optional_text(sale, "source_device_id").unwrap_or_else(|| device_id.clone()),
                    optional_text(sale, "created_by"),
                    optional_text(sale, "customer_id"),
                    optional_text(sale, "customer_name"),
                    optional_text(sale, "customer_mobile"),
                    bill_date,
                    bill_datetime,
                    optional_text(sale, "payment_mode").unwrap_or_else(|| "UNKNOWN".to_string()),
                    gross_total,
                    item_discount_total,
                    bill_discount_total,
                    tax_total,
                    net_total,
                    optional_text(sale, "sale_status")
                        .or_else(|| optional_text(sale, "status"))
                        .unwrap_or_else(|| "COMPLETED".to_string()),
                    optional_text(sale, "invoice_no"),
                    optional_text(sale, "id"),
                    sale.get("entity_version").and_then(|value| value.as_i64()).unwrap_or(1),
                    optional_text(sale, "created_at"),
                    optional_text(sale, "updated_at"),
                ],
            )
            .map_err(to_error)?;
        }
    }

    if let Some(suppliers) = snapshot
        .get("settings_bundle")
        .and_then(|value| value.get("offlineSuppliers"))
        .and_then(|value| value.as_array())
    {
        for supplier in suppliers {
            let supplier_id = optional_text(supplier, "id")
                .ok_or_else(|| "Supplier reference has no canonical identity".to_string())?;
            upsert_supplier_reference_with_tx(
                &tx,
                &supplier_id,
                supplier,
                optional_text(supplier, "updated_at"),
                supplier.get("entity_version").or_else(|| supplier.get("version")).and_then(|value| value.as_i64()).unwrap_or(1),
                false,
            )?;
        }
    }

    if let Some(settings_bundle) = snapshot.get("settings_bundle").and_then(|value| value.as_object()) {
        for (key, value) in settings_bundle {
            if key == "offlineSuppliers" {
                continue;
            }
            tx.execute(
                "INSERT INTO local_settings (
                    id, cloud_id, branch_id, setting_key, setting_value, created_at, updated_at, version, sync_status
                 ) VALUES (?1, ?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 1, 'synced')
                 ON CONFLICT(id) DO UPDATE SET
                   branch_id = excluded.branch_id,
                   setting_key = excluded.setting_key,
                   setting_value = excluded.setting_value,
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                   version = local_settings.version + 1,
                   sync_status = 'synced',
                   deleted_at = NULL",
                params![
                    format!("setting-{}-{}", branch_id, key),
                    branch_id,
                    key,
                    serde_json::to_string(value).map_err(to_error)?,
                ],
            )
            .map_err(to_error)?;
        }
    }

    tx.execute(
        "INSERT INTO sync_state (device_id, last_successful_sync_at, current_sync_status, updated_at)
         VALUES (?1, COALESCE(?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), 'IDLE', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(device_id) DO UPDATE SET
           last_successful_sync_at = COALESCE(excluded.last_successful_sync_at, sync_state.last_successful_sync_at),
           current_sync_status = 'IDLE',
           updated_at = excluded.updated_at",
        params![device_id, snapshot.get("last_successful_sync_at").and_then(|value| value.as_str())],
    )
    .map_err(to_error)?;

    tx.commit().map_err(to_error)
}

fn load_reference_snapshot_at(
    path: &Path,
    username: Option<&str>,
    device_id: Option<&str>,
) -> Result<serde_json::Value, String> {
    validate_reference_snapshot_source_at(path)?;
    initialize_at(path)?;
    let conn = Connection::open(path).map_err(to_error)?;
    let requested_device = device_id.unwrap_or("default");
    let username_key = username
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty());

    let user_profile = if let Some(username_lower) = username_key {
        let key = format!("offline_user_profile::{}::{}", requested_device, username_lower);
        single_optional_string(&conn, "SELECT value FROM local_kv WHERE key = ?1", &[&key])?
            .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok())
            .unwrap_or_else(|| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    let offline_auth = if let Some(username_lower) = username
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
    {
        let key = format!("offline_auth::{}::{}", requested_device, username_lower);
        single_optional_string(&conn, "SELECT value FROM local_kv WHERE key = ?1", &[&key])?
            .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok())
            .unwrap_or_else(|| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    let branch_context = single_optional_string(&conn, "SELECT value FROM local_kv WHERE key = 'offline_branch_context'", &[])?
        .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok())
        .unwrap_or_else(|| serde_json::json!({ "branch_id": "1", "branch_name": "Main Branch" }));

    let device_identity = conn
        .query_row(
            "SELECT device_id, device_name, platform, app_version, branch_id, registration_status, last_seen_at, last_sync_at
             FROM local_device_identity
             WHERE device_id = ?1
             ORDER BY updated_at DESC
             LIMIT 1",
            [requested_device],
            |row| {
                Ok(serde_json::json!({
                    "device_id": row.get::<_, String>(0)?,
                    "device_name": row.get::<_, String>(1)?,
                    "platform": row.get::<_, String>(2)?,
                    "app_version": row.get::<_, String>(3)?,
                    "branch_id": row.get::<_, String>(4)?,
                    "registration_status": row.get::<_, String>(5)?,
                    "last_seen_at": row.get::<_, Option<String>>(6)?,
                    "last_sync_at": row.get::<_, Option<String>>(7)?,
                }))
            },
        )
        .optional()
        .map_err(to_error)?
        .unwrap_or_else(|| serde_json::json!({}));

    let categories = {
        let mut statement = conn
            .prepare(
                "SELECT id, branch_id, name, active, updated_at, version, deleted_at
                 FROM local_categories
                 WHERE deleted_at IS NULL
                 ORDER BY name",
            )
            .map_err(to_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "category_name": row.get::<_, String>(2)?,
                    "active": row.get::<_, i64>(3)? == 1,
                    "updated_at": row.get::<_, Option<String>>(4)?,
                    "entity_version": row.get::<_, i64>(5)?,
                    "deleted_at": row.get::<_, Option<String>>(6)?,
                    "branch_id": row.get::<_, Option<String>>(1)?,
                }))
            })
            .map_err(to_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(to_error)?
    };

    let products = {
        let mut statement = conn
            .prepare(
                "SELECT
                    p.id, p.product_name, p.category_id, p.category_name, p.unit, p.barcode,
                    p.sale_rate, p.minimum_stock, p.active, p.remarks, p.updated_at, p.version,
                    COALESCE(SUM(CASE WHEN l.deleted_at IS NULL AND UPPER(COALESCE(l.status, 'ACTIVE')) <> 'CANCELLED' THEN l.balance_qty ELSE 0 END), 0) AS current_stock,
                    COUNT(CASE WHEN l.deleted_at IS NULL AND UPPER(COALESCE(l.status, 'ACTIVE')) <> 'CANCELLED' THEN 1 END) AS lot_count
                 FROM local_products p
                 LEFT JOIN local_inventory_lots l ON l.product_id = p.id
                 WHERE p.deleted_at IS NULL
                 GROUP BY p.id, p.product_name, p.category_id, p.category_name, p.unit, p.barcode,
                          p.sale_rate, p.minimum_stock, p.active, p.remarks, p.updated_at, p.version
                 ORDER BY p.product_name",
            )
            .map_err(to_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "product_name": row.get::<_, String>(1)?,
                    "category_id": row.get::<_, Option<String>>(2)?,
                    "category_name": row.get::<_, Option<String>>(3)?,
                    "unit": row.get::<_, Option<String>>(4)?,
                    "barcode": row.get::<_, Option<String>>(5)?,
                    "selling_rate": row.get::<_, Option<f64>>(6)?,
                    "sale_rate": row.get::<_, Option<f64>>(6)?,
                    "minimum_stock": row.get::<_, Option<f64>>(7)?,
                    "active": row.get::<_, i64>(8)? == 1,
                    "remarks": row.get::<_, Option<String>>(9)?,
                    "updated_at": row.get::<_, Option<String>>(10)?,
                    "entity_version": row.get::<_, i64>(11)?,
                    "current_stock": row.get::<_, f64>(12)?,
                    "lot_count": row.get::<_, i64>(13)?,
                }))
            })
            .map_err(to_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(to_error)?
    };

    let inventory_lots = {
        let mut statement = conn
            .prepare(
                "SELECT id, product_id, product_name, supplier_id, supplier_name, lot_no, size_grade,
                        opening_date, opening_qty, sold_qty, adjusted_qty, balance_qty, cost_rate, sale_rate,
                        status, remarks, created_at, updated_at
                 FROM local_inventory_lots
                 WHERE deleted_at IS NULL
                 ORDER BY product_name, opening_date, id",
            )
            .map_err(to_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "product_id": row.get::<_, String>(1)?,
                    "product_name": row.get::<_, Option<String>>(2)?,
                    "supplier_id": row.get::<_, Option<String>>(3)?,
                    "supplier_name": row.get::<_, Option<String>>(4)?,
                    "batch_no": row.get::<_, Option<String>>(5)?,
                    "lot_name": row.get::<_, Option<String>>(5)?,
                    "lot_size": row.get::<_, Option<String>>(6)?,
                    "size_grade": row.get::<_, Option<String>>(6)?,
                    "purchase_date": row.get::<_, Option<String>>(7)?,
                    "opening_date": row.get::<_, Option<String>>(7)?,
                    "purchase_qty": row.get::<_, f64>(8)?,
                    "opening_qty": row.get::<_, f64>(8)?,
                    "sold_qty": row.get::<_, f64>(9)?,
                    "adjusted_qty": row.get::<_, f64>(10)?,
                    "remaining_qty": row.get::<_, f64>(11)?,
                    "balance_qty": row.get::<_, f64>(11)?,
                    "purchase_rate": row.get::<_, f64>(12)?,
                    "effective_cost_per_unit": row.get::<_, f64>(12)?,
                    "temporary_sale_rate": row.get::<_, Option<f64>>(13)?,
                    "sale_rate": row.get::<_, Option<f64>>(13)?,
                    "batch_status": row.get::<_, String>(14)?,
                    "remarks": row.get::<_, Option<String>>(15)?,
                    "created_at": row.get::<_, Option<String>>(16)?,
                    "updated_at": row.get::<_, Option<String>>(17)?,
                }))
            })
            .map_err(to_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(to_error)?
    };

    let customers = {
        let mut statement = conn
            .prepare(
                "SELECT id, account_name, mobile_number, account_type, active, system_account, updated_at, version
                 FROM local_customers
                 WHERE deleted_at IS NULL
                 ORDER BY account_name",
            )
            .map_err(to_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "customer_name": row.get::<_, String>(1)?,
                    "account_name": row.get::<_, String>(1)?,
                    "mobile_number": row.get::<_, Option<String>>(2)?,
                    "customer_type": row.get::<_, String>(3)?,
                    "account_type": row.get::<_, String>(3)?,
                    "active": row.get::<_, i64>(4)? == 1,
                    "system_account": row.get::<_, i64>(5)? == 1,
                    "updated_at": row.get::<_, Option<String>>(6)?,
                    "entity_version": row.get::<_, i64>(7)?,
                }))
            })
            .map_err(to_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(to_error)?
    };

    let mut settings_bundle = {
        let mut statement = conn
            .prepare("SELECT setting_key, setting_value FROM local_settings WHERE deleted_at IS NULL ORDER BY setting_key")
            .map_err(to_error)?;
        let rows = statement
            .query_map([], |row| {
                let key: String = row.get(0)?;
                let value: String = row.get(1)?;
                let parsed = serde_json::from_str::<serde_json::Value>(&value).unwrap_or(serde_json::Value::String(value));
                Ok((key, parsed))
            })
            .map_err(to_error)?;
        let mut map = serde_json::Map::new();
        for row in rows {
            let (key, value) = row.map_err(to_error)?;
            map.insert(key, value);
        }
        serde_json::Value::Object(map)
    };
    let offline_suppliers = {
        let mut statement = conn
            .prepare(
                "SELECT id, company_id, supplier_name, firm_name, supplier_type, active,
                        created_at, updated_at, version
                 FROM local_supplier_references
                 WHERE deleted_at IS NULL
                 ORDER BY supplier_name, id",
            )
            .map_err(to_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "company_id": row.get::<_, String>(1)?,
                    "supplier_name": row.get::<_, String>(2)?,
                    "firm_name": row.get::<_, Option<String>>(3)?,
                    "supplier_type": row.get::<_, String>(4)?,
                    "active": row.get::<_, i64>(5)? == 1,
                    "created_at": row.get::<_, Option<String>>(6)?,
                    "updated_at": row.get::<_, String>(7)?,
                    "entity_version": row.get::<_, i64>(8)?,
                }))
            })
            .map_err(to_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(to_error)?
    };
    let mut offline_purchases = settings_bundle
        .get("offlinePurchases")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    for purchase in list_local_purchase_intents_with_conn(&conn)? {
        let purchase_id = optional_text(&purchase, "id").unwrap_or_default();
        if !offline_purchases.iter().any(|row| optional_text(row, "id").unwrap_or_default() == purchase_id) {
            offline_purchases.push(purchase);
        }
    }
    if let Some(bundle) = settings_bundle.as_object_mut() {
        bundle.insert("offlinePurchases".to_string(), serde_json::Value::Array(offline_purchases.clone()));
        bundle.insert("offlineSuppliers".to_string(), serde_json::Value::Array(offline_suppliers));
    }

    let sales_history = {
        let mut statement = conn
            .prepare(
                "SELECT id, offline_invoice_ref, bill_date, bill_datetime, customer_name, customer_mobile,
                        payment_mode, gross_total, item_discount_total, bill_discount_total, tax_total, net_total,
                        status, sync_status, server_invoice_no, created_at
                 FROM local_pos_invoices
                 ORDER BY datetime(created_at) DESC, id DESC",
            )
            .map_err(to_error)?;
        let rows = statement
            .query_map([], |row| {
                let invoice_no: Option<String> = row.get(14)?;
                let offline_ref: String = row.get(1)?;
                let net_total: f64 = row.get(11)?;
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "invoice_no": invoice_no.unwrap_or_else(|| offline_ref.clone()),
                    "offline_invoice_ref": offline_ref,
                    "sale_date": row.get::<_, String>(2)?,
                    "bill_datetime": row.get::<_, String>(3)?,
                    "customer_name": row.get::<_, Option<String>>(4)?,
                    "customer_mobile": row.get::<_, Option<String>>(5)?,
                    "payment_mode": row.get::<_, String>(6)?,
                    "gross_amount": row.get::<_, f64>(7)?,
                    "item_discount_amount": row.get::<_, f64>(8)?,
                    "invoice_discount_amount": row.get::<_, f64>(9)?,
                    "tax_amount": row.get::<_, f64>(10)?,
                    "total_amount": net_total,
                    "amount": net_total,
                    "sale_status": row.get::<_, String>(12)?,
                    "sync_status": row.get::<_, String>(13)?,
                    "created_at": row.get::<_, Option<String>>(15)?,
                }))
            })
            .map_err(to_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(to_error)?
    };

    let last_successful_sync_at = single_optional_string(
        &conn,
        "SELECT last_successful_sync_at FROM sync_state ORDER BY updated_at DESC LIMIT 1",
        &[],
    )?;
    let pending_operations = count_outbox_status(&conn, &["pending", "syncing", "failed"])?;
    let reference_ready = !products.is_empty() && !inventory_lots.is_empty();

    Ok(serde_json::json!({
        "reference_ready": reference_ready,
        "first_sync_required": !reference_ready,
        "database_path": path_to_string(path),
        "last_successful_sync_at": last_successful_sync_at,
        "device_identity": device_identity,
        "branch_context": branch_context,
        "user_profile": user_profile,
        "offline_auth": offline_auth,
        "products": products,
        "categories": categories,
        "inventory_lots": inventory_lots,
        "customers": customers,
        "settings_bundle": settings_bundle,
        "offline_purchases": offline_purchases,
        "sales_history": sales_history,
        "pending_operations": pending_operations,
        "failed_operations": count_outbox_status(&conn, &["failed"])?,
        "conflict_operations": count_outbox_status(&conn, &["conflict"])?,
    }))
}

fn validate_reference_snapshot_source_at(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "Local snapshot database corruption: unable to open the existing database read-only".to_string())?;
    let integrity = conn
        .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
        .map_err(|_| "Local snapshot database corruption: integrity check could not be completed".to_string())?;
    if !integrity.eq_ignore_ascii_case("ok") {
        return Err("Local snapshot database corruption: integrity check failed".to_string());
    }

    for table in [
        "local_schema_migrations",
        "local_kv",
        "local_device_identity",
        "local_products",
        "local_inventory_lots",
        "local_supplier_references",
        "sync_outbox",
    ] {
        let present = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                [table],
                |row| row.get::<_, i64>(0),
            )
            .map_err(to_error)?;
        if present != 1 {
            return Err(format!("Local snapshot has an incompatible schema: missing required table {table}"));
        }
    }
    Ok(())
}

fn set_smoke_value_at(path: &Path, value: &str) -> Result<(), String> {
    let conn = Connection::open(path).map_err(to_error)?;
    conn.execute(
        "INSERT INTO local_kv (key, value, updated_at)
         VALUES ('phase1_smoke_test', ?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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

fn single_optional_string(conn: &Connection, sql: &str, params: &[&dyn rusqlite::ToSql]) -> Result<Option<String>, String> {
    conn.query_row(sql, params, |row| row.get::<_, Option<String>>(0))
        .optional()
        .map(|value| value.flatten())
        .map_err(to_error)
}

pub fn ensure_device_identity_at(path: &Path) -> Result<serde_json::Value, String> {
    ensure_device_identity_with_preference_at(path, None)
}

/// Grandfathered validity, ruled in D-15. Generous on purpose: a device must not silently
/// expire before anyone notices the rollout stalled.
const GRANDFATHER_VALID_DAYS: i64 = 400;

/// Write the §11.1 compatibility shim for a device that predates offline activation.
///
/// Every installation that exists today has an approved `local_device_identity`, a cached
/// snapshot and `offline_auth::*` rows, but **no entitlement and no way to obtain one online**,
/// because the cloud it would have asked is gone. Requiring a signed code before the app runs
/// would brick every existing device on upgrade, so those devices get a shim instead.
///
/// The rule keys off `local_device_identity` plus a real cached `user_profile` **deliberately
/// not off `local_device_assignment`**, which measured empty across every real profile
/// (backlog item 2) and would therefore never fire.
///
/// This is a compatibility shim, not a credential:
/// - `verification_state = 'LEGACY_GRANDFATHER'` with an **empty** `signature_blob`, which is
///   the only shape migration 017's CHECK admits for that state. `payload_blob` is
///   `BLOB NOT NULL` and the grandfather branch does not exempt it, so it is bound as an empty
///   blob — never NULL, which would fail the NOT NULL constraint.
/// - It cannot authorise provisioning another device; that needs a `VERIFIED` entitlement.
/// - It is superseded on first redemption of a real code.
///
/// Returns `Ok(false)` when the device does not qualify — that is an ordinary outcome, not an
/// error. Errors are reserved for a database that would not answer.
fn grandfather_existing_device(
    conn: &Connection,
    identity: &serde_json::Value,
) -> Result<bool, String> {
    let device_id = match optional_text(identity, "device_id")
        .filter(|value| !value.eq_ignore_ascii_case("default"))
    {
        Some(value) => value,
        None => return Ok(false),
    };

    // Any entitlement at all means this device is already provisioned, or already shimmed.
    // Checking for *any* row rather than an active one keeps this idempotent across restarts
    // and stops a superseded shim being recreated behind a real entitlement.
    let existing: i64 = conn
        .query_row("SELECT COUNT(*) FROM local_entitlement", [], |row| row.get(0))
        .map_err(to_error)?;
    if existing > 0 {
        return Ok(false);
    }

    // A real cached snapshot is the second half of the rule. The snapshot's user profile lives
    // in local_kv under `offline_user_profile::<device>::<username>`; an empty object is what
    // gets written when nothing matched, so it does not count as real.
    let profile_prefix = format!("offline_user_profile::{}::", device_id);
    let profile: Option<String> = conn
        .query_row(
            "SELECT value FROM local_kv WHERE key LIKE ?1 || '%' ORDER BY key LIMIT 1",
            params![profile_prefix],
            |row| row.get(0),
        )
        .optional()
        .map_err(to_error)?;
    let has_real_profile = profile
        .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok())
        .and_then(|value| value.as_object().map(|map| !map.is_empty()))
        .unwrap_or(false);
    if !has_real_profile {
        return Ok(false);
    }

    let company_id: Option<String> = conn
        .query_row(
            "SELECT company_id FROM local_device_identity WHERE device_id = ?1",
            params![device_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(to_error)?
        .flatten();
    let company_id = company_id.unwrap_or_else(|| "1".to_string());
    let branch_id = optional_text(identity, "branch_id")
        .filter(|value| !value.eq_ignore_ascii_case("unassigned"))
        .unwrap_or_else(|| "1".to_string());

    let binding = crate::entitlement::device_binding_hash(&device_id);
    let device_binding_hex = binding
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();

    // Deterministic serial: the PRIMARY KEY itself refuses a duplicate shim, so idempotency
    // does not rest solely on the COUNT check above.
    let serial = format!("LEGACY-{device_id}");
    let expires_offset = format!("+{GRANDFATHER_VALID_DAYS} days");
    let grace_offset = format!(
        "+{} days",
        GRANDFATHER_VALID_DAYS + crate::entitlement::GRACE_DAYS
    );

    conn.execute(
        "INSERT OR IGNORE INTO local_entitlement (
            entitlement_serial, key_id, format_version, company_id, branch_id, device_id,
            device_binding_hex, issued_at, expires_at, grace_until, capabilities_json,
            payload_blob, signature_blob, verification_state, source
         ) VALUES (
            ?1, 0, ?2, ?3, ?4, ?5,
            ?6,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?7),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?8),
            '{}',
            X'', X'', 'LEGACY_GRANDFATHER', 'LEGACY_UPGRADE'
         )",
        params![
            serial,
            crate::entitlement::FORMAT_VERSION as i64,
            company_id,
            branch_id,
            device_id,
            device_binding_hex,
            expires_offset,
            grace_offset
        ],
    )
    .map_err(to_error)?;

    conn.execute(
        "INSERT INTO local_entitlement_audit (entitlement_serial, event, reason_code, detail_json, device_id)
         VALUES (?1, 'ACCEPTED', 'LEGACY_GRANDFATHER', ?2, ?3)",
        params![
            serial,
            format!("{{\"valid_days\":{GRANDFATHER_VALID_DAYS},\"source\":\"LEGACY_UPGRADE\"}}"),
            device_id
        ],
    )
    .map_err(to_error)?;

    Ok(true)
}

// =======================================================================================
// Offline activation redemption and state (design §6.2, Stage 5).
//
// These are the first call sites of `entitlement.rs`. The pure core decides the *meaning* of a
// signature, a clock and a capability; everything here is the SQLite side: it stores what was
// accepted, replays the ledger to answer "what state is this device in?", and records every
// decision in the append-only audit log. No state except Unprovisioned ever denies billing —
// that invariant lives in `EntitlementState::billing_allowed` and is surfaced verbatim below.
// =======================================================================================

/// Lowercase hex of a byte slice — the on-disk shape for `device_binding_hex`, salts, verifiers
/// and payload fingerprints throughout this feature.
fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Replay-guard fingerprint: lowercase-hex SHA-256 of the *exact* payload blob (§5.3).
fn payload_fingerprint(payload: &[u8]) -> String {
    use sha2::Digest;
    hex_lower(&sha2::Sha256::digest(payload))
}

/// Render a day-stamp (days since 2020-01-01) as the migration-009 ISO shape via SQLite, so the
/// stored `issued_at`/`expires_at`/`grace_until` match every other timestamp in the schema.
fn day_to_iso_at(conn: &Connection, day: i64) -> Result<String, String> {
    conn.query_row(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', '2020-01-01', ?1)",
        params![format!("+{day} days")],
        |row| row.get(0),
    )
    .map_err(to_error)
}

/// The `source` values migration 017's CHECK admits.
const ALLOWED_ENTITLEMENT_SOURCES: &[&str] = &[
    "ONLINE_REGISTRATION",
    "OFFLINE_FILE",
    "OFFLINE_TYPED",
    "OFFLINE_QR",
    "LEGACY_UPGRADE",
];

/// Append one row to the entitlement audit log (§5.2).
fn record_entitlement_audit_at(
    conn: &Connection,
    serial: Option<&str>,
    event: &str,
    reason_code: Option<&str>,
    detail_json: &str,
    device_id: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO local_entitlement_audit
           (entitlement_serial, event, reason_code, detail_json, device_id)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![serial, event, reason_code, detail_json, device_id],
    )
    .map_err(to_error)?;
    Ok(())
}

pub fn record_entitlement_audit(
    app: &AppHandle,
    serial: Option<String>,
    event: String,
    reason_code: Option<String>,
    detail_json: String,
    device_id: String,
) -> Result<(), String> {
    let path = database_path(app)?;
    initialize_at(&path)?;
    let conn = Connection::open(&path).map_err(to_error)?;
    record_entitlement_audit_at(
        &conn,
        serial.as_deref(),
        &event,
        reason_code.as_deref(),
        &detail_json,
        &device_id,
    )
}

/// Verify and accept an activation artefact, writing the VERIFIED ledger row (§6.2).
///
/// `trusted_keys` is a parameter rather than a hard reference to `TRUSTED_ACTIVATION_KEYS` for the
/// same reason `entitlement::verify` takes it: the tests sign with their own throwaway key and
/// must be able to supply the matching trusted table without depending on production key material.
/// The public wrapper passes `entitlement::TRUSTED_ACTIVATION_KEYS`.
fn accept_entitlement_at(
    path: &Path,
    device_id: &str,
    payload: &[u8],
    signature: &[u8],
    source: &str,
    trusted_keys: &[(u8, [u8; 32])],
) -> Result<serde_json::Value, String> {
    if !ALLOWED_ENTITLEMENT_SOURCES.contains(&source) {
        return Err(format!(
            "INVALID_SOURCE: {source:?} is not an accepted activation source"
        ));
    }

    initialize_at(path)?;
    let mut conn = Connection::open(path).map_err(to_error)?;

    let fingerprint = payload_fingerprint(payload);

    // 1. Cryptographic verification over the exact bytes (§3.4). A rejection is logged and the
    //    fingerprint remembered so the same bad artefact is recognised offline next time.
    let verified = match entitlement::verify(payload, signature, trusted_keys) {
        Ok(verified) => verified,
        Err(reason) => {
            let reason_code = format!("{reason:?}");
            record_entitlement_audit_at(&conn, None, "REJECTED", Some(&reason_code), "{}", device_id)?;
            conn.execute(
                "INSERT OR IGNORE INTO local_activation_code_seen (fingerprint, outcome)
                 VALUES (?1, 'REJECTED')",
                params![fingerprint],
            )
            .map_err(to_error)?;
            return Err(reason_code);
        }
    };

    // 2. Device binding (D-9). Verification says "did we sign this?"; binding says "was it meant
    //    for this machine?". They fail for different reasons and report differently.
    if entitlement::check_device_binding(verified.payload(), device_id).is_err() {
        record_entitlement_audit_at(
            &conn,
            None,
            "REJECTED",
            Some("DeviceBindingMismatch"),
            "{}",
            device_id,
        )?;
        return Err(
            "DEVICE_BINDING_MISMATCH: this activation file is for a different device".to_string(),
        );
    }

    let payload_parsed = verified.payload();
    let serial = payload_parsed.entitlement_serial.to_string();

    // 3. Idempotency: a fingerprint already seen AND a ledger row already present for this serial
    //    means this exact artefact was accepted before. Re-report the acceptance, do not double
    //    insert or re-supersede.
    let already_seen = conn
        .query_row(
            "SELECT 1 FROM local_activation_code_seen WHERE fingerprint = ?1",
            params![fingerprint],
            |_| Ok(()),
        )
        .optional()
        .map_err(to_error)?
        .is_some();
    let serial_present = conn
        .query_row(
            "SELECT 1 FROM local_entitlement WHERE entitlement_serial = ?1",
            params![serial],
            |_| Ok(()),
        )
        .optional()
        .map_err(to_error)?
        .is_some();
    if already_seen && serial_present {
        return Ok(serde_json::json!({
            "accepted": true,
            "idempotent": true,
            "entitlement_serial": serial,
            "verification_state": "VERIFIED",
            "source": source,
            "bootstrap_present": payload_parsed.carries_credential(),
        }));
    }

    // 4. Derive the stored columns from the signed payload.
    let company_id = payload_parsed.company_id.to_string();
    let branch_id = payload_parsed.branch_id.to_string();
    let device_binding_hex = hex_lower(&payload_parsed.device_binding);
    let issued_at_iso = day_to_iso_at(&conn, i64::from(payload_parsed.issued_at))?;
    let expires_at_iso = day_to_iso_at(&conn, payload_parsed.expires_at_day())?;
    let grace_until_iso = day_to_iso_at(&conn, payload_parsed.grace_until_day())?;

    let tx = conn.transaction().map_err(to_error)?;

    // 5. Supersede any prior live entitlement for this device — including a §11.1 grandfather
    //    shim on the first real redemption. Superseded serials are logged individually.
    let mut superseded: Vec<String> = Vec::new();
    {
        let mut stmt = tx
            .prepare(
                "SELECT entitlement_serial FROM local_entitlement
                 WHERE device_id = ?1 AND superseded_at IS NULL AND revoked_at IS NULL
                   AND entitlement_serial <> ?2",
            )
            .map_err(to_error)?;
        let rows = stmt
            .query_map(params![device_id, serial], |row| row.get::<_, String>(0))
            .map_err(to_error)?;
        for row in rows {
            superseded.push(row.map_err(to_error)?);
        }
    }
    tx.execute(
        "UPDATE local_entitlement
            SET superseded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE device_id = ?1 AND superseded_at IS NULL AND revoked_at IS NULL
            AND entitlement_serial <> ?2",
        params![device_id, serial],
    )
    .map_err(to_error)?;
    for prior in &superseded {
        record_entitlement_audit_at(
            &tx,
            Some(prior),
            "SUPERSEDED",
            Some("SUPERSEDED_BY_REDEMPTION"),
            &format!("{{\"superseded_by\":\"{serial}\"}}"),
            device_id,
        )?;
    }

    // 6. Insert the VERIFIED row. Migration 017's CHECK enforces a 64-byte signature over a
    //    non-empty payload; `verify` already guaranteed both.
    tx.execute(
        "INSERT OR IGNORE INTO local_entitlement (
            entitlement_serial, key_id, format_version, company_id, branch_id, device_id,
            device_binding_hex, issued_at, expires_at, grace_until, capabilities_json,
            payload_blob, signature_blob, verification_state, source
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, '{}', ?11, ?12, 'VERIFIED', ?13)",
        params![
            serial,
            i64::from(payload_parsed.key_id),
            i64::from(payload_parsed.format_version),
            company_id,
            branch_id,
            device_id,
            device_binding_hex,
            issued_at_iso,
            expires_at_iso,
            grace_until_iso,
            payload,
            signature,
            source,
        ],
    )
    .map_err(to_error)?;

    // 7. Remember the fingerprint and log the acceptance.
    tx.execute(
        "INSERT OR IGNORE INTO local_activation_code_seen (fingerprint, outcome)
         VALUES (?1, 'ACCEPTED')",
        params![fingerprint],
    )
    .map_err(to_error)?;
    record_entitlement_audit_at(
        &tx,
        Some(&serial),
        "ACCEPTED",
        None,
        &format!("{{\"source\":\"{source}\",\"verification_state\":\"VERIFIED\"}}"),
        device_id,
    )?;

    tx.commit().map_err(to_error)?;

    Ok(serde_json::json!({
        "accepted": true,
        "entitlement_serial": serial,
        "verification_state": "VERIFIED",
        "source": source,
        "superseded": superseded,
        "bootstrap_present": payload_parsed.carries_credential(),
    }))
}

pub fn accept_entitlement(
    app: &AppHandle,
    device_id: &str,
    payload: &[u8],
    signature: &[u8],
    source: &str,
) -> Result<serde_json::Value, String> {
    let path = database_path(app)?;
    accept_entitlement_at(
        &path,
        device_id,
        payload,
        signature,
        source,
        entitlement::TRUSTED_ACTIVATION_KEYS,
    )
}

/// The current live entitlement row for a device, as a JSON object (blobs omitted; the signature
/// is reported as a length). `None` when the device has no live entitlement.
fn active_entitlement_at(path: &Path, device_id: &str) -> Result<Option<serde_json::Value>, String> {
    initialize_at(path)?;
    let conn = Connection::open(path).map_err(to_error)?;
    conn.query_row(
        "SELECT entitlement_serial, key_id, format_version, company_id, branch_id, device_id,
                device_binding_hex, issued_at, expires_at, grace_until, capabilities_json,
                verification_state, source, accepted_at, superseded_at, revoked_at,
                revocation_reason, bootstrap_consumed_at, length(signature_blob)
           FROM local_entitlement
          WHERE device_id = ?1 AND superseded_at IS NULL AND revoked_at IS NULL
          ORDER BY issued_at DESC
          LIMIT 1",
        params![device_id],
        |row| {
            Ok(serde_json::json!({
                "entitlement_serial": row.get::<_, String>(0)?,
                "key_id": row.get::<_, i64>(1)?,
                "format_version": row.get::<_, i64>(2)?,
                "company_id": row.get::<_, String>(3)?,
                "branch_id": row.get::<_, String>(4)?,
                "device_id": row.get::<_, String>(5)?,
                "device_binding_hex": row.get::<_, String>(6)?,
                "issued_at": row.get::<_, String>(7)?,
                "expires_at": row.get::<_, String>(8)?,
                "grace_until": row.get::<_, String>(9)?,
                "capabilities_json": row.get::<_, String>(10)?,
                "verification_state": row.get::<_, String>(11)?,
                "source": row.get::<_, String>(12)?,
                "accepted_at": row.get::<_, Option<String>>(13)?,
                "superseded_at": row.get::<_, Option<String>>(14)?,
                "revoked_at": row.get::<_, Option<String>>(15)?,
                "revocation_reason": row.get::<_, Option<String>>(16)?,
                "bootstrap_consumed_at": row.get::<_, Option<String>>(17)?,
                "signature_len": row.get::<_, i64>(18)?,
            }))
        },
    )
    .optional()
    .map_err(to_error)
}

pub fn active_entitlement(
    app: &AppHandle,
    device_id: &str,
) -> Result<Option<serde_json::Value>, String> {
    let path = database_path(app)?;
    active_entitlement_at(&path, device_id)
}

/// Map an `EntitlementState` to its JSON pieces: PascalCase name, capability object (or null when
/// the state holds the previous set), and a reason string for `Malformed`.
fn state_json_parts(
    state: &EntitlementState,
) -> (&'static str, Option<serde_json::Value>, Option<String>) {
    let name = match state {
        EntitlementState::Unprovisioned => "Unprovisioned",
        EntitlementState::Active => "Active",
        EntitlementState::Grace => "Grace",
        EntitlementState::Expired => "Expired",
        EntitlementState::Revoked => "Revoked",
        EntitlementState::ClockAnomaly => "ClockAnomaly",
        EntitlementState::Malformed { .. } => "Malformed",
    };
    let capabilities = state.capabilities().map(|caps| {
        serde_json::json!({
            "billing": caps.billing,
            "local_reports": caps.local_reports,
            "sync": caps.sync,
            "admin": caps.admin,
            "provisioning": caps.provisioning,
        })
    });
    let reason = match state {
        EntitlementState::Malformed { reason } => Some(format!("{reason:?}")),
        _ => None,
    };
    (name, capabilities, reason)
}

/// The full entitlement state a device is in, for the UI and the authorisation layer (§6.2, §9).
///
/// `trusted_keys` is parameterised for the same testing reason as `accept_entitlement_at`.
fn entitlement_state_at(
    path: &Path,
    device_id: &str,
    trusted_keys: &[(u8, [u8; 32])],
) -> Result<serde_json::Value, String> {
    initialize_at(path)?;
    let conn = Connection::open(path).map_err(to_error)?;

    // The "current" row includes a revoked one (revocation is a state to report, not a reason to
    // fall back to an older entitlement), but never a superseded one.
    let row = conn
        .query_row(
            "SELECT entitlement_serial, verification_state, source, company_id, branch_id,
                    issued_at, expires_at, grace_until, revoked_at, bootstrap_consumed_at,
                    payload_blob, signature_blob,
                    CAST(julianday(expires_at) - julianday('2020-01-01') AS INTEGER),
                    CAST(julianday(grace_until) - julianday('2020-01-01') AS INTEGER)
               FROM local_entitlement
              WHERE device_id = ?1 AND superseded_at IS NULL
              ORDER BY issued_at DESC
              LIMIT 1",
            params![device_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, Vec<u8>>(10)?,
                    row.get::<_, Vec<u8>>(11)?,
                    row.get::<_, i64>(12)?,
                    row.get::<_, i64>(13)?,
                ))
            },
        )
        .optional()
        .map_err(to_error)?;

    let Some((
        serial,
        verification_state,
        source,
        company_id,
        branch_id,
        issued_iso,
        expires_iso,
        grace_iso,
        revoked_at,
        bootstrap_consumed_at,
        payload_blob,
        signature_blob,
        expires_day,
        grace_day,
    )) = row
    else {
        let (name, capabilities, reason) = state_json_parts(&EntitlementState::Unprovisioned);
        return Ok(serde_json::json!({
            "state": name,
            "billing_allowed": false,
            "capabilities": capabilities,
            "reason": reason,
            "verification_state": serde_json::Value::Null,
            "source": serde_json::Value::Null,
            "company_id": serde_json::Value::Null,
            "branch_id": serde_json::Value::Null,
            "entitlement_serial": serde_json::Value::Null,
            "issued_at": serde_json::Value::Null,
            "expires_at": serde_json::Value::Null,
            "grace_until": serde_json::Value::Null,
            "days_remaining": serde_json::Value::Null,
            "bootstrap": serde_json::Value::Null,
        }));
    };

    // Clock (§5.3). now is the untrusted device clock; the high-water mark is a corroborated
    // floor, and the greatest accepted `issued_at` is itself a floor on a never-synced device.
    let now_day: i64 = conn
        .query_row(
            "SELECT CAST(julianday('now') - julianday('2020-01-01') AS INTEGER)",
            [],
            |row| row.get(0),
        )
        .map_err(to_error)?;
    let issued_day: i64 = conn
        .query_row(
            "SELECT CAST(julianday(?1) - julianday('2020-01-01') AS INTEGER)",
            params![issued_iso],
            |row| row.get(0),
        )
        .map_err(to_error)?;
    let high_water_kv = single_optional_string(
        &conn,
        "SELECT value FROM local_kv WHERE key = 'entitlement_clock_high_water'",
        &[],
    )?;
    let high_water_kv_day: Option<i64> = match &high_water_kv {
        Some(value) => conn
            .query_row(
                "SELECT CAST(julianday(?1) - julianday('2020-01-01') AS INTEGER)",
                params![value],
                |row| row.get::<_, Option<i64>>(0),
            )
            .map_err(to_error)?,
        None => None,
    };
    let high_water_day = high_water_kv_day
        .map(|day| day.max(issued_day))
        .unwrap_or(issued_day);
    let effective_now = now_day.max(high_water_day);

    // Bootstrap fields come only from a VERIFIED row whose signed payload carries a credential.
    let parsed_payload = if verification_state == "VERIFIED" {
        entitlement::parse_payload(&payload_blob).ok()
    } else {
        None
    };

    let state = if revoked_at.is_some() {
        EntitlementState::Revoked
    } else if verification_state == "VERIFIED" {
        match entitlement::verify(&payload_blob, &signature_blob, trusted_keys) {
            Ok(verified) => entitlement::evaluate_state(&verified, now_day, high_water_day),
            Err(reason) => EntitlementState::Malformed { reason },
        }
    } else {
        // LEGACY_GRANDFATHER (empty blobs): same rule as evaluate_state, on the stored day-numbers.
        if now_day < high_water_day - entitlement::CLOCK_BEHIND_ANOMALY_DAYS
            || now_day > high_water_day + entitlement::CLOCK_AHEAD_ANOMALY_DAYS
        {
            EntitlementState::ClockAnomaly
        } else if effective_now < expires_day {
            EntitlementState::Active
        } else if effective_now < grace_day {
            EntitlementState::Grace
        } else {
            EntitlementState::Expired
        }
    };

    let bootstrap = match parsed_payload.as_ref() {
        Some(payload) if payload.carries_credential() => match payload.bootstrap.as_ref() {
            Some(credential) => {
                let window_open = payload
                    .bootstrap_expires_at_day()
                    .map(|expiry| now_day <= expiry)
                    .unwrap_or(false);
                let consumed = bootstrap_consumed_at.is_some();
                serde_json::json!({
                    "pending": !consumed && window_open,
                    "owner_username": credential.owner_username,
                    "owner_salt_hex": hex_lower(&credential.owner_salt),
                    "owner_verifier_hex": hex_lower(&credential.owner_verifier),
                    "window_open": window_open,
                    "consumed": consumed,
                })
            }
            None => serde_json::Value::Null,
        },
        _ => serde_json::Value::Null,
    };

    let (name, capabilities, reason) = state_json_parts(&state);
    Ok(serde_json::json!({
        "state": name,
        "billing_allowed": state.billing_allowed(),
        "capabilities": capabilities,
        "reason": reason,
        "verification_state": verification_state,
        "source": source,
        "company_id": company_id,
        "branch_id": branch_id,
        "entitlement_serial": serial,
        "issued_at": issued_iso,
        "expires_at": expires_iso,
        "grace_until": grace_iso,
        "days_remaining": expires_day - effective_now,
        "bootstrap": bootstrap,
    }))
}

pub fn entitlement_state(app: &AppHandle, device_id: &str) -> Result<serde_json::Value, String> {
    let path = database_path(app)?;
    entitlement_state_at(&path, device_id, entitlement::TRUSTED_ACTIVATION_KEYS)
}

/// Mark a bootstrap credential consumed (§8.2). Set-once: never overwrites an existing timestamp,
/// because clearing or re-stamping it would re-open a credential the design describes as single-use.
fn consume_bootstrap_at(path: &Path, device_id: &str, serial: &str) -> Result<(), String> {
    initialize_at(path)?;
    let conn = Connection::open(path).map_err(to_error)?;
    let updated = conn
        .execute(
            "UPDATE local_entitlement
                SET bootstrap_consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              WHERE entitlement_serial = ?1 AND device_id = ?2 AND bootstrap_consumed_at IS NULL",
            params![serial, device_id],
        )
        .map_err(to_error)?;
    if updated > 0 {
        record_entitlement_audit_at(
            &conn,
            Some(serial),
            "BOOTSTRAP_CREDENTIAL_CONSUMED",
            None,
            "{}",
            device_id,
        )?;
    }
    Ok(())
}

pub fn consume_bootstrap(app: &AppHandle, device_id: &str, serial: &str) -> Result<(), String> {
    let path = database_path(app)?;
    consume_bootstrap_at(&path, device_id, serial)
}

fn ensure_device_identity_with_preference_at(
    path: &Path,
    preferred_device_id: Option<&str>,
) -> Result<serde_json::Value, String> {
    let conn = Connection::open(path).map_err(to_error)?;
    let preferred_device_id = preferred_device_id
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("default"));
    let mut statement = conn
        .prepare(
            "SELECT device_id, device_name, platform, app_version, branch_id, registration_status, last_seen_at, last_sync_at
             FROM local_device_identity
             WHERE LOWER(device_id) <> 'default'
             ORDER BY device_id",
        )
        .map_err(to_error)?;
    let identities = statement
        .query_map([], device_identity_from_row)
        .map_err(to_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_error)?;
    let approved = identities
        .iter()
        .filter(|identity| {
            optional_text(identity, "registration_status")
                .map(|status| status.eq_ignore_ascii_case("approved"))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    if approved.len() > 1 {
        return Err("DEVICE_IDENTITY_CONFLICT: Multiple approved local device identities exist. Restore the canonical device backup or reconcile the identities before continuing.".to_string());
    }
    if let Some(identity) = approved.first() {
        // §11.1 grandfathering. Deliberately non-fatal: a device that cannot be grandfathered
        // must still return its identity and keep working. Failing here would brick exactly the
        // population this shim exists to protect, which is the opposite of §2.5's "fail into the
        // running state, not out of it".
        if let Err(error) = grandfather_existing_device(&conn, identity) {
            eprintln!("entitlement grandfathering skipped: {error}");
        }
        return Ok((*identity).clone());
    }
    if identities.len() > 1 {
        return Err("DEVICE_IDENTITY_CONFLICT: Multiple provisional local device identities exist and no approved canonical identity is available.".to_string());
    }
    if let Some(identity) = identities.first() {
        return Ok(identity.clone());
    }

    let hostname = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Windows Device".to_string());
    let device_id = preferred_device_id
        .map(ToOwned::to_owned)
        .map(Ok)
        .unwrap_or_else(generate_opaque_device_id)?;
    let device_name = format!("{} - FroozERP", hostname);
    let app_version = env!("CARGO_PKG_VERSION");
    conn.execute(
        "INSERT INTO local_device_identity (
            device_id, device_name, platform, app_version, branch_id, registration_status, last_seen_at, updated_at
         ) VALUES (?1, ?2, 'tauri-windows', ?3, 'unassigned', 'pending', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        params![device_id, device_name, app_version],
    )
    .map_err(to_error)?;

    Ok(serde_json::json!({
        "device_id": device_id,
        "device_name": device_name,
        "platform": "tauri-windows",
        "app_version": app_version,
        "branch_id": "unassigned",
        "registration_status": "pending",
        "last_seen_at": null,
        "last_sync_at": null,
    }))
}

fn required_text(value: &serde_json::Value, key: &str) -> Result<String, String> {
    optional_text(value, key).ok_or_else(|| format!("{key} is required"))
}

fn optional_text(value: &serde_json::Value, key: &str) -> Option<String> {
    match value.get(key) {
        Some(serde_json::Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Some(serde_json::Value::Number(number)) => Some(number.to_string()),
        _ => None,
    }
}

fn required_number(value: &serde_json::Value, key: &str) -> Result<f64, String> {
    value
        .get(key)
        .and_then(json_number)
        .filter(|number| number.is_finite())
        .ok_or_else(|| format!("{key} must be a valid number"))
}

fn number_or_zero(value: &serde_json::Value, key: &str) -> f64 {
    value.get(key).and_then(json_number).unwrap_or(0.0)
}

fn json_number(value: &serde_json::Value) -> Option<f64> {
    match value {
        serde_json::Value::Number(number) => number.as_f64(),
        serde_json::Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn pending_outbox_at(conn: &Connection, limit: i64) -> Result<Vec<PendingSyncOperation>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, COALESCE(operation_id, id), entity_type, entity_id, operation_type,
                    branch_id, device_id, user_id, COALESCE(entity_version, version, 1),
                    COALESCE(payload_json, payload), created_at, retry_count,
                    COALESCE(status, 'pending'), last_error
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
                status: row.get(12)?,
                last_error: row.get(13)?,
            })
        })
        .map_err(to_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(to_error)
}

fn apply_purchase_ack_with_tx(
    tx: &rusqlite::Transaction,
    ack: &SyncAck,
    state: &str,
    server_ack: &str,
    confirmed_at: &str,
) -> Result<(), String> {
    let exists: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM local_purchase_intents WHERE operation_id = ?1",
            [&ack.operation_id],
            |row| row.get(0),
        )
        .map_err(to_error)?;
    if exists == 0 {
        return Ok(());
    }
    let message = ack.message.clone().unwrap_or_else(|| {
        if state == "completed" { "Server acknowledged purchase".to_string() } else { "Purchase replay requires attention".to_string() }
    });
    let server_purchase_ids = ack
        .result_payload
        .as_ref()
        .and_then(|payload| payload.get("purchase_ids"))
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    tx.execute(
        "UPDATE local_purchase_intents
         SET state = ?2,
             server_purchase_ids_json = CASE WHEN ?2 = 'completed' THEN ?3 ELSE server_purchase_ids_json END,
             server_ack_json = ?4,
             last_error = CASE WHEN ?2 = 'completed' THEN NULL ELSE ?5 END,
             retry_count = retry_count + CASE WHEN ?2 IN ('failed', 'conflict') THEN 1 ELSE 0 END,
             updated_at = ?6,
             completed_at = CASE WHEN ?2 = 'completed' THEN ?6 ELSE completed_at END
         WHERE operation_id = ?1",
        params![
            ack.operation_id,
            state,
            serde_json::to_string(&server_purchase_ids).map_err(to_error)?,
            server_ack,
            message,
            confirmed_at,
        ],
    )
    .map_err(to_error)?;
    tx.execute(
        "UPDATE local_purchase_intent_lines
         SET sync_status = ?2, updated_at = ?3
         WHERE intent_id = (SELECT id FROM local_purchase_intents WHERE operation_id = ?1)",
        params![ack.operation_id, state, confirmed_at],
    )
    .map_err(to_error)?;
    if state == "completed" {
        tx.execute(
            "UPDATE local_inventory_lots
             SET sync_status = 'synced', updated_at = ?2
             WHERE id IN (
               SELECT provisional_lot_id FROM local_purchase_intent_lines
               WHERE intent_id = (SELECT id FROM local_purchase_intents WHERE operation_id = ?1)
             )",
            params![ack.operation_id, confirmed_at],
        )
        .map_err(to_error)?;
        if let Some(payload) = ack.result_payload.as_ref() {
            let canonical_purchase_id = payload
                .get("purchase")
                .and_then(|purchase| optional_text(purchase, "id"))
                .or_else(|| {
                    payload
                        .get("purchase_ids")
                        .and_then(|value| value.as_array())
                        .and_then(|ids| ids.first())
                        .and_then(|value| match value {
                            serde_json::Value::String(text) => Some(text.clone()),
                            serde_json::Value::Number(number) => Some(number.to_string()),
                            _ => None,
                        })
                });
            if let Some(server_id) = canonical_purchase_id {
                tx.execute(
                    "UPDATE local_purchase_intent_lines
                     SET server_purchase_id = ?2, updated_at = ?3
                     WHERE intent_id = (
                       SELECT id FROM local_purchase_intents WHERE operation_id = ?1
                     )",
                    params![ack.operation_id, server_id, confirmed_at],
                )
                .map_err(to_error)?;
            }
            for item in payload.get("items").and_then(|value| value.as_array()).into_iter().flatten() {
                if let (Some(line_global_id), Some(server_item_id)) = (
                    optional_text(item, "line_global_id"),
                    optional_text(item, "id"),
                ) {
                    tx.execute(
                        "UPDATE local_purchase_intent_lines
                         SET server_purchase_item_id = ?2, updated_at = ?3
                         WHERE provisional_line_id = ?1 OR provisional_purchase_id = ?1",
                        params![line_global_id, server_item_id, confirmed_at],
                    )
                    .map_err(to_error)?;
                }
            }
            for lot in payload.get("lots").and_then(|value| value.as_array()).into_iter().flatten() {
                if let (Some(global_id), Some(server_id)) = (
                    optional_text(lot, "global_id"),
                    optional_text(lot, "id"),
                ) {
                    tx.execute(
                        "UPDATE local_purchase_intent_lines
                         SET server_lot_id = ?2, updated_at = ?3
                         WHERE provisional_lot_id = ?1",
                        params![global_id, server_id, confirmed_at],
                    )
                    .map_err(to_error)?;
                }
            }
        }
    }
    Ok(())
}

fn record_conflict_with_tx(tx: &rusqlite::Transaction, ack: &SyncAck) -> Result<(), String> {
    tx.execute(
        "INSERT INTO sync_conflicts (
            id, entity_type, entity_id, local_payload, server_payload,
            local_version, server_version, reason, status, resolution_status, detected_at
         )
         SELECT
            ?1, entity_type, entity_id, COALESCE(payload_json, payload), ?2,
            entity_version, ?3, ?4, 'open', 'OPEN', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
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

#[cfg(windows)]
fn generate_opaque_device_id() -> Result<String, String> {
    use windows_sys::core::GUID;
    use windows_sys::Win32::System::Com::CoCreateGuid;

    let mut guid = GUID::from_u128(0);
    let result = unsafe { CoCreateGuid(&mut guid) };
    if result < 0 {
        return Err(format!("Windows could not generate a device identity (HRESULT {result})."));
    }
    Ok(format!(
        "FZDEV-{:08X}-{:04X}-{:04X}-{:02X}{:02X}-{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}",
        guid.data1,
        guid.data2,
        guid.data3,
        guid.data4[0],
        guid.data4[1],
        guid.data4[2],
        guid.data4[3],
        guid.data4[4],
        guid.data4[5],
        guid.data4[6],
        guid.data4[7],
    ))
}

#[cfg(not(windows))]
fn generate_opaque_device_id() -> Result<String, String> {
    Ok(format!("FZDEV-{}", unique_local_id("installation")))
}

fn apply_pulled_pos_sale_with_tx(
    tx: &rusqlite::Transaction,
    change: &PulledChange,
) -> Result<(), String> {
    let payload = &change.payload;
    let existing_version: Option<i64> = tx
        .query_row(
            "SELECT entity_version FROM local_pos_invoices WHERE id = ?1",
            [change.entity_id.as_str()],
            |row| row.get(0),
        )
        .optional()
        .map_err(to_error)?;
    let incoming_version = change.version.unwrap_or(1);
    let cancelled = change.operation_type.eq_ignore_ascii_case("SALE_CANCEL")
        || payload.get("cancelled").and_then(|value| value.as_bool()) == Some(true)
        || optional_text(payload, "status")
            .map(|status| status.eq_ignore_ascii_case("CANCELLED"))
            .unwrap_or(false);
    let status = if cancelled {
        "CANCELLED".to_string()
    } else {
        optional_text(payload, "status").unwrap_or_else(|| "COMPLETED".to_string())
    };
    let server_sale_id = optional_text(payload, "id");
    let server_invoice_no = optional_text(payload, "invoice_no");

    if let Some(local_version) = existing_version {
        if incoming_version >= local_version {
            tx.execute(
                "UPDATE local_pos_invoices
                 SET status = ?2,
                     sync_status = 'synced',
                     server_invoice_no = COALESCE(?3, server_invoice_no),
                     server_sale_id = COALESCE(?4, server_sale_id),
                     entity_version = ?5,
                     updated_at = COALESCE(?6, updated_at),
                     synced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 WHERE id = ?1",
                params![
                    change.entity_id,
                    status,
                    server_invoice_no,
                    server_sale_id,
                    incoming_version,
                    change.updated_at,
                ],
            )
            .map_err(to_error)?;
        }
        return Ok(());
    }

    let offline_invoice_ref = optional_text(payload, "offline_invoice_ref")
        .unwrap_or_else(|| format!("CLOUD-{}", change.entity_id));
    let branch_id = optional_text(payload, "branch_id").unwrap_or_else(|| "1".to_string());
    let device_id = optional_text(payload, "source_device_id")
        .or_else(|| optional_text(payload, "device_id"))
        .unwrap_or_else(|| "cloud".to_string());
    let bill_date = optional_text(payload, "bill_date")
        .or_else(|| optional_text(payload, "transaction_date"))
        .or_else(|| optional_text(payload, "sale_date"))
        .unwrap_or_else(|| "1970-01-01".to_string());
    let bill_datetime = optional_text(payload, "bill_datetime")
        .unwrap_or_else(|| format!("{}T00:00", bill_date));
    let payment_mode = optional_text(payload, "payment_mode").unwrap_or_else(|| "UNKNOWN".to_string());
    let gross_total = payload
        .get("gross_total")
        .or_else(|| payload.get("gross_amount"))
        .and_then(json_number)
        .unwrap_or(0.0);
    let item_discount_total = payload
        .get("item_discount_total")
        .or_else(|| payload.get("item_discount_amount"))
        .and_then(json_number)
        .unwrap_or(0.0);
    let bill_discount_total = payload
        .get("bill_discount_total")
        .or_else(|| payload.get("invoice_discount_amount"))
        .and_then(json_number)
        .unwrap_or(0.0);
    let tax_total = payload
        .get("tax_total")
        .or_else(|| payload.get("tax_amount"))
        .and_then(json_number)
        .unwrap_or(0.0);
    let net_total = payload
        .get("net_total")
        .or_else(|| payload.get("total_amount"))
        .and_then(json_number)
        .unwrap_or(0.0);

    tx.execute(
        "INSERT INTO local_pos_invoices (
            id, offline_invoice_ref, branch_id, device_id, user_id, customer_id,
            customer_name, customer_mobile, bill_date, bill_datetime, payment_mode,
            gross_total, item_discount_total, bill_discount_total, tax_total, net_total,
            status, sync_status, server_invoice_no, server_sale_id, entity_version,
            created_at, updated_at, synced_at
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
            ?12, ?13, ?14, ?15, ?16, ?17, 'synced', ?18, ?19, ?20,
            COALESCE(?21, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), COALESCE(?22, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         )",
        params![
            change.entity_id,
            offline_invoice_ref,
            branch_id,
            device_id,
            optional_text(payload, "created_by").or_else(|| optional_text(payload, "user_id")),
            optional_text(payload, "customer_id"),
            optional_text(payload, "customer_name"),
            optional_text(payload, "customer_mobile"),
            bill_date,
            bill_datetime,
            payment_mode,
            gross_total,
            item_discount_total,
            bill_discount_total,
            tax_total,
            net_total,
            status,
            server_invoice_no,
            server_sale_id,
            incoming_version,
            optional_text(payload, "created_at"),
            change.updated_at,
        ],
    )
    .map_err(to_error)?;

    if let Some(items) = payload.get("items").and_then(|value| value.as_array()) {
        for (index, item) in items.iter().enumerate() {
            let product_id = optional_text(item, "product_id").unwrap_or_else(|| "unknown".to_string());
            let lot_id = optional_text(item, "lot_id")
                .or_else(|| optional_text(item, "inventory_batch_id"))
                .unwrap_or_else(|| format!("unknown-lot-{}", index));
            let item_id = optional_text(item, "item_global_id")
                .or_else(|| optional_text(item, "id"))
                .unwrap_or_else(|| format!("{}-item-{}", change.entity_id, index + 1));
            let quantity = item.get("quantity").and_then(json_number).unwrap_or(0.0).max(0.0);
            let rate = item
                .get("rate")
                .or_else(|| item.get("selling_rate"))
                .and_then(json_number)
                .unwrap_or(0.0)
                .max(0.0);
            let discount = item
                .get("discount")
                .or_else(|| item.get("discount_amount"))
                .and_then(json_number)
                .unwrap_or(0.0)
                .max(0.0);
            let amount = item
                .get("amount")
                .or_else(|| item.get("net_amount"))
                .and_then(json_number)
                .unwrap_or((quantity * rate - discount).max(0.0));
            if quantity <= 0.0 {
                continue;
            }
            tx.execute(
                "INSERT INTO local_pos_invoice_items (
                    id, invoice_id, product_id, product_name, lot_id, lot_name, lot_size,
                    quantity, unit, rate, discount, amount, stock_movement_id, entity_version
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                 ON CONFLICT(id) DO NOTHING",
                params![
                    item_id,
                    change.entity_id,
                    product_id,
                    optional_text(item, "product_name"),
                    lot_id,
                    optional_text(item, "lot_name"),
                    optional_text(item, "lot_size"),
                    quantity,
                    optional_text(item, "unit"),
                    rate,
                    discount,
                    amount,
                    optional_text(item, "stock_movement_id")
                        .unwrap_or_else(|| format!("remote-stock-{}-{}", change.entity_id, index + 1)),
                    incoming_version,
                ],
            )
            .map_err(to_error)?;
        }
    }
    Ok(())
}

fn apply_change_with_tx(tx: &rusqlite::Transaction, change: &PulledChange) -> Result<(), String> {
    let _change_id = &change.change_id;
    let operation = change.operation_type.to_uppercase();
    match change.entity_type.as_str() {
        "product_category" => {
            if operation == "DELETE" {
                tx.execute(
                    "UPDATE local_categories SET deleted_at = COALESCE(?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), sync_status = 'synced' WHERE id = ?1",
                    params![change.entity_id, change.updated_at],
                )
                .map_err(to_error)?;
            } else {
                tx.execute(
                    "INSERT INTO local_categories (id, cloud_id, branch_id, name, active, updated_at, version, sync_status, deleted_at)
                     VALUES (?1, ?1, ?2, ?3, ?4, COALESCE(?5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ?6, 'synced', NULL)
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
            let category_id = if change.payload.get("category_global_id").is_some() {
                change
                    .payload
                    .get("category_global_id")
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string())
            } else {
                change.payload.get("category_id").and_then(|value| {
                    if let Some(raw) = value.as_str() {
                        Some(if raw.starts_with("category-") {
                            raw.to_string()
                        } else {
                            format!("category-{raw}")
                        })
                    } else {
                        value.as_i64().map(|id| format!("category-{id}"))
                    }
                })
            };
            tx.execute(
                "INSERT INTO local_products (
                    id, cloud_id, branch_id, product_name, category_id, category_name, unit,
                    barcode, sale_rate, minimum_stock, active, remarks, updated_at, version, sync_status, deleted_at
                 ) VALUES (?1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, COALESCE(?12, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ?13, 'synced', NULL)
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
                    category_id,
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
            tx.execute(
                "UPDATE local_products SET company_id = ?2 WHERE id = ?1",
                params![
                    change.entity_id,
                    optional_text(&change.payload, "company_id"),
                ],
            )
            .map_err(to_error)?;
        }
        "supplier" => {
            upsert_supplier_reference_with_tx(
                tx,
                &change.entity_id,
                &change.payload,
                change.updated_at.clone(),
                change.version.unwrap_or(1),
                operation == "DELETE",
            )?;
        }
        "location_product" => {
            let location_id = change
                .payload
                .get("operational_location_id")
                .and_then(json_number)
                .map(|value| (value as i64).to_string())
                .ok_or_else(|| "Location product change has no operational location".to_string())?;
            let product_id = change
                .payload
                .get("product_global_id")
                .and_then(|value| value.as_str())
                .ok_or_else(|| "Location product change has no product identity".to_string())?;
            if operation == "DELETE" {
                tx.execute(
                    "DELETE FROM local_operational_location_products
                     WHERE operational_location_id = ?1 AND product_id = ?2",
                    params![location_id, product_id],
                )
                .map_err(to_error)?;
            } else {
                tx.execute(
                    "INSERT INTO local_operational_location_products (
                       operational_location_id, product_id, enabled, pos_available,
                       selling_rate, reorder_level, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                     ON CONFLICT(operational_location_id, product_id) DO UPDATE SET
                       enabled = excluded.enabled,
                       pos_available = excluded.pos_available,
                       selling_rate = excluded.selling_rate,
                       reorder_level = excluded.reorder_level,
                       updated_at = excluded.updated_at",
                    params![
                        location_id,
                        product_id,
                        if change.payload.get("enabled").and_then(|value| value.as_bool()).unwrap_or(true) { 1 } else { 0 },
                        if change.payload.get("pos_available").and_then(|value| value.as_bool()).unwrap_or(true) { 1 } else { 0 },
                        change.payload.get("selling_rate").and_then(json_number),
                        change.payload.get("reorder_level").and_then(json_number).unwrap_or(0.0),
                        change.updated_at,
                    ],
                )
                .map_err(to_error)?;
            }
        }
        "inventory_lot" => {
            if operation == "DELETE" {
                tx.execute(
                    "UPDATE local_inventory_lots SET deleted_at = COALESCE(?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), sync_status = 'synced' WHERE id = ?1",
                    params![change.entity_id, change.updated_at],
                )
                .map_err(to_error)?;
            } else {
                let product_id = optional_text(&change.payload, "product_global_id")
                    .or_else(|| optional_text(&change.payload, "product_id"))
                    .unwrap_or_default();
                if product_id.is_empty() {
                    return Err(format!("Inventory lot {} has no canonical product identity", change.entity_id));
                }
                let purchase_qty = change.payload.get("purchase_qty").and_then(json_number).unwrap_or(0.0);
                let balance_qty = change.payload.get("remaining_qty").or_else(|| change.payload.get("balance_qty")).and_then(json_number).unwrap_or(0.0);
                let sold_qty = (purchase_qty - balance_qty).max(0.0);
                tx.execute(
                    "INSERT INTO local_inventory_lots (
                        id, cloud_id, branch_id, product_id, product_name, supplier_id, supplier_name,
                        lot_no, size_grade, opening_date, opening_qty, purchased_qty, sold_qty, returned_qty,
                        waste_qty, adjusted_qty, transfer_in_qty, transfer_out_qty, balance_qty, cost_rate,
                        sale_rate, status, remarks, created_at, updated_at, version, sync_status, deleted_at
                     ) VALUES (
                        ?1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11, ?12, ?13, ?14, ?15,
                        ?16, ?17, ?18, ?19, ?20, ?21, COALESCE(?22, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                        COALESCE(?23, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ?24, 'synced', NULL
                     ) ON CONFLICT(id) DO UPDATE SET
                        branch_id = excluded.branch_id,
                        product_id = excluded.product_id,
                        product_name = excluded.product_name,
                        supplier_id = excluded.supplier_id,
                        supplier_name = excluded.supplier_name,
                        lot_no = excluded.lot_no,
                        size_grade = excluded.size_grade,
                        opening_date = excluded.opening_date,
                        opening_qty = excluded.opening_qty,
                        purchased_qty = excluded.purchased_qty,
                        sold_qty = excluded.sold_qty,
                        returned_qty = excluded.returned_qty,
                        waste_qty = excluded.waste_qty,
                        adjusted_qty = excluded.adjusted_qty,
                        transfer_in_qty = excluded.transfer_in_qty,
                        transfer_out_qty = excluded.transfer_out_qty,
                        balance_qty = excluded.balance_qty,
                        cost_rate = excluded.cost_rate,
                        sale_rate = excluded.sale_rate,
                        status = excluded.status,
                        remarks = excluded.remarks,
                        updated_at = excluded.updated_at,
                        version = excluded.version,
                        sync_status = 'synced',
                        deleted_at = NULL",
                    params![
                        change.entity_id,
                        optional_text(&change.payload, "branch_id")
                            .or_else(|| change.branch_id.map(|value| value.to_string()))
                            .unwrap_or_else(|| "unassigned".to_string()),
                        product_id,
                        optional_text(&change.payload, "product_name"),
                        optional_text(&change.payload, "supplier_id"),
                        optional_text(&change.payload, "supplier_name"),
                        optional_text(&change.payload, "lot_no").or_else(|| optional_text(&change.payload, "batch_no")).or_else(|| optional_text(&change.payload, "lot_name")),
                        optional_text(&change.payload, "size_grade").or_else(|| optional_text(&change.payload, "lot_size")),
                        optional_text(&change.payload, "opening_date").or_else(|| optional_text(&change.payload, "purchase_date")),
                        purchase_qty,
                        sold_qty,
                        change.payload.get("returned_qty").and_then(json_number).unwrap_or(0.0),
                        change.payload.get("waste_qty").and_then(json_number).unwrap_or(0.0),
                        change.payload.get("adjusted_qty").and_then(json_number).unwrap_or(0.0),
                        change.payload.get("transfer_in_qty").and_then(json_number).unwrap_or(0.0),
                        change.payload.get("transfer_out_qty").and_then(json_number).unwrap_or(0.0),
                        balance_qty,
                        change.payload.get("effective_cost_per_unit").or_else(|| change.payload.get("purchase_rate")).and_then(json_number).unwrap_or(0.0),
                        change.payload.get("temporary_sale_rate").or_else(|| change.payload.get("sale_rate")).and_then(json_number),
                        optional_text(&change.payload, "batch_status").or_else(|| optional_text(&change.payload, "status")).unwrap_or_else(|| "ACTIVE".to_string()),
                        optional_text(&change.payload, "remarks"),
                        optional_text(&change.payload, "created_at"),
                        change.updated_at.clone(),
                        change.version.unwrap_or(1),
                    ],
                )
                .map_err(to_error)?;
                tx.execute(
                    "UPDATE local_inventory_lots
                     SET company_id = ?2, operational_location_id = ?3
                     WHERE id = ?1",
                    params![
                        change.entity_id,
                        optional_text(&change.payload, "company_id"),
                        optional_text(&change.payload, "operational_location_id"),
                    ],
                )
                .map_err(to_error)?;
            }
        }
        "pos_sale" => apply_pulled_pos_sale_with_tx(tx, change)?,
        "sync_test" => {
            tx.execute(
                "INSERT INTO local_sync_test_entities (id, branch_id, device_id, value, server_version, sync_status, updated_at, deleted_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'synced', COALESCE(?6, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), NULL)
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

fn device_identity_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<serde_json::Value> {
    Ok(serde_json::json!({
        "device_id": row.get::<_, String>(0)?,
        "device_name": row.get::<_, String>(1)?,
        "platform": row.get::<_, String>(2)?,
        "app_version": row.get::<_, String>(3)?,
        "branch_id": row.get::<_, String>(4)?,
        "registration_status": row.get::<_, String>(5)?,
        "last_seen_at": row.get::<_, Option<String>>(6)?,
        "last_sync_at": row.get::<_, Option<String>>(7)?,
    }))
}

fn upsert_supplier_reference_with_tx(
    tx: &rusqlite::Transaction,
    entity_id: &str,
    payload: &serde_json::Value,
    updated_at: Option<String>,
    version: i64,
    deleted: bool,
) -> Result<(), String> {
    let company_id = optional_text(payload, "company_id")
        .ok_or_else(|| format!("Supplier reference {entity_id} has no company scope"))?;
    let supplier_name = optional_text(payload, "supplier_name")
        .ok_or_else(|| format!("Supplier reference {entity_id} has no name"))?;
    let confirmed_updated_at = updated_at
        .or_else(|| optional_text(payload, "updated_at"))
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string());
    let deleted_at = if deleted {
        optional_text(payload, "deleted_at").or_else(|| Some(confirmed_updated_at.clone()))
    } else {
        None
    };
    tx.execute(
        "INSERT INTO local_supplier_references (
           id, cloud_id, company_id, supplier_name, firm_name, supplier_type, active,
           created_at, updated_at, version, sync_status, deleted_at
         ) VALUES (
           ?1, ?1, ?2, ?3, ?4, ?5, ?6, ?7,
           COALESCE(?8, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ?9, 'synced', ?10
         )
         ON CONFLICT(id) DO UPDATE SET
           company_id = excluded.company_id,
           supplier_name = excluded.supplier_name,
           firm_name = excluded.firm_name,
           supplier_type = excluded.supplier_type,
           active = excluded.active,
           created_at = COALESCE(local_supplier_references.created_at, excluded.created_at),
           updated_at = excluded.updated_at,
           version = excluded.version,
           sync_status = 'synced',
           deleted_at = excluded.deleted_at",
        params![
            entity_id,
            company_id,
            supplier_name,
            optional_text(payload, "firm_name"),
            optional_text(payload, "supplier_type").unwrap_or_else(|| "LOCAL_SUPPLIER".to_string()),
            if deleted || !payload.get("active").and_then(|value| value.as_bool()).unwrap_or(true) { 0 } else { 1 },
            optional_text(payload, "created_at"),
            confirmed_updated_at,
            version.max(1),
            deleted_at,
        ],
    )
    .map_err(to_error)?;
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

fn require_server_time(server_time: Option<String>) -> Result<String, String> {
    let value = server_time.unwrap_or_default();
    if value.len() < 24 || !value.ends_with('Z') || !value.contains('T') {
        return Err("Cloud sync response did not include canonical server UTC time".to_string());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_preflight_rejects_malformed_database_without_replacing_it() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-malformed-snapshot-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ));
        let original = b"not a sqlite database".to_vec();
        fs::write(&path, &original).expect("write malformed disposable database");

        let error = load_reference_snapshot_path(&path, Some("offline-user"), Some("device-test"))
            .expect_err("malformed snapshot must fail");
        assert!(error.contains("database corruption"));
        assert_eq!(fs::read(&path).expect("read preserved malformed database"), original);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn snapshot_preflight_rejects_incompatible_schema_without_migrating_it() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-incompatible-snapshot-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ));
        initialize_at(&path).expect("initialize disposable database");
        {
            let conn = Connection::open(&path).expect("open disposable database");
            conn.execute_batch("DROP TABLE local_supplier_references")
                .expect("remove required table from disposable database");
        }
        let before = fs::read(&path).expect("read incompatible database before load");

        let error = load_reference_snapshot_path(&path, Some("offline-user"), Some("device-test"))
            .expect_err("incompatible snapshot must fail");
        assert!(error.contains("incompatible schema"));
        assert!(error.contains("local_supplier_references"));
        assert_eq!(fs::read(&path).expect("read incompatible database after load"), before);
        let _ = fs::remove_file(&path);
    }

    fn test_sale_payload(invoice_id: &str, operation_id: &str, quantity: f64, amount: f64) -> serde_json::Value {
        serde_json::json!({
            "operation_id": operation_id,
            "invoice_global_id": invoice_id,
            "offline_invoice_ref": "OFF-TEST-1",
            "branch_id": "1",
            "device_id": "device-test",
            "user_id": "1",
            "customer": { "name": "Walk-in Customer", "mobile": "" },
            "bill_date": "2026-06-16",
            "bill_datetime": "2026-06-16T10:00",
            "payment_mode": "CASH",
            "gross_total": amount,
            "item_discount_total": 0.0,
            "bill_discount_total": 0.0,
            "tax_total": 0.0,
            "net_total": amount,
            "entity_version": 1,
            "items": [{
                "item_global_id": "line-test-sale-1",
                "product_id": "product-test",
                "product_name": "Test Product",
                "lot_id": "lot-test",
                "lot_name": "Test Lot",
                "lot_size": "Small",
                "quantity": quantity,
                "unit": "KG",
                "rate": 10.0,
                "discount": 0.0,
                "amount": amount,
                "stock_movement_id": "stock-test-sale-1",
                "available_qty": 5.0
            }],
            "payments": [{
                "posting_id": "posting-test-sale-1",
                "mode": "CASH",
                "amount": amount
            }]
        })
    }

    fn test_reference_bootstrap(device_id: &str, location_id: i64) -> ReferenceBootstrap {
        ReferenceBootstrap {
            protocol: "reference-v1".to_string(),
            high_watermark: "44".to_string(),
            device_id: device_id.to_string(),
            company_id: 1,
            branch_id: 1,
            operational_location_id: location_id,
            assignment_generation: 3,
            operational_location: serde_json::json!({
                "id": location_id,
                "company_id": 1,
                "branch_id": 1,
                "location_code": "BADWASIYA",
                "location_name": "Badwasiya Fruit Market",
                "location_type": "STORE",
                "timezone": "Asia/Kolkata",
                "active": true,
                "is_default": true,
                "updated_at": "2026-07-27T10:00:00.000Z"
            }),
            device_assignment: serde_json::json!({
                "device_id": device_id,
                "company_id": 1,
                "branch_id": 1,
                "operational_location_id": location_id,
                "intended_usage": "POS",
                "fixed_operational": true,
                "permission_set": { "pos": true },
                "assignment_generation": 3,
                "active": true
            }),
            location_products: vec![serde_json::json!({
                "operational_location_id": location_id,
                "product_id": "product-276",
                "enabled": true,
                "pos_available": true,
                "selling_rate": 120.0,
                "reorder_level": 5.0,
                "updated_at": "2026-07-27T10:00:00.000Z"
            })],
            records: vec![
                PulledChange {
                    change_id: serde_json::Value::Null,
                    branch_id: Some(1),
                    entity_type: "product_category".to_string(),
                    entity_id: "category-mango".to_string(),
                    operation_type: "UPSERT".to_string(),
                    version: Some(1),
                    payload: serde_json::json!({
                        "company_id": 1,
                        "branch_id": 1,
                        "category_name": "Mango",
                        "active": true
                    }),
                    updated_at: Some("2026-07-27T10:00:00.000Z".to_string()),
                },
                PulledChange {
                    change_id: serde_json::Value::Null,
                    branch_id: Some(1),
                    entity_type: "supplier".to_string(),
                    entity_id: "1".to_string(),
                    operation_type: "UPSERT".to_string(),
                    version: Some(1),
                    payload: serde_json::json!({
                        "id": 1,
                        "company_id": 1,
                        "supplier_name": "Bootstrap Supplier",
                        "firm_name": "Bootstrap Firm",
                        "supplier_type": "LOCAL_SUPPLIER",
                        "active": true,
                        "created_at": "2026-07-27T09:00:00.000Z",
                        "updated_at": "2026-07-27T10:00:00.000Z"
                    }),
                    updated_at: Some("2026-07-27T10:00:00.000Z".to_string()),
                },
                PulledChange {
                    change_id: serde_json::Value::Null,
                    branch_id: Some(1),
                    entity_type: "product".to_string(),
                    entity_id: "product-276".to_string(),
                    operation_type: "UPSERT".to_string(),
                    version: Some(2),
                    payload: serde_json::json!({
                        "company_id": 1,
                        "branch_id": 1,
                        "product_name": "Langda",
                        "category_global_id": "category-mango",
                        "category_name": "Mango",
                        "unit": "KG",
                        "selling_rate": 120.0,
                        "minimum_stock": 5.0,
                        "active": true
                    }),
                    updated_at: Some("2026-07-27T10:00:00.000Z".to_string()),
                },
                PulledChange {
                    change_id: serde_json::Value::Null,
                    branch_id: Some(1),
                    entity_type: "inventory_lot".to_string(),
                    entity_id: "lot-276-a".to_string(),
                    operation_type: "UPSERT".to_string(),
                    version: Some(4),
                    payload: serde_json::json!({
                        "company_id": 1,
                        "branch_id": 1,
                        "operational_location_id": location_id,
                        "product_global_id": "product-276",
                        "product_name": "Langda",
                        "batch_no": "L-276-A",
                        "purchase_qty": 10.0,
                        "remaining_qty": 7.5,
                        "purchase_rate": 80.0,
                        "batch_status": "ACTIVE"
                    }),
                    updated_at: Some("2026-07-27T10:00:00.000Z".to_string()),
                },
            ],
        }
    }

    fn test_offline_purchase_payload(operation_id: &str) -> serde_json::Value {
        serde_json::json!({
            "operation_id": operation_id,
            "provisional_reference": format!("OFF-PUR-{operation_id}"),
            "supplier_id": "1",
            "purchase_date": "2026-07-28",
            "purchase_bill_status": "BILL_COMPLETED",
            "purchase_type": "CREDIT",
            "freight_charges": 10.0,
            "labour_charges": 5.0,
            "other_charges": 0.0,
            "paid_amount": 0.0,
            "rebate_rule_id": "1",
            "remarks": "Offline multi-line GRN",
            "company_id": "1",
            "branch_id": "1",
            "operational_location_id": "1001",
            "assignment_generation": 3,
            "device_id": "device-bootstrap",
            "user_id": "1",
            "items": [
                {
                    "product_id": "product-276",
                    "quantity": 2.5,
                    "purchase_rate": 80.0,
                    "unit": "KG",
                    "lot_name": "Offline Lot A",
                    "lot_size": "A"
                },
                {
                    "product_id": "product-276",
                    "quantity": 3.0,
                    "purchase_rate": 82.0,
                    "unit": "KG",
                    "lot_name": "Offline Lot B",
                    "lot_size": "B"
                }
            ]
        })
    }

    #[test]
    fn offline_purchase_intent_is_durable_idempotent_and_reconciles_canonical_ids() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-offline-purchase-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ));
        let _ = fs::remove_file(&path);
        initialize_at(&path).expect("initialize offline purchase database");
        apply_reference_bootstrap_at(
            &path,
            &test_reference_bootstrap("device-bootstrap", 1001),
            "device-bootstrap",
            Some("2026-07-28T08:00:00.000Z".to_string()),
        )
        .expect("bootstrap local references");

        let operation_id = "offline-purchase-op-1";
        let payload = test_offline_purchase_payload(operation_id);
        let queued = queue_local_purchase_at(&path, payload.clone()).expect("queue offline purchase");
        assert_eq!(queued.intent["sync_status"], "pending");
        queue_local_purchase_at(&path, payload.clone()).expect("idempotent repeated queue");

        let conn = Connection::open(&path).expect("inspect queued purchase");
        let counts: (i64, i64, i64, i64) = conn
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM local_purchase_intents),
                   (SELECT COUNT(*) FROM local_purchase_intent_lines),
                   (SELECT COUNT(*) FROM local_inventory_lots WHERE id LIKE 'offline-lot-%'),
                   (SELECT COUNT(*) FROM sync_outbox WHERE entity_type = 'purchase_grn')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read queue counts");
        assert_eq!(counts, (1, 2, 2, 1));
        drop(conn);

        let mut altered = payload;
        altered["items"][0]["quantity"] = serde_json::json!(9.0);
        let error = queue_local_purchase_at(&path, altered)
            .expect_err("same operation cannot change financial intent");
        assert!(error.contains("different financial intent"));

        mark_outbox_syncing_at(&path, &[operation_id.to_string()]).expect("mark replay syncing");
        let restarted = list_local_purchase_intents_with_conn(
            &Connection::open(&path).expect("reopen after restart"),
        )
        .expect("list after restart");
        assert_eq!(restarted[0]["sync_status"], "syncing");
        release_syncing_operations_at(
            &path,
            &[operation_id.to_string()],
            Some("Network interrupted".to_string()),
        )
        .expect("release interrupted replay");
        let released = list_local_purchase_intents_with_conn(
            &Connection::open(&path).expect("reopen after release"),
        )
        .expect("list released purchase");
        assert_eq!(released[0]["sync_status"], "pending");
        assert_eq!(released[0]["last_error"], "Network interrupted");

        let ack = SyncAck {
            operation_id: operation_id.to_string(),
            status: "accepted".to_string(),
            server_entity_version: Some(1),
            server_updated_at: Some("2026-07-28T08:05:00.000Z".to_string()),
            error_code: None,
            message: Some("Purchase Saved".to_string()),
            result_payload: Some(serde_json::json!({
                "purchase_id": 901,
                "purchase_ids": [901],
                "purchase": { "id": 901, "global_id": format!("offline-purchase-{operation_id}") },
                "purchases": [
                    { "id": 901, "global_id": format!("offline-purchase-{operation_id}") }
                ],
                "items": [
                    { "id": 701, "line_global_id": format!("offline-purchase-line-{operation_id}-1") },
                    { "id": 702, "line_global_id": format!("offline-purchase-line-{operation_id}-2") }
                ],
                "lots": [
                    { "id": 801, "global_id": format!("offline-lot-{operation_id}-1") },
                    { "id": 802, "global_id": format!("offline-lot-{operation_id}-2") }
                ]
            })),
        };
        let mut conn = Connection::open(&path).expect("open for acknowledgement");
        let tx = conn.transaction().expect("begin acknowledgement");
        apply_purchase_ack_with_tx(
            &tx,
            &ack,
            "completed",
            &serde_json::to_string(&ack).expect("serialize acknowledgement"),
            "2026-07-28T08:05:00.000Z",
        )
        .expect("apply canonical mapping");
        tx.commit().expect("commit acknowledgement");

        let conn = Connection::open(&path).expect("inspect reconciliation");
        let result: (String, i64, i64, i64, i64) = conn
            .query_row(
                "SELECT
                   (SELECT state FROM local_purchase_intents WHERE operation_id = ?1),
                   (SELECT COUNT(DISTINCT server_purchase_id) FROM local_purchase_intent_lines WHERE server_purchase_id IS NOT NULL),
                   (SELECT COUNT(*) FROM local_purchase_intent_lines WHERE server_purchase_item_id IS NOT NULL),
                   (SELECT COUNT(*) FROM local_purchase_intent_lines WHERE server_lot_id IS NOT NULL),
                   (SELECT COUNT(*) FROM local_inventory_lots WHERE id LIKE 'offline-lot-%' AND sync_status = 'synced')",
                [operation_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .expect("read reconciled aggregate state");
        assert_eq!(result, ("completed".to_string(), 1, 2, 2, 2));
        drop(conn);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn reference_bootstrap_is_atomic_idempotent_and_preserves_existing_rows() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-reference-bootstrap-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ));
        let _ = fs::remove_file(&path);
        initialize_at(&path).expect("initialize bootstrap database");
        {
            let conn = Connection::open(&path).expect("open bootstrap database");
            conn.execute(
                "INSERT INTO local_products (id, product_name, sync_status) VALUES ('local-preserved', 'Preserved Local Product', 'synced')",
                [],
            )
            .expect("insert preserved product");
        }
        let bootstrap = test_reference_bootstrap("device-bootstrap", 1001);
        apply_reference_bootstrap_at(
            &path,
            &bootstrap,
            "device-bootstrap",
            Some("2026-07-27T10:01:00.000Z".to_string()),
        )
        .expect("apply first bootstrap");
        apply_reference_bootstrap_at(
            &path,
            &bootstrap,
            "device-bootstrap",
            Some("2026-07-27T10:02:00.000Z".to_string()),
        )
        .expect("retry bootstrap");

        let incremental = PulledChange {
            change_id: serde_json::json!(45),
            branch_id: Some(1),
            entity_type: "product".to_string(),
            entity_id: "product-276".to_string(),
            operation_type: "UPSERT".to_string(),
            version: Some(3),
            payload: serde_json::json!({
                "company_id": 1,
                "branch_id": 1,
                "product_name": "Langda Updated",
                "unit": "KG",
                "selling_rate": 125.0,
                "active": true
            }),
            updated_at: Some("2026-07-27T10:03:00.000Z".to_string()),
        };
        let location_product_incremental = PulledChange {
            change_id: serde_json::json!(46),
            branch_id: Some(1),
            entity_type: "location_product".to_string(),
            entity_id: "1001:product-276".to_string(),
            operation_type: "UPSERT".to_string(),
            version: Some(2),
            payload: serde_json::json!({
                "company_id": 1,
                "branch_id": 1,
                "operational_location_id": 1001,
                "product_global_id": "product-276",
                "enabled": true,
                "pos_available": true,
                "selling_rate": 130.0,
                "reorder_level": 4.0
            }),
            updated_at: Some("2026-07-27T10:03:01.000Z".to_string()),
        };
        apply_pull_changes_at(
            &path,
            &[incremental, location_product_incremental],
            "46",
            Some("device-bootstrap".to_string()),
            Some("2026-07-27T10:03:02.000Z".to_string()),
        )
        .expect("apply incremental after bootstrap");

        let conn = Connection::open(&path).expect("inspect bootstrap database");
        let counts: (i64, i64, i64, i64) = conn
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM local_products),
                   (SELECT COUNT(*) FROM local_products WHERE id = 'product-276'),
                   (SELECT COUNT(*) FROM local_inventory_lots WHERE id = 'lot-276-a'),
                   (SELECT COUNT(*) FROM local_operational_location_products WHERE product_id = 'product-276')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read idempotency counts");
        assert_eq!(counts, (2, 1, 1, 1));
        let cursor: String = conn
            .query_row(
                "SELECT last_pull_cursor FROM sync_state WHERE device_id = 'device-bootstrap'",
                [],
                |row| row.get(0),
            )
            .expect("read incremental cursor");
        assert_eq!(cursor, "46");
        let updated_name: String = conn
            .query_row("SELECT product_name FROM local_products WHERE id = 'product-276'", [], |row| row.get(0))
            .expect("read incrementally updated product");
        assert_eq!(updated_name, "Langda Updated");
        let location_rate: f64 = conn
            .query_row(
                "SELECT selling_rate FROM local_operational_location_products
                 WHERE operational_location_id = '1001' AND product_id = 'product-276'",
                [],
                |row| row.get(0),
            )
            .expect("read incrementally updated location selling rate");
        assert_eq!(location_rate, 130.0);
        let supplier_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_supplier_references WHERE id = '1' AND company_id = '1' AND active = 1",
                [],
                |row| row.get(0),
            )
            .expect("read bootstrapped supplier");
        assert_eq!(supplier_count, 1);
        drop(conn);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn supplier_references_bootstrap_and_increment_without_duplication_or_financial_fields() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-supplier-reference-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ));
        let _ = fs::remove_file(&path);
        initialize_at(&path).expect("initialize supplier reference database");
        let bootstrap = test_reference_bootstrap("device-bootstrap", 1001);
        apply_reference_bootstrap_at(
            &path,
            &bootstrap,
            "device-bootstrap",
            Some("2026-07-27T10:01:00.000Z".to_string()),
        )
        .expect("apply supplier bootstrap");
        apply_reference_bootstrap_at(
            &path,
            &bootstrap,
            "device-bootstrap",
            Some("2026-07-27T10:02:00.000Z".to_string()),
        )
        .expect("retry supplier bootstrap");

        let updated = PulledChange {
            change_id: serde_json::json!(45),
            branch_id: Some(1),
            entity_type: "supplier".to_string(),
            entity_id: "1".to_string(),
            operation_type: "UPSERT".to_string(),
            version: Some(1),
            payload: serde_json::json!({
                "id": 1,
                "company_id": 1,
                "supplier_name": "Bootstrap Supplier Updated",
                "firm_name": "Bootstrap Firm",
                "supplier_type": "LOCAL_SUPPLIER",
                "active": false,
                "opening_balance": 999999,
                "bank_name": "must-not-be-stored",
                "notes": "must-not-be-stored"
            }),
            updated_at: Some("2026-07-27T10:03:00.000Z".to_string()),
        };
        apply_pull_changes_at(
            &path,
            &[updated],
            "45",
            Some("device-bootstrap".to_string()),
            Some("2026-07-27T10:03:01.000Z".to_string()),
        )
        .expect("apply supplier incremental");

        let conn = Connection::open(&path).expect("inspect supplier reference database");
        let supplier: (i64, String, i64) = conn
            .query_row(
                "SELECT COUNT(*), MAX(supplier_name), MAX(active) FROM local_supplier_references WHERE id = '1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read supplier reference");
        assert_eq!(supplier, (1, "Bootstrap Supplier Updated".to_string(), 0));
        let columns: Vec<String> = {
            let mut statement = conn.prepare("PRAGMA table_info(local_supplier_references)").expect("read supplier schema");
            statement
                .query_map([], |row| row.get(1))
                .expect("query supplier schema")
                .collect::<Result<Vec<_>, _>>()
                .expect("collect supplier schema")
        };
        assert!(!columns.contains(&"opening_balance".to_string()));
        assert!(!columns.contains(&"bank_name".to_string()));
        assert!(!columns.contains(&"notes".to_string()));
        drop(conn);

        let snapshot = load_reference_snapshot_at(&path, None, Some("device-bootstrap"))
            .expect("load supplier snapshot");
        let suppliers = snapshot["settings_bundle"]["offlineSuppliers"]
            .as_array()
            .expect("offline supplier list");
        assert_eq!(suppliers.len(), 1);
        assert_eq!(suppliers[0]["supplier_name"], "Bootstrap Supplier Updated");
        assert_eq!(suppliers[0]["active"], false);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn product_with_explicitly_missing_canonical_category_keeps_label_without_invalid_fk() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-product-missing-category-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ));
        let _ = fs::remove_file(&path);
        initialize_at(&path).expect("initialize missing-category database");
        let product = PulledChange {
            change_id: serde_json::json!(1),
            branch_id: Some(1),
            entity_type: "product".to_string(),
            entity_id: "product-legacy-category".to_string(),
            operation_type: "UPSERT".to_string(),
            version: Some(1),
            payload: serde_json::json!({
                "company_id": 1,
                "branch_id": 1,
                "product_name": "Legacy Category Product",
                "category_id": 999,
                "category_global_id": null,
                "category_name": "Legacy Category",
                "unit": "KG",
                "active": true
            }),
            updated_at: Some("2026-07-29T10:00:00.000Z".to_string()),
        };

        apply_pull_changes_at(
            &path,
            &[product],
            "1",
            Some("device-bootstrap".to_string()),
            Some("2026-07-29T10:00:01.000Z".to_string()),
        )
        .expect("apply product without canonical category");

        let conn = Connection::open(&path).expect("inspect missing-category database");
        let result: (Option<String>, String) = conn
            .query_row(
                "SELECT category_id, category_name FROM local_products WHERE id = 'product-legacy-category'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read product category compatibility state");
        assert_eq!(result, (None, "Legacy Category".to_string()));
        drop(conn);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn online_snapshot_refresh_preserves_bootstrapped_company_and_location_scope() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-reference-scope-refresh-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ));
        let _ = fs::remove_file(&path);
        initialize_at(&path).expect("initialize scoped snapshot database");
        let bootstrap = test_reference_bootstrap("device-bootstrap", 1001);
        apply_reference_bootstrap_at(
            &path,
            &bootstrap,
            "device-bootstrap",
            Some("2026-07-27T10:02:00.000Z".to_string()),
        )
        .expect("apply reference bootstrap");

        let records = |entity_type: &str| {
            bootstrap
                .records
                .iter()
                .filter(|change| change.entity_type == entity_type)
                .map(|change| {
                    let mut payload = change.payload.clone();
                    payload["global_id"] = serde_json::json!(change.entity_id);
                    payload
                })
                .collect::<Vec<_>>()
        };
        cache_reference_snapshot_at(
            &path,
            &serde_json::json!({
                "branch_context": { "branch_id": "1", "branch_name": "Main" },
                "device_identity": { "device_id": "device-bootstrap", "device_name": "Bootstrap Device" },
                "products": records("product"),
                "categories": [],
                "inventory_lots": records("inventory_lot"),
                "customers": [],
                "sales_history": [],
                "settings_bundle": {}
            }),
        )
        .expect("refresh online snapshot after bootstrap");

        let conn = Connection::open(&path).expect("inspect scoped snapshot database");
        let scoped_lots: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_inventory_lots
                 WHERE company_id = '1' AND operational_location_id = '1001'",
                [],
                |row| row.get(0),
            )
            .expect("read scoped cached lots");
        assert_eq!(scoped_lots, 1);
        let scoped_products: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_products WHERE company_id = '1'",
                [],
                |row| row.get(0),
            )
            .expect("read company-scoped cached products");
        assert_eq!(scoped_products, 1);
        drop(conn);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn online_snapshot_refresh_updates_cached_purchase_rules_idempotently() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-purchase-rules-refresh-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ));
        let _ = fs::remove_file(&path);
        initialize_at(&path).expect("initialize purchase-rule snapshot database");

        let snapshot = |rebate_percent: i64| {
            serde_json::json!({
                "branch_context": { "branch_id": "1", "branch_name": "Main" },
                "device_identity": { "device_id": "device-rules", "device_name": "Rules Device" },
                "products": [],
                "categories": [],
                "inventory_lots": [],
                "customers": [],
                "sales_history": [],
                "settings_bundle": {
                    "mandiTaxRules": [{ "id": 1, "origin_type": "LOCAL", "tax_percent": 2, "active": true }],
                    "rebateRules": [{ "id": 4, "rule_name": "Later", "pay_within_days": 15, "rebate_percent": rebate_percent, "active": true }]
                }
            })
        };

        cache_reference_snapshot_at(&path, &snapshot(0)).expect("cache initial purchase rules");
        cache_reference_snapshot_at(&path, &snapshot(1)).expect("refresh purchase rules");

        let loaded = load_reference_snapshot_at(&path, None, Some("device-rules"))
            .expect("load refreshed purchase rules");
        assert_eq!(loaded["settings_bundle"]["mandiTaxRules"].as_array().unwrap().len(), 1);
        assert_eq!(loaded["settings_bundle"]["rebateRules"].as_array().unwrap().len(), 1);
        assert_eq!(loaded["settings_bundle"]["rebateRules"][0]["rebate_percent"], 1);

        let conn = Connection::open(&path).expect("inspect purchase-rule cache");
        let rule_setting_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_settings WHERE setting_key IN ('mandiTaxRules', 'rebateRules')",
                [],
                |row| row.get(0),
            )
            .expect("count cached purchase-rule settings");
        assert_eq!(rule_setting_count, 2);
        drop(conn);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn snapshot_cache_never_creates_or_prefers_a_default_device_identity() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-no-default-device-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ));
        let _ = fs::remove_file(&path);
        initialize_at(&path).expect("initialize device identity database");

        let missing_identity = serde_json::json!({
            "branch_context": { "branch_id": "1" },
            "products": [],
            "categories": [],
            "inventory_lots": [],
            "customers": [],
            "sales_history": [],
            "settings_bundle": {}
        });
        assert!(cache_reference_snapshot_at(&path, &missing_identity)
            .expect_err("missing canonical identity must fail closed")
            .contains("no canonical device identity"));

        let conn = Connection::open(&path).expect("seed identity compatibility rows");
        conn.execute(
            "INSERT INTO local_device_identity (
                device_id, device_name, platform, app_version, branch_id, registration_status, updated_at
             ) VALUES
               ('canonical-device', 'Canonical', 'tauri-windows', '1.0.65', '1', 'approved', '2026-07-29T10:00:00.000Z'),
               ('other-device', 'Other', 'tauri-windows', '1.0.65', '2', 'pending', '2026-07-29T12:00:00.000Z'),
               ('default', 'Legacy Default', 'tauri-windows', '1.0.65', '1', 'approved', '2026-07-29T11:00:00.000Z')",
            [],
        )
        .expect("seed canonical and legacy default identities");
        drop(conn);

        let selected = ensure_device_identity_with_preference_at(&path, Some("canonical-device"))
            .expect("select configured canonical identity");
        assert_eq!(selected["device_id"], "canonical-device");
        let preserved = ensure_device_identity_with_preference_at(&path, Some("fresh-device"))
            .expect("approved canonical identity wins over a provisional preference");
        assert_eq!(preserved["device_id"], "canonical-device");
        let conn = Connection::open(&path).expect("inspect device identities");
        let fresh_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_device_identity WHERE device_id = 'fresh-device'",
                [],
                |row| row.get(0),
            )
            .expect("count rejected fresh identities");
        assert_eq!(fresh_count, 0);
        let default_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_device_identity WHERE device_id = 'default'",
                [],
                |row| row.get(0),
            )
            .expect("count retained legacy default rows");
        assert_eq!(default_count, 1);
        drop(conn);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn conflicting_approved_identities_fail_without_creating_or_overwriting() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-device-conflict-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ));
        let _ = fs::remove_file(&path);
        initialize_at(&path).expect("initialize conflict profile");
        let conn = Connection::open(&path).expect("seed conflicts");
        conn.execute(
            "INSERT INTO local_device_identity (device_id, device_name, platform, app_version, branch_id, registration_status)
             VALUES ('approved-a', 'A', 'tauri-windows', '1.0.65', '1', 'approved'),
                    ('approved-b', 'B', 'tauri-windows', '1.0.65', '1', 'approved')",
            [],
        )
        .expect("insert conflicts");
        drop(conn);
        let error = ensure_device_identity_with_preference_at(&path, Some("approved-a"))
            .expect_err("ambiguous approved identities must fail");
        assert!(error.contains("DEVICE_IDENTITY_CONFLICT"));
        let conn = Connection::open(&path).expect("inspect conflicts");
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM local_device_identity", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 2);
        drop(conn);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn clean_install_generates_exactly_one_identity_and_reuses_it() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-clean-device-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ));
        let _ = fs::remove_file(&path);
        initialize_at(&path).expect("initialize clean profile");
        let created = ensure_device_identity_with_preference_at(&path, None).expect("create one identity");
        let reused = ensure_device_identity_with_preference_at(&path, created["device_id"].as_str())
            .expect("reuse generated identity");
        assert_eq!(created["device_id"], reused["device_id"]);
        let conn = Connection::open(&path).expect("inspect clean profile");
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM local_device_identity", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 1);
        drop(conn);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn rejected_or_interrupted_reference_bootstrap_rolls_back_every_local_write() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-reference-bootstrap-reject-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ));
        let _ = fs::remove_file(&path);
        initialize_at(&path).expect("initialize rejected bootstrap database");
        let mut bootstrap = test_reference_bootstrap("device-bootstrap", 1001);
        let lot = bootstrap.records.iter_mut()
            .find(|change| change.entity_type == "inventory_lot")
            .expect("inventory lot fixture");
        lot.payload["operational_location_id"] = serde_json::json!(2002);
        let error = apply_reference_bootstrap_at(
            &path,
            &bootstrap,
            "device-bootstrap",
            Some("2026-07-27T10:01:00.000Z".to_string()),
        )
        .expect_err("cross-location lot must be rejected");
        assert!(error.contains("outside the canonical device scope"));
        let conn = Connection::open(&path).expect("inspect rolled back bootstrap");
        let count: i64 = conn
            .query_row(
                "SELECT
                   (SELECT COUNT(*) FROM local_products) +
                   (SELECT COUNT(*) FROM local_supplier_references) +
                   (SELECT COUNT(*) FROM local_inventory_lots) +
                   (SELECT COUNT(*) FROM local_operational_locations) +
                   (SELECT COUNT(*) FROM local_device_assignment)",
                [],
                |row| row.get(0),
            )
            .expect("read rollback counts");
        assert_eq!(count, 0);
        drop(conn);

        let identity_error = apply_reference_bootstrap_at(
            &path,
            &test_reference_bootstrap("device-bootstrap", 1001),
            "different-device",
            Some("2026-07-27T10:01:00.000Z".to_string()),
        )
        .expect_err("substituted device must be rejected");
        assert!(identity_error.contains("device identity"));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn isolated_sqlite_override_is_absolute_and_test_only() {
        let default_dir = PathBuf::from(r"C:\Users\Example\AppData\Roaming\com.srtcompany.froozerp");
        let isolated_dir = PathBuf::from(r"F:\FroozERP\_recovery_backups\disposable-profile");

        assert_eq!(
            resolve_app_data_dir(
                default_dir.clone(),
                Some("test"),
                Some(isolated_dir.clone()),
            )
            .expect("accept isolated test directory"),
            isolated_dir
        );
        assert_eq!(
            resolve_app_data_dir(
                default_dir.clone(),
                Some("production"),
                Some(PathBuf::from(r"F:\ignored")),
            )
            .expect("ignore override outside tests"),
            default_dir
        );
        assert!(resolve_app_data_dir(
            PathBuf::from(r"C:\default"),
            Some("test"),
            Some(PathBuf::from("relative-profile")),
        )
        .expect_err("reject relative isolated directory")
        .contains("absolute path"));
    }

    #[test]
    fn clean_profiles_initialize_sqlite_schema_independently_and_restart() {
        let root = std::env::temp_dir().join(format!(
            "froozerp-clean-profiles-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let first = root.join("profile-a").join(LOCAL_DB_FILE);
        let second = root.join("profile-b").join(LOCAL_DB_FILE);

        let mut device_ids = Vec::new();
        for path in [&first, &second] {
            initialize_at(path).expect("initialize fresh SQLite profile");
            let identity = ensure_device_identity_at(path).expect("create fresh device identity");
            let device_id = identity["device_id"].as_str().expect("device id").to_string();
            assert!(device_id.starts_with("FZDEV-"));
            assert!(!device_id.to_lowercase().contains("profile-a"));
            assert!(!device_id.to_lowercase().contains("profile-b"));
            assert_eq!(identity["branch_id"], "unassigned");
            device_ids.push(device_id.clone());
            let status = status_at(path).expect("read fresh SQLite status");
            assert!(status.initialized);
            assert_eq!(status.schema_version, CURRENT_SCHEMA_VERSION);
            let conn = Connection::open(path).expect("open initialized SQLite database");
            let migration_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM local_schema_migrations WHERE status = 'APPLIED'",
                    [],
                    |row| row.get(0),
                )
                .expect("migration count");
            assert_eq!(migration_count, 17);
            drop(conn);
            initialize_at(path).expect("restart with existing SQLite profile");
            let restored = ensure_device_identity_at(path).expect("restore device identity");
            assert_eq!(restored["device_id"], device_id);
        }

        assert_ne!(first, second);
        assert_ne!(device_ids[0], device_ids[1]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn existing_schema_five_upgrades_additively_without_losing_local_data() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-schema-upgrade-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ));
        let _ = fs::remove_file(&path);
        let mut conn = Connection::open(&path).expect("open schema upgrade database");
        conn.execute_batch(
            "CREATE TABLE local_schema_migrations (
                version TEXT PRIMARY KEY,
                applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                checksum TEXT NOT NULL,
                status TEXT NOT NULL
            );",
        )
        .expect("create legacy migration table");
        for (version, sql) in [
            ("001_local_foundation", MIGRATION_001),
            ("002_sync_engine_foundation", MIGRATION_002),
            ("003_local_first_pos", MIGRATION_003),
            ("004_offline_sale_edit_cancel", MIGRATION_004),
            ("005_mandi_tax_sale_details", MIGRATION_005),
        ] {
            apply_migration(&mut conn, version, sql).expect("apply legacy migration");
        }
        conn.execute(
            "INSERT INTO local_kv (key, value) VALUES ('preservation-marker', 'keep-me')",
            [],
        )
        .expect("insert preservation marker");
        drop(conn);

        initialize_at(&path).expect("upgrade existing SQLite database");
        let conn = Connection::open(&path).expect("inspect upgraded SQLite database");
        let migration_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_schema_migrations WHERE status = 'APPLIED'",
                [],
                |row| row.get(0),
            )
            .expect("migration count");
        let marker: String = conn
            .query_row(
                "SELECT value FROM local_kv WHERE key = 'preservation-marker'",
                [],
                |row| row.get(0),
            )
            .expect("preserved marker");
        assert_eq!(migration_count, 17);
        assert_eq!(marker, "keep-me");
        drop(conn);
        let _ = fs::remove_file(&path);
    }

    /// Build a profile shaped like every real installation that predates offline activation:
    /// one approved identity, a cached user profile, and no entitlement.
    fn seed_legacy_profile(path: &Path, device_id: &str, with_profile: bool) {
        initialize_at(path).expect("initialize legacy profile");
        let conn = Connection::open(path).expect("open legacy profile");
        conn.execute(
            "INSERT INTO local_device_identity
               (device_id,device_name,platform,app_version,branch_id,registration_status,company_id)
             VALUES (?1,'Legacy Device','tauri-windows','1.0.71','7','approved','3')",
            params![device_id],
        )
        .expect("insert approved identity");
        if with_profile {
            conn.execute(
                "INSERT INTO local_kv (key, value) VALUES (?1, ?2)",
                params![
                    format!("offline_user_profile::{device_id}::owner"),
                    "{\"id\":\"1\",\"company_id\":\"3\",\"role\":\"OWNER\"}"
                ],
            )
            .expect("insert cached user profile");
        }
    }

    fn entitlement_rows(path: &Path) -> i64 {
        let conn = Connection::open(path).expect("open profile");
        conn.query_row("SELECT COUNT(*) FROM local_entitlement", [], |row| row.get(0))
            .expect("count entitlements")
    }

    #[test]
    fn legacy_device_with_cached_profile_is_grandfathered_once() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-grandfather-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ));
        let _ = fs::remove_file(&path);
        let device_id = "FZDEV-LEGACY-GRANDFATHER";
        seed_legacy_profile(&path, device_id, true);

        ensure_device_identity_at(&path).expect("resolve identity");
        assert_eq!(entitlement_rows(&path), 1, "a qualifying device must be shimmed");

        let conn = Connection::open(&path).expect("open profile");
        let (serial, state, source, company, branch, sig_len, payload_len, binding): (
            String,
            String,
            String,
            String,
            String,
            i64,
            i64,
            String,
        ) = conn
            .query_row(
                "SELECT entitlement_serial, verification_state, source, company_id, branch_id,
                        length(signature_blob), length(payload_blob), device_binding_hex
                 FROM local_entitlement",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                    ))
                },
            )
            .expect("read shim row");

        assert_eq!(serial, format!("LEGACY-{device_id}"));
        assert_eq!(state, "LEGACY_GRANDFATHER");
        assert_eq!(source, "LEGACY_UPGRADE");
        assert_eq!(company, "3", "company_id comes from the existing identity");
        assert_eq!(branch, "7", "branch_id comes from the existing identity");
        // §11.1: the shim is not a credential. 017's CHECK only admits LEGACY_GRANDFATHER with
        // an empty signature, and payload_blob is NOT NULL, so it must be an empty blob.
        assert_eq!(sig_len, 0, "a shim must carry no signature");
        assert_eq!(payload_len, 0, "a shim has no signed payload");
        let expected_binding = crate::entitlement::device_binding_hash(device_id)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        assert_eq!(binding, expected_binding);

        // D-15: 400 days validity, plus grace, and ordered so 017's CHECKs hold.
        let (issued, expires, grace): (String, String, String) = conn
            .query_row(
                "SELECT issued_at, expires_at, grace_until FROM local_entitlement",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read window");
        assert!(issued <= expires && expires <= grace, "signed window must be ordered");
        assert!(expires > issued, "400-day validity must be in the future");

        let audit: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_entitlement_audit WHERE reason_code = 'LEGACY_GRANDFATHER'",
                [],
                |row| row.get(0),
            )
            .expect("count audit");
        assert_eq!(audit, 1, "grandfathering must be recorded in the audit log");
        drop(conn);

        // Idempotent across restarts: a second resolve must not add a second shim.
        ensure_device_identity_at(&path).expect("resolve identity again");
        assert_eq!(entitlement_rows(&path), 1, "restart must not duplicate the shim");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn legacy_device_without_cached_profile_is_not_grandfathered() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-grandfather-noprofile-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ));
        let _ = fs::remove_file(&path);
        seed_legacy_profile(&path, "FZDEV-LEGACY-NOPROFILE", false);

        ensure_device_identity_at(&path).expect("resolve identity");
        assert_eq!(
            entitlement_rows(&path),
            0,
            "an approved identity alone is not evidence of a provisioned device"
        );
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn grandfathering_never_displaces_an_existing_entitlement() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-grandfather-existing-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ));
        let _ = fs::remove_file(&path);
        let device_id = "FZDEV-LEGACY-EXISTING";
        seed_legacy_profile(&path, device_id, true);

        let conn = Connection::open(&path).expect("open profile");
        conn.execute(
            "INSERT INTO local_entitlement (
                entitlement_serial, key_id, format_version, company_id, branch_id, device_id,
                device_binding_hex, issued_at, expires_at, grace_until,
                payload_blob, signature_blob, verification_state, source
             ) VALUES ('REAL-1', 1, 1, '3', '7', ?1, 'aabbccdd',
                '2026-01-01T00:00:00.000Z','2027-01-01T00:00:00.000Z','2027-03-02T00:00:00.000Z',
                X'0102', ?2, 'VERIFIED', 'OFFLINE_FILE')",
            params![device_id, vec![7u8; 64]],
        )
        .expect("insert a real verified entitlement");
        drop(conn);

        ensure_device_identity_at(&path).expect("resolve identity");
        assert_eq!(
            entitlement_rows(&path),
            1,
            "a device holding a real entitlement must never gain a shim"
        );
        let conn = Connection::open(&path).expect("open profile");
        let state: String = conn
            .query_row("SELECT verification_state FROM local_entitlement", [], |row| row.get(0))
            .expect("read state");
        assert_eq!(state, "VERIFIED", "the real entitlement must be untouched");
        let _ = fs::remove_file(&path);
    }

    // ---- Stage 5: offline activation redemption and state ------------------------------

    fn activation_temp_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "froozerp-{label}-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ))
    }

    fn test_signing_key() -> ed25519_dalek::SigningKey {
        ed25519_dalek::SigningKey::from_bytes(&[7u8; 32])
    }

    /// A trusted-key table matching the throwaway signing key. Never `TRUSTED_ACTIVATION_KEYS`:
    /// `accept_entitlement_at`/`entitlement_state_at` take the table as a parameter for exactly
    /// this reason, so the suite never depends on production key material.
    fn test_trusted_keys() -> Vec<(u8, [u8; 32])> {
        vec![(0x01, test_signing_key().verifying_key().to_bytes())]
    }

    fn put_varint_test(out: &mut Vec<u8>, mut value: u64) {
        loop {
            let mut byte = (value & 0x7F) as u8;
            value >>= 7;
            if value != 0 {
                byte |= 0x80;
            }
            out.push(byte);
            if value == 0 {
                break;
            }
        }
    }

    /// Build a §4 payload bound to `device_id`. Independent of `sign_activation` so this test
    /// controls issued_at directly (the state tests need it relative to the run clock).
    fn build_payload(
        device_id: &str,
        serial: u32,
        issued_at: u16,
        valid_days: u16,
        bootstrap: Option<(&str, u16)>,
    ) -> Vec<u8> {
        let mut out = Vec::new();
        out.push(crate::entitlement::FORMAT_VERSION);
        out.push(0x01); // key_id
        out.push(if bootstrap.is_some() { 0b0000_0001 } else { 0 });
        put_varint_test(&mut out, 1); // company_id
        put_varint_test(&mut out, 1); // branch_id
        out.extend_from_slice(&crate::entitlement::device_binding_hash(device_id));
        out.extend_from_slice(&serial.to_le_bytes());
        out.extend_from_slice(&issued_at.to_le_bytes());
        out.extend_from_slice(&valid_days.to_le_bytes());
        if let Some((name, days)) = bootstrap {
            out.push(name.len() as u8);
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(&[0x11u8; 16]);
            out.extend_from_slice(&[0x22u8; 32]);
            out.extend_from_slice(&days.to_le_bytes());
        }
        out
    }

    fn sign_payload(payload: &[u8]) -> Vec<u8> {
        use ed25519_dalek::Signer;
        test_signing_key().sign(payload).to_bytes().to_vec()
    }

    /// Days since 2020-01-01 for the run clock, matching the SQL `julianday` floor used inside
    /// `entitlement_state_at`.
    fn today_day() -> u16 {
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_secs() as i64;
        (secs / 86_400 - 18_262) as u16
    }

    #[test]
    fn accepting_a_genuine_code_inserts_verified_row_and_reports_active() {
        let path = activation_temp_path("accept-genuine");
        let _ = fs::remove_file(&path);
        let device = "FZDEV-ACCEPT-1";
        let issued = today_day().saturating_sub(10);
        let payload = build_payload(device, 4242, issued, 365, None);
        let sig = sign_payload(&payload);

        let result =
            accept_entitlement_at(&path, device, &payload, &sig, "OFFLINE_FILE", &test_trusted_keys())
                .expect("genuine code must be accepted");
        assert_eq!(result["accepted"], serde_json::json!(true));
        assert_eq!(result["entitlement_serial"], serde_json::json!("4242"));
        assert_eq!(result["verification_state"], serde_json::json!("VERIFIED"));

        let conn = Connection::open(&path).expect("open db");
        let (vstate, sig_len): (String, i64) = conn
            .query_row(
                "SELECT verification_state, length(signature_blob) FROM local_entitlement WHERE entitlement_serial = '4242'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read verified row");
        assert_eq!(vstate, "VERIFIED");
        assert_eq!(sig_len, 64, "a VERIFIED row must carry a 64-byte signature");
        let accepted: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_entitlement_audit WHERE event = 'ACCEPTED' AND entitlement_serial = '4242'",
                [],
                |row| row.get(0),
            )
            .expect("count accepted audit");
        assert_eq!(accepted, 1, "acceptance must be recorded once");
        drop(conn);

        let state = entitlement_state_at(&path, device, &test_trusted_keys()).expect("state");
        assert_eq!(state["state"], serde_json::json!("Active"));
        assert_eq!(state["billing_allowed"], serde_json::json!(true));
        assert_eq!(state["capabilities"]["billing"], serde_json::json!(true));

        // A second accept of the exact same artefact is idempotent, not a duplicate.
        let again =
            accept_entitlement_at(&path, device, &payload, &sig, "OFFLINE_FILE", &test_trusted_keys())
                .expect("second accept must succeed idempotently");
        assert_eq!(again["idempotent"], serde_json::json!(true));
        assert_eq!(entitlement_rows(&path), 1, "idempotent accept must not duplicate");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn wrong_device_payload_is_rejected_with_binding_mismatch() {
        let path = activation_temp_path("accept-wrongdevice");
        let _ = fs::remove_file(&path);
        let issued = today_day().saturating_sub(10);
        let payload = build_payload("FZDEV-OWNER", 55, issued, 365, None);
        let sig = sign_payload(&payload);

        let err = accept_entitlement_at(
            &path,
            "FZDEV-SOMEONE-ELSE",
            &payload,
            &sig,
            "OFFLINE_FILE",
            &test_trusted_keys(),
        )
        .expect_err("a payload for another device must be rejected");
        assert!(err.contains("DEVICE_BINDING_MISMATCH"), "got: {err}");

        let conn = Connection::open(&path).expect("open db");
        let rejected: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_entitlement_audit WHERE event = 'REJECTED' AND reason_code = 'DeviceBindingMismatch'",
                [],
                |row| row.get(0),
            )
            .expect("count rejected audit");
        assert_eq!(rejected, 1, "the rejection must be logged");
        drop(conn);
        assert_eq!(entitlement_rows(&path), 0, "a rejected code writes no ledger row");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn grandfather_row_is_active_then_superseded_by_a_real_code() {
        let path = activation_temp_path("accept-supersede");
        let _ = fs::remove_file(&path);
        let device = "FZDEV-LEGACY-THEN-REAL";
        seed_legacy_profile(&path, device, true);
        ensure_device_identity_at(&path).expect("grandfather the device");
        assert_eq!(entitlement_rows(&path), 1, "the device must be shimmed");

        // The shim alone keeps the shop running.
        let state = entitlement_state_at(&path, device, &test_trusted_keys()).expect("state");
        assert_eq!(state["state"], serde_json::json!("Active"));
        assert_eq!(state["billing_allowed"], serde_json::json!(true));
        assert_eq!(state["verification_state"], serde_json::json!("LEGACY_GRANDFATHER"));

        // First real redemption supersedes the shim.
        let issued = today_day().saturating_sub(10);
        let payload = build_payload(device, 9001, issued, 365, None);
        let sig = sign_payload(&payload);
        let result =
            accept_entitlement_at(&path, device, &payload, &sig, "OFFLINE_FILE", &test_trusted_keys())
                .expect("real code accepted");
        let superseded = result["superseded"].as_array().expect("superseded array");
        assert_eq!(superseded.len(), 1, "the shim must be superseded");
        assert_eq!(superseded[0], serde_json::json!(format!("LEGACY-{device}")));

        let conn = Connection::open(&path).expect("open db");
        let shim_superseded: Option<String> = conn
            .query_row(
                "SELECT superseded_at FROM local_entitlement WHERE verification_state = 'LEGACY_GRANDFATHER'",
                [],
                |row| row.get(0),
            )
            .expect("read shim");
        assert!(shim_superseded.is_some(), "the shim must carry a superseded_at");
        drop(conn);

        let state = entitlement_state_at(&path, device, &test_trusted_keys()).expect("state");
        assert_eq!(state["state"], serde_json::json!("Active"));
        assert_eq!(state["verification_state"], serde_json::json!("VERIFIED"));
        assert_eq!(state["entitlement_serial"], serde_json::json!("9001"));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn bootstrap_credential_is_pending_then_consumed_once() {
        let path = activation_temp_path("accept-bootstrap");
        let _ = fs::remove_file(&path);
        let device = "FZDEV-BOOTSTRAP-1";
        let issued = today_day().saturating_sub(10);
        // bootstrap_valid_days comfortably beyond the 10-day backdate so the window is open now.
        let payload = build_payload(device, 77, issued, 365, Some(("owner", 30)));
        let sig = sign_payload(&payload);
        let accept =
            accept_entitlement_at(&path, device, &payload, &sig, "OFFLINE_FILE", &test_trusted_keys())
                .expect("bootstrap code accepted");
        assert_eq!(accept["bootstrap_present"], serde_json::json!(true));

        let state = entitlement_state_at(&path, device, &test_trusted_keys()).expect("state");
        let boot = &state["bootstrap"];
        assert_eq!(boot["pending"], serde_json::json!(true));
        assert_eq!(boot["consumed"], serde_json::json!(false));
        assert_eq!(boot["window_open"], serde_json::json!(true));
        assert_eq!(boot["owner_username"], serde_json::json!("owner"));
        assert_eq!(
            boot["owner_salt_hex"],
            serde_json::json!("11111111111111111111111111111111")
        );
        assert_eq!(
            boot["owner_verifier_hex"],
            serde_json::json!("2222222222222222222222222222222222222222222222222222222222222222")
        );

        consume_bootstrap_at(&path, device, "77").expect("consume");
        let state = entitlement_state_at(&path, device, &test_trusted_keys()).expect("state");
        assert_eq!(state["bootstrap"]["pending"], serde_json::json!(false));
        assert_eq!(state["bootstrap"]["consumed"], serde_json::json!(true));

        let conn = Connection::open(&path).expect("open db");
        let consumed_audit: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_entitlement_audit WHERE event = 'BOOTSTRAP_CREDENTIAL_CONSUMED'",
                [],
                |row| row.get(0),
            )
            .expect("count consumption audit");
        assert_eq!(consumed_audit, 1, "consumption must be logged once");
        let first_ts: String = conn
            .query_row(
                "SELECT bootstrap_consumed_at FROM local_entitlement WHERE entitlement_serial = '77'",
                [],
                |row| row.get(0),
            )
            .expect("read consumed timestamp");
        drop(conn);

        // A second consume is a no-op: it must not overwrite the timestamp or re-log.
        consume_bootstrap_at(&path, device, "77").expect("second consume");
        let conn = Connection::open(&path).expect("open db");
        let second_ts: String = conn
            .query_row(
                "SELECT bootstrap_consumed_at FROM local_entitlement WHERE entitlement_serial = '77'",
                [],
                |row| row.get(0),
            )
            .expect("read consumed timestamp again");
        assert_eq!(first_ts, second_ts, "single-use: timestamp must never be overwritten");
        let consumed_audit_again: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_entitlement_audit WHERE event = 'BOOTSTRAP_CREDENTIAL_CONSUMED'",
                [],
                |row| row.get(0),
            )
            .expect("count consumption audit again");
        assert_eq!(consumed_audit_again, 1, "a no-op consume must not re-log");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn empty_db_reports_unprovisioned() {
        let path = activation_temp_path("state-empty");
        let _ = fs::remove_file(&path);
        let state =
            entitlement_state_at(&path, "FZDEV-NONE", &test_trusted_keys()).expect("state");
        assert_eq!(state["state"], serde_json::json!("Unprovisioned"));
        assert_eq!(state["billing_allowed"], serde_json::json!(false));
        assert_eq!(state["bootstrap"], serde_json::Value::Null);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn released_1063_and_1065_profiles_upgrade_without_losing_scope_data_or_queue() {
        for released_version in ["1.0.63", "1.0.65"] {
            let path = std::env::temp_dir().join(format!(
                "froozerp-{released_version}-upgrade-{}-{}.sqlite3",
                std::process::id(),
                unique_local_id("test")
            ));
            let _ = fs::remove_file(&path);
            let mut conn = Connection::open(&path).expect("open released profile");
            conn.execute_batch(
                "CREATE TABLE local_schema_migrations (
                    version TEXT PRIMARY KEY,
                    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                    checksum TEXT NOT NULL,
                    status TEXT NOT NULL
                );",
            )
            .expect("create released migration table");
            for (version, sql) in [
                ("001_local_foundation", MIGRATION_001),
                ("002_sync_engine_foundation", MIGRATION_002),
                ("003_local_first_pos", MIGRATION_003),
                ("004_offline_sale_edit_cancel", MIGRATION_004),
                ("005_mandi_tax_sale_details", MIGRATION_005),
                ("006_multibranch_identity_foundation", MIGRATION_006),
                ("007_cloud_runtime_and_inbox_foundation", MIGRATION_007),
                ("009_canonical_utc_timestamps", MIGRATION_009),
                ("010_sync_delivery_state", MIGRATION_010),
                ("011_connectivity_mode_audit", MIGRATION_011),
                ("012_connectivity_mode_server_time", MIGRATION_012),
            ] {
                apply_migration(&mut conn, version, sql).expect("apply released migration");
            }
            let device_id = format!("FZDEV-UPGRADE-{released_version}");
            conn.execute(
                "INSERT INTO local_device_identity
                   (device_id,device_name,platform,app_version,branch_id,registration_status,company_id,user_id,role)
                 VALUES (?1,'Upgrade Device','windows',?2,'1','APPROVED','1','1','OWNER')",
                params![device_id, released_version],
            )
            .expect("insert released device identity");
            conn.execute(
                "INSERT INTO local_device_identity
                   (device_id,device_name,platform,app_version,branch_id,registration_status)
                 VALUES ('legacy-pending-device','Legacy Pending','windows',?1,'unassigned','pending')",
                [released_version],
            )
            .expect("insert released provisional identity");
            conn.execute(
                "INSERT INTO local_products (id,branch_id,device_id,product_name,unit,sync_status)
                 VALUES ('upgrade-product','1',?1,'Preserved Product','KG','synced')",
                [&device_id],
            )
            .expect("insert released product");
            conn.execute(
                "INSERT INTO local_inventory_lots
                   (id,branch_id,device_id,product_id,product_name,balance_qty,cost_rate,status,sync_status)
                 VALUES ('upgrade-lot','1',?1,'upgrade-product','Preserved Product',7.5,20,'ACTIVE','synced')",
                [&device_id],
            )
            .expect("insert released lot");
            conn.execute(
                "INSERT INTO sync_runtime_config
                   (id,company_id,branch_id,device_id,user_id,role,app_mode,cloud_api_url,sync_status)
                 VALUES (1,'1','1',?1,'1','OWNER','HYBRID','https://example.invalid','IDLE')",
                [&device_id],
            )
            .expect("insert released runtime config");
            conn.execute(
                "INSERT INTO sync_outbox
                   (id,entity_type,entity_id,operation_type,payload,branch_id,device_id,status,
                    operation_id,payload_json,user_id,company_id,idempotency_key,sync_status)
                 VALUES ('upgrade-outbox','sync_test','upgrade-entity','UPSERT','{}','1',?1,'pending',
                    'upgrade-operation','{}','1','1','upgrade-operation','pending')",
                [&device_id],
            )
            .expect("insert released queued operation");
            drop(conn);

            initialize_at(&path).expect("upgrade released profile");
            let selected = ensure_device_identity_with_preference_at(&path, Some("webview-generated-device"))
                .expect("upgrade selects the established approved identity");
            assert_eq!(selected["device_id"], device_id);
            let restarted = ensure_device_identity_with_preference_at(&path, None)
                .expect("restart retains the established approved identity");
            assert_eq!(restarted["device_id"], device_id);
            let conn = Connection::open(&path).expect("inspect upgraded profile");
            let preserved: (i64, i64, f64, i64, String, String, i64, String) = conn
                .query_row(
                    "SELECT
                       (SELECT COUNT(*) FROM local_device_identity WHERE device_id=?1 AND registration_status='APPROVED'),
                       (SELECT COUNT(*) FROM local_products WHERE id='upgrade-product'),
                       (SELECT balance_qty FROM local_inventory_lots WHERE id='upgrade-lot'),
                       (SELECT COUNT(*) FROM sync_outbox WHERE operation_id='upgrade-operation' AND status='pending'),
                       (SELECT device_id FROM sync_runtime_config WHERE id=1),
                       (SELECT app_mode FROM sync_runtime_config WHERE id=1),
                       (SELECT COUNT(*) FROM local_device_identity WHERE device_id='webview-generated-device'),
                       (SELECT device_id FROM sync_outbox WHERE operation_id='upgrade-operation')",
                    [&device_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?)),
                )
                .expect("read preserved released state");
            assert_eq!(preserved, (1, 1, 7.5, 1, device_id.clone(), "HYBRID".to_string(), 0, device_id));
            let migrations: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM local_schema_migrations WHERE status='APPLIED'",
                    [],
                    |row| row.get(0),
                )
                .expect("read upgraded migration count");
            assert_eq!(migrations, 17);
            drop(conn);
            let _ = fs::remove_file(&path);
        }
    }

    #[test]
    fn pulled_pos_sale_is_applied_once_without_double_stock_mutation() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-pulled-sale-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ));
        let _ = fs::remove_file(&path);
        initialize_at(&path).expect("initialize pull test database");
        let change = PulledChange {
            change_id: serde_json::json!(101),
            branch_id: Some(1),
            entity_type: "pos_sale".to_string(),
            entity_id: "remote-sale-1".to_string(),
            operation_type: "UPSERT".to_string(),
            version: Some(1),
            updated_at: Some("2026-07-14T12:00:00.000Z".to_string()),
            payload: serde_json::json!({
                "id": 501,
                "offline_invoice_ref": "REMOTE-OFF-1",
                "branch_id": 1,
                "source_device_id": "device-b",
                "created_by": 1,
                "customer_id": 1,
                "customer_name": "Walk-in Customer",
                "sale_date": "2026-07-14",
                "bill_datetime": "2026-07-14T12:00",
                "payment_mode": "CASH",
                "gross_amount": 50,
                "total_amount": 50,
                "invoice_no": "FZ-REMOTE-1",
                "items": [{
                    "item_global_id": "remote-sale-item-1",
                    "product_id": 10,
                    "product_name": "Remote Test Product",
                    "inventory_batch_id": 20,
                    "quantity": 1,
                    "selling_rate": 50,
                    "net_amount": 50
                }]
            }),
        };
        for _ in 0..2 {
            let mut conn = Connection::open(&path).expect("open pull test database");
            let tx = conn.transaction().expect("start pull transaction");
            apply_change_with_tx(&tx, &change).expect("apply pulled sale");
            tx.commit().expect("commit pulled sale");
        }
        let conn = Connection::open(&path).expect("inspect pull test database");
        let invoice_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_pos_invoices WHERE id = 'remote-sale-1'",
                [],
                |row| row.get(0),
            )
            .expect("remote invoice count");
        let item_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_pos_invoice_items WHERE invoice_id = 'remote-sale-1'",
                [],
                |row| row.get(0),
            )
            .expect("remote item count");
        let movement_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_stock_movements WHERE invoice_id = 'remote-sale-1'",
                [],
                |row| row.get(0),
            )
            .expect("remote stock movement count");
        assert_eq!(invoice_count, 1);
        assert_eq!(item_count, 1);
        assert_eq!(movement_count, 0, "pulled sales must not deduct a separately refreshed stock snapshot");
        drop(conn);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn fresh_initial_pull_applies_inventory_lots_idempotently() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-initial-lot-pull-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ));
        let _ = fs::remove_file(&path);
        initialize_at(&path).expect("initialize initial pull database");
        let product = PulledChange {
            change_id: serde_json::json!(1),
            branch_id: Some(7),
            entity_type: "product".to_string(),
            entity_id: "product-fresh".to_string(),
            operation_type: "UPSERT".to_string(),
            version: Some(1),
            payload: serde_json::json!({
                "branch_id": 7,
                "product_name": "Fresh Product",
                "unit": "KG",
                "selling_rate": 25,
                "active": true
            }),
            updated_at: Some("2026-07-22T12:00:00.000Z".to_string()),
        };
        let lot = PulledChange {
            change_id: serde_json::json!(2),
            branch_id: Some(7),
            entity_type: "inventory_lot".to_string(),
            entity_id: "inventory-lot-fresh".to_string(),
            operation_type: "UPSERT".to_string(),
            version: Some(1),
            payload: serde_json::json!({
                "branch_id": 7,
                "product_global_id": "product-fresh",
                "product_name": "Fresh Product",
                "batch_no": "LOT-FRESH",
                "purchase_qty": 12,
                "remaining_qty": 9,
                "purchase_rate": 10,
                "batch_status": "ACTIVE"
            }),
            updated_at: Some("2026-07-22T12:00:01.000Z".to_string()),
        };
        for _ in 0..2 {
            let mut conn = Connection::open(&path).expect("open initial pull database");
            let tx = conn.transaction().expect("start initial pull transaction");
            apply_change_with_tx(&tx, &product).expect("apply pulled product");
            apply_change_with_tx(&tx, &lot).expect("apply pulled inventory lot");
            tx.commit().expect("commit initial pull");
        }
        let conn = Connection::open(&path).expect("inspect initial pull database");
        let (count, balance): (i64, f64) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(MAX(balance_qty), 0) FROM local_inventory_lots WHERE id = 'inventory-lot-fresh'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("inventory lot result");
        assert_eq!(count, 1);
        assert_eq!(balance, 9.0);
        drop(conn);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn isolated_staging_lifecycle_reaches_disposable_sqlite_exactly_once() {
        let evidence_path = match std::env::var("FROOZERP_ISOLATED_SYNC_EVIDENCE") {
            Ok(value) if !value.trim().is_empty() => value,
            _ => return,
        };
        let evidence: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(&evidence_path).expect("read isolated lifecycle evidence"),
        )
        .expect("parse isolated lifecycle evidence");
        assert_eq!(evidence.get("passed").and_then(|value| value.as_bool()), Some(true));

        for device_label in ["main", "second"] {
            let device_evidence = evidence
                .pointer(&format!("/sync_evidence/{device_label}"))
                .expect("device sync evidence");
            let bootstrap: ReferenceBootstrap = serde_json::from_value(
                device_evidence.get("bootstrap").cloned().expect("bootstrap payload"),
            )
            .expect("deserialize bootstrap payload");
            let changes: Vec<PulledChange> = serde_json::from_value(
                device_evidence
                    .get("incremental_changes")
                    .cloned()
                    .expect("incremental changes"),
            )
            .expect("deserialize incremental changes");
            assert!(!changes.is_empty(), "staging device must receive incremental mutations");

            let path = std::env::temp_dir().join(format!(
                "froozerp-isolated-lifecycle-{device_label}-{}-{}.sqlite3",
                std::process::id(),
                unique_local_id("test")
            ));
            let _ = fs::remove_file(&path);
            initialize_at(&path).expect("initialize disposable lifecycle SQLite");
            apply_reference_bootstrap_at(
                &path,
                &bootstrap,
                &bootstrap.device_id,
                Some("2026-07-27T16:00:00.000Z".to_string()),
            )
            .expect("apply isolated bootstrap");
            let cursor = changes
                .last()
                .map(|change| change.change_id.to_string().trim_matches('"').to_string())
                .unwrap_or_else(|| bootstrap.high_watermark.clone());
            for _ in 0..2 {
                apply_pull_changes_at(
                    &path,
                    &changes,
                    &cursor,
                    Some(bootstrap.device_id.clone()),
                    Some("2026-07-27T16:00:01.000Z".to_string()),
                )
                .expect("apply isolated incremental batch idempotently");
            }

            let expected_lots = bootstrap
                .records
                .iter()
                .chain(changes.iter())
                .filter(|change| {
                    change.entity_type == "inventory_lot"
                        && change.operation_type.to_uppercase() != "DELETE"
                })
                .map(|change| change.entity_id.clone())
                .collect::<std::collections::HashSet<_>>();
            let conn = Connection::open(&path).expect("inspect disposable lifecycle SQLite");
            let lot_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM local_inventory_lots WHERE deleted_at IS NULL",
                    [],
                    |row| row.get(0),
                )
                .expect("count lifecycle lots");
            assert_eq!(lot_count as usize, expected_lots.len());
            let duplicate_lots: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM (
                       SELECT id FROM local_inventory_lots GROUP BY id HAVING COUNT(*) > 1
                     )",
                    [],
                    |row| row.get(0),
                )
                .expect("count duplicate lifecycle lots");
            assert_eq!(duplicate_lots, 0);
            let stored_cursor: String = conn
                .query_row(
                    "SELECT last_pull_cursor FROM sync_state WHERE device_id = ?1",
                    [&bootstrap.device_id],
                    |row| row.get(0),
                )
                .expect("read lifecycle cursor");
            assert_eq!(stored_cursor, cursor);
            drop(conn);
            let _ = fs::remove_file(&path);
        }
    }

    #[test]
    fn online_reference_snapshot_caches_dashboard_sales_idempotently() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-snapshot-sales-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ));
        let _ = fs::remove_file(&path);
        initialize_at(&path).expect("initialize sales snapshot database");
        let snapshot = serde_json::json!({
            "branch_context": { "branch_id": "1", "branch_name": "Main" },
            "device_identity": { "device_id": "device-b", "device_name": "Device B" },
            "products": [],
            "categories": [],
            "inventory_lots": [],
            "customers": [],
            "sales_history": [{
                "id": 700,
                "global_id": "cloud-sale-global-700",
                "invoice_no": "FZ-700",
                "sale_date": "2026-07-14",
                "payment_mode": "CASH",
                "gross_amount": 75,
                "total_amount": 75,
                "customer_name": "Walk-in Customer",
                "created_at": "2026-07-14T13:00:00.000Z"
            }],
            "settings_bundle": {}
        });
        cache_reference_snapshot_at(&path, &snapshot).expect("cache first sales snapshot");
        cache_reference_snapshot_at(&path, &snapshot).expect("cache repeated sales snapshot");
        let conn = Connection::open(&path).expect("inspect sales snapshot database");
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_pos_invoices WHERE id = 'cloud-sale-global-700'",
                [],
                |row| row.get(0),
            )
            .expect("cached sale count");
        let total: f64 = conn
            .query_row(
                "SELECT net_total FROM local_pos_invoices WHERE id = 'cloud-sale-global-700'",
                [],
                |row| row.get(0),
            )
            .expect("cached sale total");
        assert_eq!(count, 1);
        assert_eq!(total, 75.0);
        drop(conn);
        let _ = fs::remove_file(&path);
    }

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

    #[test]
    fn local_pos_sale_persists_invoice_stock_payment_and_outbox() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-phase2-pos-{}.sqlite3",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);

        initialize_at(&path).expect("initialize local db");
        let sale = test_sale_payload("invoice-test-sale-1", "op-test-sale-1", 2.0, 20.0);

        let result = complete_local_pos_sale_at(&path, sale).expect("complete local POS sale");
        assert_eq!(result.pending_operations, 1);
        drop(Connection::open(&path).expect("open and drop sqlite handle"));

        initialize_at(&path).expect("reinitialize local db");
        let conn = Connection::open(&path).expect("open sqlite");
        let invoice_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_pos_invoices WHERE id = 'invoice-test-sale-1'", [], |row| row.get(0))
            .expect("invoice count");
        let item_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_pos_invoice_items WHERE invoice_id = 'invoice-test-sale-1'", [], |row| row.get(0))
            .expect("item count");
        let movement_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_stock_movements WHERE invoice_id = 'invoice-test-sale-1'", [], |row| row.get(0))
            .expect("movement count");
        let payment_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_payment_postings WHERE invoice_id = 'invoice-test-sale-1'", [], |row| row.get(0))
            .expect("payment count");
        let balance_qty: f64 = conn
            .query_row("SELECT balance_qty FROM local_inventory_lots WHERE id = 'lot-test'", [], |row| row.get(0))
            .expect("lot balance");
        let outbox_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_outbox WHERE operation_id = 'op-test-sale-1' AND status = 'pending'", [], |row| row.get(0))
            .expect("outbox count");

        assert_eq!(invoice_count, 1);
        assert_eq!(item_count, 1);
        assert_eq!(movement_count, 1);
        assert_eq!(payment_count, 1);
        assert_eq!(balance_qty, 3.0);
        assert_eq!(outbox_count, 1);

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn local_pos_checkout_rejects_cancelled_or_zero_stock_lots() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-pos-stock-guard-{}.sqlite3",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);
        initialize_at(&path).expect("initialize local db");
        let conn = Connection::open(&path).expect("open sqlite");
        conn.execute(
            "INSERT INTO local_products (id, product_name) VALUES ('product-test', 'Test Product')",
            [],
        ).expect("insert product");
        conn.execute(
            "INSERT INTO local_inventory_lots (id, product_id, balance_qty, status) VALUES ('lot-test', 'product-test', 5, 'CANCELLED')",
            [],
        ).expect("insert cancelled lot");
        drop(conn);

        let cancelled = complete_local_pos_sale_at(
            &path,
            test_sale_payload("invoice-stock-guard-1", "op-stock-guard-1", 1.0, 10.0),
        ).expect_err("cancelled lot must be rejected");
        assert!(cancelled.contains("enough local stock"));

        let conn = Connection::open(&path).expect("reopen sqlite");
        conn.execute("UPDATE local_inventory_lots SET status = 'ACTIVE', balance_qty = 0 WHERE id = 'lot-test'", [])
            .expect("set zero stock");
        drop(conn);
        let exhausted = complete_local_pos_sale_at(
            &path,
            test_sale_payload("invoice-stock-guard-2", "op-stock-guard-2", 1.0, 10.0),
        ).expect_err("zero-stock lot must be rejected");
        assert!(exhausted.contains("enough local stock"));

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn local_pos_sale_edit_restores_stock_rewrites_payment_and_queues_outbox() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-phase3-pos-edit-{}.sqlite3",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);

        initialize_at(&path).expect("initialize local db");
        complete_local_pos_sale_at(&path, test_sale_payload("invoice-test-edit-1", "op-test-edit-create", 2.0, 20.0))
            .expect("complete local POS sale");
        let edit = serde_json::json!({
            "operation_id": "op-test-edit-1",
            "invoice_global_id": "invoice-test-edit-1",
            "branch_id": "1",
            "device_id": "device-test",
            "user_id": "1",
            "reason": "Customer reduced quantity",
            "customer": { "name": "Walk-in Customer", "mobile": "" },
            "bill_date": "2026-06-16",
            "bill_datetime": "2026-06-16T10:00",
            "payment_mode": "CASH",
            "gross_total": 10.0,
            "item_discount_total": 0.0,
            "bill_discount_total": 0.0,
            "tax_total": 0.0,
            "net_total": 10.0,
            "items": [{
                "item_global_id": "line-test-edit-1",
                "product_id": "product-test",
                "product_name": "Test Product",
                "lot_id": "lot-test",
                "lot_name": "Test Lot",
                "lot_size": "Small",
                "quantity": 1.0,
                "unit": "KG",
                "rate": 10.0,
                "discount": 0.0,
                "amount": 10.0
            }],
            "payments": [{
                "posting_id": "posting-test-edit-1",
                "mode": "CASH",
                "amount": 10.0
            }]
        });

        let result = edit_local_pos_sale_at(&path, edit).expect("edit local POS sale");
        assert_eq!(result.pending_operations, 2);
        drop(Connection::open(&path).expect("open and drop sqlite handle"));

        initialize_at(&path).expect("reinitialize local db");
        let conn = Connection::open(&path).expect("open sqlite");
        let status: String = conn
            .query_row("SELECT status FROM local_pos_invoices WHERE id = 'invoice-test-edit-1'", [], |row| row.get(0))
            .expect("invoice status");
        let net_total: f64 = conn
            .query_row("SELECT net_total FROM local_pos_invoices WHERE id = 'invoice-test-edit-1'", [], |row| row.get(0))
            .expect("invoice net");
        let balance_qty: f64 = conn
            .query_row("SELECT balance_qty FROM local_inventory_lots WHERE id = 'lot-test'", [], |row| row.get(0))
            .expect("lot balance");
        let edit_outbox: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_outbox WHERE operation_id = 'op-test-edit-1' AND operation_type = 'SALE_EDIT'", [], |row| row.get(0))
            .expect("edit outbox");
        let audit_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_sale_audit_log WHERE invoice_id = 'invoice-test-edit-1' AND action = 'EDIT'", [], |row| row.get(0))
            .expect("audit count");

        assert_eq!(status, "EDITED");
        assert_eq!(net_total, 10.0);
        assert_eq!(balance_qty, 4.0);
        assert_eq!(edit_outbox, 1);
        assert_eq!(audit_count, 1);

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn local_pos_sale_cancel_restores_stock_reverses_payment_and_queues_outbox() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-phase3-pos-cancel-{}.sqlite3",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);

        initialize_at(&path).expect("initialize local db");
        complete_local_pos_sale_at(&path, test_sale_payload("invoice-test-cancel-1", "op-test-cancel-create", 2.0, 20.0))
            .expect("complete local POS sale");
        let result = cancel_local_pos_sale_at(&path, serde_json::json!({
            "operation_id": "op-test-cancel-1",
            "invoice_global_id": "invoice-test-cancel-1",
            "device_id": "device-test",
            "user_id": "1",
            "reason": "Customer cancelled"
        }))
        .expect("cancel local POS sale");
        assert_eq!(result.pending_operations, 2);
        drop(Connection::open(&path).expect("open and drop sqlite handle"));

        initialize_at(&path).expect("reinitialize local db");
        let conn = Connection::open(&path).expect("open sqlite");
        let status: String = conn
            .query_row("SELECT status FROM local_pos_invoices WHERE id = 'invoice-test-cancel-1'", [], |row| row.get(0))
            .expect("invoice status");
        let balance_qty: f64 = conn
            .query_row("SELECT balance_qty FROM local_inventory_lots WHERE id = 'lot-test'", [], |row| row.get(0))
            .expect("lot balance");
        let cancel_outbox: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_outbox WHERE operation_id = 'op-test-cancel-1' AND operation_type = 'SALE_CANCEL'", [], |row| row.get(0))
            .expect("cancel outbox");
        let reversal_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_payment_postings WHERE invoice_id = 'invoice-test-cancel-1' AND posting_type = 'PAYMENT_REVERSAL'", [], |row| row.get(0))
            .expect("payment reversal count");

        assert_eq!(status, "CANCELLED");
        assert_eq!(balance_qty, 5.0);
        assert_eq!(cancel_outbox, 1);
        assert_eq!(reversal_count, 1);

        let duplicate = cancel_local_pos_sale_at(&path, serde_json::json!({
            "invoice_global_id": "invoice-test-cancel-1",
            "device_id": "device-test",
            "reason": "Duplicate cancel"
        }));
        assert!(duplicate.is_err());

        let _ = fs::remove_file(&path);
    }
}
