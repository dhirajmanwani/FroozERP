import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  OFFLINE_CREDENTIAL_DISCARD_REASONS,
  OFFLINE_CREDENTIAL_SOURCES,
  isUsableOfflineCredentialRecord,
  normalizeKnownDeviceIds,
  resolveOfflineCredentialSource,
} from "./offlineCredentialSource.js";
import { buildOfflineSessionRecord, verifyOfflineSessionRecord } from "./offlineSession.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appSource = fs.readFileSync(path.join(here, "..", "App.jsx"), "utf8");

// The measured state of the maintainer's laptop, from docs/backlog-1.0.72.md item 5.
const APPROVED_DEVICE_ID = "FZDEV-DELL-1781852580596";
const ABSENT_DEVICE_ID = "FZDEV-629FF107-4C2E-4E0E-9A38-0B6B1F4C7E11";

const credential = (overrides = {}) => ({
  usernameLower: "dhirajmanwani",
  verifier: "verifier-bytes",
  salt: "salt-bytes",
  deviceId: APPROVED_DEVICE_ID,
  branchId: "1",
  user: { id: 7, role: "Owner", branch_id: 1 },
  ...overrides,
});

test("SQLite offline_auth wins over a localStorage session", () => {
  const sqliteRecord = credential();
  const staleRecord = credential({ usernameLower: "owner", deviceId: ABSENT_DEVICE_ID });
  const result = resolveOfflineCredentialSource({
    snapshotOfflineAuth: sqliteRecord,
    localStorageSession: staleRecord,
    knownDeviceIds: [APPROVED_DEVICE_ID],
    activeDeviceId: APPROVED_DEVICE_ID,
  });
  assert.equal(result.source, OFFLINE_CREDENTIAL_SOURCES.SQLITE);
  assert.equal(result.record, sqliteRecord);
  assert.equal(result.deviceId, APPROVED_DEVICE_ID);
  assert.equal(result.notice, "");
  assert.deepEqual(
    result.discarded.map((entry) => [entry.source, entry.reason]),
    [[OFFLINE_CREDENTIAL_SOURCES.LOCAL_STORAGE, OFFLINE_CREDENTIAL_DISCARD_REASONS.SUPERSEDED_BY_SQLITE]]
  );
});

test("SQLite offline_auth still wins when localStorage names the same approved device", () => {
  const sqliteRecord = credential({ verifier: "sqlite-verifier" });
  const result = resolveOfflineCredentialSource({
    snapshotOfflineAuth: sqliteRecord,
    localStorageSession: credential({ verifier: "localstorage-verifier" }),
    knownDeviceIds: [APPROVED_DEVICE_ID],
    activeDeviceId: APPROVED_DEVICE_ID,
  });
  assert.equal(result.source, OFFLINE_CREDENTIAL_SOURCES.SQLITE);
  assert.equal(result.record.verifier, "sqlite-verifier");
});

test("a localStorage session naming a device absent from local_device_identity is discarded", () => {
  // Backlog item 5: the stale record names FZDEV-629FF107-… which exists in no table.
  const result = resolveOfflineCredentialSource({
    snapshotOfflineAuth: {},
    localStorageSession: credential({ usernameLower: "owner", deviceId: ABSENT_DEVICE_ID }),
    knownDeviceIds: [APPROVED_DEVICE_ID],
    activeDeviceId: APPROVED_DEVICE_ID,
  });
  assert.equal(result.record, null);
  assert.equal(result.source, OFFLINE_CREDENTIAL_SOURCES.NONE);
  assert.deepEqual(
    result.discarded.map((entry) => [entry.source, entry.reason, entry.deviceId]),
    [[
      OFFLINE_CREDENTIAL_SOURCES.LOCAL_STORAGE,
      OFFLINE_CREDENTIAL_DISCARD_REASONS.UNKNOWN_DEVICE,
      ABSENT_DEVICE_ID,
    ]]
  );
  assert.match(result.notice, /not registered locally/);
});

test("a localStorage session naming a known device is still honoured", () => {
  const record = credential({ usernameLower: "owner" });
  const result = resolveOfflineCredentialSource({
    snapshotOfflineAuth: {},
    localStorageSession: record,
    knownDeviceIds: [APPROVED_DEVICE_ID],
    activeDeviceId: APPROVED_DEVICE_ID,
  });
  assert.equal(result.source, OFFLINE_CREDENTIAL_SOURCES.LOCAL_STORAGE);
  assert.equal(result.record, record);
  assert.equal(result.deviceId, APPROVED_DEVICE_ID);
  assert.equal(result.discarded.length, 0);
  assert.equal(result.notice, "");
});

test("a localStorage session naming a known but non-active device is left to device-binding checks", () => {
  const secondaryDevice = "FZDEV-SPARE-1000000000001";
  const record = credential({ deviceId: secondaryDevice });
  const result = resolveOfflineCredentialSource({
    snapshotOfflineAuth: {},
    localStorageSession: record,
    knownDeviceIds: [APPROVED_DEVICE_ID, secondaryDevice],
    activeDeviceId: APPROVED_DEVICE_ID,
  });
  assert.equal(result.source, OFFLINE_CREDENTIAL_SOURCES.LOCAL_STORAGE);
  assert.equal(result.record, record);
});

test("the snapshot device identity counts as a known device id", () => {
  const record = credential();
  const result = resolveOfflineCredentialSource({
    snapshotOfflineAuth: {},
    localStorageSession: record,
    knownDeviceIds: [undefined, APPROVED_DEVICE_ID],
    activeDeviceId: "",
  });
  assert.equal(result.source, OFFLINE_CREDENTIAL_SOURCES.LOCAL_STORAGE);
});

test("a device-unbound localStorage session is discarded once identities are known", () => {
  const result = resolveOfflineCredentialSource({
    snapshotOfflineAuth: {},
    localStorageSession: credential({ deviceId: "" }),
    knownDeviceIds: [APPROVED_DEVICE_ID],
    activeDeviceId: APPROVED_DEVICE_ID,
  });
  assert.equal(result.record, null);
  assert.equal(result.discarded[0].reason, OFFLINE_CREDENTIAL_DISCARD_REASONS.UNBOUND_DEVICE);
  assert.match(result.notice, /not registered locally/);
});

test("without any known device identity the localStorage session is honoured unchanged", () => {
  // Browser runtime: there is no SQLite and no local_device_identity, so the absent-device rule
  // cannot be evaluated. This path must not regress.
  const record = credential({ deviceId: ABSENT_DEVICE_ID });
  const result = resolveOfflineCredentialSource({
    snapshotOfflineAuth: null,
    localStorageSession: record,
    knownDeviceIds: [],
    activeDeviceId: "",
  });
  assert.equal(result.source, OFFLINE_CREDENTIAL_SOURCES.LOCAL_STORAGE);
  assert.equal(result.record, record);
  assert.equal(result.discarded.length, 0);
});

test("the placeholder device id is not a real identity and never validates a stale record", () => {
  assert.deepEqual(normalizeKnownDeviceIds(["default", "DEFAULT", "  "]), []);
  const stale = credential({ deviceId: "default" });
  const result = resolveOfflineCredentialSource({
    snapshotOfflineAuth: {},
    localStorageSession: stale,
    knownDeviceIds: ["default", APPROVED_DEVICE_ID],
    activeDeviceId: "default",
  });
  assert.equal(result.record, null);
  assert.equal(result.source, OFFLINE_CREDENTIAL_SOURCES.NONE);
  assert.equal(result.discarded[0].reason, OFFLINE_CREDENTIAL_DISCARD_REASONS.UNKNOWN_DEVICE);
});

test("device ids are compared as opaque strings, never coerced", () => {
  assert.deepEqual(normalizeKnownDeviceIds([" 004 ", "004", 4, null, "default"]), ["004"]);
  const numericLike = resolveOfflineCredentialSource({
    snapshotOfflineAuth: {},
    localStorageSession: credential({ deviceId: "4" }),
    knownDeviceIds: ["004"],
    activeDeviceId: "004",
  });
  assert.equal(numericLike.record, null);
  assert.equal(numericLike.discarded[0].reason, OFFLINE_CREDENTIAL_DISCARD_REASONS.UNKNOWN_DEVICE);
});

test("empty and malformed inputs resolve to no credential rather than throwing", () => {
  const empty = resolveOfflineCredentialSource();
  assert.equal(empty.record, null);
  assert.equal(empty.source, OFFLINE_CREDENTIAL_SOURCES.NONE);
  assert.equal(empty.discarded.length, 0);
  assert.equal(empty.notice, "");

  const emptySnapshotRecord = resolveOfflineCredentialSource({
    snapshotOfflineAuth: {},
    localStorageSession: null,
    knownDeviceIds: [APPROVED_DEVICE_ID],
    activeDeviceId: APPROVED_DEVICE_ID,
  });
  assert.equal(emptySnapshotRecord.record, null);
  assert.equal(emptySnapshotRecord.discarded.length, 0);

  [undefined, null, "", "not-json", 0, 42, [], [credential()], true].forEach((value) => {
    const result = resolveOfflineCredentialSource({
      snapshotOfflineAuth: value,
      localStorageSession: value,
      knownDeviceIds: [APPROVED_DEVICE_ID],
      activeDeviceId: APPROVED_DEVICE_ID,
    });
    assert.equal(result.record, null);
    assert.equal(result.source, OFFLINE_CREDENTIAL_SOURCES.NONE);
  });
});

test("partially written credential records are not treated as credentials", () => {
  assert.equal(isUsableOfflineCredentialRecord(credential()), true);
  assert.equal(isUsableOfflineCredentialRecord(credential({ verifier: "" })), false);
  assert.equal(isUsableOfflineCredentialRecord(credential({ salt: "   " })), false);
  assert.equal(isUsableOfflineCredentialRecord(credential({ usernameLower: "" })), false);
  assert.equal(isUsableOfflineCredentialRecord({ username_lower: "OWNER", verifier: "v", salt: "s" }), true);

  const malformedSqlite = resolveOfflineCredentialSource({
    snapshotOfflineAuth: credential({ verifier: "" }),
    localStorageSession: credential({ usernameLower: "owner" }),
    knownDeviceIds: [APPROVED_DEVICE_ID],
    activeDeviceId: APPROVED_DEVICE_ID,
  });
  assert.equal(malformedSqlite.source, OFFLINE_CREDENTIAL_SOURCES.LOCAL_STORAGE);
  assert.equal(
    malformedSqlite.discarded[0].reason,
    OFFLINE_CREDENTIAL_DISCARD_REASONS.MALFORMED
  );
});

test("snake_case snapshot records are read the same as camelCase ones", () => {
  const snakeRecord = { username_lower: "dhirajmanwani", verifier: "v", salt: "s", device_id: APPROVED_DEVICE_ID };
  const result = resolveOfflineCredentialSource({
    snapshotOfflineAuth: {},
    localStorageSession: snakeRecord,
    knownDeviceIds: [APPROVED_DEVICE_ID],
    activeDeviceId: APPROVED_DEVICE_ID,
  });
  assert.equal(result.source, OFFLINE_CREDENTIAL_SOURCES.LOCAL_STORAGE);
  assert.equal(result.deviceId, APPROVED_DEVICE_ID);
});

test("regression, backlog item 5: a stale localStorage record cannot shadow the SQLite credential", async () => {
  // The laptop's real shape: SQLite holds offline_auth::FZDEV-DELL-…::dhirajmanwani, localStorage
  // holds a record for a different user on a device id that exists in no table.
  const sqliteRecord = await buildOfflineSessionRecord({
    username: "dhirajmanwani",
    password: "laptop-offline-password",
    user: { id: 7, role: "Owner", branch_id: 1 },
    deviceId: APPROVED_DEVICE_ID,
    branchId: 1,
  });
  const staleLocalStorage = await buildOfflineSessionRecord({
    username: "owner",
    password: "some-other-password",
    user: { id: 1, role: "Owner", branch_id: 1 },
    deviceId: ABSENT_DEVICE_ID,
    branchId: 1,
  });
  const knownDeviceIds = [APPROVED_DEVICE_ID];

  // The credential the device actually holds still signs in.
  const resolved = resolveOfflineCredentialSource({
    snapshotOfflineAuth: sqliteRecord,
    localStorageSession: staleLocalStorage,
    knownDeviceIds,
    activeDeviceId: APPROVED_DEVICE_ID,
  });
  const verified = await verifyOfflineSessionRecord(resolved.record, {
    username: "dhirajmanwani",
    password: "laptop-offline-password",
    deviceId: APPROVED_DEVICE_ID,
  });
  assert.equal(verified.ok, true);

  // The failure mode as observed: signing in as the stale record's user found no SQLite row, and
  // the old unconditional localStorage fallback produced DEVICE_MISMATCH — which reads as a
  // permanent lockout on a device that holds a valid credential.
  // Old precedence: snapshot.offline_auth empty for this username -> readOfflineSession().
  const legacyResult = await verifyOfflineSessionRecord(staleLocalStorage, {
    username: "owner",
    password: "some-other-password",
    deviceId: APPROVED_DEVICE_ID,
  });
  assert.equal(legacyResult.ok, false);
  assert.equal(legacyResult.code, "DEVICE_MISMATCH");

  // With the precedence rules the stale record is discarded, so the device is never told it is
  // the wrong device.
  const repaired = resolveOfflineCredentialSource({
    snapshotOfflineAuth: {},
    localStorageSession: staleLocalStorage,
    knownDeviceIds,
    activeDeviceId: APPROVED_DEVICE_ID,
  });
  const repairedResult = await verifyOfflineSessionRecord(repaired.record, {
    username: "owner",
    password: "some-other-password",
    deviceId: APPROVED_DEVICE_ID,
  });
  assert.equal(repairedResult.ok, false);
  assert.equal(repairedResult.code, "NO_SESSION");
  assert.notEqual(repairedResult.code, "DEVICE_MISMATCH");
});

test("offline login resolves its credential through the precedence module, not a raw fallback", () => {
  const start = appSource.indexOf("const continueOffline = async");
  const end = appSource.indexOf("const loadProducts = async", start);
  assert.ok(start > 0 && end > start);
  const source = appSource.slice(start, end);
  assert.match(source, /resolveOfflineCredentialSource\(\{/);
  assert.match(source, /snapshotOfflineAuth: snapshot\?\.offline_auth/);
  assert.match(source, /localStorageSession: readOfflineSession\(\)/);
  assert.match(source, /knownDeviceIds: \[latestDevice\?\.device_id, snapshot\?\.device_identity\?\.device_id\]/);
  assert.match(source, /verifyOfflineSessionRecord\(credentialSource\.record/);
  assert.match(source, /offline-credential-source-discarded/);
  // The bug itself: snapshot.offline_auth checked, then localStorage used unconditionally.
  assert.doesNotMatch(source, /hasObjectContent\(snapshot\?\.offline_auth\)/);
  assert.doesNotMatch(source, /authenticateOfflineSession\(/);
  assert.match(appSource, /import \{ resolveOfflineCredentialSource \} from "\.\/local\/offlineCredentialSource"/);
});
