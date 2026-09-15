"use strict";

/**
 * Binds `activationLicence.js` to the Rust decoder it has to agree with.
 *
 * Two halves:
 *
 *   1. **Fixtures.** The committed artefacts under `src-tauri/tests/fixtures/` are regenerated
 *      here in memory and compared byte-for-byte. Ed25519 is deterministic (RFC 8032 §5.1.6)
 *      and the `.lic` header carries no wall-clock timestamp, so the comparison is meaningful:
 *      it fails the moment this encoder drifts from the bytes `src-tauri/tests/
 *      activation_node_encoder.rs` decodes with the shipped `parse_payload` / `verify`.
 *      A format change therefore fails in the suite instead of on a counter.
 *
 *   2. **Guards.** Every refusal `issueLicence` can make, asserted by code and by the part of
 *      the message a person would act on.
 *
 * The signing key here is `[42u8; 32]` — the same seed `entitlement.rs`'s own unit tests use in
 * `signing_key()`. It is a throwaway test key, deliberately public, and is not related to any
 * production key material. Production seeds live only on the maintainer's machine (design §3.3).
 *
 * To rewrite the committed fixtures after an intentional format change:
 *
 *   FROOZERP_REGENERATE_ACTIVATION_FIXTURES=1 node --test backend/activationLicence.test.js
 *
 * and then re-run `cargo test --manifest-path src-tauri/Cargo.toml`, which decodes them.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  issueLicence,
  ActivationLicenceError,
  deviceBindingHash,
  encodeVarint,
  parseTrustedKeys,
  dayToIso,
  todayDay,
  LIC_CONTAINER_FORMAT,
  DAY_EPOCH_FROM_UNIX,
} = require("./activationLicence");

// --------------------------------------------------------------------------------------------
// Test key material — throwaway, matches entitlement.rs's `signing_key()` / `TEST_KEY_ID`.
// --------------------------------------------------------------------------------------------

/** `SigningKey::from_bytes(&[42u8; 32])` in entitlement.rs's tests. */
const TEST_SEED_HEX = "2a".repeat(32);
/** entitlement.rs tests' `TEST_KEY_ID`. */
const TEST_KEY_ID = 7;
/**
 * The public half of that seed. Hard-coded rather than derived so a change in how this module
 * builds its PKCS#8 key shows up as a mismatch here; `activation_node_encoder.rs` derives the
 * same value independently with ed25519-dalek.
 */
const TEST_PUBLIC_KEY_HEX =
  "197f6b23e16c8532c6abc838facd5ea789be0c76b2920334039bfa8b3d368d61";

const REAL_ENTITLEMENT_RS = path.join(
  __dirname,
  "..",
  "src-tauri",
  "src",
  "entitlement.rs"
);

const FIXTURE_DIR = path.join(__dirname, "..", "src-tauri", "tests", "fixtures");

/** A synthetic `TRUSTED_ACTIVATION_KEYS` table trusting the throwaway test key at key_id 7. */
function trustedKeysSourceFor(keyId, publicKeyHex) {
  const bytes = [...Buffer.from(publicKeyHex, "hex")]
    .map((b) => `0x${b.toString(16).padStart(2, "0").toUpperCase()}`)
    .join(", ");
  return [
    "pub const TRUSTED_ACTIVATION_KEYS: &[(u8, [u8; 32])] = &[",
    `    // key_id 0x${keyId.toString(16).padStart(2, "0")} — throwaway test key.`,
    `    (0x${keyId.toString(16).padStart(2, "0")}, [${bytes}]),`,
    "];",
  ].join("\n");
}

const TEST_TRUSTED_SOURCE = trustedKeysSourceFor(TEST_KEY_ID, TEST_PUBLIC_KEY_HEX);

// --------------------------------------------------------------------------------------------
// The fixture set. This is the single definition: the committed files are written from it and
// compared against it.
// --------------------------------------------------------------------------------------------

/**
 * `node_basic` is the ordinary case. `node_multibyte` deliberately pushes every numeric field
 * to a shape a naive encoder gets wrong: a two-byte varint (300), a three-byte varint (16384),
 * u32::MAX, and u16::MAX days.
 */
const FIXTURES = [
  {
    name: "node_basic",
    deviceId: "FZDEV-TEST-0000000000001",
    companyId: 1,
    branchId: 1,
    serial: 1,
    validDays: 365,
    issuedAtDay: 2400,
  },
  {
    name: "node_multibyte",
    deviceId: "FZDEV-TEST-0000000000002",
    companyId: 300,
    branchId: 16384,
    serial: 4294967295,
    validDays: 65535,
    issuedAtDay: 2400,
  },
];

function issueFixture(spec) {
  return issueLicence({
    deviceId: spec.deviceId,
    validDays: spec.validDays,
    companyId: spec.companyId,
    branchId: spec.branchId,
    serial: spec.serial,
    keyId: TEST_KEY_ID,
    signingKeyHex: TEST_SEED_HEX,
    issuedAtDay: spec.issuedAtDay,
    trustedKeysSource: TEST_TRUSTED_SOURCE,
  });
}

function regenerating() {
  return process.env.FROOZERP_REGENERATE_ACTIVATION_FIXTURES === "1";
}

function fixtureFiles(spec) {
  const issued = issueFixture(spec);
  return [
    [`${spec.name}.payload.bin`, issued.payload],
    [`${spec.name}.sig.bin`, issued.signature],
    [`${spec.name}.lic`, Buffer.from(issued.lic, "utf8")],
  ];
}

test("committed fixtures still match what this encoder produces", () => {
  if (regenerating()) {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  }
  for (const spec of FIXTURES) {
    for (const [file, fresh] of fixtureFiles(spec)) {
      const target = path.join(FIXTURE_DIR, file);
      if (regenerating()) {
        fs.writeFileSync(target, fresh);
        continue;
      }
      let committed;
      try {
        committed = fs.readFileSync(target);
      } catch (cause) {
        assert.fail(
          `missing fixture ${file} (${cause.code}). ` +
            "Rerun with FROOZERP_REGENERATE_ACTIVATION_FIXTURES=1 if the format changed on purpose."
        );
      }
      assert.deepEqual(
        fresh.toString("hex"),
        committed.toString("hex"),
        `${file} drifted from this encoder. src-tauri/tests/activation_node_encoder.rs decodes ` +
          "these bytes with the shipped decoder, so regenerate deliberately: " +
          "FROOZERP_REGENERATE_ACTIVATION_FIXTURES=1 node --test backend/activationLicence.test.js"
      );
    }
  }
});

test("fixture signatures verify against the test key's public half", () => {
  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(TEST_PUBLIC_KEY_HEX, "hex"),
    ]),
    format: "der",
    type: "spki",
  });
  for (const spec of FIXTURES) {
    const issued = issueFixture(spec);
    assert.equal(issued.publicKeyHex, TEST_PUBLIC_KEY_HEX);
    assert.equal(issued.signature.length, 64);
    assert.ok(
      crypto.verify(null, issued.payload, publicKey, issued.signature),
      `${spec.name} signature must verify`
    );
    // And must not verify over a payload that has been altered by one byte.
    const tampered = Buffer.from(issued.payload);
    tampered[tampered.length - 3] ^= 0x01;
    assert.ok(!crypto.verify(null, tampered, publicKey, issued.signature));
  }
});

// --------------------------------------------------------------------------------------------
// Wire format
// --------------------------------------------------------------------------------------------

test("varint is LEB128, including the multi-byte cases", () => {
  const cases = [
    [0, "00"],
    [1, "01"],
    [127, "7f"],
    [128, "8001"],
    [255, "ff01"],
    [300, "ac02"],
    [16383, "ff7f"],
    [16384, "808001"],
    [Number.MAX_SAFE_INTEGER, "ffffffffffffff0f"],
  ];
  for (const [value, hex] of cases) {
    assert.equal(encodeVarint(value).toString("hex"), hex, `varint(${value})`);
  }
});

test("payload fields sit at the offsets parse_payload reads them from", () => {
  const issued = issueLicence({
    deviceId: "FZDEV-TEST-0000000000001",
    validDays: 365,
    companyId: 300,
    branchId: 1,
    serial: 4242,
    keyId: TEST_KEY_ID,
    signingKeyHex: TEST_SEED_HEX,
    issuedAtDay: 2400,
    trustedKeysSource: TEST_TRUSTED_SOURCE,
  });
  const p = issued.payload;

  assert.equal(p[0], 1, "format_version");
  assert.equal(p[1], TEST_KEY_ID, "key_id");
  assert.equal(p[2], 0, "flags — the bootstrap-credential path is not implemented");
  // company_id 300 is a two-byte varint, so branch_id starts at 5, not 4.
  assert.equal(p.subarray(3, 5).toString("hex"), "ac02", "company_id varint");
  assert.equal(p[5], 1, "branch_id varint");
  assert.equal(
    p.subarray(6, 14).toString("hex"),
    deviceBindingHash("FZDEV-TEST-0000000000001").toString("hex"),
    "device_binding"
  );
  assert.equal(p.readUInt32LE(14), 4242, "entitlement_serial, u32 LE");
  assert.equal(p.readUInt16LE(18), 2400, "issued_at, u16 LE");
  assert.equal(p.readUInt16LE(20), 365, "valid_days, u16 LE");
  assert.equal(p.length, 22, "no trailing bytes — parse_payload rejects them");
});

test("device_binding is SHA-256(device_id)[..8] and distinguishes devices", () => {
  const expected = crypto
    .createHash("sha256")
    .update("FZDEV-TEST-0000000000001")
    .digest()
    .subarray(0, 8);
  assert.equal(deviceBindingHash("FZDEV-TEST-0000000000001").toString("hex"), expected.toString("hex"));
  assert.notEqual(
    deviceBindingHash("FZDEV-TEST-0000000000001").toString("hex"),
    deviceBindingHash("FZDEV-TEST-0000000000002").toString("hex")
  );
});

test(".lic container is the envelope parse_lic reads", () => {
  const issued = issueFixture(FIXTURES[0]);
  const lines = issued.lic.split("\n");
  assert.ok(lines[0].startsWith("# FroozERP activation file."));
  assert.ok(issued.lic.includes(`format: ${LIC_CONTAINER_FORMAT}\n`));
  assert.ok(issued.lic.includes("# device: FZDEV-TEST-0000000000001\n"));
  assert.ok(issued.lic.includes("# key-id: 7\n"));
  assert.ok(issued.lic.includes("# issued: 2026-07-28\n"));
  assert.ok(issued.lic.includes("# expires: 2027-07-28\n"));
  assert.ok(issued.lic.includes("# grace-until: 2027-09-26\n"));

  const field = (key) => {
    const line = lines.find((l) => l.startsWith(`${key}: `));
    assert.ok(line, `${key} line present`);
    return Buffer.from(line.slice(key.length + 2), "base64");
  };
  assert.deepEqual(field("payload"), issued.payload);
  assert.deepEqual(field("signature"), issued.signature);
});

test("day-stamps are days since 2020-01-01 UTC", () => {
  assert.equal(DAY_EPOCH_FROM_UNIX, 18262);
  assert.equal(dayToIso(0), "2020-01-01");
  assert.equal(dayToIso(2400), "2026-07-28");
  assert.equal(todayDay(), Math.floor(Date.now() / 86400000) - 18262);
});

// --------------------------------------------------------------------------------------------
// Defaults
// --------------------------------------------------------------------------------------------

test("companyId, branchId, serial and keyId default as documented", () => {
  const issued = issueLicence({
    deviceId: "FZDEV-TEST-0000000000001",
    validDays: 30,
    signingKeyHex: TEST_SEED_HEX,
    issuedAtDay: 2400,
    keyId: TEST_KEY_ID,
    trustedKeysSource: TEST_TRUSTED_SOURCE,
  });
  assert.equal(issued.payload[3], 1, "companyId defaults to 1");
  assert.equal(issued.payload[4], 1, "branchId defaults to 1");
  assert.equal(issued.payload.readUInt32LE(13), 1, "serial defaults to 1");

  // keyId defaults to 1, which the real trusted table knows.
  const keyIds = [...parseTrustedKeys(fs.readFileSync(REAL_ENTITLEMENT_RS, "utf8")).keys()];
  assert.ok(keyIds.includes(1), "key_id 1 is the current production slot");
});

test("issuedAtDay defaults to today and expiresOnDay is issued + validDays", () => {
  const issued = issueLicence({
    deviceId: "FZDEV-TEST-0000000000001",
    validDays: 365,
    keyId: TEST_KEY_ID,
    signingKeyHex: TEST_SEED_HEX,
    trustedKeysSource: TEST_TRUSTED_SOURCE,
  });
  assert.equal(issued.issuedAtDay, todayDay());
  assert.equal(issued.expiresOnDay, issued.issuedAtDay + 365);
  assert.equal(issued.payload.readUInt16LE(issued.payload.length - 4), issued.issuedAtDay);
});

// --------------------------------------------------------------------------------------------
// Guards
// --------------------------------------------------------------------------------------------

/** Run `fn`, require it to throw an `ActivationLicenceError`, and hand the error back. */
function caught(fn, label) {
  try {
    fn();
  } catch (error) {
    assert.ok(
      error instanceof ActivationLicenceError,
      `${label ?? "call"} threw ${error.name} instead of ActivationLicenceError: ${error.message}`
    );
    return error;
  }
  assert.fail(`${label ?? "call"} was expected to be refused, but it returned a licence`);
  return null;
}

/** A licence call that differs from the good one only in `overrides`, and must be refused. */
function refusal(overrides) {
  return caught(
    () =>
      issueLicence({
        deviceId: "FZDEV-TEST-0000000000001",
        validDays: 365,
        keyId: TEST_KEY_ID,
        signingKeyHex: TEST_SEED_HEX,
        issuedAtDay: 2400,
        trustedKeysSource: TEST_TRUSTED_SOURCE,
        ...overrides,
      }),
    JSON.stringify(overrides)
  );
}

test("refuses an empty or absent device id", () => {
  for (const deviceId of ["", "   ", undefined, null, 42]) {
    const e = refusal({ deviceId });
    assert.equal(e.code, "INVALID_FIELD");
    assert.match(e.message, /deviceId/);
  }
});

test("refuses validDays outside 1..65535", () => {
  for (const validDays of [0, -1, 65536, 1.5, "365", undefined]) {
    const e = refusal({ validDays });
    assert.equal(e.code, "INVALID_FIELD");
    assert.match(e.message, /validDays/);
  }
  // The boundaries themselves are accepted.
  for (const validDays of [1, 65535]) {
    const issued = issueLicence({
      deviceId: "FZDEV-TEST-0000000000001",
      validDays,
      keyId: TEST_KEY_ID,
      signingKeyHex: TEST_SEED_HEX,
      issuedAtDay: 2400,
      trustedKeysSource: TEST_TRUSTED_SOURCE,
    });
    assert.equal(issued.payload.readUInt16LE(issued.payload.length - 2), validDays);
    assert.equal(issued.expiresOnDay, 2400 + validDays);
  }
});

test("refuses a serial that does not fit in u32", () => {
  for (const serial of [4294967296, -1, 1.5, 2 ** 40]) {
    const e = refusal({ serial });
    assert.equal(e.code, "INVALID_FIELD");
    assert.match(e.message, /serial/);
  }
  assert.equal(
    issueLicence({
      deviceId: "FZDEV-TEST-0000000000001",
      validDays: 1,
      serial: 4294967295,
      keyId: TEST_KEY_ID,
      signingKeyHex: TEST_SEED_HEX,
      issuedAtDay: 2400,
      trustedKeysSource: TEST_TRUSTED_SOURCE,
    }).payload.readUInt32LE(13),
    4294967295
  );
});

test("refuses negative or non-integer company and branch ids", () => {
  for (const field of ["companyId", "branchId"]) {
    for (const value of [-1, 1.5, "1", Number.MAX_SAFE_INTEGER + 2]) {
      const e = refusal({ [field]: value });
      assert.equal(e.code, "INVALID_FIELD");
      assert.match(e.message, new RegExp(field));
    }
  }
});

test("refuses an issuedAtDay that does not fit the 2-byte field", () => {
  for (const issuedAtDay of [-1, 65536, 1.5]) {
    const e = refusal({ issuedAtDay });
    assert.equal(e.code, "INVALID_FIELD");
    assert.match(e.message, /issuedAtDay/);
  }
});

test("refuses a signing key of the wrong length or with a non-hex digit", () => {
  const short = refusal({ signingKeyHex: "2a".repeat(31) });
  assert.equal(short.code, "INVALID_SIGNING_KEY");
  assert.match(short.message, /64 hex characters/);
  assert.match(short.message, /62 characters/);

  const long = refusal({ signingKeyHex: "2a".repeat(33) });
  assert.equal(long.code, "INVALID_SIGNING_KEY");

  const bad = refusal({ signingKeyHex: `${"2a".repeat(31)}zz` });
  assert.equal(bad.code, "INVALID_SIGNING_KEY");
  assert.match(bad.message, /not hexadecimal/);
  assert.match(bad.message, /index 62/);

  const wrongType = refusal({ signingKeyHex: undefined });
  assert.equal(wrongType.code, "INVALID_SIGNING_KEY");
});

test("refuses a key_id the app does not carry", () => {
  const e = refusal({ keyId: 9 });
  assert.equal(e.code, "UNKNOWN_KEY_ID");
  assert.match(e.message, /UnknownKeyId/);
  assert.match(e.message, /Known key ids: 7/);

  const badType = refusal({ keyId: 256 });
  assert.equal(badType.code, "INVALID_FIELD");
});

test("refuses a key the shipped app would not trust, naming both halves", () => {
  // The real table: key_id 1 is a production key, and the throwaway test seed is not it.
  const e = caught(() =>
    issueLicence({
      deviceId: "FZDEV-TEST-0000000000001",
      validDays: 365,
      keyId: 1,
      signingKeyHex: TEST_SEED_HEX,
      issuedAtDay: 2400,
    })
  );
  assert.equal(e.code, "UNTRUSTED_SIGNING_KEY");
  assert.match(e.message, /Expected public key [0-9a-f]{64}/);
  assert.ok(
    e.message.includes(TEST_PUBLIC_KEY_HEX),
    "the refusal must say what the supplied seed actually derives"
  );
  assert.ok(
    !e.message.includes(TEST_SEED_HEX),
    "the refusal must never contain the private seed"
  );
});

test("the private seed is never returned", () => {
  const issued = issueFixture(FIXTURES[0]);
  const serialised = JSON.stringify({
    ...issued,
    payload: issued.payload.toString("hex"),
    signature: issued.signature.toString("hex"),
  });
  assert.ok(!serialised.includes(TEST_SEED_HEX));
  assert.equal(issued.publicKeyHex, TEST_PUBLIC_KEY_HEX);
});

// --------------------------------------------------------------------------------------------
// Trusted-key table parsing
// --------------------------------------------------------------------------------------------

test("reads the real TRUSTED_ACTIVATION_KEYS out of entitlement.rs", () => {
  const keys = parseTrustedKeys(fs.readFileSync(REAL_ENTITLEMENT_RS, "utf8"));
  assert.ok(keys.size >= 2, "two slots are populated from day one (D-2)");
  for (const [keyId, hex] of keys) {
    assert.ok(Number.isInteger(keyId) && keyId >= 0 && keyId <= 255);
    assert.match(hex, /^[0-9a-f]{64}$/);
  }
});

test("refuses a trusted-key source it cannot read", () => {
  const cases = [
    ["no table at all", "fn main() {}"],
    [
      "a table with no entries",
      "pub const TRUSTED_ACTIVATION_KEYS: &[(u8, [u8; 32])] = &[\n];",
    ],
    [
      "an entry that is not 32 bytes",
      "pub const TRUSTED_ACTIVATION_KEYS: &[(u8, [u8; 32])] = &[\n (0x01, [0x00, 0x01]),\n];",
    ],
    [
      "the same key_id twice",
      `pub const TRUSTED_ACTIVATION_KEYS: &[(u8, [u8; 32])] = &[\n (0x01, [${Array(32)
        .fill("0x00")
        .join(", ")}]),\n (0x01, [${Array(32).fill("0x01").join(", ")}]),\n];`,
    ],
  ];
  for (const [label, source] of cases) {
    const e = caught(() => parseTrustedKeys(source), label);
    assert.equal(e.code, "TRUSTED_KEYS_UNREADABLE", label);
  }
});

test("refuses a trusted-keys path that does not exist", () => {
  const e = refusal({ trustedKeysSource: path.join(__dirname, "no-such-entitlement.rs") });
  assert.equal(e.code, "TRUSTED_KEYS_UNREADABLE");
  assert.match(e.message, /cannot read the trusted-keys source/);
});

test("comments in the trusted table do not become key bytes", () => {
  // A `// (0x02, [...])` line must not be parsed as a second entry.
  const source = `${TEST_TRUSTED_SOURCE.replace(
    "];",
    `    // (0x02, [${Array(32).fill("0xFF").join(", ")}]),\n];`
  )}`;
  const keys = parseTrustedKeys(source);
  assert.deepEqual([...keys.keys()], [TEST_KEY_ID]);
});
