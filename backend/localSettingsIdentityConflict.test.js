/**
 * A machine carrying more than one device record must still load its settings.
 *
 * This used to throw DEVICE_IDENTITY_CONFLICT, which `desktopGateway` turns into an HTTP 503 — so a
 * profile with two identity rows (a restored backup, a copied profile) could not load settings at
 * all in LOCAL_ONLY mode, with no cloud to appeal to. A metadata problem stopping a shop is exactly
 * what design §2.5 forbids: "fail into the running state, not out of it".
 *
 * Selection must also match `select_identity_under_conflict` in `src-tauri/src/local_db.rs`, or the
 * Rust and Node paths would disagree about which device this machine is.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { readLocalSettingsBundle } = require("./localSettingsStore");

const buildProfile = (rows) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "froozerp-identity-conflict-"));
  const databasePath = path.join(dir, "froozerp-local.sqlite3");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE local_device_identity (
      device_id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      company_id TEXT,
      registration_status TEXT NOT NULL,
      last_seen_at TEXT
    );
    CREATE TABLE local_settings (
      id TEXT PRIMARY KEY,
      branch_id TEXT,
      setting_key TEXT NOT NULL,
      setting_value TEXT NOT NULL,
      deleted_at TEXT
    );
    INSERT INTO local_settings VALUES ('b', '1', 'businessSettings', '{"business_name":"Frooz"}', NULL);
  `);
  const insert = database.prepare(
    "INSERT INTO local_device_identity (device_id, branch_id, company_id, registration_status, last_seen_at) VALUES (?, ?, ?, ?, ?)"
  );
  for (const row of rows) {
    insert.run(row.device_id, row.branch_id || "1", row.company_id || "1", row.registration_status, row.last_seen_at ?? null);
  }
  database.close();
  return databasePath;
};

test("two approved device records still load settings, and report the conflict", () => {
  const databasePath = buildProfile([
    { device_id: "FZDEV-AAA", registration_status: "approved", last_seen_at: "2026-08-01T00:00:00.000Z" },
    { device_id: "FZDEV-ZZZ", registration_status: "approved", last_seen_at: "2026-08-18T00:00:00.000Z" },
  ]);

  const bundle = readLocalSettingsBundle(databasePath, "1");

  assert.equal(bundle.settings.businessSettings.business_name, "Frooz", "settings must still load");
  assert.equal(bundle.canonicalDeviceId, "FZDEV-ZZZ", "most recently seen wins");
  assert.equal(bundle.identityConflict.kind, "MULTIPLE_APPROVED");
  assert.deepEqual(bundle.identityConflict.deviceIds, ["FZDEV-AAA", "FZDEV-ZZZ"]);
  assert.equal(bundle.identityConflict.selected, "FZDEV-ZZZ");
});

test("two provisional device records no longer block settings entirely", () => {
  // The case that used to return HTTP 503 and stop the app.
  const databasePath = buildProfile([
    { device_id: "FZDEV-BBB", registration_status: "pending", last_seen_at: "2026-08-02T00:00:00.000Z" },
    { device_id: "FZDEV-CCC", registration_status: "pending", last_seen_at: "2026-08-17T00:00:00.000Z" },
  ]);

  const bundle = readLocalSettingsBundle(databasePath, "1");

  assert.equal(bundle.canonicalDeviceId, "FZDEV-CCC");
  assert.equal(bundle.identityConflict.kind, "MULTIPLE_PROVISIONAL");
});

test("an approved record beats a more recently seen unapproved one", () => {
  const databasePath = buildProfile([
    { device_id: "FZDEV-APPROVED", registration_status: "approved", last_seen_at: "2026-08-01T00:00:00.000Z" },
    { device_id: "FZDEV-PENDING", registration_status: "pending", last_seen_at: "2026-08-18T00:00:00.000Z" },
  ]);

  const bundle = readLocalSettingsBundle(databasePath, "1");

  assert.equal(bundle.canonicalDeviceId, "FZDEV-APPROVED", "approval outranks recency");
  assert.equal(bundle.identityConflict, undefined, "one approved record is not a conflict");
});

test("a missing last_seen_at sorts as oldest rather than throwing", () => {
  const databasePath = buildProfile([
    { device_id: "FZDEV-NULLSEEN", registration_status: "approved", last_seen_at: null },
    { device_id: "FZDEV-SEEN", registration_status: "approved", last_seen_at: "2026-08-10T00:00:00.000Z" },
  ]);

  const bundle = readLocalSettingsBundle(databasePath, "1");

  assert.equal(bundle.canonicalDeviceId, "FZDEV-SEEN");
});

test("selection is stable across repeated reads", () => {
  const databasePath = buildProfile([
    { device_id: "FZDEV-ONE", registration_status: "pending", last_seen_at: "2026-08-05T00:00:00.000Z" },
    { device_id: "FZDEV-TWO", registration_status: "pending", last_seen_at: "2026-08-05T00:00:00.000Z" },
  ]);

  const first = readLocalSettingsBundle(databasePath, "1").canonicalDeviceId;
  const second = readLocalSettingsBundle(databasePath, "1").canonicalDeviceId;
  assert.equal(first, second, "identical timestamps must tie-break deterministically");
  assert.equal(first, "FZDEV-ONE", "device_id ascending is the final tie-break");
});

test("a single device record reports no conflict at all", () => {
  const databasePath = buildProfile([
    { device_id: "FZDEV-SOLO", registration_status: "approved", last_seen_at: "2026-08-18T00:00:00.000Z" },
  ]);

  const bundle = readLocalSettingsBundle(databasePath, "1");
  assert.equal(bundle.canonicalDeviceId, "FZDEV-SOLO");
  assert.equal(bundle.identityConflict, undefined);
});
