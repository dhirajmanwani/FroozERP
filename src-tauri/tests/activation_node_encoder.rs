//! Binds the **Node licence issuer** to the shipped Rust decoder.
//!
//! There are three independent implementations of the payload layout in
//! `docs/offline-activation-design.md` §4:
//!
//! | Implementation | Lives in | Role |
//! | --- | --- | --- |
//! | Decoder | `src-tauri/src/entitlement.rs` | the shipped contract |
//! | Rust encoder | `src-tauri/tools/sign_activation.rs` | maintainer CLI, covered by `activation_roundtrip.rs` |
//! | Node encoder | `backend/activationLicence.js` | back-office issuer, covered by this file |
//!
//! Nothing is shared between them, so agreement is evidence rather than tautology. The binding
//! is the committed fixtures under `tests/fixtures/`: `backend/activationLicence.test.js`
//! regenerates them in memory and fails if the Node encoder drifts from the committed bytes,
//! and this file decodes those same bytes with the real `parse_payload` / `verify` and fails if
//! the decoder drifts from them. A format change on either side fails a suite here rather than
//! failing on a shop counter in another town.
//!
//! The fixtures are signed with `[42u8; 32]` — the same throwaway seed `entitlement.rs`'s own
//! unit tests use in `signing_key()`, at their `TEST_KEY_ID` of `0x07`. No production key
//! material is involved, and the trusted table is passed in rather than read from
//! `TRUSTED_ACTIVATION_KEYS`, so this suite never depends on production keys.
//!
//! Fixtures are regenerated from the Node side, deliberately:
//!
//! ```text
//! FROOZERP_REGENERATE_ACTIVATION_FIXTURES=1 node --test backend/activationLicence.test.js
//! ```

use ed25519_dalek::SigningKey;
use froozerp_lib::activation::parse_lic;
use froozerp_lib::entitlement::{
    check_device_binding, device_binding_hash, evaluate_state, parse_payload, verify,
    EntitlementState, RejectReason, DEVICE_BINDING_LEN, SIGNATURE_LEN,
};
use std::path::{Path, PathBuf};

/// `entitlement.rs` tests' `TEST_KEY_ID`; the Node fixtures are issued against it.
const FIXTURE_KEY_ID: u8 = 0x07;
/// A key id the fixture trusted table deliberately does not carry.
const ABSENT_KEY_ID: u8 = 0x09;

/// The public half the Node issuer reports for the `[42u8; 32]` seed, as a lowercase hex string.
/// Asserted against ed25519-dalek's own derivation so the two key derivations cannot drift
/// silently — if they did, every fixture would still verify against itself and nothing else.
const NODE_REPORTED_PUBLIC_KEY_HEX: &str =
    "197f6b23e16c8532c6abc838facd5ea789be0c76b2920334039bfa8b3d368d61";

/// Every field the Node encoder was asked for, restated here rather than read from a manifest:
/// a manifest regenerated alongside the payload would agree with it by construction.
struct Fixture {
    name: &'static str,
    device_id: &'static str,
    other_device_id: &'static str,
    company_id: u64,
    branch_id: u64,
    serial: u32,
    issued_at: u16,
    valid_days: u16,
}

const FIXTURES: &[Fixture] = &[
    // The ordinary case: single-byte varints, small serial, the default 365-day frame.
    Fixture {
        name: "node_basic",
        device_id: "FZDEV-TEST-0000000000001",
        other_device_id: "FZDEV-TEST-0000000000002",
        company_id: 1,
        branch_id: 1,
        serial: 1,
        issued_at: 2400, // 2026-07-28
        valid_days: 365,
    },
    // Every numeric field pushed to a shape a naive encoder gets wrong: a two-byte LEB128
    // varint (300), a three-byte one (16384), u32::MAX and u16::MAX.
    Fixture {
        name: "node_multibyte",
        device_id: "FZDEV-TEST-0000000000002",
        other_device_id: "FZDEV-TEST-0000000000001",
        company_id: 300,
        branch_id: 16384,
        serial: u32::MAX,
        issued_at: 2400,
        valid_days: u16::MAX,
    },
];

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn signing_key() -> SigningKey {
    SigningKey::from_bytes(&[42u8; 32])
}

fn trusted() -> Vec<(u8, [u8; 32])> {
    vec![(FIXTURE_KEY_ID, signing_key().verifying_key().to_bytes())]
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn read_fixture(name: &str, suffix: &str) -> Vec<u8> {
    let path = fixture_dir().join(format!("{name}{suffix}"));
    std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "missing fixture {}: {e}. Regenerate with \
             FROOZERP_REGENERATE_ACTIVATION_FIXTURES=1 node --test backend/activationLicence.test.js",
            path.display()
        )
    })
}

fn payload_of(f: &Fixture) -> Vec<u8> {
    read_fixture(f.name, ".payload.bin")
}

fn signature_of(f: &Fixture) -> Vec<u8> {
    read_fixture(f.name, ".sig.bin")
}

#[test]
fn node_and_dalek_derive_the_same_public_key() {
    assert_eq!(
        hex_encode(&signing_key().verifying_key().to_bytes()),
        NODE_REPORTED_PUBLIC_KEY_HEX,
        "the Node issuer's PKCS#8 key derivation and ed25519-dalek's must agree, or fixtures \
         would verify only against themselves"
    );
}

#[test]
fn parse_payload_returns_every_field_the_node_encoder_wrote() {
    for f in FIXTURES {
        let payload = parse_payload(&payload_of(f))
            .unwrap_or_else(|e| panic!("{}: node payload must parse, got {e:?}", f.name));

        assert_eq!(payload.format_version, 1, "{}: format_version", f.name);
        assert_eq!(payload.key_id, FIXTURE_KEY_ID, "{}: key_id", f.name);
        assert_eq!(
            payload.flags, 0,
            "{}: flags — the Node issuer does not implement the credential path",
            f.name
        );
        assert!(
            !payload.carries_credential(),
            "{}: no bootstrap credential",
            f.name
        );
        assert!(payload.bootstrap.is_none(), "{}: no bootstrap", f.name);
        assert_eq!(payload.company_id, f.company_id, "{}: company_id", f.name);
        assert_eq!(payload.branch_id, f.branch_id, "{}: branch_id", f.name);
        assert_eq!(
            payload.entitlement_serial, f.serial,
            "{}: entitlement_serial",
            f.name
        );
        assert_eq!(payload.issued_at, f.issued_at, "{}: issued_at", f.name);
        assert_eq!(payload.valid_days, f.valid_days, "{}: valid_days", f.name);
        assert_eq!(
            payload.expires_at_day(),
            i64::from(f.issued_at) + i64::from(f.valid_days),
            "{}: expiry",
            f.name
        );
    }
}

#[test]
fn device_binding_matches_the_named_device_and_no_other() {
    for f in FIXTURES {
        let payload = parse_payload(&payload_of(f)).expect("parses");

        assert_eq!(
            payload.device_binding,
            device_binding_hash(f.device_id),
            "{}: bound to {}",
            f.name,
            f.device_id
        );
        assert_eq!(
            payload.device_binding.len(),
            DEVICE_BINDING_LEN,
            "{}: binding width",
            f.name
        );
        assert_eq!(
            check_device_binding(&payload, f.device_id),
            Ok(()),
            "{}: its own device must be accepted",
            f.name
        );
        assert_eq!(
            check_device_binding(&payload, f.other_device_id),
            Err(RejectReason::DeviceBindingMismatch),
            "{}: another device must be refused",
            f.name
        );
    }
}

#[test]
fn verify_accepts_the_node_signature_under_the_trusted_key() {
    for f in FIXTURES {
        let payload = payload_of(f);
        let signature = signature_of(f);
        assert_eq!(signature.len(), SIGNATURE_LEN, "{}: signature width", f.name);

        let verified = verify(&payload, &signature, &trusted())
            .unwrap_or_else(|e| panic!("{}: node signature must verify, got {e:?}", f.name));
        assert_eq!(verified.verified_with_key_id(), FIXTURE_KEY_ID, "{}", f.name);
        assert_eq!(
            verified.payload().entitlement_serial,
            f.serial,
            "{}: the verified payload is the one we parsed",
            f.name
        );
    }
}

/// Without this, the three assertions above would all pass against a verifier that accepts
/// anything. Each mutation must produce a *named* refusal, not a permissive default.
#[test]
fn verify_rejects_a_payload_or_signature_altered_by_one_byte() {
    for f in FIXTURES {
        let payload = payload_of(f);
        let signature = signature_of(f);

        // A single flipped bit in the last payload byte (valid_days, high half). The payload
        // still parses — valid_days stays non-zero — so this isolates the signature check.
        let mut altered = payload.clone();
        let last = altered.len() - 1;
        altered[last] ^= 0x02;
        assert!(
            parse_payload(&altered).is_ok(),
            "{}: the altered payload must still be structurally valid, or this proves nothing",
            f.name
        );
        assert_eq!(
            verify(&altered, &signature, &trusted()),
            Err(RejectReason::BadSignature),
            "{}: an altered payload must not verify",
            f.name
        );

        // A single flipped bit in the middle of the payload — the device binding.
        let mut rebound = payload.clone();
        let binding_start = rebound.len() - 8 - DEVICE_BINDING_LEN;
        rebound[binding_start] ^= 0x01;
        assert_eq!(
            verify(&rebound, &signature, &trusted()),
            Err(RejectReason::BadSignature),
            "{}: a re-bound payload must not verify",
            f.name
        );

        // A single flipped bit in the signature.
        let mut bad_sig = signature.clone();
        bad_sig[0] ^= 0x01;
        assert_eq!(
            verify(&payload, &bad_sig, &trusted()),
            Err(RejectReason::BadSignature),
            "{}: an altered signature must not verify",
            f.name
        );

        // A truncated signature is its own named refusal, not a bad one.
        assert_eq!(
            verify(&payload, &signature[..SIGNATURE_LEN - 1], &trusted()),
            Err(RejectReason::TruncatedSignature {
                found: SIGNATURE_LEN - 1
            }),
            "{}: a short signature",
            f.name
        );

        // A different trusted key under the same key_id.
        let other = SigningKey::from_bytes(&[99u8; 32]);
        assert_eq!(
            verify(
                &payload,
                &signature,
                &[(FIXTURE_KEY_ID, other.verifying_key().to_bytes())]
            ),
            Err(RejectReason::BadSignature),
            "{}: another key must not verify",
            f.name
        );

        // A trusted table that does not carry this key_id at all.
        assert_eq!(
            verify(
                &payload,
                &signature,
                &[(ABSENT_KEY_ID, signing_key().verifying_key().to_bytes())]
            ),
            Err(RejectReason::UnknownKeyId {
                found: FIXTURE_KEY_ID
            }),
            "{}: an absent key_id",
            f.name
        );
    }
}

/// The Node encoder must not emit a silently extensible payload: §4 permits no trailing bytes.
#[test]
fn an_extended_payload_is_refused() {
    for f in FIXTURES {
        let mut extended = payload_of(f);
        extended.push(0x00);
        assert_eq!(
            parse_payload(&extended),
            Err(RejectReason::TrailingBytes { extra: 1 }),
            "{}: trailing bytes",
            f.name
        );
    }
}

/// The `.lic` container the Node issuer writes must be the envelope `parse_lic` reads, and it
/// must carry exactly the committed payload and signature bytes.
#[test]
fn the_node_lic_container_unwraps_to_the_committed_bytes() {
    for f in FIXTURES {
        let text = String::from_utf8(read_fixture(f.name, ".lic"))
            .unwrap_or_else(|e| panic!("{}: .lic must be UTF-8: {e}", f.name));
        let (payload, signature) = parse_lic(&text)
            .unwrap_or_else(|e| panic!("{}: node .lic must parse, got {e}", f.name));

        assert_eq!(payload, payload_of(f), "{}: .lic payload", f.name);
        assert_eq!(signature, signature_of(f), "{}: .lic signature", f.name);
        verify(&payload, &signature, &trusted())
            .unwrap_or_else(|e| panic!("{}: .lic contents must verify, got {e:?}", f.name));

        // The '#' header is UNSIGNED support metadata. It must be present for a human on the
        // phone, and nothing above may have been taken from it.
        assert!(
            text.contains(&format!("# device: {}\n", f.device_id)),
            "{}: header names the device",
            f.name
        );
        assert!(
            text.contains(&format!("# key-id: {FIXTURE_KEY_ID}\n")),
            "{}: header names the key id",
            f.name
        );
    }
}

/// A Node-issued licence must reach the same state the decoder would put any other licence in.
#[test]
fn a_node_licence_evaluates_as_active_inside_its_frame() {
    let f = &FIXTURES[0];
    let verified = verify(&payload_of(f), &signature_of(f), &trusted()).expect("verifies");
    let issued = i64::from(f.issued_at);

    assert_eq!(
        evaluate_state(&verified, issued + 1, issued + 1),
        EntitlementState::Active
    );
    assert_eq!(
        evaluate_state(
            &verified,
            issued + i64::from(f.valid_days) + 1,
            issued + i64::from(f.valid_days) + 1
        ),
        EntitlementState::Grace
    );
}
