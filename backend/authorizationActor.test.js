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
    "return requireRateManager(parsedActor, client);",
    "inside `requireSelfOrRateManager`, whose own actor argument is already the session id",
  ],
  [
    "userId ? requireRateManager(userId) : Promise.resolve(null),",
    "inside `getSettingsBundle`, a helper with no `req`; its one caller passes `req.auth.userId`",
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
 */
const SESSION_DERIVED_RATE_MANAGER_CALLS = 65;

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
  assert.equal(calls.length, 5, "a caller was added or removed; each one must pass the session actor");
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
