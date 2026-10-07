"use strict";

/**
 * Auth-hardening A-4b: the actor a permission check runs against must be the verified session.
 *
 * A-4 mounted `requireAuth` on every route, so the server knows who the caller is. It did not
 * change *what the permission checks read*. `requireRateManager`, `getPermissionUser` and
 * `getSalePermissionUser` were called with `req.body.updated_by`, `req.body.created_by` or
 * `req.query.user_id` — fields the caller writes. Each of those functions looks a user up and
 * reports their role, which authorises but cannot authenticate, so a signed-in **Cashier who sent
 * the Owner's id in `updated_by` passed every one of them**: `PUT /settings/business`,
 * `POST /users`, `DELETE /users/:id`, `PUT /users/:id/password`,
 * `PUT /settings/role-permissions/:roleName`, `POST /settings/activation-codes` and 55 more.
 *
 * A-4 turned "anyone on the network is Owner" into "any employee is Owner". This is the stage that
 * closes it, and these tests pin it from three sides: the actor's provenance in the source, the
 * fact that `req.auth` is guaranteed to exist wherever it is read, and the boundary that makes the
 * source fix load-bearing — the substitution check does not and cannot cover `updated_by`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { submittedIdentityFrom } = require("./authMiddleware");
const { rejectDeviceSessionSubstitution } = require("./deviceSession");
const { collectRouteAuthCoverage } = require("./routeAuthCoverage");

const backendSource = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

/**
 * Source with comments removed.
 *
 * The comment on `requireRateManager` quotes the vulnerable call verbatim, because a fix whose
 * reason is not written down gets undone. A "this pattern must not appear" assertion has to look at
 * code, or the explanation of the bug reads as the bug.
 */
const backendCode = backendSource
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** Every function in `server.js` that turns a user id into a permission decision. */
const ACTOR_GUARDS = [
  ["requireRateManager", "grants Owner/Admin authority over settings, users, rates and stock"],
  ["getPermissionUser", "grants a named permission key such as `settings` or `pos_date_override`"],
  ["getSalePermissionUser", "grants the right to edit or cancel a completed sale"],
  ["getSettingsBundle", "decides whether the response carries the users, devices and activation-code tables"],
];

/**
 * `requireRateManager(` call sites whose first argument is not literally `req.auth.userId`, and why
 * each is still correct. Anything not on this list must name the session directly.
 */
const INDIRECT_ACTORS = [
  [
    "const manager = await requireRateManager(parsedActor, client);",
    "inside `requireSelfOrRateManager`, whose own actor argument is already the session id",
  ],
  [
    "userId ? requireRateManager(userId) : Promise.resolve(null),",
    "inside `getSettingsBundle`, a helper with no `req`; its one caller passes `req.auth`, and the id\n     it reads off that is the verified one",
  ],
  [
    "const actorId = req.auth.userId;",
    "PUT /users/:id/password, where the actor and the target are deliberately different people",
  ],
  [
    "const userId = req.auth.userId;",
    "`cancelProductHandler`, which named its local `userId` before A-4b existed",
  ],
];

/**
 * The measured count of session-derived `requireRateManager` actors, 2026-08-20.
 *
 * Pinned so that a route added later in the old style fails here rather than shipping. Raising it
 * is a normal part of adding a guarded route; lowering it, or a mismatch against the total, means
 * a call site went back to reading the request.
 *
 * 59 -> 65 on 2026-09-02: the six `/settings/charge-types` write routes (create, update, deactivate,
 * and the three slab writes) each take their actor from the session. The list route reads nothing
 * privileged and takes no guard.
 *
 * 65 -> 57 on 2026-10-07, and not by any route going unguarded: eight settings routes moved to a
 * stricter or narrower check that still reads `req.auth.userId`. `POST /settings/activation-codes`
 * is retired (426); its revoke and `POST /settings/branches` are Owner-only (`getOwnerUser`);
 * `PUT /settings/devices/:deviceId`, `POST /settings/counters` and the three backup routes now read
 * the `device_management`, `branch_settings` and `backup_restore` toggles (`getStaffPermissionUser`).
 */
const SESSION_DERIVED_RATE_MANAGER_CALLS = 57;

/** Every `requireRateManager(` occurrence in the file, session-derived or listed above. */
const TOTAL_RATE_MANAGER_CALLS = SESSION_DERIVED_RATE_MANAGER_CALLS + INDIRECT_ACTORS.length;

const countOf = (pattern) => (backendCode.match(pattern) || []).length;

test("no permission check takes its actor from a field the caller writes", () => {
  for (const [guard, consequence] of ACTOR_GUARDS) {
    assert.doesNotMatch(
      backendCode,
      new RegExp(`${guard}\\(\\s*req\\.(body|query)`),
      `${guard} ${consequence}; its user id must be proven, not submitted`,
    );
    // The escalation was never about one spelling. `updated_by`, `created_by`, `edited_by`,
    // `changed_by`, `cancelled_by`, `deactivated_by` and `reactivated_by` all reached these guards,
    // and a grep for the common one missed the rest.
    assert.doesNotMatch(
      backendCode,
      new RegExp(`${guard}\\([^)]*\\b\\w+_by\\b`),
      `${guard} must not decide permission from an actor-ish payload field`,
    );
  }

  // `requireSelfOrRateManager` takes the target first and the actor second. Only the second may
  // never come from the request — the target legitimately does.
  assert.doesNotMatch(
    backendCode,
    /requireSelfOrRateManager\([^,)]*,\s*req\.(body|query)/,
    "the actor must come from the verified session, not from the request",
  );
});

test("every rate-manager call site is accounted for", () => {
  assert.equal(
    countOf(/requireRateManager\(req\.auth\.userId/g),
    SESSION_DERIVED_RATE_MANAGER_CALLS,
    "a call site stopped naming the session, or a new one was added in the old style",
  );
  assert.equal(
    countOf(/requireRateManager\(/g),
    TOTAL_RATE_MANAGER_CALLS,
    "an unaccounted `requireRateManager` call exists; add it above with its reason or pass req.auth.userId",
  );
  for (const [line, why] of INDIRECT_ACTORS) {
    assert.ok(
      backendCode.includes(line),
      `${line} — the exception is listed because it ${why}; if it changed, re-justify it`,
    );
  }
});

test("the purchase payload carries the actor rather than reading it", () => {
  // `actorId` is both the actor for `requireRateManager` and the `created_by` written on the
  // purchase, its stock movements and its audit trail. It read `body.created_by || body.edited_by
  // || 1`, so a caller chose their own permissions *and* signed someone else's name on the row —
  // and an omitted field attributed the purchase to user 1, the Owner in a single-owner shop.
  assert.match(backendCode, /const readPurchaseEntryPayload = \(body, actorUserId\) => \{/);
  assert.match(backendCode, /actorId: parsePositiveInteger\(actorUserId\),/);
  assert.doesNotMatch(
    backendCode,
    /actorId: parsePositiveInteger\(body\./,
    "the purchase actor must not be read back out of the body it is meant to attribute",
  );

  const calls = backendCode.match(/readPurchaseEntryPayload\(/g) || [];
  // 7 since 4 Oct 2026: completing a several-fruit pending arrival reads the header and each fruit.
  assert.equal(calls.length, 7, "a caller was added or removed; each one must pass the session actor");
  assert.equal(
    countOf(/readPurchaseEntryPayload\(req\.body, req\.auth\.userId\)/g)
      + countOf(/\}, req\.auth\.userId\)/g),
    calls.length,
    "every readPurchaseEntryPayload call must supply req.auth.userId as the actor",
  );
});

test("the POS sale actor is the session, not the bill's created_by", () => {
  // `parsedCreatedBy` gates `pos_date_override` and `manual_pos_rate_override` and is also stamped
  // on the sale. It was `parsePositiveInteger(created_by) || 1`: a Cashier could backdate a bill,
  // override a rate, and file the result under the Owner's name.
  assert.match(backendCode, /const parsedCreatedBy = req\.auth\.userId;/);
  assert.doesNotMatch(
    backendCode,
    /const parsedCreatedBy = parsePositiveInteger\(created_by\)/,
    "the POS actor must not default to user 1 when the field is absent",
  );
});

test("the guard says where its argument has to come from", () => {
  // Without this the next person to add a route reads the signature, sees `userId`, and passes
  // whatever id is to hand. The comment is the only thing at the definition that says otherwise.
  const definition = backendSource.indexOf("const requireRateManager = async (userId");
  assert.ok(definition > 0, "requireRateManager must still be defined here");
  const preamble = backendSource.slice(Math.max(0, definition - 1600), definition);
  assert.match(preamble, /req\.auth\.userId/, "the definition must name the only acceptable source");
  assert.match(preamble, /cannot authenticate/, "and must say why it cannot vet the id itself");
});

test("the substitution check does not cover updated_by, which is why the actor had to change", () => {
  // The boundary this whole stage rests on. `rejectDeviceSessionSubstitution` pins user_id,
  // device_id, company_id and branch_id to the token and nothing else, so a valid session for user
  // 9 carrying `updated_by: 1` is accepted — correctly, since `updated_by` is not an identity
  // claim. Nothing in the auth layer was ever going to stop the escalation; only the call sites
  // could. If someone later widens the check and deletes the source assertions above, this test
  // says what was actually being relied on.
  const claims = { user_id: 9, device_id: "FZDEV-A4B", company_id: 1, branch_id: 1 };
  const escalating = submittedIdentityFrom({
    headers: {},
    body: { updated_by: 1, created_by: 1, edited_by: 1, cancelled_by: 1 },
    query: {},
  });
  assert.equal(
    rejectDeviceSessionSubstitution(claims, escalating),
    null,
    "the request is accepted; only the handler's choice of actor decides whether it escalates",
  );

  // The contrast, so the test is not read as "the check is broken": the four fields it does cover
  // are covered, in every location they can arrive from.
  const impersonating = submittedIdentityFrom({
    headers: { "x-user-id": "9" },
    body: {},
    query: { user_id: "1" },
  });
  assert.equal(
    rejectDeviceSessionSubstitution(claims, impersonating)?.code,
    "DEVICE_SESSION_SUBSTITUTION_REJECTED",
    "an agreeing header must not buy a disagreeing query past the check",
  );
});

/**
 * Every route whose handler now decides permission from `req.auth.userId`, measured 2026-08-20 by
 * walking each guard call site up to its registrations.
 *
 * These are exactly the routes where A-4b's substitution has to hold, and where `req.auth` must
 * exist at all: on a public route it is `undefined`, so the guard would throw a TypeError into the
 * handler's catch and answer 500 — an error rendered as a generic failure rather than as a denial.
 * `routeAuthCoverage.test.js` asserts the whole app is covered; this asserts the dependency, so
 * allow-listing one of these later fails with the reason attached rather than as one line in a
 * count.
 */
const ACTOR_ROUTES = [
  "DELETE /api/v3/product-categories/:id",
  "DELETE /product-categories/:id",
  "DELETE /settings/discount-rules/:id",
  "DELETE /settings/mandi-tax-rules/:id",
  "DELETE /settings/rebate-rules/:id",
  "DELETE /users/:id",
  "GET /api/integrations/email/status",
  "GET /api/integrations/sms/status",
  "GET /auth/recovery/readiness-report",
  "GET /dashboard-analytics",
  "GET /dashboard-expense-trend",
  "GET /dashboard-metrics",
  "GET /dashboard-profit-trend",
  "GET /dashboard-sales-trend",
  "GET /sale-rate-history",
  "GET /sale-rates",
  "GET /sales-report/change-events",
  "GET /settings",
  "GET /users",
  "POST /api/integrations/email/test",
  "POST /api/integrations/sms/test",
  "POST /api/v3/inventory-lots/:lotId/add-quantity",
  "POST /api/v3/inventory-lots/:lotId/adjust",
  "POST /api/v3/inventory-lots/:lotId/deactivate",
  "POST /api/v3/inventory-lots/:lotId/reactivate",
  "POST /api/v3/product-categories",
  "POST /api/v3/products",
  "POST /api/v3/products/:id/deactivate",
  "POST /api/v3/purchase-bills",
  "POST /api/v3/purchases/:id/cancel",
  "POST /api/v3/purchases/:id/complete-bill",
  "POST /api/v3/sale-change-approvals",
  "POST /api/v3/sales",
  "POST /api/v3/sales/:id/cancel",
  "POST /inventory-lots/:lotId/add-quantity",
  "POST /inventory-lots/:lotId/adjust",
  "POST /inventory-lots/:lotId/deactivate",
  "POST /inventory-lots/:lotId/reactivate",
  "POST /lot-discounts",
  "POST /lot-discounts/:id/deactivate",
  "POST /lots/:lotId/adjust-stock",
  "POST /lots/transfer-stock",
  "POST /product-categories",
  "POST /products",
  "POST /products/:id/cancel",
  "POST /purchase",
  "POST /purchase-bill",
  "POST /purchase/:id/cancel",
  "POST /purchase/:id/complete-bill",
  "POST /sale-rates/bulk",
  "POST /sales",
  "POST /sales/:id/cancel",
  "POST /settings/activation-codes",
  "POST /settings/backup-now",
  "POST /settings/branches",
  "POST /settings/counters",
  "POST /settings/discount-rules",
  "POST /settings/mandi-tax-rules",
  "POST /settings/rebate-rules",
  "POST /settings/safe-shutdown",
  "POST /settings/whatsapp/test",
  "POST /users",
  "POST /users/:id/deactivate",
  "POST /users/:id/reactivate",
  "POST /users/:id/recovery-action",
  "PUT /api/v3/inventory-lots/:lotId",
  "PUT /api/v3/product-categories/:id",
  "PUT /api/v3/products/:id",
  "PUT /api/v3/purchases/:id",
  "PUT /api/v3/sales/:id",
  "PUT /inventory-lots/:lotId",
  "PUT /lot-discounts/:id",
  "PUT /lots/:lotId",
  "PUT /product-categories/:id",
  "PUT /products/:id",
  "PUT /purchase/:id",
  "PUT /sales/:id",
  "PUT /settings/activation-codes/:id/revoke",
  "PUT /settings/backup",
  "PUT /settings/business",
  "PUT /settings/device-control",
  "PUT /settings/devices/:deviceId",
  "PUT /settings/discount-rules/:id",
  "PUT /settings/mandi-tax-rules/:id",
  "PUT /settings/payment",
  "PUT /settings/pos",
  "PUT /settings/rebate-rules/:id",
  "PUT /settings/role-permissions/:roleName",
  "PUT /settings/sale-rate",
  "PUT /settings/sync-status",
  "PUT /settings/update-center",
  "PUT /settings/whatsapp",
  "PUT /users/:id",
  "PUT /users/:id/password",
];

test("every route that reads the session actor requires a session", async () => {
  const coverage = await collectRouteAuthCoverage();
  const byKey = new Map(coverage.map((route) => [route.key, route]));

  const missing = ACTOR_ROUTES.filter((key) => !byKey.has(key));
  assert.deepEqual(missing, [], "these routes are no longer registered; the list is stale");

  const open = ACTOR_ROUTES
    .filter((key) => !byKey.get(key).authenticated)
    .map((key) => `${key} :: ${byKey.get(key).evidence}`);
  assert.deepEqual(
    open,
    [],
    "these routes read req.auth.userId but can be reached without a verified session",
  );
});

// ---------------------------------------------------------------------------------------------
// 2026-10-07 — who may manage whom, and the permission keys nobody used to read.
//
// Driven through the real app with a scripted users table. Everything above proves the actor is
// the session; these prove what that actor is then allowed to do to *another* account, and that the
// settings, report, billing and purchase routes ask the permission the role screen sets.
// ---------------------------------------------------------------------------------------------

const crypto = require("node:crypto");
const {
  loadServerApp,
  probe,
  setQueryResponder,
  clearQueryResponder,
  setConnectionResponder,
  clearConnectionResponder,
  startQueryRecording,
  stopQueryRecording,
} = require("./routeAuthCoverage");
const { issueDeviceSession } = require("./deviceSession");

/** Must match the throwaway key `routeAuthCoverage` pins into the environment before loading. */
const ACTOR_TEST_SIGNING_KEY = "route-auth-coverage-isolated-signing-key-000000";

/** A scrypt hash at a deliberately tiny cost, so verifying it cannot outrun the probe timeout. */
const cheapHash = (password) => {
  const salt = Buffer.from("actor-test-salt-0001");
  const derived = crypto.scryptSync(password, salt, 32, { N: 1024, r: 8, p: 1 });
  return ["scrypt", "v=1", "n=1024,r=8,p=1", salt.toString("base64"), derived.toString("base64")].join("$");
};

const PEOPLE = {
  1: { role_name: "Owner", branch_id: 1, permissions: {} },
  2: { role_name: "Admin", branch_id: 1, permissions: {} },
  3: { role_name: "Cashier", branch_id: 1, permissions: { billing: true, reports: false, purchases: false } },
  4: { role_name: "Cashier", branch_id: 2, permissions: { billing: true } },
  5: { role_name: "Admin", branch_id: 1, permissions: {} },
  6: { role_name: "Purchase Manager", branch_id: 1, permissions: { purchases: true, reports: true, billing: false } },
  8: { role_name: "Admin", branch_id: 1, permissions: { reports: false, billing: false, purchases: false, device_management: false } },
};
const personRow = (id) => {
  const person = PEOPLE[id];
  return person && {
    id: Number(id),
    full_name: `Person ${id}`,
    username: `person${id}`,
    active: true,
    session_revocation_version: 0,
    password_hash: cheapHash(`right-${id}`),
    locked_until: null,
    failed_login_attempts: 0,
    last_failed_login_at: null,
    ...person,
  };
};

/**
 * Run one request as `actorId` (session branch `branchId`). Returns the response, every statement
 * the handler issued, and the values bound to each.
 */
const actAs = async (actorId, method, url, body = {}, { branchId = 1, viewOnly = false, extra = () => undefined } = {}) => {
  const app = loadServerApp();
  const statements = [];
  const respond = (sql, values = []) => {
    const text = String(sql).replace(/\s+/g, " ").trim();
    statements.push({ sql: text, values });
    const scripted = extra(text, values);
    if (scripted !== undefined) return scripted;
    if (/FROM users u (LEFT )?JOIN roles r/i.test(text) || /^SELECT id, username, password_hash/i.test(text)) {
      const row = personRow(values[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (/^SELECT id FROM roles WHERE role_name = \$1/i.test(text)) return { rows: [{ id: 9 }], rowCount: 1 };
    return undefined;
  };
  startQueryRecording();
  setQueryResponder(respond);
  setConnectionResponder(() => ({
    query: async (sql, values) => respond(typeof sql === "object" && sql ? sql.text : sql, values) || { rows: [], rowCount: 0 },
    release: () => {},
  }));
  try {
    const token = issueDeviceSession({
      userId: actorId,
      deviceId: "FZDEV-ACTOR-TEST",
      companyId: 1,
      branchId,
      role: PEOPLE[actorId]?.role_name || "Cashier",
      viewOnly,
      secret: ACTOR_TEST_SIGNING_KEY,
    });
    const response = await probe(app, method, url, {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    }, body);
    return { response, statements };
  } finally {
    clearQueryResponder();
    clearConnectionResponder();
    stopQueryRecording();
  }
};

const wrote = (statements, pattern) => statements.some(({ sql }) => /^(INSERT|UPDATE|DELETE)\b/i.test(sql) && pattern.test(sql));

test("an Admin cannot create an Owner or another Admin", async () => {
  for (const role of ["Owner", "Admin", "admin"]) {
    const { response, statements } = await actAs(2, "POST", "/users", {
      full_name: "Usurper", username: `usurper-${role}`, role, password: "pass1234", confirm_password: "pass1234",
    });
    assert.equal(response.status, 403, `${role}: ${response.text}`);
    assert.equal(response.code, "OWNER_REQUIRED_FOR_PRIVILEGED_ACCOUNT");
    assert.equal(wrote(statements, /users/), false, "a refusal writes no user");
  }
});

test("the Owner may still create an Admin", async () => {
  const { response } = await actAs(1, "POST", "/users", {
    full_name: "New Admin", username: "new-admin", role: "Admin", password: "pass1234", confirm_password: "pass1234",
  });
  assert.notEqual(response.code, "OWNER_REQUIRED_FOR_PRIVILEGED_ACCOUNT");
  assert.notEqual(response.status, 403);
});

test("an Admin cannot promote anyone to Admin, themselves included, nor edit the Owner", async () => {
  for (const [target, role] of [[3, "Admin"], [2, "Admin"], [1, "Owner"], [1, "Cashier"], [5, "Cashier"]]) {
    const { response, statements } = await actAs(2, "PUT", `/users/${target}`, { full_name: "X", username: `x${target}`, role });
    assert.equal(response.status, 403, `user ${target} -> ${role}: ${response.text}`);
    assert.equal(response.code, "OWNER_REQUIRED_FOR_PRIVILEGED_ACCOUNT");
    assert.equal(wrote(statements, /users/), false);
  }
});

test("an Admin manages their own shop's staff and no other shop's", async () => {
  const other = await actAs(2, "PUT", "/users/4", { full_name: "X", username: "x4", role: "Cashier" });
  assert.equal(other.response.status, 403);
  assert.equal(other.response.code, "USER_NOT_IN_YOUR_BRANCH");
  for (const [method, url] of [["POST", "/users/4/deactivate"], ["POST", "/users/4/reactivate"], ["DELETE", "/users/4"]]) {
    const { response, statements } = await actAs(2, method, url);
    assert.equal(response.code, "USER_NOT_IN_YOUR_BRANCH", `${method} ${url}`);
    assert.equal(wrote(statements, /users/), false);
  }
  // The control: the same Admin editing a Cashier of their own shop gets past the guard.
  const own = await actAs(2, "PUT", "/users/3", { full_name: "X", username: "x3", role: "Cashier" });
  assert.notEqual(own.response.status, 403, own.response.text);
});

test("an Admin cannot deactivate, reactivate, delete or reset the password of the Owner or another Admin", async () => {
  for (const [method, url, body] of [
    ["POST", "/users/1/deactivate", {}],
    ["POST", "/users/5/deactivate", {}],
    ["POST", "/users/1/reactivate", {}],
    ["DELETE", "/users/1", {}],
    ["PUT", "/users/1/password", { password: "taken1234", confirm_password: "taken1234" }],
    ["POST", "/users/1/recovery-action", { action: "RESET_PASSWORD" }],
  ]) {
    const { response, statements } = await actAs(2, method, url, body);
    assert.equal(response.status, 403, `${method} ${url}: ${response.text}`);
    assert.equal(response.code, "OWNER_REQUIRED_FOR_PRIVILEGED_ACCOUNT");
    assert.equal(wrote(statements, /users/), false, `${method} ${url} must write nothing`);
  }
});

test("only the Owner edits what the Owner and Admin roles may do", async () => {
  for (const role of ["Admin", "Owner", "ADMIN", "owner"]) {
    const { response, statements } = await actAs(2, "PUT", `/settings/role-permissions/${role}`, { permissions: { reports: true } });
    assert.equal(response.status, 403, role);
    assert.equal(response.code, "OWNER_REQUIRED_FOR_PRIVILEGED_ROLE");
    assert.equal(wrote(statements, /role_permission_settings/), false);
  }
  const cashierRole = await actAs(2, "PUT", "/settings/role-permissions/Cashier", { permissions: { billing: true } });
  assert.notEqual(cashierRole.response.code, "OWNER_REQUIRED_FOR_PRIVILEGED_ROLE");
  const owner = await actAs(1, "PUT", "/settings/role-permissions/Admin", { permissions: { billing: true } });
  assert.notEqual(owner.response.code, "OWNER_REQUIRED_FOR_PRIVILEGED_ROLE");
});

test("changing your own password needs the current one, and a wrong one counts towards the lockout", async () => {
  const missing = await actAs(3, "PUT", "/users/3/password", { password: "newpass1", confirm_password: "newpass1" });
  assert.equal(missing.response.status, 400);
  assert.equal(missing.response.code, "CURRENT_PASSWORD_REQUIRED");
  assert.equal(wrote(missing.statements, /password_hash/), false);

  const wrong = await actAs(3, "PUT", "/users/3/password", { current_password: "wrong", password: "newpass1", confirm_password: "newpass1" });
  assert.equal(wrong.response.status, 403);
  assert.equal(wrong.response.code, "CURRENT_PASSWORD_INVALID");
  assert.equal(wrote(wrong.statements, /password_hash/), false, "a wrong current password changes nothing");
  assert.equal(wrote(wrong.statements, /failed_login_attempts/), true, "and is counted like a failed sign-in");

  // The same holds for an Admin changing their own: being a manager does not skip the check.
  const admin = await actAs(2, "PUT", "/users/2/password", { password: "newpass1", confirm_password: "newpass1" });
  assert.equal(admin.response.code, "CURRENT_PASSWORD_REQUIRED");
});

test("purchases and checkout ask their permission first; reports ask theirs", async () => {
  const code = backendCode;
  const purchaseStart = code.indexOf("const createPurchaseBillHandler = async (req, res) => {");
  const purchaseHead = code.slice(purchaseStart, purchaseStart + 400);
  assert.match(purchaseHead, /getStaffPermissionUser\(req\.auth\.userId, "purchases", client\)/);
  const saleStart = code.indexOf("const createSaleHandler = async (req, res) => {");
  assert.match(code.slice(saleStart, saleStart + 400), /getStaffPermissionUser\(req\.auth\.userId, "billing", client\)/);

  for (const url of ["/reports/summary", "/reports/balance-sheet", "/reports/cash-book", "/reports/day-book", "/reports/balance-sheet/details/cash", "/sales-report/changes"]) {
    const cashier = await actAs(3, "GET", url);
    assert.equal(cashier.response.status, 403, url);
    assert.equal(cashier.response.code, "REPORTS_PERMISSION_REQUIRED", url);
    const manager = await actAs(6, "GET", url);
    assert.notEqual(manager.response.code, "REPORTS_PERMISSION_REQUIRED", `${url}: a role holding reports reads it`);
    const admin = await actAs(8, "GET", url);
    assert.notEqual(admin.response.code, "REPORTS_PERMISSION_REQUIRED", `${url}: an Admin always does, whatever the row says`);
  }
});

test("the device, counter, backup and system-info routes read their toggles", async () => {
  for (const [method, url] of [
    ["PUT", "/settings/devices/FZDEV-X"],
    ["POST", "/settings/counters"],
    ["PUT", "/settings/backup"],
    ["POST", "/settings/backup-now"],
    ["POST", "/settings/safe-shutdown"],
    ["GET", "/settings/system-info"],
  ]) {
    const { response } = await actAs(3, method, url, method === "GET" ? undefined : { action: "DISABLE", counter_name: "C" });
    assert.equal(response.status, 403, `${method} ${url}: ${response.text}`);
  }
  // An Admin whose stored row has device_management unticked still manages devices.
  const admin = await actAs(8, "PUT", "/settings/devices/FZDEV-X", { action: "DISABLE" });
  assert.notEqual(admin.response.status, 403, admin.response.text);
});

test("issuing activation codes is retired, and revoking and adding a branch are the Owner's", async () => {
  const issued = await actAs(1, "POST", "/settings/activation-codes", { code_label: "x" });
  assert.equal(issued.response.status, 426);
  assert.equal(wrote(issued.statements, /activation_codes/), false);

  const adminRevoke = await actAs(2, "PUT", "/settings/activation-codes/3/revoke");
  assert.equal(adminRevoke.response.code, "OWNER_ONLY");
  const ownerRevoke = await actAs(1, "PUT", "/settings/activation-codes/3/revoke");
  const revoke = ownerRevoke.statements.find(({ sql }) => /^UPDATE activation_codes/.test(sql));
  assert.match(revoke.sql, /b\.company_id = \$2/, "a revoke is limited to this company's codes");
  assert.deepEqual(revoke.values, [3, 1]);

  const adminBranch = await actAs(2, "POST", "/settings/branches", { branch_name: "Shop 9" });
  assert.equal(adminBranch.response.code, "OWNER_ONLY");
  const ownerBranch = await actAs(1, "POST", "/settings/branches", { branch_name: "Shop 9" });
  const insert = ownerBranch.statements.find(({ sql }) => /^INSERT INTO branches/.test(sql));
  assert.match(insert.sql, /company_id/);
  assert.equal(insert.values.at(-1), 1, "the new shop belongs to the session's company, never NULL");
});

test("an activation code never revives a retired, disabled or revoked device", async () => {
  for (const status of ["RETIRED", "DISABLED", "REVOKED"]) {
    const extra = (sql) => {
      if (/FROM activation_codes ac/.test(sql)) {
        return { rows: [{ id: 3, branch_id: 1, counter_id: null, created_by: 1, code_company_id: 1, creator_role_name: "Owner" }], rowCount: 1 };
      }
      if (/^SELECT \* FROM authorized_devices WHERE device_id = \$1/.test(sql)) {
        return { rows: [{ device_id: "FZDEV-OLD", status }], rowCount: 1 };
      }
      if (/^INSERT INTO authorized_devices/.test(sql)) return { rows: [{ device_id: "FZDEV-OLD", status }], rowCount: 1 };
      return undefined;
    };
    const app = loadServerApp();
    const statements = [];
    const client = {
      query: async (sql, values) => {
        const text = String(typeof sql === "object" && sql ? sql.text : sql).replace(/\s+/g, " ").trim();
        statements.push({ sql: text, values });
        return extra(text, values) || { rows: [], rowCount: 0 };
      },
      release: () => {},
    };
    setConnectionResponder(() => client);
    try {
      const response = await probe(app, "POST", "/devices/activate", { "content-type": "application/json" }, {
        device_id: "FZDEV-OLD", activation_code: "ABCD-EFGH-IJKL",
      });
      assert.equal(response.status, 403, `${status}: ${response.text}`);
      assert.equal(response.code, "DEVICE_DISABLED");
      assert.equal(statements.some(({ sql }) => /^UPDATE authorized_devices SET status = 'APPROVED'/.test(sql)), false, status);
      assert.equal(statements.some(({ sql }) => /^UPDATE activation_codes/.test(sql)), false, "the code is not spent");
      assert.equal(statements.some(({ sql }) => sql === "ROLLBACK"), true);
    } finally {
      clearConnectionResponder();
    }
  }
});

test("wrong exit codes are limited per device and user", async () => {
  const configured = (failures) => (sql) => {
    if (/FROM device_control_settings/.test(sql)) return { rows: [{ exit_code_hash: "not-a-match" }], rowCount: 1 };
    if (/COUNT\(\*\)::INTEGER AS failures/.test(sql)) return { rows: [{ failures }], rowCount: 1 };
    return undefined;
  };
  const locked = await actAs(3, "POST", "/settings/device-control/verify-exit-code", { exit_code: "1234" }, { extra: configured(5) });
  assert.equal(locked.response.status, 429);
  assert.equal(locked.response.code, "EXIT_CODE_ATTEMPTS_LOCKED");
  const count = locked.statements.find(({ sql }) => /COUNT\(\*\)::INTEGER AS failures/.test(sql));
  assert.deepEqual(count.values.slice(0, 2), ["FZDEV-ACTOR-TEST", 3], "counted by the session's device and user");
  const logged = locked.statements.find(({ sql }) => /^INSERT INTO device_exit_attempt_logs/.test(sql));
  assert.equal(logged.values[2], "Too many attempts", "a refused attempt is logged but does not extend the window");

  const fourth = await actAs(3, "POST", "/settings/device-control/verify-exit-code", { exit_code: "1234" }, { extra: configured(4) });
  assert.equal(fourth.response.status, 403, "below the limit a wrong code is still just wrong");
});

test("the settings bundle shows this company's devices, codes, shops, counters and exit attempts only", async () => {
  const { statements } = await actAs(1, "GET", "/settings");
  for (const pattern of [/FROM authorized_devices d/, /FROM activation_codes ac/, /FROM branches WHERE/, /FROM counters c/, /FROM device_exit_attempt_logs l/]) {
    const statement = statements.find(({ sql }) => pattern.test(sql));
    assert.ok(statement, `${pattern} was not read`);
    assert.match(statement.sql, /company_id\)? = \$1/, `${pattern} must be company-scoped`);
    assert.deepEqual(statement.values, [1], `${pattern} is scoped to the session's company`);
  }
});
