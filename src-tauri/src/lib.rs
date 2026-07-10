mod local_db;

use local_db::{
    LocalDbStatus, LocalPosSaleResult, PendingSyncOperation, PulledChange, SyncAck, SyncOperation,
};
use serde::Serialize;
use std::{
    env,
    fs::{self, OpenOptions},
    io::Write,
    panic,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::Controls::Dialogs::{
    CommDlgExtendedError, GetSaveFileNameW, OPENFILENAMEW, OFN_OVERWRITEPROMPT, OFN_PATHMUSTEXIST,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::{
    Shell::ShellExecuteW,
    WindowsAndMessaging::SW_SHOWNORMAL,
};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

static KIOSK_LOCK_ENABLED: AtomicBool = AtomicBool::new(false);
static KIOSK_CLOSE_ALLOWED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Serialize, Clone)]
struct CleanupCandidate {
    path: String,
    kind: String,
    action: String,
    safe: bool,
    reason: String,
}

#[derive(Debug, Serialize)]
struct CleanupResult {
    install_path: String,
    data_path: String,
    candidates: Vec<CleanupCandidate>,
    removed: Vec<CleanupCandidate>,
    blocked: Vec<CleanupCandidate>,
    message: String,
}

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

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\").to_lowercase()
}

fn is_under(path: &Path, parent: &Path) -> bool {
    normalize_path(path).starts_with(&normalize_path(parent))
}

fn current_install_dir() -> PathBuf {
    env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files\FroozERP"))
}

fn push_shortcut_candidate(candidates: &mut Vec<CleanupCandidate>, path: PathBuf, reason: &str) {
    if path.exists() {
        candidates.push(CleanupCandidate {
            path: path.to_string_lossy().to_string(),
            kind: "shortcut".to_string(),
            action: "remove legacy shortcut".to_string(),
            safe: true,
            reason: reason.to_string(),
        });
    }
}

fn froozerp_cleanup_candidates() -> CleanupResult {
    let install_dir = current_install_dir();
    let data_dir = app_data_dir();
    let mut candidates = Vec::new();
    let mut blocked = Vec::new();

    if let Some(user_profile) = env::var_os("USERPROFILE").map(PathBuf::from) {
        push_shortcut_candidate(
            &mut candidates,
            user_profile.join("Desktop").join("FroozERP.lnk"),
            "old user Desktop shortcut can point to stale app versions",
        );
        push_shortcut_candidate(
            &mut candidates,
            user_profile
                .join("AppData")
                .join("Roaming")
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs")
                .join("FroozERP.lnk"),
            "old user Start Menu shortcut replaced by the per-machine FroozERP folder shortcut",
        );
        push_shortcut_candidate(
            &mut candidates,
            user_profile
                .join("AppData")
                .join("Roaming")
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs")
                .join("Chrome Apps")
                .join("FroozERP.lnk"),
            "old Chrome/PWA shortcut can launch a stale web app",
        );
    }
    if let Some(program_data) = env::var_os("PROGRAMDATA").map(PathBuf::from) {
        push_shortcut_candidate(
            &mut candidates,
            program_data
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs")
                .join("FroozERP.lnk"),
            "old root-level Start Menu shortcut replaced by Programs\\FroozERP\\FroozERP.lnk",
        );
    }

    let legacy_chrome_uninstall_key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\d0400be39e01c338dfc0b992b6a2c220";
    let legacy_chrome_key_exists = Command::new("reg")
        .args(["query", legacy_chrome_uninstall_key])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false);
    if legacy_chrome_key_exists {
        candidates.push(CleanupCandidate {
            path: legacy_chrome_uninstall_key.to_string(),
            kind: "registry-uninstall-entry".to_string(),
            action: "remove legacy Chrome/PWA uninstall entry".to_string(),
            safe: true,
            reason: "old Chrome app entry can make Programs & Features show a duplicate FroozERP version".to_string(),
        });
    }

    let mut old_install_paths = Vec::new();
    if let Some(program_files_x86) = env::var_os("ProgramFiles(x86)").map(PathBuf::from) {
        old_install_paths.push(program_files_x86.join("FroozERP"));
    }
    if let Some(program_files) = env::var_os("ProgramFiles").map(PathBuf::from) {
        for old_leaf in [
            "FroozERP-old",
            "FroozERP Old",
            "FroozERP Backup",
            "FroozERP-Backup",
        ] {
            old_install_paths.push(program_files.join(old_leaf));
        }
    }

    for path in old_install_paths {
        if !path.exists() || path == install_dir {
            continue;
        }
        if is_under(&path, &data_dir) {
            blocked.push(CleanupCandidate {
                path: path.to_string_lossy().to_string(),
                kind: "install-folder".to_string(),
                action: "blocked".to_string(),
                safe: false,
                reason: "path is inside the FroozERP business data directory".to_string(),
            });
            continue;
        }
        let has_app_binary =
            path.join("froozerp.exe").exists() || path.join("uninstall.exe").exists();
        if has_app_binary {
            candidates.push(CleanupCandidate {
                path: path.to_string_lossy().to_string(),
                kind: "install-folder".to_string(),
                action: "remove old app install folder".to_string(),
                safe: true,
                reason: "verified known old Program Files app folder outside business data"
                    .to_string(),
            });
        } else {
            blocked.push(CleanupCandidate {
                path: path.to_string_lossy().to_string(),
                kind: "install-folder".to_string(),
                action: "blocked".to_string(),
                safe: false,
                reason: "known old install path exists but app binaries were not verified"
                    .to_string(),
            });
        }
    }

    CleanupResult {
        install_path: install_dir.to_string_lossy().to_string(),
        data_path: data_dir.to_string_lossy().to_string(),
        candidates,
        removed: Vec::new(),
        blocked,
        message: "Old application files detected. Business data paths are excluded.".to_string(),
    }
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

fn sanitize_file_name(value: &str) -> String {
    let normalized_source = value.replace('&', " and ");
    let cleaned: String = normalized_source
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            ch if ch.is_control() => '-',
            ch => ch,
        })
        .collect();
    let mut collapsed = String::with_capacity(cleaned.len());
    let mut previous_separator = false;
    for ch in cleaned.chars() {
        if ch.is_whitespace() || ch == '_' || ch == '-' {
            if !previous_separator {
                collapsed.push('-');
                previous_separator = true;
            }
        } else {
            collapsed.push(ch);
            previous_separator = false;
        }
    }
    let trimmed = collapsed.trim_matches([' ', '.', '-']).trim();
    if trimmed.is_empty() {
        "FroozERP-Document.pdf".to_string()
    } else if trimmed.to_ascii_lowercase().ends_with(".pdf") {
        trimmed.to_string()
    } else {
        format!("{}.pdf", trimmed)
    }
}

fn unique_preview_pdf_path(preview_dir: &Path, file_name: &str) -> PathBuf {
    let sanitized = sanitize_file_name(file_name);
    let base_path = preview_dir.join(&sanitized);
    if !base_path.exists() {
        return base_path;
    }

    let (stem, extension) = sanitized
        .rsplit_once('.')
        .map(|(stem, extension)| (stem.to_string(), format!(".{}", extension)))
        .unwrap_or_else(|| (sanitized.clone(), String::new()));

    for index in 1..1000 {
        let candidate = preview_dir.join(format!("{}-({}){}", stem, index, extension));
        if !candidate.exists() {
            return candidate;
        }
    }

    preview_dir.join(format!("{}-{}.pdf", stem, timestamp_ms()))
}

#[tauri::command]
fn open_pdf_in_system_viewer(file_name: String, bytes: Vec<u8>) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("PDF file is empty".to_string());
    }
    let preview_dir = app_data_dir().join("pdf-preview");
    fs::create_dir_all(&preview_dir).map_err(|error| error.to_string())?;
    let path = unique_preview_pdf_path(&preview_dir, &file_name);
    fs::write(&path, bytes).map_err(|error| error.to_string())?;
    if !path.is_file() {
        return Err("PDF preview file was not created".to_string());
    }
    #[cfg(target_os = "windows")]
    open_path_with_windows_shell(&path)?;
    #[cfg(not(target_os = "windows"))]
    Command::new(if cfg!(target_os = "macos") { "open" } else { "xdg-open" })
        .arg(&path)
        .spawn()
        .map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(target_os = "windows")]
fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn open_path_with_windows_shell(path: &Path) -> Result<(), String> {
    let operation = wide_null("open");
    let file = wide_null(&path.to_string_lossy());
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if (result as isize) <= 32 {
        return Err(format!("Windows shell open failed with code {}", result as isize));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn save_pdf_path_with_windows_dialog(suggested_name: &str) -> Result<Option<PathBuf>, String> {
    let mut file_buffer = vec![0u16; 32768];
    let suggested = wide_null(suggested_name);
    let copy_len = suggested.len().min(file_buffer.len());
    file_buffer[..copy_len].copy_from_slice(&suggested[..copy_len]);

    let filter = wide_null("PDF documents (*.pdf)\0*.pdf\0All files (*.*)\0*.*\0");
    let title = wide_null("Save FroozERP PDF");
    let initial_dir = env::var("USERPROFILE")
        .map(|home| PathBuf::from(home).join("Desktop"))
        .ok()
        .filter(|path| path.exists())
        .map(|path| wide_null(&path.to_string_lossy()));

    let mut dialog: OPENFILENAMEW = unsafe { std::mem::zeroed() };
    dialog.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
    dialog.lpstrFilter = filter.as_ptr();
    dialog.lpstrFile = file_buffer.as_mut_ptr();
    dialog.nMaxFile = file_buffer.len() as u32;
    dialog.lpstrTitle = title.as_ptr();
    dialog.Flags = OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST;
    if let Some(initial_dir) = initial_dir.as_ref() {
        dialog.lpstrInitialDir = initial_dir.as_ptr();
    }

    let accepted = unsafe { GetSaveFileNameW(&mut dialog) };
    if accepted == 0 {
        let error_code = unsafe { CommDlgExtendedError() };
        if error_code == 0 {
            return Ok(None);
        }
        return Err(format!("Windows save dialog failed with code {}", error_code));
    }

    let selected_len = file_buffer
        .iter()
        .position(|ch| *ch == 0)
        .unwrap_or(file_buffer.len());
    let selected = String::from_utf16_lossy(&file_buffer[..selected_len]);
    if selected.trim().is_empty() {
        return Ok(None);
    }
    let mut path = PathBuf::from(selected);
    if path.extension().is_none() {
        path.set_extension("pdf");
    }
    Ok(Some(path))
}

#[tauri::command]
fn save_pdf_with_dialog(file_name: String, bytes: Vec<u8>) -> Result<Option<String>, String> {
    if bytes.is_empty() {
        return Err("PDF file is empty".to_string());
    }
    let suggested_name = sanitize_file_name(&file_name);
    #[cfg(target_os = "windows")]
    let selected_path = save_pdf_path_with_windows_dialog(&suggested_name)?;
    #[cfg(not(target_os = "windows"))]
    let selected_path = {
        let fallback_dir = app_data_dir().join("pdf-export");
        fs::create_dir_all(&fallback_dir).map_err(|error| error.to_string())?;
        Some(fallback_dir.join(&suggested_name))
    };
    let Some(path) = selected_path else {
        return Ok(None);
    };
    let path = if path.extension().is_none() {
        let mut with_extension = path;
        with_extension.set_extension("pdf");
        with_extension
    } else {
        path
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&path, bytes).map_err(|error| error.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
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
    window
        .set_fullscreen(enabled)
        .map_err(|error| error.to_string())?;
    window
        .set_decorations(!enabled)
        .map_err(|error| error.to_string())?;
    window
        .set_resizable(!enabled)
        .map_err(|error| error.to_string())?;
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
fn detect_old_froozerp_versions() -> Result<CleanupResult, String> {
    Ok(froozerp_cleanup_candidates())
}

#[tauri::command]
fn clean_old_froozerp_versions() -> Result<CleanupResult, String> {
    let mut result = froozerp_cleanup_candidates();
    let data_dir = app_data_dir();
    let install_dir = current_install_dir();
    let candidates = result.candidates.clone();
    result.candidates = candidates.clone();
    for candidate in candidates {
        let path = PathBuf::from(&candidate.path);
        if !candidate.safe || is_under(&path, &data_dir) || path == install_dir {
            let mut blocked = candidate.clone();
            blocked.safe = false;
            blocked.action = "blocked".to_string();
            blocked.reason = "cleanup safety check refused this path".to_string();
            result.blocked.push(blocked);
            continue;
        }
        let cleanup_result = if candidate.kind == "shortcut" {
            if path.exists() {
                fs::remove_file(&path)
            } else {
                Ok(())
            }
        } else if candidate.kind == "install-folder" {
            if path.exists() {
                fs::remove_dir_all(&path)
            } else {
                Ok(())
            }
        } else if candidate.kind == "registry-uninstall-entry" {
            match Command::new("reg")
                .args(["delete", &candidate.path, "/f"])
                .status()
            {
                Ok(status) if status.success() => Ok(()),
                Ok(_) => Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "registry cleanup command failed",
                )),
                Err(error) => Err(error),
            }
        } else {
            Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                "unknown cleanup candidate kind",
            ))
        };
        match cleanup_result {
            Ok(_) => result.removed.push(candidate),
            Err(error) => {
                let mut blocked = candidate.clone();
                blocked.safe = false;
                blocked.action = "failed".to_string();
                blocked.reason = format!("cleanup failed: {}", error);
                result.blocked.push(blocked);
            }
        }
    }
    result.message = "Old application file cleanup completed. Business data preserved.".to_string();
    Ok(result)
}

#[tauri::command]
fn local_cache_reference_snapshot(
    app: AppHandle,
    snapshot: serde_json::Value,
) -> Result<LocalDbStatus, String> {
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
fn sync_outbox_pending(
    app: AppHandle,
    limit: Option<i64>,
) -> Result<Vec<PendingSyncOperation>, String> {
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
fn pos_sale_complete_local(
    app: AppHandle,
    sale: serde_json::Value,
) -> Result<LocalPosSaleResult, String> {
    local_db::complete_local_pos_sale(&app, sale)
}

#[tauri::command]
fn pos_sale_edit_local(
    app: AppHandle,
    edit: serde_json::Value,
) -> Result<LocalPosSaleResult, String> {
    local_db::edit_local_pos_sale(&app, edit)
}

#[tauri::command]
fn pos_sale_cancel_local(
    app: AppHandle,
    cancellation: serde_json::Value,
) -> Result<LocalPosSaleResult, String> {
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
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&panic_path)
        {
            let _ = writeln!(
                file,
                "{} [PANIC] {} at {}",
                timestamp_ms(),
                payload,
                location
            );
        }
    }));

    write_app_log("INFO", "FroozERP desktop startup requested");

    let result = tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let path = diagnostic_log_path();
            write_app_log(
                "INFO",
                &format!("Application log file: {}", path.to_string_lossy()),
            );
            write_app_log("INFO", "Tauri setup started");
            match clean_old_froozerp_versions() {
                Ok(cleanup) => write_app_log(
                    "INFO",
                    &format!(
                        "Old version cleanup completed: removed={}, blocked={}, data_path={}",
                        cleanup.removed.len(),
                        cleanup.blocked.len(),
                        cleanup.data_path
                    ),
                ),
                Err(error) => {
                    write_app_log("ERROR", &format!("Old version cleanup failed: {}", error))
                }
            }
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
                        Err(error) => write_app_log(
                            "ERROR",
                            &format!("One-time WebView cache recovery failed: {}", error),
                        ),
                    }
                } else {
                    write_app_log(
                        "ERROR",
                        "Main window was not available during WebView cache recovery",
                    );
                }
            }
            write_app_log("INFO", "Tauri setup completed");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_log_path,
            app_log,
            open_pdf_in_system_viewer,
            save_pdf_with_dialog,
            set_kiosk_mode,
            close_froozerp_window,
            detect_old_froozerp_versions,
            clean_old_froozerp_versions,
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
                if KIOSK_LOCK_ENABLED.load(Ordering::SeqCst)
                    && !KIOSK_CLOSE_ALLOWED.load(Ordering::SeqCst)
                {
                    api.prevent_close();
                    let _ = window.emit("kiosk-exit-required", ());
                    write_app_log("INFO", "Close prevented by kiosk lock");
                }
            }
        })
        .run(tauri::generate_context!())
        .map_err(|error| error.to_string());

    if let Err(error) = result {
        write_app_log(
            "ERROR",
            &format!("error while running FroozERP desktop app: {}", error),
        );
        panic!("error while running FroozERP desktop app: {}", error);
    }
}
