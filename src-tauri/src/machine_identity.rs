//! One computer, one device id.
//!
//! A desktop's device id is minted once and must then survive every update, every reinstall and an
//! uninstall that chose "delete app data". The SQLite profile under `%APPDATA%` cannot carry that on
//! its own: it is exactly what such an uninstall deletes, it is per Windows user, and a deleted or
//! corrupted file used to mean a brand-new `FZDEV-…` id and one more "device" for the Owner to
//! approve. Two things in this module close that gap:
//!
//! * **A machine fingerprint.** `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`, the per-install
//!   Windows GUID, lower-cased and hashed as `sha256("froozerp:machine:" + guid)`. Only the hash ever
//!   leaves this module — the raw GUID is never stored, logged or sent. Any failure is `""`, never a
//!   panic and never a blocked startup.
//! * **A machine anchor file** at `%ProgramData%\FroozERP\device-anchor.json`, outside the app-data
//!   directory and so outside anything the uninstaller removes. It records which device id this
//!   machine was given and the fingerprint it was given under. A profile with no identity row reuses
//!   the anchored id instead of minting a new one, but only when the fingerprint still matches —
//!   a `ProgramData` folder copied onto another computer must not hand that computer this one's id.
//!
//! Everything here is local registry and local file access. Nothing in this module opens a network
//! connection, so LOCAL_ONLY's `reachedCloud=false` / zero-external-connections contract is untouched.
//!
//! A disposable or test profile (`NODE_ENV=test` + an absolute `FROOZERP_ISOLATED_SQLITE_DIR`, the
//! same rule `local_db::database_path` applies) keeps its anchor inside that isolated directory, so
//! `npm run app:disposable` never reads or writes the real machine's anchor.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// File name of the anchor, both in `%ProgramData%\FroozERP` and in an isolated profile directory.
pub const DEVICE_ANCHOR_FILE: &str = "device-anchor.json";
/// The one anchor format this build reads and writes.
const DEVICE_ANCHOR_VERSION: u64 = 1;
/// Domain separation for the fingerprint hash, so this digest cannot collide in meaning with any
/// other SHA-256 of the same GUID that some other product computes.
const MACHINE_FP_DOMAIN: &str = "froozerp:machine:";
/// Where `%ProgramData%` lives when the variable is missing (a stripped service environment).
const DEFAULT_PROGRAM_DATA: &str = r"C:\ProgramData";

/// What the device-identity resolver knows about the machine it is running on.
///
/// `MachineContext::none()` is the inert form — no fingerprint, no anchor — which is what every
/// path-addressed (`*_at`) caller and every unit test uses, so a `cargo test` run on a developer's
/// real Windows laptop never touches that laptop's `ProgramData` anchor.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MachineContext {
    /// Lowercase hex SHA-256 fingerprint of this machine, or `""` when it is unknown.
    pub machine_fp: String,
    /// Where this machine's anchor lives, or `None` where there is no anchor (non-Windows, or inert).
    pub anchor_path: Option<PathBuf>,
}

impl MachineContext {
    /// No fingerprint and no anchor: today's behaviour exactly.
    pub fn none() -> Self {
        Self::default()
    }

    /// The real machine: fingerprint from the registry, anchor from `%ProgramData%` (or the
    /// isolated profile directory under the disposable/test override).
    pub fn current() -> Self {
        Self {
            machine_fp: current_machine_fp(),
            anchor_path: device_anchor_path(),
        }
    }
}

/// `sha256_hex("froozerp:machine:" + lowercase(trim(guid)))`, or `""` for an empty GUID.
pub fn machine_fp_from_guid(raw_guid: &str) -> String {
    use sha2::Digest;
    let normalized = raw_guid.trim().to_lowercase();
    if normalized.is_empty() {
        return String::new();
    }
    let digest = sha2::Sha256::digest(format!("{MACHINE_FP_DOMAIN}{normalized}").as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// This machine's fingerprint, or `""` when it cannot be read. Windows hashes its MachineGuid;
/// Android hashes its `Settings.Secure.ANDROID_ID`; every other platform is `""`.
#[cfg(not(target_os = "android"))]
pub fn current_machine_fp() -> String {
    read_machine_guid()
        .map(|guid| machine_fp_from_guid(&guid))
        .unwrap_or_default()
}

#[cfg(target_os = "android")]
pub fn current_machine_fp() -> String {
    read_android_id()
        .map(|android_id| android_fp_from_android_id(&android_id))
        .unwrap_or_default()
}

/// Domain separation for a phone's fingerprint, so a phone and a computer can never share one.
const ANDROID_FP_DOMAIN: &str = "froozerp:android:";
/// Domain separation for the device id a phone derives from its fingerprint.
const STABLE_DEVICE_ID_DOMAIN: &str = "froozerp:device-id:";
/// The value a buggy batch of Android 2.2 builds returned for every device. Treated as unknown.
const SHARED_ANDROID_ID: &str = "9774d56d682e549c";

/// `sha256_hex("froozerp:android:" + lowercase(trim(android_id)))`, or `""` for an empty or
/// known-shared ANDROID_ID. The raw ANDROID_ID never leaves this module.
pub fn android_fp_from_android_id(raw_android_id: &str) -> String {
    use sha2::Digest;
    let normalized = raw_android_id.trim().to_lowercase();
    if normalized.is_empty() || normalized == SHARED_ANDROID_ID {
        return String::new();
    }
    let digest = sha2::Sha256::digest(format!("{ANDROID_FP_DOMAIN}{normalized}").as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A phone has no `%ProgramData%` that survives an uninstall, so it cannot keep an anchor file.
/// What it does keep is ANDROID_ID, which Android holds per device, user and app-signing key and
/// which survives an uninstall and reinstall. A phone with no identity row therefore derives its
/// device id from its fingerprint: the same phone, reinstalled, comes back as the same device.
///
/// `FZDEV-` + the first 16 bytes of `sha256("froozerp:device-id:" + machine_fp)` in the upper-case
/// GUID shape every other device id has. `None` off Android or without a fingerprint, where a
/// random id (and, on Windows, the anchor) applies instead.
pub fn stable_device_id(machine_fp: &str, is_android: bool) -> Option<String> {
    use sha2::Digest;
    let fp = machine_fp.trim();
    if !is_android || fp.len() != 64 || !fp.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let digest = sha2::Sha256::digest(format!("{STABLE_DEVICE_ID_DOMAIN}{}", fp.to_lowercase()).as_bytes());
    let hex: String = digest[..16].iter().map(|byte| format!("{byte:02X}")).collect();
    Some(format!(
        "FZDEV-{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

/// `Settings.Secure.getString(context.getContentResolver(), "android_id")` through JNI, on the
/// calling thread. `None` on any failure; a pending Java exception is cleared, never left behind.
#[cfg(target_os = "android")]
fn read_android_id() -> Option<String> {
    use jni::objects::{JObject, JString, JValue};
    let context = tao::platform::android::prelude::main_android_context()?;
    let vm = unsafe { jni::JavaVM::from_raw(context.java_vm.cast()) }.ok()?;
    let mut env = vm.attach_current_thread().ok()?;
    let activity = unsafe { JObject::from_raw(context.context_jobject.cast()) };
    let read = |env: &mut jni::JNIEnv| -> Option<String> {
        let resolver = env
            .call_method(&activity, "getContentResolver", "()Landroid/content/ContentResolver;", &[])
            .ok()?
            .l()
            .ok()?;
        let key = env.new_string("android_id").ok()?;
        let value = env
            .call_static_method(
                "android/provider/Settings$Secure",
                "getString",
                "(Landroid/content/ContentResolver;Ljava/lang/String;)Ljava/lang/String;",
                &[JValue::Object(&resolver), JValue::Object(&key)],
            )
            .ok()?
            .l()
            .ok()?;
        if value.is_null() {
            return None;
        }
        let value = JString::from(value);
        let text: String = env.get_string(&value).ok()?.into();
        let text = text.trim().to_string();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    };
    let result = read(&mut env);
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_clear();
    }
    result
}

/// `HKLM\SOFTWARE\Microsoft\Cryptography` value `MachineGuid` (REG_SZ), read from the 64-bit view
/// even by a 32-bit process. `None` on any failure.
#[cfg(windows)]
fn read_machine_guid() -> Option<String> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6464KEY,
    };

    let subkey: Vec<u16> = "SOFTWARE\\Microsoft\\Cryptography"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let value_name: Vec<u16> = "MachineGuid".encode_utf16().chain(std::iter::once(0)).collect();

    // A GUID is 36 characters; 128 UTF-16 units is ample room for it and its terminator. A value
    // that does not fit is not a GUID, and ERROR_MORE_DATA simply reads as "unknown".
    let read = |flags: u32| -> Option<String> {
        let mut buffer = [0u16; 128];
        let mut size_bytes: u32 = (buffer.len() * std::mem::size_of::<u16>()) as u32;
        // SAFETY: both name buffers are NUL-terminated and outlive the call; `buffer` is writable
        // for exactly `size_bytes` bytes, and RegGetValueW writes no more than that. The value type
        // is not requested (null `pdwtype`), which the API allows.
        let status = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                subkey.as_ptr(),
                value_name.as_ptr(),
                flags,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut size_bytes,
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        let units = (size_bytes as usize / std::mem::size_of::<u16>()).min(buffer.len());
        let end = buffer[..units].iter().position(|unit| *unit == 0).unwrap_or(units);
        let text = String::from_utf16(&buffer[..end]).ok()?;
        let text = text.trim().to_string();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    };

    // RRF_SUBKEY_WOW6464KEY is what keeps a 32-bit build from reading the (absent) WOW6432Node
    // copy. Should an old Windows refuse the flag, the plain read is the shipped 64-bit build's
    // native view anyway.
    read(RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY).or_else(|| read(RRF_RT_REG_SZ))
}

#[cfg(not(any(windows, target_os = "android")))]
fn read_machine_guid() -> Option<String> {
    None
}

/// Where this machine's anchor lives right now, honouring the disposable/test override.
pub fn device_anchor_path() -> Option<PathBuf> {
    resolve_device_anchor_path(
        std::env::var("NODE_ENV").ok().as_deref(),
        std::env::var_os("FROOZERP_ISOLATED_SQLITE_DIR").map(PathBuf::from),
        std::env::var_os("ProgramData").map(PathBuf::from),
        cfg!(windows),
    )
}

/// The pure rule behind `device_anchor_path`.
///
/// 1. `NODE_ENV=test` + an absolute isolated directory → `<isolated>\device-anchor.json`, on every
///    platform. Same rule as `local_db::resolve_app_data_dir`, so a disposable profile and its
///    anchor live and die together.
/// 2. Windows → `%ProgramData%\FroozERP\device-anchor.json`, falling back to `C:\ProgramData`.
/// 3. Anything else → no anchor; phones and the non-shipped desktop builds keep today's behaviour.
fn resolve_device_anchor_path(
    node_env: Option<&str>,
    isolated_dir: Option<PathBuf>,
    program_data: Option<PathBuf>,
    is_windows: bool,
) -> Option<PathBuf> {
    if node_env == Some("test") {
        if let Some(dir) = isolated_dir.filter(|dir| dir.is_absolute()) {
            return Some(dir.join(DEVICE_ANCHOR_FILE));
        }
    }
    if !is_windows {
        return None;
    }
    let base = program_data
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or_else(|| PathBuf::from(DEFAULT_PROGRAM_DATA));
    Some(base.join("FroozERP").join(DEVICE_ANCHOR_FILE))
}

/// A device id this module will put into, or take out of, an anchor.
///
/// `FZDEV-` followed by ASCII letters, digits and hyphens, at most 128 characters. That covers the
/// Windows `CoCreateGuid` shape, the v4-UUID shape and the browser's `FZDEV-<time>-<hex>` fallback,
/// and refuses `default`, an empty string, whitespace, and anything that could be a path or markup.
pub fn is_well_formed_device_id(device_id: &str) -> bool {
    let Some(rest) = device_id.strip_prefix("FZDEV-") else {
        return false;
    };
    !rest.is_empty()
        && device_id.len() <= 128
        && rest.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
}

/// The contents of a valid anchor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceAnchor {
    pub device_id: String,
    pub machine_fp: String,
}

/// What reading the anchor found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AnchorRead {
    /// No anchor file.
    Missing,
    /// The file exists but could not be read (permissions, a locked file). Never overwritten:
    /// whatever is in it may well be valid.
    Unreadable(String),
    /// The file was read but is not a version-1 anchor with a well-formed id and fingerprint.
    /// Useless to every reader, so it may be replaced.
    Invalid(String),
    /// A well-formed anchor.
    Present(DeviceAnchor),
}

pub fn read_anchor(path: &Path) -> AnchorRead {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return AnchorRead::Missing,
        Err(error) => return AnchorRead::Unreadable(error.to_string()),
    };
    parse_anchor(&text)
}

fn parse_anchor(text: &str) -> AnchorRead {
    let value: serde_json::Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(error) => return AnchorRead::Invalid(format!("not JSON: {error}")),
    };
    if value.get("version").and_then(serde_json::Value::as_u64) != Some(DEVICE_ANCHOR_VERSION) {
        return AnchorRead::Invalid("unsupported anchor version".to_string());
    }
    let device_id = value
        .get("device_id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    if !is_well_formed_device_id(&device_id) {
        return AnchorRead::Invalid("anchor device_id is not a well-formed FZDEV id".to_string());
    }
    let machine_fp = value
        .get("machine_fp")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    if machine_fp.len() != 64 || !machine_fp.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return AnchorRead::Invalid("anchor machine_fp is not a SHA-256 hex digest".to_string());
    }
    AnchorRead::Present(DeviceAnchor {
        device_id,
        machine_fp: machine_fp.to_ascii_lowercase(),
    })
}

/// Write the anchor atomically: a temporary file in the same directory, flushed, then renamed over
/// the target. A reader sees either the old file, no file, or the whole new one — never half.
pub fn write_anchor(path: &Path, anchor: &DeviceAnchor) -> Result<(), String> {
    if !is_well_formed_device_id(&anchor.device_id) || anchor.machine_fp.is_empty() {
        return Err("refusing to write an anchor without a well-formed id and a fingerprint".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "device anchor path has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let body = serde_json::json!({
        "version": DEVICE_ANCHOR_VERSION,
        "device_id": anchor.device_id,
        "machine_fp": anchor.machine_fp,
    })
    .to_string();
    let temp_path = parent.join(format!(
        "{DEVICE_ANCHOR_FILE}.{}.tmp",
        std::process::id()
    ));
    let written = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&temp_path)?;
        file.write_all(body.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp_path, path)
    })();
    if let Err(error) = written {
        let _ = fs::remove_file(&temp_path);
        return Err(error.to_string());
    }
    Ok(())
}

/// The id a profile with **no** identity row should use, given the anchor.
///
/// `Some(id)` only when the anchor is well-formed and was written under this very machine's
/// (non-empty) fingerprint. Everything else — no fingerprint, no anchor, an unreadable or invalid
/// one, one from another computer — is `None`, and the caller mints as it always has.
pub fn reusable_anchor_device_id(machine_fp: &str, anchor: &AnchorRead) -> Option<String> {
    if machine_fp.is_empty() {
        return None;
    }
    match anchor {
        AnchorRead::Present(found) if found.machine_fp == machine_fp => Some(found.device_id.clone()),
        _ => None,
    }
}

/// Why an anchor was, or was not, (re)written. Returned for logging and for tests.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AnchorOutcome {
    /// Nothing to do: no anchor path or no fingerprint on this machine.
    NotApplicable,
    /// The anchor already names this id.
    AlreadyCurrent,
    /// The anchor was written with this id.
    Written,
    /// An anchor naming something else was left as it was (another Windows user, an older install,
    /// or a file that could not be read).
    LeftAlone(String),
    /// The id is not one an anchor may hold.
    NotWellFormed,
    /// Writing failed; logged and ignored.
    WriteFailed(String),
}

/// When an anchor may be (over)written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AnchorWritePolicy {
    /// Only when there is no anchor at all, or the one there is useless (invalid). Used for an
    /// existing identity (back-fill) and for a frontend-preferred id.
    IfMissingOrInvalid,
    /// Also over a well-formed anchor written under a different fingerprint — a `ProgramData`
    /// folder that came from another computer. Used only when this machine just minted its id
    /// because no anchor for *this* machine existed.
    ReplaceForeignMachine,
}

/// Record `device_id` as this machine's id, within the limits of `policy`. Never fails: every
/// problem is reported in the outcome and logged by the caller.
pub fn settle_anchor(
    machine: &MachineContext,
    device_id: &str,
    policy: AnchorWritePolicy,
) -> AnchorOutcome {
    let Some(path) = machine.anchor_path.as_deref() else {
        return AnchorOutcome::NotApplicable;
    };
    if machine.machine_fp.is_empty() {
        return AnchorOutcome::NotApplicable;
    }
    if !is_well_formed_device_id(device_id) {
        return AnchorOutcome::NotWellFormed;
    }
    let current = read_anchor(path);
    let may_write = match &current {
        AnchorRead::Missing | AnchorRead::Invalid(_) => true,
        AnchorRead::Unreadable(error) => {
            return AnchorOutcome::LeftAlone(format!("anchor unreadable: {error}"));
        }
        AnchorRead::Present(found) => {
            if found.device_id == device_id {
                return AnchorOutcome::AlreadyCurrent;
            }
            policy == AnchorWritePolicy::ReplaceForeignMachine && found.machine_fp != machine.machine_fp
        }
    };
    if !may_write {
        return AnchorOutcome::LeftAlone("anchor names a different device id".to_string());
    }
    match write_anchor(
        path,
        &DeviceAnchor {
            device_id: device_id.to_string(),
            machine_fp: machine.machine_fp.clone(),
        },
    ) {
        Ok(()) => AnchorOutcome::Written,
        Err(error) => AnchorOutcome::WriteFailed(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_phone_fingerprint_is_a_domain_separated_hash_and_never_the_raw_android_id() {
        let fp = android_fp_from_android_id(" 1A2B3C4D5E6F7A8B ");
        assert_eq!(fp.len(), 64);
        assert!(fp.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
        assert_eq!(fp, android_fp_from_android_id("1a2b3c4d5e6f7a8b"));
        assert!(!fp.contains("1a2b3c4d5e6f7a8b"));
        assert_ne!(fp, machine_fp_from_guid("1a2b3c4d5e6f7a8b"), "a phone and a computer never share one");
        assert_eq!(android_fp_from_android_id(""), "");
        assert_eq!(android_fp_from_android_id("9774D56D682E549C"), "", "the shared emulator-bug value is unknown");
    }

    #[test]
    fn a_reinstalled_phone_derives_the_same_device_id_and_a_computer_derives_none() {
        let fp = android_fp_from_android_id("1a2b3c4d5e6f7a8b");
        let first = stable_device_id(&fp, true).expect("a phone with a fingerprint has a stable id");
        assert_eq!(Some(first.clone()), stable_device_id(&fp, true));
        assert_eq!(Some(first.clone()), stable_device_id(&fp.to_uppercase(), true));
        assert!(is_well_formed_device_id(&first));
        let shape: Vec<usize> = first.trim_start_matches("FZDEV-").split('-').map(str::len).collect();
        assert_eq!(shape, vec![8, 4, 4, 4, 12]);
        assert_ne!(Some(first), stable_device_id(&android_fp_from_android_id("ffff0000ffff0000"), true));
        assert_eq!(stable_device_id(&fp, false), None, "a computer keeps its random id and anchor");
        assert_eq!(stable_device_id("", true), None);
        assert_eq!(stable_device_id("not-a-fingerprint", true), None);
    }

    fn temp_anchor(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir()
            .join(format!("froozerp-anchor-{label}-{}-{nanos}", std::process::id()))
            .join(DEVICE_ANCHOR_FILE)
    }

    fn machine(fp: &str, path: &Path) -> MachineContext {
        MachineContext {
            machine_fp: fp.to_string(),
            anchor_path: Some(path.to_path_buf()),
        }
    }

    const FP_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const FP_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const ID_1: &str = "FZDEV-11111111-1111-1111-1111-111111111111";
    const ID_2: &str = "FZDEV-22222222-2222-2222-2222-222222222222";

    #[test]
    fn the_fingerprint_is_a_domain_separated_hash_of_the_normalised_guid() {
        let fp = machine_fp_from_guid("  8B1C2D3E-AAAA-BBBB-CCCC-0123456789AB \n");
        assert_eq!(fp.len(), 64);
        assert!(fp.chars().all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase()));
        assert_eq!(fp, machine_fp_from_guid("8b1c2d3e-aaaa-bbbb-cccc-0123456789ab"));
        // Never the raw GUID, and not a bare hash of it either.
        assert!(!fp.contains("8b1c2d3e"));
        use sha2::Digest;
        let bare: String = sha2::Sha256::digest(b"8b1c2d3e-aaaa-bbbb-cccc-0123456789ab")
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_ne!(fp, bare);
        assert_eq!(machine_fp_from_guid("   "), "");
    }

    #[test]
    fn well_formed_ids_are_fzdev_ids_and_nothing_else() {
        assert!(is_well_formed_device_id(ID_1));
        assert!(is_well_formed_device_id("FZDEV-1727000000000-ab12cd34ef56"));
        for bad in ["", "default", "FZDEV-", "fzdev-1234", " FZDEV-1", "FZDEV-1 ", "FZDEV-..\\x", "device-a"] {
            assert!(!is_well_formed_device_id(bad), "{bad:?} must be refused");
        }
        assert!(!is_well_formed_device_id(&format!("FZDEV-{}", "A".repeat(200))));
    }

    #[test]
    fn the_anchor_lives_in_program_data_or_inside_an_isolated_profile() {
        let isolated = std::env::temp_dir().join("froozerp-isolated");
        assert_eq!(
            resolve_device_anchor_path(Some("test"), Some(isolated.clone()), None, true),
            Some(isolated.join(DEVICE_ANCHOR_FILE)),
            "a disposable profile must never reach the real machine's anchor"
        );
        assert_eq!(
            resolve_device_anchor_path(Some("test"), Some(isolated.clone()), None, false),
            Some(isolated.join(DEVICE_ANCHOR_FILE))
        );
        // The isolated dir only counts under NODE_ENV=test, exactly like the database path.
        assert_eq!(
            resolve_device_anchor_path(None, Some(isolated), Some(PathBuf::from("D:\\PD")), true),
            Some(PathBuf::from("D:\\PD").join("FroozERP").join(DEVICE_ANCHOR_FILE))
        );
        assert_eq!(
            resolve_device_anchor_path(None, None, None, true),
            Some(PathBuf::from(DEFAULT_PROGRAM_DATA).join("FroozERP").join(DEVICE_ANCHOR_FILE))
        );
        assert_eq!(
            resolve_device_anchor_path(None, None, Some(PathBuf::new()), true),
            Some(PathBuf::from(DEFAULT_PROGRAM_DATA).join("FroozERP").join(DEVICE_ANCHOR_FILE))
        );
        assert_eq!(resolve_device_anchor_path(None, None, Some(PathBuf::from("/pd")), false), None);
    }

    #[test]
    fn an_anchor_round_trips_and_only_a_matching_machine_reuses_it() {
        let path = temp_anchor("round-trip");
        assert_eq!(read_anchor(&path), AnchorRead::Missing);
        write_anchor(&path, &DeviceAnchor { device_id: ID_1.to_string(), machine_fp: FP_A.to_string() })
            .expect("write anchor");
        let read = read_anchor(&path);
        assert_eq!(
            read,
            AnchorRead::Present(DeviceAnchor { device_id: ID_1.to_string(), machine_fp: FP_A.to_string() })
        );
        assert_eq!(reusable_anchor_device_id(FP_A, &read), Some(ID_1.to_string()));
        assert_eq!(reusable_anchor_device_id(FP_B, &read), None, "another computer's anchor");
        assert_eq!(reusable_anchor_device_id("", &read), None, "an unknown machine reuses nothing");
        // No temp file is left behind.
        let leftovers = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_damaged_anchor_is_invalid_and_never_reused() {
        for text in [
            "not json",
            "{}",
            r#"{"version":2,"device_id":"FZDEV-1","machine_fp":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#,
            r#"{"version":1,"device_id":"default","machine_fp":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#,
            r#"{"version":1,"device_id":"FZDEV-1","machine_fp":""}"#,
            r#"{"version":1,"device_id":"FZDEV-1","machine_fp":"xyz"}"#,
        ] {
            let read = parse_anchor(text);
            assert!(matches!(read, AnchorRead::Invalid(_)), "{text} must be invalid, got {read:?}");
            assert_eq!(reusable_anchor_device_id(FP_A, &read), None);
        }
    }

    #[test]
    fn settling_backfills_a_missing_anchor_but_never_overwrites_another_id() {
        let path = temp_anchor("settle");
        let here = machine(FP_A, &path);

        assert_eq!(settle_anchor(&here, ID_1, AnchorWritePolicy::IfMissingOrInvalid), AnchorOutcome::Written);
        assert_eq!(settle_anchor(&here, ID_1, AnchorWritePolicy::IfMissingOrInvalid), AnchorOutcome::AlreadyCurrent);
        // Another Windows user / an older install with its own id: both are left alone.
        assert!(matches!(
            settle_anchor(&here, ID_2, AnchorWritePolicy::IfMissingOrInvalid),
            AnchorOutcome::LeftAlone(_)
        ));
        // Even a fresh mint does not replace an anchor written under this same machine.
        assert!(matches!(
            settle_anchor(&here, ID_2, AnchorWritePolicy::ReplaceForeignMachine),
            AnchorOutcome::LeftAlone(_)
        ));
        assert_eq!(reusable_anchor_device_id(FP_A, &read_anchor(&path)), Some(ID_1.to_string()));

        // A ProgramData folder copied from another computer is replaced only by a fresh mint.
        let elsewhere = machine(FP_B, &path);
        assert!(matches!(
            settle_anchor(&elsewhere, ID_2, AnchorWritePolicy::IfMissingOrInvalid),
            AnchorOutcome::LeftAlone(_)
        ));
        assert_eq!(settle_anchor(&elsewhere, ID_2, AnchorWritePolicy::ReplaceForeignMachine), AnchorOutcome::Written);
        assert_eq!(reusable_anchor_device_id(FP_B, &read_anchor(&path)), Some(ID_2.to_string()));

        // A corrupt anchor is repaired.
        fs::write(&path, "garbage").unwrap();
        assert_eq!(settle_anchor(&here, ID_1, AnchorWritePolicy::IfMissingOrInvalid), AnchorOutcome::Written);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn settling_does_nothing_without_a_fingerprint_a_path_or_a_well_formed_id() {
        let path = temp_anchor("inert");
        assert_eq!(
            settle_anchor(&MachineContext::none(), ID_1, AnchorWritePolicy::IfMissingOrInvalid),
            AnchorOutcome::NotApplicable
        );
        assert_eq!(
            settle_anchor(&machine("", &path), ID_1, AnchorWritePolicy::IfMissingOrInvalid),
            AnchorOutcome::NotApplicable
        );
        assert_eq!(
            settle_anchor(&machine(FP_A, &path), "webview-generated-device", AnchorWritePolicy::IfMissingOrInvalid),
            AnchorOutcome::NotWellFormed
        );
        assert_eq!(read_anchor(&path), AnchorRead::Missing);
    }
}
