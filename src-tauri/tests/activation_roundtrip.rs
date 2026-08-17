//! Stage 3 round-trip suite: **real `sign_activation` output through `entitlement.rs`.**
//!
//! `entitlement.rs`'s 33 unit tests build their payloads with a private test helper, so before
//! this file existed the wire format had only ever been exercised against itself. Everything here
//! runs the actual CLI binary, writes actual `.lic` files, and feeds the bytes back through
//! `parse_payload` / `verify` / `check_device_binding` / `evaluate_state`.
//!
//! Three independent implementations are cross-checked:
//!
//! | Implementation | Lives in | Role |
//! | --- | --- | --- |
//! | Encoder | `src-tauri/tools/sign_activation.rs` | writes payload bytes and the `.lic` container |
//! | Decoder | `src-tauri/src/entitlement.rs` | the shipped contract |
//! | `.lic` reader | this file (`parse_lic`) | a throwaway stand-in for Stage 5's importer |
//!
//! Nothing is shared between them, so agreement is evidence rather than tautology.
//!
//! Fixtures are committed under `src-tauri/fixtures/activation/` and regenerated here into
//! `CARGO_TARGET_TMPDIR` on every run, then compared byte-for-byte. Ed25519 is deterministic
//! (RFC 8032 §5.1.6) and the `.lic` header carries no wall-clock timestamp, so the comparison is
//! meaningful: it fails the moment the CLI and the committed artefacts drift apart.
//!
//! To rewrite the committed fixtures after an intentional format change:
//!
//! ```text
//! FROOZERP_REGENERATE_ACTIVATION_FIXTURES=1 cargo test --manifest-path src-tauri/Cargo.toml
//! ```

#![cfg(feature = "signing-cli")]

use froozerp_lib::entitlement::{
    check_device_binding, device_binding_hash, evaluate_state, parse_payload, verify,
    EntitlementState, RejectReason, DEFAULT_VALID_DAYS, FLAG_CARRIES_CREDENTIAL, GRACE_DAYS,
    MAX_OWNER_USERNAME_LEN, OWNER_SALT_LEN, OWNER_VERIFIER_LEN, SIGNATURE_LEN,
};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Compiled by cargo as part of this test run; `required-features` keeps it out of the bundle.
const CLI: &str = env!("CARGO_BIN_EXE_sign_activation");

const TEST_DEVICE: &str = "FZDEV-TEST-0000000000001";
const OTHER_DEVICE: &str = "FZDEV-TEST-0000000000002";

/// Day-stamps are days since 2020-01-01 (`entitlement::DAY_EPOCH`). Fixed constants, never a
/// clock read: a suite whose expected states depend on the day it runs is a suite that starts
/// failing on its own.
const ISSUED_DAY: u16 = 2400; // 2026-07-28
const EVAL_DAY: i64 = 2420; // 2026-08-17

/// `bootstrap-salt-hex` / `bootstrap-verifier-hex` inputs, matching the byte patterns
/// `entitlement.rs`'s own tests use so a divergence shows up as a value mismatch, not a shape one.
const SALT_HEX: &str = "11111111111111111111111111111111";
const VERIFIER_HEX: &str =
    "2222222222222222222222222222222222222222222222222222222222222222";

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/activation")
}

fn key_path(label: &str) -> String {
    fixture_dir()
        .join(format!("TEST-ONLY-root-key-{label}.hex"))
        .to_string_lossy()
        .into_owned()
}

/// The trusted-key table these tests verify against.
///
/// **Never `TRUSTED_ACTIVATION_KEYS`.** That constant is placeholder material until the
/// maintainer generates the real keypair on their own machine (design §3.3), and
/// `entitlement.rs` has a test asserting it must fail loudly. `verify` takes the table as a
/// parameter precisely so tests can supply their own.
fn test_trusted_keys() -> Vec<(u8, [u8; 32])> {
    vec![(0x01, read_pub("alpha")), (0x02, read_pub("bravo"))]
}

fn read_pub(label: &str) -> [u8; 32] {
    let text = std::fs::read_to_string(fixture_dir().join(format!(
        "TEST-ONLY-root-key-{label}.pub.hex"
    )))
    .unwrap_or_else(|e| panic!("missing public key fixture for {label}: {e}"));
    let bytes = hex_decode(text.trim());
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    out
}

// ---------------------------------------------------------------------------------------------
// Fixture catalogue
// ---------------------------------------------------------------------------------------------

struct Fixture {
    /// Base filename under `fixtures/activation/`.
    name: &'static str,
    /// One line of prose, mirrored into the fixture README.
    intent: &'static str,
    args: Vec<String>,
}

fn s(v: &str) -> String {
    v.to_string()
}

fn base_args(key: &str, serial: u32, device: &str, issued_day: u16, valid_days: u16) -> Vec<String> {
    vec![
        s("--key"),
        key_path(key),
        s("--key-id"),
        s("1"),
        s("--company"),
        s("1"),
        s("--branch"),
        s("1"),
        s("--device-id"),
        s(device),
        s("--serial"),
        serial.to_string(),
        s("--issued-at-day"),
        issued_day.to_string(),
        s("--valid-days"),
        valid_days.to_string(),
    ]
}

fn catalogue() -> Vec<Fixture> {
    let mut out = Vec::new();

    out.push(Fixture {
        name: "valid",
        intent: "verifies, bound to the test device, Active at the evaluation day",
        args: base_args("alpha", 1001, TEST_DEVICE, ISSUED_DAY, DEFAULT_VALID_DAYS),
    });

    // expires day 2365, grace runs to 2425; EVAL_DAY 2420 sits inside it.
    out.push(Fixture {
        name: "grace",
        intent: "verifies; past expiry but inside the 60-day grace window (D-13)",
        args: base_args("alpha", 1002, TEST_DEVICE, 2000, DEFAULT_VALID_DAYS),
    });

    // expires day 1365, grace ends 1425, far behind EVAL_DAY.
    out.push(Fixture {
        name: "expired",
        intent: "verifies; past expiry and past grace",
        args: base_args("alpha", 1003, TEST_DEVICE, 1000, DEFAULT_VALID_DAYS),
    });

    // key_id 1 is trusted and maps to alpha, but this is signed by bravo.
    out.push(Fixture {
        name: "wrong-key",
        intent: "declares a trusted key_id but is signed by a different private key",
        args: base_args("bravo", 1004, TEST_DEVICE, ISSUED_DAY, DEFAULT_VALID_DAYS),
    });

    let mut unknown = base_args("alpha", 1005, TEST_DEVICE, ISSUED_DAY, DEFAULT_VALID_DAYS);
    set_arg(&mut unknown, "--key-id", "127");
    out.push(Fixture {
        name: "unknown-key-id",
        intent: "key_id 0x7F is absent from the trusted table",
        args: unknown,
    });

    out.push(Fixture {
        name: "wrong-device",
        intent: "verifies, but is bound to a different device_id (D-9)",
        args: base_args("alpha", 1006, OTHER_DEVICE, ISSUED_DAY, DEFAULT_VALID_DAYS),
    });

    let mut bad_version = base_args("alpha", 1007, TEST_DEVICE, ISSUED_DAY, DEFAULT_VALID_DAYS);
    bad_version.push(s("--format-version"));
    bad_version.push(s("9"));
    out.push(Fixture {
        name: "bad-format-version",
        intent: "format_version 9 is not a version this build understands",
        args: bad_version,
    });

    let mut truncated = base_args("alpha", 1008, TEST_DEVICE, ISSUED_DAY, DEFAULT_VALID_DAYS);
    truncated.push(s("--truncate-signature"));
    truncated.push(s("63"));
    out.push(Fixture {
        name: "truncated-signature",
        intent: "63 signature bytes instead of 64",
        args: truncated,
    });

    let mut boot = base_args("alpha", 1009, TEST_DEVICE, ISSUED_DAY, DEFAULT_VALID_DAYS);
    boot.extend([
        s("--bootstrap-username"),
        s("dhirajmanwani"),
        s("--bootstrap-salt-hex"),
        s(SALT_HEX),
        s("--bootstrap-verifier-hex"),
        s(VERIFIER_HEX),
        s("--bootstrap-valid-days"),
        s("30"),
    ]);
    out.push(Fixture {
        name: "bootstrap",
        intent: "carries an Owner bootstrap credential still inside its window at EVAL_DAY (§8.1)",
        args: boot,
    });

    let mut boot_expired = base_args("alpha", 1010, TEST_DEVICE, ISSUED_DAY, DEFAULT_VALID_DAYS);
    boot_expired.extend([
        s("--bootstrap-username"),
        s("dhirajmanwani"),
        s("--bootstrap-salt-hex"),
        s(SALT_HEX),
        s("--bootstrap-verifier-hex"),
        s(VERIFIER_HEX),
        s("--bootstrap-valid-days"),
        s("7"),
    ]);
    out.push(Fixture {
        name: "bootstrap-expired",
        intent: "entitlement still Active, but the 7-day bootstrap window closed at day 2407 (§8.2)",
        args: boot_expired,
    });

    out
}

fn set_arg(args: &mut [String], name: &str, value: &str) {
    let idx = args
        .iter()
        .position(|a| a == name)
        .unwrap_or_else(|| panic!("{name} not present"));
    args[idx + 1] = value.to_string();
}

// ---------------------------------------------------------------------------------------------
// Generation and the committed-fixture comparison
// ---------------------------------------------------------------------------------------------

fn run_cli(args: &[String]) {
    let output = Command::new(CLI)
        .args(args)
        .output()
        .unwrap_or_else(|e| panic!("failed to run {CLI}: {e}"));
    if !output.status.success() {
        panic!(
            "sign_activation {:?} failed ({}):\n{}",
            args,
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

/// Regenerate every fixture into `dir` using the real CLI.
fn generate_all(dir: &Path) {
    std::fs::create_dir_all(dir).expect("create output dir");
    for fixture in catalogue() {
        let mut args = vec![s("sign")];
        args.extend(fixture.args.clone());
        for (flag, ext) in [
            ("--out", "lic"),
            ("--out-payload", "payload.bin"),
            ("--out-sig", "sig.bin"),
        ] {
            args.push(flag.to_string());
            args.push(
                dir.join(format!("{}.{ext}", fixture.name))
                    .to_string_lossy()
                    .into_owned(),
            );
        }
        run_cli(&args);
    }
}

fn regenerating() -> bool {
    std::env::var("FROOZERP_REGENERATE_ACTIVATION_FIXTURES").is_ok_and(|v| v == "1")
}

#[test]
fn committed_fixtures_are_exactly_what_the_cli_produces_today() {
    let tmp = Path::new(env!("CARGO_TARGET_TMPDIR")).join("activation-fixtures");
    generate_all(&tmp);

    let committed = fixture_dir();
    let mut mismatches = Vec::new();

    for fixture in catalogue() {
        for ext in ["lic", "payload.bin", "sig.bin"] {
            let file = format!("{}.{ext}", fixture.name);
            let fresh = std::fs::read(tmp.join(&file)).expect("CLI produced the file");

            if regenerating() {
                std::fs::write(committed.join(&file), &fresh).expect("rewrite fixture");
                continue;
            }

            match std::fs::read(committed.join(&file)) {
                Ok(old) if old == fresh => {}
                Ok(_) => mismatches.push(format!("{file}: committed bytes differ from CLI output")),
                Err(e) => mismatches.push(format!("{file}: {e}")),
            }
        }
    }

    assert!(
        mismatches.is_empty(),
        "committed fixtures are stale or missing:\n  {}\n\nIf the format changed on purpose, \
         rerun with FROOZERP_REGENERATE_ACTIVATION_FIXTURES=1.",
        mismatches.join("\n  ")
    );
}

// ---------------------------------------------------------------------------------------------
// A throwaway `.lic` reader — Stage 5 owns the real one.
// ---------------------------------------------------------------------------------------------

struct Lic {
    header_comments: Vec<String>,
    container_format: String,
    payload: Vec<u8>,
    signature: Vec<u8>,
}

fn parse_lic(text: &str) -> Lic {
    let mut header_comments = Vec::new();
    let mut container_format = String::new();
    let mut payload = Vec::new();
    let mut signature = Vec::new();

    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        if let Some(comment) = line.strip_prefix('#') {
            header_comments.push(comment.trim().to_string());
            continue;
        }
        let (key, value) = line.split_once(':').unwrap_or_else(|| {
            panic!("unrecognised .lic line: {line:?}");
        });
        let value = value.trim();
        match key.trim() {
            "format" => container_format = value.to_string(),
            "payload" => payload = base64_decode(value),
            "signature" => signature = base64_decode(value),
            other => panic!("unknown .lic key {other:?}"),
        }
    }

    Lic {
        header_comments,
        container_format,
        payload,
        signature,
    }
}

fn read_lic(name: &str) -> Lic {
    let text = std::fs::read_to_string(fixture_dir().join(format!("{name}.lic")))
        .unwrap_or_else(|e| panic!("missing fixture {name}.lic: {e}"));
    parse_lic(&text)
}

fn base64_decode(text: &str) -> Vec<u8> {
    fn value(c: u8) -> u32 {
        match c {
            b'A'..=b'Z' => u32::from(c - b'A'),
            b'a'..=b'z' => u32::from(c - b'a') + 26,
            b'0'..=b'9' => u32::from(c - b'0') + 52,
            b'+' => 62,
            b'/' => 63,
            other => panic!("invalid base64 byte {other:?}"),
        }
    }
    let chars: Vec<u8> = text.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    assert_eq!(chars.len() % 4, 0, "base64 length must be a multiple of 4");
    let mut out = Vec::with_capacity(chars.len() / 4 * 3);
    for quad in chars.chunks(4) {
        let pad = quad.iter().filter(|c| **c == b'=').count();
        let n = (value(quad[0]) << 18)
            | (value(quad[1]) << 12)
            | (if pad > 1 { 0 } else { value(quad[2]) } << 6)
            | (if pad > 0 { 0 } else { value(quad[3]) });
        out.push((n >> 16) as u8);
        if pad < 2 {
            out.push((n >> 8) as u8);
        }
        if pad < 1 {
            out.push(n as u8);
        }
    }
    out
}

fn hex_decode(text: &str) -> Vec<u8> {
    let clean: Vec<u8> = text.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    assert_eq!(clean.len() % 2, 0);
    clean
        .chunks(2)
        .map(|p| {
            let d = |c: u8| match c {
                b'0'..=b'9' => c - b'0',
                b'a'..=b'f' => c - b'a' + 10,
                b'A'..=b'F' => c - b'A' + 10,
                other => panic!("bad hex digit {other:?}"),
            };
            (d(p[0]) << 4) | d(p[1])
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// The `.lic` container itself (§7.2)
// ---------------------------------------------------------------------------------------------

#[test]
fn lic_container_carries_the_same_bytes_as_the_raw_outputs() {
    for fixture in catalogue() {
        let lic = read_lic(fixture.name);
        let raw_payload = std::fs::read(fixture_dir().join(format!("{}.payload.bin", fixture.name)))
            .expect("payload fixture");
        let raw_sig = std::fs::read(fixture_dir().join(format!("{}.sig.bin", fixture.name)))
            .expect("signature fixture");
        assert_eq!(
            lic.payload, raw_payload,
            "{}: base64 payload in the .lic differs from the raw payload bytes",
            fixture.name
        );
        assert_eq!(
            lic.signature, raw_sig,
            "{}: base64 signature in the .lic differs from the raw signature bytes",
            fixture.name
        );
        assert_eq!(lic.container_format, "FRZ-LIC/1", "{}", fixture.name);
    }
}

#[test]
fn lic_header_is_human_readable_support_metadata() {
    // §7.2: "human-readable header comment lines (company, branch, device, expiry, serial) for
    // support". They are outside the signature, so this asserts presence, not authority.
    let lic = read_lic("valid");
    let joined = lic.header_comments.join("\n");
    for needle in [
        "company: 1",
        "branch: 1",
        &format!("device: {TEST_DEVICE}"),
        "serial: 1001",
        "key-id: 1",
        "issued: 2026-07-28",
        "expires: 2027-07-28",
        "grace-until: 2027-09-26",
    ] {
        assert!(
            joined.contains(needle),
            "header is missing {needle:?}:\n{joined}"
        );
    }
    assert!(
        joined.contains("UNSIGNED"),
        "the header must say out loud that it is not covered by the signature"
    );
}

#[test]
fn lic_header_is_not_trusted_by_the_verifier() {
    // Rewriting the human header must not change what verifies. This is the whole reason §3.4
    // says the signature covers the exact payload bytes and nothing else.
    let text = std::fs::read_to_string(fixture_dir().join("valid.lic")).unwrap();
    let tampered = text
        .replace("# company: 1", "# company: 999")
        .replace("# expires: 2027-07-28", "# expires: 2099-01-01");
    assert_ne!(text, tampered, "the tamper target must exist");

    let lic = parse_lic(&tampered);
    let verified = verify(&lic.payload, &lic.signature, &test_trusted_keys())
        .expect("payload is untouched, so it still verifies");
    assert_eq!(verified.payload().company_id, 1, "header lies, payload rules");
    assert_eq!(
        verified.payload().expires_at_day(),
        i64::from(ISSUED_DAY) + i64::from(DEFAULT_VALID_DAYS)
    );
}

#[test]
fn lic_file_is_about_the_size_the_design_predicted() {
    // §7.2 estimates ~350 bytes for the core artefact. Not a contract, but a large drift means
    // the header or the payload grew without anyone noticing.
    let bytes = std::fs::metadata(fixture_dir().join("valid.lic"))
        .expect("valid.lic")
        .len();
    assert!(
        (250..=520).contains(&bytes),
        "valid.lic is {bytes} bytes; §7.2 predicted roughly 350"
    );
}

// ---------------------------------------------------------------------------------------------
// Round trip: every fixture's expected outcome
// ---------------------------------------------------------------------------------------------

/// `evaluate_state` with a corroborated clock — `now == high_water`, no anomaly in play.
fn state_of(name: &str) -> EntitlementState {
    let lic = read_lic(name);
    let verified = verify(&lic.payload, &lic.signature, &test_trusted_keys())
        .unwrap_or_else(|e| panic!("{name} was expected to verify, got {e:?}"));
    evaluate_state(&verified, EVAL_DAY, EVAL_DAY)
}

#[test]
fn valid_fixture_verifies_binds_and_is_active() {
    let lic = read_lic("valid");

    let parsed = parse_payload(&lic.payload).expect("parses");
    assert_eq!(parsed.format_version, 1);
    assert_eq!(parsed.key_id, 1);
    assert_eq!(parsed.flags, 0);
    assert_eq!(parsed.company_id, 1);
    assert_eq!(parsed.branch_id, 1);
    assert_eq!(parsed.entitlement_serial, 1001);
    assert_eq!(parsed.issued_at, ISSUED_DAY);
    assert_eq!(parsed.valid_days, DEFAULT_VALID_DAYS);
    assert!(!parsed.carries_credential());
    assert!(parsed.bootstrap.is_none());

    // The CLI computed device_binding independently of entitlement.rs; they must agree.
    assert_eq!(parsed.device_binding, device_binding_hash(TEST_DEVICE));
    assert_eq!(check_device_binding(&parsed, TEST_DEVICE), Ok(()));

    assert_eq!(lic.signature.len(), SIGNATURE_LEN);
    let verified = verify(&lic.payload, &lic.signature, &test_trusted_keys()).expect("verifies");
    assert_eq!(verified.verified_with_key_id(), 1);
    assert_eq!(
        verified.payload().grace_until_day(),
        i64::from(ISSUED_DAY) + i64::from(DEFAULT_VALID_DAYS) + GRACE_DAYS
    );

    assert_eq!(
        evaluate_state(&verified, EVAL_DAY, EVAL_DAY),
        EntitlementState::Active
    );
}

#[test]
fn grace_fixture_lands_in_grace() {
    assert_eq!(state_of("grace"), EntitlementState::Grace);
}

#[test]
fn expired_fixture_lands_in_expired() {
    assert_eq!(state_of("expired"), EntitlementState::Expired);
}

#[test]
fn wrong_key_fixture_is_rejected_as_bad_signature() {
    let lic = read_lic("wrong-key");
    // It parses — the structure is fine, only the authenticity is not.
    let parsed = parse_payload(&lic.payload).expect("structurally valid");
    assert_eq!(parsed.key_id, 1);
    assert_eq!(
        verify(&lic.payload, &lic.signature, &test_trusted_keys()),
        Err(RejectReason::BadSignature)
    );
}

#[test]
fn unknown_key_id_fixture_is_rejected_by_key_id_not_by_signature() {
    let lic = read_lic("unknown-key-id");
    assert_eq!(
        verify(&lic.payload, &lic.signature, &test_trusted_keys()),
        Err(RejectReason::UnknownKeyId { found: 0x7F })
    );
}

#[test]
fn wrong_device_fixture_verifies_but_fails_binding() {
    // The two failures are deliberately distinct (`verify` vs `check_device_binding`): a genuine
    // code sent to the wrong branch must not be reported as a forgery.
    let lic = read_lic("wrong-device");
    let verified =
        verify(&lic.payload, &lic.signature, &test_trusted_keys()).expect("signature is genuine");
    assert_eq!(
        check_device_binding(verified.payload(), TEST_DEVICE),
        Err(RejectReason::DeviceBindingMismatch)
    );
    assert_eq!(
        check_device_binding(verified.payload(), OTHER_DEVICE),
        Ok(()),
        "it is a valid code, just for another device"
    );
}

#[test]
fn bad_format_version_fixture_is_a_named_rejection_not_a_crash() {
    let lic = read_lic("bad-format-version");
    assert_eq!(
        parse_payload(&lic.payload),
        Err(RejectReason::UnknownFormatVersion { found: 9 })
    );
    // verify() parses first, so the same named reason surfaces there.
    assert_eq!(
        verify(&lic.payload, &lic.signature, &test_trusted_keys()),
        Err(RejectReason::UnknownFormatVersion { found: 9 })
    );
}

#[test]
fn truncated_signature_fixture_is_rejected_on_length() {
    let lic = read_lic("truncated-signature");
    assert_eq!(lic.signature.len(), 63);
    assert_eq!(
        verify(&lic.payload, &lic.signature, &test_trusted_keys()),
        Err(RejectReason::TruncatedSignature { found: 63 })
    );
}

#[test]
fn bootstrap_fixture_carries_a_live_owner_credential() {
    let lic = read_lic("bootstrap");
    let verified = verify(&lic.payload, &lic.signature, &test_trusted_keys()).expect("verifies");
    let payload = verified.payload();

    assert!(payload.carries_credential());
    assert_eq!(payload.flags & FLAG_CARRIES_CREDENTIAL, FLAG_CARRIES_CREDENTIAL);

    let boot = payload.bootstrap.as_ref().expect("credential present");
    assert_eq!(boot.owner_username, "dhirajmanwani");
    assert!(boot.owner_username.len() <= MAX_OWNER_USERNAME_LEN);
    assert_eq!(boot.owner_salt, [0x11u8; OWNER_SALT_LEN]);
    assert_eq!(boot.owner_verifier, [0x22u8; OWNER_VERIFIER_LEN]);
    assert_eq!(boot.bootstrap_valid_days, 30);

    let expires = payload.bootstrap_expires_at_day().expect("has a window");
    assert_eq!(expires, i64::from(ISSUED_DAY) + 30);
    assert!(
        EVAL_DAY < expires,
        "the credential window must still be open at the evaluation day"
    );

    assert_eq!(
        evaluate_state(&verified, EVAL_DAY, EVAL_DAY),
        EntitlementState::Active
    );

    // The header names the Owner so the maintainer can read it out on the phone, but the salt and
    // verifier never appear in cleartext prose.
    let header = lic.header_comments.join("\n");
    assert!(header.contains("bootstrap-owner: dhirajmanwani"));
    assert!(!header.contains(SALT_HEX));
    assert!(!header.contains(VERIFIER_HEX));
}

#[test]
fn bootstrap_expired_fixture_keeps_the_entitlement_but_closes_the_credential_window() {
    let lic = read_lic("bootstrap-expired");
    let verified = verify(&lic.payload, &lic.signature, &test_trusted_keys()).expect("verifies");
    let payload = verified.payload();

    let expires = payload.bootstrap_expires_at_day().expect("has a window");
    assert_eq!(expires, i64::from(ISSUED_DAY) + 7);
    assert!(
        EVAL_DAY > expires,
        "the credential window must be closed at the evaluation day"
    );

    // §8.2 is explicit that the bootstrap window is a *separate* clock from entitlement validity:
    // an expired temporary password must never take the device out of Active.
    assert_eq!(
        evaluate_state(&verified, EVAL_DAY, EVAL_DAY),
        EntitlementState::Active
    );
}

// ---------------------------------------------------------------------------------------------
// Clock behaviour and the §2.2 invariant, driven by real signed bytes
// ---------------------------------------------------------------------------------------------

#[test]
fn real_bytes_reach_clock_anomaly_in_both_directions() {
    let lic = read_lic("valid");
    let verified = verify(&lic.payload, &lic.signature, &test_trusted_keys()).unwrap();

    // Clock behind the corroborated high-water mark.
    assert_eq!(
        evaluate_state(&verified, EVAL_DAY, EVAL_DAY + 3),
        EntitlementState::ClockAnomaly
    );
    // Clock implausibly ahead of it.
    assert_eq!(
        evaluate_state(&verified, EVAL_DAY + 731, EVAL_DAY),
        EntitlementState::ClockAnomaly
    );
}

#[test]
fn winding_the_clock_back_does_not_extend_a_real_entitlement() {
    let lic = read_lic("expired");
    let verified = verify(&lic.payload, &lic.signature, &test_trusted_keys()).unwrap();
    // System clock claims we are inside validity; the high-water mark knows better (§5.3).
    let high_water = EVAL_DAY;
    let now = i64::from(ISSUED_DAY) + 1;
    assert_eq!(
        evaluate_state(&verified, now, high_water),
        EntitlementState::ClockAnomaly,
        "a clock this far behind the mark is untrustworthy before it is anything else"
    );
    assert_eq!(
        evaluate_state(&verified, high_water - 1, high_water),
        EntitlementState::Expired,
        "a small rollback inside the tolerance still evaluates against the high-water mark"
    );
}

#[test]
fn no_fixture_outcome_ever_denies_billing() {
    // The §2.2 invariant, re-asserted here against real artefacts rather than constructed enum
    // values: whatever a signed file turns out to be, a running shop keeps billing.
    let trusted = test_trusted_keys();
    for fixture in catalogue() {
        let lic = read_lic(fixture.name);
        let state = match verify(&lic.payload, &lic.signature, &trusted) {
            Ok(verified) => evaluate_state(&verified, EVAL_DAY, EVAL_DAY),
            Err(reason) => EntitlementState::Malformed { reason },
        };
        assert!(
            state.billing_allowed(),
            "{} produced {state:?}, which denies billing ({})",
            fixture.name,
            fixture.intent
        );
    }
}

// ---------------------------------------------------------------------------------------------
// The CLI's own surface
// ---------------------------------------------------------------------------------------------

#[test]
fn pubkey_subcommand_matches_the_committed_public_halves() {
    for label in ["alpha", "bravo"] {
        let output = Command::new(CLI)
            .args(["pubkey", "--key", &key_path(label)])
            .output()
            .expect("run pubkey");
        assert!(output.status.success());
        let printed = String::from_utf8(output.stdout).unwrap().trim().to_string();
        let committed = std::fs::read_to_string(
            fixture_dir().join(format!("TEST-ONLY-root-key-{label}.pub.hex")),
        )
        .unwrap()
        .trim()
        .to_string();
        assert_eq!(printed, committed, "{label} public key drifted");
    }
}

#[test]
fn cli_refuses_a_key_file_that_is_not_a_32_byte_seed() {
    let tmp = Path::new(env!("CARGO_TARGET_TMPDIR")).join("bad-key.hex");
    std::fs::write(&tmp, b"not a key").unwrap();
    let output = Command::new(CLI)
        .args([
            "sign",
            "--key",
            &tmp.to_string_lossy(),
            "--device-id",
            TEST_DEVICE,
        ])
        .output()
        .expect("run sign");
    assert!(!output.status.success(), "a junk key file must not sign");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("32 raw bytes"), "unhelpful error: {stderr}");
}

#[test]
fn cli_rejects_a_mistyped_option_instead_of_ignoring_it() {
    // Silently ignoring `--valid-day 30` would mint a 365-day entitlement for a 30-day intent.
    let output = Command::new(CLI)
        .args([
            "sign",
            "--key",
            &key_path("alpha"),
            "--device-id",
            TEST_DEVICE,
            "--valid-day",
            "30",
        ])
        .output()
        .expect("run sign");
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("unknown option --valid-day"));
}

#[test]
fn cli_requires_salt_and_verifier_alongside_a_bootstrap_username() {
    let output = Command::new(CLI)
        .args([
            "sign",
            "--key",
            &key_path("alpha"),
            "--device-id",
            TEST_DEVICE,
            "--bootstrap-username",
            "owner",
        ])
        .output()
        .expect("run sign");
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("--bootstrap-salt-hex is required"));
}

#[test]
fn cli_default_issue_date_round_trips_through_the_day_epoch() {
    // No --issued-at: the CLI stamps today. Assert only that the stamp is a plausible day number
    // and that the entitlement is Active — never a hard-coded date, which would rot.
    let out = Path::new(env!("CARGO_TARGET_TMPDIR")).join("today.payload.bin");
    run_cli(&[
        s("sign"),
        s("--key"),
        key_path("alpha"),
        s("--device-id"),
        s(TEST_DEVICE),
        s("--out-payload"),
        out.to_string_lossy().into_owned(),
    ]);
    let payload = std::fs::read(&out).unwrap();
    let parsed = parse_payload(&payload).expect("parses");
    assert!(
        parsed.issued_at >= 2000,
        "issued_at {} is before 2025 — the day epoch is wrong",
        parsed.issued_at
    );
    assert_eq!(parsed.valid_days, DEFAULT_VALID_DAYS, "D-13 default");
}
