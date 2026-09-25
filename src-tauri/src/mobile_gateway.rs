//! The desktop gateway's local routes, connectivity policy and cloud-request audit, for the phone.
//!
//! On Windows the shell starts `backend/desktopGateway.js` as a Node sidecar, and every request the
//! frontend makes to its "local API" goes through that process: it answers a handful of routes
//! itself, holds the LOCAL_ONLY kill switch, and decides -- and audits -- whether anything else may
//! be proxied to the cloud. A phone has no Node to run it on. This module is that gateway's local
//! half, ported so the phone app keeps the same guarantees:
//!
//! - [`handle_request`] serves the routes `localRoute` answers, with the same status codes and JSON
//!   bodies, plus the speech refusal and a `NOT_A_LOCAL_ROUTE` 404 for everything else.
//! - [`cloud_decision`] is `cloudRequest`'s policy check: in LOCAL_ONLY it refuses with the same
//!   status and body the gateway sends for a refused proxy request and appends the same audit line
//!   (`blocked: true`, `reachedCloud: false`); when cloud access is allowed it audits the request
//!   exactly as the gateway does just before it calls `fetch`.
//!
//! The frontend's axios adapter (`frontend/src/local/mobileGateway.js`) is the single choke point
//! that calls these two, so on the phone the LOCAL_ONLY invariant is enforced here plus that adapter,
//! instead of at a process boundary.
//!
//! ## Fidelity
//!
//! File names, file formats (policy file pretty-printed with two spaces, keys in the gateway's
//! order; audit file one JSON object per line, `at` first) and the Owner-authority rules are the
//! gateway's, line for line. Where JavaScript semantics matter (`||` truthiness, `!== false`,
//! `String(x)`), they are reproduced with the helpers at the bottom rather than approximated.
//! Known, deliberate differences are listed on the functions they affect:
//! [`classify_control_origin`] parses origins with a small parser instead of WHATWG `URL` (every
//! difference refuses rather than admits), and [`select_canonical_device`] breaks exact
//! `last_seen_at` ties by byte order where the gateway uses `localeCompare` (identical for
//! `FZDEV-` ids, which are upper-case hex and hyphens).
//!
//! ## Network
//!
//! Exactly two places here may open an outbound connection, both through [`CloudProbe`] and both
//! only after the policy has been read as allowing internet access -- the same two places the
//! gateway calls `fetch` from inside `localRoute`: the `/api/cloud/health` probe and the
//! authoritative-time probe when the Owner switches cloud access *on*. The tests below count probe
//! invocations to prove that LOCAL_ONLY makes none.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const POLICY_FILE_NAME: &str = "cloud-network-policy.json";
pub const AUDIT_FILE_NAME: &str = "cloud-request-audit.jsonl";

const SPEECH_ROUTE_PREFIX: &str = "/api/local/speech/";
const LEGACY_CLOUD_API_URLS: [&str; 1] = ["https://froozerp-production.up.railway.app"];

/// desktopGateway.js `CLOUD_NOT_CONFIGURED_MESSAGE` (the gateway's own, used by /api/cloud/health).
const GATEWAY_CLOUD_NOT_CONFIGURED_MESSAGE: &str = "No cloud backend is configured for this installation. The request was refused instead of being sent to a default target.";
/// cloudProxyError.js `CLOUD_NOT_CONFIGURED_MESSAGE` (the refused-proxy body). Not the same text.
const PROXY_CLOUD_NOT_CONFIGURED_MESSAGE: &str =
    "No cloud backend is configured for this installation. Local modules remain available.";
/// cloudProxyError.js `CLOUD_UNAVAILABLE_MESSAGE`.
const CLOUD_UNAVAILABLE_MESSAGE: &str =
    "FroozERP cloud is temporarily unavailable. Local modules remain available.";
const LOCAL_ONLY_PROXY_MESSAGE: &str =
    "Local Only mode selected - cloud sync paused. Local modules remain available.";
const LOCAL_ONLY_HEALTH_MESSAGE: &str = "Local Only mode selected - cloud sync paused.";

const CLOUD_HEALTH_TIMEOUT: Duration = Duration::from_millis(8000);
const AUTHORITATIVE_TIME_TIMEOUT: Duration = Duration::from_millis(5000);

// ---------------------------------------------------------------------------------------------
// Command payloads (see the shared mobile contract)
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct GatewayRequest {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub query: Option<String>,
    /// Values are taken as JSON so a number or boolean header from axios does not fail the whole
    /// invoke; they are converted with `String(value)` semantics and `null` is dropped.
    #[serde(default)]
    pub headers: Option<HashMap<String, Value>>,
    #[serde(default)]
    pub body: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GatewayResponse {
    pub status: u16,
    pub body: Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CloudDecisionRequest {
    pub method: String,
    pub path: String,
    /// Part of the contract, and unused on purpose: the gateway's proxy decision depends only on the
    /// policy and on whether a cloud is configured, never on what the caller claims about itself.
    #[serde(default)]
    #[allow(dead_code)]
    pub headers: Option<HashMap<String, Value>>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CloudDecision {
    pub allowed: bool,
    pub status: u16,
    pub body: Value,
    /// Where an allowed request must go: the cloud this decision was audited against. The adapter
    /// sends to this address rather than to its own idea of the cloud, so the audit line and the
    /// request can never name two different hosts. Absent on a refusal.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cloud_base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RuntimeProfile {
    pub platform: &'static str,
    pub mobile: bool,
    pub gateway: bool,
}

pub fn runtime_profile() -> RuntimeProfile {
    let platform = if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    let mobile = cfg!(mobile);
    RuntimeProfile {
        platform,
        mobile,
        // A sidecar gateway is started on desktop only.
        gateway: !mobile,
    }
}

// ---------------------------------------------------------------------------------------------
// Context and the network seam
// ---------------------------------------------------------------------------------------------

/// The one way this module reaches the network. `get_json` is `fetch(url)` followed by
/// `response.json().catch(() => ({}))`: `Ok((status, body))` whenever an HTTP response arrived
/// (body `{}` when it is not JSON), `Err` for a network failure or timeout.
pub trait CloudProbe: Sync {
    fn get_json(&self, url: &str, timeout: Duration) -> Result<(u16, Value), String>;
}

/// A probe that never connects. Used where the Rust shell must not make a cloud request itself:
/// on desktop the Node gateway owns that job.
pub struct NoNetworkProbe;

impl CloudProbe for NoNetworkProbe {
    fn get_json(&self, _url: &str, _timeout: Duration) -> Result<(u16, Value), String> {
        Err("This build does not make cloud requests from the shell.".to_string())
    }
}

/// The real probe. Compiled wherever `ureq` is a dependency (everything but Windows) so a Linux
/// `cargo check` type-checks the code the phone runs; lib.rs only selects it under `cfg(mobile)`.
#[cfg(not(windows))]
#[cfg_attr(desktop, allow(dead_code))]
pub struct HttpCloudProbe;

#[cfg(not(windows))]
impl CloudProbe for HttpCloudProbe {
    fn get_json(&self, url: &str, timeout: Duration) -> Result<(u16, Value), String> {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            // `fetch` resolves on any HTTP status; the caller reads `response.ok` itself.
            .http_status_as_error(false)
            // Node's `fetch` ignores HTTP(S)_PROXY, so the gateway never used one either.
            .proxy(None)
            .build();
        let agent = ureq::Agent::new_with_config(config);
        let mut response = agent.get(url).call().map_err(|error| error.to_string())?;
        let status = response.status().as_u16();
        let body = response
            .body_mut()
            .read_to_string()
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .unwrap_or_else(|| json!({}));
        Ok((status, body))
    }
}

pub struct GatewayContext<'a> {
    /// The gateway's `APP_DATA`. `None` means it could not be resolved, and then the policy reads
    /// as UNREADABLE -- cloud access denied -- rather than as "never set", which would allow it.
    pub app_data_dir: Option<PathBuf>,
    /// The gateway's `SQLITE_PATH`.
    pub sqlite_path: Option<PathBuf>,
    /// Already normalised with [`normalize_cloud_api_url`]; empty means "no cloud configured".
    pub cloud_api_url: String,
    pub app_version: String,
    pub probe: &'a dyn CloudProbe,
}

impl GatewayContext<'_> {
    fn policy_path(&self) -> Option<PathBuf> {
        self.app_data_dir.as_ref().map(|dir| dir.join(POLICY_FILE_NAME))
    }

    fn audit_path(&self) -> Option<PathBuf> {
        self.app_data_dir
            .as_ref()
            .map(|dir| dir.join("logs").join(AUDIT_FILE_NAME))
    }

    fn cloud_configured(&self) -> bool {
        !self.cloud_api_url.is_empty()
    }
}

/// desktopGateway.js `normalizeCloudApiUrl`: trim, drop one trailing slash, and map the retired
/// production host onto the current one.
pub fn normalize_cloud_api_url(value: &str) -> String {
    let trimmed = value.trim();
    let normalized = trimmed.strip_suffix('/').unwrap_or(trimmed);
    if LEGACY_CLOUD_API_URLS.contains(&normalized) {
        return crate::PRODUCTION_CLOUD_API_URL.to_string();
    }
    normalized.to_string()
}

// ---------------------------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicySource {
    Stored,
    NeverSet,
    Unreadable,
}

impl PolicySource {
    fn as_str(self) -> &'static str {
        match self {
            PolicySource::Stored => "STORED",
            PolicySource::NeverSet => "NEVER_SET",
            PolicySource::Unreadable => "UNREADABLE",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Policy {
    pub allow_internet_access: bool,
    pub updated_at: Value,
    pub confirmed_at: Value,
    pub time_source: Value,
    pub changed_by: Value,
    pub device_id: Value,
    pub source: PolicySource,
}

impl Policy {
    fn fail_closed(source: PolicySource) -> Self {
        Policy {
            allow_internet_access: false,
            updated_at: Value::Null,
            confirmed_at: Value::Null,
            time_source: json!("device"),
            changed_by: Value::Null,
            device_id: Value::Null,
            source,
        }
    }

    fn to_json(&self) -> Map<String, Value> {
        let mut map = Map::new();
        map.insert("allowInternetAccess".into(), json!(self.allow_internet_access));
        map.insert("updatedAt".into(), self.updated_at.clone());
        map.insert("confirmedAt".into(), self.confirmed_at.clone());
        map.insert("timeSource".into(), self.time_source.clone());
        map.insert("changedBy".into(), self.changed_by.clone());
        map.insert("deviceId".into(), self.device_id.clone());
        map.insert("source".into(), json!(self.source.as_str()));
        map
    }
}

/// How reading the policy file went, in the gateway's terms.
pub enum PolicyRead<'a> {
    Contents(&'a str),
    NotFound,
    Failed,
}

/// desktopGateway.js `resolvePolicyFromRead`: absent allows (NEVER_SET), unreadable or
/// unanswerable denies (UNREADABLE), a stored boolean stands.
pub fn resolve_policy_from_read(read: PolicyRead<'_>) -> Policy {
    let contents = match read {
        PolicyRead::NotFound => {
            let mut policy = Policy::fail_closed(PolicySource::NeverSet);
            policy.allow_internet_access = true;
            return policy;
        }
        PolicyRead::Failed => return Policy::fail_closed(PolicySource::Unreadable),
        PolicyRead::Contents(contents) => contents,
    };
    let Ok(value) = serde_json::from_str::<Value>(contents) else {
        return Policy::fail_closed(PolicySource::Unreadable);
    };
    let Some(allow) = value.get("allowInternetAccess").and_then(Value::as_bool) else {
        return Policy::fail_closed(PolicySource::Unreadable);
    };
    let updated_at = js_or(&[value.get("updatedAt")]).unwrap_or(Value::Null);
    Policy {
        allow_internet_access: allow,
        confirmed_at: js_or(&[value.get("confirmedAt"), value.get("updatedAt")]).unwrap_or(Value::Null),
        updated_at,
        time_source: js_or(&[value.get("timeSource")]).unwrap_or_else(|| json!("device")),
        changed_by: js_or(&[value.get("changedBy")]).unwrap_or(Value::Null),
        device_id: js_or(&[value.get("deviceId")]).unwrap_or(Value::Null),
        source: PolicySource::Stored,
    }
}

pub fn read_policy(ctx: &GatewayContext<'_>) -> Policy {
    let Some(path) = ctx.policy_path() else {
        // No resolvable app-data directory. Somebody may well have chosen LOCAL_ONLY in a file we
        // cannot find, so this is the unreadable case, not the never-set one.
        return resolve_policy_from_read(PolicyRead::Failed);
    };
    match fs::read(&path) {
        // `readFileSync(path, "utf8")` replaces invalid UTF-8 rather than failing.
        Ok(bytes) => resolve_policy_from_read(PolicyRead::Contents(&String::from_utf8_lossy(&bytes))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            resolve_policy_from_read(PolicyRead::NotFound)
        }
        Err(_) => resolve_policy_from_read(PolicyRead::Failed),
    }
}

/// The policy file exactly as `writePolicy` writes it: these keys, in this order, two-space indent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WrittenPolicy {
    pub allow_internet_access: bool,
    pub updated_at: String,
    pub confirmed_at: String,
    pub time_source: String,
    pub changed_by: Option<String>,
    pub device_id: Option<String>,
}

pub struct AuthoritativeTime {
    pub confirmed_at: String,
    pub time_source: &'static str,
}

fn write_policy(
    ctx: &GatewayContext<'_>,
    allowed: bool,
    time: &AuthoritativeTime,
    changed_by: &str,
    device_id: &str,
) -> Result<WrittenPolicy, GatewayError> {
    let path = ctx
        .policy_path()
        .ok_or_else(|| GatewayError::other("The app data directory is not available."))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| GatewayError::other(error.to_string()))?;
    }
    let value = WrittenPolicy {
        allow_internet_access: allowed,
        updated_at: iso_now(),
        confirmed_at: if time.confirmed_at.is_empty() {
            iso_now()
        } else {
            time.confirmed_at.clone()
        },
        time_source: time.time_source.to_string(),
        changed_by: Some(changed_by.to_string()).filter(|value| !value.is_empty()),
        device_id: Some(device_id.to_string()).filter(|value| !value.is_empty()),
    };
    let payload =
        serde_json::to_string_pretty(&value).map_err(|error| GatewayError::other(error.to_string()))?;
    fs::write(&path, payload).map_err(|error| GatewayError::other(error.to_string()))?;
    Ok(value)
}

// ---------------------------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------------------------

/// One line of `cloud-request-audit.jsonl`: `{ at, ...entry }`, keys in the gateway's order.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub method: String,
    pub route: String,
    pub blocked: bool,
    pub reached_cloud: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<String>,
}

impl AuditEntry {
    fn blocked(method: &str, route: &str, reason: &str) -> Self {
        AuditEntry {
            method: method.to_string(),
            route: route.to_string(),
            blocked: true,
            reached_cloud: false,
            reason: Some(reason.to_string()),
            source: None,
            provenance: None,
        }
    }

    fn with_source(mut self, source: &str) -> Self {
        self.source = Some(source.to_string());
        self
    }
}

#[derive(Serialize)]
struct AuditLine<'a> {
    at: String,
    #[serde(flatten)]
    entry: &'a AuditEntry,
}

pub fn audit_line(at: String, entry: &AuditEntry) -> String {
    serde_json::to_string(&AuditLine { at, entry }).unwrap_or_default()
}

/// desktopGateway.js `auditCloudRequest`: append one line, and never fail the request over it.
fn audit_cloud_request(ctx: &GatewayContext<'_>, entry: AuditEntry) {
    let Some(path) = ctx.audit_path() else { return };
    if let Some(parent) = path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    let line = audit_line(iso_now(), &entry);
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{}", line);
    }
}

// ---------------------------------------------------------------------------------------------
// Kill-switch authority (desktopGateway.js classifyControlOrigin / resolveKillSwitchDecision)
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlOrigin {
    DesktopApp,
    ForeignWebsite,
    NotABrowser,
}

impl ControlOrigin {
    pub fn as_str(self) -> &'static str {
        match self {
            ControlOrigin::DesktopApp => "DESKTOP_APP",
            ControlOrigin::ForeignWebsite => "FOREIGN_WEBSITE",
            ControlOrigin::NotABrowser => "NOT_A_BROWSER",
        }
    }
}

const DESKTOP_SHELL_ORIGINS: [&str; 3] = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];
const LOOPBACK_ORIGIN_HOSTNAMES: [&str; 4] = ["localhost", "127.0.0.1", "::1", "[::1]"];

/// The hostname of an http(s) origin, or `None` when WHATWG `new URL()` would have thrown or the
/// scheme is not http(s) -- both of which the gateway reports as NOT_A_BROWSER.
///
/// Not a full WHATWG parser. The differences all land on the refusing side: a host WHATWG would
/// have rewritten to a loopback address (`http://2130706433`) stays a website here, and a host
/// WHATWG would reject for its characters is classified by its text rather than dropped.
fn origin_hostname(origin: &str) -> Result<String, ()> {
    let (scheme, rest) = origin.split_once(':').ok_or(())?;
    let mut chars = scheme.chars();
    let valid_scheme = chars.next().map(|ch| ch.is_ascii_alphabetic()).unwrap_or(false)
        && chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '-' | '.'));
    if !valid_scheme {
        return Err(());
    }
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(());
    }
    let rest = rest.trim_start_matches(['/', '\\']);
    let authority_end = rest.find(['/', '\\', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let host_port = authority.rsplit_once('@').map(|(_, host)| host).unwrap_or(authority);
    let host = if host_port.starts_with('[') {
        let close = host_port.find(']').ok_or(())?;
        &host_port[..=close]
    } else {
        host_port.split(':').next().unwrap_or_default()
    };
    if host.is_empty() {
        return Err(());
    }
    Ok(host.to_lowercase())
}

pub fn classify_control_origin(value: &str) -> ControlOrigin {
    let origin = value.trim();
    if origin.is_empty() {
        return ControlOrigin::NotABrowser;
    }
    let lowered = origin.to_lowercase();
    if lowered == "null" {
        return ControlOrigin::ForeignWebsite;
    }
    if DESKTOP_SHELL_ORIGINS.contains(&lowered.as_str()) {
        return ControlOrigin::DesktopApp;
    }
    let Ok(hostname) = origin_hostname(origin) else {
        return ControlOrigin::NotABrowser;
    };
    if LOOPBACK_ORIGIN_HOSTNAMES.contains(&hostname.as_str())
        || hostname.ends_with(".localhost")
        || hostname.starts_with("127.")
    {
        return ControlOrigin::DesktopApp;
    }
    ControlOrigin::ForeignWebsite
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KillSwitchDecision {
    pub allowed: bool,
    pub direction: Option<&'static str>,
    pub provenance: ControlOrigin,
    pub code: Option<&'static str>,
    pub message: Option<&'static str>,
}

impl KillSwitchDecision {
    fn refuse(provenance: ControlOrigin, code: &'static str, message: &'static str) -> Self {
        KillSwitchDecision {
            allowed: false,
            direction: None,
            provenance,
            code: Some(code),
            message: Some(message),
        }
    }

    fn allow(provenance: ControlOrigin, direction: &'static str) -> Self {
        KillSwitchDecision {
            allowed: true,
            direction: Some(direction),
            provenance,
            code: None,
            message: None,
        }
    }
}

/// desktopGateway.js `resolveKillSwitchDecision`. Pure. Unlocking gets every check; locking down
/// keeps only the Owner-claim check, because refusing it could leave a device online that its
/// Owner asked to isolate. `local_owner_user_ids` of `None` or empty means "cannot evaluate" and
/// skips the corroboration; ids are compared trimmed and exact, never as numbers.
pub fn resolve_kill_switch_decision(
    requested_internet_access: bool,
    claimed_user_id: &str,
    claimed_role: &str,
    claimed_device_id: &str,
    origin: &str,
    local_owner_user_ids: Option<&[String]>,
) -> KillSwitchDecision {
    let user_id = claimed_user_id.trim();
    let role = claimed_role.trim().to_uppercase();
    let device_id = claimed_device_id.trim();
    let provenance = classify_control_origin(origin);

    if user_id.is_empty() || device_id.is_empty() || role != "OWNER" {
        return KillSwitchDecision::refuse(
            provenance,
            "OWNER_REQUIRED",
            "Authenticated Owner permission is required.",
        );
    }
    if !requested_internet_access {
        return KillSwitchDecision::allow(provenance, "LOCK_DOWN");
    }
    if provenance == ControlOrigin::ForeignWebsite {
        return KillSwitchDecision::refuse(
            provenance,
            "CROSS_ORIGIN_CONTROL_REFUSED",
            "Cloud access can only be re-enabled from FroozERP on this device.",
        );
    }
    let known_owners = local_owner_user_ids
        .unwrap_or_default()
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if !known_owners.is_empty() && !known_owners.contains(&user_id) {
        return KillSwitchDecision::refuse(
            provenance,
            "OWNER_NOT_RECOGNISED",
            "This device does not recognise the requesting user as an Owner.",
        );
    }
    KillSwitchDecision::allow(provenance, "UNLOCK")
}

/// desktopGateway.js `readLocalOwnerUserIds`: Owner ids from the cached offline profiles, or `None`
/// when that cannot be answered. Read-only; every failure is `None`, which never grants anything.
pub fn read_local_owner_user_ids(sqlite_path: Option<&Path>) -> Option<Vec<String>> {
    let path = sqlite_path?;
    let connection =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let mut statement = connection
        .prepare("SELECT value FROM local_kv WHERE key LIKE 'offline_user_profile::%'")
        .ok()?;
    let rows = statement
        .query_map([], |row| row.get::<_, rusqlite::types::Value>(0))
        .ok()?
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    let mut owners = Vec::new();
    for value in rows {
        let rusqlite::types::Value::Text(text) = value else {
            // A non-text value parses to a primitive (or fails to parse) and has no role.
            continue;
        };
        let Ok(profile) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let role = js_or(&[profile.get("role")]).map(|value| js_string(&value)).unwrap_or_default();
        if role.trim().to_uppercase() != "OWNER" {
            continue;
        }
        let id = match profile.get("id") {
            None | Some(Value::Null) => String::new(),
            Some(value) => js_string(value),
        };
        let id = id.trim();
        if !id.is_empty() {
            owners.push(id.to_string());
        }
    }
    Some(owners)
}

// ---------------------------------------------------------------------------------------------
// Local settings (backend/localSettingsStore.js readLocalSettingsBundle)
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct GatewayError {
    pub code: String,
    pub message: String,
}

impl GatewayError {
    fn local(code: &str, message: &str) -> Self {
        GatewayError {
            code: code.to_string(),
            message: message.to_string(),
        }
    }

    /// Anything without a `LOCAL_` code: an fs error, a SQLite error (node:sqlite throws those as
    /// `ERR_SQLITE_ERROR`, which localSettingsStore rethrows unchanged), malformed request JSON.
    fn other(message: impl Into<String>) -> Self {
        GatewayError {
            code: String::new(),
            message: message.into(),
        }
    }

    fn sqlite(error: rusqlite::Error) -> Self {
        GatewayError {
            code: "ERR_SQLITE_ERROR".to_string(),
            message: error.to_string(),
        }
    }
}

struct DeviceRow {
    device_id: String,
    branch_id: rusqlite::types::Value,
    company_id: rusqlite::types::Value,
    registration_status: String,
    last_seen_at: String,
}

/// localSettingsStore.js `selectCanonicalDevice`. Approved rows beat the rest, then most recently
/// seen, then `device_id`. The final tie-break is byte order here and `localeCompare` in Node; they
/// agree for every `FZDEV-` id (upper-case hex and hyphens), and it is also what local_db.rs's
/// `select_identity_under_conflict` does.
fn select_canonical_device(
    connection: &rusqlite::Connection,
) -> Result<(DeviceRow, Option<Value>), GatewayError> {
    let mut statement = connection
        .prepare(
            "SELECT device_id, branch_id, company_id, registration_status, last_seen_at
             FROM local_device_identity
             WHERE LOWER(device_id) <> 'default'
             ORDER BY device_id",
        )
        .map_err(GatewayError::sqlite)?;
    let identities = statement
        .query_map([], |row| {
            Ok(DeviceRow {
                device_id: sql_js_string(&row.get::<_, rusqlite::types::Value>(0)?),
                branch_id: row.get(1)?,
                company_id: row.get(2)?,
                registration_status: sql_js_string(&row.get::<_, rusqlite::types::Value>(3)?),
                last_seen_at: sql_js_string(&row.get::<_, rusqlite::types::Value>(4)?),
            })
        })
        .map_err(GatewayError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(GatewayError::sqlite)?;
    if identities.is_empty() {
        return Err(GatewayError::local(
            "LOCAL_DEVICE_IDENTITY_MISSING",
            "No established local device identity is available for offline settings.",
        ));
    }
    let approved_count = identities
        .iter()
        .filter(|identity| identity.registration_status.to_lowercase() == "approved")
        .count();
    let mut group = identities
        .into_iter()
        .filter(|identity| approved_count == 0 || identity.registration_status.to_lowercase() == "approved")
        .collect::<Vec<_>>();
    if group.len() == 1 {
        return Ok((group.remove(0), None));
    }
    let mut device_ids = group.iter().map(|identity| identity.device_id.clone()).collect::<Vec<_>>();
    device_ids.sort();
    group.sort_by(|a, b| {
        b.last_seen_at
            .cmp(&a.last_seen_at)
            .then_with(|| a.device_id.cmp(&b.device_id))
    });
    let selected = group.remove(0);
    let conflict = json!({
        "kind": if approved_count > 1 { "MULTIPLE_APPROVED" } else { "MULTIPLE_PROVISIONAL" },
        "deviceIds": device_ids,
        "selected": selected.device_id,
    });
    Ok((selected, Some(conflict)))
}

/// The whole of `readLocalSettingsBundle`'s answer. The gateway sends `settings` as the body and the
/// device id as a response header; the invoke contract carries only a body, so the rest is kept for
/// parity and for the tests rather than read by the route.
#[allow(dead_code)]
pub struct LocalSettingsBundle {
    pub settings: Map<String, Value>,
    pub canonical_device_id: String,
    pub company_id: Value,
    pub branch_id: String,
    pub identity_conflict: Option<Value>,
}

pub fn read_local_settings_bundle(database_path: &Path) -> Result<LocalSettingsBundle, GatewayError> {
    let connection = rusqlite::Connection::open_with_flags(
        database_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(GatewayError::sqlite)?;
    connection
        .execute_batch("PRAGMA query_only = ON;")
        .map_err(GatewayError::sqlite)?;
    let integrity: Option<String> = connection
        .query_row("PRAGMA quick_check", [], |row| row.get::<_, rusqlite::types::Value>(0))
        .map(|value| sql_js_string(&value))
        .ok();
    if integrity.map(|value| value.to_lowercase()) != Some("ok".to_string()) {
        return Err(GatewayError::local(
            "LOCAL_SETTINGS_DATABASE_INVALID",
            "The local settings database failed its integrity check. FroozERP did not replace it.",
        ));
    }
    let (identity, conflict) = select_canonical_device(&connection)?;
    let branch_id = sql_js_string_truthy(&identity.branch_id).trim().to_string();
    if branch_id.is_empty() || branch_id.to_lowercase() == "unassigned" {
        return Err(GatewayError::local(
            "LOCAL_DEVICE_SCOPE_MISSING",
            "The established local device has no assigned branch for offline settings.",
        ));
    }
    let mut statement = connection
        .prepare(
            "SELECT setting_key, setting_value, branch_id
             FROM local_settings
             WHERE deleted_at IS NULL
               AND (branch_id IS NULL OR branch_id = ?)
             ORDER BY CASE WHEN branch_id IS NULL THEN 0 ELSE 1 END, setting_key",
        )
        .map_err(GatewayError::sqlite)?;
    let rows = statement
        .query_map([branch_id.as_str()], |row| {
            Ok((
                sql_js_string(&row.get::<_, rusqlite::types::Value>(0)?),
                row.get::<_, rusqlite::types::Value>(1)?,
            ))
        })
        .map_err(GatewayError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(GatewayError::sqlite)?;
    let mut settings = Map::new();
    for (key, raw) in rows {
        let parsed = match &raw {
            rusqlite::types::Value::Text(text) => serde_json::from_str::<Value>(text).ok(),
            rusqlite::types::Value::Integer(value) => Some(json!(value)),
            rusqlite::types::Value::Real(value) => serde_json::Number::from_f64(*value).map(Value::Number),
            // JSON.parse(null) is null; JSON.parse of a byte array is its comma-joined text.
            rusqlite::types::Value::Null => Some(Value::Null),
            rusqlite::types::Value::Blob(_) => None,
        };
        let Some(parsed) = parsed else {
            return Err(GatewayError::local(
                "LOCAL_SETTINGS_MALFORMED",
                &format!(
                    "Saved local setting '{}' is malformed. FroozERP preserved the existing settings and did not replace them.",
                    key
                ),
            ));
        };
        settings.insert(key, parsed);
    }
    Ok(LocalSettingsBundle {
        settings,
        canonical_device_id: identity.device_id,
        company_id: match sql_js_string_truthy(&identity.company_id) {
            value if value.is_empty() => Value::Null,
            _ => sql_value_to_json(&identity.company_id),
        },
        branch_id,
        identity_conflict: conflict,
    })
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

fn header(headers: &HashMap<String, Value>, name: &str) -> Option<String> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .and_then(|(_, value)| match value {
            Value::Null => None,
            other => Some(js_string(other)),
        })
}

fn split_path_and_query(path: &str, query: Option<&str>) -> (String, String) {
    let without_fragment = path.split('#').next().unwrap_or_default();
    let (pathname, inline_query) = match without_fragment.split_once('?') {
        Some((pathname, query)) => (pathname, query),
        None => (without_fragment, ""),
    };
    let pathname = if pathname.starts_with('/') {
        pathname.to_string()
    } else {
        format!("/{}", pathname)
    };
    let extra = query.unwrap_or_default().trim_start_matches('?');
    let query = match (inline_query.is_empty(), extra.is_empty()) {
        (true, _) => extra.to_string(),
        (false, true) => inline_query.to_string(),
        (false, false) => format!("{}&{}", inline_query, extra),
    };
    (pathname, query)
}

/// `URLSearchParams.get(name)`: the first value, `+` as space, percent-decoded.
fn query_param(query: &str, name: &str) -> Option<String> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| match pair.split_once('=') {
            Some((key, value)) => (form_decode(key), form_decode(value)),
            None => (form_decode(pair), String::new()),
        })
        .find(|(key, _)| key == name)
        .map(|(_, value)| value)
}

fn form_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => out.push(b' '),
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
                match hex.and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                    Some(byte) => {
                        out.push(byte);
                        index += 2;
                    }
                    None => out.push(b'%'),
                }
            }
            byte => out.push(byte),
        }
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn health(ctx: &GatewayContext<'_>) -> Result<Value, GatewayError> {
    let path = ctx
        .sqlite_path
        .as_ref()
        .ok_or_else(|| GatewayError::other("FROOZERP_SQLITE_PATH is required."))?;
    validate_sqlite(path)?;
    Ok(json!({
        "status": "ok",
        "app": "FroozERP",
        "api_version": "1",
        "server_time": iso_now(),
        "version": ctx.app_version,
        "database": "reachable",
        "database_type": "sqlite",
        "database_path": path.to_string_lossy(),
        "storage_adapter": "desktop-sqlite",
        "client_postgres_access": false,
        "deployment_type": "local",
        "app_mode": "LOCAL_SINGLE_DEVICE",
        "cloud_api_configured": ctx.cloud_configured(),
    }))
}

/// desktopGateway.js `validateSQLite`: the file opens read-write and starts with the SQLite magic.
fn validate_sqlite(path: &Path) -> Result<(), GatewayError> {
    use std::io::Read;
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| GatewayError::other(error.to_string()))?;
    let mut header = [0u8; 16];
    let mut filled = 0;
    while filled < header.len() {
        match file.read(&mut header[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(error) => return Err(GatewayError::other(error.to_string())),
        }
    }
    if filled != 16 || &header != b"SQLite format 3\0" {
        return Err(GatewayError::other("The local database is not valid SQLite."));
    }
    Ok(())
}

fn respond(status: u16, body: Value) -> GatewayResponse {
    GatewayResponse { status, body }
}

fn policy_body(policy: &Policy) -> Value {
    let mut body = policy.to_json();
    body.insert(
        "status".into(),
        json!(if policy.allow_internet_access { "AUTO" } else { "LOCAL_ONLY" }),
    );
    Value::Object(body)
}

/// desktopGateway.js `readAuthoritativeTime`.
fn read_authoritative_time(ctx: &GatewayContext<'_>) -> AuthoritativeTime {
    if !ctx.cloud_configured() {
        audit_cloud_request(
            ctx,
            AuditEntry::blocked("GET", "/api/health", "CLOUD_NOT_CONFIGURED").with_source("authoritative-time"),
        );
        return AuthoritativeTime { confirmed_at: iso_now(), time_source: "device" };
    }
    let url = format!("{}/api/health", ctx.cloud_api_url);
    if let Ok((status, value)) = ctx.probe.get_json(&url, AUTHORITATIVE_TIME_TIMEOUT) {
        if (200..300).contains(&status) {
            if let Some(server_time) = js_or(&[value.get("server_time")]) {
                // `new Date(x).toISOString()` throws on an unparseable date, which the gateway's
                // catch turns into device time.
                if let Some(confirmed_at) = server_time.as_str().and_then(normalize_iso_timestamp) {
                    return AuthoritativeTime { confirmed_at, time_source: "railway" };
                }
            }
        }
    }
    AuthoritativeTime { confirmed_at: iso_now(), time_source: "device" }
}

fn parse_request_body(body: Option<&Value>) -> Result<Value, GatewayError> {
    match body {
        None | Some(Value::Null) => Ok(json!({})),
        Some(Value::String(text)) if text.is_empty() => Ok(json!({})),
        Some(Value::String(text)) => serde_json::from_str::<Value>(text)
            .map_err(|error| GatewayError::other(format!("Invalid JSON body: {}", error))),
        Some(other) => Ok(other.clone()),
    }
}

fn put_internet_access(
    ctx: &GatewayContext<'_>,
    method: &str,
    pathname: &str,
    headers: &HashMap<String, Value>,
    body: Option<&Value>,
) -> Result<GatewayResponse, GatewayError> {
    let input = parse_request_body(body)?;
    if input.is_null() {
        // `input.user_id` on `null` is a TypeError in the gateway.
        return Err(GatewayError::other("Cannot read properties of null (reading 'user_id')"));
    }
    let claim = |field: &str, header_name: &str| -> String {
        js_or(&[input.get(field)])
            .map(|value| js_string(&value))
            .or_else(|| header(headers, header_name).filter(|value| !value.is_empty()))
            .unwrap_or_default()
    };
    let user_id = claim("user_id", "x-user-id").trim().to_string();
    let role = claim("role", "x-user-role").trim().to_uppercase();
    let device_id = claim("device_id", "x-device-id").trim().to_string();
    let requested_internet_access = input.get("allowInternetAccess") != Some(&Value::Bool(false));
    let origin = header(headers, "origin").unwrap_or_default();
    // Only the unlocking direction is corroborated against local data.
    let owners = if requested_internet_access {
        read_local_owner_user_ids(ctx.sqlite_path.as_deref())
    } else {
        None
    };
    let decision = resolve_kill_switch_decision(
        requested_internet_access,
        &user_id,
        &role,
        &device_id,
        &origin,
        owners.as_deref(),
    );
    if !decision.allowed {
        // Returns before write_policy: a refusal can never be what opens cloud access, and no
        // outbound request has been made.
        let code = decision.code.unwrap_or("OWNER_REQUIRED");
        let mut entry = AuditEntry::blocked(method, pathname, code).with_source("kill-switch-authority");
        entry.provenance = Some(decision.provenance.as_str().to_string());
        audit_cloud_request(ctx, entry);
        return Ok(respond(403, json!({ "code": code, "message": decision.message.unwrap_or_default() })));
    }
    // Gated on the *requested* mode, as in the gateway: switching into LOCAL_ONLY must not probe.
    let time = if requested_internet_access {
        read_authoritative_time(ctx)
    } else {
        audit_cloud_request(
            ctx,
            AuditEntry::blocked(method, pathname, "APP_LOCAL_ONLY").with_source("authoritative-time"),
        );
        AuthoritativeTime { confirmed_at: iso_now(), time_source: "device" }
    };
    let written = write_policy(ctx, requested_internet_access, &time, &user_id, &device_id)?;
    let mut body = serde_json::to_value(&written)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    body.insert(
        "status".into(),
        json!(if written.allow_internet_access { "AUTO" } else { "LOCAL_ONLY" }),
    );
    Ok(respond(200, Value::Object(body)))
}

fn cloud_health(ctx: &GatewayContext<'_>, method: &str, pathname: &str) -> GatewayResponse {
    if !read_policy(ctx).allow_internet_access {
        return respond(
            200,
            json!({
                "status": "ok",
                "localBackendStatus": "ok",
                "appInternetAllowed": false,
                "cloudReachable": false,
                "syncReady": false,
                "errorCode": "APP_LOCAL_ONLY",
                "safeErrorMessage": LOCAL_ONLY_HEALTH_MESSAGE,
            }),
        );
    }
    if !ctx.cloud_configured() {
        audit_cloud_request(
            ctx,
            AuditEntry::blocked(method, pathname, "CLOUD_NOT_CONFIGURED").with_source("cloud-health"),
        );
        return respond(
            200,
            json!({
                "status": "ok",
                "localBackendStatus": "ok",
                "configuredCloudBaseUrl": "",
                "cloudApiConfigured": false,
                "appInternetAllowed": true,
                "cloudReachable": false,
                "syncReady": false,
                "errorCode": "CLOUD_NOT_CONFIGURED",
                "safeErrorMessage": GATEWAY_CLOUD_NOT_CONFIGURED_MESSAGE,
            }),
        );
    }
    let url = format!("{}/api/health", ctx.cloud_api_url);
    match ctx.probe.get_json(&url, CLOUD_HEALTH_TIMEOUT) {
        Ok((status, value)) => {
            let ok = (200..300).contains(&status);
            respond(
                200,
                json!({
                    "status": "ok",
                    "localBackendStatus": "ok",
                    "configuredCloudBaseUrl": ctx.cloud_api_url,
                    "cloudApiConfigured": true,
                    "appInternetAllowed": true,
                    "railwayHttpStatus": status,
                    "cloudReachable": ok && value.get("status") == Some(&json!("ok")),
                    "syncReady": false,
                    "cloudVersion": js_or(&[value.get("version")]).unwrap_or_else(|| json!("")),
                    "errorCode": if ok { "" } else { "CLOUD_HTTP_ERROR" },
                    "safeErrorMessage": if ok {
                        "Cloud backend is reachable.".to_string()
                    } else {
                        format!("Cloud returned HTTP {}.", status)
                    },
                }),
            )
        }
        Err(_) => respond(
            200,
            json!({
                "status": "ok",
                "localBackendStatus": "ok",
                "configuredCloudBaseUrl": ctx.cloud_api_url,
                "cloudApiConfigured": true,
                "appInternetAllowed": true,
                "cloudReachable": false,
                "syncReady": false,
                "errorCode": "CLOUD_UNREACHABLE",
                "safeErrorMessage": "Cloud backend is not reachable.",
            }),
        ),
    }
}

/// desktopGateway.js `localRoute`. `Ok(None)` is its `return false`: not a local route.
fn local_route(
    ctx: &GatewayContext<'_>,
    method: &str,
    pathname: &str,
    query: &str,
    headers: &HashMap<String, Value>,
    body: Option<&Value>,
) -> Result<Option<GatewayResponse>, GatewayError> {
    if pathname == "/health" || pathname == "/api/health" {
        return Ok(Some(respond(200, health(ctx)?)));
    }
    if pathname == "/api/version" {
        let mut value = health(ctx)?;
        if let Some(map) = value.as_object_mut() {
            map.insert("api".into(), json!("FroozERP Desktop Gateway"));
        }
        return Ok(Some(respond(200, value)));
    }
    if pathname == "/api/system/compatibility" {
        let frontend_version = query_param(query, "frontend_version")
            .filter(|value| !value.is_empty())
            .or_else(|| header(headers, "x-froozerp-frontend-version").filter(|value| !value.is_empty()))
            .unwrap_or_else(|| ctx.app_version.clone());
        return Ok(Some(respond(
            200,
            json!({
                "status": "ok",
                "appVersion": ctx.app_version,
                "frontendVersion": frontend_version,
                "backendVersion": ctx.app_version,
                "compatible": frontend_version == ctx.app_version,
                "database": "reachable",
                "databaseType": "sqlite",
                "storageAdapter": "desktop-sqlite",
                "clientPostgresAccess": false,
                "deploymentType": "local",
                "appMode": "LOCAL_SINGLE_DEVICE",
            }),
        )));
    }
    if pathname == "/api/cloud/internet-access" && method == "GET" {
        return Ok(Some(respond(200, policy_body(&read_policy(ctx)))));
    }
    if pathname == "/api/cloud/internet-access" && method == "PUT" {
        return put_internet_access(ctx, method, pathname, headers, body).map(Some);
    }
    if pathname == "/api/cloud/health" {
        return Ok(Some(cloud_health(ctx, method, pathname)));
    }
    if pathname == "/settings" && method == "GET" && !read_policy(ctx).allow_internet_access {
        let route = if query.is_empty() {
            pathname.to_string()
        } else {
            format!("{}?{}", pathname, query)
        };
        audit_cloud_request(ctx, AuditEntry::blocked(method, &route, "APP_LOCAL_ONLY").with_source("local-sqlite"));
        let path = ctx.sqlite_path.as_ref().ok_or_else(|| {
            GatewayError::local(
                "LOCAL_SETTINGS_LOAD_FAILED",
                "Saved local settings could not be loaded. FroozERP preserved the existing database and did not create defaults.",
            )
        })?;
        let bundle = read_local_settings_bundle(path)?;
        return Ok(Some(respond(200, Value::Object(bundle.settings))));
    }
    Ok(None)
}

/// cloudProxyError.js `normalizeCloudProxyError`, for the error shapes that can reach it here.
fn normalize_proxy_error(code: &str) -> (u16, Value) {
    match code {
        "CLOUD_NOT_CONFIGURED" => (
            503,
            json!({
                "code": "CLOUD_NOT_CONFIGURED",
                "failure_kind": "CLOUD_NOT_CONFIGURED",
                "cloud_connected": false,
                "message": PROXY_CLOUD_NOT_CONFIGURED_MESSAGE,
            }),
        ),
        "APP_INTERNET_DISABLED" | "APP_LOCAL_ONLY" => (
            503,
            json!({
                "code": "APP_LOCAL_ONLY",
                "failure_kind": "CLOUD_UNAVAILABLE",
                "cloud_connected": false,
                "message": LOCAL_ONLY_PROXY_MESSAGE,
            }),
        ),
        _ => (
            502,
            json!({
                "code": "CLOUD_UNAVAILABLE",
                "failure_kind": "CLOUD_UNAVAILABLE",
                "cloud_connected": false,
                "message": CLOUD_UNAVAILABLE_MESSAGE,
            }),
        ),
    }
}

/// The gateway's request handler minus the proxy: `mobile_gateway_request`.
pub fn handle_request(ctx: &GatewayContext<'_>, request: &GatewayRequest) -> GatewayResponse {
    let method = request.method.trim().to_uppercase();
    if method == "OPTIONS" {
        return respond(204, Value::Null);
    }
    let (pathname, query) = split_path_and_query(&request.path, request.query.as_deref());
    // Before everything else, as in the gateway: no speech path, known or unknown, any method,
    // may ever fall through to a cloud request.
    if pathname.starts_with(SPEECH_ROUTE_PREFIX) {
        return respond(
            501,
            json!({
                "code": "NOT_AVAILABLE_ON_THIS_DEVICE",
                "message": "Voice is not available in the phone app.",
            }),
        );
    }
    let empty = HashMap::new();
    let headers = request.headers.as_ref().unwrap_or(&empty);
    match local_route(ctx, &method, &pathname, &query, headers, request.body.as_ref()) {
        Ok(Some(response)) => response,
        Ok(None) => respond(404, json!({ "code": "NOT_A_LOCAL_ROUTE" })),
        Err(error) if error.code.starts_with("LOCAL_") || error.code == "DEVICE_IDENTITY_CONFLICT" => respond(
            503,
            json!({
                "code": error.code,
                "failure_kind": "LOCAL_SETTINGS_UNAVAILABLE",
                "cloud_connected": false,
                "message": error.message,
            }),
        ),
        Err(error) => {
            let (status, body) = normalize_proxy_error(&error.code);
            respond(status, body)
        }
    }
}

/// desktopGateway.js `cloudRequest`'s decision, without the `fetch`: `mobile_gateway_cloud_decision`.
pub fn cloud_decision(ctx: &GatewayContext<'_>, request: &CloudDecisionRequest) -> CloudDecision {
    let method = request.method.trim().to_uppercase();
    let route = if request.path.starts_with('/') {
        request.path.clone()
    } else {
        format!("/{}", request.path)
    };
    // The gateway never proxies a speech path (it answers them before `cloudRequest` is reachable).
    // The adapter should never ask, and if it does the answer is the same refusal.
    if route.starts_with(SPEECH_ROUTE_PREFIX) {
        return CloudDecision {
            allowed: false,
            status: 501,
            body: json!({
                "code": "NOT_AVAILABLE_ON_THIS_DEVICE",
                "message": "Voice is not available in the phone app.",
            }),
            cloud_base_url: None,
        };
    }
    if !read_policy(ctx).allow_internet_access {
        audit_cloud_request(ctx, AuditEntry::blocked(&method, &route, "APP_LOCAL_ONLY"));
        let (status, body) = normalize_proxy_error("APP_LOCAL_ONLY");
        return CloudDecision { allowed: false, status, body, cloud_base_url: None };
    }
    if !ctx.cloud_configured() {
        audit_cloud_request(ctx, AuditEntry::blocked(&method, &route, "CLOUD_NOT_CONFIGURED"));
        let (status, body) = normalize_proxy_error("CLOUD_NOT_CONFIGURED");
        return CloudDecision { allowed: false, status, body, cloud_base_url: None };
    }
    audit_cloud_request(
        ctx,
        AuditEntry {
            method,
            route,
            blocked: false,
            reached_cloud: true,
            reason: None,
            source: None,
            provenance: None,
        },
    );
    CloudDecision {
        allowed: true,
        status: 0,
        body: Value::Null,
        cloud_base_url: Some(ctx.cloud_api_url.clone()),
    }
}

// ---------------------------------------------------------------------------------------------
// JavaScript semantics
// ---------------------------------------------------------------------------------------------

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(true),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `a || b || ...`, returning the first truthy value (or `None` for "fell through").
fn js_or(values: &[Option<&Value>]) -> Option<Value> {
    values
        .iter()
        .flatten()
        .find(|value| js_truthy(value))
        .map(|value| (*value).clone())
}

fn js_number_string(number: &serde_json::Number) -> String {
    if let Some(value) = number.as_i64() {
        return value.to_string();
    }
    if let Some(value) = number.as_u64() {
        return value.to_string();
    }
    let value = number.as_f64().unwrap_or(f64::NAN);
    if value.fract() == 0.0 && value.abs() < 1e21 {
        format!("{}", value as i128)
    } else {
        format!("{}", value)
    }
}

/// `String(value)`.
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(number) => js_number_string(number),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

fn sql_value_to_json(value: &rusqlite::types::Value) -> Value {
    match value {
        rusqlite::types::Value::Null => Value::Null,
        rusqlite::types::Value::Integer(value) => json!(value),
        rusqlite::types::Value::Real(value) => serde_json::Number::from_f64(*value)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        rusqlite::types::Value::Text(text) => json!(text),
        rusqlite::types::Value::Blob(bytes) => json!(bytes),
    }
}

/// `String(x ?? "")` for a SQLite column value, as node:sqlite hands it to JavaScript.
fn sql_js_string(value: &rusqlite::types::Value) -> String {
    match value {
        rusqlite::types::Value::Null => String::new(),
        other => js_string(&sql_value_to_json(other)),
    }
}

/// `String(x || "")` for a SQLite column value.
fn sql_js_string_truthy(value: &rusqlite::types::Value) -> String {
    let json = sql_value_to_json(value);
    if js_truthy(&json) {
        js_string(&json)
    } else {
        String::new()
    }
}

// ---------------------------------------------------------------------------------------------
// Time: `new Date().toISOString()` without a date crate
// ---------------------------------------------------------------------------------------------

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = month as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub fn iso_from_unix_millis(millis: i64) -> String {
    let days = millis.div_euclid(86_400_000);
    let in_day = millis.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year,
        month,
        day,
        in_day / 3_600_000,
        (in_day / 60_000) % 60,
        (in_day / 1000) % 60,
        in_day % 1000
    )
}

pub fn iso_now() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default();
    iso_from_unix_millis(millis)
}

/// `new Date(value).toISOString()` for the ISO-8601 forms the cloud sends
/// (`YYYY-MM-DDTHH:MM[:SS[.fff…]]` with `Z` or `±HH:MM`). `None` where JavaScript would have
/// thrown -- and for the looser forms `Date` also accepts, which then fall back to device time.
pub fn normalize_iso_timestamp(value: &str) -> Option<String> {
    let value = value.trim();
    let bytes = value.as_bytes();
    let digits = |range: std::ops::Range<usize>| -> Option<i64> {
        let slice = value.get(range)?;
        if slice.is_empty() || !slice.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        slice.parse().ok()
    };
    if bytes.len() < 17 || bytes[4] != b'-' || bytes[7] != b'-' || !matches!(bytes[10], b'T' | b't' | b' ') || bytes[13] != b':' {
        return None;
    }
    let year = digits(0..4)?;
    let month = digits(5..7)? as u32;
    let day = digits(8..10)? as u32;
    let hour = digits(11..13)?;
    let minute = digits(14..16)?;
    let mut index = 16;
    let mut second = 0;
    let mut millis = 0;
    if bytes.get(index) == Some(&b':') {
        second = digits(index + 1..index + 3)?;
        index += 3;
        if bytes.get(index) == Some(&b'.') {
            let start = index + 1;
            let mut end = start;
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
            if end == start {
                return None;
            }
            let fraction = &value[start..end];
            let padded = format!("{:0<3}", &fraction[..fraction.len().min(3)]);
            millis = padded.parse::<i64>().ok()?;
            index = end;
        }
    }
    let offset_minutes = match value.get(index..)? {
        "Z" | "z" => 0,
        zone if zone.len() == 6 && matches!(zone.as_bytes()[0], b'+' | b'-') && zone.as_bytes()[3] == b':' => {
            let sign = if zone.as_bytes()[0] == b'-' { -1 } else { 1 };
            let hours = digits(index + 1..index + 3)?;
            let minutes = digits(index + 4..index + 6)?;
            if hours > 23 || minutes > 59 {
                return None;
            }
            sign * (hours * 60 + minutes)
        }
        _ => return None,
    };
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        _ => return None,
    };
    if day == 0 || day > days_in_month || hour > 24 || minute > 59 || second > 59 {
        return None;
    }
    if hour == 24 && (minute != 0 || second != 0 || millis != 0) {
        return None;
    }
    let total = days_from_civil(year, month, day) * 86_400_000
        + hour * 3_600_000
        + minute * 60_000
        + second * 1000
        + millis
        - offset_minutes * 60_000;
    Some(iso_from_unix_millis(total))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    /// Counts every attempted outbound connection and answers from a script.
    struct CountingProbe {
        calls: AtomicUsize,
        urls: Mutex<Vec<String>>,
        answer: Result<(u16, Value), String>,
    }

    impl CountingProbe {
        fn answering(answer: Result<(u16, Value), String>) -> Self {
            CountingProbe {
                calls: AtomicUsize::new(0),
                urls: Mutex::new(Vec::new()),
                answer,
            }
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl CloudProbe for CountingProbe {
        fn get_json(&self, url: &str, _timeout: Duration) -> Result<(u16, Value), String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.urls.lock().unwrap().push(url.to_string());
            self.answer.clone()
        }
    }

    struct Fixture {
        dir: PathBuf,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "froozerp-mobile-gateway-{}-{}-{}",
                name,
                std::process::id(),
                SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
            ));
            fs::create_dir_all(&dir).unwrap();
            Fixture { dir }
        }

        fn ctx<'a>(&self, probe: &'a dyn CloudProbe, cloud: &str) -> GatewayContext<'a> {
            GatewayContext {
                app_data_dir: Some(self.dir.clone()),
                sqlite_path: Some(self.dir.join("froozerp-local.sqlite3")),
                cloud_api_url: normalize_cloud_api_url(cloud),
                app_version: "9.9.9".to_string(),
                probe,
            }
        }

        fn set_policy(&self, contents: &str) {
            fs::write(self.dir.join(POLICY_FILE_NAME), contents).unwrap();
        }

        fn local_only(&self) {
            self.set_policy(
                "{\n  \"allowInternetAccess\": false,\n  \"updatedAt\": \"2026-09-01T10:00:00.000Z\",\n  \"confirmedAt\": \"2026-09-01T10:00:00.000Z\",\n  \"timeSource\": \"device\",\n  \"changedBy\": \"1\",\n  \"deviceId\": \"FZDEV-A\"\n}",
            );
        }

        fn policy_text(&self) -> Option<String> {
            fs::read_to_string(self.dir.join(POLICY_FILE_NAME)).ok()
        }

        fn audit_lines(&self) -> Vec<String> {
            fs::read_to_string(self.dir.join("logs").join(AUDIT_FILE_NAME))
                .unwrap_or_default()
                .lines()
                .map(str::to_string)
                .collect()
        }

        fn audit_entries(&self) -> Vec<Value> {
            self.audit_lines()
                .iter()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect()
        }

        fn init_db(&self) -> PathBuf {
            let path = self.dir.join("froozerp-local.sqlite3");
            crate::local_db::initialize_path(&path).unwrap();
            path
        }

        fn seed_owner(&self, id: &str) {
            let path = self.init_db();
            let connection = rusqlite::Connection::open(path).unwrap();
            connection
                .execute(
                    "INSERT INTO local_kv (key, value) VALUES (?1, ?2)",
                    rusqlite::params![
                        format!("offline_user_profile::FZDEV-A::owner-{}", id),
                        json!({ "id": id, "role": "Owner", "username": "owner" }).to_string()
                    ],
                )
                .unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    const CLOUD: &str = "https://cloud.example.test";

    fn request(method: &str, path: &str) -> GatewayRequest {
        GatewayRequest {
            method: method.to_string(),
            path: path.to_string(),
            query: None,
            headers: None,
            body: None,
        }
    }

    fn put_access(allow: bool, user: &str, role: &str, device: &str, origin: Option<&str>) -> GatewayRequest {
        let mut headers = HashMap::new();
        if let Some(origin) = origin {
            headers.insert("Origin".to_string(), json!(origin));
        }
        GatewayRequest {
            method: "put".to_string(),
            path: "/api/cloud/internet-access".to_string(),
            query: None,
            headers: Some(headers),
            body: Some(json!({
                "allowInternetAccess": allow,
                "user_id": user,
                "role": role,
                "device_id": device,
            })),
        }
    }

    fn decision_request(method: &str, path: &str) -> CloudDecisionRequest {
        CloudDecisionRequest {
            method: method.to_string(),
            path: path.to_string(),
            headers: None,
        }
    }

    // ---- LOCAL_ONLY: the invariant ----------------------------------------------------------

    #[test]
    fn local_only_refuses_a_cloud_bound_request_with_the_gateway_body() {
        let fixture = Fixture::new("refuse");
        fixture.local_only();
        let probe = CountingProbe::answering(Ok((200, json!({ "status": "ok" }))));
        let ctx = fixture.ctx(&probe, CLOUD);

        let decision = cloud_decision(&ctx, &decision_request("post", "/api/sync/push"));

        assert!(!decision.allowed);
        assert_eq!(decision.status, 503);
        assert_eq!(
            decision.body,
            json!({
                "code": "APP_LOCAL_ONLY",
                "failure_kind": "CLOUD_UNAVAILABLE",
                "cloud_connected": false,
                "message": "Local Only mode selected - cloud sync paused. Local modules remain available.",
            })
        );
        assert_eq!(probe.calls(), 0, "LOCAL_ONLY must make no external connection");
    }

    #[test]
    fn local_only_audit_entry_is_blocked_and_never_reached_the_cloud() {
        let fixture = Fixture::new("audit");
        fixture.local_only();
        let probe = CountingProbe::answering(Ok((200, json!({}))));
        let ctx = fixture.ctx(&probe, CLOUD);

        cloud_decision(&ctx, &decision_request("GET", "/api/products?branch_id=1"));

        let lines = fixture.audit_lines();
        assert_eq!(lines.len(), 1);
        // Byte-for-byte the gateway's `JSON.stringify({ at, ...entry })`: key order included.
        let expected_tail = r#","method":"GET","route":"/api/products?branch_id=1","blocked":true,"reachedCloud":false,"reason":"APP_LOCAL_ONLY"}"#;
        assert!(lines[0].starts_with(r#"{"at":""#), "{}", lines[0]);
        assert!(lines[0].ends_with(expected_tail), "{}", lines[0]);
        let entry = &fixture.audit_entries()[0];
        assert_eq!(entry["blocked"], json!(true));
        assert_eq!(entry["reachedCloud"], json!(false));
        assert!(normalize_iso_timestamp(entry["at"].as_str().unwrap()).is_some());
        assert_eq!(probe.calls(), 0);
    }

    #[test]
    fn local_only_cloud_health_reports_paused_without_probing() {
        let fixture = Fixture::new("health-paused");
        fixture.local_only();
        let probe = CountingProbe::answering(Ok((200, json!({ "status": "ok" }))));
        let ctx = fixture.ctx(&probe, CLOUD);

        let response = handle_request(&ctx, &request("GET", "/api/cloud/health"));

        assert_eq!(response.status, 200);
        assert_eq!(response.body["appInternetAllowed"], json!(false));
        assert_eq!(response.body["errorCode"], json!("APP_LOCAL_ONLY"));
        assert_eq!(response.body["cloudReachable"], json!(false));
        assert_eq!(probe.calls(), 0);
    }

    #[test]
    fn a_non_owner_cannot_switch_the_policy_in_either_direction() {
        let fixture = Fixture::new("non-owner");
        fixture.local_only();
        let before = fixture.policy_text();
        let probe = CountingProbe::answering(Ok((200, json!({ "server_time": "2026-09-25T00:00:00.000Z" }))));
        let ctx = fixture.ctx(&probe, CLOUD);

        for role in ["CASHIER", "MANAGER", ""] {
            let response = handle_request(&ctx, &put_access(true, "7", role, "FZDEV-A", None));
            assert_eq!(response.status, 403, "role {role:?}");
            assert_eq!(
                response.body,
                json!({ "code": "OWNER_REQUIRED", "message": "Authenticated Owner permission is required." })
            );
        }
        // Owner role but no user or no device is an incomplete claim.
        assert_eq!(handle_request(&ctx, &put_access(true, "", "OWNER", "FZDEV-A", None)).status, 403);
        assert_eq!(handle_request(&ctx, &put_access(true, "7", "OWNER", "", None)).status, 403);
        // And locking down still needs the Owner claim.
        assert_eq!(handle_request(&ctx, &put_access(false, "7", "CASHIER", "FZDEV-A", None)).status, 403);

        assert_eq!(fixture.policy_text(), before, "a refusal must leave the policy file untouched");
        assert_eq!(read_policy(&ctx).allow_internet_access, false);
        assert_eq!(probe.calls(), 0, "a refused switch must touch no network");
        let entries = fixture.audit_entries();
        assert_eq!(entries.len(), 6);
        for entry in entries {
            assert_eq!(entry["blocked"], json!(true));
            assert_eq!(entry["reachedCloud"], json!(false));
            assert_eq!(entry["reason"], json!("OWNER_REQUIRED"));
            assert_eq!(entry["source"], json!("kill-switch-authority"));
            assert_eq!(entry["provenance"], json!("NOT_A_BROWSER"));
            assert_eq!(entry["route"], json!("/api/cloud/internet-access"));
            assert_eq!(entry["method"], json!("PUT"));
        }
    }

    #[test]
    fn an_owner_the_device_does_not_recognise_cannot_unlock() {
        let fixture = Fixture::new("unrecognised");
        fixture.local_only();
        fixture.seed_owner("4");
        let probe = CountingProbe::answering(Ok((200, json!({}))));
        let ctx = fixture.ctx(&probe, CLOUD);

        // Opaque ids: "004" is not "4".
        let response = handle_request(&ctx, &put_access(true, "004", "owner", "FZDEV-A", None));
        assert_eq!(response.status, 403);
        assert_eq!(response.body["code"], json!("OWNER_NOT_RECOGNISED"));
        assert_eq!(read_policy(&ctx).allow_internet_access, false);
        assert_eq!(probe.calls(), 0);
        assert_eq!(read_local_owner_user_ids(ctx.sqlite_path.as_deref()), Some(vec!["4".to_string()]));
    }

    #[test]
    fn a_website_cannot_unlock_but_may_lock_down() {
        let fixture = Fixture::new("website");
        fixture.local_only();
        let probe = CountingProbe::answering(Ok((200, json!({}))));
        let ctx = fixture.ctx(&probe, CLOUD);

        let refused = handle_request(&ctx, &put_access(true, "1", "OWNER", "FZDEV-A", Some("https://attacker.example")));
        assert_eq!(refused.status, 403);
        assert_eq!(refused.body["code"], json!("CROSS_ORIGIN_CONTROL_REFUSED"));
        assert_eq!(fixture.audit_entries()[0]["provenance"], json!("FOREIGN_WEBSITE"));
        assert_eq!(read_policy(&ctx).allow_internet_access, false);

        let locked = handle_request(&ctx, &put_access(false, "1", "OWNER", "FZDEV-A", Some("null")));
        assert_eq!(locked.status, 200);
        assert_eq!(locked.body["status"], json!("LOCAL_ONLY"));
        assert_eq!(probe.calls(), 0);
    }

    #[test]
    fn switching_into_local_only_never_probes_and_writes_the_gateway_file_format() {
        let fixture = Fixture::new("lockdown");
        let probe = CountingProbe::answering(Ok((200, json!({ "server_time": "2026-09-25T00:00:00.000Z" }))));
        let ctx = fixture.ctx(&probe, CLOUD);
        assert!(read_policy(&ctx).allow_internet_access, "never set allows");

        let response = handle_request(&ctx, &put_access(false, "1", "OWNER", "FZDEV-A", None));

        assert_eq!(response.status, 200);
        assert_eq!(response.body["allowInternetAccess"], json!(false));
        assert_eq!(response.body["status"], json!("LOCAL_ONLY"));
        assert_eq!(response.body["timeSource"], json!("device"));
        assert_eq!(response.body["changedBy"], json!("1"));
        assert!(response.body.get("source").is_none(), "the PUT answer is the written policy");
        assert_eq!(probe.calls(), 0, "switching into LOCAL_ONLY must not reach the cloud");

        let text = fixture.policy_text().unwrap();
        let keys = text
            .lines()
            .filter_map(|line| line.trim().strip_prefix('"').and_then(|rest| rest.split('"').next()))
            .collect::<Vec<_>>();
        assert_eq!(keys, ["allowInternetAccess", "updatedAt", "confirmedAt", "timeSource", "changedBy", "deviceId"]);
        assert!(text.starts_with("{\n  \"allowInternetAccess\": false,\n"), "{text}");

        let entries = fixture.audit_entries();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["reason"], json!("APP_LOCAL_ONLY"));
        assert_eq!(entries[0]["source"], json!("authoritative-time"));
        assert_eq!(entries[0]["blocked"], json!(true));
        assert_eq!(entries[0]["reachedCloud"], json!(false));

        // And now every cloud-bound request is refused.
        assert!(!cloud_decision(&ctx, &decision_request("GET", "/api/anything")).allowed);
        assert_eq!(probe.calls(), 0);
    }

    #[test]
    fn a_recognised_owner_can_unlock_and_gets_server_confirmed_time() {
        let fixture = Fixture::new("unlock");
        fixture.local_only();
        fixture.seed_owner("1");
        let probe = CountingProbe::answering(Ok((200, json!({ "status": "ok", "server_time": "2026-09-25T05:30:00+05:30" }))));
        let ctx = fixture.ctx(&probe, CLOUD);

        let response = handle_request(&ctx, &put_access(true, "1", "Owner", "FZDEV-A", Some("http://tauri.localhost")));

        assert_eq!(response.status, 200, "{}", response.body);
        assert_eq!(response.body["status"], json!("AUTO"));
        assert_eq!(response.body["timeSource"], json!("railway"));
        assert_eq!(response.body["confirmedAt"], json!("2026-09-25T00:00:00.000Z"));
        assert_eq!(probe.calls(), 1);
        assert_eq!(probe.urls.lock().unwrap()[0], "https://cloud.example.test/api/health");
        assert!(read_policy(&ctx).allow_internet_access);
        assert_eq!(read_policy(&ctx).source, PolicySource::Stored);
    }

    #[test]
    fn an_unreadable_or_unresolvable_policy_fails_closed() {
        let fixture = Fixture::new("unreadable");
        let probe = CountingProbe::answering(Ok((200, json!({}))));
        let ctx = fixture.ctx(&probe, CLOUD);
        for contents in ["not json", "{}", "{\"allowInternetAccess\":\"false\"}", "null", "[]"] {
            fixture.set_policy(contents);
            let policy = read_policy(&ctx);
            assert!(!policy.allow_internet_access, "{contents}");
            assert_eq!(policy.source, PolicySource::Unreadable, "{contents}");
            assert!(!cloud_decision(&ctx, &decision_request("GET", "/api/x")).allowed, "{contents}");
        }

        let unresolved = GatewayContext {
            app_data_dir: None,
            sqlite_path: None,
            cloud_api_url: CLOUD.to_string(),
            app_version: "9.9.9".to_string(),
            probe: &probe,
        };
        let decision = cloud_decision(&unresolved, &decision_request("GET", "/api/x"));
        assert!(!decision.allowed);
        assert_eq!(decision.body["code"], json!("APP_LOCAL_ONLY"));
        let health = handle_request(&unresolved, &request("GET", "/api/cloud/health"));
        assert_eq!(health.body["appInternetAllowed"], json!(false));
        assert_eq!(probe.calls(), 0);
    }

    // ---- Allowed and not-configured -----------------------------------------------------------

    #[test]
    fn an_allowed_request_is_audited_as_reaching_the_cloud() {
        let fixture = Fixture::new("allowed");
        let probe = CountingProbe::answering(Ok((200, json!({}))));
        let ctx = fixture.ctx(&probe, CLOUD);

        let decision = cloud_decision(&ctx, &decision_request("patch", "/api/products/004"));

        assert_eq!(
            decision,
            CloudDecision { allowed: true, status: 0, body: Value::Null, cloud_base_url: Some(CLOUD.to_string()) }
        );
        let lines = fixture.audit_lines();
        assert!(lines[0].ends_with(r#","method":"PATCH","route":"/api/products/004","blocked":false,"reachedCloud":true}"#), "{}", lines[0]);
        assert_eq!(probe.calls(), 0, "the decision itself never connects; the adapter sends the request");
    }

    #[test]
    fn no_cloud_configured_is_refused_by_name() {
        let fixture = Fixture::new("unconfigured");
        let probe = CountingProbe::answering(Ok((200, json!({}))));
        let ctx = fixture.ctx(&probe, "  ");

        let decision = cloud_decision(&ctx, &decision_request("GET", "/api/x"));
        assert!(!decision.allowed);
        assert_eq!(decision.status, 503);
        assert_eq!(
            decision.body,
            json!({
                "code": "CLOUD_NOT_CONFIGURED",
                "failure_kind": "CLOUD_NOT_CONFIGURED",
                "cloud_connected": false,
                "message": "No cloud backend is configured for this installation. Local modules remain available.",
            })
        );
        let health = handle_request(&ctx, &request("GET", "/api/cloud/health"));
        assert_eq!(health.body["errorCode"], json!("CLOUD_NOT_CONFIGURED"));
        assert_eq!(health.body["cloudApiConfigured"], json!(false));
        let entries = fixture.audit_entries();
        assert_eq!(entries[0]["reason"], json!("CLOUD_NOT_CONFIGURED"));
        assert!(entries[0].get("source").is_none());
        assert_eq!(entries[1]["source"], json!("cloud-health"));
        assert_eq!(probe.calls(), 0);
    }

    #[test]
    fn cloud_health_mirrors_the_gateway_when_allowed() {
        let fixture = Fixture::new("health-allowed");
        let up = CountingProbe::answering(Ok((200, json!({ "status": "ok", "version": "1.0.74" }))));
        let response = handle_request(&fixture.ctx(&up, CLOUD), &request("GET", "/api/cloud/health"));
        assert_eq!(response.body["cloudReachable"], json!(true));
        assert_eq!(response.body["railwayHttpStatus"], json!(200));
        assert_eq!(response.body["cloudVersion"], json!("1.0.74"));
        assert_eq!(response.body["errorCode"], json!(""));
        assert_eq!(response.body["configuredCloudBaseUrl"], json!(CLOUD));

        let failing = CountingProbe::answering(Ok((500, json!({}))));
        let response = handle_request(&fixture.ctx(&failing, CLOUD), &request("GET", "/api/cloud/health"));
        assert_eq!(response.body["errorCode"], json!("CLOUD_HTTP_ERROR"));
        assert_eq!(response.body["safeErrorMessage"], json!("Cloud returned HTTP 500."));

        let down = CountingProbe::answering(Err("timeout".to_string()));
        let response = handle_request(&fixture.ctx(&down, CLOUD), &request("GET", "/api/cloud/health"));
        assert_eq!(response.status, 200);
        assert_eq!(response.body["errorCode"], json!("CLOUD_UNREACHABLE"));
        assert!(response.body.get("railwayHttpStatus").is_none());
    }

    // ---- Local routes ------------------------------------------------------------------------

    #[test]
    fn speech_unknown_and_preflight_routes() {
        let fixture = Fixture::new("routes");
        let probe = CountingProbe::answering(Ok((200, json!({}))));
        let ctx = fixture.ctx(&probe, CLOUD);

        for path in ["/api/local/speech/status", "/api/local/speech/transcribe", "/api/local/speech/nope"] {
            let response = handle_request(&ctx, &request("POST", path));
            assert_eq!(response.status, 501);
            assert_eq!(
                response.body,
                json!({ "code": "NOT_AVAILABLE_ON_THIS_DEVICE", "message": "Voice is not available in the phone app." })
            );
            assert!(!cloud_decision(&ctx, &decision_request("POST", path)).allowed);
        }
        assert_eq!(
            handle_request(&ctx, &request("GET", "/api/products")),
            GatewayResponse { status: 404, body: json!({ "code": "NOT_A_LOCAL_ROUTE" }) }
        );
        assert_eq!(handle_request(&ctx, &request("POST", "/api/cloud/internet-access")).status, 404);
        assert_eq!(handle_request(&ctx, &request("OPTIONS", "/api/anything")).status, 204);
        // /settings is only local while LOCAL_ONLY is in force.
        assert_eq!(handle_request(&ctx, &request("GET", "/settings")).status, 404);
        assert_eq!(probe.calls(), 0);
    }

    #[test]
    fn health_version_and_compatibility() {
        let fixture = Fixture::new("health");
        let probe = CountingProbe::answering(Ok((200, json!({}))));
        let ctx = fixture.ctx(&probe, CLOUD);

        // No database yet: the gateway's validateSQLite throws, which becomes a 502.
        let missing = handle_request(&ctx, &request("GET", "/api/health"));
        assert_eq!(missing.status, 502);
        assert_eq!(missing.body["code"], json!("CLOUD_UNAVAILABLE"));

        fixture.init_db();
        let health = handle_request(&ctx, &request("GET", "/health"));
        assert_eq!(health.status, 200);
        assert_eq!(health.body["app"], json!("FroozERP"));
        assert_eq!(health.body["version"], json!("9.9.9"));
        assert_eq!(health.body["database_type"], json!("sqlite"));
        assert_eq!(health.body["client_postgres_access"], json!(false));
        assert_eq!(health.body["cloud_api_configured"], json!(true));
        let version = handle_request(&ctx, &request("GET", "/api/version"));
        assert_eq!(version.body["api"], json!("FroozERP Desktop Gateway"));

        let mut compat = request("GET", "/api/system/compatibility");
        compat.query = Some("?frontend_version=9.9.9&x=1".to_string());
        assert_eq!(handle_request(&ctx, &compat).body["compatible"], json!(true));
        let mut compat = request("GET", "/api/system/compatibility?frontend_version=1.0.0");
        compat.headers = Some(HashMap::from([("X-FroozERP-Frontend-Version".to_string(), json!("9.9.9"))]));
        let body = handle_request(&ctx, &compat).body;
        assert_eq!(body["frontendVersion"], json!("1.0.0"));
        assert_eq!(body["compatible"], json!(false));
        let mut compat = request("GET", "/api/system/compatibility");
        compat.headers = Some(HashMap::from([("x-froozerp-frontend-version".to_string(), json!("2.0.0"))]));
        assert_eq!(handle_request(&ctx, &compat).body["frontendVersion"], json!("2.0.0"));
    }

    #[test]
    fn settings_are_served_from_sqlite_only_in_local_only() {
        let fixture = Fixture::new("settings");
        fixture.local_only();
        let probe = CountingProbe::answering(Ok((200, json!({}))));
        let ctx = fixture.ctx(&probe, CLOUD);

        // No database: node:sqlite's ERR_SQLITE_ERROR is not a LOCAL_ code, so the gateway says 502.
        assert_eq!(handle_request(&ctx, &request("GET", "/settings")).status, 502);

        let path = fixture.init_db();
        let unscoped = handle_request(&ctx, &request("GET", "/settings"));
        assert_eq!(unscoped.status, 503);
        assert_eq!(unscoped.body["code"], json!("LOCAL_DEVICE_IDENTITY_MISSING"));
        assert_eq!(unscoped.body["failure_kind"], json!("LOCAL_SETTINGS_UNAVAILABLE"));

        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "INSERT INTO local_device_identity (device_id, device_name, platform, app_version, branch_id, registration_status)
                 VALUES ('FZDEV-A', 'Phone', 'tauri-android', '9.9.9', '2', 'approved');
                 INSERT INTO local_settings (id, branch_id, setting_key, setting_value) VALUES ('s1', NULL, 'shop_name', '\"Frooz\"');
                 INSERT INTO local_settings (id, branch_id, setting_key, setting_value) VALUES ('s2', '2', 'shop_name', '\"Frooz Branch\"');
                 INSERT INTO local_settings (id, branch_id, setting_key, setting_value) VALUES ('s3', '3', 'other_branch', '1');
                 INSERT INTO local_settings (id, branch_id, setting_key, setting_value) VALUES ('s4', NULL, 'tax', '{\"gst\":5}');",
            )
            .unwrap();
        let mut settings = request("GET", "/settings");
        settings.query = Some("t=1".to_string());
        let response = handle_request(&ctx, &settings);
        assert_eq!(response.status, 200, "{}", response.body);
        assert_eq!(response.body, json!({ "shop_name": "Frooz Branch", "tax": { "gst": 5 } }));
        let entries = fixture.audit_entries();
        let last = entries.last().unwrap();
        assert_eq!(last["route"], json!("/settings?t=1"));
        assert_eq!(last["source"], json!("local-sqlite"));
        assert_eq!(last["blocked"], json!(true));
        assert_eq!(last["reachedCloud"], json!(false));

        connection
            .execute("INSERT INTO local_settings (id, branch_id, setting_key, setting_value) VALUES ('s5', NULL, 'broken', '{')", [])
            .unwrap();
        let malformed = handle_request(&ctx, &request("GET", "/settings"));
        assert_eq!(malformed.status, 503);
        assert_eq!(malformed.body["code"], json!("LOCAL_SETTINGS_MALFORMED"));
        assert_eq!(probe.calls(), 0);
    }

    #[test]
    fn two_approved_devices_resolve_like_the_gateway() {
        let fixture = Fixture::new("conflict");
        let path = fixture.init_db();
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "INSERT INTO local_device_identity (device_id, device_name, platform, app_version, branch_id, registration_status, last_seen_at)
                 VALUES ('FZDEV-B', 'B', 'tauri-windows', '1', '5', 'approved', '2026-08-01T00:00:00.000Z'),
                        ('FZDEV-A', 'A', 'tauri-windows', '1', '4', 'approved', '2026-09-01T00:00:00.000Z'),
                        ('FZDEV-C', 'C', 'tauri-windows', '1', '6', 'pending', '2026-09-20T00:00:00.000Z');",
            )
            .unwrap();
        let bundle = read_local_settings_bundle(&path).unwrap();
        assert_eq!(bundle.canonical_device_id, "FZDEV-A");
        assert_eq!(bundle.branch_id, "4");
        assert_eq!(bundle.company_id, Value::Null);
        assert_eq!(
            bundle.identity_conflict,
            Some(json!({ "kind": "MULTIPLE_APPROVED", "deviceIds": ["FZDEV-A", "FZDEV-B"], "selected": "FZDEV-A" }))
        );
    }

    // ---- Pieces ------------------------------------------------------------------------------

    #[test]
    fn origin_classification_matches_the_gateway_cases() {
        for origin in [
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
            "http://localhost:5173",
            "http://127.0.0.1:5000",
            "http://[::1]:5173",
            "HTTP://LOCALHOST",
            "http://app.localhost",
        ] {
            assert_eq!(classify_control_origin(origin), ControlOrigin::DesktopApp, "{origin}");
        }
        for origin in ["https://attacker.example", "null", "NULL", "http://localhost.attacker.example", "http://user@evil.example"] {
            assert_eq!(classify_control_origin(origin), ControlOrigin::ForeignWebsite, "{origin}");
        }
        for origin in ["", "  ", "froozerp://localhost", "not a url", "http://", "1http://x"] {
            assert_eq!(classify_control_origin(origin), ControlOrigin::NotABrowser, "{origin:?}");
        }
    }

    #[test]
    fn kill_switch_decision_rules() {
        let owners = vec!["1".to_string()];
        let decision = resolve_kill_switch_decision(true, " 1 ", "owner", "FZDEV-A", "", Some(&owners));
        assert!(decision.allowed);
        assert_eq!(decision.direction, Some("UNLOCK"));
        // An unevaluable corroboration is skipped, never failed.
        assert!(resolve_kill_switch_decision(true, "9", "OWNER", "D", "", None).allowed);
        assert!(resolve_kill_switch_decision(true, "9", "OWNER", "D", "", Some(&[])).allowed);
        // The corroboration never blocks the lockdown direction.
        let lock = resolve_kill_switch_decision(false, "9", "OWNER", "D", "https://evil.example", Some(&owners));
        assert!(lock.allowed);
        assert_eq!(lock.direction, Some("LOCK_DOWN"));
        assert_eq!(
            resolve_kill_switch_decision(true, "9", "OWNER", "D", "", Some(&owners)).code,
            Some("OWNER_NOT_RECOGNISED")
        );
    }

    #[test]
    fn policy_resolution_matches_the_gateway() {
        let never = resolve_policy_from_read(PolicyRead::NotFound);
        assert!(never.allow_internet_access);
        assert_eq!(never.source, PolicySource::NeverSet);
        assert_eq!(never.time_source, json!("device"));
        let stored = resolve_policy_from_read(PolicyRead::Contents(
            r#"{"allowInternetAccess":true,"updatedAt":"u","confirmedAt":"","timeSource":"","changedBy":0}"#,
        ));
        assert!(stored.allow_internet_access);
        assert_eq!(stored.confirmed_at, json!("u"), "confirmedAt || updatedAt");
        assert_eq!(stored.time_source, json!("device"));
        assert_eq!(stored.changed_by, Value::Null);
        assert_eq!(resolve_policy_from_read(PolicyRead::Failed).source, PolicySource::Unreadable);
    }

    #[test]
    fn legacy_cloud_address_is_normalised() {
        assert_eq!(
            normalize_cloud_api_url(" https://froozerp-production.up.railway.app/ "),
            crate::PRODUCTION_CLOUD_API_URL
        );
        assert_eq!(normalize_cloud_api_url("https://sandbox.example/"), "https://sandbox.example");
        assert_eq!(normalize_cloud_api_url(""), "");
    }

    #[test]
    fn timestamps_format_like_to_iso_string() {
        assert_eq!(iso_from_unix_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_unix_millis(1_758_758_400_123), "2025-09-25T00:00:00.123Z");
        assert_eq!(iso_from_unix_millis(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(normalize_iso_timestamp("2026-09-25T10:11:12.345Z").as_deref(), Some("2026-09-25T10:11:12.345Z"));
        assert_eq!(normalize_iso_timestamp("2026-09-25T10:11:12Z").as_deref(), Some("2026-09-25T10:11:12.000Z"));
        assert_eq!(normalize_iso_timestamp("2026-09-25T10:11:12.3456789Z").as_deref(), Some("2026-09-25T10:11:12.345Z"));
        assert_eq!(normalize_iso_timestamp("2026-03-01T01:00:00+05:30").as_deref(), Some("2026-02-28T19:30:00.000Z"));
        assert_eq!(normalize_iso_timestamp("2026-02-30T00:00:00Z"), None);
        assert_eq!(normalize_iso_timestamp("yesterday"), None);
        let now = iso_now();
        assert_eq!(normalize_iso_timestamp(&now), Some(now));
    }

    #[test]
    fn query_parameters_decode_like_url_search_params() {
        assert_eq!(query_param("a=1&frontend_version=1.0.74&frontend_version=2", "frontend_version").as_deref(), Some("1.0.74"));
        assert_eq!(query_param("frontend_version=1%2E0+beta", "frontend_version").as_deref(), Some("1.0 beta"));
        assert_eq!(query_param("x=%zz%4", "x").as_deref(), Some("%zz%4"));
        assert_eq!(query_param("", "x"), None);
    }

    #[test]
    fn runtime_profile_describes_this_build() {
        let profile = runtime_profile();
        assert_eq!(profile.mobile, cfg!(mobile));
        assert_eq!(profile.gateway, !cfg!(mobile));
        if cfg!(target_os = "windows") {
            assert_eq!(profile.platform, "windows");
        }
    }

    /// The real probe, against a loopback HTTP server: status, JSON body, and a non-JSON body read
    /// as `{}` the way `response.json().catch(() => ({}))` does.
    #[cfg(not(windows))]
    #[test]
    fn http_probe_reads_status_and_json() {
        use std::io::{BufRead, BufReader};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for body in ["{\"status\":\"ok\",\"version\":\"1\"}", "<html>"] {
                let (mut stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                while reader.read_line(&mut line).unwrap() > 0 && line != "\r\n" {
                    line.clear();
                }
                let status = if body.starts_with('{') { "200 OK" } else { "503 Service Unavailable" };
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            }
        });
        let url = format!("http://{}/api/health", address);
        let (status, body) = HttpCloudProbe.get_json(&url, Duration::from_secs(5)).unwrap();
        assert_eq!(status, 200);
        assert_eq!(body, json!({ "status": "ok", "version": "1" }));
        let (status, body) = HttpCloudProbe.get_json(&url, Duration::from_secs(5)).unwrap();
        assert_eq!(status, 503);
        assert_eq!(body, json!({}));
        server.join().unwrap();
        assert!(NoNetworkProbe.get_json(&url, Duration::from_secs(1)).is_err());
    }
}
