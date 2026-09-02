"use strict";

/**
 * The door onto order routing.
 *
 * `transferCustomerOrderBranch` has existed, tested, since earlier today -- and reachable by
 * nothing. That is the third time this session a finished engine has sat behind no route, so these
 * tests check the door as much as the engine: that it exists, that it refuses the wrong people, and
 * that a customer's name and address do not travel to a shop with no business seeing them.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SOURCE = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

const handler = (needle) => {
  const start = SOURCE.indexOf(needle);
  assert.ok(start > 0, `route ${needle} is not registered`);
  return SOURCE.slice(start, start + 3200);
};

test("both order-routing routes exist and are authorised", () => {
  // The engine was built this morning and mounted nowhere. A route is what makes it real.
  for (const route of [
    'app.get("/api/orders/unassigned"',
    'app.post("/api/orders/:orderGlobalId/assign"',
  ]) {
    assert.match(handler(route), /requireOrderRouter\(req/, `${route} must check who is asking`);
    assert.match(handler(route), /ORDER_ROUTING_DENIED/, `${route} must refuse by name`);
  }
});

test("routing an order needs the right company, not just the right role", () => {
  // The hole closed in /lots/transfer-stock today was a role check with no company check: any
  // Owner could move any other company's stock. This helper must not repeat it.
  const guard = handler("const requireOrderRouter = async (req");
  assert.match(guard, /RATE_MANAGER_ROLES\.has\(user\.role_name\)/, "role is checked");
  assert.match(
    guard,
    /parsePositiveInteger\(user\.company_id\) !== companyId/,
    "and the company must match, or role alone would authorise a cross-tenant write",
  );
  // Re-read from the database rather than trusted from the token, so a demotion takes effect at
  // once rather than when the session happens to expire.
  assert.match(guard, /FROM users u\s+JOIN roles r/);
});

test("the unassigned queue is scoped to the caller's own company", () => {
  const route = handler('app.get("/api/orders/unassigned"');
  assert.match(route, /co\.company_id = \$1/, "another company's orders must not be listed");
  assert.match(route, /co\.branch_id IS NULL/, "only orders nobody is handling yet");
  assert.match(route, /co\.deleted_at IS NULL/);
  assert.deepEqual(
    (route.match(/\[router\.companyId\]/g) || []).length,
    1,
    "the company must come from the verified router, never from the request",
  );
});

test("an unassigned order carries a customer's details, so it is never synced to a counter", () => {
  // docs/order-routing-decision.md: the pull predicate scopes by branch and location and has no
  // notion of role, so a company-wide unassigned order would land on every till -- including
  // cashier machines -- carrying a name, a mobile number and a home address.
  //
  // This is why the queue is an authenticated read and not a sync entity. The check is that it
  // stayed that way: `customer_order` must not have been added to the pull road's reference types,
  // which bypass branch scoping entirely.
  assert.match(
    SOURCE,
    /app\.get\("\/api\/orders\/unassigned"/,
    "the queue must be a read over the API",
  );
  const bootstrap = fs.readFileSync(path.join(__dirname, "syncReferenceBootstrap.js"), "utf8");
  const referenceTypes = bootstrap.match(/COMPANY_REFERENCE_ENTITY_TYPES = Object\.freeze\(\[([^\]]*)\]/);
  assert.ok(referenceTypes, "could not read the company-wide reference types");
  assert.doesNotMatch(
    referenceTypes[1],
    /customer_order/,
    "an order on the company-wide list would reach every counter in the business",
  );
});

test("assigning reports how many shops were told, and the refusals keep their meaning", () => {
  const route = handler('app.post("/api/orders/:orderGlobalId/assign"');
  // Two rows when it moved between shops, one when assigned for the first time. Surfaced so the
  // rule can be seen holding rather than assumed.
  assert.match(route, /change_rows: result\.changes\.length/);
  // A refusal that arrives as 500 tells an operator nothing and invites a retry that cannot work.
  assert.match(route, /result\.code === "NOT_FOUND" \? 404/);
  assert.match(route, /result\.code === "VALIDATION_ERROR" \? 400/);
  assert.match(route, /ROLLBACK/, "a refused assignment must leave nothing behind");
});
