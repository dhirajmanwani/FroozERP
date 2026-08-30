"use strict";

/**
 * Auth-hardening A-4e: the remaining protocol-v3 write routes must decide who may write.
 *
 * A-4d wired `authorizePermission` into `operationalV3.js` and used it on the three supplier master
 * routes, because those are the ones the shipped Accounts screen posts to. It stopped there. Seven
 * other write routes in the same file were left declaring `{ write: true }` and nothing else, which
 * buys a scope check and no authority check at all: any signed-in employee holding a session for a
 * counter terminal could place a purchase order, receive goods into stock, raise a supplier bill,
 * settle it against a payment, move stock between shops, or change what a terminal sells and at what
 * rate. `write: true` reads like a guard and is not one — it asks whether the *device* may write,
 * never whether the *person* may.
 *
 * None of these seven are called by the shipped client (nothing under `frontend/src` or
 * `src-tauri/src` names them), so this closes an API hole rather than changing what any screen can
 * do, and no permission-key migration is needed — every key used here already exists and is already
 * seeded.
 *
 * The tests are behavioural, not textual: each route is registered into a stand-in app with an
 * authorizer that refuses, and the assertion is that the handler never ran. A source-shaped
 * assertion would keep passing if `guard` stopped consulting the authorizer.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  paymentAllocationPermissions,
  registerOperationalV3Routes,
} = require("./operationalV3");

const operationalSource = fs.readFileSync(path.join(__dirname, "operationalV3.js"), "utf8");
const scopeSource = fs.readFileSync(path.join(__dirname, "scopeManagement.js"), "utf8");
const backendSource = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

const ownerContext = {
  user_id: 1,
  device_id: "FZDEV-A4E",
  company_id: 1,
  branch_id: 1,
  operational_location_id: 10,
  role: "Owner",
  fixed_operational: false,
  device_permissions: { consolidated_reports: true, manage_assignments: true },
  staff_permissions: { consolidated_reports: true, manage_assignments: true },
};

const fakeResponse = () => ({
  statusCode: 200,
  payload: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.payload = payload;
    return this;
  },
});

/**
 * The routes as the app actually receives them, plus every database call and permission question.
 *
 * The database stub answers every statement with no rows, so a handler that gets past the guard
 * still runs — and its calls land in `queries`. That is the point: "the handler never ran" is
 * asserted by an empty `queries`, which no amount of rewriting inside the handler can fake.
 */
const registerRoutes = ({ authorizePermission } = {}) => {
  const routes = [];
  const queries = [];
  const asked = [];
  const app = {};
  for (const method of ["get", "post", "put", "delete"]) {
    app[method] = (routePath, ...handlers) => routes.push({ method, path: routePath, handler: handlers.at(-1) });
  }
  const database = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [] };
    },
  };
  registerOperationalV3Routes({
    app,
    database,
    resolveContext: async () => ({ context: ownerContext }),
    sendScopeError: () => {
      throw new Error("the scope check must not be what refuses these requests");
    },
    ...(authorizePermission
      ? {
        authorizePermission: async (req, key) => {
          asked.push(key);
          return authorizePermission(req, key);
        },
      }
      : {}),
  });
  return {
    queries,
    asked,
    find: (method, routePath) => {
      const route = routes.find((entry) => entry.method === method && entry.path === routePath);
      assert.ok(route, `${method.toUpperCase()} ${routePath} is no longer registered; this list is stale`);
      return route;
    },
  };
};

const requestFor = ({ method, path: routePath, body = {}, params = {} }) => ({
  method: method.toUpperCase(),
  path: routePath,
  params,
  query: {},
  body,
});

/**
 * Every write route this stage guards, with the key it must demand and why that key.
 *
 * `keys` is exhaustive and exact. A route naming a key not listed here fails, which is what stops
 * someone reaching for a broad key (`settings`, `reports`) to make a 403 go away, and what stops the
 * opposite mistake of quietly widening one of these later.
 *
 * None of these tables exist in `server.js` at all — `purchase_orders`, `goods_receipts`,
 * `supplier_bills`, `payment_allocations` and `inventory_transfers` are protocol-v3 only — so there
 * was no non-v3 handler to copy a key from. Each key is the one the shipped client gates the module
 * that owns the row on, which is also the key the seeded roles already grant and deny deliberately.
 */
const GUARDED_WRITES = [
  {
    method: "put",
    path: "/api/v3/location-products/:productId",
    params: { productId: "5" },
    keys: ["inventory"],
    why: "decides what a terminal may sell and at what rate; `products` is the Inventory module in the client",
  },
  {
    method: "post",
    path: "/api/v3/purchase-orders",
    keys: ["purchases"],
    why: "commits the shop to an order with a supplier",
  },
  {
    method: "post",
    path: "/api/v3/goods-receipts",
    keys: ["purchases"],
    why: "receives purchased stock, opening inventory lots at the supplier's cost",
  },
  {
    method: "post",
    path: "/api/v3/supplier-bills",
    keys: ["purchases"],
    why: "raises the invoice that becomes payable",
  },
  {
    method: "post",
    path: "/api/v3/payment-allocations",
    body: { payment_entity_type: "SUPPLIER_PAYMENT", target_entity_type: "SUPPLIER_BILL" },
    keys: ["supplier_payments"],
    why: "decides which supplier bill a recorded payment settles",
  },
  {
    method: "post",
    path: "/api/v3/transfers",
    keys: ["inventory"],
    why: "reserves source stock for a move between locations",
  },
  {
    method: "post",
    path: "/api/v3/transfers/:transferId/actions/:action",
    params: { transferId: "1", action: "dispatch" },
    keys: ["inventory"],
    why: "moves remaining_qty between locations and opens and closes lots as it goes",
  },
];

/** The A-4d routes, guarded already, re-checked here because the same `guard` now serves both. */
const SUPPLIER_WRITES = [
  { method: "post", path: "/api/v3/suppliers", keys: ["supplier_accounts"] },
  { method: "put", path: "/api/v3/suppliers/:supplierId", params: { supplierId: "3" }, keys: ["supplier_accounts"] },
  { method: "delete", path: "/api/v3/suppliers/:supplierId", params: { supplierId: "3" }, keys: ["supplier_accounts"] },
];

const ALL_GUARDED = [...GUARDED_WRITES, ...SUPPLIER_WRITES];

test("a caller without the permission is refused before the route reaches the database", async () => {
  for (const route of ALL_GUARDED) {
    const app = registerRoutes({ authorizePermission: async () => null });
    const res = fakeResponse();
    await app.find(route.method, route.path).handler(requestFor(route), res);
    assert.equal(
      res.statusCode,
      403,
      `${route.method.toUpperCase()} ${route.path} answered ${res.statusCode} to a caller with no permission — it ${route.why || "writes business data"}`,
    );
    assert.equal(res.payload.code, "OPERATIONAL_PERMISSION_REQUIRED");
    assert.deepEqual(
      app.queries,
      [],
      `${route.method.toUpperCase()} ${route.path} touched the database before deciding whether the caller may`,
    );
  }
});

test("each write route demands exactly the permission keys chosen for it", async () => {
  // The authorizer grants everything, so the guard asks every key it intends to require and the
  // handler then runs on a stub database and usually fails its own validation. That failure is not
  // interesting here — the questions were already asked, and they are what this pins.
  const consoleError = console.error;
  console.error = () => {};
  try {
    for (const route of ALL_GUARDED) {
      const app = registerRoutes({ authorizePermission: async () => ({ id: 1, role_name: "Owner" }) });
      const res = fakeResponse();
      await app.find(route.method, route.path).handler(requestFor(route), res);
      assert.deepEqual(
        [...new Set(app.asked)].sort(),
        [...route.keys].sort(),
        `${route.method.toUpperCase()} ${route.path} must require exactly ${route.keys.join(" + ")} — an unlisted key grants or denies something this table does not describe`,
      );
    }
  } finally {
    console.error = consoleError;
  }
});

test("a route declaring a permission with no authorizer wired in refuses rather than falling through", async () => {
  // The wiring in `server.js` is one object literal away from being dropped in a refactor. If that
  // happened and the guard fell through, every route above would silently become open again — and
  // it would look like a passing deploy, because nothing else in the file would change.
  for (const route of ALL_GUARDED) {
    const app = registerRoutes();
    const res = fakeResponse();
    await app.find(route.method, route.path).handler(requestFor(route), res);
    assert.equal(res.statusCode, 500, `${route.method.toUpperCase()} ${route.path} fell through an unwired authorizer`);
    assert.equal(res.payload.code, "OPERATIONAL_AUTHORIZATION_NOT_CONFIGURED");
    assert.deepEqual(app.queries, [], "an unconfigured authorizer must not let the handler run");
  }
});

test("an allocation takes the key of the side it settles, and both keys when the sides disagree", () => {
  assert.deepEqual(
    paymentAllocationPermissions({ body: { payment_entity_type: "SUPPLIER_PAYMENT", target_entity_type: "SUPPLIER_BILL" } }),
    ["supplier_payments"],
  );
  assert.deepEqual(
    paymentAllocationPermissions({ body: { payment_entity_type: "CUSTOMER_PAYMENT", target_entity_type: "SALE" } }),
    ["customer_payments"],
  );
  assert.deepEqual(
    paymentAllocationPermissions({ body: { payment_entity_type: "SALE_PAYMENT", target_entity_type: "SALE" } }),
    ["customer_payments"],
  );
  // Nothing in `validatePaymentAllocation` requires the two sides to be the same side of the ledger,
  // so a customer's payment can be pointed at a supplier's bill. That request needs both authorities.
  assert.deepEqual(
    paymentAllocationPermissions({ body: { payment_entity_type: "CUSTOMER_PAYMENT", target_entity_type: "SUPPLIER_BILL" } }).sort(),
    ["customer_payments", "supplier_payments"],
  );
  // An unrecognised or absent type demands both rather than none. "None" would mean the request
  // walks past the check entirely and is refused by validation *inside* the handler instead, which
  // is precisely the ordering this stage exists to fix.
  for (const body of [{}, { payment_entity_type: "GIFT", target_entity_type: "SALE" }]) {
    assert.deepEqual(
      paymentAllocationPermissions({ body }).sort(),
      ["customer_payments", "supplier_payments"],
    );
  }
});

test("a caller holding one of two required keys is still refused", async () => {
  // `guard` requires every key, not any one. If it ever weakened to "any", the two-sided allocation
  // above would let whichever authority the caller happens to hold move the other side's money.
  const app = registerRoutes({
    authorizePermission: async (_req, key) => (key === "customer_payments" ? { id: 2 } : null),
  });
  const res = fakeResponse();
  await app.find("post", "/api/v3/payment-allocations").handler(
    requestFor({
      method: "post",
      path: "/api/v3/payment-allocations",
      body: { payment_entity_type: "CUSTOMER_PAYMENT", target_entity_type: "SUPPLIER_BILL" },
    }),
    res,
  );
  assert.equal(res.statusCode, 403);
  assert.deepEqual(app.queries, []);
});

test("the read routes are not swept up by the guard", async () => {
  // Over-guarding is its own outage: a reporting screen that 403s is as broken as a write that does
  // not. These carry no permission and must still answer for a caller who holds none.
  for (const routePath of ["/api/v3/suppliers", "/api/v3/purchase-orders", "/api/v3/goods-receipts", "/api/v3/supplier-bills"]) {
    const app = registerRoutes({ authorizePermission: async () => null });
    const res = fakeResponse();
    await app.find("get", routePath).handler(requestFor({ method: "get", path: routePath }), res);
    assert.equal(res.statusCode, 200, `GET ${routePath} must remain readable`);
    assert.equal(app.asked.length, 0, `GET ${routePath} asked for a permission it does not declare`);
  }
});

/**
 * Every route registration in `operationalV3.js`, with the options object it declares.
 *
 * Read from the source because the sweep below has to be able to see a route that was added without
 * a permission — a route registered into the stand-in app can only be inspected for what it does,
 * not for what its author forgot to write.
 */
const ROUTE_BLOCK = /^ {2}use\("(get|post|put|delete)", "([^"]+)"[\s\S]*?^ {2}\}(?:, (\{[^\n]*\}))?\);$/gm;

const declaredRoutes = () => [...operationalSource.matchAll(ROUTE_BLOCK)].map((match) => ({
  key: `${match[1].toUpperCase()} ${match[2]}`,
  options: match[3] || "",
}));

/**
 * The routes allowed to declare no permission, each with the reason it needs none.
 *
 * This list, not the diff, is what keeps A-4e true: the next write route added in the old style will
 * not be in `GUARDED_WRITES`, but it will land here and fail with its own name attached.
 */
const NO_PERMISSION_BY_DESIGN = [
  "GET /api/v3/location-products",
  "GET /api/v3/suppliers",
  "GET /api/v3/purchase-orders",
  "GET /api/v3/goods-receipts",
  "GET /api/v3/supplier-bills",
  "GET /api/v3/payment-allocations",
  "GET /api/v3/transfers",
  // Reads the names of the other places in a company the caller is already authenticated into.
  // No stock, no money, no customer. It is deliberately not behind the "inventory" permission that
  // guards the transfer *writes*: the maintainer's staff hold more than one job, so the person who
  // sends a consignment may be on the Purchase Manager role, which does not carry "inventory"
  // by default. Gating the destination list would have made the screen unreachable for the role
  // most likely to use it, while protecting nothing the writes do not already protect.
  "GET /api/v3/transfers/destinations",
  "GET /api/v3/reports/consolidated",
  // Both previews write nothing (`would_write: false`) and both go through
  // `validateAssignmentPreview`, which refuses anyone who is not the Owner holding
  // `manage_assignments` on both the device and the staff record. A permission key on top of that
  // would be a second, weaker answer to a question already asked.
  "POST /api/v3/admin/staff-assignments/preview",
  "POST /api/v3/admin/device-assignments/preview",
];

test("no route in operationalV3.js declares write: true without declaring a permission", () => {
  const routes = declaredRoutes();
  assert.ok(
    routes.length >= 20,
    `only ${routes.length} registrations found; the scan broke rather than the file shrinking`,
  );
  const open = routes
    .filter((route) => /write: true/.test(route.options) && !/permission:/.test(route.options))
    .map((route) => route.key)
    .sort();
  assert.deepEqual(
    open,
    [],
    "`write: true` alone asks whether the device may write, never whether the person may",
  );

  const unkeyed = routes.filter((route) => !/permission:/.test(route.options)).map((route) => route.key).sort();
  assert.deepEqual(
    unkeyed,
    [...NO_PERMISSION_BY_DESIGN].sort(),
    "a route with no permission that is not on the by-design list, or a listed one that has since gained a key",
  );
  assert.equal(
    unkeyed.length,
    NO_PERMISSION_BY_DESIGN.length,
    "the count is pinned so a route added later without a key cannot pass by being swapped for a removed one",
  );
});

test("every permission key these routes name exists in PERMISSION_KEYS", () => {
  // `getPermissionUser` returns null for a key it does not recognise, so a typo does not fail loudly
  // — it 403s everyone except the Owner, on a route nobody is watching, until a shop reports it.
  const declared = /const PERMISSION_KEYS = \[([\s\S]*?)\];/.exec(backendSource);
  assert.ok(declared, "PERMISSION_KEYS moved; this assertion is stale");
  const known = new Set([...declared[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1]));
  const used = new Set([
    ...ALL_GUARDED.flatMap((route) => route.keys),
    ...[...operationalSource.matchAll(/permission: "([a-z_]+)"/g)].map((match) => match[1]),
  ]);
  const unknown = [...used].filter((key) => !known.has(key)).sort();
  assert.deepEqual(unknown, [], "a permission key the server does not know denies everyone but the Owner");
});

test("the scope-management writes registered through the same helper are Owner-gated in the handler", () => {
  // They are registered by `registerScopeManagementRoutes` through this file's `use`, so the sweep
  // above cannot see them and would otherwise report the file clean while six branch, location,
  // assignment and device-approval writes carried `{ write: true }` and nothing else. They are not a
  // hole — every one of them calls `requireAssignmentOwner` as its first statement — and this records
  // that, so removing that call fails here rather than silently joining the class A-4e just closed.
  const registrations = [...scopeSource.matchAll(/^ {2}use\("(get|post|put|delete)", "([^"]+)"[\s\S]*?^ {2}\}(?:, \{[^\n]*\})?\);$/gm)];
  assert.ok(registrations.length >= 7, `only ${registrations.length} scope-management routes found; the scan broke`);
  for (const registration of registrations) {
    assert.match(
      registration[0],
      /requireAssignmentOwner\(context\);/,
      `${registration[1].toUpperCase()} ${registration[2]} must refuse a non-Owner before it does anything else`,
    );
  }
});
