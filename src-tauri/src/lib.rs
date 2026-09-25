// A phone build (`cfg(mobile)`, set by tauri-build for Android and iOS) compiles the whole shell
// but never runs the Windows sidecar, updater and cleanup code, which is gated off below. What is
// left of those helpers is dead code there, not a defect; the allowance is for mobile builds only,
// so the desktop build keeps every warning it had.
#![cfg_attr(mobile, allow(dead_code, unused_imports, unused_variables))]

// Offline activation entitlement core (Stage 1). Pure logic, no call sites yet — the module is
// declared so it compiles and its tests run; nothing in the app invokes it.
pub mod entitlement;
pub mod activation;
mod local_db;
mod mobile_gateway;

use local_db::{
    LocalDbStatus, LocalPosSaleResult, LocalPurchaseIntentResult, PendingSyncOperation, PulledChange, SyncAck, SyncOperation,
};
use serde::{Deserialize, Serialize};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::{
    env,
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::TcpStream,
    panic,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    thread,
    time::Duration,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
#[cfg(target_os = "windows")]
use windows_sys::Win32::System::Threading::{
    CreateMutexW, OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::Controls::Dialogs::{
    CommDlgExtendedError, GetSaveFileNameW, OFN_OVERWRITEPROMPT, OFN_PATHMUSTEXIST, OPENFILENAMEW,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};

static KIOSK_LOCK_ENABLED: AtomicBool = AtomicBool::new(false);
static KIOSK_CLOSE_ALLOWED: AtomicBool = AtomicBool::new(false);
static LOCAL_BACKEND_PROCESS: Mutex<Option<Child>> = Mutex::new(None);
static LOCAL_BACKEND_START_GUARD: Mutex<()> = Mutex::new(());
/// Tauri's own answer for the app-data directory, captured at the start of `setup`. Consulted only
/// on a phone -- see `app_data_dir`.
static RESOLVED_APP_DATA_DIR: OnceLock<PathBuf> = OnceLock::new();
/// Whether the phone app's SQLite file has been created and migrated. On desktop the sidecar launch
/// does this before the gateway starts; a phone has no launch step, so the first gateway request does.
static MOBILE_SQLITE_READY: Mutex<bool> = Mutex::new(false);
#[cfg(target_os = "windows")]
static DESKTOP_INSTANCE_MUTEX: Mutex<Option<isize>> = Mutex::new(None);
const LOCAL_BACKEND_PORT: &str = "5000";

/// The port a **development** build uses, so it can never take the shop app's.
///
/// `npm run app` and `npm run app:disposable` both used to bind 5000 -- the same port the installed
/// app needs. The disposable launcher isolates the *database* and says so at length, but it never
/// isolated the port, and a port is just as exclusive as a file.
///
/// That gap cost thirteen days. A dev build started on 2026-08-20 held 5000 until 2026-09-02; the
/// installed app started, found the port owned by something reporting a version it did not
/// recognise, and refused to come up. The shop could not bill, and nothing in the message said
/// "another copy of this app is running".
///
/// A separate port makes the two physically unable to fight. `frontend/src/App.jsx` derives the
/// same split from `import.meta.env.DEV`, and `localBackendPort.test.mjs` fails if the two sides
/// ever disagree -- because a frontend calling 5000 while its backend listens on 5051 is a dev app
/// quietly talking to the shop's own backend, which is worse than either of them failing.
const DEV_BACKEND_PORT: &str = "5051";
/// The cloud this build belongs to.
///
/// ## Why this is a build-time fact and not a setting
///
/// The shell used to launch `desktopGateway.js` with no cloud address at all. The gateway therefore
/// had no cloud target, refused every cloud route by name, and the app fell back to this computer --
/// on a machine with perfectly good internet. Nothing on screen said so, because from the app's side
/// that is indistinguishable from being offline.
///
/// The other half of the same gap was in the frontend: a **Cloud API URL** text box the shopkeeper
/// was expected to fill in, whose placeholder read like a filled-in value. On 2026-09-02 the pair of
/// them cost an afternoon of wrong diagnoses -- the internet, then a mode setting, then the box.
///
/// A shop does not choose which cloud its own ERP syncs to. There is one, it belongs to this
/// product, and the app should know it the way it knows its own name. The maintainer put it
/// plainly: *"mujhe khud switch krne ki zarurat hi nhi padni chahiye"*.
///
/// Stated plainly, because it is a real change in what a shipped build does: **an installed
/// FroozERP now contacts this address by itself whenever it can reach it.** That is the product
/// working as intended -- this computer when there is no internet, the cloud when there is, with
/// nothing to switch -- and it is the behaviour that was asked for.
const PRODUCTION_CLOUD_API_URL: &str = "https://froozerp-production-27bb.up.railway.app";

const BACKEND_OWNERSHIP_FILE: &str = "local-backend-owner.json";
const BACKEND_STARTUP_LOCK_FILE: &str = "local-backend-startup.lock";
const UPDATE_TRANSACTION_FILE: &str = "update-transaction.json";
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
#[cfg(target_os = "windows")]
const DETACHED_PROCESS: u32 = 0x00000008;

#[cfg(target_os = "windows")]
fn hide_child_console(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
}

#[cfg(not(target_os = "windows"))]
fn hide_child_console(_command: &mut Command) {}

#[cfg(target_os = "windows")]
fn acquire_desktop_instance_mutex() -> bool {
    let mut name: Vec<u16> = "Local\\com.srtcompany.froozerp.desktop.instance"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let handle = unsafe { CreateMutexW(std::ptr::null(), 1, name.as_mut_ptr()) };
    if handle.is_null() {
        write_app_log(
            "ERROR",
            "Unable to create FroozERP desktop instance mutex; continuing startup",
        );
        return true;
    }
    let already_running = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    if already_running {
        unsafe {
            let _ = CloseHandle(handle);
        }
        write_app_log(
            "INFO",
            "Another FroozERP desktop instance is already running; exiting duplicate launch",
        );
        return false;
    }
    if let Ok(mut guard) = DESKTOP_INSTANCE_MUTEX.lock() {
        *guard = Some(handle as isize);
    }
    true
}

#[cfg(target_os = "windows")]
fn release_desktop_instance_mutex() {
    if let Ok(mut guard) = DESKTOP_INSTANCE_MUTEX.lock() {
        if let Some(handle) = guard.take() {
            unsafe {
                let _ = CloseHandle(handle as _);
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn acquire_desktop_instance_mutex() -> bool {
    true
}

#[cfg(not(target_os = "windows"))]
fn release_desktop_instance_mutex() {}

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

#[derive(Debug, Serialize)]
struct InstallDiagnostics {
    current_executable: String,
    current_install_dir: String,
    desktop_app_version: String,
    package_version: String,
    data_path: String,
    stale_installations: Vec<String>,
    cleanup_message: String,
    update_transaction_status: String,
    update_transaction_message: String,
    update_transaction_target_version: String,
}

#[derive(Debug, Serialize)]
struct UpdateInstallPreparation {
    stopped_owned_backend: bool,
    stopped_port_backend: bool,
    backend_pid_before: Option<u32>,
    backend_executable: String,
    unlocked: bool,
    transaction_path: String,
    message: String,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct UpdateTransactionRecord {
    state: String,
    target_version: String,
    previous_desktop_version: String,
    previous_backend_version: String,
    started_at: u64,
    updated_at: u64,
    install_dir: String,
    executable_path: String,
    backend_executable: String,
    backend_pid_before: Option<u32>,
    message: String,
}

#[derive(Debug, Serialize, Clone)]
struct BackendServiceStatus {
    healthy: bool,
    started: bool,
    reused_existing: bool,
    pid: Option<u32>,
    port_pid: Option<u32>,
    url: String,
    backend_dir: String,
    node_path: String,
    startup_source: String,
    database_path: String,
    startup_log_path: String,
    stdout_log_path: String,
    stderr_log_path: String,
    error_code: String,
    exit_code: Option<i32>,
    stderr_tail: String,
    /// Set when a **release** build is running its backend out of a git working tree.
    ///
    /// `F:\\FroozERP` on the maintainer's laptop is both the installed app and the checkout, so
    /// `current_install_dir().join("backend")` resolves to the repository's own backend folder --
    /// which means every `git pull` silently changes the shop's backend, and a half-finished branch
    /// is one command away from serving real customers.
    ///
    /// Reported rather than refused, deliberately. A refusal here would leave the shop unable to
    /// bill on the spot, and the arrangement has been live for months; the fix is to move the
    /// install, which needs a person and an installer. What was missing was not enforcement, it was
    /// anybody being *told*. So the technical-details panel now says it out loud.
    source_checkout_warning: String,
    message: String,
}

#[derive(Debug, Serialize)]
struct BackendOwnershipRecord {
    backend_instance_id: String,
    app_version: String,
    pid: u32,
    ownership_token: String,
    startup_timestamp: u64,
    backend_dir: String,
    node_path: String,
}

fn diagnostic_log_path() -> PathBuf {
    app_data_dir()
        .join("logs")
        .join("froozerp-startup.log")
}

fn startup_transition_log_path() -> PathBuf {
    app_data_dir()
        .join("logs")
        .join("froozerp-startup-transitions.jsonl")
}

fn backend_stdout_log_path() -> PathBuf {
    app_data_dir()
        .join("logs")
        .join("froozerp-backend-stdout.log")
}

fn backend_stderr_log_path() -> PathBuf {
    app_data_dir()
        .join("logs")
        .join("froozerp-backend-stderr.log")
}

fn local_sqlite_database_path() -> PathBuf {
    app_data_dir().join("froozerp-local.sqlite3")
}

fn tail_text_file(path: &Path, max_bytes: usize) -> String {
    let Ok(bytes) = fs::read(path) else {
        return String::new();
    };
    let start = bytes.len().saturating_sub(max_bytes);
    String::from_utf8_lossy(&bytes[start..]).trim().to_string()
}

/// The one app-data directory every file in the shell lives under.
///
/// Resolution order:
///
/// 1. **The disposable/test override** (`NODE_ENV=test` + an absolute `FROOZERP_ISOLATED_SQLITE_DIR`),
///    on every platform, exactly as before -- `local_db::database_path` applies the same rule, so the
///    SQLite file and everything else stay in one isolated profile.
/// 2. **On a phone, Tauri's path resolver** (`app.path().app_data_dir()`), captured in `setup`.
///    Android and iOS have no `%APPDATA%`, and the old fallback was `temp_dir()` -- on Android an
///    unwritable `/data/local/tmp` -- so logs, the gateway policy file and the WebView-recovery
///    marker would all have failed. It is also what `local_db` already uses for the database.
/// 3. **Everywhere else, `%APPDATA%\com.srtcompany.froozerp`, unchanged.** On Windows Tauri's
///    resolver lands in the same folder (`dirs::data_dir()` is FOLDERID_RoamingAppData, plus the
///    identifier), but it is not the same *rule*: it ignores the `APPDATA` variable, which the
///    Windows lifecycle test overrides, and it does not exist before `setup`, while the panic hook
///    and the first log line need a path earlier than that. So the Windows code path is kept as is.
///
/// Before `setup` on a phone (the first log line only) this falls through to (3); nothing is
/// persisted there. Code that must not use a guessed directory calls `app_data_dir_if_resolved`.
fn app_data_dir() -> PathBuf {
    if let Some(path) = isolated_app_data_dir() {
        return path;
    }
    if cfg!(mobile) {
        if let Some(path) = RESOLVED_APP_DATA_DIR.get() {
            return path.clone();
        }
    }
    env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| env::temp_dir())
        .join("com.srtcompany.froozerp")
}

/// The disposable/test profile override: `NODE_ENV=test` and an absolute
/// `FROOZERP_ISOLATED_SQLITE_DIR`. A relative path is ignored, as it always was.
fn isolated_app_data_dir() -> Option<PathBuf> {
    if env::var("NODE_ENV").ok().as_deref() != Some("test") {
        return None;
    }
    env::var_os("FROOZERP_ISOLATED_SQLITE_DIR")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

/// `app_data_dir()`, or `None` on a phone whose directory has not been resolved (before `setup`, or
/// if the resolver failed). The phone gateway treats `None` as an unreadable policy -- cloud access
/// denied -- rather than reading a guessed directory, finding no policy file and allowing it.
fn app_data_dir_if_resolved() -> Option<PathBuf> {
    if cfg!(mobile) && isolated_app_data_dir().is_none() && RESOLVED_APP_DATA_DIR.get().is_none() {
        return None;
    }
    Some(app_data_dir())
}

/// Captures Tauri's app-data directory. Called first thing in `setup` on every platform, so the
/// desktop build exercises it too; only a phone reads the value back (see `app_data_dir`).
fn remember_resolved_app_data_dir(app: &AppHandle) {
    match app.path().app_data_dir() {
        Ok(path) => {
            let _ = RESOLVED_APP_DATA_DIR.set(path);
        }
        Err(error) => write_app_log(
            "ERROR",
            &format!("Unable to resolve the app data directory: {}", error),
        ),
    }
}

/// The message a desktop-only command returns in the phone app.
#[cfg_attr(desktop, allow(dead_code))]
fn not_in_phone_app<T>(feature: &str) -> Result<T, String> {
    Err(format!("{} is not available in the phone app.", feature))
}

/// Creates and migrates the phone app's SQLite file once. No-op on desktop, where the sidecar launch
/// does it (`ensure_local_backend_service_internal`).
fn ensure_mobile_sqlite_ready() {
    if !cfg!(mobile) || app_data_dir_if_resolved().is_none() {
        return;
    }
    let mut ready = MOBILE_SQLITE_READY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if *ready {
        return;
    }
    match local_db::initialize_path(&local_sqlite_database_path()) {
        Ok(status) => {
            write_app_log(
                "INFO",
                &format!(
                    "Phone SQLite initialized: path={}, schema={}",
                    status.database_path, status.schema_version
                ),
            );
            *ready = true;
        }
        Err(error) => write_app_log(
            "ERROR",
            &format!("Unable to initialize phone SQLite database: {}", error),
        ),
    }
}

/// The phone gateway's view of this installation: the same directory, database and cloud address
/// the desktop shell hands `desktopGateway.js` (`FROOZERP_APP_DATA_DIR`, `FROOZERP_SQLITE_PATH`,
/// `CLOUD_API_URL`), and a probe that can only connect on a phone.
fn with_gateway_context<T>(run: impl FnOnce(&mobile_gateway::GatewayContext<'_>) -> T) -> T {
    let app_data_dir = app_data_dir_if_resolved();
    let sqlite_path = app_data_dir
        .as_ref()
        .map(|_| local_sqlite_database_path());
    // On desktop the Node gateway owns every cloud request; the shell itself never makes one.
    #[cfg(mobile)]
    let probe = mobile_gateway::HttpCloudProbe;
    #[cfg(desktop)]
    let probe = mobile_gateway::NoNetworkProbe;
    let context = mobile_gateway::GatewayContext {
        app_data_dir,
        sqlite_path,
        cloud_api_url: mobile_gateway::normalize_cloud_api_url(&cloud_api_url()),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        probe: &probe,
    };
    run(&context)
}

#[tauri::command]
fn runtime_profile() -> mobile_gateway::RuntimeProfile {
    mobile_gateway::runtime_profile()
}

const PHONE_GATEWAY_ONLY: &str = "The phone gateway commands run only in the phone app; the desktop uses its local gateway.";

/// The local routes of `desktopGateway.js`, for the phone. See `mobile_gateway.rs`.
#[tauri::command]
async fn mobile_gateway_request(
    request: mobile_gateway::GatewayRequest,
) -> Result<mobile_gateway::GatewayResponse, String> {
    // The desktop has the Node gateway for this; a second writer of its policy file and audit log
    // from the desktop webview would be a second door into the kill switch.
    if !cfg!(mobile) {
        return Err(PHONE_GATEWAY_ONLY.to_string());
    }
    // Off the main thread: /api/cloud/health and an Owner's switch back to Auto each wait on the
    // cloud (up to 8 s and 5 s, as in the gateway).
    tauri::async_runtime::spawn_blocking(move || {
        ensure_mobile_sqlite_ready();
        with_gateway_context(|context| mobile_gateway::handle_request(context, &request))
    })
    .await
    .map_err(|error| error.to_string())
}

/// The gateway's LOCAL_ONLY / cloud-configured decision (and audit) for a request it would proxy.
#[tauri::command]
async fn mobile_gateway_cloud_decision(
    request: mobile_gateway::CloudDecisionRequest,
) -> Result<mobile_gateway::CloudDecision, String> {
    if !cfg!(mobile) {
        return Err(PHONE_GATEWAY_ONLY.to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        with_gateway_context(|context| mobile_gateway::cloud_decision(context, &request))
    })
    .await
    .map_err(|error| error.to_string())
}

#[cfg(desktop)]
fn cleanup_updater_temp_artifacts() {
    let temp_dir = env::temp_dir();
    let Ok(entries) = fs::read_dir(&temp_dir) else {
        write_app_log(
            "ERROR",
            &format!(
                "Unable to inspect updater temp directory: {}",
                temp_dir.to_string_lossy()
            ),
        );
        return;
    };
    let mut removed = 0usize;
    let mut blocked = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("FroozERP-") || !name.contains("-updater-") {
            continue;
        }
        if !path.is_dir() {
            continue;
        }
        match fs::remove_dir_all(&path) {
            Ok(_) => {
                removed += 1;
                write_app_log(
                    "INFO",
                    &format!("Removed completed updater temp folder {}", path.to_string_lossy()),
                );
            }
            Err(error) => {
                blocked += 1;
                write_app_log(
                    "ERROR",
                    &format!(
                        "Unable to remove updater temp folder {}: {}",
                        path.to_string_lossy(),
                        error
                    ),
                );
            }
        }
    }
    if removed > 0 || blocked > 0 {
        write_app_log(
            "INFO",
            &format!(
                "Updater temp cleanup finished: removed={}, blocked={}",
                removed, blocked
            ),
        );
    }
}

fn backend_ownership_path() -> PathBuf {
    app_data_dir().join("runtime").join(BACKEND_OWNERSHIP_FILE)
}

fn backend_startup_lock_path() -> PathBuf {
    app_data_dir()
        .join("runtime")
        .join(BACKEND_STARTUP_LOCK_FILE)
}

fn update_transaction_path() -> PathBuf {
    app_data_dir().join("runtime").join(UPDATE_TRANSACTION_FILE)
}

fn read_update_transaction() -> Option<UpdateTransactionRecord> {
    fs::read_to_string(update_transaction_path())
        .ok()
        .and_then(|payload| serde_json::from_str(&payload).ok())
}

fn write_update_transaction(record: &UpdateTransactionRecord) -> Result<(), String> {
    let path = update_transaction_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let payload = serde_json::to_string_pretty(record).map_err(|error| error.to_string())?;
    fs::write(path, payload).map_err(|error| error.to_string())
}

fn update_transaction_status() -> (String, String, String) {
    read_update_transaction()
        .map(|record| (record.state, record.message, record.target_version))
        .unwrap_or_else(|| ("none".to_string(), String::new(), String::new()))
}

fn reconcile_update_transaction(backend_status: &BackendServiceStatus) {
    let Some(mut record) = read_update_transaction() else {
        return;
    };
    if !matches!(
        record.state.as_str(),
        "installing" | "restarting" | "verifying_after_restart" | "partial" | "failed"
    ) {
        return;
    }
    let desktop_version = env!("CARGO_PKG_VERSION").to_string();
    record.updated_at = now_unix_seconds();
    if desktop_version == record.target_version && backend_status.healthy {
        record.state = "success".to_string();
        record.message = format!(
            "Update verified after restart: desktop {}, backend healthy at target {}.",
            desktop_version, record.target_version
        );
    } else if desktop_version != record.target_version {
        record.state = "failed".to_string();
        record.message = format!(
            "Previous update did not complete. Expected desktop {}, running {}.",
            record.target_version, desktop_version
        );
    } else {
        record.state = "partial".to_string();
        record.message = format!(
            "Previous update requires repair. Desktop is {}, but backend health is not verified: {}",
            desktop_version, backend_status.message
        );
    }
    let _ = write_update_transaction(&record);
    write_app_log(
        if record.state == "success" { "INFO" } else { "ERROR" },
        &format!("Update transaction reconciled: {} - {}", record.state, record.message),
    );
}

fn now_unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn desktop_instance_token() -> String {
    format!("froozerp-{}-{}", std::process::id(), now_unix_seconds())
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

fn local_backend_port() -> String {
    #[cfg(test)]
    if let Ok(port) = env::var("FROOZERP_TEST_BACKEND_PORT") {
        if port.parse::<u16>().is_ok() {
            return port;
        }
    }
    // Decided by how this binary was built, not by an environment variable. A variable has to be
    // set correctly in every terminal window, and `run-disposable-app.mjs` exists precisely because
    // that turned out not to be a safeguard.
    if cfg!(debug_assertions) {
        return DEV_BACKEND_PORT.to_string();
    }
    LOCAL_BACKEND_PORT.to_string()
}

/// The cloud address handed to the gateway, or an empty string for "this installation has none".
///
/// Two rules, in order:
///
/// 1. **An explicit address always wins**, in either build. That is how a rehearsal points at a
///    sandbox, and it is the only way a second deployment would ever be possible.
/// 2. **A development build has no cloud unless it was given one.** `npm run app:disposable` seeds
///    itself from a copy of live business data, and a rehearsal that quietly synced that copy into
///    production would be worse than anything it was rehearsing for. Same reasoning as
///    `DEV_BACKEND_PORT`, and the same mechanism: decided by how the binary was built, because an
///    environment variable has to be set correctly in every terminal window.
///
/// The empty string is passed to the child explicitly rather than left unset, so an inherited
/// `CLOUD_API_URL` from some other tool's shell cannot become a development build's cloud by
/// accident.
fn cloud_api_url() -> String {
    for name in ["FROOZERP_CLOUD_API_URL", "CLOUD_API_URL"] {
        if let Ok(configured) = env::var(name) {
            let trimmed = configured.trim().trim_end_matches('/');
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    if cfg!(mobile) {
        return mobile_cloud_api_url();
    }
    if cfg!(debug_assertions) {
        return String::new();
    }
    PRODUCTION_CLOUD_API_URL.to_string()
}

/// The cloud a phone build talks to. A phone has no shell environment to set and no disposable
/// profile holding a copy of live data (the reason a desktop debug build gets no cloud), so the
/// address is chosen when the APK is built: `FROOZERP_MOBILE_CLOUD_API_URL` at compile time for a
/// rehearsal cloud, otherwise production. Without one a debug APK could never sign in at all.
fn mobile_cloud_api_url() -> String {
    if let Some(configured) = option_env!("FROOZERP_MOBILE_CLOUD_API_URL") {
        let trimmed = configured.trim().trim_end_matches('/');
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    PRODUCTION_CLOUD_API_URL.to_string()
}

fn local_backend_url() -> String {
    format!("http://127.0.0.1:{}", local_backend_port())
}

fn local_backend_health_response(timeout_ms: u64) -> Result<String, String> {
    let port = local_backend_port();
    let address = format!("127.0.0.1:{}", port);
    let timeout = Duration::from_millis(timeout_ms);
    let mut stream = TcpStream::connect_timeout(
        &address
            .parse()
            .map_err(|error| format!("Invalid backend address: {}", error))?,
        timeout,
    )
    .map_err(|error| format!("Local backend not reachable: {}", error))?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    stream
        .write_all(
            format!(
                "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
                port
            )
            .as_bytes(),
        )
        .map_err(|error| format!("Local backend health request failed: {}", error))?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| format!("Local backend health response failed: {}", error))?;
    Ok(response)
}

fn extract_http_body(response: &str) -> &str {
    response
        .split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .unwrap_or(response)
}

fn local_backend_health_json(timeout_ms: u64) -> Result<serde_json::Value, String> {
    let response = local_backend_health_response(timeout_ms)?;
    if response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200") {
        if response.contains("\"FroozERP\"") || response.contains("FroozERP") {
            return serde_json::from_str(extract_http_body(&response))
                .map_err(|error| format!("Local backend health JSON failed: {}", error));
        }
        return Err(format!("Port {} responded, but it is not FroozERP.", local_backend_port()));
    }
    Err(format!(
        "Port {} responded without healthy status: {}",
        local_backend_port(),
        response.lines().next().unwrap_or("no status line")
    ))
}

fn probe_local_backend_health(timeout_ms: u64) -> Result<(), String> {
    local_backend_health_json(timeout_ms).map(|_| ())
}

fn local_backend_version(timeout_ms: u64) -> Result<String, String> {
    let health = local_backend_health_json(timeout_ms)?;
    Ok(health
        .get("version")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string())
}

fn local_backend_version_matches(timeout_ms: u64) -> Result<bool, String> {
    let version = local_backend_version(timeout_ms)?;
    Ok(version.trim() == env!("CARGO_PKG_VERSION"))
}

fn spawned_backend_owns_port(spawned_pid: u32, port_owner_pid: Option<u32>) -> bool {
    port_owner_pid == Some(spawned_pid)
}

fn backend_dir_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let install_dir = current_install_dir();
    candidates.push(install_dir.join("backend"));
    candidates.push(install_dir.join("_up_").join("backend"));
    candidates.push(install_dir.join("resources").join("backend"));
    if cfg!(debug_assertions) {
        if let Some(path) = env::var_os("FROOZERP_BACKEND_DIR").map(PathBuf::from) {
            candidates.push(path);
        }
        if let Ok(current_dir) = env::current_dir() {
            candidates.push(current_dir.join("backend"));
            candidates.push(current_dir.join("..").join("backend"));
        }
    } else if let Ok(current_dir) = env::current_dir() {
        if is_under(&current_dir, &install_dir) {
            candidates.push(current_dir.join("backend"));
            candidates.push(current_dir.join("..").join("backend"));
        }
    }
    candidates
}

/// Whether this backend directory sits inside a git working tree.
///
/// Walks upward looking for `.git`, because the checkout root is usually the backend's parent but
/// need not be. Bounded so a pathological path cannot spin: a repository nested deeper than this
/// is not the arrangement being guarded against.
fn backend_dir_is_in_checkout(backend_dir: &Path) -> bool {
    let mut current = Some(backend_dir);
    for _ in 0..6 {
        let Some(dir) = current else { return false };
        if dir.join(".git").exists() {
            return true;
        }
        current = dir.parent();
    }
    false
}

/// The warning to show, or empty when there is nothing to say.
///
/// Debug builds are exempt: a development build is *supposed* to run from the checkout, and saying
/// so on every dev run would train the reader to ignore the line that matters.
fn source_checkout_warning_for(backend_dir: Option<&Path>) -> String {
    if cfg!(debug_assertions) {
        return String::new();
    }
    match backend_dir {
        Some(dir) if backend_dir_is_in_checkout(dir) => format!(
            "This app is running its backend from a source checkout ({}). Every code update pulled \
             into that folder changes this app immediately. Move the installation to its own folder.",
            dir.display()
        ),
        _ => String::new(),
    }
}

fn resolve_backend_dir() -> Result<PathBuf, String> {
    backend_dir_candidates()
        .into_iter()
        .find(|path| path.join("desktopGateway.js").exists())
        .ok_or_else(|| "Packaged FroozERP backend was not found.".to_string())
}

fn node_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let install_dir = current_install_dir();
    // An explicit override has to come first or it is not an override. `resolve_node_path` takes
    // the first candidate that exists, and a dev checkout always has the bundled
    // `froozerp-backend-node.exe` on disk, so an override placed after it could never be reached.
    // It stays behind `debug_assertions`: a packaged release must never take the interpreter it
    // executes from the environment.
    if cfg!(debug_assertions) {
        if let Some(path) = env::var_os("FROOZERP_NODE_PATH").map(PathBuf::from) {
            candidates.push(path);
        }
    }
    candidates.push(
        install_dir
            .join("binaries")
            .join("froozerp-backend-node.exe"),
    );
    candidates.push(install_dir.join("froozerp-backend-node.exe"));
    candidates.push(
        install_dir
            .join("_up_")
            .join("binaries")
            .join("froozerp-backend-node.exe"),
    );
    candidates.push(
        install_dir
            .join("resources")
            .join("binaries")
            .join("froozerp-backend-node.exe"),
    );
    if cfg!(debug_assertions) {
        if let Ok(current_dir) = env::current_dir() {
            candidates.push(
                current_dir
                    .join("src-tauri")
                    .join("binaries")
                    .join("froozerp-backend-node.exe"),
            );
            candidates.push(
                current_dir
                    .join("binaries")
                    .join("froozerp-backend-node.exe"),
            );
            candidates.push(PathBuf::from("node"));
        }
    } else if let Ok(current_dir) = env::current_dir() {
        if is_under(&current_dir, &install_dir) {
            candidates.push(
                current_dir
                    .join("binaries")
                    .join("froozerp-backend-node.exe"),
            );
        }
    }
    candidates
}

fn resolve_node_path() -> PathBuf {
    let install_dir = current_install_dir();
    node_candidates()
        .into_iter()
        .find(|path| path == Path::new("node") || path.exists())
        .unwrap_or_else(|| {
            install_dir
                .join("binaries")
                .join("froozerp-backend-node.exe")
        })
}

fn acquire_backend_startup_lock() -> Result<fs::File, String> {
    let path = backend_startup_lock_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    for attempt in 1..=24 {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                let _ = writeln!(
                    file,
                    "pid={}\napp_version={}\nstarted_at={}",
                    std::process::id(),
                    env!("CARGO_PKG_VERSION"),
                    now_unix_seconds()
                );
                return Ok(file);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if probe_local_backend_health(900).is_ok() {
                    return Err("Local FroozERP service became healthy while another app instance was starting it.".to_string());
                }
                if attempt == 12 {
                    write_app_log("ERROR", "Backend startup lock appears stale; removing it after repeated failed health checks");
                    let _ = fs::remove_file(&path);
                } else {
                    thread::sleep(Duration::from_millis(500));
                }
            }
            Err(error) => return Err(format!("Unable to create backend startup lock: {}", error)),
        }
    }
    Err(
        "Another FroozERP window is starting the local service. Retry in a few seconds."
            .to_string(),
    )
}

fn release_backend_startup_lock() {
    let _ = fs::remove_file(backend_startup_lock_path());
}

fn backend_startup_source(node_path: &Path) -> &'static str {
    let path = node_path.to_string_lossy().to_lowercase();
    if path.contains("froozerp-backend-node.exe") {
        "packaged"
    } else if path == "node" || path.ends_with("\\node.exe") {
        "system-fallback"
    } else {
        "custom"
    }
}

#[cfg(desktop)]
fn backend_status(
    message: String,
    healthy: bool,
    started: bool,
    reused_existing: bool,
    pid: Option<u32>,
    backend_dir: Option<PathBuf>,
    node_path: Option<PathBuf>,
    startup_source: &str,
) -> BackendServiceStatus {
    let stderr_log_path = backend_stderr_log_path();
    // Captured before `backend_dir` is consumed into the struct below.
    let backend_dir_for_warning = backend_dir.clone();
    BackendServiceStatus {
        healthy,
        started,
        reused_existing,
        pid,
        port_pid: backend_port_owner_pid(),
        url: local_backend_url(),
        backend_dir: backend_dir
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
        node_path: node_path
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
        startup_source: startup_source.to_string(),
        database_path: local_sqlite_database_path().to_string_lossy().to_string(),
        startup_log_path: diagnostic_log_path().to_string_lossy().to_string(),
        stdout_log_path: backend_stdout_log_path().to_string_lossy().to_string(),
        stderr_log_path: stderr_log_path.to_string_lossy().to_string(),
        error_code: if healthy { "OK" } else { "LOCAL_BACKEND_UNHEALTHY" }.to_string(),
        exit_code: None,
        stderr_tail: tail_text_file(&stderr_log_path, 4096),
        source_checkout_warning: source_checkout_warning_for(backend_dir_for_warning.as_deref()),
        message,
    }
}

fn write_backend_ownership(pid: u32, token: &str, backend_dir: &Path, node_path: &Path) {
    let path = backend_ownership_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let record = BackendOwnershipRecord {
        backend_instance_id: format!("froozerp-local-{}", pid),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        pid,
        ownership_token: token.to_string(),
        startup_timestamp: now_unix_seconds(),
        backend_dir: backend_dir.to_string_lossy().to_string(),
        node_path: node_path.to_string_lossy().to_string(),
    };
    if let Ok(payload) = serde_json::to_string_pretty(&record) {
        let _ = fs::write(path, payload);
    }
}

fn clear_backend_ownership(token: &str) {
    let path = backend_ownership_path();
    let content = fs::read_to_string(&path).unwrap_or_default();
    if token.is_empty() || content.contains(&format!("\"ownership_token\": \"{}\"", token)) {
        let _ = fs::remove_file(path);
    }
}

#[cfg(desktop)]
fn stop_owned_backend(reason: &str) -> bool {
    let mut stopped_owned_backend = false;
    if let Ok(mut guard) = LOCAL_BACKEND_PROCESS.lock() {
        if let Some(mut child) = guard.take() {
            let pid = child.id();
            write_app_log(
                "INFO",
                &format!("Stopping owned local backend PID {} ({})", pid, reason),
            );
            // Stop the gateway's whole process tree first. `child.kill()` is TerminateProcess on
            // Windows: the gateway runs no exit handler, so the speech server it started
            // (`whisper-server.exe`, about 500 MB with the model loaded) would outlive the app
            // until the next launch cleaned it up. The kill below stays for anything taskkill missed.
            #[cfg(target_os = "windows")]
            {
                let mut tree = Command::new("taskkill.exe");
                hide_child_console(&mut tree);
                let _ = tree.args(["/PID", &pid.to_string(), "/T", "/F"]).status();
            }
            let _ = child.kill();
            let _ = child.wait();
            stopped_owned_backend = true;
        }
    }
    if stopped_owned_backend {
        clear_backend_ownership("");
    }
    stopped_owned_backend
}

/// The Node sidecar (`desktopGateway.js`). Desktop only: a phone has no Node runtime and no
/// `froozerp-backend-node.exe`; its local routes are served by `mobile_gateway` instead.
#[cfg(desktop)]
fn ensure_local_backend_service_internal(force_restart: bool) -> BackendServiceStatus {
    // The native startup worker and the React startup check can arrive together.
    // Serialize them so one valid launch cannot be mistaken for a stale lock.
    let _start_guard = LOCAL_BACKEND_START_GUARD
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    if !force_restart && local_backend_version_matches(900).unwrap_or(false) {
        write_app_log("INFO", "Local backend already healthy with matching version; reusing existing port 5000 service");
        return backend_status(
            "Local FroozERP service is already running.".to_string(),
            true,
            false,
            true,
            backend_port_owner_pid(),
            None,
            Some(resolve_node_path()),
            "reused",
        );
    } else if !force_restart {
        if let Ok(version) = local_backend_version(900) {
            write_app_log(
                "ERROR",
                &format!(
                    "Local backend version mismatch: desktop {}, backend {}",
                    env!("CARGO_PKG_VERSION"),
                    version
                ),
            );
            return backend_status(
                format!(
                    "Local FroozERP service version mismatch: desktop {}, backend {}. Restart service.",
                    env!("CARGO_PKG_VERSION"),
                    version
                ),
                false,
                false,
                true,
                backend_port_owner_pid(),
                None,
                Some(resolve_node_path()),
                "version-mismatch",
            );
        }
    }

    if force_restart {
        release_backend_startup_lock();
        clear_backend_ownership("");
        stop_owned_backend("restart requested");
        thread::sleep(Duration::from_millis(300));
        if probe_local_backend_health(500).is_ok() {
            if let Some(pid) = backend_port_owner_pid() {
                let _ = stop_verified_backend_pid(pid, "restart requested");
                thread::sleep(Duration::from_millis(500));
            }
        }
        if local_backend_version_matches(900).unwrap_or(false) {
            return backend_status(
                "An external FroozERP service is already running on port 5000.".to_string(),
                true,
                false,
                true,
                backend_port_owner_pid(),
                None,
                Some(resolve_node_path()),
                "reused",
            );
        }
    }

    if let Ok(mut guard) = LOCAL_BACKEND_PROCESS.lock() {
        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    write_app_log(
                        "ERROR",
                        &format!("Managed local backend exited with status {}", status),
                    );
                    *guard = None;
                }
                Ok(None) => {
                    if local_backend_version_matches(900).unwrap_or(false) {
                        return backend_status(
                            "Managed local FroozERP service is running.".to_string(),
                            true,
                            false,
                            false,
                            Some(child.id()),
                            None,
                            Some(resolve_node_path()),
                            "owned",
                        );
                    }
                }
                Err(error) => {
                    write_app_log(
                        "ERROR",
                        &format!("Unable to inspect local backend process: {}", error),
                    );
                    *guard = None;
                }
            }
        }
    }

    let startup_lock = match acquire_backend_startup_lock() {
        Ok(lock) => Some(lock),
        Err(message) => {
            if local_backend_version_matches(900).unwrap_or(false) {
                write_app_log("INFO", &message);
                return backend_status(
                    "Local FroozERP service is already running.".to_string(),
                    true,
                    false,
                    true,
                    backend_port_owner_pid(),
                    None,
                    Some(resolve_node_path()),
                    "reused",
                );
            }
            write_app_log("ERROR", &message);
            return backend_status(
                message,
                false,
                false,
                false,
                None,
                None,
                None,
                "startup-lock",
            );
        }
    };

    if local_backend_version_matches(900).unwrap_or(false) {
        drop(startup_lock);
        release_backend_startup_lock();
        write_app_log(
            "INFO",
            "Local backend became healthy before launch; reusing it",
        );
        return backend_status(
            "Local FroozERP service is already running.".to_string(),
            true,
            false,
            true,
            backend_port_owner_pid(),
            None,
            Some(resolve_node_path()),
            "reused",
        );
    }

    let backend_dir = match resolve_backend_dir() {
        Ok(path) => path,
        Err(error) => {
            drop(startup_lock);
            release_backend_startup_lock();
            write_app_log("ERROR", &format!("Local backend launch blocked: {}", error));
            let mut status = backend_status(error, false, false, false, None, None, None, "unavailable");
            status.error_code = "BACKEND_RESOURCES_MISSING".to_string();
            return status;
        }
    };
    let node_path = resolve_node_path();
    let startup_source = backend_startup_source(&node_path);
    if !node_path.exists() {
        drop(startup_lock);
        release_backend_startup_lock();
        let message = format!(
            "Packaged FroozERP backend runtime was not found at {}.",
            node_path.to_string_lossy()
        );
        write_app_log("ERROR", &message);
        let mut status = backend_status(
            message,
            false,
            false,
            false,
            None,
            Some(backend_dir),
            Some(node_path),
            startup_source,
        );
        status.error_code = "BACKEND_RUNTIME_MISSING".to_string();
        return status;
    }
    let desktop_gateway_path = backend_dir.join("desktopGateway.js");
    if !desktop_gateway_path.exists() {
        drop(startup_lock);
        release_backend_startup_lock();
        let message = format!(
            "Packaged FroozERP backend resources are incomplete. desktop_gateway_exists={}, backend_dir={}",
            desktop_gateway_path.exists(),
            backend_dir.to_string_lossy()
        );
        write_app_log("ERROR", &message);
        let mut status = backend_status(
            message,
            false,
            false,
            false,
            None,
            Some(backend_dir),
            Some(node_path),
            startup_source,
        );
        status.error_code = "BACKEND_RESOURCES_INCOMPLETE".to_string();
        return status;
    }
    let owner_token = desktop_instance_token();
    let sqlite_path = local_sqlite_database_path();
    match local_db::initialize_path(&sqlite_path) {
        Ok(status) => write_app_log(
            "INFO",
            &format!(
                "Desktop SQLite initialized: path={}, schema={}",
                status.database_path, status.schema_version
            ),
        ),
        Err(error) => {
            drop(startup_lock);
            release_backend_startup_lock();
            let message = format!("Unable to initialize desktop SQLite database: {}", error);
            write_app_log("ERROR", &message);
            let mut status = backend_status(
                message,
                false,
                false,
                false,
                None,
                Some(backend_dir),
                Some(node_path),
                startup_source,
            );
            status.error_code = "LOCAL_SQLITE_INITIALIZATION_FAILED".to_string();
            return status;
        }
    }
    write_app_log(
        "INFO",
        &format!(
            "Launching local backend: node={}, backend_dir={}, source={}",
            node_path.to_string_lossy(),
            backend_dir.to_string_lossy(),
            startup_source
        ),
    );
    let stdout_log = backend_stdout_log_path();
    let stderr_log = backend_stderr_log_path();
    if let Some(parent) = stdout_log.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let stdout_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&stdout_log)
        .ok();
    let stderr_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&stderr_log)
        .ok();
    let mut command = Command::new(&node_path);
    command
        .arg("desktopGateway.js")
        .current_dir(&backend_dir)
        .env("PORT", local_backend_port())
        .env("APP_VERSION", env!("CARGO_PKG_VERSION"))
        .env("APP_MODE", "LOCAL_SINGLE_DEVICE")
        .env("CLOUD_API_URL", cloud_api_url())
        // The gateway used to derive this from %APPDATA% itself, which meant a disposable run --
        // whose whole purpose is isolation -- still read and wrote the real machine's connectivity
        // policy and audit log. `app_data_dir()` already honours FROOZERP_ISOLATED_SQLITE_DIR, so
        // passing it through makes the gateway isolated by the same rule as everything else.
        .env("FROOZERP_APP_DATA_DIR", app_data_dir())
        .env("FROOZERP_RUNTIME_MODE", "desktop-local")
        .env("FROOZERP_LOCAL_STORAGE", "sqlite")
        .env("FROOZERP_SQLITE_PATH", &sqlite_path)
        .env("FROOZERP_DESKTOP_SERVICE", "1")
        .env("FROOZERP_BACKEND_OWNER_TOKEN", &owner_token)
        .env_remove("DATABASE_URL")
        .env_remove("CLOUD_DATABASE_URL")
        .env_remove("DB_HOST")
        .env_remove("DB_PORT")
        .env_remove("DB_NAME")
        .env_remove("DB_USER")
        .env_remove("DB_PASSWORD")
        .stdin(Stdio::null());
    match stdout_file {
        Some(file) => {
            command.stdout(Stdio::from(file));
        }
        None => {
            command.stdout(Stdio::null());
        }
    };
    match stderr_file {
        Some(file) => {
            command.stderr(Stdio::from(file));
        }
        None => {
            command.stderr(Stdio::null());
        }
    };
    hide_child_console(&mut command);
    let child = command.spawn();

    let mut child = match child {
        Ok(child) => child,
        Err(error) => {
            drop(startup_lock);
            release_backend_startup_lock();
            let message = format!("Unable to launch local FroozERP service: {}", error);
            write_app_log("ERROR", &message);
            let mut status = backend_status(
                message,
                false,
                false,
                false,
                None,
                Some(backend_dir),
                Some(node_path),
                startup_source,
            );
            status.error_code = "BACKEND_SPAWN_FAILED".to_string();
            return status;
        }
    };
    let pid = child.id();
    write_backend_ownership(pid, &owner_token, &backend_dir, &node_path);
    write_app_log("INFO", &format!("Local backend launch attempt PID {}", pid));
    for attempt in 1..=16 {
        thread::sleep(Duration::from_millis(750));
        match child.try_wait() {
            Ok(Some(exit_status)) => {
                drop(startup_lock);
                release_backend_startup_lock();
                clear_backend_ownership(&owner_token);
                let exit_code = exit_status.code();
                let stderr_tail = tail_text_file(&stderr_log, 4096);
                let message = format!(
                    "Local FroozERP service exited before becoming healthy. exit_code={:?}. See backend stderr log: {}",
                    exit_code,
                    stderr_log.to_string_lossy()
                );
                write_app_log("ERROR", &format!("{} stderr_tail={}", message, stderr_tail));
                let mut status = backend_status(
                    message,
                    false,
                    true,
                    false,
                    Some(pid),
                    Some(backend_dir),
                    Some(node_path),
                    startup_source,
                );
                status.error_code = "BACKEND_EXITED_BEFORE_HEALTHY".to_string();
                status.exit_code = exit_code;
                status.stderr_tail = stderr_tail;
                return status;
            }
            Ok(None) => {}
            Err(error) => {
                write_app_log("ERROR", &format!("Unable to inspect backend PID {}: {}", pid, error));
            }
        }
        match local_backend_version_matches(900) {
            Ok(true) => {
                let port_owner_pid = backend_port_owner_pid();
                if !spawned_backend_owns_port(pid, port_owner_pid) {
                    let competing_pid = port_owner_pid;
                    write_app_log(
                        "ERROR",
                        &format!(
                            "Backend PID {} became healthy through competing port owner {:?}; stopping losing child",
                            pid, competing_pid
                        ),
                    );
                    let _ = child.kill();
                    let _ = child.wait();
                    clear_backend_ownership(&owner_token);
                    drop(startup_lock);
                    release_backend_startup_lock();
                    return backend_status(
                        "Existing FroozERP service won the startup race; duplicate child was stopped."
                            .to_string(),
                        competing_pid.is_some(),
                        false,
                        true,
                        competing_pid,
                        Some(backend_dir),
                        Some(node_path),
                        "reused-race-winner",
                    );
                }
                drop(startup_lock);
                release_backend_startup_lock();
                let message = format!("Local FroozERP service started on attempt {}", attempt);
                write_app_log("INFO", &message);
                if let Ok(mut guard) = LOCAL_BACKEND_PROCESS.lock() {
                    *guard = Some(child);
                }
                return backend_status(
                    message,
                    true,
                    true,
                    false,
                    Some(pid),
                    Some(backend_dir),
                    Some(node_path),
                    startup_source,
                );
            }
            Ok(false) => {
                write_app_log(
                    "INFO",
                    &format!("Local backend version mismatch pending attempt {}", attempt),
                );
            }
            Err(error) => {
                write_app_log(
                    "INFO",
                    &format!(
                        "Local backend health pending attempt {}: {}",
                        attempt, error
                    ),
                );
            }
        }
    }
    let message =
        "Local FroozERP service stopped or did not become healthy. Restart service.".to_string();
    write_app_log("ERROR", &message);
    drop(startup_lock);
    release_backend_startup_lock();
    if let Ok(mut guard) = LOCAL_BACKEND_PROCESS.lock() {
        *guard = Some(child);
    }
    let mut status = backend_status(
        message,
        false,
        true,
        false,
        Some(pid),
        Some(backend_dir),
        Some(node_path),
        startup_source,
    );
    status.error_code = "BACKEND_HEALTH_TIMEOUT".to_string();
    status.stderr_tail = tail_text_file(&stderr_log, 4096);
    status
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

/// Windows install cleanup (Program Files folders, shortcuts, `reg query`). Desktop only.
#[cfg(desktop)]
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
    let mut reg_query = Command::new("reg");
    hide_child_console(&mut reg_query);
    let legacy_chrome_key_exists = reg_query
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
        old_install_paths.push(program_files.join("FroozERP"));
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

#[cfg(desktop)]
fn froozerp_install_diagnostics(package_version: String) -> InstallDiagnostics {
    let cleanup = froozerp_cleanup_candidates();
    let (update_transaction_status, update_transaction_message, update_transaction_target_version) =
        update_transaction_status();
    let current_executable = env::current_exe()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();
    let stale_installations = cleanup
        .candidates
        .iter()
        .filter(|candidate| candidate.kind == "install-folder")
        .map(|candidate| candidate.path.clone())
        .collect();
    InstallDiagnostics {
        current_executable,
        current_install_dir: cleanup.install_path,
        desktop_app_version: package_version.clone(),
        package_version,
        data_path: cleanup.data_path,
        stale_installations,
        cleanup_message: cleanup.message,
        update_transaction_status,
        update_transaction_message,
        update_transaction_target_version,
    }
}

fn is_file_unlocked(path: &Path) -> bool {
    if !path.exists() {
        return true;
    }
    OpenOptions::new().read(true).write(true).open(path).is_ok()
}

fn wait_for_file_unlock(path: &Path, attempts: usize, delay: Duration) -> bool {
    for _ in 0..attempts {
        if is_file_unlocked(path) {
            return true;
        }
        thread::sleep(delay);
    }
    is_file_unlocked(path)
}

/// Who listens on the backend port, from `netstat -ano -p tcp` (Windows syntax). Desktop only.
#[cfg(desktop)]
fn backend_port_owner_pid() -> Option<u32> {
    let mut netstat = Command::new("netstat");
    hide_child_console(&mut netstat);
    let output = netstat.args(["-ano", "-p", "tcp"]).output().ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let port_suffix = format!(":{}", local_backend_port());
    for line in stdout.lines() {
        let normalized = line.split_whitespace().collect::<Vec<_>>();
        if normalized.len() >= 5
            && normalized[0].eq_ignore_ascii_case("TCP")
            && normalized[1].ends_with(&port_suffix)
            && normalized[3].eq_ignore_ascii_case("LISTENING")
        {
            if let Ok(pid) = normalized[4].parse::<u32>() {
                return Some(pid);
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn windows_process_executable_path(pid: u32) -> Option<PathBuf> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }
    let mut buffer = vec![0u16; 32768];
    let mut size = buffer.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size) };
    unsafe {
        let _ = CloseHandle(handle);
    }
    if ok == 0 || size == 0 {
        None
    } else {
        Some(PathBuf::from(String::from_utf16_lossy(
            &buffer[..size as usize],
        )))
    }
}

#[cfg(not(target_os = "windows"))]
fn windows_process_executable_path(_pid: u32) -> Option<PathBuf> {
    None
}

fn is_froozerp_backend_process_path(path: &Path) -> bool {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    file_name.eq_ignore_ascii_case("froozerp-backend-node.exe")
        && is_under(path, &current_install_dir())
}

#[cfg(desktop)]
fn stop_verified_backend_pid(pid: u32, reason: &str) -> bool {
    let Some(path) = windows_process_executable_path(pid) else {
        write_app_log(
            "ERROR",
            &format!("Refusing to stop backend PID {} ({}): executable path unavailable", pid, reason),
        );
        return false;
    };
    if !is_froozerp_backend_process_path(&path) {
        write_app_log(
            "ERROR",
            &format!(
                "Refusing to stop PID {} ({}): path {} is not the active FroozERP backend",
                pid,
                reason,
                path.to_string_lossy()
            ),
        );
        return false;
    }
    let mut command = Command::new("taskkill.exe");
    hide_child_console(&mut command);
    let status = command
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status();
    match status {
        Ok(status) if status.success() => {
            write_app_log(
                "INFO",
                &format!(
                    "Stopped verified FroozERP backend PID {} at {} ({})",
                    pid,
                    path.to_string_lossy(),
                    reason
                ),
            );
            true
        }
        Ok(status) => {
            write_app_log(
                "ERROR",
                &format!("Unable to stop FroozERP backend PID {}: taskkill exited {}", pid, status),
            );
            false
        }
        Err(error) => {
            write_app_log(
                "ERROR",
                &format!("Unable to stop FroozERP backend PID {}: {}", pid, error),
            );
            false
        }
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

#[derive(Serialize)]
struct StartupTransitionRecord {
    timestamp_ms: u128,
    process_id: u32,
    state: String,
    detail: String,
}

#[tauri::command]
fn record_startup_transition(state: String, detail: Option<String>) -> Result<(), String> {
    let normalized_state = state.trim().chars().take(80).collect::<String>();
    if normalized_state.is_empty() {
        return Err("Startup transition state is required".to_string());
    }
    let normalized_detail = detail
        .unwrap_or_default()
        .replace('\r', " ")
        .replace('\n', " ")
        .chars()
        .take(500)
        .collect::<String>();
    let record = StartupTransitionRecord {
        timestamp_ms: timestamp_ms(),
        process_id: std::process::id(),
        state: normalized_state.clone(),
        detail: normalized_detail,
    };
    let path = startup_transition_log_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let payload = serde_json::to_string(&record).map_err(|error| error.to_string())?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    writeln!(file, "{}", payload).map_err(|error| error.to_string())?;
    write_app_log("INFO", &format!("Startup render state: {}", normalized_state));
    Ok(())
}

#[tauri::command]
fn show_main_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not available".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    write_app_log("INFO", "Main window revealed after neutral shell paint");
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
    #[cfg(mobile)]
    return not_in_phone_app("Opening a PDF in the system viewer");
    #[cfg(desktop)]
    return open_pdf_in_system_viewer_desktop(file_name, bytes);
}

#[cfg(desktop)]
fn open_pdf_in_system_viewer_desktop(file_name: String, bytes: Vec<u8>) -> Result<String, String> {
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
    Command::new(if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    })
    .arg(&path)
    .spawn()
    .map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn open_startup_log() -> Result<String, String> {
    #[cfg(mobile)]
    return not_in_phone_app("Opening the startup log");
    #[cfg(desktop)]
    return open_startup_log_desktop();
}

#[cfg(desktop)]
fn open_startup_log_desktop() -> Result<String, String> {
    let path = diagnostic_log_path();
    if !path.exists() {
        return Err(format!("Startup log does not exist yet: {}", path.to_string_lossy()));
    }
    #[cfg(target_os = "windows")]
    open_path_with_windows_shell(&path)?;
    #[cfg(not(target_os = "windows"))]
    Command::new(if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    })
    .arg(&path)
    .spawn()
    .map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn backend_startup_diagnostics() -> Result<BackendServiceStatus, String> {
    local_backend_service_status()
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
        return Err(format!(
            "Windows shell open failed with code {}",
            result as isize
        ));
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
        return Err(format!(
            "Windows save dialog failed with code {}",
            error_code
        ));
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

/// Kiosk lock. On a phone this returns Ok and does nothing: there is no window chrome to remove
/// (`set_fullscreen`/`set_decorations` do not exist there) and no way to close the app from it.
#[tauri::command]
fn set_kiosk_mode(app: AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(mobile)]
    return Ok(());
    #[cfg(desktop)]
    return set_kiosk_mode_desktop(app, enabled);
}

#[cfg(desktop)]
fn set_kiosk_mode_desktop(app: AppHandle, enabled: bool) -> Result<(), String> {
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

/// On a phone this returns Ok and does nothing: the OS owns the app's lifecycle.
#[tauri::command]
fn close_froozerp_window(app: AppHandle, allow_exit: Option<bool>) -> Result<(), String> {
    #[cfg(mobile)]
    return Ok(());
    #[cfg(desktop)]
    return close_froozerp_window_desktop(app, allow_exit);
}

#[cfg(desktop)]
fn close_froozerp_window_desktop(app: AppHandle, allow_exit: Option<bool>) -> Result<(), String> {
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
fn ensure_local_backend_service() -> Result<BackendServiceStatus, String> {
    #[cfg(mobile)]
    return not_in_phone_app("The local FroozERP service");
    #[cfg(desktop)]
    return Ok(ensure_local_backend_service_internal(false));
}

#[tauri::command]
fn restart_local_backend_service() -> Result<BackendServiceStatus, String> {
    #[cfg(mobile)]
    return not_in_phone_app("The local FroozERP service");
    #[cfg(desktop)]
    return Ok(ensure_local_backend_service_internal(true));
}

#[tauri::command]
fn prepare_update_installation(target_version: Option<String>) -> Result<UpdateInstallPreparation, String> {
    #[cfg(mobile)]
    return not_in_phone_app("Installing an update from inside the app");
    #[cfg(desktop)]
    return prepare_update_installation_desktop(target_version);
}

#[cfg(desktop)]
fn prepare_update_installation_desktop(
    target_version: Option<String>,
) -> Result<UpdateInstallPreparation, String> {
    let backend_executable = resolve_node_path();
    let backend_pid_before = backend_port_owner_pid();
    let previous_backend_version = local_backend_version(900).unwrap_or_default();
    let stopped_owned_backend = stop_owned_backend("update installation requested");
    thread::sleep(Duration::from_millis(500));
    let mut stopped_port_backend = false;
    if probe_local_backend_health(900).is_ok() {
        if let Some(pid) = backend_port_owner_pid() {
            stopped_port_backend = stop_verified_backend_pid(pid, "update installation requested");
        }
    }
    for _ in 0..30 {
        if probe_local_backend_health(500).is_err() {
            break;
        }
        thread::sleep(Duration::from_millis(500));
    }
    let backend_still_reachable = probe_local_backend_health(500).is_ok();
    let unlocked = !backend_still_reachable
        && wait_for_file_unlock(&backend_executable, 60, Duration::from_millis(500));
    let target_version = target_version.unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
    let transaction_path = update_transaction_path();
    let message = if unlocked {
        let record = UpdateTransactionRecord {
            state: "installing".to_string(),
            target_version: target_version.clone(),
            previous_desktop_version: env!("CARGO_PKG_VERSION").to_string(),
            previous_backend_version,
            started_at: now_unix_seconds(),
            updated_at: now_unix_seconds(),
            install_dir: current_install_dir().to_string_lossy().to_string(),
            executable_path: env::current_exe()
                .map(|path| path.to_string_lossy().to_string())
                .unwrap_or_default(),
            backend_executable: backend_executable.to_string_lossy().to_string(),
            backend_pid_before,
            message: "Installer launch approved after backend shutdown and file unlock.".to_string(),
        };
        write_update_transaction(&record)?;
        "Backend service stopped and sidecar executable is unlocked for update installation."
            .to_string()
    } else {
        format!(
            "Backend sidecar executable is still locked or reachable. reachable={}, file={}",
            backend_still_reachable,
            backend_executable.to_string_lossy()
        )
    };
    Ok(UpdateInstallPreparation {
        stopped_owned_backend,
        stopped_port_backend,
        backend_pid_before,
        backend_executable: backend_executable.to_string_lossy().to_string(),
        unlocked,
        transaction_path: transaction_path.to_string_lossy().to_string(),
        message,
    })
}

#[tauri::command]
fn local_backend_service_status() -> Result<BackendServiceStatus, String> {
    #[cfg(mobile)]
    return not_in_phone_app("The local FroozERP service");
    #[cfg(desktop)]
    return local_backend_service_status_desktop();
}

#[cfg(desktop)]
fn local_backend_service_status_desktop() -> Result<BackendServiceStatus, String> {
    let reachable = probe_local_backend_health(900).is_ok();
    let version_matches = local_backend_version_matches(900).unwrap_or(false);
    let healthy = reachable && version_matches;
    let mut pid = None;
    if let Ok(mut guard) = LOCAL_BACKEND_PROCESS.lock() {
        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    write_app_log(
                        "ERROR",
                        &format!("Managed local backend exited with status {}", status),
                    );
                    *guard = None;
                }
                Ok(None) => pid = Some(child.id()),
                Err(error) => write_app_log(
                    "ERROR",
                    &format!("Unable to inspect local backend process: {}", error),
                ),
            }
        }
    }
    let owned_pid = pid.is_some();
    let port_pid = if healthy {
        backend_port_owner_pid()
    } else {
        None
    };
    if pid.is_none() {
        pid = port_pid;
    }
    let node_path = if healthy {
        Some(resolve_node_path())
    } else {
        None
    };
    Ok(backend_status(
        if healthy {
            "Local FroozERP service is healthy.".to_string()
        } else if reachable {
            format!(
                "Local FroozERP service version mismatch. Desktop {}, backend {}.",
                env!("CARGO_PKG_VERSION"),
                local_backend_version(900).unwrap_or_else(|_| "unknown".to_string())
            )
        } else {
            "Local FroozERP service stopped. Restart service.".to_string()
        },
        healthy,
        false,
        !owned_pid && port_pid.is_some() && healthy,
        pid,
        None,
        node_path,
        if owned_pid {
            "owned"
        } else if healthy {
            "reused"
        } else {
            "unknown"
        },
    ))
}

#[tauri::command]
fn detect_old_froozerp_versions() -> Result<CleanupResult, String> {
    #[cfg(mobile)]
    return not_in_phone_app("Old-version detection");
    #[cfg(desktop)]
    return Ok(froozerp_cleanup_candidates());
}

#[tauri::command]
fn install_diagnostics(app: AppHandle) -> Result<InstallDiagnostics, String> {
    #[cfg(mobile)]
    return Ok(phone_install_diagnostics(app.package_info().version.to_string()));
    #[cfg(desktop)]
    return Ok(froozerp_install_diagnostics(
        app.package_info().version.to_string(),
    ));
}

/// What `install_diagnostics` can honestly say about a phone install: versions and the data path.
/// There are no Program Files folders, shortcuts or registry entries to report.
#[cfg_attr(desktop, allow(dead_code))]
fn phone_install_diagnostics(package_version: String) -> InstallDiagnostics {
    let (update_transaction_status, update_transaction_message, update_transaction_target_version) =
        update_transaction_status();
    InstallDiagnostics {
        current_executable: env::current_exe()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
        current_install_dir: String::new(),
        desktop_app_version: package_version.clone(),
        package_version,
        data_path: app_data_dir().to_string_lossy().to_string(),
        stale_installations: Vec::new(),
        cleanup_message: "Old-version cleanup does not apply to the phone app.".to_string(),
        update_transaction_status,
        update_transaction_message,
        update_transaction_target_version,
    }
}

#[tauri::command]
fn clean_old_froozerp_versions() -> Result<CleanupResult, String> {
    #[cfg(mobile)]
    return not_in_phone_app("Old-version cleanup");
    #[cfg(desktop)]
    return clean_old_froozerp_versions_desktop();
}

#[cfg(desktop)]
fn clean_old_froozerp_versions_desktop() -> Result<CleanupResult, String> {
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
            let mut reg_delete = Command::new("reg");
            hide_child_console(&mut reg_delete);
            match reg_delete.args(["delete", &candidate.path, "/f"]).status() {
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
fn local_get_or_create_device_identity(
    app: AppHandle,
    preferred_device_id: Option<String>,
) -> Result<serde_json::Value, String> {
    local_db::ensure_device_identity(&app, preferred_device_id.as_deref())
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
fn local_db_audit(app: AppHandle) -> Result<serde_json::Value, String> {
    local_db::database_audit(&app)
}

#[tauri::command]
fn entitlement_status(app: AppHandle, device_id: String) -> Result<serde_json::Value, String> {
    local_db::entitlement_state(&app, &device_id)
}

#[tauri::command]
fn entitlement_redeem(
    app: AppHandle,
    device_id: String,
    payload_base64: String,
    signature_base64: String,
    source: Option<String>,
) -> Result<serde_json::Value, String> {
    let payload = activation::base64_decode(&payload_base64)
        .map_err(|error| format!("invalid payload base64: {error}"))?;
    let signature = activation::base64_decode(&signature_base64)
        .map_err(|error| format!("invalid signature base64: {error}"))?;
    let source = source.unwrap_or_else(|| "OFFLINE_FILE".to_string());
    local_db::accept_entitlement(&app, &device_id, &payload, &signature, &source)?;
    local_db::entitlement_state(&app, &device_id)
}

#[tauri::command]
fn entitlement_import_file(
    app: AppHandle,
    device_id: String,
    contents: String,
    source: Option<String>,
) -> Result<serde_json::Value, String> {
    let (payload, signature) = activation::parse_lic(&contents)?;
    let source = source.unwrap_or_else(|| "OFFLINE_FILE".to_string());
    local_db::accept_entitlement(&app, &device_id, &payload, &signature, &source)?;
    local_db::entitlement_state(&app, &device_id)
}

#[tauri::command]
fn entitlement_consume_bootstrap(
    app: AppHandle,
    device_id: String,
    entitlement_serial: String,
) -> Result<(), String> {
    local_db::consume_bootstrap(&app, &device_id, &entitlement_serial)
}
#[tauri::command]
fn local_record_connectivity_mode_change(
    app: AppHandle,
    user_id: String,
    username: Option<String>,
    role: String,
    device_id: String,
    previous_mode: String,
    next_mode: String,
    server_confirmed_at: String,
    time_source: String,
) -> Result<(), String> {
    local_db::record_connectivity_mode_change(
        &app,
        &user_id,
        username.as_deref(),
        &role,
        &device_id,
        &previous_mode,
        &next_mode,
        &server_confirmed_at,
        &time_source,
    )
}
#[tauri::command]
fn local_save_customer_order(app: AppHandle, order: serde_json::Value) -> Result<serde_json::Value, String> {
    local_db::save_customer_order(&app, &order)
}

#[tauri::command]
fn local_list_customer_orders(app: AppHandle) -> Result<serde_json::Value, String> {
    local_db::list_customer_orders(&app)
}

#[tauri::command]
fn local_set_customer_order_status(
    app: AppHandle,
    order_id: String,
    next_status: String,
    patch: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    local_db::set_customer_order_status(
        &app,
        &order_id,
        &next_status,
        &patch.unwrap_or_else(|| serde_json::json!({})),
    )
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
fn sync_outbox_mark_syncing(app: AppHandle, operation_ids: Vec<String>) -> Result<LocalDbStatus, String> {
    local_db::mark_outbox_syncing(&app, &operation_ids)
}
#[tauri::command]
fn sync_outbox_release_syncing(
    app: AppHandle,
    operation_ids: Vec<String>,
    message: Option<String>,
) -> Result<LocalDbStatus, String> {
    local_db::release_syncing_operations(&app, &operation_ids, message)
}
#[tauri::command]
fn sync_apply_push_acks(app: AppHandle, acks: Vec<SyncAck>, device_id: Option<String>, server_time: Option<String>) -> Result<LocalDbStatus, String> {
    local_db::apply_push_acks(&app, &acks, device_id, server_time)
}
#[tauri::command]
fn sync_apply_pull_changes(
    app: AppHandle,
    changes: Vec<PulledChange>,
    next_cursor: String,
    device_id: Option<String>,
    server_time: Option<String>,
) -> Result<LocalDbStatus, String> {
    local_db::apply_pull_changes(&app, &changes, &next_cursor, device_id, server_time)
}
#[tauri::command]
fn sync_apply_reference_bootstrap(
    app: AppHandle,
    bootstrap: local_db::ReferenceBootstrap,
    device_id: String,
    server_time: Option<String>,
) -> Result<LocalDbStatus, String> {
    local_db::apply_reference_bootstrap(&app, &bootstrap, &device_id, server_time)
}
#[tauri::command]
fn sync_record_cycle_completed(app: AppHandle, device_id: String, server_time: Option<String>, push_result: String) -> Result<LocalDbStatus, String> {
    local_db::record_sync_cycle_completed(&app, &device_id, server_time, &push_result)
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

#[tauri::command]
fn purchase_queue_local(
    app: AppHandle,
    purchase: serde_json::Value,
) -> Result<LocalPurchaseIntentResult, String> {
    local_db::queue_local_purchase(&app, purchase)
}

#[tauri::command]
fn purchase_list_local(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    local_db::list_local_purchase_intents(&app)
}

#[cfg(test)]
mod local_backend_lifecycle_tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    // These tests mutate process-wide environment variables, so they have to run one at a time.
    // A panic while the lock is held poisons it, and every later test then fails with
    // `PoisonError` instead of its own result — one real failure becomes several fake ones and
    // the suite stops being readable. The lock guards no data, only exclusion, so a poisoned
    // lock is still a valid lock.
    fn lock_environment() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn spawned_backend_must_own_the_port_before_it_is_accepted() {
        assert!(spawned_backend_owns_port(42, Some(42)));
        assert!(!spawned_backend_owns_port(42, Some(84)));
        assert!(!spawned_backend_owns_port(42, None));
    }

    #[test]
    fn test_runtime_uses_the_isolated_sqlite_directory_for_backend_and_logs() {
        let _guard = lock_environment();
        let original_node_env = env::var_os("NODE_ENV");
        let original_isolated_dir = env::var_os("FROOZERP_ISOLATED_SQLITE_DIR");
        let isolated_dir = env::temp_dir().join(format!(
            "froozerp-isolated-app-data-{}-{}",
            std::process::id(),
            timestamp_ms()
        ));
        env::set_var("NODE_ENV", "test");
        env::set_var("FROOZERP_ISOLATED_SQLITE_DIR", &isolated_dir);

        assert_eq!(app_data_dir(), isolated_dir);
        assert_eq!(local_sqlite_database_path(), isolated_dir.join("froozerp-local.sqlite3"));
        assert_eq!(
            diagnostic_log_path(),
            isolated_dir.join("logs").join("froozerp-startup.log")
        );

        match original_node_env {
            Some(value) => env::set_var("NODE_ENV", value),
            None => env::remove_var("NODE_ENV"),
        }
        match original_isolated_dir {
            Some(value) => env::set_var("FROOZERP_ISOLATED_SQLITE_DIR", value),
            None => env::remove_var("FROOZERP_ISOLATED_SQLITE_DIR"),
        }
    }

    // Windows-only, and not for want of a desktop: this test asserts that concurrent startups
    // arbitrate to a single port owner, and `backend_port_owner_pid` decides that by parsing
    // `netstat -ano -p tcp` — Windows syntax. Anywhere else it returns `None`,
    // `spawned_backend_owns_port` reads that as "a competitor holds the port", and the launch
    // kills its own healthy child and reports unhealthy. There is no other-platform answer to
    // assert here, so the test is pinned to the platform whose behaviour it describes rather
    // than left to fail everywhere else. Windows is the only shipped target.
    #[cfg(windows)]
    #[test]
    fn forced_restart_replaces_only_the_owned_desktop_sqlite_service() {
        let _guard = lock_environment();
        let profile_root = env::temp_dir().join(format!(
            "froozerp-backend-restart-{}-{}",
            std::process::id(),
            timestamp_ms()
        ));
        let roaming = profile_root.join("AppData").join("Roaming");
        let local = profile_root.join("AppData").join("Local");
        fs::create_dir_all(&roaming).expect("create temporary roaming profile");
        fs::create_dir_all(&local).expect("create temporary local profile");

        let original_appdata = env::var_os("APPDATA");
        let original_localappdata = env::var_os("LOCALAPPDATA");
        let original_database_url = env::var_os("DATABASE_URL");
        let original_test_port = env::var_os("FROOZERP_TEST_BACKEND_PORT");
        let listener = std::net::TcpListener::bind("127.0.0.1:0")
            .expect("reserve isolated backend test port");
        let test_port = listener
            .local_addr()
            .expect("read isolated backend test port")
            .port();
        drop(listener);
        env::set_var("APPDATA", &roaming);
        env::set_var("LOCALAPPDATA", &local);
        env::set_var("FROOZERP_TEST_BACKEND_PORT", test_port.to_string());
        env::set_var(
            "DATABASE_URL",
            "postgresql://poison:poison@127.0.0.1:5432/poison",
        );

        let database_path = local_sqlite_database_path();
        local_db::initialize_path(&database_path).expect("initialize desktop SQLite database");
        let first_thread = thread::spawn(|| ensure_local_backend_service_internal(false));
        let second_thread = thread::spawn(|| ensure_local_backend_service_internal(false));
        let first = first_thread.join().expect("first startup thread");
        let second = second_thread.join().expect("second startup thread");
        assert!(first.healthy, "first start failed: {}", first.message);
        assert!(second.healthy, "second start failed: {}", second.message);
        assert_eq!(
            [first.started, second.started]
                .into_iter()
                .filter(|started| *started)
                .count(),
            1,
            "concurrent startup checks must launch exactly one backend"
        );
        let first_pid = first.pid.or(second.pid).expect("first owned backend PID");

        let restarted = ensure_local_backend_service_internal(true);
        assert!(restarted.healthy, "forced restart failed: {}", restarted.message);
        let restarted_pid = restarted.pid.expect("restarted owned backend PID");
        assert_ne!(first_pid, restarted_pid, "restart must replace the owned process");

        let health = local_backend_health_json(2_000).expect("health after forced restart");
        assert_eq!(health.get("status").and_then(|value| value.as_str()), Some("ok"));
        assert_eq!(
            health.get("database_type").and_then(|value| value.as_str()),
            Some("sqlite")
        );
        assert_eq!(
            health
                .get("client_postgres_access")
                .and_then(|value| value.as_bool()),
            Some(false)
        );

        assert!(stop_owned_backend("lifecycle test cleanup"));
        match original_appdata {
            Some(value) => env::set_var("APPDATA", value),
            None => env::remove_var("APPDATA"),
        }
        match original_localappdata {
            Some(value) => env::set_var("LOCALAPPDATA", value),
            None => env::remove_var("LOCALAPPDATA"),
        }
        match original_database_url {
            Some(value) => env::set_var("DATABASE_URL", value),
            None => env::remove_var("DATABASE_URL"),
        }
        match original_test_port {
            Some(value) => env::set_var("FROOZERP_TEST_BACKEND_PORT", value),
            None => env::remove_var("FROOZERP_TEST_BACKEND_PORT"),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // On desktop the path is fixed before anything else runs. On a phone it is not known until
    // `setup` has asked Tauri, so the hook looks it up when (if) a panic happens.
    #[cfg(desktop)]
    let panic_path = diagnostic_log_path();
    panic::set_hook(Box::new(move |info| {
        #[cfg(mobile)]
        let panic_path = diagnostic_log_path();
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

    let builder = tauri::Builder::default();
    // Desktop only. A phone is updated through its store, and these crates are not even dependencies
    // of a mobile build (Cargo.toml); their permissions are desktop-only in capabilities/default.json.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());
    let result = builder
        .setup(|app| {
            remember_resolved_app_data_dir(app.handle());
            if !acquire_desktop_instance_mutex() {
                app.handle().exit(0);
                return Ok(());
            }
            let path = diagnostic_log_path();
            write_app_log(
                "INFO",
                &format!("Application log file: {}", path.to_string_lossy()),
            );
            write_app_log("INFO", "Tauri setup started");
            #[cfg(desktop)]
            cleanup_updater_temp_artifacts();
            #[cfg(desktop)]
            match detect_old_froozerp_versions() {
                Ok(cleanup) => write_app_log(
                    "INFO",
                    &format!(
                        "Old version detection completed: candidates={}, blocked={}, data_path={}",
                        cleanup.candidates.len(),
                        cleanup.blocked.len(),
                        cleanup.data_path
                    ),
                ),
                Err(error) => {
                    write_app_log("ERROR", &format!("Old version detection failed: {}", error))
                }
            }
            // Desktop only. This recovers WebView2 profiles that cached the 1.0.0 service worker; a phone
            // never ran that build. Gated rather than left to the marker file, because a marker that
            // cannot be written (the app-data directory used to be unwritable on Android) would clear
            // all browsing data -- including the web storage the app keeps -- on every launch.
            #[cfg(desktop)]
            let marker = webview_recovery_marker_path();
            #[cfg(desktop)]
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
            #[cfg(desktop)]
            let backend_app = app.handle().clone();
            #[cfg(desktop)]
            thread::spawn(move || {
                write_app_log("INFO", "Starting local backend worker after WebView setup");
                let backend_status = ensure_local_backend_service_internal(false);
                write_app_log(
                    if backend_status.healthy { "INFO" } else { "ERROR" },
                    &format!(
                        "Local backend setup result: healthy={}, started={}, reused={}, pid={:?}, message={}",
                        backend_status.healthy,
                        backend_status.started,
                        backend_status.reused_existing,
                        backend_status.pid,
                        backend_status.message
                    ),
                );
                reconcile_update_transaction(&backend_status);
                if let Err(error) = backend_app.emit("local-backend-service-status", backend_status) {
                    write_app_log(
                        "ERROR",
                        &format!("Unable to publish local backend service status: {}", error),
                    );
                }
            });
            // A phone has no sidecar to launch. Its SQLite file is prepared here instead, off the
            // main thread, so the first local route the frontend calls finds it ready.
            #[cfg(mobile)]
            thread::spawn(ensure_mobile_sqlite_ready);
            write_app_log("INFO", "Tauri setup completed");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_log_path,
            app_log,
            record_startup_transition,
            show_main_window,
            open_startup_log,
            backend_startup_diagnostics,
            open_pdf_in_system_viewer,
            save_pdf_with_dialog,
            set_kiosk_mode,
            close_froozerp_window,
            ensure_local_backend_service,
            restart_local_backend_service,
            prepare_update_installation,
            local_backend_service_status,
            detect_old_froozerp_versions,
            install_diagnostics,
            clean_old_froozerp_versions,
            local_cache_reference_snapshot,
            local_load_reference_snapshot,
            local_get_or_create_device_identity,
            local_db_initialize,
            local_db_status,
            local_db_audit,
            entitlement_status,
            entitlement_redeem,
            entitlement_import_file,
            entitlement_consume_bootstrap,
            local_record_connectivity_mode_change,
            local_save_customer_order,
            local_list_customer_orders,
            local_set_customer_order_status,
            local_db_set_smoke_value,
            local_db_get_smoke_value,
            sync_outbox_enqueue,
            sync_outbox_count,
            sync_outbox_pending,
            sync_outbox_mark_syncing,
            sync_outbox_release_syncing,
            sync_apply_push_acks,
            sync_apply_pull_changes,
            sync_apply_reference_bootstrap,
            sync_record_cycle_completed,
            sync_mark_failed,
            sync_retry_failed_operations,
            sync_queue_test_entity,
            pos_sale_complete_local,
            pos_sale_edit_local,
            pos_sale_cancel_local,
            pos_sale_load_local,
            pos_sale_list_local,
            purchase_queue_local,
            purchase_list_local,
            runtime_profile,
            mobile_gateway_request,
            mobile_gateway_cloud_decision
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if KIOSK_LOCK_ENABLED.load(Ordering::SeqCst)
                    && !KIOSK_CLOSE_ALLOWED.load(Ordering::SeqCst)
                {
                    api.prevent_close();
                    let _ = window.emit("kiosk-exit-required", ());
                    write_app_log("INFO", "Close prevented by kiosk lock");
                } else {
                    #[cfg(desktop)]
                    stop_owned_backend("window close");
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
        release_desktop_instance_mutex();
        panic!("error while running FroozERP desktop app: {}", error);
    }
    release_desktop_instance_mutex();
}
