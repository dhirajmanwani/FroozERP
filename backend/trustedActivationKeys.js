"use strict";

/**
 * The activation keys the shipped app trusts, as the backend reads them.
 *
 * A copy of the `TRUSTED_ACTIVATION_KEYS` table in `src-tauri/src/entitlement.rs`, which stays the
 * source of truth. The issue route used to read that Rust file at run time, from
 * `../src-tauri/src/entitlement.rs`. The hosted backend is deployed from `backend/` alone
 * (`backend/railway.json`), so on Railway that file does not exist and every licence was refused
 * with TRUSTED_KEYS_UNAVAILABLE (26 Sep 2026).
 *
 * A copy can go stale, and the point of the check is to catch a key the shipped app would refuse.
 * `activationLicenceRoute.test.js` therefore fails unless this text is identical to the Rust table,
 * so a key rotation that changes one without the other cannot pass `npm --prefix backend test`.
 */
const TRUSTED_ACTIVATION_KEYS_SOURCE = `pub const TRUSTED_ACTIVATION_KEYS: &[(u8, [u8; 32])] = &[
    // key_id 0x01 — "current" slot. Public half only.
    (0x01, [
        0x91, 0x4F, 0x23, 0xF3, 0x4E, 0x21, 0x3E, 0xCE,
        0x06, 0x1D, 0x9A, 0x97, 0x95, 0xC9, 0x26, 0xC7,
        0x05, 0xEB, 0x30, 0x97, 0x27, 0x35, 0x0B, 0x9D,
        0x7A, 0x28, 0x7F, 0xBB, 0xD3, 0xF8, 0xE7, 0xA4,
    ]),
    // key_id 0x02 — "next" slot, pre-provisioned for rotation. Public half only.
    (0x02, [
        0x15, 0x34, 0xCA, 0x85, 0x8D, 0x9F, 0xF5, 0x23,
        0x93, 0x2B, 0x12, 0xF4, 0x54, 0x8F, 0x2C, 0x26,
        0xFA, 0x9B, 0xCA, 0xD2, 0x37, 0x33, 0x7D, 0x37,
        0x09, 0xC7, 0xE9, 0x2D, 0x98, 0xA3, 0xF8, 0xEE,
    ]),
];`;

module.exports = { TRUSTED_ACTIVATION_KEYS_SOURCE };
