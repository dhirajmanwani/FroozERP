//! Offline activation entitlement core.
//!
//! Pure logic only: no database access, no filesystem access, no Tauri command wiring.
//! Nothing in this module can reach the running application, which is deliberate — this is
//! the single place where the meaning of a signature, a timestamp or a capability is decided,
//! and it is exhaustively unit-testable without mocking time or I/O.
//!
//! See `docs/offline-activation-design.md`:
//!   §3.4 verify the exact bytes, never re-serialise
//!   §4   payload layout
//!   §5.3 clock high-water mark
//!   §6.1 public surface
//!   §8.1 bootstrap credential extension (file delivery only)
//!   §9   state machine
//!
//! Design invariant (§2.2): **no state except `Unprovisioned` ever denies billing.**
//! A shop that is running never stops billing — not on expiry, not on revocation, not on a
//! clock anomaly, not on a corrupt entitlement. `EntitlementState::billing_allowed` encodes
//! this directly and is asserted in the tests below.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};

/// Payload format this build understands. An unknown version is a *named* rejection, never a
/// crash and never a permissive default (§2.4).
pub const FORMAT_VERSION: u8 = 1;

/// `flags` bit 0: the payload carries a bootstrap Owner credential (§8.1).
/// Set only for file-delivered (`.lic`) codes; typed codes never carry it.
pub const FLAG_CARRIES_CREDENTIAL: u8 = 0b0000_0001;

/// Default entitlement validity and grace, ruled in D-13.
pub const DEFAULT_VALID_DAYS: u16 = 365;
pub const GRACE_DAYS: i64 = 60;

/// Truncated SHA-256 of the device identity string (§4, D-10: `device_id` alone, no hardware
/// fingerprint).
pub const DEVICE_BINDING_LEN: usize = 8;

/// Ed25519. Irreducible — see §7.1 for what this costs the typed-code budget.
pub const SIGNATURE_LEN: usize = 64;

pub const MAX_OWNER_USERNAME_LEN: usize = 24;
pub const OWNER_SALT_LEN: usize = 16;
pub const OWNER_VERIFIER_LEN: usize = 32;

/// Day-stamps throughout this module are **days since 2020-01-01 UTC**, matching the 2-byte
/// `issued_at` field in §4. Callers convert; this module never reads a clock itself.
pub const DAY_EPOCH: &str = "2020-01-01";

/// A clock more than this many days *behind* the high-water mark is not trusted (D-5).
/// Small slack absorbs timezone and DST noise.
pub const CLOCK_BEHIND_ANOMALY_DAYS: i64 = 2;

/// A clock more than this many days *ahead* of the high-water mark is not trusted (D-5).
///
/// Being generous here is the safe direction, not the risky one: `ClockAnomaly` means *hold
/// current state*, and holding state keeps billing alive. A device legitimately offline for
/// longer than this holds its last good state rather than expiring on a clock nobody has been
/// able to corroborate — which is the outcome §2.5 asks for.
pub const CLOCK_AHEAD_ANOMALY_DAYS: i64 = 730;

/// Public keys this build trusts, keyed by the 1-byte `key_id` in the payload.
///
/// **Two slots are populated from day one (D-2, §3.2).** Rotation then means switching which
/// key signs *new* codes; every code already in the field keeps verifying against its original
/// `key_id` with no app update. Shipping one key and adding the second only when rotation is
/// needed would force every device to update *before* it could verify anything signed after the
/// rotation — the wrong order for a rotation meant to be uneventful.
///
/// ---
/// **PLACEHOLDER KEY MATERIAL — NOT REAL KEYS.**
/// These are structurally valid 32-byte arrays so the module compiles and its shape is fixed,
/// but they are not the public halves of any keypair that exists. Real keys arrive with the
/// signing CLI in Stage 3. Until then nothing verifies against these, and that is intended:
/// `verify` returns `RejectReason::MalformedTrustedKey` rather than silently accepting if the
/// bytes are not a valid Ed25519 point. Tests pass their own `trusted_keys`, which is exactly
/// why `verify` takes them as a parameter instead of reading this constant.
/// ---
pub const TRUSTED_ACTIVATION_KEYS: &[(u8, [u8; 32])] = &[
    // key_id 0x01 — "current" slot, placeholder.
    (0x01, [0xAA; 32]),
    // key_id 0x02 — "next" slot, pre-provisioned for rotation, placeholder.
    (0x02, [0xBB; 32]),
];

/// Why an activation artefact was refused.
///
/// Every failure has its own variant. There is no catch-all, no bare `Option`, and no
/// unit-error: per §2.4 an error must be nameable, because a maintainer debugging a branch over
/// the phone needs the reason code, not "activation failed".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RejectReason {
    /// Ran out of bytes while reading a named field.
    Truncated { field: &'static str },
    /// Bytes remain after a complete payload — a payload must not be silently extensible.
    TrailingBytes { extra: usize },
    /// `format_version` is not one this build understands.
    UnknownFormatVersion { found: u8 },
    /// `key_id` is not present in the supplied trusted-key set.
    UnknownKeyId { found: u8 },
    /// A trusted-key entry is not a valid Ed25519 public key (e.g. placeholder material).
    MalformedTrustedKey { key_id: u8 },
    /// The detached signature was not exactly `SIGNATURE_LEN` bytes.
    TruncatedSignature { found: usize },
    /// Signature did not verify over the exact bytes supplied.
    BadSignature,
    /// The payload is bound to a different device.
    DeviceBindingMismatch,
    /// A field was structurally present but semantically invalid.
    MalformedField { field: &'static str },
    /// A varint did not terminate within the bounds of a u64.
    VarintOverflow { field: &'static str },
    /// `owner_username` exceeded `MAX_OWNER_USERNAME_LEN`.
    OwnerUsernameTooLong { found: usize },
    /// `owner_username` was not valid UTF-8.
    OwnerUsernameNotUtf8,
    /// The carries-credential flag was set but the credential fields were absent.
    MissingCredentialFields,
}

/// Bootstrap Owner credential (§8.1). File-delivered codes only.
///
/// This is a PBKDF2 salt+verifier, never a password. It is single-use by local policy (§8.2):
/// once the forced password change completes, the device stops consulting it and records
/// `BOOTSTRAP_CREDENTIAL_CONSUMED`. Consumption state lives in SQLite, not here — this module
/// only reports what the artefact claims.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootstrapCredential {
    pub owner_username: String,
    pub owner_salt: [u8; OWNER_SALT_LEN],
    pub owner_verifier: [u8; OWNER_VERIFIER_LEN],
    /// Days after `issued_at` at which the bootstrap credential stops being honoured.
    pub bootstrap_valid_days: u16,
}

/// A parsed, **not yet verified** payload. Parsing proves structure, never authenticity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Payload {
    pub format_version: u8,
    pub key_id: u8,
    pub flags: u8,
    pub company_id: u64,
    pub branch_id: u64,
    pub device_binding: [u8; DEVICE_BINDING_LEN],
    pub entitlement_serial: u32,
    /// Days since `DAY_EPOCH`.
    pub issued_at: u16,
    pub valid_days: u16,
    /// Present iff `flags & FLAG_CARRIES_CREDENTIAL != 0`.
    pub bootstrap: Option<BootstrapCredential>,
}

impl Payload {
    pub fn carries_credential(&self) -> bool {
        self.flags & FLAG_CARRIES_CREDENTIAL != 0
    }

    /// Day-stamp at which the entitlement expires and grace begins.
    pub fn expires_at_day(&self) -> i64 {
        i64::from(self.issued_at) + i64::from(self.valid_days)
    }

    /// Day-stamp past which the entitlement is fully expired.
    pub fn grace_until_day(&self) -> i64 {
        self.expires_at_day() + GRACE_DAYS
    }

    /// Day-stamp past which a bootstrap credential is no longer honoured (§8.2).
    pub fn bootstrap_expires_at_day(&self) -> Option<i64> {
        self.bootstrap
            .as_ref()
            .map(|b| i64::from(self.issued_at) + i64::from(b.bootstrap_valid_days))
    }
}

/// A payload whose signature has been checked against a trusted key.
///
/// Constructible only by [`verify`] — the fields are private and there is no public
/// constructor, so a `Verified` in hand is proof that verification actually ran. `evaluate_state`
/// accepts nothing else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verified {
    payload: Payload,
    key_id: u8,
}

impl Verified {
    pub fn payload(&self) -> &Payload {
        &self.payload
    }

    /// The trusted key this artefact actually verified against.
    pub fn verified_with_key_id(&self) -> u8 {
        self.key_id
    }
}

/// What a device may do, per the §9 table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capabilities {
    pub billing: bool,
    pub local_reports: bool,
    pub sync: bool,
    pub admin: bool,
    pub provisioning: bool,
}

/// The entire authorisation policy surface (§9).
///
/// `Unprovisioned`, `Revoked` and `Malformed` are assigned by the caller from facts this module
/// cannot see (absence of an entitlement row, a revocation delivered at sync, a parse/verify
/// failure). `Active`, `Grace`, `Expired` and `ClockAnomaly` are derived here by
/// [`evaluate_state`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntitlementState {
    /// No entitlement at all. The only state in which billing is unavailable.
    Unprovisioned,
    Active,
    Grace,
    Expired,
    Revoked,
    /// The clock could not be trusted in either direction (D-5). Hold whatever state the device
    /// last legitimately had; never restrict on the strength of a clock known to be wrong.
    ClockAnomaly,
    /// Unparseable or unverifiable. Hold previous state, banner loudly (§2.5).
    Malformed { reason: RejectReason },
}

impl EntitlementState {
    /// The §2.2 invariant, encoded once so it cannot be regressed quietly.
    pub fn billing_allowed(&self) -> bool {
        !matches!(self, EntitlementState::Unprovisioned)
    }

    /// States that carry no capability set of their own and must inherit the previous one.
    pub fn holds_previous_state(&self) -> bool {
        matches!(
            self,
            EntitlementState::ClockAnomaly | EntitlementState::Malformed { .. }
        )
    }

    /// Capabilities for the determinate states; `None` means "hold the previous capability set".
    pub fn capabilities(&self) -> Option<Capabilities> {
        match self {
            EntitlementState::Unprovisioned => Some(Capabilities {
                billing: false,
                local_reports: false,
                sync: false,
                admin: false,
                provisioning: false,
            }),
            EntitlementState::Active => Some(Capabilities {
                billing: true,
                local_reports: true,
                sync: true,
                admin: true,
                provisioning: true,
            }),
            EntitlementState::Grace => Some(Capabilities {
                billing: true,
                local_reports: true,
                sync: true,
                admin: true,
                provisioning: false,
            }),
            // Expired and Revoked share a capability set (D-14). Revoked differs only in how
            // loudly it is presented, which is a UI concern, not a policy one.
            EntitlementState::Expired | EntitlementState::Revoked => Some(Capabilities {
                billing: true,
                local_reports: true,
                sync: true,
                admin: false,
                provisioning: false,
            }),
            EntitlementState::ClockAnomaly | EntitlementState::Malformed { .. } => None,
        }
    }
}

/// Truncated SHA-256 of the device identity string (§4).
pub fn device_binding_hash(device_id: &str) -> [u8; DEVICE_BINDING_LEN] {
    let digest = Sha256::digest(device_id.as_bytes());
    let mut out = [0u8; DEVICE_BINDING_LEN];
    out.copy_from_slice(&digest[..DEVICE_BINDING_LEN]);
    out
}

/// Confirm a payload is bound to this device (D-9: device-bound codes only).
///
/// Separate from [`verify`] on purpose: verification answers "did we sign this?", binding
/// answers "was it meant for this machine?". They fail for different reasons and a caller may
/// legitimately want to report the difference.
pub fn check_device_binding(payload: &Payload, device_id: &str) -> Result<(), RejectReason> {
    if payload.device_binding == device_binding_hash(device_id) {
        Ok(())
    } else {
        Err(RejectReason::DeviceBindingMismatch)
    }
}

/// Cursor over payload bytes. Every read is bounds-checked into a named `Truncated`.
struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Reader { bytes, pos: 0 }
    }

    fn take(&mut self, n: usize, field: &'static str) -> Result<&'a [u8], RejectReason> {
        let end = self
            .pos
            .checked_add(n)
            .ok_or(RejectReason::Truncated { field })?;
        if end > self.bytes.len() {
            return Err(RejectReason::Truncated { field });
        }
        let slice = &self.bytes[self.pos..end];
        self.pos = end;
        Ok(slice)
    }

    fn u8(&mut self, field: &'static str) -> Result<u8, RejectReason> {
        Ok(self.take(1, field)?[0])
    }

    fn u16_le(&mut self, field: &'static str) -> Result<u16, RejectReason> {
        let b = self.take(2, field)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }

    fn u32_le(&mut self, field: &'static str) -> Result<u32, RejectReason> {
        let b = self.take(4, field)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    /// LEB128 unsigned varint.
    fn varint(&mut self, field: &'static str) -> Result<u64, RejectReason> {
        let mut value: u64 = 0;
        let mut shift = 0u32;
        loop {
            let byte = self.u8(field)?;
            if shift >= 64 {
                return Err(RejectReason::VarintOverflow { field });
            }
            let payload_bits = u64::from(byte & 0x7F);
            value |= payload_bits
                .checked_shl(shift)
                .ok_or(RejectReason::VarintOverflow { field })?;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
            shift += 7;
        }
    }

    fn remaining(&self) -> usize {
        self.bytes.len().saturating_sub(self.pos)
    }
}

/// Parse the compact binary payload (§4).
///
/// Structure only — this proves nothing about authenticity. Trailing bytes are rejected so a
/// payload cannot be silently extended past what was signed.
pub fn parse_payload(bytes: &[u8]) -> Result<Payload, RejectReason> {
    let mut r = Reader::new(bytes);

    let format_version = r.u8("format_version")?;
    if format_version != FORMAT_VERSION {
        return Err(RejectReason::UnknownFormatVersion {
            found: format_version,
        });
    }
    let key_id = r.u8("key_id")?;
    let flags = r.u8("flags")?;
    let company_id = r.varint("company_id")?;
    let branch_id = r.varint("branch_id")?;

    let mut device_binding = [0u8; DEVICE_BINDING_LEN];
    device_binding.copy_from_slice(r.take(DEVICE_BINDING_LEN, "device_binding")?);

    let entitlement_serial = r.u32_le("entitlement_serial")?;
    let issued_at = r.u16_le("issued_at")?;
    let valid_days = r.u16_le("valid_days")?;

    if valid_days == 0 {
        return Err(RejectReason::MalformedField { field: "valid_days" });
    }

    // `operational_location_id` is deliberately absent (D-4): pinning a device to a counter in
    // a signed artefact would mean a new code every time a device moves. It stays sync-delivered
    // via `local_device_assignment`.

    let bootstrap = if flags & FLAG_CARRIES_CREDENTIAL != 0 {
        if r.remaining() == 0 {
            return Err(RejectReason::MissingCredentialFields);
        }
        let name_len = usize::from(r.u8("owner_username_len")?);
        if name_len > MAX_OWNER_USERNAME_LEN {
            return Err(RejectReason::OwnerUsernameTooLong { found: name_len });
        }
        if name_len == 0 {
            return Err(RejectReason::MalformedField {
                field: "owner_username",
            });
        }
        let name_bytes = r.take(name_len, "owner_username")?;
        let owner_username = core::str::from_utf8(name_bytes)
            .map_err(|_| RejectReason::OwnerUsernameNotUtf8)?
            .to_string();

        let mut owner_salt = [0u8; OWNER_SALT_LEN];
        owner_salt.copy_from_slice(r.take(OWNER_SALT_LEN, "owner_salt")?);

        let mut owner_verifier = [0u8; OWNER_VERIFIER_LEN];
        owner_verifier.copy_from_slice(r.take(OWNER_VERIFIER_LEN, "owner_verifier")?);

        let bootstrap_valid_days = r.u16_le("bootstrap_valid_days")?;
        if bootstrap_valid_days == 0 {
            return Err(RejectReason::MalformedField {
                field: "bootstrap_valid_days",
            });
        }

        Some(BootstrapCredential {
            owner_username,
            owner_salt,
            owner_verifier,
            bootstrap_valid_days,
        })
    } else {
        None
    };

    if r.remaining() != 0 {
        return Err(RejectReason::TrailingBytes {
            extra: r.remaining(),
        });
    }

    Ok(Payload {
        format_version,
        key_id,
        flags,
        company_id,
        branch_id,
        device_binding,
        entitlement_serial,
        issued_at,
        valid_days,
        bootstrap,
    })
}

/// Verify a detached signature over **the exact bytes supplied** (§3.4).
///
/// `bytes` is never re-serialised before verification — re-serialisation is where signature
/// schemes die. The stored payload blob is the source of truth; parsed fields are a convenience
/// index rebuilt from the blob, never the reverse.
pub fn verify(
    bytes: &[u8],
    sig: &[u8],
    trusted_keys: &[(u8, [u8; 32])],
) -> Result<Verified, RejectReason> {
    let payload = parse_payload(bytes)?;

    let key_bytes = trusted_keys
        .iter()
        .find(|(id, _)| *id == payload.key_id)
        .map(|(_, key)| key)
        .ok_or(RejectReason::UnknownKeyId {
            found: payload.key_id,
        })?;

    let verifying_key = VerifyingKey::from_bytes(key_bytes).map_err(|_| {
        RejectReason::MalformedTrustedKey {
            key_id: payload.key_id,
        }
    })?;

    if sig.len() != SIGNATURE_LEN {
        return Err(RejectReason::TruncatedSignature { found: sig.len() });
    }
    let mut sig_bytes = [0u8; SIGNATURE_LEN];
    sig_bytes.copy_from_slice(sig);
    let signature = Signature::from_bytes(&sig_bytes);

    verifying_key
        .verify(bytes, &signature)
        .map_err(|_| RejectReason::BadSignature)?;

    let key_id = payload.key_id;
    Ok(Verified { payload, key_id })
}

/// Derive the entitlement state from a verified artefact and the clock (§5.3, §9, D-5).
///
/// `now_day` and `high_water_day` are days since [`DAY_EPOCH`], passed in rather than read, so
/// every branch here is directly testable without mocking time.
///
/// Expiry is evaluated against `max(now, high_water)`: winding the clock back must not extend an
/// entitlement. A clock untrustworthy in *either* direction yields [`EntitlementState::ClockAnomaly`],
/// which means hold current state — a dead CMOS battery must not lock a shop.
pub fn evaluate_state(
    verified: &Verified,
    now_day: i64,
    high_water_day: i64,
) -> EntitlementState {
    if now_day < high_water_day - CLOCK_BEHIND_ANOMALY_DAYS
        || now_day > high_water_day + CLOCK_AHEAD_ANOMALY_DAYS
    {
        return EntitlementState::ClockAnomaly;
    }

    let effective_now = now_day.max(high_water_day);
    let payload = verified.payload();

    if effective_now < payload.expires_at_day() {
        EntitlementState::Active
    } else if effective_now < payload.grace_until_day() {
        EntitlementState::Grace
    } else {
        EntitlementState::Expired
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    const TEST_KEY_ID: u8 = 0x07;
    const OTHER_KEY_ID: u8 = 0x09;
    const TEST_DEVICE: &str = "FZDEV-DELL-1781852580596";
    /// 2026-08-16 is ~2419 days after 2020-01-01; exact value is irrelevant to the logic.
    const ISSUED: u16 = 2400;

    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[42u8; 32])
    }

    fn other_signing_key() -> SigningKey {
        SigningKey::from_bytes(&[99u8; 32])
    }

    fn trusted() -> Vec<(u8, [u8; 32])> {
        vec![(TEST_KEY_ID, signing_key().verifying_key().to_bytes())]
    }

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

    struct Build {
        format_version: u8,
        key_id: u8,
        flags: u8,
        company_id: u64,
        branch_id: u64,
        device: String,
        serial: u32,
        issued_at: u16,
        valid_days: u16,
        bootstrap: Option<(String, u16)>,
    }

    impl Default for Build {
        fn default() -> Self {
            Build {
                format_version: FORMAT_VERSION,
                key_id: TEST_KEY_ID,
                flags: 0,
                company_id: 1,
                branch_id: 1,
                device: TEST_DEVICE.to_string(),
                serial: 4242,
                issued_at: ISSUED,
                valid_days: DEFAULT_VALID_DAYS,
                bootstrap: None,
            }
        }
    }

    impl Build {
        fn bytes(&self) -> Vec<u8> {
            let mut out = Vec::new();
            out.push(self.format_version);
            out.push(self.key_id);
            out.push(self.flags);
            put_varint(&mut out, self.company_id);
            put_varint(&mut out, self.branch_id);
            out.extend_from_slice(&device_binding_hash(&self.device));
            out.extend_from_slice(&self.serial.to_le_bytes());
            out.extend_from_slice(&self.issued_at.to_le_bytes());
            out.extend_from_slice(&self.valid_days.to_le_bytes());
            if let Some((name, days)) = &self.bootstrap {
                out.push(name.len() as u8);
                out.extend_from_slice(name.as_bytes());
                out.extend_from_slice(&[0x11; OWNER_SALT_LEN]);
                out.extend_from_slice(&[0x22; OWNER_VERIFIER_LEN]);
                out.extend_from_slice(&days.to_le_bytes());
            }
            out
        }

        fn signed(&self) -> (Vec<u8>, Vec<u8>) {
            let bytes = self.bytes();
            let sig = signing_key().sign(&bytes).to_bytes().to_vec();
            (bytes, sig)
        }
    }

    fn verified_default() -> Verified {
        let (bytes, sig) = Build::default().signed();
        verify(&bytes, &sig, &trusted()).expect("default fixture must verify")
    }

    // ---- parse -------------------------------------------------------------------------

    #[test]
    fn parses_a_well_formed_payload() {
        let payload = parse_payload(&Build::default().bytes()).unwrap();
        assert_eq!(payload.format_version, FORMAT_VERSION);
        assert_eq!(payload.key_id, TEST_KEY_ID);
        assert_eq!(payload.company_id, 1);
        assert_eq!(payload.branch_id, 1);
        assert_eq!(payload.entitlement_serial, 4242);
        assert_eq!(payload.issued_at, ISSUED);
        assert_eq!(payload.valid_days, DEFAULT_VALID_DAYS);
        assert!(!payload.carries_credential());
        assert!(payload.bootstrap.is_none());
        assert_eq!(payload.device_binding, device_binding_hash(TEST_DEVICE));
    }

    #[test]
    fn rejects_unknown_format_version() {
        let bytes = Build {
            format_version: 99,
            ..Default::default()
        }
        .bytes();
        assert_eq!(
            parse_payload(&bytes),
            Err(RejectReason::UnknownFormatVersion { found: 99 })
        );
    }

    #[test]
    fn rejects_truncated_payload_with_the_field_name() {
        let full = Build::default().bytes();
        let cut = &full[..full.len() - 1];
        match parse_payload(cut) {
            Err(RejectReason::Truncated { field }) => assert_eq!(field, "valid_days"),
            other => panic!("expected Truncated, got {other:?}"),
        }
    }

    #[test]
    fn rejects_trailing_bytes() {
        let mut bytes = Build::default().bytes();
        bytes.push(0xFF);
        assert_eq!(
            parse_payload(&bytes),
            Err(RejectReason::TrailingBytes { extra: 1 })
        );
    }

    #[test]
    fn rejects_zero_valid_days_as_malformed() {
        let bytes = Build {
            valid_days: 0,
            ..Default::default()
        }
        .bytes();
        assert_eq!(
            parse_payload(&bytes),
            Err(RejectReason::MalformedField { field: "valid_days" })
        );
    }

    #[test]
    fn rejects_credential_flag_with_no_credential_body() {
        let bytes = Build {
            flags: FLAG_CARRIES_CREDENTIAL,
            bootstrap: None,
            ..Default::default()
        }
        .bytes();
        assert_eq!(
            parse_payload(&bytes),
            Err(RejectReason::MissingCredentialFields)
        );
    }

    #[test]
    fn rejects_overlong_owner_username() {
        let bytes = Build {
            flags: FLAG_CARRIES_CREDENTIAL,
            bootstrap: Some(("x".repeat(MAX_OWNER_USERNAME_LEN + 1), 7)),
            ..Default::default()
        }
        .bytes();
        assert_eq!(
            parse_payload(&bytes),
            Err(RejectReason::OwnerUsernameTooLong {
                found: MAX_OWNER_USERNAME_LEN + 1
            })
        );
    }

    // ---- carries-credential variant (§8.1) ---------------------------------------------

    #[test]
    fn parses_the_carries_credential_variant() {
        let build = Build {
            flags: FLAG_CARRIES_CREDENTIAL,
            bootstrap: Some(("dhirajmanwani".to_string(), 7)),
            ..Default::default()
        };
        let payload = parse_payload(&build.bytes()).unwrap();
        assert!(payload.carries_credential());
        let boot = payload.bootstrap.as_ref().expect("credential present");
        assert_eq!(boot.owner_username, "dhirajmanwani");
        assert_eq!(boot.owner_salt, [0x11; OWNER_SALT_LEN]);
        assert_eq!(boot.owner_verifier, [0x22; OWNER_VERIFIER_LEN]);
        assert_eq!(boot.bootstrap_valid_days, 7);
        assert_eq!(
            payload.bootstrap_expires_at_day(),
            Some(i64::from(ISSUED) + 7)
        );
    }

    #[test]
    fn credential_variant_verifies_end_to_end() {
        let build = Build {
            flags: FLAG_CARRIES_CREDENTIAL,
            bootstrap: Some(("owner".to_string(), 7)),
            ..Default::default()
        };
        let (bytes, sig) = build.signed();
        let verified = verify(&bytes, &sig, &trusted()).unwrap();
        assert!(verified.payload().carries_credential());
    }

    // ---- verify ------------------------------------------------------------------------

    #[test]
    fn verifies_a_genuine_signature() {
        let (bytes, sig) = Build::default().signed();
        let verified = verify(&bytes, &sig, &trusted()).unwrap();
        assert_eq!(verified.verified_with_key_id(), TEST_KEY_ID);
        assert_eq!(verified.payload().entitlement_serial, 4242);
    }

    #[test]
    fn rejects_a_signature_from_the_wrong_key() {
        let bytes = Build::default().bytes();
        let sig = other_signing_key().sign(&bytes).to_bytes().to_vec();
        assert_eq!(
            verify(&bytes, &sig, &trusted()),
            Err(RejectReason::BadSignature)
        );
    }

    #[test]
    fn rejects_unknown_key_id() {
        let build = Build {
            key_id: OTHER_KEY_ID,
            ..Default::default()
        };
        let (bytes, sig) = build.signed();
        assert_eq!(
            verify(&bytes, &sig, &trusted()),
            Err(RejectReason::UnknownKeyId {
                found: OTHER_KEY_ID
            })
        );
    }

    #[test]
    fn rejects_truncated_signature() {
        let (bytes, sig) = Build::default().signed();
        assert_eq!(
            verify(&bytes, &sig[..63], &trusted()),
            Err(RejectReason::TruncatedSignature { found: 63 })
        );
    }

    #[test]
    fn rejects_a_tampered_payload_byte() {
        let (mut bytes, sig) = Build::default().signed();
        let last = bytes.len() - 1;
        bytes[last] ^= 0x01;
        assert_eq!(
            verify(&bytes, &sig, &trusted()),
            Err(RejectReason::BadSignature)
        );
    }

    #[test]
    fn rejects_placeholder_trusted_key_material_rather_than_accepting_it() {
        // The shipped TRUSTED_ACTIVATION_KEYS are placeholders until Stage 3. They must fail
        // loudly, never silently accept.
        let build = Build {
            key_id: 0x01,
            ..Default::default()
        };
        let (bytes, sig) = build.signed();
        let result = verify(&bytes, &sig, TRUSTED_ACTIVATION_KEYS);
        assert!(
            matches!(
                result,
                Err(RejectReason::MalformedTrustedKey { key_id: 0x01 })
                    | Err(RejectReason::BadSignature)
            ),
            "placeholder keys must never verify, got {result:?}"
        );
    }

    #[test]
    fn trusted_key_table_ships_two_rotation_slots() {
        // D-2 / §3.2: two slots from day one, so rotation never requires an app update first.
        assert!(
            TRUSTED_ACTIVATION_KEYS.len() >= 2,
            "rotation requires at least a current and a next key slot"
        );
        let ids: Vec<u8> = TRUSTED_ACTIVATION_KEYS.iter().map(|(id, _)| *id).collect();
        let mut unique = ids.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(ids.len(), unique.len(), "key ids must be distinct");
    }

    // ---- device binding ----------------------------------------------------------------

    #[test]
    fn accepts_the_bound_device() {
        let payload = parse_payload(&Build::default().bytes()).unwrap();
        assert_eq!(check_device_binding(&payload, TEST_DEVICE), Ok(()));
    }

    #[test]
    fn rejects_a_different_device() {
        let payload = parse_payload(&Build::default().bytes()).unwrap();
        assert_eq!(
            check_device_binding(&payload, "FZDEV-SOMEONE-ELSE"),
            Err(RejectReason::DeviceBindingMismatch)
        );
    }

    #[test]
    fn device_binding_is_stable_and_discriminating() {
        assert_eq!(
            device_binding_hash(TEST_DEVICE),
            device_binding_hash(TEST_DEVICE)
        );
        assert_ne!(device_binding_hash("a"), device_binding_hash("b"));
    }

    // ---- state ------------------------------------------------------------------------

    #[test]
    fn active_before_expiry() {
        let v = verified_default();
        let day = i64::from(ISSUED) + 10;
        assert_eq!(evaluate_state(&v, day, day), EntitlementState::Active);
    }

    #[test]
    fn grace_between_expiry_and_grace_end() {
        let v = verified_default();
        let day = i64::from(ISSUED) + i64::from(DEFAULT_VALID_DAYS) + 1;
        assert_eq!(evaluate_state(&v, day, day), EntitlementState::Grace);
    }

    #[test]
    fn expired_past_grace() {
        let v = verified_default();
        let day = i64::from(ISSUED) + i64::from(DEFAULT_VALID_DAYS) + GRACE_DAYS + 1;
        assert_eq!(evaluate_state(&v, day, day), EntitlementState::Expired);
    }

    #[test]
    fn boundary_day_of_expiry_enters_grace_not_expired() {
        let v = verified_default();
        let day = i64::from(ISSUED) + i64::from(DEFAULT_VALID_DAYS);
        assert_eq!(evaluate_state(&v, day, day), EntitlementState::Grace);
    }

    #[test]
    fn winding_the_clock_back_does_not_extend_an_entitlement() {
        // High-water says we are past grace; the system clock claims we are still inside
        // validity. max(now, high_water) must win (§5.3). The rollback is small enough to stay
        // inside the anomaly threshold, so this exercises the high-water rule, not the anomaly
        // rule.
        let v = verified_default();
        let high_water = i64::from(ISSUED) + i64::from(DEFAULT_VALID_DAYS) + GRACE_DAYS + 10;
        let now = high_water - 1;
        assert_eq!(evaluate_state(&v, now, high_water), EntitlementState::Expired);
    }

    #[test]
    fn clock_far_behind_high_water_is_an_anomaly() {
        let v = verified_default();
        let high_water = i64::from(ISSUED) + 100;
        let now = high_water - CLOCK_BEHIND_ANOMALY_DAYS - 1;
        assert_eq!(
            evaluate_state(&v, now, high_water),
            EntitlementState::ClockAnomaly
        );
    }

    #[test]
    fn clock_implausibly_ahead_is_an_anomaly() {
        let v = verified_default();
        let high_water = i64::from(ISSUED);
        let now = high_water + CLOCK_AHEAD_ANOMALY_DAYS + 1;
        assert_eq!(
            evaluate_state(&v, now, high_water),
            EntitlementState::ClockAnomaly
        );
    }

    #[test]
    fn a_clock_anomaly_never_expires_a_device() {
        // The point of D-5: an untrustworthy clock must not push a shop into a more restricted
        // state. Even though `now` is far past grace, the anomaly wins.
        let v = verified_default();
        let high_water = i64::from(ISSUED);
        let now = high_water + CLOCK_AHEAD_ANOMALY_DAYS + 5000;
        let state = evaluate_state(&v, now, high_water);
        assert_eq!(state, EntitlementState::ClockAnomaly);
        assert!(state.holds_previous_state());
        assert!(state.billing_allowed());
    }

    #[test]
    fn small_clock_drift_is_tolerated_not_flagged() {
        let v = verified_default();
        let high_water = i64::from(ISSUED) + 100;
        let now = high_water - CLOCK_BEHIND_ANOMALY_DAYS;
        assert_eq!(evaluate_state(&v, now, high_water), EntitlementState::Active);
    }

    // ---- the §2.2 invariant ------------------------------------------------------------

    #[test]
    fn no_state_except_unprovisioned_ever_denies_billing() {
        // This is the design invariant from §2.2 and principle 2. If a future change makes any
        // state stop billing, this test must fail loudly rather than let a shop go dark.
        let all = [
            EntitlementState::Unprovisioned,
            EntitlementState::Active,
            EntitlementState::Grace,
            EntitlementState::Expired,
            EntitlementState::Revoked,
            EntitlementState::ClockAnomaly,
            EntitlementState::Malformed {
                reason: RejectReason::BadSignature,
            },
        ];
        for state in all {
            let expected = !matches!(state, EntitlementState::Unprovisioned);
            assert_eq!(
                state.billing_allowed(),
                expected,
                "billing capability regressed for {state:?}"
            );
            if let Some(caps) = state.capabilities() {
                assert_eq!(
                    caps.billing, expected,
                    "capability table disagrees with billing_allowed for {state:?}"
                );
            }
        }
    }

    #[test]
    fn expired_and_revoked_keep_billing_but_lose_admin() {
        for state in [EntitlementState::Expired, EntitlementState::Revoked] {
            let caps = state.capabilities().expect("determinate state");
            assert!(caps.billing, "{state:?} must keep billing");
            assert!(caps.local_reports, "{state:?} must keep local reports");
            assert!(caps.sync, "{state:?} must keep sync");
            assert!(!caps.admin, "{state:?} must lose admin");
            assert!(!caps.provisioning, "{state:?} must lose provisioning");
        }
    }

    #[test]
    fn grace_keeps_admin_but_blocks_provisioning() {
        let caps = EntitlementState::Grace.capabilities().unwrap();
        assert!(caps.billing && caps.admin && caps.sync);
        assert!(!caps.provisioning);
    }

    #[test]
    fn unprovisioned_is_the_only_state_with_no_capability_at_all() {
        let caps = EntitlementState::Unprovisioned.capabilities().unwrap();
        assert!(!caps.billing && !caps.local_reports && !caps.sync);
        assert!(!caps.admin && !caps.provisioning);
    }

    #[test]
    fn indeterminate_states_hold_previous_capabilities() {
        assert!(EntitlementState::ClockAnomaly.capabilities().is_none());
        assert!(EntitlementState::Malformed {
            reason: RejectReason::BadSignature
        }
        .capabilities()
        .is_none());
    }
}
