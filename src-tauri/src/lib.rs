mod local_db;

use local_db::{LocalDbStatus, LocalPosSaleResult, PendingSyncOperation, PulledChange, SyncAck, SyncOperation};
use std::{
    env,
    fs::{self, OpenOptions},
    io::Write,
    panic,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

static KIOSK_LOCK_ENABLED: AtomicBool = AtomicBool::new(false);
static KIOSK_CLOSE_ALLOWED: AtomicBool = AtomicBool::new(false);

fn diagnostic_log_path() -> PathBuf {
    env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| env::temp_dir())
        .join("com.srtcompany.froozerp")
        .join("logs")
        .join("froozerp-startup.log")
}

fn app_data_dir() -> PathBuf {
    env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| env::temp_dir())
        .join("com.srtcompany.froozerp")
}

fn webview_recovery_marker_path() -> PathBuf {
    app_data_dir().join("webview-cache-recovered-1.0.0-no-tauri-sw-20260617")
}

fn timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn write_app_log(level: &str, message: &str) {
    let path = diagnostic_log_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{} [{}] {}", timestamp_ms(), level, message);
    }
}

#[tauri::command]
fn app_log_path() -> Result<String, String> {
    Ok(diagnostic_log_path().to_string_lossy().to_string())
}

#[tauri::command]
fn app_log(level: Option<String>, message: String) -> Result<(), String> {
    write_app_log(level.as_deref().unwrap_or("INFO"), &message);
    Ok(())
}

#[tauri::command]
fn set_kiosk_mode(app: AppHandle, enabled: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not available".to_string())?;
    KIOSK_LOCK_ENABLED.store(enabled, Ordering::SeqCst);
    if enabled {
        KIOSK_CLOSE_ALLOWED.store(false, Ordering::SeqCst);
    }
    window.set_fullscreen(enabled).map_err(|error| error.to_string())?;
    window.set_decorations(!enabled).map_err(|error| error.to_string())?;
    window.set_resizable(!enabled).map_err(|error| error.to_string())?;
    write_app_log("INFO", &format!("Kiosk mode set to {}", enabled));
    Ok(())
}

#[tauri::command]
fn close_froozerp_window(app: AppHandle, allow_exit: Option<bool>) -> Result<(), String> {
    if allow_exit.unwrap_or(false) {
        KIOSK_CLOSE_ALLOWED.store(true, Ordering::SeqCst);
        KIOSK_LOCK_ENABLED.store(false, Ordering::SeqCst);
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not available".to_string())?;
    let _ = window.set_fullscreen(false);
    let _ = window.set_decorations(true);
    let _ = window.set_resizable(true);
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
fn local_cache_reference_snapshot(app: AppHandle, snapshot: serde_json::Value) -> Result<LocalDbStatus, String> {
    local_db::cache_reference_snapshot(&app, &snapshot)
}

#[tauri::command]
fn local_load_reference_snapshot(
    app: AppHandle,
    username: Option<String>,
    device_id: Option<String>,
) -> Result<serde_json::Value, String> {
    local_db::load_reference_snapshot(&app, username.as_deref(), device_id.as_deref())
}

#[tauri::command]
fn local_get_or_create_device_identity(app: AppHandle) -> Result<serde_json::Value, String> {
    local_db::ensure_device_identity(&app)
}

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

#[tauri::command]
fn pos_sale_complete_local(app: AppHandle, sale: serde_json::Value) -> Result<LocalPosSaleResult, String> {
    local_db::complete_local_pos_sale(&app, sale)
}

#[tauri::command]
fn pos_sale_edit_local(app: AppHandle, edit: serde_json::Value) -> Result<LocalPosSaleResult, String> {
    local_db::edit_local_pos_sale(&app, edit)
}

#[tauri::command]
fn pos_sale_cancel_local(app: AppHandle, cancellation: serde_json::Value) -> Result<LocalPosSaleResult, String> {
    local_db::cancel_local_pos_sale(&app, cancellation)
}

#[tauri::command]
fn pos_sale_load_local(app: AppHandle, invoice_id: String) -> Result<serde_json::Value, String> {
    local_db::load_local_pos_sale(&app, &invoice_id)
}

#[tauri::command]
fn pos_sale_list_local(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    local_db::list_local_pos_sales(&app)
}

pub fn run() {
    let panic_path = diagnostic_log_path();
    panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|location| format!("{}:{}", location.file(), location.line()))
            .unwrap_or_else(|| "unknown location".to_string());
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| info.payload().downcast_ref::<String>().map(String::as_str))
            .unwrap_or("panic without string payload");
        if let Some(parent) = panic_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&panic_path) {
            let _ = writeln!(file, "{} [PANIC] {} at {}", timestamp_ms(), payload, location);
        }
    }));

    write_app_log("INFO", "FroozERP desktop startup requested");

    let result = tauri::Builder::default()
        .setup(|app| {
            let path = diagnostic_log_path();
            write_app_log("INFO", &format!("Application log file: {}", path.to_string_lossy()));
            write_app_log("INFO", "Tauri setup started");
            let marker = webview_recovery_marker_path();
            if !marker.exists() {
                if let Some(window) = app.get_webview_window("main") {
                    match window.clear_all_browsing_data() {
                        Ok(_) => {
                            write_app_log("INFO", "One-time WebView cache recovery completed");
                            if let Some(parent) = marker.parent() {
                                let _ = fs::create_dir_all(parent);
                            }
                            let _ = fs::write(&marker, "1.0.0");
                        }
                        Err(error) => write_app_log("ERROR", &format!("One-time WebView cache recovery failed: {}", error)),
                    }
                } else {
                    write_app_log("ERROR", "Main window was not available during WebView cache recovery");
                }
            }
            write_app_log("INFO", "Tauri setup completed");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_log_path,
            app_log,
            set_kiosk_mode,
            close_froozerp_window,
            local_cache_reference_snapshot,
            local_load_reference_snapshot,
            local_get_or_create_device_identity,
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
            sync_queue_test_entity,
            pos_sale_complete_local,
            pos_sale_edit_local,
            pos_sale_cancel_local,
            pos_sale_load_local,
            pos_sale_list_local
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if KIOSK_LOCK_ENABLED.load(Ordering::SeqCst) && !KIOSK_CLOSE_ALLOWED.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.emit("kiosk-exit-required", ());
                    write_app_log("INFO", "Close prevented by kiosk lock");
                }
            }
        })
        .run(tauri::generate_context!())
        .map_err(|error| error.to_string());

    if let Err(error) = result {
        write_app_log("ERROR", &format!("error while running FroozERP desktop app: {}", error));
        panic!("error while running FroozERP desktop app: {}", error);
    }
}
