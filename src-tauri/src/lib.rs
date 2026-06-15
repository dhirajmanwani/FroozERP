mod local_db;

use local_db::{LocalDbStatus, PendingSyncOperation, PulledChange, SyncAck, SyncOperation};
use tauri::AppHandle;

#[tauri::command]
fn local_db_initialize(app: AppHandle) -> Result<LocalDbStatus, String> {
    local_db::initialize(&app)
}

#[tauri::command]
fn local_db_status(app: AppHandle) -> Result<LocalDbStatus, String> {
    local_db::status(&app)
}

#[tauri::command]
fn local_db_set_smoke_value(app: AppHandle, value: String) -> Result<(), String> {
    local_db::set_smoke_value(&app, &value)
}

#[tauri::command]
fn local_db_get_smoke_value(app: AppHandle) -> Result<Option<String>, String> {
    local_db::get_smoke_value(&app)
}

#[tauri::command]
fn sync_outbox_enqueue(app: AppHandle, operation: SyncOperation) -> Result<i64, String> {
    local_db::enqueue_sync_operation(&app, &operation)
}

#[tauri::command]
fn sync_outbox_count(app: AppHandle) -> Result<i64, String> {
    local_db::pending_outbox_count(&app)
}

#[tauri::command]
fn sync_outbox_pending(app: AppHandle, limit: Option<i64>) -> Result<Vec<PendingSyncOperation>, String> {
    local_db::pending_outbox(&app, limit.unwrap_or(50))
}

#[tauri::command]
fn sync_apply_push_acks(app: AppHandle, acks: Vec<SyncAck>) -> Result<LocalDbStatus, String> {
    local_db::apply_push_acks(&app, &acks)
}

#[tauri::command]
fn sync_apply_pull_changes(
    app: AppHandle,
    changes: Vec<PulledChange>,
    next_cursor: String,
    device_id: Option<String>,
) -> Result<LocalDbStatus, String> {
    local_db::apply_pull_changes(&app, &changes, &next_cursor, device_id)
}

#[tauri::command]
fn sync_mark_failed(app: AppHandle, message: String) -> Result<LocalDbStatus, String> {
    local_db::mark_sync_failed(&app, &message)
}

#[tauri::command]
fn sync_retry_failed_operations(app: AppHandle) -> Result<LocalDbStatus, String> {
    local_db::retry_failed_operations(&app)
}

#[tauri::command]
fn sync_queue_test_entity(
    app: AppHandle,
    entity_id: String,
    value: String,
    branch_id: Option<String>,
    device_id: Option<String>,
    user_id: Option<String>,
) -> Result<i64, String> {
    local_db::queue_sync_test_entity(&app, &entity_id, &value, branch_id, device_id, user_id)
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            local_db_initialize,
            local_db_status,
            local_db_set_smoke_value,
            local_db_get_smoke_value,
            sync_outbox_enqueue,
            sync_outbox_count,
            sync_outbox_pending,
            sync_apply_push_acks,
            sync_apply_pull_changes,
            sync_mark_failed,
            sync_retry_failed_operations,
            sync_queue_test_entity
        ])
        .run(tauri::generate_context!())
        .expect("error while running FroozERP desktop app");
}
