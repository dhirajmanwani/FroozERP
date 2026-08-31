use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

use crate::entitlement::{self, EntitlementState};

const CURRENT_SCHEMA_VERSION: &str = "023_customer_order_transfer";
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
const MIGRATION_019: &str = include_str!("../migrations/sqlite/019_provisional_lot_cost_status.sql");
const MIGRATION_020: &str = include_str!("../migrations/sqlite/020_customer_orders.sql");
const MIGRATION_021: &str = include_str!("../migrations/sqlite/021_customer_order_payment.sql");
const MIGRATION_022: &str = include_str!("../migrations/sqlite/022_customer_order_sync.sql");
const MIGRATION_023: &str = include_str!("../migrations/sqlite/023_customer_order_transfer.sql");

#[derive(Debug, Serialize)]
pub struct LocalDbStatus {
    pub initialized: bool,
    pub database_path: String,
    pub schema_version: String,
    pub pending_operations: i64,
    pub failed_operations: i64,
    pub conflict_operations: i64,
    /// Pulled changes this build could not apply and kept rather than dropped. Surfaced because
    /// the alternative is the failure that reports itself as health: sync green, cursor advanced,
    /// records gone.
    pub unapplied_changes: i64,
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

#[derive(Clone, Debug, Deserialize)]
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
            unapplied_changes: 0,
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
    apply_push_acks_at(&database_path(app)?, acks, device_id, server_time)
}

/// The body of `apply_push_acks`, addressed by path.
///
/// Split out for the same reason every other `*_at` in this file is: the `AppHandle` form cannot be
/// driven from a test, and what an acknowledgement does to the local database is exactly the part
/// worth pinning. The seam between the outbox row and the record's own `sync_status` lives here.
pub fn apply_push_acks_at(
    path: &Path,
    acks: &[SyncAck],
    device_id: Option<String>,
    server_time: Option<String>,
) -> Result<LocalDbStatus, String> {
    initialize_at(path)?;
    let mut conn = Connection::open(path).map_err(to_error)?;
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
                // The order's own row, not just its outbox row. Migration 022 gave
                // `local_customer_orders` a `sync_status`, and without this arm it would sit at
                // 'pending' forever after a perfectly successful push - every synced order
                // reporting itself as still waiting, which is a status field lying about the one
                // thing it exists to say.
                //
                // Version-gated on purpose. `entity_version` is bumped by every local status
                // change, and a change made while this push was in flight has already queued its
                // own operation. Marking the row 'synced' on the older acknowledgement would
                // report the newer, genuinely unsent version as delivered. Only the version the
                // server actually acknowledged clears the flag; anything newer stays 'pending'
                // until its own acknowledgement arrives. A NULL `server_entity_version` matches
                // nothing here rather than matching everything.
                tx.execute(
                    "UPDATE local_customer_orders
                     SET sync_status = 'synced',
                         sync_blocked_reason = NULL
                     WHERE id = (SELECT entity_id FROM sync_outbox
                                  WHERE operation_id = ?1 AND entity_type = 'customer_order')
                       AND entity_version = ?2",
                    params![ack.operation_id, ack.server_entity_version],
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
    status_at(path)
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

/// One scope value, read the way the local layer reads every other opaque id.
///
/// The Rust side of `canonicalInventoryId`. `local_inventory_lots.branch_id` is TEXT, the wire
/// value arrives as a Postgres INTEGER, and the applier below stringifies it — so a branch
/// comparison necessarily crosses that boundary, and the only safe way across is to bring both
/// sides to text and compare as text. Never `Number()`, and never numeric equality: `"004"` and
/// `4` are different entities, and treating them as one is what silently emptied the Inventory
/// table while every summary tile went on looking correct.
///
/// An integer-valued float is rendered as an integer because a JSON `4.0` and a JSON `4` are the
/// same branch said two ways, and `"4"` vs `"4.0"` would refuse a legitimate row. `"unassigned"`
/// is the placeholder the applier stamps when the server said nothing, so it is treated as "no
/// scope stated" rather than as the name of a shop.
fn canonical_scope_id(value: Option<&serde_json::Value>) -> Option<String> {
    let text = match value {
        Some(serde_json::Value::String(raw)) => raw.trim().to_string(),
        Some(serde_json::Value::Number(number)) => {
            if let Some(integer) = number.as_i64() {
                integer.to_string()
            } else if let Some(unsigned) = number.as_u64() {
                unsigned.to_string()
            } else if let Some(float) = number.as_f64() {
                if float.is_finite() && float.fract() == 0.0 {
                    format!("{}", float as i64)
                } else {
                    number.to_string()
                }
            } else {
                number.to_string()
            }
        }
        _ => return None,
    };
    if text.is_empty() || text.eq_ignore_ascii_case("unassigned") {
        None
    } else {
        Some(text)
    }
}

/// The shop this device is standing in, as far as the pull path is concerned.
#[derive(Debug, Clone, Default)]
struct DevicePullScope {
    branch_id: Option<String>,
    operational_location_id: Option<String>,
}

impl DevicePullScope {
    /// Why an incoming `inventory_lot` must not be applied here, or `None` if it may be.
    ///
    /// Three rules, and each one is a decision:
    ///
    /// 1. **Only a stated scope can disagree.** A payload that carries no `branch_id` and no
    ///    `operational_location_id` is applied. Absence is not evidence of foreignness — it is an
    ///    older server, or a record written before migration 013 — and refusing it would stop a
    ///    working device from syncing anything at all. The bootstrap path can afford to demand
    ///    scope on every record because it runs once, against a payload built for it; the hot path
    ///    cannot.
    /// 2. **Only a known scope can judge.** A device with no resolved branch — never bootstrapped,
    ///    entitlement missing — refuses nothing. It has no shelf to compare against, and a check
    ///    that cannot be evaluated must not be resolved as "guilty".
    /// 3. **DELETE is exempt.** A delete names a row to remove. If this device does not have it,
    ///    the delete is a no-op; if it does, the row is one that should never have arrived and
    ///    removing it corrects the device rather than damaging it. Refusing foreign deletes would
    ///    strand exactly the rows a fix most needs to clear.
    fn refusal_for_inventory_lot(&self, change: &PulledChange) -> Option<String> {
        if change.operation_type.eq_ignore_ascii_case("DELETE") {
            return None;
        }
        // The applier falls back to the change envelope's `branch_id` when the payload has none and
        // stamps that on the row, so the check has to look at the same value the write would use.
        // Checking only the payload would let an envelope-only foreign branch through the guard and
        // straight onto the shelf.
        let payload_branch = canonical_scope_id(change.payload.get("branch_id"))
            .or_else(|| change.branch_id.map(|value| value.to_string()));
        let payload_location = canonical_scope_id(change.payload.get("operational_location_id"));

        let mut mismatches: Vec<String> = Vec::new();
        if let (Some(device), Some(incoming)) = (self.branch_id.as_deref(), payload_branch.as_deref()) {
            if device != incoming {
                mismatches.push(format!("branch {incoming:?} is not this device's branch {device:?}"));
            }
        }
        if let (Some(device), Some(incoming)) =
            (self.operational_location_id.as_deref(), payload_location.as_deref())
        {
            if device != incoming {
                mismatches.push(format!(
                    "operational location {incoming:?} is not this device's location {device:?}"
                ));
            }
        }
        if mismatches.is_empty() {
            None
        } else {
            Some(mismatches.join("; "))
        }
    }
}

/// What this device is, resolved once per pull.
///
/// Deliberately the *same* answer `canonical_scope` in the reference snapshot shows the operator,
/// because the two must never be able to differ: if the screen says a device belongs to Ratanada
/// then Ratanada is what the pull enforces, and there is no second ladder to keep in step.
///
/// A lookup failure resolves to unscoped rather than to an error. Scope trouble is metadata
/// trouble; a device whose entitlement row is unreadable still has to be able to sync and bill,
/// and `canonical_snapshot_scope_at` already logs the reason.
fn resolve_device_pull_scope(conn: &Connection, device_id: Option<&str>) -> DevicePullScope {
    let named = device_id
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("default"))
        .map(|value| value.to_string());
    // When the caller did not name a device, the assignment table may still say who this is — but
    // only if it says so unambiguously. Picking the first of several active assignments would
    // enforce one shop's scope on another shop's rows, which is the very failure this guards.
    let device = match named {
        Some(value) => Some(value),
        None => {
            let candidates: Result<Vec<String>, _> = conn
                .prepare("SELECT device_id FROM local_device_assignment WHERE active = 1")
                .and_then(|mut statement| {
                    statement
                        .query_map([], |row| row.get::<_, String>(0))
                        .and_then(|rows| rows.collect())
                });
            match candidates {
                Ok(mut rows) if rows.len() == 1 => Some(rows.remove(0)),
                _ => None,
            }
        }
    };
    let Some(device) = device else {
        return DevicePullScope::default();
    };
    let scope = canonical_snapshot_scope_at(conn, &device);
    DevicePullScope {
        branch_id: canonical_scope_id(scope.get("branch_id")),
        operational_location_id: canonical_scope_id(scope.get("operational_location_id")),
    }
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
    // Stock belongs to the shop it is physically sitting in, and a counter may sell only what is on
    // its own shelf (docs/stock-distribution-decision.md). The bootstrap path has always enforced
    // that — it refuses any `inventory_lot` outside the canonical device scope — but this path, the
    // one every subsequent pull takes, applied whatever arrived. So the rule held for exactly as
    // long as a device never pulled again. The check is the same check; it now runs where it
    // matters.
    //
    // **Refused and recorded, not thrown.** A hard `Err` here aborts the whole transaction, which
    // means one foreign lot discards every other change in the page *and* leaves the cursor
    // wedged — the page is offered again, fails again, and sync stops for good on a device whose
    // own data is fine. A foreign lot is a server-side scoping bug, not a corrupt device, and the
    // proportionate answer is to decline the row and say so in a form somebody can count and
    // replay. That is exactly what `local_unapplied_changes` (migration 022) is for: the row is
    // kept whole, the reason is named, the console says it out loud, and the rest of the pull
    // lands. What must never happen — and is what happened before — is "applied silently", or a
    // sync that reports itself healthy while the shelf and the screen disagree.
    //
    // Note that a genuine transfer *out* of this shop is not affected: per the distribution
    // decision it arrives as a change scoped to this branch with a reduced quantity, not as a row
    // wearing the receiving branch's id.
    let device_scope = resolve_device_pull_scope(&tx, device_id.as_deref());
    for change in changes {
        if change.entity_type == "inventory_lot" {
            if let Some(detail) = device_scope.refusal_for_inventory_lot(change) {
                record_unapplied_change(
                    &tx,
                    change,
                    "INVENTORY_LOT_OUTSIDE_DEVICE_SCOPE",
                    Some(detail),
                )?;
                continue;
            }
        }
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
            // `purchase_bill_status` is recorded here even though `cost_rate` above already used it
            // to choose between the expected and the real rate. Using a fact to pick a number and
            // then discarding the fact is precisely how the valuation bug happened on the sync
            // path: the resulting row says a cost with no way to tell whether it is a real one.
            // A lot booked offline against a pending bill is provisional from the moment it exists,
            // and waiting for a round trip to the cloud to learn that would leave every
            // offline-created lot silently valued in the meantime.
            "INSERT INTO local_inventory_lots (
                id, cloud_id, branch_id, device_id, product_id, product_name, supplier_id,
                lot_no, size_grade, opening_date, opening_qty, purchased_qty, balance_qty,
                cost_rate, sale_rate, status, purchase_bill_status, remarks, created_by, version,
                sync_status, company_id, operational_location_id
             ) VALUES (?1,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10,?10,?11,?12,'ACTIVE',?17,?13,?14,1,'pending',?15,?16)
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
                purchase_bill_status.clone(),
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

/// A trimmed string field from a JSON object, or None when absent or blank.
///
/// Blank-as-None is the point: a form posts `""` for every field the operator left alone, and
/// storing those would overwrite a carrier reference with nothing on the next status change. The
/// UPDATE below leans on that by using COALESCE, so "not supplied" and "cleared" stay distinct.
fn order_text(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|field| field.as_str())
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// A branch id read out of JSON as **text**, whatever shape it arrived in.
///
/// `local_customer_orders.branch_id` is INTEGER while every other local table stores branch ids as
/// TEXT, and the wire needs text either way. The old reader was
/// `order.get("branch_id").and_then(|value| value.as_i64())`, which silently dropped the branch
/// whenever the caller sent a string — and `App.jsx` sends `user?.branch_id`, whose shape depends
/// on what the login response happened to contain. A dropped branch is not a cosmetic loss: the
/// server's `logSyncChange` throws on a change with no branch id, and because a push batch is one
/// Postgres transaction that throw discards the acknowledgements for every other operation in it.
///
/// A string is trimmed and kept as a string. It is never parsed: ids in this codebase are opaque,
/// and `"004"` is not `4`.
fn order_branch_text(value: &serde_json::Value, key: &str) -> Option<String> {
    match value.get(key) {
        Some(serde_json::Value::String(raw)) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
        }
        Some(serde_json::Value::Number(number)) => Some(number.to_string()),
        _ => None,
    }
}

/// Said on the order itself when it cannot be queued, so the state has a name instead of being an
/// order that simply never syncs.
const ORDER_BRANCH_UNRESOLVED: &str =
    "This order has no branch, and this device has no approved branch of its own to give it.      It is saved here and is not queued for the cloud, because a branchless change would be      rejected by the server and would take the rest of the batch down with it. The next status      change tries again.";

/// Which branch an order belongs to, decided before it is allowed onto the outbox.
///
/// Three rungs, strongest first, and no default constant at the bottom. Inventing `"1"` for a
/// device that has never been told its branch would file real orders against a branch that is
/// merely the first one — a wrong answer that reports itself as a right one. `None` here is
/// answered by `sync_status = 'blocked'` and a reason the operator can read, not by a guess.
fn resolve_order_branch_id(
    conn: &Connection,
    supplied: Option<String>,
) -> Result<Option<String>, String> {
    // Rung 1 — what the caller said. The order's own branch always wins.
    if supplied.is_some() {
        return Ok(supplied);
    }

    // Rung 2 — this device's approved registration. `ORDER BY device_id` rather than "whichever
    // row comes first": a profile carrying two identities must resolve the same way on every call,
    // or the same order would push under different branches on different days.
    let identity: Option<String> = conn
        .query_row(
            "SELECT branch_id FROM local_device_identity
              WHERE LOWER(registration_status) = 'approved'
                AND branch_id IS NOT NULL
                AND TRIM(branch_id) <> ''
                AND LOWER(branch_id) <> 'unassigned'
              ORDER BY device_id
              LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(to_error)?;
    if identity.is_some() {
        return Ok(identity);
    }

    // Rung 3 — the cached branch context the reference snapshot already trusts for the same
    // question elsewhere in this file.
    let context = single_optional_string(
        conn,
        "SELECT value FROM local_kv WHERE key = 'offline_branch_context'",
        &[],
    )?
    .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
    .and_then(|value| order_branch_text(&value, "branch_id"));
    Ok(context)
}

/// The device this order is being written on, for the outbox row. Best effort: the outbox column is
/// nullable and, unlike the branch, the server does not refuse a change without it.
fn resolve_order_device_id(conn: &Connection) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT device_id FROM local_device_identity
          WHERE LOWER(registration_status) = 'approved'
          ORDER BY device_id
          LIMIT 1",
        [],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(to_error)
}

/// Put this order on the sync road, inside the caller's transaction.
///
/// **Inside the transaction is the whole point.** `enqueue_sync_operation` opens a connection of
/// its own and runs outside any transaction, so a frontend that called "save the order" and then
/// "queue the order" would leave, on any failure between the two, an order with no outbox row —
/// unsynced for ever, and looking exactly like a synced one. The POS sale has always enqueued
/// inside its own transaction (`complete_local_pos_sale_at`); this is the same shape.
///
/// The payload is the **whole order**, header and every line, on creation and on every status
/// change alike, always as `UPSERT`. A distinct operation type per status change would create an
/// ordering dependency, and the server sorts a push batch by `operation_id` string rather than by
/// causality and then permanently records any rejection — so a status change that arrived before
/// its own creation would be rejected once and never retried. Whole-record UPSERT with
/// last-writer-wins on `version` is order-independent and immune to that.
///
/// The operation id is derived from the order and its version, not from the clock. That makes the
/// enqueue idempotent against `ON CONFLICT(operation_id) DO NOTHING`: re-running the same mutation
/// queues the same row once, and a genuinely new mutation carries a new version and so a new id.
fn enqueue_customer_order_with_tx(
    tx: &rusqlite::Transaction,
    order_id: &str,
) -> Result<(), String> {
    let mut payload = read_customer_order(tx, order_id)?;
    let version = payload
        .get("entity_version")
        .and_then(|value| value.as_i64())
        .unwrap_or(1);

    let Some(branch_id) = resolve_order_branch_id(tx, order_branch_text(&payload, "branch_id"))?
    else {
        // Not queued, and said so on the record. Never a NULL branch on the outbox: the server
        // throws on one, and a push batch is a single Postgres transaction, so this one order
        // would discard the acknowledgements for every other operation travelling with it.
        tx.execute(
            "UPDATE local_customer_orders
                SET sync_status = 'blocked', sync_blocked_reason = ?2
              WHERE id = ?1",
            rusqlite::params![order_id, ORDER_BRANCH_UNRESOLVED],
        )
        .map_err(to_error)?;
        return Ok(());
    };

    let device_id = resolve_order_device_id(tx)?;
    // The conversion happens here, at the sync boundary, rather than by rebuilding the table: the
    // column is INTEGER only on this one table, nothing joins it against another table's branch,
    // and a SQLite column-type change means copying every row.
    payload["branch_id"] = serde_json::Value::String(branch_id.clone());
    payload["entity_version"] = serde_json::Value::from(version);
    if let Some(device) = &device_id {
        payload["device_id"] = serde_json::Value::String(device.clone());
    }

    let operation_id = format!("order-{order_id}-v{version}");
    let operation = SyncOperation {
        id: operation_id.clone(),
        operation_id: Some(operation_id),
        entity_type: "customer_order".to_string(),
        entity_id: order_id.to_string(),
        operation_type: "UPSERT".to_string(),
        payload,
        branch_id: Some(branch_id),
        device_id,
        user_id: None,
        version: Some(version),
        created_at: None,
    };
    enqueue_sync_operation_with_conn(tx, &operation)?;

    tx.execute(
        "UPDATE local_customer_orders
            SET sync_status = 'pending', sync_blocked_reason = NULL
          WHERE id = ?1",
        rusqlite::params![order_id],
    )
    .map_err(to_error)?;
    Ok(())
}

/// Customer orders held on this device.
///
/// The workflow rules — which status may follow which, and when a reservation lapses — live in
/// `frontend/src/local/orderLifecycle.js`, where they are tested. This layer is deliberately a
/// faithful store rather than a second copy of them: two implementations of a state machine drift,
/// and the one nobody is looking at wins.
///
/// It enforces exactly one rule of its own, and only because money is involved: **an order that has
/// been billed cannot walk backwards.** `sale_id` is set when the order is sent and an invoice is
/// raised; after that, returning it to RECEIVED or PACKED or CANCELLED would leave a bill attached
/// to an order the shop believes it still has in stock. Undoing a sent order is a sale return, and
/// that is a separate recorded event with its own money.
pub fn save_customer_order(app: &AppHandle, order: &serde_json::Value) -> Result<serde_json::Value, String> {
    save_customer_order_at(&database_path(app)?, order)
}

/// The path-taking core. Split out for the same reason as `initialize_at`: a test cannot build an
/// `AppHandle`, and a storage rule that is only exercised through the running app is a rule nobody
/// checks until it has already gone wrong in front of a customer.
pub fn save_customer_order_at(
    path: &Path,
    order: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    initialize_at(path)?;
    let mut conn = Connection::open(path).map_err(to_error)?;

    let order_id = order_text(order, "id").unwrap_or_else(|| unique_local_id("order"));
    let order_no = order_text(order, "order_no")
        .ok_or_else(|| "An order number is required.".to_string())?;
    let customer_name = order_text(order, "customer_name")
        .ok_or_else(|| "A customer name is required, even for a first-time caller.".to_string())?;

    let items = order
        .get("items")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "An order needs at least one line.".to_string())?;
    if items.is_empty() {
        return Err("An order needs at least one line.".to_string());
    }

    // One transaction for the order and every line. A half-written order is worse than none: it
    // would hold a reservation against lines that were never recorded, so the stock would be
    // missing from the counter with nothing on screen explaining where it went.
    let tx = conn.transaction().map_err(to_error)?;

    // Decided before the row is written, not at push time. An order has to belong to a branch for
    // the cloud to accept it at all, and the honest place to record that is on the order.
    let branch_id = resolve_order_branch_id(&tx, order_branch_text(order, "branch_id"))?;

    tx.execute(
        "INSERT INTO local_customer_orders (
           id, order_no, source, customer_id, customer_name, customer_mobile, delivery_address,
           status, reserved_at, notes, branch_id, created_by, taken_at_branch_id
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'RECEIVED',
                   -- COALESCE, not the column DEFAULT: `reserved_at` has none. An earlier draft
                   -- assumed it did and passed NULL, which produced accepted orders carrying no
                   -- reservation time at all. Those never lapse — `reservationState` fails towards
                   -- holding stock when it has no timestamp to measure from — so a forgotten order
                   -- would have held its fruit for ever, which is the exact failure the lapse exists
                   -- to prevent. Caught by a test, not by reading.
                   COALESCE(?8, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                   ?9, ?10, ?11, ?12)",
        rusqlite::params![
            order_id,
            order_no,
            order_text(order, "source").unwrap_or_else(|| "PHONE".to_string()),
            order_text(order, "customer_id"),
            customer_name,
            order_text(order, "customer_mobile"),
            order_text(order, "delivery_address"),
            // Reserved from the moment it is accepted; the lapse is measured from here. When the
            // caller does not supply one, SQLite's own strftime fills it in above, so every clock
            // in this file is SQLite's and there is no second date format to keep in step.
            order_text(order, "reserved_at"),
            order_text(order, "notes"),
            // Text, not `as_i64()`. The old reader dropped any branch the caller sent as a string,
            // and App.jsx sends `user?.branch_id` whose shape is whatever the login response held.
            // SQLite's INTEGER affinity still stores a numeric branch as an integer, so nothing
            // that reads this column sees a change; a non-numeric branch is now kept instead of
            // silently becoming NULL.
            branch_id,
            order_text(order, "created_by"),
            // Provenance and fulfilment are the same branch here, and that is not an assumption:
            // the device taking this order is the device that will pack it. They only diverge
            // later, when somebody transfers the order, and a transfer changes `branch_id` alone.
            // Written from the resolved value rather than from the raw payload so that a device
            // that supplied no branch of its own records the same answer in both columns — or NULL
            // in both, when the branch could not be resolved at all and the order is blocked.
            branch_id,
        ],
    )
    .map_err(to_error)?;

    for (index, item) in items.iter().enumerate() {
        let product_id = order_text(item, "product_id")
            .ok_or_else(|| "Every order line needs a product.".to_string())?;
        let quantity = item
            .get("quantity")
            .and_then(|value| value.as_f64())
            .ok_or_else(|| "Every order line needs a quantity.".to_string())?;
        if !(quantity > 0.0) {
            return Err("An order line must have a quantity greater than zero.".to_string());
        }
        tx.execute(
            "INSERT INTO local_customer_order_items (
               id, order_id, line_index, product_id, product_name, unit, quantity, agreed_rate
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                // Derived from the order and the line's position, not from the clock.
                // `unique_local_id` is a pure function of the current millisecond, and these are
                // inserted in a tight loop — every line of a multi-line order got the identical
                // PRIMARY KEY, the second INSERT failed, and the transaction rejected the whole
                // order. Order id plus index is unique by construction and stable across a retry.
                order_text(item, "id").unwrap_or_else(|| format!("{order_id}-line-{index}")),
                order_id,
                index as i64,
                product_id,
                order_text(item, "product_name").unwrap_or_else(|| "Unnamed product".to_string()),
                order_text(item, "unit"),
                quantity,
                item.get("agreed_rate").and_then(|value| value.as_f64()),
            ],
        )
        .map_err(to_error)?;
    }

    // The outbox row goes in here, inside the same transaction as the order and its lines, before
    // the commit. An order that exists with nothing queued behind it is an order that never leaves
    // this device and never says so.
    enqueue_customer_order_with_tx(&tx, &order_id)?;

    tx.commit().map_err(to_error)?;
    read_customer_order(&conn, &order_id)
}

/// Move an order along, and record whatever that step produced.
///
/// `patch` carries the fields the step generates — the carrier and tracking link on SENT, the sale
/// and invoice raised with it, a reason on CANCELLED. They are written in the same statement as the
/// status so an order can never be SENT with no record of who is carrying it.
pub fn set_customer_order_status(
    app: &AppHandle,
    order_id: &str,
    next_status: &str,
    patch: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    set_customer_order_status_at(&database_path(app)?, order_id, next_status, patch)
}

pub fn set_customer_order_status_at(
    path: &Path,
    order_id: &str,
    next_status: &str,
    patch: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    initialize_at(path)?;
    let mut conn = Connection::open(path).map_err(to_error)?;

    let current: (String, Option<String>) = conn
        .query_row(
            "SELECT status, sale_id FROM local_customer_orders WHERE id = ?1 AND deleted_at IS NULL",
            rusqlite::params![order_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "That order could not be found.".to_string())?;

    // The one rule this layer owns. Everything else about which move follows which is decided in
    // orderLifecycle.js; this is here because it is the one whose failure leaves a bill attached to
    // stock the shop thinks it still has.
    let already_billed = current.1.as_deref().map(|id| !id.trim().is_empty()).unwrap_or(false);
    let walking_back = matches!(next_status, "RECEIVED" | "PACKED" | "CANCELLED");
    if already_billed && walking_back {
        return Err(
            "This order has already been billed. To undo it, record a sale return.".to_string(),
        );
    }

    let stamp_column = match next_status {
        "PACKED" => Some("packed_at"),
        "SENT" => Some("sent_at"),
        "DELIVERED" => Some("delivered_at"),
        "CANCELLED" => Some("cancelled_at"),
        _ => None,
    };
    // Every timestamp below is written by SQLite's own strftime, in the same shape as the column
    // DEFAULTs in migration 020. Formatting dates in Rust as well would mean two clocks and two
    // formats to keep in step, and the one nobody looks at drifts.
    let restart_reservation = next_status == "RECEIVED";

    // A transaction, where there used to be a bare statement. The status change, the version bump
    // and the outbox row have to land together or not at all: a status change that committed
    // without its outbox row would be a move the rest of the business never hears about, and it
    // would look identical to one that had synced.
    let tx = conn.transaction().map_err(to_error)?;

    let changed = tx.execute(
        "UPDATE local_customer_orders SET
           status = ?2,
           -- Returning an order to RECEIVED restarts its reservation clock. Without this, a lapsed
           -- order put back in the queue would still read as expired and would be flagged for
           -- attention for ever, however recently someone looked at it.
           reserved_at = CASE WHEN ?3 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE reserved_at END,
           packed_at = CASE WHEN ?4 = 'packed_at' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE packed_at END,
           sent_at = CASE WHEN ?4 = 'sent_at' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE sent_at END,
           delivered_at = CASE WHEN ?4 = 'delivered_at' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE delivered_at END,
           cancelled_at = CASE WHEN ?4 = 'cancelled_at' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE cancelled_at END,
           cancellation_reason = COALESCE(?5, cancellation_reason),
           carrier = COALESCE(?6, carrier),
           carrier_reference = COALESCE(?7, carrier_reference),
           tracking_url = COALESCE(?8, tracking_url),
           carrier_contact = COALESCE(?9, carrier_contact),
           sale_id = COALESCE(?10, sale_id),
           invoice_no = COALESCE(?11, invoice_no),
           -- Every local mutation moves the version on. This is the number the whole sync contract
           -- rests on: the pull path refuses an incoming copy older than the one already here, so
           -- a status change can never be undone by a stale copy of the same order arriving late
           -- from another device.
           entity_version = entity_version + 1,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1 AND deleted_at IS NULL",
        rusqlite::params![
            order_id,
            next_status,
            restart_reservation,
            stamp_column.unwrap_or(""),
            order_text(patch, "cancellation_reason"),
            order_text(patch, "carrier"),
            order_text(patch, "carrier_reference"),
            order_text(patch, "tracking_url"),
            order_text(patch, "carrier_contact"),
            order_text(patch, "sale_id"),
            order_text(patch, "invoice_no"),
        ],
    )
    .map_err(to_error)?;
    if changed == 0 {
        // The order was found a moment ago and is gone now. Named, not swallowed: a status change
        // that quietly updates nothing and then reports the order back unchanged is the failure
        // that reads as success.
        return Err("That order changed underneath this update and was not moved.".to_string());
    }

    enqueue_customer_order_with_tx(&tx, order_id)?;
    tx.commit().map_err(to_error)?;
    read_customer_order(&conn, order_id)
}

/// Every order this device knows about, newest first, with its lines attached.
///
/// Deleted orders are excluded; finished ones are not. A board that hid delivered orders would make
/// "did that go out?" unanswerable the day after it went out.
pub fn list_customer_orders(app: &AppHandle) -> Result<serde_json::Value, String> {
    list_customer_orders_at(&database_path(app)?)
}

pub fn list_customer_orders_at(path: &Path) -> Result<serde_json::Value, String> {
    initialize_at(path)?;
    let conn = Connection::open(path).map_err(to_error)?;
    let mut statement = conn
        .prepare(
            "SELECT id FROM local_customer_orders
             WHERE deleted_at IS NULL
             ORDER BY created_at DESC, id DESC",
        )
        .map_err(to_error)?;
    let ids: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(to_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_error)?;
    let mut orders = Vec::with_capacity(ids.len());
    for id in ids {
        orders.push(read_customer_order(&conn, &id)?);
    }
    Ok(serde_json::json!({ "orders": orders }))
}

fn read_customer_order(conn: &Connection, order_id: &str) -> Result<serde_json::Value, String> {
    let mut order: serde_json::Value = conn
        .query_row(
            "SELECT id, order_no, source, customer_id, customer_name, customer_mobile,
                    delivery_address, status, reserved_at, packed_at, sent_at, delivered_at,
                    cancelled_at, cancellation_reason, carrier, carrier_reference, tracking_url,
                    carrier_contact, sale_id, invoice_no, notes, branch_id, created_by, created_at,
                    payment_state, amount_paid, payment_reference, payment_marked_at,
                    entity_version, sync_status, sync_blocked_reason, updated_at,
                    taken_at_branch_id, transferred_to_branch_id, transferred_away_at
             FROM local_customer_orders WHERE id = ?1",
            rusqlite::params![order_id],
            |row| {
                // Read as a raw value rather than as `Option<i64>`. The column is INTEGER, but a
                // branch id is an opaque string everywhere else in this codebase and a copy pulled
                // from the cloud can legitimately carry a non-numeric one. `Option<i64>` on such a
                // row fails the whole read, and because `list_customer_orders_at` reads every order
                // in a loop, one such row would empty the entire Orders board. A numeric branch
                // still comes back as a number, exactly as before.
                let branch_id = match row.get::<_, rusqlite::types::Value>(21)? {
                    rusqlite::types::Value::Null => serde_json::Value::Null,
                    rusqlite::types::Value::Integer(value) => serde_json::Value::from(value),
                    rusqlite::types::Value::Real(value) => serde_json::Value::from(value),
                    rusqlite::types::Value::Text(value) => serde_json::Value::String(value),
                    rusqlite::types::Value::Blob(_) => serde_json::Value::Null,
                };
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "order_no": row.get::<_, String>(1)?,
                    "source": row.get::<_, String>(2)?,
                    "customer_id": row.get::<_, Option<String>>(3)?,
                    "customer_name": row.get::<_, String>(4)?,
                    "customer_mobile": row.get::<_, Option<String>>(5)?,
                    "delivery_address": row.get::<_, Option<String>>(6)?,
                    "status": row.get::<_, String>(7)?,
                    "reserved_at": row.get::<_, Option<String>>(8)?,
                    "packed_at": row.get::<_, Option<String>>(9)?,
                    "sent_at": row.get::<_, Option<String>>(10)?,
                    "delivered_at": row.get::<_, Option<String>>(11)?,
                    "cancelled_at": row.get::<_, Option<String>>(12)?,
                    "cancellation_reason": row.get::<_, Option<String>>(13)?,
                    "carrier": row.get::<_, Option<String>>(14)?,
                    "carrier_reference": row.get::<_, Option<String>>(15)?,
                    "tracking_url": row.get::<_, Option<String>>(16)?,
                    "carrier_contact": row.get::<_, Option<String>>(17)?,
                    "sale_id": row.get::<_, Option<String>>(18)?,
                    "invoice_no": row.get::<_, Option<String>>(19)?,
                    "notes": row.get::<_, Option<String>>(20)?,
                    "branch_id": branch_id,
                    "created_by": row.get::<_, Option<String>>(22)?,
                    "created_at": row.get::<_, String>(23)?,
                    "payment_state": row.get::<_, Option<String>>(24)?,
                    "amount_paid": row.get::<_, Option<f64>>(25)?,
                    "payment_reference": row.get::<_, Option<String>>(26)?,
                    "payment_marked_at": row.get::<_, Option<String>>(27)?,
                    // The sync half of the record. `sync_status` is deliberately part of what the
                    // board reads: 'blocked' is an error state with a sentence attached, and an
                    // order that is never going to reach the cloud must not look like one that has.
                    "entity_version": row.get::<_, i64>(28)?,
                    "sync_status": row.get::<_, String>(29)?,
                    "sync_blocked_reason": row.get::<_, Option<String>>(30)?,
                    "updated_at": row.get::<_, Option<String>>(31)?,
                    // The routing half of the record. `branch_id` above is the branch *fulfilling*
                    // the order; this is the branch that *took* it, and they differ from the moment
                    // anybody moves an order. Read as Option<String> rather than as a raw value
                    // because, unlike `branch_id`, this column is TEXT — there is no INTEGER
                    // affinity to trip over.
                    "taken_at_branch_id": row.get::<_, Option<String>>(32)?,
                    // Both NULL on an ordinary order. Set together on the losing device when a
                    // TRANSFER_OUT arrives, so an order that left is distinguishable from one that
                    // was cancelled and from one that simply vanished.
                    "transferred_to_branch_id": row.get::<_, Option<String>>(33)?,
                    "transferred_away_at": row.get::<_, Option<String>>(34)?,
                }))
            },
        )
        // "Not found" only when there genuinely is no such row. Every other failure — a column
        // added to the SELECT and not to the closure, a schema older than this build — used to be
        // reported as a missing order, which sends the reader looking for a deleted record instead
        // of at the query. Same rule as errors never rendering as zero.
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => "That order could not be found.".to_string(),
            other => format!("That order could not be read: {other}"),
        })?;

    let mut statement = conn
        .prepare(
            "SELECT id, line_index, product_id, product_name, unit, quantity, agreed_rate,
                    inventory_lot_id
             FROM local_customer_order_items WHERE order_id = ?1 ORDER BY line_index",
        )
        .map_err(to_error)?;
    let items: Vec<serde_json::Value> = statement
        .query_map(rusqlite::params![order_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "line_index": row.get::<_, i64>(1)?,
                // Read back as text and never parsed. "004" is not 4.
                "product_id": row.get::<_, String>(2)?,
                "product_name": row.get::<_, String>(3)?,
                "unit": row.get::<_, Option<String>>(4)?,
                "quantity": row.get::<_, f64>(5)?,
                "agreed_rate": row.get::<_, Option<f64>>(6)?,
                "inventory_lot_id": row.get::<_, Option<String>>(7)?,
            }))
        })
        .map_err(to_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_error)?;
    order["items"] = serde_json::Value::Array(items);
    Ok(order)
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
    apply_migration(&mut conn, "019_provisional_lot_cost_status", MIGRATION_019)?;
    apply_migration(&mut conn, "020_customer_orders", MIGRATION_020)?;
    apply_migration(&mut conn, "021_customer_order_payment", MIGRATION_021)?;
    apply_migration(&mut conn, "022_customer_order_sync", MIGRATION_022)?;
    apply_migration(&mut conn, "023_customer_order_transfer", MIGRATION_023)?;
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
        unapplied_changes: conn
            .query_row("SELECT COUNT(*) FROM local_unapplied_changes", [], |row| row.get(0))
            .optional()
            .map_err(to_error)?
            .unwrap_or(0),
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
    // §6.3 / §12: a snapshot that OMITS `registration_status` must yield the device's EXISTING
    // status, never an upgrade to approved. The old default asserted approval on the strength of a
    // field being absent, which is the weakest possible evidence — and because the desktop builds
    // its own snapshot, it was effectively a device approving itself. A device with no row yet is
    // `pending`; only a verified entitlement (or the cloud) may promote it.
    let existing_registration_status: Option<String> = tx
        .query_row(
            "SELECT registration_status FROM local_device_identity WHERE device_id = ?1",
            params![device_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(to_error)?
        .flatten();
    let registration_status = optional_text(&device_identity, "registration_status")
        .or(existing_registration_status)
        .unwrap_or_else(|| "pending".to_string());

    let user_profile = snapshot.get("user_profile").cloned().unwrap_or_else(|| serde_json::json!({}));
    let company_id = optional_text(&user_profile, "company_id")
        .or_else(|| optional_text(&device_identity, "company_id"));

    // A live VERIFIED entitlement outranks the snapshot for scope (§6.4 rung 1). Without this the
    // promotion in `accept_entitlement_at` would be cosmetic: `branch_id` is overwritten
    // unconditionally below (`branch_id = excluded.branch_id`, no COALESCE) and the snapshot's
    // value is client-supplied — `App.jsx` falls back to "1" when it knows nothing. A device could
    // otherwise redeem a code scoped to branch 7 and have the very next cache quietly move it to
    // branch 1. Scope that arrived under a signature is not up for revision by an unsigned snapshot.
    let signed_scope: Option<(String, String)> = tx
        .query_row(
            "SELECT company_id, branch_id FROM local_entitlement
              WHERE device_id = ?1 AND verification_state = 'VERIFIED'
                AND superseded_at IS NULL AND revoked_at IS NULL
              ORDER BY issued_at DESC LIMIT 1",
            params![device_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(to_error)?;
    let (company_id, branch_id) = match signed_scope {
        Some((signed_company, signed_branch)) => (Some(signed_company), signed_branch),
        None => (company_id, branch_id),
    };
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

/// Resolve a device's company/branch/operational-location scope from local data alone, in
/// decreasing order of authority, and NEVER fail the snapshot build over it (§6.4, D-6).
///
/// - **Rung 1 — an active `VERIFIED` entitlement.** Supplies `company_id`/`branch_id`. A verified
///   entitlement is a signature over this device's own binding, checked once at acceptance time;
///   the stored columns are trusted from that point on without re-verifying on every read — the
///   same trust boundary `active_entitlement_at` already uses.
/// - **Rung 2 — an active `local_device_assignment` row.** Adds `operational_location_id`. If
///   rung 1 did not fire, this rung's own `company_id`/`branch_id` are used as a weaker fallback,
///   since a real sync-delivered assignment is still meaningful evidence — just not as strong as a
///   signature.
/// - **Rung 3 — an approved `local_device_identity`.** `branch_id` only, exactly as §6.4 states;
///   company scope is deliberately never read from here.
/// - **Rung 4 — unscoped.** `branch_id`/`company_id` come back `null` and the caller's existing
///   `branch_context` default stands unnarrowed. Not a failure path: a device with a corrupt or
///   absent entitlement row must still load its own stock and bill (§2.5).
///
/// **`DEVICE_SCOPE_CONFLICT` / `DEVICE_SCOPE_MISMATCH`.** Design §6.4 names these as the two
/// warnings that must fall through rather than abort, but does not define what distinguishes
/// them. Resolved here, and flagged as a decision this stage owns rather than one already ruled:
/// `CONFLICT` is rung 1 and rung 2 both resolving and disagreeing on `company_id`/`branch_id` —
/// two comparably authoritative sources contradicting each other. `MISMATCH` is rung 3's
/// `branch_id` disagreeing with a `branch_id` already resolved by rung 1 or 2 — a weaker,
/// possibly-stale source disagreeing with something already trusted more. Neither ever changes
/// which value wins; the higher rung always wins. Both are returned as data for a caller to
/// surface, never thrown.
fn canonical_snapshot_scope_at(conn: &Connection, device_id: &str) -> serde_json::Value {
    match canonical_snapshot_scope_try(conn, device_id) {
        Ok(scope) => scope,
        Err(error) => {
            // A lookup failure is metadata trouble, not a reason to refuse the snapshot — the same
            // "fail into the running state" reasoning `grandfather_existing_device`'s call site
            // already uses. Logged so it is not silently invisible, never propagated.
            eprintln!("canonical snapshot scope resolution skipped: {error}");
            serde_json::json!({
                "company_id": null,
                "branch_id": null,
                "operational_location_id": null,
                "source": "unscoped",
                "warnings": [{"code": "DEVICE_SCOPE_LOOKUP_FAILED", "detail": error}],
            })
        }
    }
}

fn canonical_snapshot_scope_try(conn: &Connection, device_id: &str) -> Result<serde_json::Value, String> {
    let entitlement_scope: Option<(String, String)> = conn
        .query_row(
            "SELECT company_id, branch_id FROM local_entitlement
              WHERE device_id = ?1 AND superseded_at IS NULL AND revoked_at IS NULL
                AND verification_state = 'VERIFIED'
              ORDER BY issued_at DESC LIMIT 1",
            params![device_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(to_error)?;

    let assignment_scope: Option<(String, String, String)> = conn
        .query_row(
            "SELECT company_id, branch_id, operational_location_id FROM local_device_assignment
              WHERE device_id = ?1 AND active = 1",
            params![device_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
        )
        .optional()
        .map_err(to_error)?;

    let identity_branch: Option<String> = conn
        .query_row(
            "SELECT branch_id FROM local_device_identity
              WHERE device_id = ?1 AND LOWER(registration_status) = 'approved'",
            params![device_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(to_error)?
        .filter(|value| !value.eq_ignore_ascii_case("unassigned"));

    let mut warnings: Vec<serde_json::Value> = Vec::new();
    let mut company_id: Option<String> = None;
    let mut branch_id: Option<String> = None;
    let mut operational_location_id: Option<String> = None;
    let mut source = "unscoped";

    if let Some((company, branch)) = &entitlement_scope {
        company_id = Some(company.clone());
        branch_id = Some(branch.clone());
        source = "entitlement";
    }

    if let Some((assign_company, assign_branch, location)) = &assignment_scope {
        if company_id.is_some() {
            if company_id.as_deref() != Some(assign_company.as_str())
                || branch_id.as_deref() != Some(assign_branch.as_str())
            {
                warnings.push(serde_json::json!({
                    "code": "DEVICE_SCOPE_CONFLICT",
                    "detail": "local_device_assignment disagrees with the active entitlement; the entitlement's scope was kept.",
                }));
            }
        } else {
            company_id = Some(assign_company.clone());
            branch_id = Some(assign_branch.clone());
            source = "device_assignment";
        }
        operational_location_id = Some(location.clone());
    }

    if let Some(identity_branch_value) = &identity_branch {
        match &branch_id {
            Some(existing) if existing != identity_branch_value => {
                warnings.push(serde_json::json!({
                    "code": "DEVICE_SCOPE_MISMATCH",
                    "detail": "local_device_identity's branch differs from the resolved scope; the more authoritative source was kept.",
                }));
            }
            Some(_) => {}
            None => {
                branch_id = Some(identity_branch_value.clone());
                source = "device_identity";
            }
        }
    }

    if branch_id.is_none() {
        source = "unscoped";
    }

    // The name a person can read, beside the ids only the machine cares about.
    //
    // The maintainer runs more than one device in a branch -- a warehouse machine and a counter
    // machine can sit under one roof, and two tills can stand side by side. Ids cannot tell those
    // apart on screen, and a device quietly set up as the wrong counter is a mistake that surfaces
    // days later as stock that does not add up. `local_operational_locations` already holds the
    // name; it has simply never been carried up to where anybody could see it.
    //
    // A missing row is left as null rather than filled with the id: "Counter 40" reads like a name
    // and is not one, and a person shown it would believe the device was configured when it was not.
    let location_name: Option<String> = match &operational_location_id {
        Some(id) => conn
            .query_row(
                "SELECT location_name FROM local_operational_locations WHERE id = ?1",
                params![id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(to_error)?
            .flatten()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        None => None,
    };

    Ok(serde_json::json!({
        "company_id": company_id,
        "branch_id": branch_id,
        "operational_location_id": operational_location_id,
        "location_name": location_name,
        "source": source,
        "warnings": warnings,
    }))
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
                    // Every location's stock added together, because the join below is on
                    // `product_id` alone. That is correct for an owner looking at the company and
                    // wrong for a cashier looking at a shelf, and nothing in the name says which.
                    // A counter's own figure must come from `product_stock_by_scope` (or be summed
                    // from `inventory_lots`, which now carries scope) — never from here.
                    "current_stock": row.get::<_, f64>(12)?,
                    "lot_count": row.get::<_, i64>(13)?,
                }))
            })
            .map_err(to_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(to_error)?
    };

    // The same aggregate as `products`, split by the place the fruit is sitting in.
    //
    // This exists because `products.current_stock` cannot be made scope-aware without either
    // filtering the snapshot (which decides for a caller that never asked) or emitting several rows
    // per product (which every existing reader of `products` would mis-count). So the scoped answer
    // is a second projection of the *same rows* rather than a change to the first.
    //
    // The predicate is a character-for-character copy of the one in `products` — same
    // `deleted_at IS NULL`, same CANCELLED exclusion — and that is load-bearing, not tidiness. A
    // summary and a detail that filter differently disagree eventually, and the disagreement looks
    // exactly like data loss. `product_aggregate_and_lot_list_agree_about_which_lots_exist` fails
    // if these two predicates are ever edited apart.
    //
    // `inventory_lots` remains the detail of record; this is a convenience over it, so a caller
    // must not mix a tile from here with a table filtered by some other rule.
    let product_stock_by_scope = {
        let mut statement = conn
            .prepare(
                "SELECT l.product_id, l.branch_id, l.company_id, l.operational_location_id,
                        COALESCE(SUM(l.balance_qty), 0) AS current_stock,
                        COUNT(*) AS lot_count
                 FROM local_inventory_lots l
                 WHERE l.deleted_at IS NULL
                   AND UPPER(COALESCE(l.status, 'ACTIVE')) <> 'CANCELLED'
                 GROUP BY l.product_id, l.branch_id, l.company_id, l.operational_location_id
                 ORDER BY l.product_id, l.branch_id, l.operational_location_id",
            )
            .map_err(to_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok(serde_json::json!({
                    "product_id": row.get::<_, String>(0)?,
                    "branch_id": row.get::<_, Option<String>>(1)?,
                    "company_id": row.get::<_, Option<String>>(2)?,
                    "operational_location_id": row.get::<_, Option<String>>(3)?,
                    "current_stock": row.get::<_, f64>(4)?,
                    "lot_count": row.get::<_, i64>(5)?,
                }))
            })
            .map_err(to_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(to_error)?
    };

    let inventory_lots = {
        let mut statement = conn
            .prepare(
                // Scope — `branch_id`, `company_id`, `operational_location_id` — is selected but
                // deliberately NOT filtered on. A lot belongs to one shop
                // (docs/stock-distribution-decision.md), and until this query emitted those three
                // columns the frontend could not filter by shop even if it wanted to: the fields
                // simply were not in the objects it received, so every counter saw every counter's
                // fruit. Emitting them is what makes the choice possible. The choice itself stays
                // in the frontend local layer, where it is testable and where a filter that is
                // active can be made visible to the person looking at it. Filtering here would
                // instead hide rows from a caller that never asked, and would leave the product
                // aggregate below counting a different universe than this list — the exact
                // summary-vs-detail split CLAUDE.md warns about.
                "SELECT id, product_id, product_name, supplier_id, supplier_name, lot_no, size_grade,
                        opening_date, opening_qty, sold_qty, adjusted_qty, balance_qty, cost_rate, sale_rate,
                        status, remarks, created_at, updated_at, purchase_bill_status,
                        branch_id, company_id, operational_location_id
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
                    // Migration 019. Deliberately Option: NULL means this device was never told,
                    // which is a different fact from BILL_COMPLETED and must stay distinguishable
                    // all the way to the screen. Emitting a default here would put the guess back.
                    "purchase_bill_status": row.get::<_, Option<String>>(18)?,
                    "remarks": row.get::<_, Option<String>>(15)?,
                    "created_at": row.get::<_, Option<String>>(16)?,
                    "updated_at": row.get::<_, Option<String>>(17)?,
                    // Where this fruit physically is. Every one of the three is a separate column
                    // on the table and none is an alias of another, unlike the pairs above — do
                    // not "tidy" one away. All three are Option because a lot written before
                    // migration 013, or pulled from a server that does not send scope, genuinely
                    // has none: NULL here means "this device was never told", which is a different
                    // fact from "it belongs to nowhere" and must stay distinguishable on screen.
                    // Emitted as opaque text and never coerced with a number — `"004"` and `4` are
                    // different entities, and comparing them numerically is what silently emptied
                    // the Inventory table once already.
                    "branch_id": row.get::<_, Option<String>>(19)?,
                    "company_id": row.get::<_, Option<String>>(20)?,
                    "operational_location_id": row.get::<_, Option<String>>(21)?,
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
    // §6.4 / Stage 8: additive only. `branch_context` above is untouched — whatever was last
    // cached stands exactly as it did before this field existed. `canonical_scope` is a second,
    // independently-computed opinion a caller may prefer once it starts reading it.
    let canonical_scope = canonical_snapshot_scope_at(&conn, requested_device);

    Ok(serde_json::json!({
        "reference_ready": reference_ready,
        "first_sync_required": !reference_ready,
        "database_path": path_to_string(path),
        "last_successful_sync_at": last_successful_sync_at,
        "device_identity": device_identity,
        "branch_context": branch_context,
        "canonical_scope": canonical_scope,
        "user_profile": user_profile,
        "offline_auth": offline_auth,
        "products": products,
        "product_stock_by_scope": product_stock_by_scope,
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

    // 8. Promote the identity locally (§6.3). This is the change that removes the cloud from the
    //    authorisation path: until now `registration_status` could only move to 'approved' by a
    //    cloud lookup, or by one of the two hardcoded defaults that asserted approval without
    //    evidence. A verified entitlement IS the evidence — it is a signature over this device's
    //    own binding, checked locally against a baked-in trusted key.
    //
    //    `company_id` and `branch_id` come from the signed payload rather than from the caller, so
    //    a device cannot talk itself into another company's scope. The row is only touched when it
    //    already exists; `ensure_device_identity_*` owns creation, and inventing an identity here
    //    would let an activation file conjure a device that never registered.
    let promoted = tx
        .execute(
            "UPDATE local_device_identity
                SET registration_status = 'approved',
                    company_id = ?2,
                    branch_id = ?3,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              WHERE device_id = ?1",
            params![device_id, company_id, branch_id],
        )
        .map_err(to_error)?;
    if promoted > 0 {
        record_entitlement_audit_at(
            &tx,
            Some(&serial),
            "DEVICE_PROMOTED",
            Some("VERIFIED_ENTITLEMENT"),
            &format!("{{\"company_id\":\"{company_id}\",\"branch_id\":\"{branch_id}\"}}"),
            device_id,
        )?;
    }

    tx.commit().map_err(to_error)?;

    Ok(serde_json::json!({
        "accepted": true,
        "entitlement_serial": serial,
        "verification_state": "VERIFIED",
        "source": source,
        "superseded": superseded,
        "bootstrap_present": payload_parsed.carries_credential(),
        "identity_promoted": promoted > 0,
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

fn is_approved_identity(identity: &serde_json::Value) -> bool {
    optional_text(identity, "registration_status")
        .map(|status| status.eq_ignore_ascii_case("approved"))
        .unwrap_or(false)
}

/// Deterministic pick among competing `local_device_identity` rows.
///
/// §2.5 rules "fail into the running state, not out of it", so a profile carrying more than
/// one identity must not stop the app; it must choose one and say so. The order is fixed and
/// documented because the same profile has to resolve to the same device on every restart and
/// on every machine:
///
/// 1. an approved identity beats a non-approved one;
/// 2. then the most recently seen wins — `last_seen_at` DESC, with a NULL/absent
///    `last_seen_at` treated as the oldest possible value so it never outranks a real one;
/// 3. then `device_id` ascending, which breaks every remaining tie (timestamps are ISO-8601
///    UTC, so lexical order is chronological order).
///
/// This is read-only: it selects among existing rows and never creates, deletes or rewrites
/// one.
fn select_identity_under_conflict<'a>(
    candidates: &[&'a serde_json::Value],
) -> Option<&'a serde_json::Value> {
    candidates.iter().copied().min_by_key(|identity| {
        let approved_rank: u8 = if is_approved_identity(identity) { 0 } else { 1 };
        let last_seen = optional_text(identity, "last_seen_at");
        // Reverse() turns the ascending min_by_key into "newest first", and puts None
        // (no last_seen_at) last, i.e. oldest.
        (
            approved_rank,
            std::cmp::Reverse(last_seen),
            optional_text(identity, "device_id").unwrap_or_default(),
        )
    })
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
        .filter(|identity| is_approved_identity(identity))
        .collect::<Vec<_>>();

    // A profile with more than one identity row is a metadata problem, and §2.5 forbids a
    // metadata problem from stopping a shop: real field profiles carry two or three rows
    // (backlog item 5). Both conflict shapes therefore resolve to a deterministic pick and
    // report the conflict as data on the returned identity instead of returning Err, which
    // used to surface as a 503 and a blocked startup. Nothing is written here.
    let conflict = if approved.len() > 1 {
        Some(("MULTIPLE_APPROVED", approved.clone()))
    } else if approved.is_empty() && identities.len() > 1 {
        Some(("MULTIPLE_PROVISIONAL", identities.iter().collect::<Vec<_>>()))
    } else {
        None
    };
    if let Some((kind, candidates)) = conflict {
        if let Some(selected) = select_identity_under_conflict(&candidates) {
            let mut conflicting_device_ids = candidates
                .iter()
                .filter_map(|identity| optional_text(identity, "device_id"))
                .collect::<Vec<_>>();
            conflicting_device_ids.sort();
            let selected_device_id = optional_text(selected, "device_id").unwrap_or_default();
            eprintln!(
                "device identity conflict ({kind}): {} competing identities {:?}, continuing with {selected_device_id}",
                conflicting_device_ids.len(),
                conflicting_device_ids
            );
            if is_approved_identity(selected) {
                // Grandfathering runs for the selected approved identity exactly as it does on
                // the single-approved path below, and stays non-fatal for the same reason.
                if let Err(error) = grandfather_existing_device(&conn, selected) {
                    eprintln!("entitlement grandfathering skipped: {error}");
                }
            }
            let mut identity = selected.clone();
            if let Some(fields) = identity.as_object_mut() {
                fields.insert(
                    "identity_conflict".to_string(),
                    serde_json::Value::Bool(true),
                );
                fields.insert(
                    "identity_conflict_kind".to_string(),
                    serde_json::Value::String(kind.to_string()),
                );
                fields.insert(
                    "identity_conflict_device_ids".to_string(),
                    serde_json::json!(conflicting_device_ids),
                );
                fields.insert(
                    "identity_conflict_selected".to_string(),
                    serde_json::Value::String(selected_device_id),
                );
            }
            return Ok(identity);
        }
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

/// Statuses this build can display. The same six the CHECK constraint in migration 020 allows.
const CUSTOMER_ORDER_STATUSES: [&str; 6] =
    ["RECEIVED", "PACKED", "SENT", "DELIVERED", "CANCELLED", "RETURNED"];
const CUSTOMER_ORDER_SOURCES: [&str; 5] = ["PHONE", "WHATSAPP", "WEBSITE", "COUNTER", "OTHER"];
const CUSTOMER_ORDER_PAYMENT_STATES: [&str; 3] = ["UNPAID", "PAID", "ON_DELIVERY"];

/// Keep a pulled change this build could not apply, instead of dropping it.
///
/// `apply_pull_changes_at` advances the pull cursor in the same transaction that applies the
/// changes, so a change this code declines is never offered again. Before migration 022 the
/// decline was `_ => {}` — no error, no log, no trace — which meant that the day the server began
/// emitting an entity type an older device did not know, every one of those rows was destroyed on
/// that device while sync went on reporting itself healthy.
///
/// Two things are deliberately not done here. It is not an error: a device running older code has
/// to be able to go on syncing everything it does understand, so one unknown type must not fail the
/// page. And it is not a `sync_conflicts` row: that table feeds a conflict count a person is meant
/// to act on, and "this build is older than the server" is not a conflict to resolve. It is written
/// whole, so an upgraded build can read these back and apply them.
fn record_unapplied_change(
    tx: &rusqlite::Transaction,
    change: &PulledChange,
    reason: &str,
    detail: Option<String>,
) -> Result<(), String> {
    let payload = serde_json::to_string(&change.payload).map_err(to_error)?;
    // Derived from the change, not from the clock, so a replay updates the row it already wrote
    // instead of piling up a copy per pull.
    let record_id = format!(
        "{}::{}::{}",
        change.entity_type,
        change.entity_id,
        change.version.unwrap_or(0)
    );
    eprintln!(
        "local sync: change not applied ({reason}) entity_type={} entity_id={} version={:?}",
        change.entity_type, change.entity_id, change.version
    );
    tx.execute(
        "INSERT INTO local_unapplied_changes (
            id, entity_type, entity_id, operation_type, version, payload, updated_at, reason, detail
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
           operation_type = excluded.operation_type,
           payload = excluded.payload,
           updated_at = excluded.updated_at,
           reason = excluded.reason,
           detail = excluded.detail,
           last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           seen_count = local_unapplied_changes.seen_count + 1",
        params![
            record_id,
            change.entity_type,
            change.entity_id,
            change.operation_type,
            change.version,
            payload,
            change.updated_at,
            reason,
            detail,
        ],
    )
    .map_err(to_error)?;
    Ok(())
}

/// Apply a customer order pulled from the cloud.
///
/// ## Stock reservation on the receiving device — the judgement this function makes
///
/// An order in RECEIVED or PACKED reserves stock on the device that took it. The reservation is
/// **derived, not stored**: `reservedQuantityByProduct` in `frontend/src/local/orderLifecycle.js`
/// walks the orders this device holds and adds up the lines of the ones still holding stock, and
/// `reservedStock.js` subtracts that from what the counter may sell. Nothing is written to
/// `local_inventory_lots` when an order is accepted.
///
/// That decides the question. Writing the pulled order faithfully into `local_customer_orders` and
/// `local_customer_order_items` — with its real status and its real `reserved_at`, so the lapse
/// clock reads the same on both devices — *is* what makes device B reserve the stock. It needs no
/// stock mutation, and a stock mutation would be actively wrong: it would double-count against the
/// POS arithmetic, which deducts from lots at the moment of sale and knows nothing about orders.
/// So this function deliberately does not touch `local_inventory_lots`, for the same reason
/// `apply_pulled_pos_sale_with_tx` does not.
///
/// **Residual risk, stated rather than hidden.** The reservation on device B is only as fresh as
/// its last successful pull. Between one counter accepting an order and the other counter pulling
/// it, both can still sell the same crate; sync closes that window, it does not remove it. When it
/// happens, `availableQuantity` reports `oversold` with the shortfall rather than showing a plain
/// "out of stock", so a person is told to ring the customer. A second, narrower risk: reservations
/// are summed across every order this device holds, without regard to branch, so if the server ever
/// sends a device orders from a branch other than its own, that device's counter would see stock
/// reserved that is not its stock to reserve. `branch_id` is preserved on every row applied here so
/// that a branch filter is possible; today no caller applies one, and that belongs to the frontend
/// layer rather than here.
fn apply_pulled_customer_order_with_tx(
    tx: &rusqlite::Transaction,
    change: &PulledChange,
) -> Result<(), String> {
    let payload = &change.payload;
    let incoming_version = change.version.unwrap_or(1);

    // The version guard, the same shape as the POS sale's. Last-writer-wins on version: an older
    // copy arriving late — a re-delivery, a device that has been offline, a batch replayed after a
    // failed ack — must never undo a newer local status change.
    let existing_version: Option<i64> = tx
        .query_row(
            "SELECT entity_version FROM local_customer_orders WHERE id = ?1",
            [change.entity_id.as_str()],
            |row| row.get(0),
        )
        .optional()
        .map_err(to_error)?;
    if let Some(local_version) = existing_version {
        if incoming_version < local_version {
            return Ok(());
        }
    }

    if change.operation_type.eq_ignore_ascii_case("DELETE") {
        tx.execute(
            "UPDATE local_customer_orders
                SET deleted_at = COALESCE(?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                    entity_version = ?3,
                    sync_status = 'synced',
                    sync_blocked_reason = NULL,
                    updated_at = COALESCE(?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
              WHERE id = ?1",
            params![change.entity_id, change.updated_at, incoming_version],
        )
        .map_err(to_error)?;
        return Ok(());
    }

    // The order has moved to another branch, and this device is the one losing it.
    //
    // **This arm has to exist, and its absence is the single most likely way to build this wrong.**
    // Everything below treats a change that is not DELETE as an upsert, so a TRANSFER_OUT falling
    // through would re-insert the order onto the very device it is supposed to be leaving — and
    // because the two branches' change rows carry the same entity_version, the version guard would
    // not save us either. Both branches would then go on believing they owed the same customer a
    // delivery, which is exactly the confusion this whole design exists to prevent.
    //
    // It is deliberately not folded into the DELETE arm. "This order was cancelled" and "this order
    // is now the other branch's" are different facts, and a counter told the wrong one rings the
    // wrong customer.
    //
    // `deleted_at` is what releases the reserved stock: reservations are summed by
    // `reservedQuantityByProduct` over the orders the board loads, and the board loads
    // `deleted_at IS NULL`. So the release is a consequence of the rule that already governs every
    // other order, rather than a second mechanism that could disagree with it.
    //
    // `branch_id` is left exactly as it was. It still says which branch this row belonged to, which
    // is the true statement here; overwriting it with the destination would leave the losing device
    // holding a row claiming to belong to a branch it has never been.
    //
    // When no such row exists — a TRANSFER_OUT for an order this device never pulled — the UPDATE
    // touches nothing and that is the right answer: there is no local copy to take away, and
    // inserting a tombstone would only invent a record of an order this counter never saw.
    if change.operation_type.eq_ignore_ascii_case("TRANSFER_OUT") {
        // Where it went. The explicit field is preferred; `branch_id` on a transfer payload is the
        // *new* fulfilment branch and so answers the same question, and is the fallback for a
        // server that names it only that way. Read through `order_branch_text` for the same reason
        // every other branch here is: `as_i64` silently drops a branch id sent as a string, and
        // "004" is not 4.
        let destination = order_branch_text(payload, "transferred_to_branch_id")
            .or_else(|| order_branch_text(payload, "branch_id"));
        tx.execute(
            "UPDATE local_customer_orders
                SET deleted_at = COALESCE(?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                    transferred_to_branch_id = ?4,
                    transferred_away_at = COALESCE(?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                    entity_version = ?3,
                    sync_status = 'synced',
                    sync_blocked_reason = NULL,
                    updated_at = COALESCE(?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
              WHERE id = ?1",
            params![change.entity_id, change.updated_at, incoming_version, destination],
        )
        .map_err(to_error)?;
        return Ok(());
    }

    // Status is the field that decides whether this order holds stock, so an unrecognised one is
    // not guessed at. Coercing it to RECEIVED would reserve fruit for an order that might have been
    // cancelled; letting the CHECK constraint reject it would abort the whole pull transaction and
    // wedge the cursor for every other change in the page. It is kept instead, and skipped.
    let status = optional_text(payload, "status")
        .map(|value| value.trim().to_uppercase())
        .unwrap_or_else(|| "RECEIVED".to_string());
    if !CUSTOMER_ORDER_STATUSES.contains(&status.as_str()) {
        return record_unapplied_change(
            tx,
            change,
            "CUSTOMER_ORDER_STATUS_NOT_RECOGNISED",
            Some(format!(
                "status {status:?} is not one this build knows how to display or reserve against"
            )),
        );
    }

    // Source is not load-bearing in the same way — it records how the order arrived. An unknown one
    // becomes OTHER, which is what OTHER means, rather than costing the order.
    let source = optional_text(payload, "source")
        .map(|value| value.trim().to_uppercase())
        .filter(|value| CUSTOMER_ORDER_SOURCES.contains(&value.as_str()))
        .unwrap_or_else(|| "OTHER".to_string());

    let raw_payment_state = optional_text(payload, "payment_state")
        .map(|value| value.trim().to_uppercase());
    let payment_state = raw_payment_state
        .clone()
        .filter(|value| CUSTOMER_ORDER_PAYMENT_STATES.contains(&value.as_str()));
    if raw_payment_state.is_some() && payment_state.is_none() {
        // The order still applies — it is stock and a customer — but NULL means "nobody was ever
        // asked whether this was paid", which is not what happened here. The difference is kept.
        record_unapplied_change(
            tx,
            change,
            "CUSTOMER_ORDER_PAYMENT_STATE_NOT_RECOGNISED",
            Some(format!(
                "payment_state {:?} is not one this build knows; the order was applied with no payment state",
                raw_payment_state.unwrap_or_default()
            )),
        )?;
    }

    let order_no = optional_text(payload, "order_no")
        .unwrap_or_else(|| format!("CLOUD-{}", change.entity_id));
    // `order_no` is UNIQUE. A collision with a *different* order would abort the pull transaction
    // and stall the cursor behind it for ever, so it is caught here and kept instead.
    let clashing_id: Option<String> = tx
        .query_row(
            "SELECT id FROM local_customer_orders WHERE order_no = ?1 AND id <> ?2",
            params![order_no, change.entity_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(to_error)?;
    if let Some(other) = clashing_id {
        return record_unapplied_change(
            tx,
            change,
            "CUSTOMER_ORDER_NUMBER_ALREADY_USED",
            Some(format!(
                "order number {order_no:?} already belongs to order {other:?} on this device"
            )),
        );
    }

    // The branch *fulfilling* this order. It is the column the whole transport scopes by, so it is
    // also the column a transfer changes — an order arriving here with a different `branch_id` than
    // it had is a transfer in, and needs no special handling on this side.
    let branch_id = order_branch_text(payload, "branch_id")
        .or_else(|| change.branch_id.map(|value| value.to_string()));
    // The branch that *took* the order. Never derived from `branch_id`: on an order transferred in
    // from somewhere else those two are different by definition, so falling back to the fulfilment
    // branch would quietly rewrite history to say this branch answered a call it never took. When
    // the payload does not carry it — an older server, or a record written before the split — the
    // UPSERT below keeps whatever this device already had rather than replacing it with NULL.
    let taken_at_branch_id = order_branch_text(payload, "taken_at_branch_id");

    tx.execute(
        "INSERT INTO local_customer_orders (
            id, order_no, source, customer_id, customer_name, customer_mobile, delivery_address,
            status, reserved_at, packed_at, sent_at, delivered_at, cancelled_at,
            cancellation_reason, carrier, carrier_reference, tracking_url, carrier_contact,
            sale_id, invoice_no, notes, branch_id, created_by, created_at, updated_at, deleted_at,
            payment_state, amount_paid, payment_reference, payment_marked_at,
            entity_version, sync_status, sync_blocked_reason, taken_at_branch_id
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
            ?19, ?20, ?21, ?22, ?23,
            COALESCE(?24, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            COALESCE(?25, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            ?26, ?27, ?28, ?29, ?30, ?31, 'synced', NULL, ?32
         )
         ON CONFLICT(id) DO UPDATE SET
           order_no = excluded.order_no,
           source = excluded.source,
           customer_id = excluded.customer_id,
           customer_name = excluded.customer_name,
           customer_mobile = excluded.customer_mobile,
           delivery_address = excluded.delivery_address,
           status = excluded.status,
           reserved_at = excluded.reserved_at,
           packed_at = excluded.packed_at,
           sent_at = excluded.sent_at,
           delivered_at = excluded.delivered_at,
           cancelled_at = excluded.cancelled_at,
           cancellation_reason = excluded.cancellation_reason,
           carrier = excluded.carrier,
           carrier_reference = excluded.carrier_reference,
           tracking_url = excluded.tracking_url,
           carrier_contact = excluded.carrier_contact,
           sale_id = excluded.sale_id,
           invoice_no = excluded.invoice_no,
           notes = excluded.notes,
           branch_id = excluded.branch_id,
           created_by = excluded.created_by,
           updated_at = excluded.updated_at,
           deleted_at = excluded.deleted_at,
           payment_state = excluded.payment_state,
           amount_paid = excluded.amount_paid,
           payment_reference = excluded.payment_reference,
           payment_marked_at = excluded.payment_marked_at,
           entity_version = excluded.entity_version,
           -- COALESCE, not `excluded.`, and it is the one field here treated that way. Provenance
           -- never changes, so an incoming copy that does not carry it is saying nothing about it
           -- rather than saying it is unknown — and overwriting a real branch with NULL would lose
           -- the only record of who took the order, permanently and silently.
           taken_at_branch_id = COALESCE(excluded.taken_at_branch_id, local_customer_orders.taken_at_branch_id),
           -- Cleared, because an UPSERT reaching this device means this branch is fulfilling the
           -- order — the pull predicate sends it nowhere else. An order transferred away and later
           -- transferred back would otherwise come back live while still carrying the note saying
           -- it had left, which reads as two contradictory facts about the same row.
           transferred_to_branch_id = NULL,
           transferred_away_at = NULL,
           sync_status = 'synced',
           sync_blocked_reason = NULL",
        params![
            change.entity_id,
            order_no,
            source,
            optional_text(payload, "customer_id"),
            optional_text(payload, "customer_name")
                .unwrap_or_else(|| "Walk-in customer".to_string()),
            optional_text(payload, "customer_mobile"),
            optional_text(payload, "delivery_address"),
            status,
            // Carried across rather than restamped. The lapse is measured from this timestamp, so
            // restamping it here would make every pull look like a fresh reservation and a
            // forgotten order would hold its fruit for ever — the exact failure the lapse exists
            // to prevent, reintroduced through the back door.
            optional_text(payload, "reserved_at"),
            optional_text(payload, "packed_at"),
            optional_text(payload, "sent_at"),
            optional_text(payload, "delivered_at"),
            optional_text(payload, "cancelled_at"),
            optional_text(payload, "cancellation_reason"),
            optional_text(payload, "carrier"),
            optional_text(payload, "carrier_reference"),
            optional_text(payload, "tracking_url"),
            optional_text(payload, "carrier_contact"),
            optional_text(payload, "sale_id"),
            optional_text(payload, "invoice_no"),
            optional_text(payload, "notes"),
            branch_id,
            optional_text(payload, "created_by"),
            optional_text(payload, "created_at"),
            change.updated_at.clone(),
            optional_text(payload, "deleted_at"),
            payment_state,
            payload.get("amount_paid").and_then(json_number),
            optional_text(payload, "payment_reference"),
            optional_text(payload, "payment_marked_at"),
            incoming_version,
            taken_at_branch_id,
        ],
    )
    .map_err(to_error)?;

    // Whole-record UPSERT means the lines are replaced, not merged. Merging would leave a line that
    // was removed from the order still reserving stock here after it had stopped reserving stock
    // where it was edited. The push payload always carries every line, including the lot assigned
    // at packing, so a round trip loses nothing.
    tx.execute(
        "DELETE FROM local_customer_order_items WHERE order_id = ?1",
        params![change.entity_id],
    )
    .map_err(to_error)?;

    if let Some(items) = payload.get("items").and_then(|value| value.as_array()) {
        for (index, item) in items.iter().enumerate() {
            // Never coerced. `"004"` and `4` are different products, and comparing one against the
            // other is what silently emptied the Inventory table once.
            let Some(product_id) = order_text(item, "product_id") else {
                record_unapplied_change(
                    tx,
                    change,
                    "CUSTOMER_ORDER_LINE_HAS_NO_PRODUCT",
                    Some(format!("line {index} of this order carries no product id and was skipped")),
                )?;
                continue;
            };
            let quantity = item.get("quantity").and_then(json_number).unwrap_or(0.0);
            if !(quantity > 0.0) {
                // The CHECK would reject it and take the whole pull page down with it. A line that
                // reserves nothing, or reserves backwards, is kept and skipped instead.
                record_unapplied_change(
                    tx,
                    change,
                    "CUSTOMER_ORDER_LINE_QUANTITY_NOT_POSITIVE",
                    Some(format!("line {index} of this order has quantity {quantity} and was skipped")),
                )?;
                continue;
            }
            tx.execute(
                "INSERT INTO local_customer_order_items (
                    id, order_id, line_index, product_id, product_name, unit, quantity,
                    agreed_rate, inventory_lot_id
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    order_text(item, "id")
                        .unwrap_or_else(|| format!("{}-line-{}", change.entity_id, index)),
                    change.entity_id,
                    index as i64,
                    product_id,
                    order_text(item, "product_name")
                        .unwrap_or_else(|| "Unnamed product".to_string()),
                    order_text(item, "unit"),
                    quantity,
                    item.get("agreed_rate").and_then(json_number),
                    // Text, and left alone. The lot assigned at packing is an opaque id like every
                    // other id here.
                    order_text(item, "inventory_lot_id"),
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
                        sale_rate, status, purchase_bill_status, remarks, created_at, updated_at, version,
                        sync_status, deleted_at
                     ) VALUES (
                        ?1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11, ?12, ?13, ?14, ?15,
                        ?16, ?17, ?18, ?19, ?20, ?21, ?22, COALESCE(?23, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                        COALESCE(?24, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ?25, 'synced', NULL
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
                        purchase_bill_status = excluded.purchase_bill_status,
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
                        // The whole point of migration 019: this used to be dropped, so a lot whose
                        // bill had not arrived was indistinguishable from one that genuinely cost
                        // nothing. Left NULL when the server does not say, because "not told" and
                        // "told it is final" are different facts and only one of them is evidence.
                        optional_text(&change.payload, "purchase_bill_status"),
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
        "customer_order" => apply_pulled_customer_order_with_tx(tx, change)?,
        // Not `_ => {}`. An unrecognised entity type used to be dropped here with no error and no
        // log, while the caller advanced the pull cursor in the same transaction — so the change
        // was never offered again and the loss was invisible on both ends. It is kept instead:
        // still not fatal, because a device running older code has to go on syncing everything it
        // does understand, but no longer silent and no longer destroyed.
        _ => record_unapplied_change(
            tx,
            change,
            "ENTITY_TYPE_NOT_SUPPORTED",
            Some(format!(
                "this build has no arm for entity type {:?}",
                change.entity_type
            )),
        )?,
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

    /// How many migrations `initialize_at` applies to a fresh profile.
    ///
    /// Was written out as a bare `17` in three separate assertions. Adding migration 019 broke all
    /// three at once with nothing but `left: 18, right: 17` to explain why, and the failures were
    /// mistaken for the environment for long enough to reach a merge check. One named constant is
    /// the whole fix: **bump this when you add a migration**, and the number says what it counts.
    const EXPECTED_APPLIED_MIGRATIONS: i64 = 22;

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

    /// An order with more than one item saves.
    ///
    /// `unique_local_id` is a pure function of the current millisecond — same prefix, same
    /// millisecond, same id. Order lines are inserted in a tight loop, so every line of a
    /// multi-line order was handed the identical TEXT PRIMARY KEY, the second INSERT failed on the
    /// uniqueness constraint, and the transaction took the whole order with it. Any order with two
    /// or more items was rejected outright. The round-trip test above only ever saved one line,
    /// which is exactly why it stayed green.
    #[test]
    fn a_multi_line_order_saves() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-order-multiline-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ));
        let _ = fs::remove_file(&path);
        initialize_at(&path).expect("initialize order database");

        let order = serde_json::json!({
            "order_no": "ORD-MULTI",
            "customer_name": "Ram",
            "items": [
                { "product_id": "004", "product_name": "Apple", "quantity": 2.5, "agreed_rate": 180 },
                { "product_id": "005", "product_name": "Banana", "quantity": 1.5, "agreed_rate": 60 },
                { "product_id": "006", "product_name": "Pomegranate", "quantity": 1.0, "agreed_rate": 240 }
            ]
        });
        let saved = save_customer_order_at(&path, &order).expect("a three-line order must save");
        let items = saved["items"].as_array().expect("items come back as an array");
        assert_eq!(items.len(), 3, "every line must survive");

        let ids: std::collections::HashSet<&str> =
            items.iter().filter_map(|item| item["id"].as_str()).collect();
        assert_eq!(ids.len(), 3, "each line needs an id of its own");

        let _ = fs::remove_file(&path);
    }

    /// A billed order cannot be walked backwards, whatever the caller asks for.
    ///
    /// This is the single rule the storage layer owns. Everything else about which status may
    /// follow which is decided in `frontend/src/local/orderLifecycle.js`, because two copies of a
    /// state machine drift and the one nobody is looking at wins. This one is here because its
    /// failure leaves an invoice attached to stock the shop believes it still has on the shelf.
    #[test]
    fn a_billed_order_cannot_walk_backwards() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-order-billing-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ));
        let _ = fs::remove_file(&path);
        initialize_at(&path).expect("initialize order database");
        let conn = Connection::open(&path).expect("open order database");
        conn.execute(
            "INSERT INTO local_customer_orders (id, order_no, customer_name, status, sale_id, invoice_no) \
             VALUES ('order-billed', 'ORD-9', 'Ram', 'SENT', 'sale-77', 'INV-77')",
            [],
        )
        .expect("seed a sent, billed order");
        drop(conn);

        for refused in ["RECEIVED", "PACKED", "CANCELLED"] {
            let outcome = set_customer_order_status_at(&path, "order-billed", refused, &serde_json::json!({}));
            let message = outcome.expect_err("a billed order must not walk backwards");
            assert!(
                message.contains("sale return"),
                "the refusal must name the alternative, got: {message}"
            );
        }

        // Forwards is still allowed: a sent parcel can be delivered, or come back.
        set_customer_order_status_at(&path, "order-billed", "DELIVERED", &serde_json::json!({}))
            .expect("a billed order may still be marked delivered");

        let _ = fs::remove_file(&path);
    }

    /// An order and its lines survive a round trip, and a rejected line takes the whole order with it.
    #[test]
    fn an_order_is_written_whole_or_not_at_all() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-order-roundtrip-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ));
        let _ = fs::remove_file(&path);
        initialize_at(&path).expect("initialize order database");

        let bad = serde_json::json!({
            "order_no": "ORD-BAD",
            "customer_name": "Sita",
            "items": [
                { "product_id": "004", "product_name": "Apple", "quantity": 5 },
                { "product_id": "005", "product_name": "Banana", "quantity": 0 }
            ]
        });
        assert!(
            save_customer_order_at(&path, &bad).is_err(),
            "a zero-quantity line must refuse the whole order"
        );

        // The point of the transaction: a half-written order would hold a reservation against
        // lines that were never recorded, so stock would be missing from the counter with nothing
        // on screen explaining where it went.
        let conn = Connection::open(&path).expect("reopen");
        let orphans: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_customer_orders", [], |row| row.get(0))
            .expect("count orders");
        assert_eq!(orphans, 0, "the rejected order must leave nothing behind");
        drop(conn);

        let good = serde_json::json!({
            "order_no": "ORD-GOOD",
            "customer_name": "Sita",
            "customer_mobile": "9876543210",
            "items": [{ "product_id": "004", "product_name": "Apple", "unit": "kg", "quantity": 10.5, "agreed_rate": 80 }]
        });
        let saved = save_customer_order_at(&path, &good).expect("a well-formed order is saved");
        assert_eq!(saved["status"], "RECEIVED");
        assert_eq!(saved["items"][0]["product_id"], "004", "ids stay text");
        assert_eq!(saved["items"][0]["quantity"], 10.5);
        assert!(
            saved["reserved_at"].as_str().is_some_and(|value| !value.is_empty()),
            "an accepted order reserves stock immediately, so it must carry a reservation time"
        );

        // Nothing was queued for either order. The rejected one left no outbox row because it left
        // no order; the accepted one left none because this profile has no branch of its own to
        // give it, and a branchless change would be refused by the server and would take the
        // acknowledgements for the rest of its push batch down with it. That refusal is named on
        // the record rather than being an order that silently never syncs.
        let conn = Connection::open(&path).expect("reopen for outbox");
        let queued: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_outbox", [], |row| row.get(0))
            .expect("count outbox");
        assert_eq!(queued, 0, "a rejected order must leave no outbox row either");
        drop(conn);
        assert_eq!(saved["sync_status"], "blocked");
        assert!(
            saved["sync_blocked_reason"]
                .as_str()
                .is_some_and(|reason| reason.contains("no branch")),
            "an order that cannot be queued must say so in words, not just fail to sync"
        );

        let _ = fs::remove_file(&path);
    }

    /// Build a throwaway order profile.
    fn order_sync_test_path(label: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "froozerp-order-sync-{label}-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ));
        let _ = fs::remove_file(&path);
        path
    }

    /// Give the profile an approved device so branch resolution has a rung 2 to land on.
    fn seed_order_branch(path: &std::path::Path, branch: &str) {
        let conn = Connection::open(path).expect("open profile to seed identity");
        conn.execute(
            "INSERT INTO local_device_identity
               (device_id, device_name, platform, app_version, branch_id, registration_status)
             VALUES ('FZDEV-ORDERS', 'Order Counter', 'windows', '1.0.0', ?1, 'approved')",
            rusqlite::params![branch],
        )
        .expect("seed approved device identity");
    }

    /// One order read back by id, through the same list the board uses.
    fn order_row(path: &std::path::Path, order_id: &str) -> serde_json::Value {
        list_customer_orders_at(path)
            .expect("orders list")["orders"]
            .as_array()
            .expect("orders array")
            .iter()
            .find(|order| order["id"] == order_id)
            .cloned()
            .unwrap_or_else(|| panic!("order {order_id} is missing from the board"))
    }

    fn outbox_rows(path: &std::path::Path) -> Vec<(String, String, String, String, i64, Option<String>, String, serde_json::Value)> {
        let conn = Connection::open(path).expect("open profile to read outbox");
        let mut statement = conn
            .prepare(
                "SELECT operation_id, entity_type, entity_id, operation_type, version, branch_id,
                        status, payload_json
                 FROM sync_outbox ORDER BY version, operation_id",
            )
            .expect("prepare outbox read");
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                    serde_json::from_str::<serde_json::Value>(&row.get::<_, String>(7)?)
                        .unwrap_or(serde_json::Value::Null),
                ))
            })
            .expect("read outbox")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect outbox");
        rows
    }

    /// Writing an order queues it, in the same transaction, exactly once.
    ///
    /// The order and its outbox row have to commit together. Enqueueing from JavaScript after the
    /// save returned would mean that any failure between the two calls left an order with nothing
    /// queued behind it — unsynced for ever, and indistinguishable on screen from one that had
    /// synced. So this asserts on the shape of the queued row as well as on its existence.
    #[test]
    fn an_order_write_queues_exactly_one_upsert_carrying_the_whole_order() {
        let path = order_sync_test_path("write");
        initialize_at(&path).expect("initialize order sync database");

        let saved = save_customer_order_at(
            &path,
            &serde_json::json!({
                "order_no": "ORD-SYNC-1",
                "customer_name": "Ram",
                // A branch sent as a string. The old reader used `as_i64()` and dropped it, which
                // is how an order reached the outbox with no branch at all.
                "branch_id": "3",
                "items": [
                    { "product_id": "004", "product_name": "Apple", "quantity": 2.5, "agreed_rate": 180 },
                    { "product_id": "005", "product_name": "Banana", "quantity": 1.5, "agreed_rate": 60 }
                ]
            }),
        )
        .expect("a well-formed order saves");
        let order_id = saved["id"].as_str().expect("saved order has an id").to_string();

        let rows = outbox_rows(&path);
        assert_eq!(rows.len(), 1, "one order write means one outbox row, not zero and not two");
        let (operation_id, entity_type, entity_id, operation_type, version, branch, status, payload) =
            rows.into_iter().next().unwrap();
        assert_eq!(entity_type, "customer_order");
        assert_eq!(entity_id, order_id, "the entity id is the order id, uncoerced");
        assert_eq!(operation_type, "UPSERT");
        assert_eq!(version, 1);
        assert_eq!(branch.as_deref(), Some("3"), "the branch travels as text");
        assert_eq!(status, "pending");
        assert_eq!(operation_id, format!("order-{order_id}-v1"));

        // The whole record, every time: header plus every line.
        assert_eq!(payload["branch_id"], "3", "the wire carries a text branch id");
        assert_eq!(payload["customer_name"], "Ram");
        assert_eq!(payload["status"], "RECEIVED");
        assert_eq!(payload["entity_version"], 1);
        let lines = payload["items"].as_array().expect("the payload carries its lines");
        assert_eq!(lines.len(), 2, "a partial payload would sync a partial order");
        assert_eq!(lines[0]["product_id"], "004", "product ids stay opaque text on the wire");
        assert_eq!(saved["sync_status"], "pending");

        let _ = fs::remove_file(&path);
    }

    /// A branch that is not a number survives the round trip instead of emptying the board.
    ///
    /// `local_customer_orders.branch_id` is INTEGER while every other local table stores branch ids
    /// as TEXT. The column is not rebuilt — nothing joins it — so the read has to tolerate what
    /// SQLite's affinity rules actually store. A read that insisted on `Option<i64>` would fail on
    /// such a row, and because the board reads every order in a loop, one row would empty all of it.
    #[test]
    fn a_branch_id_that_is_not_a_number_survives_the_order_round_trip() {
        let path = order_sync_test_path("textbranch");
        initialize_at(&path).expect("initialize order sync database");

        let saved = save_customer_order_at(
            &path,
            &serde_json::json!({
                "order_no": "ORD-SYNC-TEXT",
                "customer_name": "Sita",
                "branch_id": "north-2",
                "items": [{ "product_id": "004", "product_name": "Apple", "quantity": 1 }]
            }),
        )
        .expect("an order with a non-numeric branch saves");
        assert_eq!(saved["branch_id"], "north-2");
        assert_eq!(outbox_rows(&path)[0].5.as_deref(), Some("north-2"));

        // And the board still loads.
        let board = list_customer_orders_at(&path).expect("the orders board must still load");
        assert_eq!(board["orders"].as_array().expect("orders array").len(), 1);

        let _ = fs::remove_file(&path);
    }

    /// A rejected order leaves neither an order nor an outbox row.
    #[test]
    fn a_rejected_order_leaves_no_outbox_row_behind() {
        let path = order_sync_test_path("rollback");
        initialize_at(&path).expect("initialize order sync database");
        seed_order_branch(&path, "3");

        let outcome = save_customer_order_at(
            &path,
            &serde_json::json!({
                "order_no": "ORD-SYNC-BAD",
                "customer_name": "Mohan",
                "items": [
                    { "product_id": "004", "product_name": "Apple", "quantity": 5 },
                    { "product_id": "005", "product_name": "Banana", "quantity": 0 }
                ]
            }),
        );
        assert!(outcome.is_err(), "a zero-quantity line must refuse the whole order");

        let conn = Connection::open(&path).expect("reopen after rollback");
        let orders: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_customer_orders", [], |row| row.get(0))
            .expect("count orders");
        let queued: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_outbox", [], |row| row.get(0))
            .expect("count outbox");
        assert_eq!(orders, 0, "the rejected order must leave nothing behind");
        assert_eq!(
            queued, 0,
            "an outbox row without its order would push an order that does not exist"
        );
        drop(conn);
        let _ = fs::remove_file(&path);
    }

    /// Every status change queues its own whole-record UPSERT and moves the version on.
    ///
    /// Not a distinct operation type per status change: the server sorts a push batch by
    /// `operation_id` string rather than by causality and permanently records any rejection, so a
    /// status change that arrived before its own creation would be rejected once and never retried.
    /// Whole-record UPSERT with last-writer-wins on version is order-independent.
    #[test]
    #[test]
    fn an_acknowledged_order_stops_reporting_itself_as_pending() {
        // The seam between the two halves of this feature, and the one place neither half could
        // see on its own. The push acknowledgement marks the *outbox* row synced; the order's own
        // `sync_status` is a different column, added by migration 022. Without an arm for it here
        // a perfectly delivered order sits at 'pending' forever, and the board reports every
        // synced order as still waiting - a status field lying about the single thing it exists
        // to say.
        let path = order_sync_test_path("ack");
        initialize_at(&path).expect("initialize order sync database");
        seed_order_branch(&path, "7");

        let saved = save_customer_order_at(
            &path,
            &serde_json::json!({
                "order_no": "ORD-ACK-1",
                "customer_name": "Sita",
                "items": [{ "product_id": "004", "product_name": "Apple", "quantity": 2 }]
            }),
        )
        .expect("order saves");
        let order_id = saved["id"].as_str().unwrap().to_string();
        assert_eq!(saved["sync_status"], "pending", "an order starts out unsent");

        let ack = SyncAck {
            operation_id: format!("order-{order_id}-v1"),
            status: "accepted".to_string(),
            server_entity_version: Some(1),
            server_updated_at: Some("2026-08-27T10:00:00.000Z".to_string()),
            error_code: None,
            message: None,
            result_payload: Some(serde_json::json!({
                "entity_type": "customer_order",
                "order_id": order_id,
                "entity_version": 1,
                "duplicate": false
            })),
        };
        apply_push_acks_at(&path, &[ack], None, Some("2026-08-27T10:00:00.000Z".to_string()))
            .expect("the acknowledgement applies");

        let order = order_row(&path, &order_id);
        assert_eq!(order["sync_status"], "synced", "a delivered order must stop claiming to be pending");
        assert!(order["sync_blocked_reason"].is_null());
    }

    #[test]
    fn an_order_changed_while_its_push_was_in_flight_stays_pending() {
        // The reason the arm above is version-gated rather than a plain id match. A status change
        // made between the push leaving and its acknowledgement arriving has already queued an
        // operation of its own. Clearing the flag on the older acknowledgement would report that
        // newer, genuinely unsent version as delivered - the shop would believe a change had
        // reached the other counters when it had not left this one.
        let path = order_sync_test_path("ack-inflight");
        initialize_at(&path).expect("initialize order sync database");
        seed_order_branch(&path, "7");

        let saved = save_customer_order_at(
            &path,
            &serde_json::json!({
                "order_no": "ORD-ACK-2",
                "customer_name": "Gita",
                "items": [{ "product_id": "004", "product_name": "Apple", "quantity": 2 }]
            }),
        )
        .expect("order saves");
        let order_id = saved["id"].as_str().unwrap().to_string();

        // v2 happens while v1 is still on the wire.
        set_customer_order_status_at(&path, &order_id, "PACKED", &serde_json::json!({}))
            .expect("an order can be packed");

        let ack = SyncAck {
            operation_id: format!("order-{order_id}-v1"),
            status: "accepted".to_string(),
            server_entity_version: Some(1),
            server_updated_at: Some("2026-08-27T10:00:00.000Z".to_string()),
            error_code: None,
            message: None,
            result_payload: Some(serde_json::json!({ "entity_version": 1 })),
        };
        apply_push_acks_at(&path, &[ack], None, Some("2026-08-27T10:00:00.000Z".to_string()))
            .expect("the acknowledgement applies");

        let order = order_row(&path, &order_id);
        assert_eq!(order["entity_version"], 2);
        assert_eq!(
            order["sync_status"], "pending",
            "v1's acknowledgement must not vouch for v2, which has not been sent"
        );
    }

    fn a_status_change_queues_its_own_upsert_and_moves_the_version_on() {
        let path = order_sync_test_path("status");
        initialize_at(&path).expect("initialize order sync database");
        // No branch on the order itself: this exercises rung 2, the device's own registration.
        seed_order_branch(&path, "7");

        let saved = save_customer_order_at(
            &path,
            &serde_json::json!({
                "order_no": "ORD-SYNC-2",
                "customer_name": "Ram",
                "items": [{ "product_id": "004", "product_name": "Apple", "quantity": 4 }]
            }),
        )
        .expect("order saves");
        let order_id = saved["id"].as_str().unwrap().to_string();
        assert_eq!(saved["entity_version"], 1);
        assert_eq!(outbox_rows(&path).len(), 1);
        assert_eq!(outbox_rows(&path)[0].5.as_deref(), Some("7"), "the device's branch is used");

        let packed = set_customer_order_status_at(&path, &order_id, "PACKED", &serde_json::json!({}))
            .expect("an order can be packed");
        assert_eq!(packed["status"], "PACKED");
        assert_eq!(packed["entity_version"], 2, "every local mutation moves the version on");
        assert_eq!(packed["sync_status"], "pending");

        let rows = outbox_rows(&path);
        assert_eq!(rows.len(), 2, "the status change queues a row of its own");
        assert_eq!(rows[1].0, format!("order-{order_id}-v2"));
        assert_eq!(rows[1].3, "UPSERT", "a status change is an UPSERT like any other mutation");
        assert_eq!(rows[1].4, 2);
        assert_eq!(rows[1].7["status"], "PACKED", "the queued payload is the order as it now stands");
        assert_eq!(
            rows[1].7["items"].as_array().map(Vec::len),
            Some(1),
            "a status change still carries the whole record, lines included"
        );

        let sent = set_customer_order_status_at(
            &path,
            &order_id,
            "SENT",
            &serde_json::json!({ "carrier": "Porter", "sale_id": "sale-1", "invoice_no": "INV-1" }),
        )
        .expect("a packed order can be sent");
        assert_eq!(sent["entity_version"], 3);
        let rows = outbox_rows(&path);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[2].7["carrier"], "Porter");
        assert_eq!(rows[2].7["sale_id"], "sale-1");

        let operation_ids: std::collections::HashSet<&str> =
            rows.iter().map(|row| row.0.as_str()).collect();
        assert_eq!(operation_ids.len(), 3, "each mutation needs an operation id of its own");

        let _ = fs::remove_file(&path);
    }

    /// A refused status change queues nothing.
    #[test]
    fn a_refused_status_change_queues_nothing() {
        let path = order_sync_test_path("refused");
        initialize_at(&path).expect("initialize order sync database");
        seed_order_branch(&path, "7");
        let conn = Connection::open(&path).expect("open to seed");
        conn.execute(
            "INSERT INTO local_customer_orders (id, order_no, customer_name, status, sale_id, invoice_no) \
             VALUES ('order-billed', 'ORD-B', 'Ram', 'SENT', 'sale-9', 'INV-9')",
            [],
        )
        .expect("seed a billed order");
        drop(conn);

        assert!(
            set_customer_order_status_at(&path, "order-billed", "RECEIVED", &serde_json::json!({}))
                .is_err(),
            "a billed order must not walk backwards"
        );
        assert!(
            outbox_rows(&path).is_empty(),
            "a refused status change must not queue a move that never happened"
        );
        let _ = fs::remove_file(&path);
    }

    /// A pulled order lands whole, and a replay of the same change changes nothing.
    ///
    /// This is the arm that has to exist **before** the server ever emits a `customer_order` row.
    /// Without it the change falls to the default arm, and `apply_pull_changes_at` advances the
    /// pull cursor in the same transaction regardless — so the order would be gone from every
    /// device with no error anywhere.
    #[test]
    fn a_pulled_order_is_applied_once_and_replays_without_duplicating() {
        let path = order_sync_test_path("pull");
        initialize_at(&path).expect("initialize order pull database");

        let change = PulledChange {
            change_id: serde_json::json!(9001),
            branch_id: Some(3),
            entity_type: "customer_order".to_string(),
            entity_id: "remote-order-1".to_string(),
            operation_type: "UPSERT".to_string(),
            version: Some(4),
            updated_at: Some("2026-08-20T09:30:00.000Z".to_string()),
            payload: serde_json::json!({
                "id": "remote-order-1",
                "order_no": "ORD-REMOTE-1",
                "source": "WHATSAPP",
                "customer_name": "Anita",
                "customer_mobile": "9876500000",
                "status": "PACKED",
                "reserved_at": "2026-08-20T09:00:00.000Z",
                "packed_at": "2026-08-20T09:25:00.000Z",
                "branch_id": "3",
                "payment_state": "ON_DELIVERY",
                "amount_paid": 0,
                "items": [
                    { "id": "remote-order-1-line-0", "product_id": "004", "product_name": "Apple", "unit": "kg", "quantity": 6, "agreed_rate": 80, "inventory_lot_id": "lot-77" },
                    { "id": "remote-order-1-line-1", "product_id": "005", "product_name": "Banana", "quantity": 2 }
                ]
            }),
        };

        for _ in 0..2 {
            apply_pull_changes_at(
                &path,
                std::slice::from_ref(&change),
                "cursor-1",
                Some("FZDEV-B".to_string()),
                Some("2026-08-20T09:31:00.000Z".to_string()),
            )
            .expect("a pulled order must apply");
        }

        let applied = read_customer_order(
            &Connection::open(&path).expect("open after pull"),
            "remote-order-1",
        )
        .expect("the pulled order must be readable");
        assert_eq!(applied["order_no"], "ORD-REMOTE-1");
        assert_eq!(applied["status"], "PACKED");
        assert_eq!(applied["source"], "WHATSAPP");
        assert_eq!(applied["entity_version"], 4);
        assert_eq!(applied["sync_status"], "synced");
        assert_eq!(applied["payment_state"], "ON_DELIVERY");
        // Carried across, not restamped. The lapse is measured from this timestamp; restamping it
        // on every pull would mean a forgotten order held its fruit for ever.
        assert_eq!(applied["reserved_at"], "2026-08-20T09:00:00.000Z");

        let lines = applied["items"].as_array().expect("lines");
        assert_eq!(lines.len(), 2, "a replay must not duplicate the lines");
        assert_eq!(lines[0]["product_id"], "004", "ids stay text through the sync path");
        assert_eq!(lines[0]["quantity"], 6.0);
        assert_eq!(lines[0]["inventory_lot_id"], "lot-77");

        let conn = Connection::open(&path).expect("inspect after pull");
        let orders: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_customer_orders", [], |row| row.get(0))
            .expect("count orders");
        assert_eq!(orders, 1, "a replayed change must not make a second order");

        // The receiving device reserves this stock because the order is here in a reserving status
        // and `reservedQuantityByProduct` derives the reservation from exactly these rows. Nothing
        // is written to the lots: doing so would double-count against the POS arithmetic, which
        // deducts from lots at the moment of sale and knows nothing about orders. Same reason
        // `apply_pulled_pos_sale_with_tx` leaves the lots alone.
        let lots: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_inventory_lots", [], |row| row.get(0))
            .expect("count lots");
        let movements: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_stock_movements", [], |row| row.get(0))
            .expect("count movements");
        assert_eq!(lots, 0, "a pulled order must not invent or mutate stock");
        assert_eq!(movements, 0, "a pulled order is a reservation, not a stock movement");

        // Applying a pulled order must not push it straight back out again.
        let queued: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_outbox", [], |row| row.get(0))
            .expect("count outbox");
        assert_eq!(queued, 0, "an order that came from the cloud must not be echoed back to it");
        drop(conn);

        let _ = fs::remove_file(&path);
    }

    /// An older copy arriving late must not undo a newer local change.
    #[test]
    fn an_older_pulled_order_does_not_overwrite_a_newer_local_one() {
        let path = order_sync_test_path("stale");
        initialize_at(&path).expect("initialize order pull database");
        seed_order_branch(&path, "3");

        save_customer_order_at(
            &path,
            &serde_json::json!({
                "id": "order-local-1",
                "order_no": "ORD-LOCAL-1",
                "customer_name": "Ram",
                "items": [{ "product_id": "004", "product_name": "Apple", "quantity": 3 }]
            }),
        )
        .expect("local order saves");
        let packed =
            set_customer_order_status_at(&path, "order-local-1", "PACKED", &serde_json::json!({}))
                .expect("local order packs");
        assert_eq!(packed["entity_version"], 2);

        let stale = PulledChange {
            change_id: serde_json::json!(1),
            branch_id: Some(3),
            entity_type: "customer_order".to_string(),
            entity_id: "order-local-1".to_string(),
            operation_type: "UPSERT".to_string(),
            version: Some(1),
            updated_at: Some("2026-08-20T08:00:00.000Z".to_string()),
            payload: serde_json::json!({
                "order_no": "ORD-LOCAL-1",
                "customer_name": "Ram",
                "status": "CANCELLED",
                "branch_id": "3",
                "items": []
            }),
        };
        apply_pull_changes_at(
            &path,
            std::slice::from_ref(&stale),
            "cursor-2",
            Some("FZDEV-ORDERS".to_string()),
            Some("2026-08-20T09:31:00.000Z".to_string()),
        )
        .expect("a stale change is skipped, not an error");

        let conn = Connection::open(&path).expect("open after stale pull");
        let after = read_customer_order(&conn, "order-local-1").expect("read order");
        assert_eq!(after["status"], "PACKED", "a stale copy must not undo a newer local change");
        assert_eq!(after["entity_version"], 2);
        assert_eq!(
            after["items"].as_array().map(Vec::len),
            Some(1),
            "and it must not take the lines with it"
        );
        drop(conn);

        // A genuinely newer copy does win.
        let newer = PulledChange { version: Some(5), ..stale };
        apply_pull_changes_at(
            &path,
            std::slice::from_ref(&newer),
            "cursor-3",
            Some("FZDEV-ORDERS".to_string()),
            Some("2026-08-20T09:32:00.000Z".to_string()),
        )
        .expect("a newer change applies");
        let conn = Connection::open(&path).expect("open after newer pull");
        let after = read_customer_order(&conn, "order-local-1").expect("read order");
        assert_eq!(after["status"], "CANCELLED");
        assert_eq!(after["entity_version"], 5);
        drop(conn);

        let _ = fs::remove_file(&path);
    }

    /// A transfer takes the order off this branch's board and says where it went.
    ///
    /// A transfer from branch A to branch B writes **two** change-log rows carrying the same
    /// entity_version: a TRANSFER_OUT scoped to A and an UPSERT scoped to B. A's devices only pull
    /// rows matching A, so without the first row they would never be told the order had left, and
    /// two branches would go on believing they owed the same customer a delivery.
    ///
    /// The soft delete is what releases the reserved stock: reservations are summed by
    /// `reservedQuantityByProduct` over the orders the board loads, and the board loads
    /// `deleted_at IS NULL`. The two transfer columns are what stop the order from looking as
    /// though it had simply vanished — a counter told "cancelled" when the truth is "it is now
    /// Ratanada's" rings the wrong customer.
    #[test]
    fn a_transferred_out_order_leaves_the_board_and_records_where_it_went() {
        let path = order_sync_test_path("transfer-out");
        initialize_at(&path).expect("initialize order transfer database");
        seed_order_branch(&path, "3");

        save_customer_order_at(
            &path,
            &serde_json::json!({
                "id": "order-moving",
                "order_no": "ORD-MOVING",
                "customer_name": "Anita",
                "items": [{ "product_id": "004", "product_name": "Apple", "quantity": 6 }]
            }),
        )
        .expect("the order is taken at this branch");

        // Taken here and fulfilled here, which is every order until somebody moves one.
        let before = order_row(&path, "order-moving");
        assert_eq!(before["branch_id"], 3);
        assert_eq!(before["taken_at_branch_id"], "3");
        assert!(before["transferred_to_branch_id"].is_null());

        let transfer = PulledChange {
            change_id: serde_json::json!(9101),
            branch_id: Some(3),
            entity_type: "customer_order".to_string(),
            entity_id: "order-moving".to_string(),
            operation_type: "TRANSFER_OUT".to_string(),
            version: Some(2),
            updated_at: Some("2026-08-28T11:00:00.000Z".to_string()),
            payload: serde_json::json!({
                "id": "order-moving",
                "order_no": "ORD-MOVING",
                "customer_name": "Anita",
                "status": "RECEIVED",
                // The payload describes the order as it now is: fulfilled by branch 7, still taken
                // at branch 3.
                "branch_id": "7",
                "transferred_to_branch_id": "7",
                "taken_at_branch_id": "3",
                "items": [{ "product_id": "004", "product_name": "Apple", "quantity": 6 }]
            }),
        };
        apply_pull_changes_at(
            &path,
            std::slice::from_ref(&transfer),
            "cursor-transfer-1",
            Some("FZDEV-ORDERS".to_string()),
            Some("2026-08-28T11:01:00.000Z".to_string()),
        )
        .expect("a transfer out applies");

        // Gone from the query the board actually runs, which is what releases the reservation.
        let board = list_customer_orders_at(&path).expect("orders list");
        assert!(
            board["orders"]
                .as_array()
                .expect("orders array")
                .iter()
                .all(|order| order["id"] != "order-moving"),
            "an order that has moved to another branch must not stay on this branch's board"
        );

        let conn = Connection::open(&path).expect("open after transfer");
        let after = read_customer_order(&conn, "order-moving")
            .expect("the row stays, so it can explain itself");
        assert_eq!(
            after["transferred_to_branch_id"], "7",
            "the order did not vanish; it went somewhere, and the record says where"
        );
        assert_eq!(after["transferred_away_at"], "2026-08-28T11:00:00.000Z");
        assert_eq!(
            after["taken_at_branch_id"], "3",
            "provenance is not rewritten by a transfer — this branch did answer the phone"
        );
        assert_eq!(
            after["branch_id"], 3,
            "and the row still says which branch lost it, rather than claiming to be branch 7's"
        );
        assert_eq!(after["entity_version"], 2);
        assert_eq!(after["sync_status"], "synced");
        assert!(after["sync_blocked_reason"].is_null());

        let deleted_at: Option<String> = conn
            .query_row(
                "SELECT deleted_at FROM local_customer_orders WHERE id = 'order-moving'",
                [],
                |row| row.get(0),
            )
            .expect("read deleted_at");
        assert!(
            deleted_at.is_some(),
            "the soft delete is what releases the reserved stock, so it has to be set"
        );

        // Nothing was invented or destroyed in the stock tables: the reservation was only ever
        // derived from the orders this device holds.
        let lots: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_inventory_lots", [], |row| row.get(0))
            .expect("count lots");
        let movements: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_stock_movements", [], |row| row.get(0))
            .expect("count movements");
        assert_eq!(lots, 0, "releasing a reservation is not a stock movement");
        assert_eq!(movements, 0);
        drop(conn);

        let _ = fs::remove_file(&path);
    }

    /// A TRANSFER_OUT must never leave a live order behind.
    ///
    /// `apply_pulled_customer_order_with_tx` special-cases DELETE and treats **everything else** as
    /// an upsert. Without an explicit TRANSFER_OUT arm the change falls through to that upsert and
    /// re-inserts the order onto the very device it is supposed to be leaving — and since both
    /// change rows of a transfer carry the same entity_version, the version guard does not catch it
    /// either. This test is the one that fails if that arm is ever removed.
    #[test]
    fn a_transfer_out_is_not_an_upsert_and_leaves_no_live_order_behind() {
        let path = order_sync_test_path("transfer-not-upsert");
        initialize_at(&path).expect("initialize order transfer database");
        seed_order_branch(&path, "3");

        save_customer_order_at(
            &path,
            &serde_json::json!({
                "id": "order-leaving",
                "order_no": "ORD-LEAVING",
                "customer_name": "Ram",
                "items": [{ "product_id": "004", "product_name": "Apple", "quantity": 2 }]
            }),
        )
        .expect("the order is taken at this branch");

        let transfer = PulledChange {
            change_id: serde_json::json!(9102),
            branch_id: Some(3),
            entity_type: "customer_order".to_string(),
            entity_id: "order-leaving".to_string(),
            operation_type: "TRANSFER_OUT".to_string(),
            version: Some(2),
            updated_at: Some("2026-08-28T12:00:00.000Z".to_string()),
            payload: serde_json::json!({
                "id": "order-leaving",
                "order_no": "ORD-LEAVING",
                "customer_name": "Ram",
                // Deliberately different from the local row on every field an upsert would copy, so
                // that a fall-through is visible rather than merely suspected.
                "status": "PACKED",
                "branch_id": "7",
                "transferred_to_branch_id": "7",
                "taken_at_branch_id": "3",
                "items": [{ "product_id": "004", "product_name": "Apple", "quantity": 2 }]
            }),
        };
        apply_pull_changes_at(
            &path,
            std::slice::from_ref(&transfer),
            "cursor-transfer-2",
            Some("FZDEV-ORDERS".to_string()),
            Some("2026-08-28T12:01:00.000Z".to_string()),
        )
        .expect("a transfer out applies");

        let conn = Connection::open(&path).expect("open after transfer");
        let live: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_customer_orders
                  WHERE id = 'order-leaving' AND deleted_at IS NULL",
                [],
                |row| row.get(0),
            )
            .expect("count live rows");
        assert_eq!(
            live, 0,
            "a TRANSFER_OUT treated as an upsert would re-insert the order it is meant to remove"
        );
        let (status, branch): (String, i64) = conn
            .query_row(
                "SELECT status, branch_id FROM local_customer_orders WHERE id = 'order-leaving'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read the row that stayed behind");
        assert_eq!(status, "RECEIVED", "the payload's status is not applied by a transfer out");
        assert_eq!(branch, 3, "nor is the destination branch written over the losing branch");
        drop(conn);

        // And a transfer out for an order this device never pulled creates nothing at all. There is
        // no local copy to take away, and a tombstone would invent a record of an order this
        // counter never saw.
        let unknown = PulledChange {
            change_id: serde_json::json!(9103),
            entity_id: "order-never-here".to_string(),
            version: Some(1),
            ..transfer
        };
        apply_pull_changes_at(
            &path,
            std::slice::from_ref(&unknown),
            "cursor-transfer-3",
            Some("FZDEV-ORDERS".to_string()),
            Some("2026-08-28T12:02:00.000Z".to_string()),
        )
        .expect("a transfer out for an unknown order is not an error");
        let conn = Connection::open(&path).expect("open after unknown transfer");
        let created: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_customer_orders WHERE id = 'order-never-here'",
                [],
                |row| row.get(0),
            )
            .expect("count invented rows");
        assert_eq!(created, 0, "a transfer out must never create an order");
        drop(conn);

        let _ = fs::remove_file(&path);
    }

    /// An older TRANSFER_OUT arriving late must not take away a newer local order.
    ///
    /// The version guard applies to a transfer exactly as it does to an upsert: a re-delivery, or a
    /// device coming back from a long offline spell, must not remove an order from a board that has
    /// since moved it on.
    #[test]
    fn an_older_transfer_out_does_not_undo_a_newer_local_change() {
        let path = order_sync_test_path("transfer-stale");
        initialize_at(&path).expect("initialize order transfer database");
        seed_order_branch(&path, "3");

        save_customer_order_at(
            &path,
            &serde_json::json!({
                "id": "order-staying",
                "order_no": "ORD-STAYING",
                "customer_name": "Sita",
                "items": [{ "product_id": "004", "product_name": "Apple", "quantity": 4 }]
            }),
        )
        .expect("local order saves");
        let packed =
            set_customer_order_status_at(&path, "order-staying", "PACKED", &serde_json::json!({}))
                .expect("local order packs");
        assert_eq!(packed["entity_version"], 2);

        let stale = PulledChange {
            change_id: serde_json::json!(9104),
            branch_id: Some(3),
            entity_type: "customer_order".to_string(),
            entity_id: "order-staying".to_string(),
            operation_type: "TRANSFER_OUT".to_string(),
            version: Some(1),
            updated_at: Some("2026-08-27T08:00:00.000Z".to_string()),
            payload: serde_json::json!({
                "id": "order-staying",
                "order_no": "ORD-STAYING",
                "customer_name": "Sita",
                "status": "RECEIVED",
                "branch_id": "7",
                "transferred_to_branch_id": "7",
                "taken_at_branch_id": "3",
                "items": []
            }),
        };
        apply_pull_changes_at(
            &path,
            std::slice::from_ref(&stale),
            "cursor-transfer-4",
            Some("FZDEV-ORDERS".to_string()),
            Some("2026-08-28T13:00:00.000Z".to_string()),
        )
        .expect("a stale transfer is skipped, not an error");

        let still_there = order_row(&path, "order-staying");
        assert_eq!(
            still_there["status"], "PACKED",
            "a stale transfer must not remove an order the branch has since packed"
        );
        assert_eq!(still_there["entity_version"], 2);
        assert!(still_there["transferred_to_branch_id"].is_null());
        assert!(still_there["transferred_away_at"].is_null());

        // A genuinely newer transfer does take it away.
        let current = PulledChange { version: Some(3), ..stale };
        apply_pull_changes_at(
            &path,
            std::slice::from_ref(&current),
            "cursor-transfer-5",
            Some("FZDEV-ORDERS".to_string()),
            Some("2026-08-28T13:01:00.000Z".to_string()),
        )
        .expect("a newer transfer applies");
        let board = list_customer_orders_at(&path).expect("orders list");
        assert!(
            board["orders"]
                .as_array()
                .expect("orders array")
                .iter()
                .all(|order| order["id"] != "order-staying"),
            "the current transfer does move the order off this board"
        );
        let conn = Connection::open(&path).expect("open after newer transfer");
        let after = read_customer_order(&conn, "order-staying").expect("read order");
        assert_eq!(after["transferred_to_branch_id"], "7");
        assert_eq!(after["entity_version"], 3);
        drop(conn);

        let _ = fs::remove_file(&path);
    }

    /// An entity type this build does not know is kept, not destroyed, and does not stop the page.
    ///
    /// `apply_pull_changes_at` advances the pull cursor in the same transaction that applies the
    /// changes, so anything declined here is never offered again. The old `_ => {}` therefore
    /// destroyed it silently. It must still not be fatal — a device on older code has to go on
    /// syncing what it does understand — so this asserts both halves at once.
    #[test]
    fn an_unknown_entity_type_is_kept_rather_than_destroying_the_page() {
        let path = order_sync_test_path("unknown");
        initialize_at(&path).expect("initialize pull database");

        let unknown = PulledChange {
            change_id: serde_json::json!(1),
            branch_id: Some(1),
            entity_type: "delivery_route".to_string(),
            entity_id: "route-1".to_string(),
            operation_type: "UPSERT".to_string(),
            version: Some(2),
            updated_at: Some("2026-08-20T09:00:00.000Z".to_string()),
            payload: serde_json::json!({ "name": "Ring Road", "stops": 4 }),
        };
        let known = PulledChange {
            change_id: serde_json::json!(2),
            branch_id: Some(1),
            entity_type: "product".to_string(),
            entity_id: "product-1".to_string(),
            operation_type: "UPSERT".to_string(),
            version: Some(1),
            updated_at: Some("2026-08-20T09:00:00.000Z".to_string()),
            payload: serde_json::json!({ "product_name": "Apple", "branch_id": 1 }),
        };

        for _ in 0..2 {
            apply_pull_changes_at(
                &path,
                &[unknown.clone(), known.clone()],
                "cursor-9",
                Some("FZDEV-B".to_string()),
                Some("2026-08-20T09:31:00.000Z".to_string()),
            )
            .expect("one unknown type must not fail the whole page");
        }

        let conn = Connection::open(&path).expect("inspect after pull");
        let products: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_products WHERE id = 'product-1'", [], |row| {
                row.get(0)
            })
            .expect("count products");
        assert_eq!(products, 1, "the changes this build does understand must still apply");

        let (reason, payload, seen): (String, String, i64) = conn
            .query_row(
                "SELECT reason, payload, seen_count FROM local_unapplied_changes WHERE entity_id = 'route-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("the unknown change must be kept, not dropped");
        assert_eq!(reason, "ENTITY_TYPE_NOT_SUPPORTED");
        assert!(
            payload.contains("Ring Road"),
            "the change is kept whole so an upgraded build can apply it: {payload}"
        );
        assert_eq!(seen, 2, "a replay updates the kept row rather than piling up copies");
        drop(conn);

        // And it is counted, because a loss that reports itself as health is the failure this
        // whole table exists to prevent.
        let status = status_at(&path).expect("status");
        assert_eq!(status.unapplied_changes, 1);
        assert_eq!(status.current_cursor.as_deref(), Some("cursor-9"));

        let _ = fs::remove_file(&path);
    }

    /// A pulled order in a status this build cannot display is kept, not guessed at.
    ///
    /// Coercing it to RECEIVED would reserve fruit for an order that might have been cancelled.
    /// Letting the CHECK constraint reject it would abort the pull transaction and wedge the cursor
    /// behind it for every other change in the page. Neither; it is kept and skipped.
    #[test]
    fn a_pulled_order_in_an_unknown_status_is_kept_not_guessed_at() {
        let path = order_sync_test_path("badstatus");
        initialize_at(&path).expect("initialize pull database");

        let change = PulledChange {
            change_id: serde_json::json!(1),
            branch_id: Some(1),
            entity_type: "customer_order".to_string(),
            entity_id: "remote-order-2".to_string(),
            operation_type: "UPSERT".to_string(),
            version: Some(1),
            updated_at: Some("2026-08-20T09:00:00.000Z".to_string()),
            payload: serde_json::json!({
                "order_no": "ORD-REMOTE-2",
                "customer_name": "Anita",
                "status": "HALF_PACKED",
                "branch_id": "1",
                "items": [{ "product_id": "004", "product_name": "Apple", "quantity": 1 }]
            }),
        };
        apply_pull_changes_at(
            &path,
            std::slice::from_ref(&change),
            "cursor-4",
            Some("FZDEV-B".to_string()),
            Some("2026-08-20T09:31:00.000Z".to_string()),
        )
        .expect("an unreadable status must not fail the page");

        let conn = Connection::open(&path).expect("inspect");
        let orders: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_customer_orders", [], |row| row.get(0))
            .expect("count orders");
        assert_eq!(orders, 0, "an order in a status with no buttons must not be reserved against");
        let reason: String = conn
            .query_row(
                "SELECT reason FROM local_unapplied_changes WHERE entity_id = 'remote-order-2'",
                [],
                |row| row.get(0),
            )
            .expect("the skipped order must be kept");
        assert_eq!(reason, "CUSTOMER_ORDER_STATUS_NOT_RECOGNISED");
        drop(conn);
        let _ = fs::remove_file(&path);
    }

    /// A pulled order whose number is already used by a different local order is kept, not applied.
    ///
    /// `order_no` is UNIQUE. Letting the INSERT fail would abort the pull transaction and stall the
    /// cursor behind it permanently, which turns one collision into a device that never syncs again.
    #[test]
    fn a_pulled_order_number_collision_does_not_stall_the_cursor() {
        let path = order_sync_test_path("collision");
        initialize_at(&path).expect("initialize pull database");
        seed_order_branch(&path, "1");
        save_customer_order_at(
            &path,
            &serde_json::json!({
                "id": "order-local-2",
                "order_no": "ORD-CLASH",
                "customer_name": "Ram",
                "items": [{ "product_id": "004", "product_name": "Apple", "quantity": 1 }]
            }),
        )
        .expect("local order saves");

        let change = PulledChange {
            change_id: serde_json::json!(1),
            branch_id: Some(1),
            entity_type: "customer_order".to_string(),
            entity_id: "remote-order-3".to_string(),
            operation_type: "UPSERT".to_string(),
            version: Some(1),
            updated_at: Some("2026-08-20T09:00:00.000Z".to_string()),
            payload: serde_json::json!({
                "order_no": "ORD-CLASH",
                "customer_name": "Anita",
                "status": "RECEIVED",
                "branch_id": "1",
                "items": [{ "product_id": "004", "product_name": "Apple", "quantity": 1 }]
            }),
        };
        apply_pull_changes_at(
            &path,
            std::slice::from_ref(&change),
            "cursor-5",
            Some("FZDEV-ORDERS".to_string()),
            Some("2026-08-20T09:31:00.000Z".to_string()),
        )
        .expect("a collision must not stall the cursor");

        let conn = Connection::open(&path).expect("inspect");
        let reason: String = conn
            .query_row(
                "SELECT reason FROM local_unapplied_changes WHERE entity_id = 'remote-order-3'",
                [],
                |row| row.get(0),
            )
            .expect("the colliding order must be kept");
        assert_eq!(reason, "CUSTOMER_ORDER_NUMBER_ALREADY_USED");
        drop(conn);
        let status = status_at(&path).expect("status");
        assert_eq!(status.current_cursor.as_deref(), Some("cursor-5"), "the page still completed");
        let _ = fs::remove_file(&path);
    }

    /// An order that cannot resolve a branch is saved, refused the outbox, and says why.
    ///
    /// The server's `logSyncChange` throws on a change with no branch id, and a push batch is one
    /// Postgres transaction — so one branchless order would discard the acknowledgements for every
    /// other operation travelling with it. It must not be queued. It must also not become an order
    /// that silently never syncs, so the refusal is a named state on the record, and the next
    /// status change tries again.
    #[test]
    fn an_order_with_no_resolvable_branch_is_blocked_rather_than_queued_with_a_null() {
        let path = order_sync_test_path("nobranch");
        initialize_at(&path).expect("initialize order sync database");

        let saved = save_customer_order_at(
            &path,
            &serde_json::json!({
                "id": "order-nobranch",
                "order_no": "ORD-NOBRANCH",
                "customer_name": "Ram",
                "items": [{ "product_id": "004", "product_name": "Apple", "quantity": 1 }]
            }),
        )
        .expect("the order is still written down");
        assert_eq!(saved["sync_status"], "blocked");
        assert!(saved["sync_blocked_reason"].as_str().is_some_and(|r| !r.is_empty()));
        assert!(outbox_rows(&path).is_empty(), "a null branch must never reach the outbox");

        // The device learns its branch, and the next status change queues the order.
        seed_order_branch(&path, "5");
        let packed =
            set_customer_order_status_at(&path, "order-nobranch", "PACKED", &serde_json::json!({}))
                .expect("the order packs");
        assert_eq!(packed["sync_status"], "pending");
        assert!(packed["sync_blocked_reason"].is_null());
        let rows = outbox_rows(&path);
        assert_eq!(rows.len(), 1, "the retry queues the order once it has a branch");
        assert_eq!(rows[0].5.as_deref(), Some("5"));
        assert_eq!(rows[0].7["status"], "PACKED");

        let _ = fs::remove_file(&path);
    }

    /// The order tables exist, and their CHECK constraints are load-bearing rather than decorative.
    ///
    /// `status` and `source` are constrained in SQL as well as in
    /// `frontend/src/local/orderLifecycle.js` on purpose. The JS state machine decides which moves
    /// the app offers; the constraint decides what can end up in the file. A row written by a
    /// future sync arm, a repair script, or a hand-edited database still has to be a status this
    /// app knows how to display — an unrecognised one would render as an order stuck in a state
    /// with no buttons and no explanation.
    #[test]
    fn customer_order_tables_reject_states_the_app_cannot_display() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-customer-orders-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ));
        let _ = fs::remove_file(&path);
        initialize_at(&path).expect("initialize order database");
        let conn = Connection::open(&path).expect("open order database");

        conn.execute(
            "INSERT INTO local_customer_orders (id, order_no, customer_name, status, source) \
             VALUES ('order-1', 'ORD-1', 'Ram', 'RECEIVED', 'PHONE')",
            [],
        )
        .expect("a well-formed order is accepted");

        assert!(
            conn.execute(
                "INSERT INTO local_customer_orders (id, order_no, customer_name, status) \
                 VALUES ('order-2', 'ORD-2', 'Sita', 'HALF_PACKED')",
                [],
            )
            .is_err(),
            "an unknown status must be refused by the database, not only by the UI"
        );

        assert!(
            conn.execute(
                "INSERT INTO local_customer_orders (id, order_no, customer_name, source) \
                 VALUES ('order-3', 'ORD-3', 'Mohan', 'CARRIER_PIGEON')",
                [],
            )
            .is_err(),
            "an unknown order source must be refused"
        );

        // Quantity is the one that silently corrupts stock rather than merely looking wrong: a
        // zero- or negative-quantity line would reserve nothing, or worse, reserve backwards.
        assert!(
            conn.execute(
                "INSERT INTO local_customer_order_items (id, order_id, line_index, product_id, product_name, quantity) \
                 VALUES ('line-bad', 'order-1', 0, 'product-apple', 'Apple', 0)",
                [],
            )
            .is_err(),
            "a zero-quantity order line must be refused"
        );

        conn.execute(
            "INSERT INTO local_customer_order_items (id, order_id, line_index, product_id, product_name, quantity) \
             VALUES ('line-1', 'order-1', 0, '004', 'Apple', 10.5)",
            [],
        )
        .expect("a well-formed line is accepted");

        // Ids stay text. "004" must come back as "004": CLAUDE.md records numeric coercion of
        // canonical ids silently emptying the Inventory table.
        let product_id: String = conn
            .query_row(
                "SELECT product_id FROM local_customer_order_items WHERE id = 'line-1'",
                [],
                |row| row.get(0),
            )
            .expect("read the stored product id");
        assert_eq!(product_id, "004");

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

    /// Snapshot of every identity row, used to prove conflict resolution writes nothing.
    fn identity_rows(path: &Path) -> Vec<(String, String, Option<String>)> {
        let conn = Connection::open(path).expect("inspect identities");
        let mut statement = conn
            .prepare(
                "SELECT device_id, registration_status, last_seen_at
                 FROM local_device_identity ORDER BY device_id",
            )
            .expect("prepare identity inspection");
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .expect("query identities")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect identities");
        rows
    }

    #[test]
    fn conflicting_approved_identities_resolve_without_creating_or_overwriting() {
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
        let before = identity_rows(&path);

        // §2.5: ambiguous identities must not stop the app. Neither row carries a
        // last_seen_at, so the device_id tie-break decides and 'approved-a' wins.
        let identity = ensure_device_identity_with_preference_at(&path, Some("approved-a"))
            .expect("ambiguous approved identities must keep the app running");
        assert_eq!(identity["device_id"], "approved-a");
        assert_eq!(identity["identity_conflict"], true);
        assert_eq!(identity["identity_conflict_kind"], "MULTIPLE_APPROVED");
        assert_eq!(
            identity["identity_conflict_device_ids"],
            serde_json::json!(["approved-a", "approved-b"])
        );
        assert_eq!(identity["identity_conflict_selected"], "approved-a");

        // Still the guarantee that mattered: the conflict path creates and overwrites nothing.
        let conn = Connection::open(&path).expect("inspect conflicts");
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM local_device_identity", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 2);
        drop(conn);
        assert_eq!(identity_rows(&path), before, "conflict resolution must be read-only");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn multiple_approved_identities_select_the_most_recently_seen() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-device-conflict-recent-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ));
        let _ = fs::remove_file(&path);
        initialize_at(&path).expect("initialize conflict profile");
        let conn = Connection::open(&path).expect("seed conflicts");
        conn.execute(
            "INSERT INTO local_device_identity
               (device_id, device_name, platform, app_version, branch_id, registration_status, last_seen_at)
             VALUES ('approved-a', 'A', 'tauri-windows', '1.0.65', '1', 'approved', '2026-08-01T10:00:00.000Z'),
                    ('approved-z', 'Z', 'tauri-windows', '1.0.65', '1', 'approved', '2026-08-09T10:00:00.000Z')",
            [],
        )
        .expect("insert conflicts");
        drop(conn);
        let before = identity_rows(&path);

        let identity = ensure_device_identity_at(&path).expect("resolve conflicting identities");
        assert_eq!(
            identity["device_id"], "approved-z",
            "last_seen_at DESC must outrank the device_id tie-break"
        );
        assert_eq!(identity["identity_conflict"], true);
        assert_eq!(identity["identity_conflict_kind"], "MULTIPLE_APPROVED");
        assert_eq!(
            identity["identity_conflict_device_ids"],
            serde_json::json!(["approved-a", "approved-z"])
        );
        assert_eq!(identity["identity_conflict_selected"], "approved-z");
        assert_eq!(identity_rows(&path), before, "no row may be created or modified");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn multiple_provisional_identities_keep_the_app_running() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-device-provisional-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ));
        let _ = fs::remove_file(&path);
        initialize_at(&path).expect("initialize provisional profile");
        let conn = Connection::open(&path).expect("seed provisional identities");
        conn.execute(
            "INSERT INTO local_device_identity
               (device_id, device_name, platform, app_version, branch_id, registration_status, last_seen_at)
             VALUES ('pending-a', 'A', 'tauri-windows', '1.0.65', '1', 'pending', '2026-08-02T10:00:00.000Z'),
                    ('pending-b', 'B', 'tauri-windows', '1.0.65', '1', 'pending', NULL)",
            [],
        )
        .expect("insert provisional identities");
        drop(conn);
        let before = identity_rows(&path);

        // This shape used to block startup outright, which §2.5 forbids.
        let identity = ensure_device_identity_at(&path)
            .expect("multiple provisional identities must never block startup");
        assert_eq!(
            identity["device_id"], "pending-a",
            "a NULL last_seen_at is the oldest, so the seen device wins"
        );
        assert_eq!(identity["identity_conflict"], true);
        assert_eq!(identity["identity_conflict_kind"], "MULTIPLE_PROVISIONAL");
        assert_eq!(
            identity["identity_conflict_device_ids"],
            serde_json::json!(["pending-a", "pending-b"])
        );
        assert_eq!(identity["identity_conflict_selected"], "pending-a");
        assert_eq!(identity_rows(&path), before, "no row may be created or modified");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn conflicting_identity_selection_is_stable_across_calls() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-device-conflict-stable-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ));
        let _ = fs::remove_file(&path);
        initialize_at(&path).expect("initialize conflict profile");
        let conn = Connection::open(&path).expect("seed conflicts");
        conn.execute(
            "INSERT INTO local_device_identity
               (device_id, device_name, platform, app_version, branch_id, registration_status, last_seen_at)
             VALUES ('pending-b', 'B', 'tauri-windows', '1.0.65', '1', 'pending', '2026-08-05T10:00:00.000Z'),
                    ('pending-a', 'A', 'tauri-windows', '1.0.65', '1', 'pending', '2026-08-05T10:00:00.000Z')",
            [],
        )
        .expect("insert conflicts");
        drop(conn);

        let first = ensure_device_identity_at(&path).expect("first resolve");
        let second = ensure_device_identity_at(&path).expect("second resolve");
        assert_eq!(first["device_id"], second["device_id"], "selection must be deterministic");
        assert_eq!(first["device_id"], "pending-a", "equal timestamps fall back to device_id ASC");
        let count: i64 = Connection::open(&path)
            .expect("inspect conflicts")
            .query_row("SELECT COUNT(*) FROM local_device_identity", [], |row| row.get(0))
            .expect("count identities");
        assert_eq!(count, 2, "repeated resolves must not add rows");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn a_single_identity_reports_no_conflict_fields() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-device-single-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ));
        let _ = fs::remove_file(&path);
        initialize_at(&path).expect("initialize single-identity profile");
        let conn = Connection::open(&path).expect("seed single identity");
        conn.execute(
            "INSERT INTO local_device_identity (device_id, device_name, platform, app_version, branch_id, registration_status)
             VALUES ('only-device', 'Only', 'tauri-windows', '1.0.65', '1', 'approved')",
            [],
        )
        .expect("insert single identity");
        drop(conn);

        let identity = ensure_device_identity_at(&path).expect("resolve single identity");
        assert_eq!(identity["device_id"], "only-device");
        for field in [
            "identity_conflict",
            "identity_conflict_kind",
            "identity_conflict_device_ids",
            "identity_conflict_selected",
        ] {
            assert!(
                identity.get(field).is_none(),
                "the normal path must stay clean: {field} must not be emitted"
            );
        }
        // A newly created identity is equally clean.
        let fresh = std::env::temp_dir().join(format!(
            "froozerp-device-fresh-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ));
        let _ = fs::remove_file(&fresh);
        initialize_at(&fresh).expect("initialize fresh profile");
        let created = ensure_device_identity_at(&fresh).expect("create identity");
        assert!(created.get("identity_conflict").is_none());
        let _ = fs::remove_file(&fresh);
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

    /// An absolute path on the host, not only on Windows.
    ///
    /// `Path::is_absolute` is platform-dependent: `F:\\anything` is absolute on Windows and
    /// relative everywhere else. The test below turns on exactly that predicate, so hard-coded
    /// Windows literals made it assert the opposite of its name off Windows. Windows is the shipped
    /// target and stays the first argument; the second only exists so the test is meaningful when it
    /// is run anywhere else.
    fn absolute_here(windows: &str, unix: &str) -> PathBuf {
        PathBuf::from(if cfg!(windows) { windows } else { unix })
    }

    #[test]
    fn isolated_sqlite_override_is_absolute_and_test_only() {
        let default_dir = absolute_here(
            r"C:\Users\Example\AppData\Roaming\com.srtcompany.froozerp",
            "/home/example/.local/share/com.srtcompany.froozerp",
        );
        let isolated_dir = absolute_here(
            r"F:\FroozERP\_recovery_backups\disposable-profile",
            "/tmp/froozerp-disposable-profile",
        );

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
                Some(absolute_here(r"F:\ignored", "/tmp/ignored")),
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
            assert_eq!(migration_count, EXPECTED_APPLIED_MIGRATIONS);
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
        assert_eq!(migration_count, EXPECTED_APPLIED_MIGRATIONS);
        assert_eq!(marker, "keep-me");
        drop(conn);
        let _ = fs::remove_file(&path);
    }

    /// Migration 023 backfills provenance from the branch that was already on the row.
    ///
    /// Every order written before the split was typed in on a device at the branch that is handling
    /// it — there was no way to move one — so `taken_at_branch_id := branch_id` is the true value
    /// and not a guess. Leaving it NULL would claim we do not know where those orders were taken.
    /// A row that never had a branch at all stays NULL, because that is the honest answer for it.
    #[test]
    fn migration_023_backfills_provenance_onto_orders_written_before_the_split() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-order-transfer-backfill-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ));
        let _ = fs::remove_file(&path);

        // A profile at the schema this migration upgrades from: everything up to and including 022,
        // and nothing after it.
        let mut conn = Connection::open(&path).expect("open pre-023 database");
        conn.execute_batch(
            "CREATE TABLE local_schema_migrations (
                version TEXT PRIMARY KEY,
                applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                checksum TEXT NOT NULL,
                status TEXT NOT NULL
            );",
        )
        .expect("create migration table");
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
            ("013_operational_location_foundation", MIGRATION_013),
            ("014_offline_purchase_grn", MIGRATION_014),
            ("015_supplier_reference_cache", MIGRATION_015),
            ("016_purchase_aggregate_reconciliation", MIGRATION_016),
            ("017_offline_entitlement_foundation", MIGRATION_017),
            ("018_bootstrap_credential_consumption", MIGRATION_018),
            ("019_provisional_lot_cost_status", MIGRATION_019),
            ("020_customer_orders", MIGRATION_020),
            ("021_customer_order_payment", MIGRATION_021),
            ("022_customer_order_sync", MIGRATION_022),
        ] {
            apply_migration(&mut conn, version, sql).expect("apply pre-023 migration");
        }
        conn.execute(
            "INSERT INTO local_customer_orders (id, order_no, customer_name, status, branch_id)
             VALUES ('order-pre-023', 'ORD-PRE-023', 'Ram', 'RECEIVED', 4)",
            [],
        )
        .expect("insert a pre-split order");
        conn.execute(
            "INSERT INTO local_customer_orders (id, order_no, customer_name, status)
             VALUES ('order-pre-023-branchless', 'ORD-PRE-023-NB', 'Sita', 'RECEIVED')",
            [],
        )
        .expect("insert a pre-split order that never resolved a branch");
        drop(conn);

        initialize_at(&path).expect("upgrade the pre-023 profile");

        let conn = Connection::open(&path).expect("inspect the upgraded profile");
        let migrations: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_schema_migrations WHERE status = 'APPLIED'",
                [],
                |row| row.get(0),
            )
            .expect("migration count");
        assert_eq!(migrations, EXPECTED_APPLIED_MIGRATIONS);

        let (taken, branch): (Option<String>, i64) = conn
            .query_row(
                "SELECT taken_at_branch_id, branch_id FROM local_customer_orders
                  WHERE id = 'order-pre-023'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read the backfilled order");
        // Text, not 4. `taken_at_branch_id` is TEXT and SQLite applies the target column's affinity
        // on UPDATE, which is the shape the rest of the codebase and the wire use for a branch id.
        assert_eq!(taken.as_deref(), Some("4"), "provenance is backfilled from the branch that was there");
        assert_eq!(branch, 4, "and the fulfilment branch is left exactly as it was");

        let branchless: Option<String> = conn
            .query_row(
                "SELECT taken_at_branch_id FROM local_customer_orders
                  WHERE id = 'order-pre-023-branchless'",
                [],
                |row| row.get(0),
            )
            .expect("read the branchless order");
        assert!(
            branchless.is_none(),
            "an order that never had a branch must not be given one by the backfill"
        );
        drop(conn);

        // Forward-only and version-gated: a restart re-runs nothing and changes nothing. SQLite has
        // no ADD COLUMN IF NOT EXISTS, so a second run of this file would fail outright — the gate
        // in apply_migration() is what makes it idempotent.
        initialize_at(&path).expect("restart with the upgraded profile");
        let conn = Connection::open(&path).expect("inspect after restart");
        let taken_again: Option<String> = conn
            .query_row(
                "SELECT taken_at_branch_id FROM local_customer_orders WHERE id = 'order-pre-023'",
                [],
                |row| row.get(0),
            )
            .expect("read after restart");
        assert_eq!(taken_again.as_deref(), Some("4"));
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

    #[test]
    fn grandfathering_still_fires_for_the_selected_identity_under_conflict() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-grandfather-conflict-{}-{}.sqlite3",
            std::process::id(),
            unique_local_id("test")
        ));
        let _ = fs::remove_file(&path);
        let device_id = "FZDEV-LEGACY-SELECTED";
        seed_legacy_profile(&path, device_id, true);
        let conn = Connection::open(&path).expect("open legacy profile");
        conn.execute(
            "UPDATE local_device_identity SET last_seen_at = '2026-08-10T10:00:00.000Z' WHERE device_id = ?1",
            params![device_id],
        )
        .expect("mark the legacy device as most recently seen");
        conn.execute(
            "INSERT INTO local_device_identity
               (device_id,device_name,platform,app_version,branch_id,registration_status,company_id,last_seen_at)
             VALUES ('FZDEV-LEGACY-RIVAL','Rival','tauri-windows','1.0.71','7','approved','3','2026-07-01T10:00:00.000Z')",
            [],
        )
        .expect("insert a competing approved identity");
        drop(conn);

        let identity = ensure_device_identity_at(&path).expect("resolve conflicting identities");
        assert_eq!(identity["device_id"], device_id);
        assert_eq!(identity["identity_conflict_kind"], "MULTIPLE_APPROVED");
        assert_eq!(
            entitlement_rows(&path),
            1,
            "the selected approved identity must still be grandfathered"
        );
        let conn = Connection::open(&path).expect("open profile");
        let serial: String = conn
            .query_row("SELECT entitlement_serial FROM local_entitlement", [], |row| row.get(0))
            .expect("read shim serial");
        assert_eq!(serial, format!("LEGACY-{device_id}"), "the shim binds the selected device");
        drop(conn);

        // Non-fatal and idempotent, exactly as on the single-approved path.
        ensure_device_identity_at(&path).expect("resolve again");
        assert_eq!(entitlement_rows(&path), 1);
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

    // ---- Stage 6: local promotion of registration_status (§6.3, §12) ----------------------

    /// Insert a pending identity the way `ensure_device_identity_*` does for a new device.
    fn seed_pending_identity(path: &Path, device_id: &str) {
        initialize_at(path).expect("init");
        let conn = Connection::open(path).expect("open");
        conn.execute(
            "INSERT INTO local_device_identity (device_id, device_name, platform, app_version,
                 branch_id, registration_status, last_seen_at, updated_at)
             VALUES (?1, 'Test Device', 'tauri-windows', '1.0.0', 'unassigned', 'pending',
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            params![device_id],
        )
        .expect("seed identity");
    }

    fn identity_status(path: &Path, device_id: &str) -> Option<(String, String, Option<String>)> {
        let conn = Connection::open(path).expect("open");
        conn.query_row(
            "SELECT registration_status, branch_id, company_id FROM local_device_identity WHERE device_id = ?1",
            params![device_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .expect("query identity")
    }

    #[test]
    fn a_verified_entitlement_promotes_the_device_locally_with_payload_scope() {
        // The point of Stage 6: approval stops requiring a cloud lookup. The signature over this
        // device's own binding is the evidence, and the scope comes from the signed payload.
        let path = activation_temp_path("promote-verified");
        let _ = fs::remove_file(&path);
        let device = "FZDEV-PROMOTE-1";
        seed_pending_identity(&path, device);
        assert_eq!(identity_status(&path, device).unwrap().0, "pending");

        let payload = build_payload(device, 7001, today_day().saturating_sub(5), 365, None);
        let sig = sign_payload(&payload);
        let result =
            accept_entitlement_at(&path, device, &payload, &sig, "OFFLINE_FILE", &test_trusted_keys())
                .expect("genuine code must be accepted");

        assert_eq!(result["identity_promoted"], serde_json::json!(true));
        let (status, branch, company) = identity_status(&path, device).expect("identity row");
        assert_eq!(status, "approved");
        assert_eq!(branch, "1", "branch must come from the signed payload");
        assert_eq!(company.as_deref(), Some("1"), "company must come from the signed payload");

        let conn = Connection::open(&path).expect("open");
        let promoted_events: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_entitlement_audit WHERE event = 'DEVICE_PROMOTED'",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(promoted_events, 1, "promotion must be auditable");
    }

    #[test]
    fn a_rejected_code_never_promotes_the_device() {
        // A code for another device must leave the identity exactly as it was.
        let path = activation_temp_path("promote-rejected");
        let _ = fs::remove_file(&path);
        let device = "FZDEV-PROMOTE-2";
        seed_pending_identity(&path, device);

        let payload = build_payload("FZDEV-SOMEONE-ELSE", 7002, today_day(), 365, None);
        let sig = sign_payload(&payload);
        let err = accept_entitlement_at(
            &path,
            device,
            &payload,
            &sig,
            "OFFLINE_FILE",
            &test_trusted_keys(),
        )
        .expect_err("a code bound elsewhere must be refused");
        assert!(err.starts_with("DEVICE_BINDING_MISMATCH"), "got {err}");
        assert_eq!(identity_status(&path, device).unwrap().0, "pending");
    }

    #[test]
    fn acceptance_never_invents_an_identity_row() {
        // Creation belongs to ensure_device_identity_*. If an activation file could conjure an
        // identity, it could register a device that never existed.
        let path = activation_temp_path("promote-no-identity");
        let _ = fs::remove_file(&path);
        let device = "FZDEV-PROMOTE-3";
        initialize_at(&path).expect("init");

        let payload = build_payload(device, 7003, today_day().saturating_sub(2), 365, None);
        let sig = sign_payload(&payload);
        let result =
            accept_entitlement_at(&path, device, &payload, &sig, "OFFLINE_FILE", &test_trusted_keys())
                .expect("acceptance still succeeds");
        assert_eq!(result["identity_promoted"], serde_json::json!(false));
        assert!(identity_status(&path, device).is_none(), "no identity may be created here");
    }

    #[test]
    fn a_snapshot_cannot_move_a_signed_device_to_another_branch() {
        // Found by audit: `branch_id = excluded.branch_id` is an unconditional overwrite, and the
        // snapshot's branch is client-supplied (App.jsx falls back to "1"). Without the signed-scope
        // override, redeeming a code for branch 7 then caching any snapshot would silently relocate
        // the device to branch 1 — making the promotion cosmetic.
        let path = activation_temp_path("signed-scope-wins");
        let _ = fs::remove_file(&path);
        let device = "FZDEV-SCOPE-1";
        seed_pending_identity(&path, device);

        // A payload carrying company 1 / branch 1, accepted and promoted.
        let payload = build_payload(device, 7100, today_day().saturating_sub(3), 365, None);
        let sig = sign_payload(&payload);
        accept_entitlement_at(&path, device, &payload, &sig, "OFFLINE_FILE", &test_trusted_keys())
            .expect("accepted");
        assert_eq!(identity_status(&path, device).unwrap().1, "1");

        // A snapshot now claims a different branch entirely.
        let snapshot = serde_json::json!({
            "device_identity": { "device_id": device, "branch_id": "99" },
            "branch_context": { "branch_id": "99" },
            "user_profile": { "id": "user-1", "company_id": "99" },
            "products": [],
            "inventory_lots": [],
        });
        cache_reference_snapshot_at(&path, &snapshot).expect("snapshot caches");

        let (status, branch, company) = identity_status(&path, device).expect("identity row");
        assert_eq!(status, "approved");
        assert_eq!(branch, "1", "the signed branch must survive an unsigned snapshot");
        assert_eq!(
            company.as_deref(),
            Some("1"),
            "the signed company must survive an unsigned snapshot"
        );
    }

    #[test]
    fn a_snapshot_still_sets_scope_when_no_signed_entitlement_exists() {
        // The override must not freeze scope for devices that have no entitlement yet — the
        // ordinary cloud-provisioned path still needs the snapshot to be authoritative.
        let path = activation_temp_path("unsigned-scope-applies");
        let _ = fs::remove_file(&path);
        let device = "FZDEV-SCOPE-2";
        seed_pending_identity(&path, device);

        let snapshot = serde_json::json!({
            "device_identity": { "device_id": device, "branch_id": "42" },
            "branch_context": { "branch_id": "42" },
            "user_profile": { "id": "user-1", "company_id": "42" },
            "products": [],
            "inventory_lots": [],
        });
        cache_reference_snapshot_at(&path, &snapshot).expect("snapshot caches");

        let (_, branch, company) = identity_status(&path, device).expect("identity row");
        assert_eq!(branch, "42");
        assert_eq!(company.as_deref(), Some("42"));
    }

    // ---- Stage 8: canonical_snapshot_scope (design §6.4) -----------------------------------

    fn seed_operational_location(conn: &Connection, id: &str, company: &str, branch: &str) {
        conn.execute(
            "INSERT INTO local_operational_locations
                (id, company_id, branch_id, location_code, location_name, updated_at)
             VALUES (?1, ?2, ?3, 'LOC', 'Location', strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            params![id, company, branch],
        )
        .expect("seed location");
    }

    fn seed_device_assignment(path: &Path, device_id: &str, company: &str, branch: &str, location: &str) {
        initialize_at(path).expect("init");
        let conn = Connection::open(path).expect("open");
        conn.pragma_update(None, "foreign_keys", "ON").expect("fk on");
        seed_operational_location(&conn, location, company, branch);
        conn.execute(
            "INSERT INTO local_device_assignment
                (device_id, company_id, branch_id, operational_location_id, intended_usage,
                 assignment_generation, server_confirmed_at)
             VALUES (?1, ?2, ?3, ?4, 'GENERAL', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            params![device_id, company, branch, location],
        )
        .expect("seed assignment");
    }

    fn accept_scoped_entitlement(path: &Path, device_id: &str, company: u64, branch: u64, serial: u32) {
        seed_pending_identity(path, device_id);
        let mut payload = Vec::new();
        payload.push(crate::entitlement::FORMAT_VERSION);
        payload.push(0x01);
        payload.push(0);
        put_varint_test(&mut payload, company);
        put_varint_test(&mut payload, branch);
        payload.extend_from_slice(&crate::entitlement::device_binding_hash(device_id));
        payload.extend_from_slice(&serial.to_le_bytes());
        payload.extend_from_slice(&today_day().saturating_sub(5).to_le_bytes());
        payload.extend_from_slice(&365u16.to_le_bytes());
        let sig = sign_payload(&payload);
        accept_entitlement_at(path, device_id, &payload, &sig, "OFFLINE_FILE", &test_trusted_keys())
            .expect("scoped entitlement accepted");
    }

    fn scope_of(path: &Path, device_id: &str) -> serde_json::Value {
        let conn = Connection::open(path).expect("open");
        canonical_snapshot_scope_at(&conn, device_id)
    }

    #[test]
    fn rung1_a_verified_entitlement_alone_supplies_company_and_branch() {
        let path = activation_temp_path("scope-rung1");
        let _ = fs::remove_file(&path);
        let device = "FZDEV-SCOPE-R1";
        accept_scoped_entitlement(&path, device, 7, 3, 8001);

        let scope = scope_of(&path, device);
        assert_eq!(scope["company_id"], serde_json::json!("7"));
        assert_eq!(scope["branch_id"], serde_json::json!("3"));
        assert_eq!(scope["operational_location_id"], serde_json::Value::Null);
        assert_eq!(scope["source"], serde_json::json!("entitlement"));
        assert_eq!(scope["warnings"], serde_json::json!([]));
    }

    #[test]
    fn rung2_an_assignment_alone_supplies_full_scope() {
        let path = activation_temp_path("scope-rung2-alone");
        let _ = fs::remove_file(&path);
        let device = "FZDEV-SCOPE-R2A";
        seed_device_assignment(&path, device, "9", "4", "loc-9-4");

        let scope = scope_of(&path, device);
        assert_eq!(scope["company_id"], serde_json::json!("9"));
        assert_eq!(scope["branch_id"], serde_json::json!("4"));
        assert_eq!(scope["operational_location_id"], serde_json::json!("loc-9-4"));
        assert_eq!(scope["source"], serde_json::json!("device_assignment"));
        assert_eq!(scope["warnings"], serde_json::json!([]));
    }

    #[test]
    fn rung2_only_adds_the_location_when_rung1_already_resolved_scope() {
        let path = activation_temp_path("scope-rung1-plus-2");
        let _ = fs::remove_file(&path);
        let device = "FZDEV-SCOPE-R12";
        accept_scoped_entitlement(&path, device, 5, 2, 8002);
        seed_device_assignment(&path, device, "5", "2", "loc-5-2");

        let scope = scope_of(&path, device);
        // company/branch still say the entitlement supplied them, not the assignment.
        assert_eq!(scope["source"], serde_json::json!("entitlement"));
        assert_eq!(scope["company_id"], serde_json::json!("5"));
        assert_eq!(scope["branch_id"], serde_json::json!("2"));
        assert_eq!(scope["operational_location_id"], serde_json::json!("loc-5-2"));
        assert_eq!(scope["warnings"], serde_json::json!([]), "agreement raises no warning");
    }

    #[test]
    fn a_disagreeing_assignment_is_flagged_but_the_entitlement_still_wins() {
        let path = activation_temp_path("scope-conflict");
        let _ = fs::remove_file(&path);
        let device = "FZDEV-SCOPE-CONFLICT";
        accept_scoped_entitlement(&path, device, 5, 2, 8003);
        // A stale or wrong assignment naming a different branch entirely.
        seed_device_assignment(&path, device, "5", "9", "loc-5-9");

        let scope = scope_of(&path, device);
        assert_eq!(scope["branch_id"], serde_json::json!("2"), "the signed scope must still win");
        assert_eq!(
            scope["operational_location_id"],
            serde_json::json!("loc-5-9"),
            "the location is still useful even when branch disagrees"
        );
        let warnings = scope["warnings"].as_array().expect("warnings array");
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0]["code"], serde_json::json!("DEVICE_SCOPE_CONFLICT"));
    }

    #[test]
    fn rung3_an_approved_identity_supplies_branch_only_never_company() {
        let path = activation_temp_path("scope-rung3");
        let _ = fs::remove_file(&path);
        let device = "FZDEV-SCOPE-R3";
        seed_pending_identity(&path, device);
        {
            let conn = Connection::open(&path).expect("open");
            conn.execute(
                "UPDATE local_device_identity SET registration_status='approved', branch_id='6' WHERE device_id=?1",
                params![device],
            )
            .expect("approve");
        }

        let scope = scope_of(&path, device);
        assert_eq!(scope["branch_id"], serde_json::json!("6"));
        assert_eq!(scope["company_id"], serde_json::Value::Null, "rung 3 must never supply company");
        assert_eq!(scope["source"], serde_json::json!("device_identity"));
    }

    #[test]
    fn rung3_unassigned_branch_does_not_count_as_a_real_scope() {
        let path = activation_temp_path("scope-rung3-unassigned");
        let _ = fs::remove_file(&path);
        let device = "FZDEV-SCOPE-R3-UNASSIGNED";
        seed_pending_identity(&path, device);
        {
            let conn = Connection::open(&path).expect("open");
            conn.execute(
                "UPDATE local_device_identity SET registration_status='approved', branch_id='unassigned' WHERE device_id=?1",
                params![device],
            )
            .expect("approve");
        }

        let scope = scope_of(&path, device);
        assert_eq!(scope["branch_id"], serde_json::Value::Null);
        assert_eq!(scope["source"], serde_json::json!("unscoped"));
    }

    #[test]
    fn a_stale_identity_branch_is_flagged_but_the_resolved_scope_still_wins() {
        let path = activation_temp_path("scope-mismatch");
        let _ = fs::remove_file(&path);
        let device = "FZDEV-SCOPE-MISMATCH";
        accept_scoped_entitlement(&path, device, 5, 2, 8004);
        {
            let conn = Connection::open(&path).expect("open");
            conn.execute(
                "UPDATE local_device_identity SET branch_id='99' WHERE device_id=?1",
                params![device],
            )
            .expect("stale identity branch");
        }

        let scope = scope_of(&path, device);
        assert_eq!(scope["branch_id"], serde_json::json!("2"), "the entitlement's branch must still win");
        let warnings = scope["warnings"].as_array().expect("warnings array");
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0]["code"], serde_json::json!("DEVICE_SCOPE_MISMATCH"));
    }

    #[test]
    fn rung4_a_device_with_nothing_at_all_is_unscoped_not_an_error() {
        let path = activation_temp_path("scope-rung4");
        let _ = fs::remove_file(&path);
        initialize_at(&path).expect("init");

        let scope = scope_of(&path, "FZDEV-SCOPE-NOTHING");
        assert_eq!(scope["company_id"], serde_json::Value::Null);
        assert_eq!(scope["branch_id"], serde_json::Value::Null);
        assert_eq!(scope["operational_location_id"], serde_json::Value::Null);
        assert_eq!(scope["source"], serde_json::json!("unscoped"));
        assert_eq!(scope["warnings"], serde_json::json!([]));
    }

    #[test]
    fn an_unscoped_device_still_loads_a_full_snapshot_without_erroring() {
        // The point of D-6: scope resolution must never abort the snapshot build.
        let path = activation_temp_path("scope-rung4-snapshot");
        let _ = fs::remove_file(&path);
        let device = "FZDEV-SCOPE-SNAPSHOT-UNSCOPED";
        initialize_at(&path).expect("init");

        let snapshot = load_reference_snapshot_at(&path, None, Some(device))
            .expect("a snapshot must still load with nothing to scope from");
        assert_eq!(snapshot["canonical_scope"]["source"], serde_json::json!("unscoped"));
    }

    #[test]
    fn a_scoped_snapshot_carries_canonical_scope_without_touching_branch_context() {
        // Additive only: branch_context is untouched by this stage, exactly as it was before.
        let path = activation_temp_path("scope-additive");
        let _ = fs::remove_file(&path);
        let device = "FZDEV-SCOPE-ADDITIVE";
        accept_scoped_entitlement(&path, device, 11, 4, 8005);

        let snapshot_before = serde_json::json!({
            "device_identity": { "device_id": device },
            "branch_context": { "branch_id": "1", "branch_name": "Main Branch" },
            "user_profile": {},
            "products": [],
            "inventory_lots": [],
        });
        cache_reference_snapshot_at(&path, &snapshot_before).expect("caches");

        let snapshot = load_reference_snapshot_at(&path, None, Some(device)).expect("loads");
        assert_eq!(
            snapshot["branch_context"]["branch_id"],
            serde_json::json!("1"),
            "the existing cached branch_context must be completely unaffected"
        );
        assert_eq!(snapshot["canonical_scope"]["branch_id"], serde_json::json!("4"));
        assert_eq!(snapshot["canonical_scope"]["source"], serde_json::json!("entitlement"));
    }

    #[test]
    fn a_snapshot_omitting_registration_status_never_upgrades_the_device() {
        // The defect being removed: an absent field used to mean "approved", so the desktop
        // building its own snapshot approved itself.
        let path = activation_temp_path("snapshot-no-upgrade");
        let _ = fs::remove_file(&path);
        let device = "FZDEV-SNAPSHOT-1";
        seed_pending_identity(&path, device);

        let snapshot = serde_json::json!({
            "device_identity": { "device_id": device, "branch_id": "1" },
            "user_profile": { "id": "user-1", "company_id": "1" },
            "products": [],
            "inventory_lots": [],
        });
        cache_reference_snapshot_at(&path, &snapshot).expect("snapshot caches");

        assert_eq!(
            identity_status(&path, device).unwrap().0,
            "pending",
            "an omitted status must preserve the existing one, never upgrade it"
        );
    }

    #[test]
    fn a_snapshot_omitting_registration_status_leaves_an_approved_device_approved() {
        // The other direction: preserving the existing status must not DEMOTE a legitimately
        // approved device either. Absent means "unchanged", not "pending".
        let path = activation_temp_path("snapshot-no-demote");
        let _ = fs::remove_file(&path);
        let device = "FZDEV-SNAPSHOT-2";
        seed_pending_identity(&path, device);
        {
            let conn = Connection::open(&path).expect("open");
            conn.execute(
                "UPDATE local_device_identity SET registration_status = 'approved' WHERE device_id = ?1",
                params![device],
            )
            .expect("approve");
        }

        let snapshot = serde_json::json!({
            "device_identity": { "device_id": device, "branch_id": "1" },
            "user_profile": { "id": "user-1", "company_id": "1" },
            "products": [],
            "inventory_lots": [],
        });
        cache_reference_snapshot_at(&path, &snapshot).expect("snapshot caches");

        assert_eq!(identity_status(&path, device).unwrap().0, "approved");
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
            assert_eq!(migrations, EXPECTED_APPLIED_MIGRATIONS);
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
    // ---- Stock is scoped to the shop it is sitting in (docs/stock-distribution-decision.md) ----
    //
    // Ratanada holds 15 kg of apples and Main Branch holds 20. A cashier at Ratanada must bill
    // against Ratanada's 15 and must never be able to reach Main Branch's crate: selling it makes
    // both shops' counts wrong and prints the wrong shop on the bill, and the error is silent for
    // days. These four tests cover the two places the device is responsible for — what the
    // snapshot tells the frontend, and what the pull path lets onto the shelf.

    fn seed_scoped_product(conn: &Connection, id: &str, name: &str) {
        conn.execute(
            "INSERT INTO local_products (id, product_name, unit, sale_rate, active)
             VALUES (?1, ?2, 'KG', 100, 1)",
            params![id, name],
        )
        .expect("seed product");
    }

    /// Written with SQL rather than through the pull path on purpose: the point of the snapshot
    /// tests is a device that already holds several shops' lots, and the pull path now refuses to
    /// create exactly that situation.
    #[allow(clippy::too_many_arguments)]
    fn seed_scoped_lot(
        conn: &Connection,
        id: &str,
        product_id: &str,
        branch: &str,
        company: &str,
        location: &str,
        balance: f64,
        status: &str,
        deleted: bool,
    ) {
        conn.execute(
            "INSERT INTO local_inventory_lots (
                id, branch_id, company_id, operational_location_id, product_id, product_name,
                lot_no, opening_date, opening_qty, balance_qty, cost_rate, status, deleted_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, 'Apples', ?1, '2026-08-01', ?6, ?6, 10, ?7, ?8)",
            params![
                id,
                branch,
                company,
                location,
                product_id,
                balance,
                status,
                if deleted { Some("2026-08-02T00:00:00.000Z") } else { None },
            ],
        )
        .expect("seed lot");
    }

    #[test]
    fn snapshot_lots_carry_the_shop_they_are_sitting_in() {
        // Before this, the SELECT behind `inventory_lots` listed eighteen columns and none of them
        // was scope, so `branch_id`, `company_id` and `operational_location_id` never reached
        // JavaScript at all. The frontend could not filter a cashier down to their own shop even
        // if it wanted to — the fields were not in the objects it received. It only looked correct
        // because there is one shop today.
        let path = activation_temp_path("scoped-lot-snapshot");
        let _ = fs::remove_file(&path);
        let device = "FZDEV-STOCK-SCOPE-1";
        seed_device_assignment(&path, device, "1", "3", "loc-ratanada");

        {
            let conn = Connection::open(&path).expect("open scoped snapshot database");
            seed_scoped_product(&conn, "product-apple", "Apples");
            seed_scoped_lot(&conn, "lot-ratanada", "product-apple", "3", "1", "loc-ratanada", 15.0, "ACTIVE", false);
            seed_scoped_lot(&conn, "lot-main", "product-apple", "4", "1", "loc-main", 20.0, "ACTIVE", false);
        }

        let snapshot = load_reference_snapshot_at(&path, None, Some(device)).expect("load snapshot");
        let lots = snapshot["inventory_lots"].as_array().expect("lot list");

        // Both shops' lots are still emitted. The snapshot's job is to make the filter possible,
        // not to apply it: filtering here would decide for a caller that never asked, and would
        // leave the product aggregate counting a universe the list does not show.
        assert_eq!(lots.len(), 2);

        for lot in lots {
            for field in ["branch_id", "company_id", "operational_location_id"] {
                assert!(
                    lot.get(field).is_some_and(|value| !value.is_null()),
                    "lot {:?} must carry {field}; a lot with no scope cannot be filtered to a shop \
                     and would be billable from every counter",
                    lot["id"],
                );
            }
        }

        let ratanada = lots.iter().find(|lot| lot["id"] == "lot-ratanada").expect("ratanada lot");
        assert_eq!(ratanada["branch_id"], serde_json::json!("3"));
        assert_eq!(ratanada["company_id"], serde_json::json!("1"));
        assert_eq!(ratanada["operational_location_id"], serde_json::json!("loc-ratanada"));
        assert_eq!(ratanada["remaining_qty"], serde_json::json!(15.0));

        let main = lots.iter().find(|lot| lot["id"] == "lot-main").expect("main lot");
        assert_eq!(main["branch_id"], serde_json::json!("4"));
        assert_eq!(main["operational_location_id"], serde_json::json!("loc-main"));

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn product_aggregate_and_lot_list_agree_about_which_lots_exist() {
        // The summary-vs-detail guard. `products.current_stock` and `product_stock_by_scope` are
        // separate queries from the lot list, and CLAUDE.md's rule is that a panel's total and its
        // table must be derived from the same filtered source or they will eventually disagree —
        // and the disagreement will look like data loss rather than like a bug. This test is what
        // catches the two predicates being edited apart.
        let path = activation_temp_path("scoped-aggregate-agreement");
        let _ = fs::remove_file(&path);
        let device = "FZDEV-STOCK-SCOPE-2";
        seed_device_assignment(&path, device, "1", "3", "loc-ratanada");

        {
            let conn = Connection::open(&path).expect("open aggregate database");
            seed_scoped_product(&conn, "product-apple", "Apples");
            seed_scoped_lot(&conn, "lot-r1", "product-apple", "3", "1", "loc-ratanada", 15.0, "ACTIVE", false);
            seed_scoped_lot(&conn, "lot-r2", "product-apple", "3", "1", "loc-ratanada", 5.0, "ACTIVE", false);
            seed_scoped_lot(&conn, "lot-m1", "product-apple", "4", "1", "loc-main", 20.0, "ACTIVE", false);
            // Cancelled: listed as a lot, excluded from both stock figures. Present so the two
            // aggregates are checked against a rule the lot list does not itself apply.
            seed_scoped_lot(&conn, "lot-cancelled", "product-apple", "3", "1", "loc-ratanada", 7.0, "CANCELLED", false);
            // Deleted: must be invisible everywhere.
            seed_scoped_lot(&conn, "lot-deleted", "product-apple", "3", "1", "loc-ratanada", 9.0, "ACTIVE", true);
        }

        let snapshot = load_reference_snapshot_at(&path, None, Some(device)).expect("load snapshot");
        let lots = snapshot["inventory_lots"].as_array().expect("lot list");
        let by_scope = snapshot["product_stock_by_scope"].as_array().expect("scoped aggregate");
        let products = snapshot["products"].as_array().expect("product list");

        let live_ids = lots.iter().map(|lot| lot["id"].as_str().unwrap().to_string()).collect::<std::collections::HashSet<_>>();
        assert!(!live_ids.contains("lot-deleted"), "a deleted lot must not reach the list");
        assert!(live_ids.contains("lot-cancelled"), "a cancelled lot is still a lot");
        assert_eq!(live_ids.len(), 4);

        // Rebuild the scoped aggregate from the detail rows, applying the one rule the aggregate
        // adds, and require the two to be identical. If somebody changes what one of them counts,
        // this is the assertion that fails instead of the Inventory tiles.
        let mut expected: std::collections::BTreeMap<(String, String, String), (f64, i64)> =
            std::collections::BTreeMap::new();
        for lot in lots {
            if lot["batch_status"].as_str().unwrap_or("ACTIVE").to_uppercase() == "CANCELLED" {
                continue;
            }
            let key = (
                lot["product_id"].as_str().unwrap().to_string(),
                lot["branch_id"].as_str().unwrap().to_string(),
                lot["operational_location_id"].as_str().unwrap().to_string(),
            );
            let entry = expected.entry(key).or_insert((0.0, 0));
            entry.0 += lot["balance_qty"].as_f64().unwrap();
            entry.1 += 1;
        }

        let mut emitted: std::collections::BTreeMap<(String, String, String), (f64, i64)> =
            std::collections::BTreeMap::new();
        for row in by_scope {
            emitted.insert(
                (
                    row["product_id"].as_str().unwrap().to_string(),
                    row["branch_id"].as_str().unwrap().to_string(),
                    row["operational_location_id"].as_str().unwrap().to_string(),
                ),
                (row["current_stock"].as_f64().unwrap(), row["lot_count"].as_i64().unwrap()),
            );
        }
        assert_eq!(emitted, expected);
        assert_eq!(
            emitted.get(&("product-apple".into(), "3".into(), "loc-ratanada".into())),
            Some(&(20.0, 2)),
            "Ratanada's own shelf, and nothing of Main Branch's"
        );

        // And the unscoped product total is the sum of the scoped ones — the same rows again, so a
        // caller that reads either one is reading the same fruit.
        let product = products.iter().find(|row| row["id"] == "product-apple").expect("product row");
        let scoped_total: f64 = by_scope.iter().map(|row| row["current_stock"].as_f64().unwrap()).sum();
        let scoped_lots: i64 = by_scope.iter().map(|row| row["lot_count"].as_i64().unwrap()).sum();
        assert_eq!(product["current_stock"].as_f64().unwrap(), scoped_total);
        assert_eq!(product["lot_count"].as_i64().unwrap(), scoped_lots);
        assert_eq!(scoped_total, 40.0);

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn a_pulled_lot_from_another_shop_is_refused_and_the_rest_of_the_pull_lands() {
        // The bootstrap path has always refused an `inventory_lot` outside the device's canonical
        // scope. The incremental path — the one every pull after the first one takes — applied
        // whatever arrived, so the rule held only until the device pulled again. What is asserted
        // here is both halves: the foreign lot is not live, and the honest changes travelling with
        // it in the same page still applied and the cursor still advanced.
        let path = activation_temp_path("scoped-pull-refusal");
        let _ = fs::remove_file(&path);
        let device = "FZDEV-STOCK-SCOPE-3";
        seed_device_assignment(&path, device, "1", "3", "loc-ratanada");
        {
            let conn = Connection::open(&path).expect("open refusal database");
            seed_scoped_product(&conn, "product-apple", "Apples");
        }

        let foreign_payload = PulledChange {
            change_id: serde_json::json!(101),
            branch_id: Some(4),
            entity_type: "inventory_lot".to_string(),
            entity_id: "lot-main-branch".to_string(),
            operation_type: "UPSERT".to_string(),
            version: Some(1),
            payload: serde_json::json!({
                "branch_id": 4,
                "company_id": 1,
                "operational_location_id": "loc-main",
                "product_global_id": "product-apple",
                "product_name": "Apples",
                "purchase_qty": 20,
                "remaining_qty": 20,
                "batch_status": "ACTIVE"
            }),
            updated_at: Some("2026-08-30T10:00:00.000Z".to_string()),
        };
        // Scope stated only on the envelope. The applier falls back to it and stamps it on the row,
        // so a guard that read the payload alone would wave this one through onto the shelf.
        let foreign_envelope = PulledChange {
            change_id: serde_json::json!(102),
            branch_id: Some(4),
            entity_type: "inventory_lot".to_string(),
            entity_id: "lot-envelope-only".to_string(),
            operation_type: "UPSERT".to_string(),
            version: Some(1),
            payload: serde_json::json!({
                "product_global_id": "product-apple",
                "product_name": "Apples",
                "purchase_qty": 6,
                "remaining_qty": 6,
                "batch_status": "ACTIVE"
            }),
            updated_at: Some("2026-08-30T10:00:01.000Z".to_string()),
        };
        // Same page, nothing wrong with it. A hard `Err` on the lots above would have discarded
        // this and wedged the cursor behind them for ever.
        let innocent = PulledChange {
            change_id: serde_json::json!(103),
            branch_id: Some(3),
            entity_type: "product".to_string(),
            entity_id: "product-banana".to_string(),
            operation_type: "UPSERT".to_string(),
            version: Some(1),
            payload: serde_json::json!({
                "branch_id": 3,
                "product_name": "Bananas",
                "unit": "KG",
                "selling_rate": 40,
                "active": true
            }),
            updated_at: Some("2026-08-30T10:00:02.000Z".to_string()),
        };

        apply_pull_changes_at(
            &path,
            &[foreign_payload, foreign_envelope, innocent],
            "103",
            Some(device.to_string()),
            Some("2026-08-30T10:00:03.000Z".to_string()),
        )
        .expect("a foreign lot must not fail the page");

        let conn = Connection::open(&path).expect("inspect refusal database");
        // Not "soft-deleted", not "applied with a corrected branch" — not present at all. A row
        // that reached the table would be sellable from this counter.
        let foreign_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM local_inventory_lots WHERE id IN ('lot-main-branch', 'lot-envelope-only')",
                [],
                |row| row.get(0),
            )
            .expect("count foreign lots");
        assert_eq!(foreign_rows, 0, "another shop's stock must never reach this device's lots");

        // Refused loudly: countable, readable, and replayable rather than dropped.
        let refusals: Vec<(String, String)> = {
            let mut statement = conn
                .prepare(
                    "SELECT entity_id, reason FROM local_unapplied_changes
                      WHERE entity_type = 'inventory_lot' ORDER BY entity_id",
                )
                .expect("prepare refusals");
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .expect("query refusals")
                .collect::<Result<Vec<_>, _>>()
                .expect("collect refusals")
        };
        assert_eq!(
            refusals,
            vec![
                ("lot-envelope-only".to_string(), "INVENTORY_LOT_OUTSIDE_DEVICE_SCOPE".to_string()),
                ("lot-main-branch".to_string(), "INVENTORY_LOT_OUTSIDE_DEVICE_SCOPE".to_string()),
            ]
        );
        let detail: String = conn
            .query_row(
                "SELECT detail FROM local_unapplied_changes WHERE entity_id = 'lot-main-branch'",
                [],
                |row| row.get(0),
            )
            .expect("refusal detail");
        assert!(detail.contains("branch"), "the reason has to name what was wrong: {detail}");

        // The rest of the page landed, and the cursor moved, so the next pull does not re-offer it.
        let banana: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_products WHERE id = 'product-banana'", [], |row| row.get(0))
            .expect("count innocent product");
        assert_eq!(banana, 1);
        let cursor: String = conn
            .query_row(
                "SELECT last_pull_cursor FROM sync_state WHERE device_id = ?1",
                params![device],
                |row| row.get(0),
            )
            .expect("read cursor");
        assert_eq!(cursor, "103");

        drop(conn);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn a_pulled_lot_for_this_shop_still_applies() {
        // Without this, a suite passes by refusing everything, and a counter that can sell nothing
        // is not a fix. Three shapes that must all still go through: the device's own branch and
        // location stated in full; scope stated only on the envelope and matching; and a payload
        // that states no scope at all, which is an older server rather than a foreign shop.
        let path = activation_temp_path("scoped-pull-accepts-own");
        let _ = fs::remove_file(&path);
        let device = "FZDEV-STOCK-SCOPE-4";
        seed_device_assignment(&path, device, "1", "3", "loc-ratanada");
        {
            let conn = Connection::open(&path).expect("open accept database");
            seed_scoped_product(&conn, "product-apple", "Apples");
        }

        let make_lot = |change_id: i64, id: &str, payload: serde_json::Value, envelope_branch: Option<i64>| PulledChange {
            change_id: serde_json::json!(change_id),
            branch_id: envelope_branch,
            entity_type: "inventory_lot".to_string(),
            entity_id: id.to_string(),
            operation_type: "UPSERT".to_string(),
            version: Some(1),
            payload,
            updated_at: Some("2026-08-30T11:00:00.000Z".to_string()),
        };

        let changes = vec![
            make_lot(
                201,
                "lot-own-full",
                serde_json::json!({
                    "branch_id": 3,
                    "company_id": 1,
                    "operational_location_id": "loc-ratanada",
                    "product_global_id": "product-apple",
                    "product_name": "Apples",
                    "purchase_qty": 15,
                    "remaining_qty": 15,
                    "batch_status": "ACTIVE"
                }),
                Some(3),
            ),
            make_lot(
                202,
                "lot-own-envelope",
                serde_json::json!({
                    "product_global_id": "product-apple",
                    "product_name": "Apples",
                    "purchase_qty": 4,
                    "remaining_qty": 4,
                    "batch_status": "ACTIVE"
                }),
                Some(3),
            ),
            make_lot(
                203,
                "lot-no-scope-stated",
                serde_json::json!({
                    "product_global_id": "product-apple",
                    "product_name": "Apples",
                    "purchase_qty": 2,
                    "remaining_qty": 2,
                    "batch_status": "ACTIVE"
                }),
                None,
            ),
        ];

        apply_pull_changes_at(
            &path,
            &changes,
            "203",
            Some(device.to_string()),
            Some("2026-08-30T11:00:01.000Z".to_string()),
        )
        .expect("this device's own stock must apply");

        let conn = Connection::open(&path).expect("inspect accept database");
        let (live, balance): (i64, f64) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(balance_qty), 0) FROM local_inventory_lots WHERE deleted_at IS NULL",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("count applied lots");
        assert_eq!(live, 3);
        assert_eq!(balance, 21.0);
        let refused: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_unapplied_changes", [], |row| row.get(0))
            .expect("count refusals");
        assert_eq!(refused, 0, "nothing here is foreign, so nothing may be refused");

        drop(conn);
        let _ = fs::remove_file(&path);
    }
}
