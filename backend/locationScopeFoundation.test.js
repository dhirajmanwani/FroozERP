"use strict";

/**
 * The three things warehouse-to-shop distribution will be built on top of, and which were wrong.
 *
 * `docs/stock-distribution-decision.md` rules that stock belongs to the place it physically sits
 * and that a counter may sell only what is on its own shelf. Three pieces of the machinery that
 * has to enforce that did not agree with each other:
 *
 * 1. **The startup schema could not serve the sync protocol it ships with.**
 *    `syncReferenceBootstrap.js` filters lots on `company_id`, `branch_id` *and*
 *    `operational_location_id`, but `inventory_batches` only ever received the first and third from
 *    `migrations/cloud/009_operational_location_foundation.sql`. Neither of the two startup schema
 *    paths added them, so a database bootstrapped by `server.js` alone had a bootstrap query that
 *    could not run. Two paths, because `initializeDatabase` and `ensureProductEntrySchema` both
 *    `CREATE TABLE IF NOT EXISTS inventory_batches`; whichever runs first defines the table, so
 *    fixing one and not the other makes the outcome depend on call order. That is why the
 *    assertions below check both and not "at least one".
 *
 * 2. **The incremental pull was location-blind in the mode that actually ships.**
 *    `operationalScopeMode` defaults to `off` and nothing in the repository sets it, so the
 *    non-ENFORCE branch of `/api/sync/pull` is the branch that runs - and it filtered company and
 *    branch but not location, while the reference bootstrap it continues filters all three. A
 *    warehouse and a shop counter under one branch pulled each other's stock.
 *
 * 3. **The cloud migration runner skipped 011.** That migration installs
 *    `froozerp_publish_inventory_lot_sync`, the only mechanism that publishes an inventory-lot
 *    change to a device. Missing it means no stock movement of any kind reaches a counter except
 *    through a full reference bootstrap - which is to say, distribution would appear to work and
 *    silently never arrive.
 *
 * Item 2 is driven against the real app rather than read out of the source, because what matters is
 * the value *bound* to the new predicate: a source-text check would pass on a version that filtered
 * on a location the caller supplied, or on one that is always NULL.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  loadServerApp,
  probe,
  setQueryResponder,
  clearQueryResponder,
} = require("./routeAuthCoverage");
const { issueDeviceSession } = require("./deviceSession");

const SERVER_SOURCE = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const BOOTSTRAP_SOURCE = fs.readFileSync(path.join(__dirname, "syncReferenceBootstrap.js"), "utf8");
const MIGRATION_009 = fs.readFileSync(
  path.join(__dirname, "migrations/cloud/009_operational_location_foundation.sql"),
  "utf8"
);
const RUNNER_SOURCE = fs.readFileSync(
  path.join(__dirname, "../scripts/run-cloud-migrations.js"),
  "utf8"
);

/* ------------------------------------------------------------------ *
 * 1. Both startup schema paths carry the operational-location columns  *
 * ------------------------------------------------------------------ */

const allIndexesOf = (haystack, needle) => {
  const found = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return found;
    found.push(at);
    from = at + needle.length;
  }
};

const INITIALIZE_DATABASE_AT = SERVER_SOURCE.indexOf("const initializeDatabase = async () =>");
const ENSURE_PRODUCT_ENTRY_AT = SERVER_SOURCE.indexOf("const ensureProductEntrySchema = async (");

const LOCATION_SCOPE_STATEMENTS = [
  "ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS company_id INTEGER;",
  "ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS operational_location_id INTEGER;",
  "CREATE INDEX IF NOT EXISTS inventory_batches_location_fifo_idx",
];

test("the two schema paths this file is about both exist and are distinct", () => {
  // Every assertion below is positional. If either anchor moves or is renamed, they would silently
  // measure nothing, so the anchors are checked first.
  assert.ok(INITIALIZE_DATABASE_AT > 0, "initializeDatabase must be findable");
  assert.ok(ENSURE_PRODUCT_ENTRY_AT > INITIALIZE_DATABASE_AT, "ensureProductEntrySchema follows it");
  assert.equal(
    (SERVER_SOURCE.match(/CREATE TABLE IF NOT EXISTS inventory_batches \(/g) || []).length,
    2,
    "there are exactly two startup definitions of inventory_batches; a third would need its own case here",
  );
});

for (const statement of LOCATION_SCOPE_STATEMENTS) {
  test(`both startup schema paths run: ${statement.slice(0, 62).trim()}`, () => {
    // "One of the two" is the actual bug. Asserted as one occurrence in each region rather than as
    // a count of two, so moving both copies into one path cannot pass.
    const occurrences = allIndexesOf(SERVER_SOURCE, statement);
    const inInitialize = occurrences.filter(
      (at) => at > INITIALIZE_DATABASE_AT && at < ENSURE_PRODUCT_ENTRY_AT
    );
    const inEnsure = occurrences.filter((at) => at > ENSURE_PRODUCT_ENTRY_AT);
    assert.equal(inInitialize.length, 1, `initializeDatabase must run it exactly once: ${statement}`);
    assert.equal(inEnsure.length, 1, `ensureProductEntrySchema must run it exactly once: ${statement}`);
  });
}

test("the startup columns are bare, because the tables they would reference do not exist yet", () => {
  // Migration 009 declares these with `REFERENCES companies(id)` / `REFERENCES
  // operational_locations(id)`. Startup must not: `companies` is created by migration 006 and
  // `operational_locations` by 009, and neither is created at startup - so a foreign key here would
  // abort the entire bootstrap transaction on precisely the fresh database this repairs. Migration
  // 009 remains the owner of the constraints; startup only guarantees the columns exist.
  // `ai_settings.company_id` is bare in the same bootstrap for the same reason.
  assert.match(MIGRATION_009, /ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies\(id\);/);
  assert.doesNotMatch(
    SERVER_SOURCE,
    /ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES/,
  );
  assert.doesNotMatch(
    SERVER_SOURCE,
    /ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS operational_location_id INTEGER REFERENCES/,
  );
  assert.doesNotMatch(SERVER_SOURCE, /CREATE TABLE IF NOT EXISTS operational_locations\b/);
});

test("the columns exist because the shipped bootstrap query needs them", () => {
  // The reason, pinned. If the bootstrap ever stops filtering on all three, the assertions above
  // become cargo cult rather than a requirement, and this is where that shows up.
  assert.match(
    BOOTSTRAP_SOURCE,
    /FROM inventory_batches ib[\s\S]{0,400}?WHERE ib\.company_id = \$1[\s\S]{0,200}?AND ib\.branch_id = \$2[\s\S]{0,200}?AND ib\.operational_location_id = \$3/,
  );
});

test("the location FIFO index matches the one migration 009 creates", () => {
  // Two definitions of one index name is how they drift. Compared column list against column list.
  const columns = "(company_id, branch_id, operational_location_id, product_id, purchase_date, created_at, id)";
  assert.ok(MIGRATION_009.includes(`ON inventory_batches${columns}`));
  assert.equal(
    allIndexesOf(SERVER_SOURCE, `ON inventory_batches${columns}`).length,
    2,
    "both startup paths must build the index over the same columns as migration 009",
  );
});

/* --------------------------------------------------------- *
 * 2. The default-mode incremental pull filters by location   *
 * --------------------------------------------------------- */

/** Must match the throwaway key `routeAuthCoverage` pins into the environment before loading. */
const TEST_SIGNING_KEY = "route-auth-coverage-isolated-signing-key-000000";

const COMPANY_ID = 1;
const BRANCH_ID = 4;
const WAREHOUSE_LOCATION = 40;
const DEVICE_ID = "FZDEV-PULL-LOCATION";
const USER_ID = 7;

const pullToken = () => issueDeviceSession({
  userId: USER_ID,
  deviceId: DEVICE_ID,
  companyId: COMPANY_ID,
  branchId: BRANCH_ID,
  role: "Owner",
  secret: TEST_SIGNING_KEY,
});

const changeRow = (changeId, locationId) => ({
  change_id: changeId,
  branch_id: BRANCH_ID,
  entity_type: "inventory_lot",
  entity_id: `inventory-lot-${changeId}`,
  operation_type: "UPSERT",
  version: 1,
  payload: { operational_location_id: locationId },
  updated_at: "2026-08-30T04:00:00.000Z",
});

/**
 * Drive one real `/api/sync/pull` and hand back the change-log statement it issued.
 *
 * `assignedLocationId` is what `device_assignments` is scripted to hold for this device - `null`
 * meaning the device has no active assignment naming a location, which is every device on a
 * deployment that has not rolled assignments out.
 */
const pullOnce = async (assignedLocationId) => {
  const app = loadServerApp();
  let changeLogCall = null;
  setQueryResponder((sql, values) => {
    if (/FROM users u\s+JOIN roles r/i.test(sql)) {
      return {
        rows: [{
          id: USER_ID,
          full_name: "Owner",
          company_id: COMPANY_ID,
          branch_id: BRANCH_ID,
          active: true,
          session_revocation_version: 0,
          role_name: "Owner",
        }],
        rowCount: 1,
      };
    }
    if (/FROM authorized_devices WHERE device_id = \$1/i.test(sql)) {
      return {
        rows: [{
          device_id: DEVICE_ID,
          status: "APPROVED",
          assigned_branch_id: BRANCH_ID,
          company_id: COMPANY_ID,
          last_sync_at: null,
          sync_status: "IDLE",
        }],
        rowCount: 1,
      };
    }
    if (/FROM branches WHERE id = \$1/i.test(sql)) {
      return { rows: [{ id: BRANCH_ID, company_id: COMPANY_ID, active: true }], rowCount: 1 };
    }
    if (/FROM device_assignments da/i.test(sql)) {
      return assignedLocationId === null
        ? { rows: [], rowCount: 0 }
        : { rows: [{ operational_location_id: assignedLocationId }], rowCount: 1 };
    }
    if (/FROM sync_change_log/i.test(sql)) {
      changeLogCall = { sql, values };
      return { rows: [changeRow(11, WAREHOUSE_LOCATION)], rowCount: 1 };
    }
    // Everything else - the trailing `UPDATE authorized_devices SET last_sync_at` and anything a
    // future edit adds - answers empty rather than falling through. The harness default *rejects*
    // outside recording mode, which surfaces as a 500 from the handler's catch and would read as
    // "the predicate broke the pull" when it only means the script was incomplete.
    return { rows: [], rowCount: 0 };
  });
  try {
    const response = await probe(
      app,
      "GET",
      `/api/sync/pull?user_id=${USER_ID}&device_id=${DEVICE_ID}&company_id=${COMPANY_ID}&branch_id=${BRANCH_ID}&cursor=0&limit=50`,
      { authorization: `Bearer ${pullToken()}` },
    );
    return { response, changeLogCall };
  } finally {
    clearQueryResponder();
  }
};

test("the default-mode pull binds the device's own operational location", async () => {
  // The claim, driven. `operationalScopeMode` is pinned to `off` by the harness, which is the
  // shipped default, so this is the branch that actually runs on a real counter.
  const { response, changeLogCall } = await pullOnce(WAREHOUSE_LOCATION);
  assert.equal(response.status, 200, "the pull must still complete");
  assert.ok(changeLogCall, "the pull must have queried sync_change_log");
  assert.match(changeLogCall.sql, /operational_location_id = \$3/);
  assert.deepEqual(
    changeLogCall.values,
    [COMPANY_ID, BRANCH_ID, WAREHOUSE_LOCATION, 0, 51],
    "company, branch, the device's location, the cursor, and limit + 1",
  );
});

test("a device with no location assignment keeps the branch-wide view it has today", async () => {
  // The NULL decision, and the one that would have broken every existing counter if it had gone the
  // other way. `= NULL` matches nothing, so a strict predicate on a device whose location nobody has
  // stated would have returned an empty change feed for ever, silently. Such a device is not an
  // error - it is a device on a deployment that has not rolled out `device_assignments` - so it is
  // bound as NULL and the predicate stands down.
  const { response, changeLogCall } = await pullOnce(null);
  assert.equal(response.status, 200);
  assert.equal(changeLogCall.values[2], null);
  assert.match(changeLogCall.sql, /\$3::INTEGER IS NULL/);
});

test("change rows that carry no location are delivered to everyone in the branch", async () => {
  // The second NULL, on the other side of the comparison. Everything `logSyncChange` writes outside
  // ENFORCE has a NULL `operational_location_id`, because `requireSyncContext` returns
  // `operationalLocationId: null` there, and so does every row written before migration 009 added
  // the column. Excluding those would empty every counter's incremental feed of its whole history.
  const { changeLogCall } = await pullOnce(WAREHOUSE_LOCATION);
  assert.match(changeLogCall.sql, /OR operational_location_id IS NULL/);
});

test("the location a pull filters on is the device's, never the caller's to choose", async () => {
  // `operational_location_id` is one of the fields `rejectDeviceSessionSubstitution` does not pin
  // outside ENFORCE, so if the handler ever read it off the query string a counter could name the
  // warehouse and pull its stock. It is read from `device_assignments` for that reason.
  assert.match(
    SERVER_SOURCE,
    /FROM device_assignments da\s+WHERE da\.device_id = \$1\s+AND da\.active = TRUE/,
  );
  assert.match(SERVER_SOURCE, /deviceLocationId: parsePositiveInteger\(/);
  assert.match(SERVER_SOURCE, /context\.deviceLocationId \?\? null, cursor, limit \+ 1/);
});

test("the canonical write scope stays NULL outside ENFORCE", async () => {
  // `deviceLocationId` is deliberately a second, weaker field. `operationalLocationId` authorises
  // writes and is only canonical once `createOperationalScopeService` has proved the user and the
  // device share an approved assignment; quietly filling it in from `device_assignments` would hand
  // the legacy path an authority it never established. The response reports the canonical one.
  const { response } = await pullOnce(WAREHOUSE_LOCATION);
  assert.equal(response.body.operational_location_id, null);
});

/* --------------------------------------- *
 * 3. The cloud migration runner list       *
 * --------------------------------------- */

const runnerMigrations = (RUNNER_SOURCE.match(/backend\/migrations\/cloud\/[0-9A-Za-z_]+\.sql/g) || []);

test("the migration runner applies 011, which is what publishes stock changes to devices", () => {
  // Without `froozerp_publish_inventory_lot_sync` no inventory-lot change reaches a counter except
  // through a full reference bootstrap. A distribution feature built on top would appear to work on
  // the server and silently never arrive at the shop.
  assert.ok(
    runnerMigrations.includes("backend/migrations/cloud/011_inventory_incremental_publication.sql"),
    "011 must be in scripts/run-cloud-migrations.js",
  );
});

test("the runner list is in numeric order", () => {
  // The list is applied in the order it is written, inside one transaction. 011 depends on the
  // tables 009 creates and on the columns 010 adds; out of order it fails, and a reader skimming an
  // ordered list is also far likelier to notice a gap.
  const numbers = runnerMigrations.map((file) => Number(file.split("/").pop().slice(0, 3)));
  assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));
  assert.equal(new Set(numbers).size, numbers.length, "no migration may be listed twice");
});

test("every file the runner names exists on disk", () => {
  // The runner has no guard of its own: it reads a hand-written array and `fs.readFileSync` throws
  // only once it is already connected to a database, mid-transaction. A name that does not exist,
  // or a file renamed without updating the list, is caught here instead.
  for (const file of runnerMigrations) {
    assert.ok(
      fs.existsSync(path.join(__dirname, "..", file)),
      `${file} is named by scripts/run-cloud-migrations.js but is not on disk`,
    );
  }
});
