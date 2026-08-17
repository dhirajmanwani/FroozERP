//! FroozERP offline-activation signing CLI — **maintainer-local tool, never shipped.**
//!
//! Stage 3 of `docs/offline-activation-plan.md`. Mints the signed artefacts that
//! `src-tauri/src/entitlement.rs` verifies: the `.lic` file (design §7.2, D-8) and, for tests,
//! the raw payload/signature byte pair.
//!
//! ## Why this file lives in `src-tauri/tools/` and not `src-tauri/src/bin/`
//!
//! Tauri's CLI enumerates **every** binary target of the package and hands the non-main ones to
//! the bundler, which copies them into the installer:
//!
//! * `tauri-cli-2.11.2/src/interface/rust.rs:934-1021` (`get_binaries`) walks `[[bin]]` entries
//!   *and* scans the `src/bin` directory, marking everything that is not `default-run` as a
//!   non-main `BundleBinary`.
//! * `tauri-bundler-2.9.2/src/bundle/windows/nsis/mod.rs:828-839` (`generate_binaries_data`)
//!   packages every `!bin.main()` binary into the NSIS installer.
//!
//! `default-run` only decides which binary is *main*; it does not exclude the others. Two things
//! keep this tool out of the bundle, and both are required:
//!
//! 1. **`required-features = ["signing-cli"]`** on the `[[bin]]` target. `get_binaries` skips a
//!    declared bin whose required features are absent from the features passed on the tauri/cargo
//!    command line (`rust.rs:944-952`). Cargo's own default features are *not* part of that list,
//!    so the bin is skipped by the bundler even though `cargo build` builds it.
//! 2. **The source is outside `src/bin/`.** The directory scan at `rust.rs:963-1001` re-adds any
//!    file found under `src/bin` that is not already in the binary list — which is exactly what a
//!    `required-features` skip produces. Left in `src/bin`, the tool would either be bundled
//!    anyway or (with the feature off) make the bundler look for a binary cargo never built.
//!
//! ## Key material
//!
//! The private key is **read from a file path given on the command line**. It is never embedded,
//! never generated here, and never written anywhere by this tool (design §3.3: "never ships,
//! never enters the repo, never enters Railway, never enters CI"). The fixtures under
//! `src-tauri/fixtures/activation/` are signed with deliberately-public throwaway keys whose
//! seeds are literal ASCII strings saying so.
//!
//! ## Usage
//!
//! ```text
//! sign_activation sign   --key <path> --device-id <id> [options]
//! sign_activation pubkey --key <path>
//! sign_activation help
//! ```
//!
//! Run `sign_activation help` for the full option list.

use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs;
use std::path::PathBuf;

// ---------------------------------------------------------------------------------------------
// Payload layout — an independent implementation of design §4.
//
// This encoder is deliberately NOT shared with `entitlement.rs`. `entitlement.rs` is the decoder
// and the contract; if the two ever disagree, the round-trip tests in
// `src-tauri/tests/activation_roundtrip.rs` fail. Sharing the codec would make those tests
// tautological.
// ---------------------------------------------------------------------------------------------

const FORMAT_VERSION: u8 = 1;
const FLAG_CARRIES_CREDENTIAL: u8 = 0b0000_0001;
const DEVICE_BINDING_LEN: usize = 8;
const OWNER_SALT_LEN: usize = 16;
const OWNER_VERIFIER_LEN: usize = 32;
const MAX_OWNER_USERNAME_LEN: usize = 24;
const SIGNATURE_LEN: usize = 64;
const GRACE_DAYS: i64 = 60;
const DEFAULT_VALID_DAYS: u16 = 365;
const DEFAULT_BOOTSTRAP_VALID_DAYS: u16 = 7;

/// `1970-01-01` → `2020-01-01`, the `DAY_EPOCH` all day-stamps in the payload are relative to.
const DAY_EPOCH_FROM_UNIX: i64 = 18262;

/// Container-format tag written into the `.lic` file. Independent of the payload's
/// `format_version`: this versions the text envelope, that versions the signed bytes.
const LIC_CONTAINER_FORMAT: &str = "FRZ-LIC/1";

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

#[derive(Debug)]
struct CliError(String);

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

fn err<T>(msg: impl Into<String>) -> Result<T, CliError> {
    Err(CliError(msg.into()))
}

type R<T> = Result<T, CliError>;

// ---------------------------------------------------------------------------------------------
// Small helpers: hex, base64, civil dates. No extra crates — the dependency surface of a tool
// that touches private keys is worth keeping at zero.
// ---------------------------------------------------------------------------------------------

fn hex_decode(text: &str) -> R<Vec<u8>> {
    let clean: Vec<u8> = text
        .bytes()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
    if clean.len() % 2 != 0 {
        return err("hex input has an odd number of digits");
    }
    let mut out = Vec::with_capacity(clean.len() / 2);
    for pair in clean.chunks(2) {
        let hi = hex_nibble(pair[0])?;
        let lo = hex_nibble(pair[1])?;
        out.push((hi << 4) | lo);
    }
    Ok(out)
}

fn hex_nibble(b: u8) -> R<u8> {
    match b {
        b'0'..=b'9' => Ok(b - b'0'),
        b'a'..=b'f' => Ok(b - b'a' + 10),
        b'A'..=b'F' => Ok(b - b'A' + 10),
        other => err(format!("'{}' is not a hex digit", other as char)),
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[usize::from(b >> 4)] as char);
        out.push(DIGITS[usize::from(b & 0x0F)] as char);
    }
    out
}

const B64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding (RFC 4648 §4). Padded so a truncated line is detectable.
fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = chunk.get(1).copied().map(u32::from).unwrap_or(0);
        let b2 = chunk.get(2).copied().map(u32::from).unwrap_or(0);
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64_ALPHABET[((n >> 18) & 0x3F) as usize] as char);
        out.push(B64_ALPHABET[((n >> 12) & 0x3F) as usize] as char);
        out.push(if chunk.len() > 1 {
            B64_ALPHABET[((n >> 6) & 0x3F) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64_ALPHABET[(n & 0x3F) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// Days since 1970-01-01 for a proleptic-Gregorian civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Inverse of [`days_from_civil`].
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// A payload day-stamp rendered as an ISO date, for the human header of the `.lic` file.
fn day_to_iso(day: i64) -> String {
    let (y, m, d) = civil_from_days(DAY_EPOCH_FROM_UNIX + day);
    format!("{y:04}-{m:02}-{d:02}")
}

fn iso_to_day(text: &str) -> R<i64> {
    let parts: Vec<&str> = text.split('-').collect();
    if parts.len() != 3 {
        return err(format!("'{text}' is not a YYYY-MM-DD date"));
    }
    let y: i64 = parts[0]
        .parse()
        .map_err(|_| CliError(format!("'{text}': bad year")))?;
    let m: i64 = parts[1]
        .parse()
        .map_err(|_| CliError(format!("'{text}': bad month")))?;
    let d: i64 = parts[2]
        .parse()
        .map_err(|_| CliError(format!("'{text}': bad day")))?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return err(format!("'{text}' is not a calendar date"));
    }
    Ok(days_from_civil(y, m, d) - DAY_EPOCH_FROM_UNIX)
}

fn today_day() -> R<i64> {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| CliError("system clock is before 1970".into()))?
        .as_secs() as i64;
    Ok(secs / 86_400 - DAY_EPOCH_FROM_UNIX)
}

/// Truncated SHA-256 of the device identity string (§4, D-10). Mirrors
/// `entitlement::device_binding_hash`; deliberately re-implemented so the tests compare two
/// implementations rather than one.
fn device_binding_hash(device_id: &str) -> [u8; DEVICE_BINDING_LEN] {
    let digest = Sha256::digest(device_id.as_bytes());
    let mut out = [0u8; DEVICE_BINDING_LEN];
    out.copy_from_slice(&digest[..DEVICE_BINDING_LEN]);
    out
}

/// LEB128 unsigned varint, matching `entitlement::Reader::varint`.
fn put_varint(out: &mut Vec<u8>, mut value: u64) {
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

// ---------------------------------------------------------------------------------------------
// Key loading
// ---------------------------------------------------------------------------------------------

/// Load a 32-byte Ed25519 seed from a file: either 64 hex digits (whitespace ignored) or exactly
/// 32 raw bytes.
///
/// Nothing here generates a key. `docs/offline-activation-design.md` §3.3 puts key generation and
/// custody on the maintainer's own machine; see `fixtures/activation/README.md` for the
/// `openssl rand`/PowerShell one-liners.
fn load_signing_key(path: &PathBuf) -> R<SigningKey> {
    let raw = fs::read(path)
        .map_err(|e| CliError(format!("cannot read key file {}: {e}", path.display())))?;

    let as_text = String::from_utf8(raw.clone()).ok();
    let seed: Vec<u8> = match as_text {
        Some(text)
            if text.bytes().filter(|b| !b.is_ascii_whitespace()).count() == 64
                && text
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() || b.is_ascii_whitespace()) =>
        {
            hex_decode(&text)?
        }
        _ if raw.len() == 32 => raw,
        _ => {
            return err(format!(
                "key file {} must contain either 64 hex digits or exactly 32 raw bytes (found {} bytes)",
                path.display(),
                raw.len()
            ))
        }
    };

    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(&seed);
    Ok(SigningKey::from_bytes(&bytes))
}

// ---------------------------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------------------------

struct Args {
    values: Vec<(String, String)>,
}

impl Args {
    fn parse(raw: &[String]) -> R<Args> {
        let mut values = Vec::new();
        let mut i = 0;
        while i < raw.len() {
            let token = &raw[i];
            if !token.starts_with("--") {
                return err(format!("unexpected argument '{token}' (options start with --)"));
            }
            if let Some((name, value)) = token[2..].split_once('=') {
                values.push((name.to_string(), value.to_string()));
                i += 1;
            } else {
                let name = token[2..].to_string();
                let value = raw
                    .get(i + 1)
                    .ok_or_else(|| CliError(format!("--{name} needs a value")))?;
                if value.starts_with("--") {
                    return err(format!("--{name} needs a value"));
                }
                values.push((name, value.clone()));
                i += 2;
            }
        }
        Ok(Args { values })
    }

    fn opt(&self, name: &str) -> Option<&str> {
        self.values
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    fn req(&self, name: &str) -> R<&str> {
        self.opt(name)
            .ok_or_else(|| CliError(format!("--{name} is required")))
    }

    fn num<T: std::str::FromStr>(&self, name: &str, default: T) -> R<T> {
        match self.opt(name) {
            None => Ok(default),
            Some(text) => text
                .parse()
                .map_err(|_| CliError(format!("--{name}: '{text}' is not a valid number"))),
        }
    }

    /// Reject typos rather than silently ignoring them — a mistyped `--valid-days` on a real
    /// entitlement would silently mint a 365-day code when 30 was meant.
    fn reject_unknown(&self, known: &[&str]) -> R<()> {
        for (k, _) in &self.values {
            if !known.contains(&k.as_str()) {
                return err(format!("unknown option --{k}"));
            }
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// sign
// ---------------------------------------------------------------------------------------------

const SIGN_OPTIONS: &[&str] = &[
    "key",
    "key-id",
    "company",
    "branch",
    "device-id",
    "serial",
    "issued-at",
    "issued-at-day",
    "valid-days",
    "format-version",
    "bootstrap-username",
    "bootstrap-salt-hex",
    "bootstrap-verifier-hex",
    "bootstrap-valid-days",
    "truncate-signature",
    "company-name",
    "branch-name",
    "out",
    "out-payload",
    "out-sig",
];

struct Bootstrap {
    username: String,
    salt: [u8; OWNER_SALT_LEN],
    verifier: [u8; OWNER_VERIFIER_LEN],
    valid_days: u16,
}

fn cmd_sign(args: &Args) -> R<()> {
    args.reject_unknown(SIGN_OPTIONS)?;

    let key_path = PathBuf::from(args.req("key")?);
    let signing_key = load_signing_key(&key_path)?;

    let key_id: u8 = args.num("key-id", 1u8)?;
    let company_id: u64 = args.num("company", 1u64)?;
    let branch_id: u64 = args.num("branch", 1u64)?;
    let device_id = args.req("device-id")?.to_string();
    let serial: u32 = args.num("serial", 1u32)?;
    let valid_days: u16 = args.num("valid-days", DEFAULT_VALID_DAYS)?;
    let format_version: u8 = args.num("format-version", FORMAT_VERSION)?;

    if device_id.trim().is_empty() {
        return err("--device-id must not be empty");
    }

    let issued_day: i64 = match (args.opt("issued-at"), args.opt("issued-at-day")) {
        (Some(_), Some(_)) => return err("give either --issued-at or --issued-at-day, not both"),
        (Some(date), None) => iso_to_day(date)?,
        (None, Some(day)) => day
            .parse()
            .map_err(|_| CliError(format!("--issued-at-day: '{day}' is not a number")))?,
        (None, None) => today_day()?,
    };
    if !(0..=i64::from(u16::MAX)).contains(&issued_day) {
        return err(format!(
            "--issued-at resolves to day {issued_day}, outside the 2-byte field (0..=65535 days after 2020-01-01)"
        ));
    }
    let issued_at = issued_day as u16;

    // A bootstrap credential travels in the file format only (§8.1). The typed fallback stays at
    // the compact core payload.
    let bootstrap = match args.opt("bootstrap-username") {
        None => {
            for stray in [
                "bootstrap-salt-hex",
                "bootstrap-verifier-hex",
                "bootstrap-valid-days",
            ] {
                if args.opt(stray).is_some() {
                    return err(format!("--{stray} needs --bootstrap-username"));
                }
            }
            None
        }
        Some(username) => {
            if username.is_empty() || username.len() > MAX_OWNER_USERNAME_LEN {
                return err(format!(
                    "--bootstrap-username must be 1..={MAX_OWNER_USERNAME_LEN} bytes (found {})",
                    username.len()
                ));
            }
            let salt_hex = args.req("bootstrap-salt-hex")?;
            let verifier_hex = args.req("bootstrap-verifier-hex")?;
            let salt_bytes = hex_decode(salt_hex)?;
            let verifier_bytes = hex_decode(verifier_hex)?;
            if salt_bytes.len() != OWNER_SALT_LEN {
                return err(format!(
                    "--bootstrap-salt-hex must decode to {OWNER_SALT_LEN} bytes (found {})",
                    salt_bytes.len()
                ));
            }
            if verifier_bytes.len() != OWNER_VERIFIER_LEN {
                return err(format!(
                    "--bootstrap-verifier-hex must decode to {OWNER_VERIFIER_LEN} bytes (found {})",
                    verifier_bytes.len()
                ));
            }
            let mut salt = [0u8; OWNER_SALT_LEN];
            salt.copy_from_slice(&salt_bytes);
            let mut verifier = [0u8; OWNER_VERIFIER_LEN];
            verifier.copy_from_slice(&verifier_bytes);
            Some(Bootstrap {
                username: username.to_string(),
                salt,
                verifier,
                valid_days: args.num("bootstrap-valid-days", DEFAULT_BOOTSTRAP_VALID_DAYS)?,
            })
        }
    };

    let flags = if bootstrap.is_some() {
        FLAG_CARRIES_CREDENTIAL
    } else {
        0
    };

    // ---- payload (§4) ----
    let mut payload = Vec::new();
    payload.push(format_version);
    payload.push(key_id);
    payload.push(flags);
    put_varint(&mut payload, company_id);
    put_varint(&mut payload, branch_id);
    payload.extend_from_slice(&device_binding_hash(&device_id));
    payload.extend_from_slice(&serial.to_le_bytes());
    payload.extend_from_slice(&issued_at.to_le_bytes());
    payload.extend_from_slice(&valid_days.to_le_bytes());
    if let Some(b) = &bootstrap {
        payload.push(b.username.len() as u8);
        payload.extend_from_slice(b.username.as_bytes());
        payload.extend_from_slice(&b.salt);
        payload.extend_from_slice(&b.verifier);
        payload.extend_from_slice(&b.valid_days.to_le_bytes());
    }

    // ---- signature over the exact payload bytes (§3.4) ----
    let full_signature = signing_key.sign(&payload).to_bytes();
    let keep: usize = args.num("truncate-signature", SIGNATURE_LEN)?;
    if keep > SIGNATURE_LEN {
        return err(format!(
            "--truncate-signature must be 0..={SIGNATURE_LEN} (found {keep})"
        ));
    }
    let signature = &full_signature[..keep];
    if keep != SIGNATURE_LEN {
        eprintln!(
            "sign_activation: WARNING --truncate-signature {keep} produced a DELIBERATELY INVALID \
             artefact. This is a test fixture, not an activation code."
        );
    }

    // ---- .lic text (§7.2) ----
    let lic = render_lic(
        &LicHeader {
            company_id,
            company_name: args.opt("company-name").map(str::to_string),
            branch_id,
            branch_name: args.opt("branch-name").map(str::to_string),
            device_id: device_id.clone(),
            serial,
            key_id,
            issued_day,
            valid_days,
            bootstrap_username: bootstrap.as_ref().map(|b| b.username.clone()),
            bootstrap_valid_days: bootstrap.as_ref().map(|b| b.valid_days),
        },
        &payload,
        signature,
    );

    let mut wrote_anything = false;
    if let Some(path) = args.opt("out") {
        write_file(path, lic.as_bytes())?;
        wrote_anything = true;
    }
    if let Some(path) = args.opt("out-payload") {
        write_file(path, &payload)?;
        wrote_anything = true;
    }
    if let Some(path) = args.opt("out-sig") {
        write_file(path, signature)?;
        wrote_anything = true;
    }
    if !wrote_anything {
        print!("{lic}");
    }

    Ok(())
}

fn write_file(path: &str, bytes: &[u8]) -> R<()> {
    if let Some(parent) = std::path::Path::new(path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| CliError(format!("cannot create {}: {e}", parent.display())))?;
        }
    }
    fs::write(path, bytes).map_err(|e| CliError(format!("cannot write {path}: {e}")))
}

struct LicHeader {
    company_id: u64,
    company_name: Option<String>,
    branch_id: u64,
    branch_name: Option<String>,
    device_id: String,
    serial: u32,
    key_id: u8,
    issued_day: i64,
    valid_days: u16,
    bootstrap_username: Option<String>,
    bootstrap_valid_days: Option<u16>,
}

/// Render the `.lic` container (design §7.2).
///
/// Every `#` line is **unsigned support metadata**. A reader must take every fact it acts on from
/// the decoded payload, never from the header — the header exists so a maintainer reading the file
/// over the phone can tell which branch and which device it belongs to without tooling.
fn render_lic(h: &LicHeader, payload: &[u8], signature: &[u8]) -> String {
    let expires_day = h.issued_day + i64::from(h.valid_days);
    let mut out = String::new();
    out.push_str("# FroozERP activation file. '#' lines are UNSIGNED support metadata.\n");
    match &h.company_name {
        Some(name) => out.push_str(&format!("# company: {} ({})\n", name, h.company_id)),
        None => out.push_str(&format!("# company: {}\n", h.company_id)),
    }
    match &h.branch_name {
        Some(name) => out.push_str(&format!("# branch: {} ({})\n", name, h.branch_id)),
        None => out.push_str(&format!("# branch: {}\n", h.branch_id)),
    }
    out.push_str(&format!("# device: {}\n", h.device_id));
    out.push_str(&format!("# serial: {}\n", h.serial));
    out.push_str(&format!("# key-id: {}\n", h.key_id));
    out.push_str(&format!("# issued: {}\n", day_to_iso(h.issued_day)));
    out.push_str(&format!("# expires: {}\n", day_to_iso(expires_day)));
    out.push_str(&format!(
        "# grace-until: {}\n",
        day_to_iso(expires_day + GRACE_DAYS)
    ));
    if let (Some(name), Some(days)) = (&h.bootstrap_username, h.bootstrap_valid_days) {
        out.push_str(&format!(
            "# bootstrap-owner: {} (temporary, expires {})\n",
            name,
            day_to_iso(h.issued_day + i64::from(days))
        ));
    }
    out.push_str(&format!("format: {LIC_CONTAINER_FORMAT}\n"));
    out.push_str(&format!("payload: {}\n", base64_encode(payload)));
    out.push_str(&format!("signature: {}\n", base64_encode(signature)));
    out
}

// ---------------------------------------------------------------------------------------------
// pubkey
// ---------------------------------------------------------------------------------------------

fn cmd_pubkey(args: &Args) -> R<()> {
    args.reject_unknown(&["key", "key-id"])?;
    let signing_key = load_signing_key(&PathBuf::from(args.req("key")?))?;
    let public = signing_key.verifying_key().to_bytes();
    let key_id: u8 = args.num("key-id", 1u8)?;

    println!("{}", hex_encode(&public));
    eprintln!();
    eprintln!("Paste into TRUSTED_ACTIVATION_KEYS in src-tauri/src/entitlement.rs:");
    eprintln!();
    eprintln!("    (0x{key_id:02X}, [");
    for row in public.chunks(8) {
        let cells: Vec<String> = row.iter().map(|b| format!("0x{b:02X}")).collect();
        eprintln!("        {},", cells.join(", "));
    }
    eprintln!("    ]),");
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

const HELP: &str = r#"sign_activation — FroozERP offline-activation signing CLI (maintainer-local; not shipped)

USAGE
  sign_activation sign   --key <path> --device-id <id> [options]
  sign_activation pubkey --key <path> [--key-id <n>]
  sign_activation help

KEY FILE
  A 32-byte Ed25519 seed: either 64 hex digits (whitespace ignored) or 32 raw bytes.
  This tool never generates, prints or stores a private key. Per design §3.3 the root private
  key lives only on the maintainer's machine and must never enter the repo, Railway or CI.

sign OPTIONS
  --key <path>                  Ed25519 private key seed file                     (required)
  --device-id <string>          Device identity the code is bound to (D-9)        (required)
  --key-id <u8>                 Trusted-key slot written into the payload         [1]
  --company <u64>               company_id                                        [1]
  --branch <u64>                branch_id                                         [1]
  --serial <u32>                entitlement_serial                                [1]
  --valid-days <u16>            Validity in days (D-13 rules 365)                 [365]
  --issued-at <YYYY-MM-DD>      Issue date                                        [today, UTC]
  --issued-at-day <u16>         Issue date as days since 2020-01-01 (exclusive with --issued-at)
  --company-name <string>       Header comment only; NOT signed
  --branch-name <string>        Header comment only; NOT signed
  --out <path>                  Write the .lic file
  --out-payload <path>          Write the raw signed payload bytes
  --out-sig <path>              Write the raw detached signature bytes
                                (with none of the three, the .lic is printed to stdout)

BOOTSTRAP OWNER CREDENTIAL (§8.1, file delivery only)
  --bootstrap-username <s>      Owner username, 1..=24 bytes; sets the carries-credential flag
  --bootstrap-salt-hex <hex>    16 bytes                                          (required with it)
  --bootstrap-verifier-hex <hex> 32 bytes                                         (required with it)
  --bootstrap-valid-days <u16>  Days after issue the credential is honoured       [7]

  The salt and verifier are supplied, not derived: no KDF is specified anywhere in the design
  documents or in entitlement.rs yet, and inventing one here would pre-empt Stage 5, which owns
  the verification side. §8.2's recommendation that this tool auto-generate a high-entropy
  temporary password is deliberately NOT implemented for that reason.

FIXTURE GENERATION (produces deliberately invalid artefacts — never use for a real code)
  --format-version <u8>         Override the payload format_version               [1]
  --truncate-signature <n>      Emit only the first n signature bytes             [64]
"#;

fn real_main() -> R<()> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = argv.first() else {
        print!("{HELP}");
        return err("no command given");
    };
    let args = Args::parse(&argv[1..])?;
    match command.as_str() {
        "sign" => cmd_sign(&args),
        "pubkey" => cmd_pubkey(&args),
        "help" | "--help" | "-h" => {
            print!("{HELP}");
            Ok(())
        }
        other => {
            print!("{HELP}");
            err(format!("unknown command '{other}'"))
        }
    }
}

fn main() {
    if let Err(e) = real_main() {
        eprintln!("sign_activation: {e}");
        std::process::exit(2);
    }
}
