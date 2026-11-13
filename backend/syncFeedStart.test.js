"use strict";

/**
 * A device whose sync cursor is still 0 must be able to start pulling outside enforce mode.
 *
 * 13 Nov 2026: on the owner's desktop a saved Purchase Entry ("Saved to cloud") never reached POS
 * on the same machine until he signed out and back in. The purchase itself was fine - its lot was
 * stamped with the device's company, branch and location, the trigger published it, and the pull
 * predicate would have delivered it. The pull simply never ran. A device asks for the reference
 * bootstrap while its cursor is 0, and outside `FROOZERP_OPERATIONAL_SCOPE_MODE=enforce` (the
 * shipped default) `/api/sync/pull` answered that with 409 OPERATIONAL_SCOPE_REQUIRED. Only a
 * successful pull moves the cursor, so the device asked again every cycle and was refused every
 * cycle. The failed cycle also skipped the desktop's post-sync refresh, so the only stock that ever
 * reached that machine was the snapshot fetched at sign-in.
 *
 * Outside enforce the device's fill is that ordinary snapshot; the server now answers a bootstrap
 * request with the cursor the feed starts from, read under a lock, and the next pull carries the
 * purchase's lot like any other change.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  loadServerApp,
  probe,
  setQueryResponder,
  clearQueryResponder,
  setConnectionResponder,
  clearConnectionResponder,
} = require("./routeAuthCoverage");
const { issueDeviceSession } = require("./deviceSession");

/** Must match the throwaway key `routeAuthCoverage` pins into the environment before loading. */
const TEST_SIGNING_KEY = "route-auth-coverage-isolated-signing-key-000000";
const DEVICE_ID = "FZDEV-FEED-START";
const WATERMARK = "66";

const token = issueDeviceSession({
  userId: 7,
  deviceId: DEVICE_ID,
  companyId: 1,
  branchId: 1,
  role: "Owner",
  secret: TEST_SIGNING_KEY,
});

/** The query string the desktop sends (frontend/src/local/syncService.js `pullServerChanges`). */
const pullUrl = ({ cursor, bootstrap }) => `/api/sync/pull?${new URLSearchParams({
  user_id: "7",
  device_id: DEVICE_ID,
  company_id: "1",
  branch_id: "1",
  operational_location_id: "1",
  cursor,
  limit: "50",
  ...(bootstrap ? { bootstrap_protocol: "reference-v1" } : {}),
})}`;

const purchasedLot = {
  change_id: "67",
  branch_id: 1,
  entity_type: "inventory_lot",
  entity_id: "purchase-lot-op-1",
  operation_type: "UPSERT",
  version: 1,
  payload: { global_id: "purchase-lot-op-1", company_id: 1, branch_id: 1, operational_location_id: 1, remaining_qty: 9 },
  updated_at: "2026-11-13T19:05:32.846Z",
};

/** A legacy (non-enforce) sync context for user 7 on an approved device at branch 1, location 1. */
const respondAsSyncDatabase = (pulls) => (sql, values) => {
  if (/FROM users u\s+JOIN roles r/i.test(sql)) {
    return { rows: [{ id: 7, full_name: "Owner", company_id: 1, branch_id: 1, active: true, session_revocation_version: 0, role_name: "Owner" }] };
  }
  if (/SELECT \* FROM authorized_devices WHERE device_id/i.test(sql)) {
    return { rows: [{ device_id: DEVICE_ID, status: "APPROVED", assigned_branch_id: 1, company_id: 1 }] };
  }
  if (/FROM branches WHERE id = \$1/i.test(sql)) return { rows: [{ id: 1, company_id: 1, active: true }] };
  if (/FROM device_assignments da/i.test(sql)) return { rows: [{ operational_location_id: 1 }] };
  if (/^\s*UPDATE authorized_devices SET last_sync_at/i.test(sql)) return { rows: [], rowCount: 1 };
  if (/FROM sync_change_log/i.test(sql) && /change_id > \$4/.test(sql)) {
    pulls.push(values);
    return { rows: Number(values[3]) < Number(purchasedLot.change_id) ? [purchasedLot] : [] };
  }
  return undefined;
};

const withSyncDatabase = async (run) => {
  const app = loadServerApp();
  const pulls = [];
  const transaction = [];
  setQueryResponder(respondAsSyncDatabase(pulls));
  setConnectionResponder(() => ({
    release: () => {},
    query: async (text) => {
      const sql = String(typeof text === "object" && text ? text.text : text || "").trim();
      transaction.push(sql);
      if (/MAX\(change_id\)/i.test(sql)) return { rows: [{ high_watermark: WATERMARK }] };
      return { rows: [], rowCount: 0 };
    },
  }));
  try {
    return await run({ app, pulls, transaction });
  } finally {
    clearQueryResponder();
    clearConnectionResponder();
  }
};

const get = (app, url) => probe(app, "GET", url, { authorization: `Bearer ${token}` });

test("outside enforce, a device at cursor 0 is given the cursor its feed starts from, not a refusal", async () => {
  await withSyncDatabase(async ({ app, pulls, transaction }) => {
    const response = await get(app, pullUrl({ cursor: "0", bootstrap: true }));
    assert.equal(response.status, 200, response.text);
    assert.notEqual(response.code, "OPERATIONAL_SCOPE_REQUIRED");
    assert.deepEqual(response.body.changes, []);
    assert.equal(response.body.next_cursor, WATERMARK);
    assert.equal(response.body.has_more, false);
    // Nothing is replayed from the start of history: the device's fill is the ordinary snapshot.
    assert.equal(pulls.length, 0);
    // The watermark is read under the lock, inside a transaction, so a writer still holding a lower
    // change id cannot commit after it and be stepped over.
    const lock = transaction.findIndex((sql) => /^LOCK TABLE sync_change_log IN SHARE MODE$/i.test(sql));
    const read = transaction.findIndex((sql) => /MAX\(change_id\)/i.test(sql));
    assert.ok(transaction[0] === "BEGIN", transaction.join(" | "));
    assert.ok(lock > 0 && read > lock, transaction.join(" | "));
    assert.equal(transaction.at(-1), "COMMIT");
  });
});

test("the purchase saved after that reaches the device on its very next pull", async () => {
  await withSyncDatabase(async ({ app, pulls }) => {
    const start = await get(app, pullUrl({ cursor: "0", bootstrap: true }));
    assert.equal(start.status, 200, start.text);
    const next = await get(app, pullUrl({ cursor: start.body.next_cursor, bootstrap: false }));
    assert.equal(next.status, 200, next.text);
    assert.deepEqual(next.body.changes.map((change) => change.entity_id), ["purchase-lot-op-1"]);
    assert.equal(next.body.next_cursor, "67");
    // Read from the cursor it was given, for this device's company, branch and location.
    assert.deepEqual(pulls[0].slice(0, 4), [1, 1, 1, Number(WATERMARK)]);
  });
});

test("a device that is not approved is still refused before any cursor is handed out", async () => {
  await withSyncDatabase(async ({ app, transaction }) => {
    setQueryResponder((sql, values) => {
      if (/SELECT \* FROM authorized_devices WHERE device_id/i.test(sql)) {
        return { rows: [{ device_id: DEVICE_ID, status: "PENDING", assigned_branch_id: 1, company_id: 1 }] };
      }
      return respondAsSyncDatabase([])(sql, values);
    });
    const response = await get(app, pullUrl({ cursor: "0", bootstrap: true }));
    assert.equal(response.status, 403);
    assert.equal(response.body.next_cursor, undefined);
    assert.equal(transaction.length, 0);
  });
});
