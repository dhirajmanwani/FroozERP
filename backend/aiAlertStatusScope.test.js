"use strict";

/**
 * Acknowledging an alert works at all, and works on your own branch's alerts only.
 *
 * ## The two bugs
 *
 * `PATCH /api/ai/alerts/:id` and `PATCH /api/ai/reminders/:id` each chose one of three SQL strings
 * and then bound the same four values to whichever was chosen. Only the `SNOOZE` string referenced
 * `$4`, so `ACKNOWLEDGE` and `RESOLVE` handed Postgres four parameters for a statement naming
 * three. Postgres refuses that outright — `bind message supplies 4 parameters, but prepared
 * statement requires 3` — so two of the three actions on the alerts screen could never have
 * worked against a real database. Nothing caught it: `queryArity.test.js` reads the string literals
 * passed to `pool.query`, and these were passed a variable.
 *
 * The second is tenancy. `WHERE id = $1` with no branch predicate let a signed-in user of one shop
 * acknowledge, snooze or resolve another shop's alerts, and the ids are sequential. The handler
 * then answered `res.json(undefined)` when nothing matched, which is HTTP 200 with an empty body —
 * a silent success for an action that did nothing.
 *
 * ## How this is tested
 *
 * The responder below refuses a statement the way Postgres refuses it, on parameter count, and
 * matches rows on both `id` and `branch_id` the way the database would. So the first bug shows up
 * here as the 500 it would be in production rather than as a difference in source text, and the
 * second shows up as somebody else's alert changing status.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  loadServerApp,
  probe,
  setQueryResponder,
  clearQueryResponder,
} = require("./routeAuthCoverage");
const { issueDeviceSession } = require("./deviceSession");
const { buildStatusChange } = require("./aiBusinessAssistantService");

/** Must match the throwaway key `routeAuthCoverage` pins into the environment before loading. */
const TEST_SIGNING_KEY = "route-auth-coverage-isolated-signing-key-000000";

/* --------------------------------------------------------------------- the statement builder */

test("every action binds exactly the parameters its statement names", () => {
  // The bug, stated as the rule it broke. A prepared statement's parameter count is its highest
  // `$N`; supplying any other number is rejected by Postgres before a row is touched.
  for (const table of ["ai_alerts", "ai_reminders"]) {
    for (const action of ["ACKNOWLEDGE", "SNOOZE", "RESOLVE"]) {
      const { text, values } = buildStatusChange({
        table, action, id: 5, branchId: 2, userId: 7, ownerNotes: "", snoozedUntil: null,
      });
      const highest = Math.max(...[...text.matchAll(/\$(\d+)/g)].map(([, position]) => Number(position)));
      assert.equal(highest, values.length, `${table} ${action} names $${highest} and binds ${values.length}`);
    }
  }
});

test("every action is scoped to one branch", () => {
  for (const table of ["ai_alerts", "ai_reminders"]) {
    for (const action of ["ACKNOWLEDGE", "SNOOZE", "RESOLVE"]) {
      const { text, values } = buildStatusChange({
        table, action, id: 5, branchId: 2, userId: 7, ownerNotes: "", snoozedUntil: null,
      });
      const branch = text.match(/branch_id = \$(\d+)/);
      assert.ok(branch, `${table} ${action} must carry a branch predicate`);
      assert.equal(values[Number(branch[1]) - 1], 2, "and must bind the session's branch to it");
    }
  }
});

test("an unknown action produces no statement rather than a wide one", () => {
  assert.equal(
    buildStatusChange({ table: "ai_alerts", action: "DELETE", id: 5, branchId: 2, userId: 7 }),
    null,
  );
});

test("the table cannot be chosen from outside this module", () => {
  assert.throws(
    () => buildStatusChange({ table: "users", action: "RESOLVE", id: 5, branchId: 2, userId: 7 }),
    /FROST_UNKNOWN_STATUS_TABLE/,
  );
});

/* ------------------------------------------------------------------------ the routes for real */

/** One alert in each shop, with ids a caller could walk between. */
const ROWS = {
  ai_alerts: [
    { id: 11, branch_id: 1, status: "OPEN", title: "Main Shop stock low", owner_notes: null },
    { id: 12, branch_id: 2, status: "OPEN", title: "Market Yard stock low", owner_notes: null },
  ],
  ai_reminders: [
    { id: 21, branch_id: 1, status: "OPEN", title: "Main Shop follow-up", owner_notes: null },
    { id: 22, branch_id: 2, status: "OPEN", title: "Market Yard follow-up", owner_notes: null },
  ],
};

/**
 * Refuse a mis-bound statement the way Postgres does, then apply it to the fixture.
 *
 * Returns the row only when both `id` and `branch_id` match, which is what makes a cross-branch
 * attempt come back as no rows rather than as a changed row somewhere else.
 */
const applyStatement = (sql, values) => {
  const positions = [...sql.matchAll(/\$(\d+)/g)].map(([, position]) => Number(position));
  const required = positions.length ? Math.max(...positions) : 0;
  if (values.length !== required) {
    throw new Error(`bind message supplies ${values.length} parameters, but prepared statement requires ${required}`);
  }
  const value = (position) => values[position - 1];
  const table = sql.match(/UPDATE (\w+)/)[1];
  const idPosition = Number(sql.match(/WHERE id = \$(\d+)/)[1]);
  const branchPredicate = sql.match(/branch_id = \$(\d+)/);
  const status = sql.match(/SET status = '(\w+)'/)[1];
  const row = (ROWS[table] || []).find((candidate) => candidate.id === value(idPosition)
    && (!branchPredicate || candidate.branch_id === value(Number(branchPredicate[1]))));
  if (!row) return { rows: [], rowCount: 0 };
  return { rows: [{ ...row, status }], rowCount: 1 };
};

const PERMISSION_USER = {
  rows: [{ id: 7, full_name: "Rahul", username: "rahul", branch_id: 2, role_name: "Admin", permissions: {} }],
  rowCount: 1,
};

let app;

/**
 * Drive one status change as a user whose session belongs to `branchId`.
 *
 * The permission lookup is answered so the handler actually runs; everything else the FROST stack
 * touches on the way past — audit rows, usage counters — answers emptily, so a missing side effect
 * cannot be mistaken for the refusal under test.
 */
const changeStatus = async (route, { id, action, branchId, snoozedUntil = null }) => {
  if (!app) app = loadServerApp();
  const token = issueDeviceSession({
    userId: 7,
    deviceId: "FZDEV-ALERT-STATUS",
    companyId: 1,
    branchId,
    role: "Admin",
    secret: TEST_SIGNING_KEY,
  });
  const statements = [];
  setQueryResponder((sql, values) => {
    statements.push({ sql, values });
    if (/FROM\s+users\s+u\s+JOIN\s+roles\s+r/i.test(sql)) return PERMISSION_USER;
    if (/^\s*UPDATE ai_(alerts|reminders)/.test(sql)) return applyStatement(sql, values || []);
    return { rows: [], rowCount: 0 };
  });
  try {
    const response = await probe(
      app,
      "PATCH",
      `${route}/${id}`,
      { authorization: `Bearer ${token}`, "content-type": "application/json" },
      { action, snoozed_until: snoozedUntil, owner_notes: "" },
    );
    return { response, statements };
  } finally {
    clearQueryResponder();
  }
};

test("acknowledging an alert succeeds, which it never did", async () => {
  // Straight reproduction: before the fix this statement was refused by the database and the route
  // answered 500. The status in the response proves the ACKNOWLEDGE branch is what ran.
  const { response } = await changeStatus("/api/ai/alerts", { id: 12, action: "ACKNOWLEDGE", branchId: 2 });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, "ACKNOWLEDGED");
  assert.equal(response.body.id, 12);
});

test("resolving an alert succeeds too", async () => {
  const { response } = await changeStatus("/api/ai/alerts", { id: 12, action: "RESOLVE", branchId: 2 });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, "RESOLVED");
});

test("snoozing still works, and still carries its timestamp", async () => {
  const { response, statements } = await changeStatus("/api/ai/alerts", {
    id: 12, action: "SNOOZE", branchId: 2, snoozedUntil: "2026-10-01T09:00:00.000Z",
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, "SNOOZED");
  const update = statements.find(({ sql }) => /UPDATE ai_alerts/.test(sql));
  assert.ok(update.values.includes("2026-10-01T09:00:00.000Z"), "the requested snooze time must be bound");
});

test("reminders behave identically", async () => {
  for (const [action, status] of [["ACKNOWLEDGE", "ACKNOWLEDGED"], ["RESOLVE", "RESOLVED"], ["SNOOZE", "SNOOZED"]]) {
    const { response } = await changeStatus("/api/ai/reminders", { id: 22, action, branchId: 2 });
    assert.equal(response.status, 200, `${action} must succeed`);
    assert.equal(response.body.status, status);
  }
});

test("another branch's alert cannot be acknowledged", async () => {
  // Alert 11 belongs to the Main Shop; this session belongs to the Market Yard. The id is one away
  // from their own, so this is not a hypothetical reach.
  const { response } = await changeStatus("/api/ai/alerts", { id: 11, action: "ACKNOWLEDGE", branchId: 2 });
  assert.equal(response.status, 404);
});

test("another branch's reminder cannot be resolved", async () => {
  const { response } = await changeStatus("/api/ai/reminders", { id: 21, action: "RESOLVE", branchId: 2 });
  assert.equal(response.status, 404);
});

test("a no-op is never reported as a success", async () => {
  // `res.json(undefined)` sent HTTP 200 with an empty body, so the screen marked the alert
  // acknowledged and the next refresh silently put it back.
  const { response } = await changeStatus("/api/ai/alerts", { id: 999, action: "ACKNOWLEDGE", branchId: 2 });
  assert.equal(response.status, 404);
  assert.ok(response.body?.message, "and says what was not found");
});

test("the update statement carries the session's branch, not the request's", async () => {
  const { statements } = await changeStatus("/api/ai/alerts", { id: 12, action: "ACKNOWLEDGE", branchId: 2 });
  const update = statements.find(({ sql }) => /UPDATE ai_alerts/.test(sql));
  assert.match(update.sql, /WHERE id = \$1 AND branch_id = \$4/);
  assert.deepEqual(update.values, [12, 7, "", 2]);
});
