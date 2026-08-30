"use strict";

/**
 * `POST /lots/transfer-stock` was an unscoped cross-tenant write, and is now refused.
 *
 * ## What was wrong
 *
 * The handler locked its two lots with `WHERE id = ANY($1::int[]) ... FOR UPDATE` - by primary key
 * and nothing else. No `company_id`, no `branch_id`, no `operational_location_id`, not even
 * `deleted_at`. Its only guard was `requireRateManager`, which reads a role and stops there. Put
 * together, any authenticated Owner or Admin could move any quantity between any two lot ids in
 * the database, across branches and across companies, and the two `stock_transactions` rows the
 * handler writes take their `branch_id` from the lots it just moved - so the movement was booked
 * to the victim's branch, by the victim's branch, with nothing anywhere naming the actor's own.
 *
 * It was not on `LEGACY_WRITE_ROUTES`, so unlike its neighbour `PUT /lots/:lotId` it was not
 * retired, and the app-wide 426 gate never reached it because `operationalScopeMode` defaults to
 * `off`.
 *
 * ## Why retired rather than scoped
 *
 * There is nothing on the legacy path to scope *to*. `req.v3OperationalContext` is undefined there,
 * which is exactly how the rest of the retired list came to fail open. `/api/v3/transfers` is the
 * replacement and already does the whole job properly, and nothing calls the legacy route -
 * `operationalWriteRoutes.test.js` asserts the client has neither the call nor the button.
 *
 * ## Why these tests drive the app instead of reading the source
 *
 * The claim is behavioural: a real Owner session, aimed at lots this test declares to belong to
 * another company, must not reach the statements that would move them. A source-text assertion
 * would pass on a build where the refusal was registered after the handler. The harness pins
 * `FROOZERP_OPERATIONAL_SCOPE_MODE=off`, which is the mode that ships, so what is proved here is
 * proved in the configuration that actually runs.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  loadServerApp,
  probe,
  listRegisteredRoutes,
  startQueryRecording,
  stopQueryRecording,
  setConnectionResponder,
  clearConnectionResponder,
} = require("./routeAuthCoverage");
const { issueDeviceSession } = require("./deviceSession");
const { isRetiredLegacyWrite, retiredLegacyWriteReplacement } = require("./operationalScope");

/** Must match the throwaway key `routeAuthCoverage` pins into the environment before loading. */
const TEST_SIGNING_KEY = "route-auth-coverage-isolated-signing-key-000000";

const ATTACKER_COMPANY = 1;
const ATTACKER_BRANCH = 1;
const VICTIM_COMPANY = 2;
const VICTIM_BRANCH = 77;
const VICTIM_LOCATION = 770;

/** Two lots that belong to a different company and a different branch from the caller's session. */
const FOREIGN_FROM_LOT = 8801;
const FOREIGN_TO_LOT = 8802;
/** A lot in the caller's own company but a branch they are not signed in to. */
const SIBLING_BRANCH_LOT = 8803;

const token = (overrides = {}) => issueDeviceSession({
  userId: 7,
  deviceId: "FZDEV-LOT-TRANSFER",
  companyId: ATTACKER_COMPANY,
  branchId: ATTACKER_BRANCH,
  role: "Owner",
  secret: TEST_SIGNING_KEY,
  ...overrides,
});

const foreignLot = (id, overrides = {}) => ({
  id,
  product_id: 500 + id,
  company_id: VICTIM_COMPANY,
  branch_id: VICTIM_BRANCH,
  operational_location_id: VICTIM_LOCATION,
  remaining_qty: "1000.000",
  batch_status: "ACTIVE",
  deleted_at: null,
  ...overrides,
});

/**
 * A transaction client that would happily carry the theft out.
 *
 * It answers the role lookup with an Owner and the lot lookup with the victim's two lots, so the
 * handler has everything it needs to complete. That is the point: the refusal has to happen before
 * any of it, and the evidence is that this object is never asked a single question.
 */
const complicitClient = () => {
  const statements = [];
  return {
    statements,
    query: async (text, values) => {
      const sql = String(typeof text === "object" && text ? text.text : text || "")
        .replace(/\s+/g, " ")
        .trim();
      statements.push({ sql, values: values || [] });
      if (/FROM users u JOIN roles r/i.test(sql)) {
        return { rows: [{ id: 7, full_name: "Owner", role_name: "Owner" }], rowCount: 1 };
      }
      if (/FROM inventory_batches WHERE id = ANY/i.test(sql)) {
        return { rows: [foreignLot(FOREIGN_FROM_LOT), foreignLot(FOREIGN_TO_LOT)], rowCount: 2 };
      }
      if (/UPDATE inventory_batches/i.test(sql)) {
        return { rows: [foreignLot(Number(values?.[2]) || FOREIGN_FROM_LOT)], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
};

let app;

const attempt = async (body, sessionToken = token()) => {
  if (!app) app = loadServerApp();
  const client = complicitClient();
  setConnectionResponder(() => client);
  startQueryRecording();
  try {
    const response = await probe(app, "POST", "/lots/transfer-stock", {
      authorization: `Bearer ${sessionToken}`,
      "content-type": "application/json",
    }, body);
    return { response, client, poolStatements: stopQueryRecording() };
  } finally {
    stopQueryRecording();
    clearConnectionResponder();
  }
};

test("an Owner cannot move another company's stock", async () => {
  // The whole finding, in one request. The session is a genuine, correctly signed Owner of
  // company 1; the lots named belong to company 2, branch 77. Before the fix this returned 200 and
  // the quantity had moved.
  const { response, client, poolStatements } = await attempt({
    from_lot_id: FOREIGN_FROM_LOT,
    to_lot_id: FOREIGN_TO_LOT,
    quantity: 250,
    reason: "Cross-tenant move",
  });
  assert.equal(response.status, 426);
  assert.equal(response.code, "CLIENT_UPGRADE_REQUIRED");
  assert.equal(response.body.replacement_route, "/api/v3/transfers");
  // The refusal is only worth anything if it happens before the transaction. If this ever fails,
  // read the statement it names: the handler ran and the lots were reachable.
  assert.deepEqual(
    client.statements.map((entry) => entry.sql),
    [],
    "the handler must never open its transaction",
  );
  assert.deepEqual(
    poolStatements.filter((sql) => /inventory_batches|stock_transactions|product_audit_trail/i.test(sql)),
    [],
    "no stock table may be touched by a refused request",
  );
});

test("nor another branch of their own company", async () => {
  // Company alone is not the boundary the business cares about: `docs/stock-distribution-decision.md`
  // says a counter may sell only what is on its own shelf. A move between two branches of one
  // company is the same silent shortage, one org chart level down.
  const { response, client } = await attempt({
    from_lot_id: SIBLING_BRANCH_LOT,
    to_lot_id: FOREIGN_TO_LOT,
    quantity: 1,
    reason: "Sibling branch move",
  });
  assert.equal(response.status, 426);
  assert.equal(response.code, "CLIENT_UPGRADE_REQUIRED");
  assert.deepEqual(client.statements, []);
});

test("the refusal does not depend on the body being well formed", async () => {
  // A refusal that only fires on a valid payload is a validation error wearing a security label.
  // An empty body must be refused for the same reason and with the same code.
  const { response, client } = await attempt({});
  assert.equal(response.status, 426);
  assert.equal(response.code, "CLIENT_UPGRADE_REQUIRED");
  assert.deepEqual(client.statements, []);
});

test("an anonymous caller is told nothing, not told to upgrade", async () => {
  // Ordering, at this route specifically. The retirement gate is mounted behind authentication so a
  // stranger probing the path learns it exists only after presenting a session this server signed.
  if (!app) app = loadServerApp();
  const response = await probe(app, "POST", "/lots/transfer-stock", {
    "content-type": "application/json",
  }, { from_lot_id: FOREIGN_FROM_LOT, to_lot_id: FOREIGN_TO_LOT, quantity: 1, reason: "x" });
  assert.equal(response.status, 401);
});

test("the route stays registered, so an old client gets an upgrade hint and not a 404", () => {
  // `operationalWriteRoutes.test.js` pins the same arrangement from the source side. Asserted here
  // from the live registration table as well, because "retired" must never become "deleted": a 404
  // tells a counter running last month's build nothing about what to do next.
  const registered = listRegisteredRoutes(loadServerApp())
    .some((route) => route.method === "POST" && route.path === "/lots/transfer-stock");
  assert.ok(registered, "POST /lots/transfer-stock must remain registered");
});

test("the replacement is named, and is not itself refused", () => {
  // Retiring a route whose replacement is also refused removes the feature rather than upgrading
  // it. Both halves are asserted so neither can be changed alone.
  assert.equal(isRetiredLegacyWrite("POST", "/lots/transfer-stock"), true);
  assert.equal(retiredLegacyWriteReplacement("POST", "/lots/transfer-stock"), "/api/v3/transfers");
  assert.equal(isRetiredLegacyWrite("POST", "/api/v3/transfers"), false);
  assert.equal(isRetiredLegacyWrite("POST", "/api/v3/transfers/7/actions/dispatch"), false);
});
