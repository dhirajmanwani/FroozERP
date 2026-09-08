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

/**
 * A client that answers SELECTs from a script and records every write.
 *
 * Transaction control is not a write. Counting BEGIN and COMMIT as writes would make
 * "a refusal writes nothing" pass or fail on bookkeeping rather than on what reached a table,
 * which is the property that matters.
 */
const fakeClient = (rowsByTurn) => {
  const answers = Array.isArray(rowsByTurn) ? [...rowsByTurn] : [rowsByTurn];
  const writes = [];
  return {
    writes,
    query: async (sql, params) => {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [] };
      if (/^\s*SELECT/i.test(sql)) {
        const next = answers.length > 1 ? answers.shift() : answers[0];
        return { rows: next ? [next] : [] };
      }
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

test("applying without --counter sets APPROVED and nothing else", async () => {
  // Posting is opt-in. Approval and posting are different decisions, and asking for one must not
  // quietly perform the other.
  const { approveDevice } = await import(modulePath);
  const client = fakeClient(PENDING);
  const result = await approveDevice(client, { deviceId: "FZDEV-A", apply: true });
  assert.equal(result.ok, true);
  assert.equal(client.writes.length, 1);
  const { sql } = client.writes[0];
  assert.match(sql, /UPDATE authorized_devices/);
  assert.match(sql, /status = 'APPROVED'/);
  assert.match(sql, /COALESCE\(approved_at, CURRENT_TIMESTAMP\)/, "an earlier approval date is history, not something to overwrite");
  assert.doesNotMatch(sql, /device_assignments|users/i, "without --counter it must not reach past the device row");
});

test("no device id at all is usage, not a crash", async () => {
  const { approveDevice, REFUSALS } = await import(modulePath);
  const result = await approveDevice(fakeClient(PENDING), {});
  assert.equal(result.code, REFUSALS.USAGE);
});

/**
 * Posting, which the first version of this command deliberately did not do.
 *
 * The reasoning was that assignments belong to Branches & Counters. That was wrong for the one case
 * this command exists to serve: a machine with no posting has no operational scope, so every screen
 * filters to nothing and Branches & Counters itself refuses with "User and device do not share an
 * approved operational location" — the very screen that would fix it. Approve-only moved the
 * maintainer one step further into the same deadlock.
 */

const COUNTER = { id: 1, location_name: "Main Branch Counter", company_id: 1, branch_id: 1, active: true, branch_name: "Main Branch" };
const NO_POSTING = { generation: 0, active_count: 0 };
const STAFFED = { count: 1 };

test("posting to a counter that does not exist is refused", async () => {
  const { approveDevice, REFUSALS } = await import(modulePath);
  const client = fakeClient([PENDING, null]);
  const result = await approveDevice(client, { deviceId: "FZDEV-A", counterId: 99, apply: true });
  assert.equal(result.code, REFUSALS.NO_COUNTER);
  assert.equal(client.writes.length, 0, "and the approval must not happen either");
});

test("posting a machine where nobody is posted is refused", async () => {
  // The half-fix that looks like a fix. `requireAssignmentOwner` reads manage_assignments from the
  // device assignment *and* the staff assignment; a machine posted where no person is posted still
  // fails login with DEVICE_LOCATION_MISMATCH, which is indistinguishable from having done nothing.
  const { approveDevice, REFUSALS } = await import(modulePath);
  const client = fakeClient([PENDING, COUNTER, NO_POSTING, { count: 0 }]);
  const result = await approveDevice(client, { deviceId: "FZDEV-A", counterId: 1, apply: true });
  assert.equal(result.code, REFUSALS.NOBODY_AT_COUNTER);
  assert.equal(client.writes.length, 0);
  assert.match(result.message, /needs both/);
});

test("a machine already standing at a counter is not moved from here", async () => {
  // A relocation carries an audit trail, and that belongs in the app.
  const { approveDevice, REFUSALS } = await import(modulePath);
  const client = fakeClient([PENDING, COUNTER, { generation: 2, active_count: 1 }, STAFFED]);
  const result = await approveDevice(client, { deviceId: "FZDEV-A", counterId: 1, apply: true });
  assert.equal(result.code, REFUSALS.ALREADY_POSTED);
  assert.equal(client.writes.length, 0);
});

test("--counter approves and posts, together", async () => {
  const { approveDevice } = await import(modulePath);
  const client = fakeClient([PENDING, COUNTER, NO_POSTING, STAFFED]);
  const result = await approveDevice(client, { deviceId: "FZDEV-A", counterId: 1, apply: true });
  assert.equal(result.ok, true);
  assert.equal(client.writes.length, 2, "the approval and the posting");
  assert.match(client.writes[0].sql, /UPDATE authorized_devices/);
  assert.match(client.writes[1].sql, /INSERT INTO device_assignments/);
  // The generation continues rather than restarting: (device_id, assignment_generation) is unique,
  // and a machine whose earlier posting was ended keeps its old rows.
  assert.equal(client.writes[1].params[5], 1);
  assert.equal(result.plan.counter.name, "Main Branch Counter");
});

test("a dry run with --counter still writes nothing, and says what it would post", async () => {
  const { approveDevice } = await import(modulePath);
  const client = fakeClient([PENDING, COUNTER, NO_POSTING, STAFFED]);
  const result = await approveDevice(client, { deviceId: "FZDEV-A", counterId: 1 });
  assert.equal(result.dryRun, true);
  assert.equal(client.writes.length, 0);
  assert.equal(result.plan.counter.id, 1);
});

test("an already-approved device can still be posted to a counter", async () => {
  // The case that shipped broken. The ALREADY_APPROVED refusal returned before the posting ran, so
  // a device approved an hour earlier and posted nowhere -- the exact state this command creates
  // when run without --counter -- could never be posted at all. It answered "Nothing to do." to a
  // request that plainly had something to do.
  //
  // Nothing above covered it: the no-op test passes no counter, and the posting tests start from
  // PENDING. Two correct tests, and the gap between them was the bug.
  const { approveDevice } = await import(modulePath);
  const client = fakeClient([APPROVED, COUNTER, NO_POSTING, STAFFED]);
  const result = await approveDevice(client, { deviceId: "FZDEV-A", counterId: 1, apply: true });
  assert.equal(result.ok, true, "an approved device with --counter must proceed");
  assert.equal(result.plan.previousStatus, "APPROVED");
  assert.equal(client.writes.length, 2);
  assert.match(client.writes[1].sql, /INSERT INTO device_assignments/);
});

test("without a counter, an already-approved device is still a no-op, and says how to post it", async () => {
  // The control for the test above, and the message has to lead somewhere: "Nothing to do." on its
  // own is what sent the maintainer back here.
  const { approveDevice, REFUSALS } = await import(modulePath);
  const client = fakeClient(APPROVED);
  const result = await approveDevice(client, { deviceId: "FZDEV-A", apply: true });
  assert.equal(result.code, REFUSALS.ALREADY_APPROVED);
  assert.equal(client.writes.length, 0);
  assert.match(result.message, /--counter/);
});
