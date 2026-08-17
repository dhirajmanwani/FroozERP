//! Offline activation `.lic` container reader (Stage 5).
//!
//! The signing side that writes `.lic` files lives in `src-tauri/tools/sign_activation.rs`
//! (`render_lic`, design §7.2). This module is the shipped reader: it turns the text envelope
//! back into the `(payload, signature)` byte pair that `entitlement::verify` checks. It proves
//! nothing about authenticity — that is `entitlement.rs`'s job — it only unwraps the container.
//!
//! The container is deliberately trivial to parse by hand over the phone:
//!   * `#` lines are UNSIGNED support metadata and are ignored entirely (they may contain `:`).
//!   * blank lines are ignored.
//!   * every other line is `key: value`; the keys are `format`, `payload`, `signature`.
//!   * `payload` and `signature` are standard base64 with padding (RFC 4648 §4).
//!
//! A reader must take every fact it acts on from the decoded `payload`, never from the `#`
//! header — the header exists only so a human can tell which branch and device a file belongs to.

/// The only container format this build understands. Independent of the payload's
/// `format_version`: this versions the text envelope, that versions the signed bytes.
pub const LIC_CONTAINER_FORMAT: &str = "FRZ-LIC/1";

/// Parse a `.lic` container into its `(payload, signature)` byte pair.
///
/// Returns a named `String` error when the container is not `FRZ-LIC/1`, when `payload` or
/// `signature` is missing, or when either base64 field fails to decode. Blank and `#` lines are
/// ignored, so a `#` header line containing a colon never reaches the `key: value` split.
pub fn parse_lic(text: &str) -> Result<(Vec<u8>, Vec<u8>), String> {
    let mut container_format: Option<String> = None;
    let mut payload: Option<Vec<u8>> = None;
    let mut signature: Option<Vec<u8>> = None;

    for raw in text.lines() {
        let line = raw.trim_end_matches('\r');
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with('#') {
            // Unsigned support metadata. May legitimately contain ':' — skip before splitting.
            continue;
        }
        let (key, value) = trimmed
            .split_once(':')
            .ok_or_else(|| format!("unrecognised .lic line: {trimmed:?}"))?;
        let key = key.trim();
        let value = value.trim();
        match key {
            "format" => container_format = Some(value.to_string()),
            "payload" => {
                payload = Some(
                    base64_decode(value).map_err(|e| format!("invalid payload base64: {e}"))?,
                );
            }
            "signature" => {
                signature = Some(
                    base64_decode(value).map_err(|e| format!("invalid signature base64: {e}"))?,
                );
            }
            other => return Err(format!("unknown .lic key: {other:?}")),
        }
    }

    match container_format.as_deref() {
        Some(LIC_CONTAINER_FORMAT) => {}
        Some(other) => {
            return Err(format!(
                "unsupported .lic format {other:?}, expected {LIC_CONTAINER_FORMAT:?}"
            ))
        }
        None => return Err("missing 'format' line in .lic file".to_string()),
    }

    let payload = payload.ok_or_else(|| "missing 'payload' line in .lic file".to_string())?;
    let signature =
        signature.ok_or_else(|| "missing 'signature' line in .lic file".to_string())?;

    Ok((payload, signature))
}

/// Standard base64 with padding (RFC 4648 §4). Mirrors `sign_activation::base64_encode`'s output.
///
/// Public so the Tauri command layer can decode the base64 arguments of `entitlement_redeem`
/// without a second copy of this decoder.
pub fn base64_decode(text: &str) -> Result<Vec<u8>, String> {
    fn value(c: u8) -> Result<u32, String> {
        match c {
            b'A'..=b'Z' => Ok(u32::from(c - b'A')),
            b'a'..=b'z' => Ok(u32::from(c - b'a') + 26),
            b'0'..=b'9' => Ok(u32::from(c - b'0') + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            other => Err(format!("invalid base64 byte {:?}", other as char)),
        }
    }
    let chars: Vec<u8> = text.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if chars.len() % 4 != 0 {
        return Err("base64 length must be a multiple of 4".to_string());
    }
    let mut out = Vec::with_capacity(chars.len() / 4 * 3);
    for quad in chars.chunks(4) {
        let pad = quad.iter().filter(|c| **c == b'=').count();
        if pad > 2 {
            return Err("base64 quad has too much padding".to_string());
        }
        // Padding may only appear at the end of the input.
        let c2 = if pad > 1 { 0 } else { value(quad[2])? };
        let c3 = if pad > 0 { 0 } else { value(quad[3])? };
        let n = (value(quad[0])? << 18) | (value(quad[1])? << 12) | (c2 << 6) | c3;
        out.push((n >> 16) as u8);
        if pad < 2 {
            out.push((n >> 8) as u8);
        }
        if pad < 1 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Standard base64 encoder with padding, used only to build test inputs.
    fn base64_encode(bytes: &[u8]) -> String {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let b0 = u32::from(chunk[0]);
            let b1 = chunk.get(1).copied().map(u32::from).unwrap_or(0);
            let b2 = chunk.get(2).copied().map(u32::from).unwrap_or(0);
            let n = (b0 << 16) | (b1 << 8) | b2;
            out.push(ALPHABET[((n >> 18) & 0x3F) as usize] as char);
            out.push(ALPHABET[((n >> 12) & 0x3F) as usize] as char);
            out.push(if chunk.len() > 1 {
                ALPHABET[((n >> 6) & 0x3F) as usize] as char
            } else {
                '='
            });
            out.push(if chunk.len() > 2 {
                ALPHABET[(n & 0x3F) as usize] as char
            } else {
                '='
            });
        }
        out
    }

    fn build_lic(payload: &[u8], signature: &[u8]) -> String {
        format!(
            "# FroozERP activation file. '#' lines are UNSIGNED support metadata.\n\
             # company: Acme Fruits (7)\n\
             # device: FZDEV-TEST-0000000000001\n\
             # issued: 2026-07-28\n\
             \n\
             format: {LIC_CONTAINER_FORMAT}\n\
             payload: {}\n\
             signature: {}\n",
            base64_encode(payload),
            base64_encode(signature),
        )
    }

    #[test]
    fn round_trips_a_valid_lic() {
        let payload: Vec<u8> = (0u8..=40).collect();
        let signature: Vec<u8> = (0u8..64).map(|i| i.wrapping_mul(3)).collect();
        let text = build_lic(&payload, &signature);
        let (got_payload, got_sig) = parse_lic(&text).expect("valid .lic must parse");
        assert_eq!(got_payload, payload);
        assert_eq!(got_sig, signature);
    }

    #[test]
    fn rejects_unknown_container_format() {
        let text = format!(
            "format: FRZ-LIC/999\npayload: {}\nsignature: {}\n",
            base64_encode(b"abc"),
            base64_encode(b"def"),
        );
        let err = parse_lic(&text).expect_err("unknown format must be rejected");
        assert!(err.contains("unsupported .lic format"), "got: {err}");
    }

    #[test]
    fn rejects_missing_payload() {
        let text = format!(
            "format: {LIC_CONTAINER_FORMAT}\nsignature: {}\n",
            base64_encode(b"def"),
        );
        let err = parse_lic(&text).expect_err("missing payload must be rejected");
        assert!(err.contains("missing 'payload'"), "got: {err}");
    }

    #[test]
    fn rejects_missing_signature() {
        let text = format!(
            "format: {LIC_CONTAINER_FORMAT}\npayload: {}\n",
            base64_encode(b"abc"),
        );
        let err = parse_lic(&text).expect_err("missing signature must be rejected");
        assert!(err.contains("missing 'signature'"), "got: {err}");
    }

    #[test]
    fn rejects_bad_base64() {
        let text = format!(
            "format: {LIC_CONTAINER_FORMAT}\npayload: not*valid*base64!!\nsignature: {}\n",
            base64_encode(b"def"),
        );
        let err = parse_lic(&text).expect_err("bad base64 must be rejected");
        assert!(err.contains("payload base64"), "got: {err}");
    }

    #[test]
    fn header_lines_with_colons_do_not_confuse_the_parser() {
        // Every '#' line here carries a ':' — a naive split on the first ':' would treat them as
        // key/value pairs. They must be ignored before the split.
        let payload = b"payload-bytes".to_vec();
        let signature = vec![0xABu8; 8];
        let text = format!(
            "# time: 10:30:00 and url: https://example.com\n\
             # note: format: pretend\n\
             format: {LIC_CONTAINER_FORMAT}\n\
             payload: {}\n\
             signature: {}\n",
            base64_encode(&payload),
            base64_encode(&signature),
        );
        let (got_payload, got_sig) = parse_lic(&text).expect("header colons must not confuse");
        assert_eq!(got_payload, payload);
        assert_eq!(got_sig, signature);
    }

    #[test]
    fn base64_decode_rejects_non_multiple_of_four() {
        assert!(base64_decode("abc").is_err());
    }
}
