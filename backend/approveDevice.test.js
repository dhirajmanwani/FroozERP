"use strict";

/**
 * The refusals in `scripts/approve-device.mjs`, proven without a database.
 *
 * ## Why this command exists at all
 *
 * Device approval lives in Settings, which needs a signed-in Owner, which needs `/login`, which
 * refuses any device that is not already approved. Correct, and the point of the gate — until the
 * shop's only device stops being approved, at which point there is no way in.
 *
 * That happened on 2026-09-08: "clear application data" during an uninstall took the local
 * database, the app generated itself a new device identity, and the cloud had never heard of it.
 * Everything else was fixed by then and the shop still could not open.
 *
 * ## Why the refusals are the thing to test
 *
 * The command writes to a live shop's database from a shell, so what it *declines* to do is its
 * entire safety. Two refusals matter most:
 *
 *   - it never inserts a device it has not seen, so a mistyped id cannot authorise a machine that
 *     has never registered;
 *   - it will not quietly undo a DISABLED or REVOKED status, because that was somebody's decision.
 *
 * A fake client is enough to prove all of it, and means these hold on every machine rather than
 * only where a database happens to be reachable.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const modulePath = pathToFileURL(path.join(__dirname, "..", "scripts", "approve-device.mjs")).href;

/** A client that answers the one SELECT and records every write. */
const fakeClient = (row) => {
  const writes = [];
  return {
    writes,
    query: async (sql, params) => {
      if (/^\s*SELECT/i.test(sql)) return { rows: row ? [row] : [] };
      writes.push({ sql, params });
      return { rows: [] };
    },
  };
};

const APPROVED = { device_id: "FZDEV-A", device_name: "Counter", status: "APPROVED", last_active_at: null };
const PENDING = { device_id: "FZDEV-A", device_name: "Counter", status: "PENDING", last_active_at: null };

test("a device id nobody has registered is refused, not created", async () => {
  // The important one. Inserting here would turn a typo into an authorised machine, and the id is
  // typed by hand off another computer's screen.
  const { approveDevice, REFUSALS } = await import(modulePath);
  const client = fakeClient(null);
  const result = await approveDevice(client, { deviceId: "FZDEV-TYPO", apply: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, REFUSALS.NO_DEVICE);
  assert.equal(client.writes.length, 0, "a refusal must write nothing");
  assert.match(result.message, /login screen/, "and must say where the right id comes from");
});

test("a deliberately blocked device is not quietly reinstated", async () => {
  const { approveDevice, REFUSALS, BLOCKED_STATUSES } = await import(modulePath);
  for (const status of BLOCKED_STATUSES) {
    const client = fakeClient({ ...PENDING, status });
    const result = await approveDevice(client, { deviceId: "FZDEV-A", apply: true });
    assert.equal(result.ok, false, `${status} must not be approved by default`);
    assert.equal(result.code, REFUSALS.DELIBERATELY_BLOCKED);
    assert.equal(client.writes.length, 0);
    assert.match(result.message, /--reinstate/, "and must name the flag that means it");
  }
});

test("--reinstate is what undoing a block looks like", async () => {
  // Not removed as a capability — made explicit. A maintainer who means it says so.
  const { approveDevice } = await import(modulePath);
  const client = fakeClient({ ...PENDING, status: "REVOKED" });
  const result = await approveDevice(client, { deviceId: "FZDEV-A", apply: true, reinstate: true });
  assert.equal(result.ok, true);
  assert.equal(client.writes.length, 1);
});

test("an already-approved device is a no-op that says so", async () => {
  // Re-running must not churn approved_at, and must not read as a failure either.
  const { approveDevice, REFUSALS } = await import(modulePath);
  const client = fakeClient(APPROVED);
  const result = await approveDevice(client, { deviceId: "FZDEV-A", apply: true });
  assert.equal(result.code, REFUSALS.ALREADY_APPROVED);
  assert.equal(client.writes.length, 0);
});

test("a dry run is the default, and writes nothing", async () => {
  // Same convention as run-cloud-migrations.js: a write to a live shop's database is the shape you
  // have to ask for.
  const { approveDevice } = await import(modulePath);
  const client = fakeClient(PENDING);
  const result = await approveDevice(client, { deviceId: "FZDEV-A" });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(client.writes.length, 0);
  assert.equal(result.plan.previousStatus, "PENDING");
});

test("applying sets APPROVED and nothing else", async () => {
  // Narrow on purpose. Assignments and permissions belong to the ordinary screens; a second,
  // unaudited way to grant them is not something a recovery command should install.
  const { approveDevice } = await import(modulePath);
  const client = fakeClient(PENDING);
  const result = await approveDevice(client, { deviceId: "FZDEV-A", apply: true });
  assert.equal(result.ok, true);
  assert.equal(client.writes.length, 1);
  const { sql } = client.writes[0];
  assert.match(sql, /UPDATE authorized_devices/);
  assert.match(sql, /status = 'APPROVED'/);
  assert.match(sql, /COALESCE\(approved_at, CURRENT_TIMESTAMP\)/, "an earlier approval date is history, not something to overwrite");
  assert.doesNotMatch(sql, /device_assignments|permissions|users/i, "it must not reach past the device row");
});

test("no device id at all is usage, not a crash", async () => {
  const { approveDevice, REFUSALS } = await import(modulePath);
  const result = await approveDevice(fakeClient(PENDING), {});
  assert.equal(result.code, REFUSALS.USAGE);
});
