use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const CURRENT_SCHEMA_VERSION: &str = "003_local_first_pos";
const LOCAL_DB_FILE: &str = "froozerp-local.sqlite3";
const MIGRATION_001: &str = include_str!("../migrations/sqlite/001_local_foundation.sql");
const MIGRATION_002: &str = include_str!("../migrations/sqlite/002_sync_engine_foundation.sql");
const MIGRATION_003: &str = include_str!("../migrations/sqlite/003_local_first_pos.sql");

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

#[derive(Debug, Serialize)]
pub struct LocalPosSaleResult {
    pub invoice: serde_json::Value,
    pub pending_operations: i64,
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
                tx.execute(
                    "UPDATE local_pos_invoices
                     SET sync_status = 'synced',
                         server_invoice_no = json_extract(?2, '$.result_payload.invoice_no'),
                         server_sale_id = json_extract(?2, '$.result_payload.sale_id'),
                         synced_at = datetime('now'),
                         updated_at = datetime('now'),
                         entity_version = COALESCE(?3, entity_version)
                     WHERE id = (SELECT entity_id FROM sync_outbox WHERE operation_id = ?1 AND entity_type = 'pos_sale')",
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
                tx.execute(
                    "UPDATE local_pos_invoices
                     SET sync_status = 'conflict', updated_at = datetime('now')
                     WHERE id = (SELECT entity_id FROM sync_outbox WHERE operation_id = ?1 AND entity_type = 'pos_sale')",
                    params![ack.operation_id],
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
                tx.execute(
                    "UPDATE local_pos_invoices
                     SET sync_status = 'failed', updated_at = datetime('now')
                     WHERE id = (SELECT entity_id FROM sync_outbox WHERE operation_id = ?1 AND entity_type = 'pos_sale')",
                    params![ack.operation_id],
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

pub fn complete_local_pos_sale(app: &AppHandle, sale: serde_json::Value) -> Result<LocalPosSaleResult, String> {
    let path = database_path(app)?;
    complete_local_pos_sale_at(&path, sale)
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
            status, sync_status, entity_version, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                   'COMPLETED', 'pending', ?17, datetime('now'), datetime('now'))",
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
                "SELECT balance_qty FROM local_inventory_lots WHERE id = ?1 OR cloud_id = ?1 LIMIT 1",
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
             VALUES (?1, ?1, ?2, ?3, ?4, ?5, 'synced', datetime('now'))
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
             ) VALUES (?1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, 'ACTIVE', 'synced', datetime('now'))
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
                 updated_at = datetime('now'),
                 sync_status = CASE WHEN LOWER(sync_status) = 'pending' THEN sync_status ELSE 'synced' END
             WHERE id = ?1 AND balance_qty >= ?2",
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
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'SALE_OUT', ?8, ?9, datetime('now'), 'pending')",
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
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'), 'pending')",
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
    apply_migration(&mut conn, "003_local_first_pos", MIGRATION_003)?;
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

    #[test]
    fn local_pos_sale_persists_invoice_stock_payment_and_outbox() {
        let path = std::env::temp_dir().join(format!(
            "froozerp-phase2-pos-{}.sqlite3",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);

        initialize_at(&path).expect("initialize local db");
        let sale = serde_json::json!({
            "operation_id": "op-test-sale-1",
            "invoice_global_id": "invoice-test-sale-1",
            "offline_invoice_ref": "OFF-TEST-1",
            "branch_id": "1",
            "device_id": "device-test",
            "user_id": "1",
            "customer": { "name": "Walk-in Customer", "mobile": "" },
            "bill_date": "2026-06-16",
            "bill_datetime": "2026-06-16T10:00",
            "payment_mode": "CASH",
            "gross_total": 20.0,
            "item_discount_total": 0.0,
            "bill_discount_total": 0.0,
            "tax_total": 0.0,
            "net_total": 20.0,
            "entity_version": 1,
            "items": [{
                "item_global_id": "line-test-sale-1",
                "product_id": "product-test",
                "product_name": "Test Product",
                "lot_id": "lot-test",
                "lot_name": "Test Lot",
                "lot_size": "Small",
                "quantity": 2.0,
                "unit": "KG",
                "rate": 10.0,
                "discount": 0.0,
                "amount": 20.0,
                "stock_movement_id": "stock-test-sale-1",
                "available_qty": 5.0
            }],
            "payments": [{
                "posting_id": "posting-test-sale-1",
                "mode": "CASH",
                "amount": 20.0
            }]
        });

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
}
