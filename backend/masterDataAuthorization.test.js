"use strict";

/**
 * Auth-hardening A-4d: the routes that write master data must decide who may write it.
 *
 * A-4c swept for write routes with no permission check and found this class outside the money list.
 * Seven master-data handlers had no authorisation call of any kind — not a weak one, none — and each
 * writes `opening_balance`, the column the account ledger renders directly as `outstanding_balance`
 * and `payable_balance`. Any signed-in employee could restate what a customer or a supplier owed.
 * That is worse than several of the routes A-4c fixed: a payment adds a row to a history, whereas
 * this rewrites the number the history is measured from, leaving nothing behind that says it moved.
 *
 * `POST /api/whatsapp/send-document` is the eighth. It spends the shop's WhatsApp Cloud credentials
 * and mails ledgers and reports to numbers named in the request, while `whatsapp_send` — a key added
 * for exactly this route and deliberately seeded false for the staff roles — was read by nothing. It
 * also stamped `whatsapp_send_logs.sent_by_user_id` from `req.body.sentByUserId`, so the one column
 * that records who sent a customer's ledger out of the shop held whatever the client typed.
 *
 * The enumeration is the point: the table below is the authority on which key each route uses, and
 * the file-wide sweep near the end is the authority on which write routes are allowed to have no key
 * at all. A route added later in the old style fails here rather than shipping.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { submittedIdentityFrom } = require("./authMiddleware");
const { rejectDeviceSessionSubstitution } = require("./deviceSession");
const { collectRouteAuthCoverage } = require("./routeAuthCoverage");

const backendSource = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const appSource = fs.readFileSync(path.join(__dirname, "..", "frontend", "src", "App.jsx"), "utf8");

/**
 * Source with comments removed, line numbering intact.
 *
 * The guards added by this stage quote the vulnerable pattern they replace, and the startup
 * migration explains which lockout it exists to avoid, so an assertion that reads comments passes or
 * fails on its own documentation. Block comments are blanked rather than deleted because everything
 * below addresses the file by line.
 */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const backendCode = stripComments(backendSource);
const appCode = stripComments(appSource);
const codeLines = backendCode.split("\n");

/** A line that ends a top-level route registration (`});`) or handler constant (`};`). */
const BODY_END = /^(\}\);?|\};)$/;

/** Anything that reaches the database with an effect: a write, or the transaction that wraps one. */
const DATABASE_WRITE = /INSERT INTO|UPDATE [a-z_]+\b|DELETE FROM|query\("BEGIN"\)/;

/** The lines of one top-level block, from its opening line to the line that closes it. */
const blockFrom = (start) => {
  let end = start;
  while (end < codeLines.length - 1 && !BODY_END.test(codeLines[end])) end += 1;
  return codeLines.slice(start, end + 1);
};

/**
 * The lines of one handler, read from the source rather than a hand-copied excerpt, so the
 * assertions cannot pass against a stale copy of code that has since changed.
 */
const handlerBody = (registration) => {
  const start = codeLines.findIndex((line) => line.startsWith(registration));
  assert.notEqual(start, -1, `${registration} is no longer registered; this list is stale`);
  return blockFrom(start);
};

const firstIndex = (lines, pattern) => lines.findIndex((line) => pattern.test(line));

/**
 * Every route this stage guards, with the permission key it must use and why that key.
 *
 * `keys` is exhaustive and exact — a route naming a key not listed here fails, which is what stops
 * someone reaching for a broad key (`settings`, `reports`) to make a 403 go away. `effect` is the
 * first thing the handler does that the outside world can see, which for the WhatsApp route is a log
 * insert and an outbound send rather than a bare `INSERT INTO`.
 */
const MASTER_DATA_ROUTES = [
  {
    registration: 'app.post("/accounts"',
    label: "POST /accounts",
    keys: ["customer_accounts", "supplier_accounts"],
    why: "one route, three destination tables: customers, suppliers and the generic accounts ledger",
  },
  {
    registration: 'app.put("/accounts/:accountKey"',
    label: "PUT /accounts/:accountKey",
    keys: ["customer_accounts", "supplier_accounts"],
    why: "restating an existing opening balance is the same authority as setting it, on whichever side",
  },
  {
    registration: 'app.post("/suppliers"',
    label: "POST /suppliers",
    keys: ["supplier_accounts"],
    why: "creates the supplier master row and its payable opening balance",
  },
  {
    registration: 'app.put("/suppliers/:id"',
    label: "PUT /suppliers/:id",
    keys: ["supplier_accounts"],
    why: "rewrites what the shop owes a supplier",
  },
  {
    registration: 'app.delete("/suppliers/:id"',
    label: "DELETE /suppliers/:id",
    keys: ["supplier_accounts"],
    why: "deactivates a supplier; deliberately the same key as edit because it is reversible",
  },
  {
    registration: 'app.post("/customers"',
    label: "POST /customers",
    keys: ["customer_accounts"],
    why: "creates the customer master row and its outstanding opening balance",
  },
  {
    registration: 'app.put("/customers/:id"',
    label: "PUT /customers/:id",
    keys: ["customer_accounts"],
    why: "rewrites what a customer owes",
  },
  {
    registration: 'app.post("/api/whatsapp/send-document"',
    label: "POST /api/whatsapp/send-document",
    keys: ["whatsapp_send"],
    effect: /insertWhatsappLog\(|await fetch\(/,
    why: "spends the business WhatsApp credentials and mails ledgers to numbers named in the request",
  },
];

test("every master-data route checks a permission before it has any effect", () => {
  for (const { registration, label, effect, why } of MASTER_DATA_ROUTES) {
    const lines = handlerBody(registration);
    const guard = firstIndex(lines, /getPermissionUser\(/);
    const write = firstIndex(lines, effect || DATABASE_WRITE);
    assert.notEqual(guard, -1, `${label} has no permission check at all — it ${why}`);
    assert.ok(write === -1 || guard < write, `${label} acts before its permission check`);
  }
});

test("each master-data route uses exactly the permission key chosen for it", () => {
  for (const { registration, label, keys } of MASTER_DATA_ROUTES) {
    const body = handlerBody(registration).join("\n");
    const named = [...body.matchAll(/getPermissionUser\([^,]+,\s*(?:"([a-z_]+)"|(\w+))/g)]
      .map((match) => match[1])
      .filter(Boolean);
    // A key held in a local (the two routes that serve both sides of the account master pick theirs
    // from the account type) is matched from its assignment instead, so the table still sees every
    // key the route can require. Only lower-case literals are collected, which is what keeps the
    // account-type and account-key-prefix strings in the same expression out of the result.
    const fromLocals = [...body.matchAll(/permissionKey = [^;]+/gs)]
      .flatMap((match) => [...match[0].matchAll(/"([a-z_]+)"/g)].map((key) => key[1]));
    const used = [...new Set([...named, ...fromLocals])].sort();
    assert.deepEqual(
      used,
      [...keys].sort(),
      `${label} must require exactly ${keys.join(" + ")} — an unlisted key grants or denies something this table does not describe`,
    );
  }
});

test("the two account-master routes pick their key from the row they are about to rewrite", () => {
  // The A-4c shape, applied to a route that carries two entity types rather than two money
  // movements. Choosing one key for the whole route would have been wrong in one direction: a
  // Cashier maintains customers and is denied supplier accounts, so a single `supplier_accounts`
  // would have stopped the counter adding a customer, and a single `customer_accounts` would have
  // handed the counter the supplier ledger.
  const create = handlerBody('app.post("/accounts"').join("\n");
  assert.match(
    create,
    /permissionKey = account\.account_type === "CUSTOMER"\s*\?\s*"customer_accounts"\s*:\s*"supplier_accounts"/,
    "POST /accounts must key on the account type it is about to insert",
  );

  const edit = handlerBody('app.put("/accounts/:accountKey"').join("\n");
  assert.match(
    edit,
    /permissionKey = source === "CUSTOMER"/,
    "PUT /accounts/:accountKey must key on the account-key prefix, which names the table it updates",
  );
  // An unrecognised prefix takes no key and falls through to the pre-existing "Invalid account" 400,
  // rather than being answered with a permission denial for an account that does not exist.
  assert.match(edit, /: null;/, "an unrecognised account key must fall through, not be denied");
});

test("the WhatsApp actor is the session, never a field the caller wrote", () => {
  const body = handlerBody('app.post("/api/whatsapp/send-document"').join("\n");
  assert.match(body, /const sentByUserId = req\.auth\.userId;/, "the send log must record the verified session");
  assert.doesNotMatch(
    body,
    /sentByUserId,?\s*\n\s*\} = req\.body/,
    "sentByUserId must not be read out of the body it is meant to attribute",
  );
  assert.doesNotMatch(backendCode, /req\.body\.sentByUserId/, "no path may take the sender from the body");
});

test("no actor in the opening-stock helper falls back to user 1", () => {
  // `sale_rate_history.changed_by` is NOT NULL, so the old `actorId || 1` could only ever have filed
  // an unattributable rate change under user 1 — the Owner in a single-owner shop. Failing the
  // insert is the correct outcome; both callers resolve the actor from a permission check first, so
  // it is not reachable today and this pins that it stays that way.
  assert.doesNotMatch(
    backendCode,
    /actorId \|\| 1\b/,
    "an actor defaulting to 1 signs the Owner's name on a rate change nobody can be shown to have made",
  );
});

/**
 * Every write registration in the file, resolved through named handler constants.
 *
 * `app.put("/sales/:id", updateSaleHandler)` and the `v3WriteAdapter(...)` mounts carry no body of
 * their own, so a scan that only reads the registration line would report them unguarded and a scan
 * that read forward from it would swallow the next unrelated handler. Both failure modes read as
 * findings, which is worse than not scanning at all, so the handler is looked up by name.
 */
const collectWriteRegistrations = () => {
  const handlers = new Map();
  codeLines.forEach((line, index) => {
    const declaration = /^const ([A-Za-z0-9_$]+) = async \(/.exec(line);
    if (declaration) handlers.set(declaration[1], blockFrom(index).join("\n"));
  });

  // `requireOrderRouter` is listed because it is a stricter check than one already trusted here,
  // not a looser one: it re-reads the role from the database like `requireRateManager` does, and
  // then also requires the caller's company to match the session's. Role without company is the
  // shape of the cross-tenant hole found in /lots/transfer-stock today -- a role check wearing
  // authorisation's clothes.
  const GUARDS = /getPermissionUser\(|requireRateManager\(|getSalePermissionUser\(|requireSelfOrRateManager\(|requireSyncContext\(|requireOrderRouter\(/;
  const registrations = [];
  codeLines.forEach((line, index) => {
    const match = /^app\.(post|put|patch|delete)\("([^"]+)"/.exec(line);
    if (!match) return;
    let body;
    if (/async \(req, res\)/.test(line)) {
      body = blockFrom(index).join("\n");
    } else {
      const span = [];
      for (let cursor = index; cursor < codeLines.length && cursor < index + 8; cursor += 1) {
        span.push(codeLines[cursor]);
        if (/\);\s*$/.test(codeLines[cursor])) break;
      }
      const text = span.join("\n");
      const named = [...text.matchAll(/\b([A-Za-z0-9_$]+)\b/g)]
        .map((token) => token[1])
        .filter((token) => handlers.has(token));
      body = named.length ? named.map((token) => handlers.get(token)).join("\n") : text;
    }
    registrations.push({
      key: `${match[1].toUpperCase()} ${match[2]}`,
      writes: DATABASE_WRITE.test(body),
      guarded: GUARDS.test(body),
    });
  });
  return registrations;
};

/**
 * The write routes that are allowed to reach the database with no permission check, each because the
 * caller has no identity to check yet or is a device rather than a person.
 *
 * This list, not the diff, is what keeps A-4d true: the next handler written in the old style will
 * not be in `MASTER_DATA_ROUTES`, but it will land here and fail with its own name attached.
 */
const UNGUARDED_BY_DESIGN = [
  "POST /login",
  // Self-authenticating: it verifies the owner's username and password itself and refuses once any
  // approved owner device exists. There is no permission to check because there is no session yet —
  // that is why it sits on A-4's public allow-list. A-5 gave it the same failed-attempt lock as
  // /login, so "no permission check" no longer means "unlimited guessing".
  "POST /bootstrap/first-owner-device",
  // A-6 Gate 1.5. Writes one column on one row: the caller's own session revocation counter. The
  // user id comes from the verified token and is never read from the request, so there is no other
  // account it could be pointed at and no permission to check - "may I sign myself out" has one
  // answer. Reading the id from the body instead is exactly the A-3 bug this list was built after.
  "POST /auth/sign-out",
  "POST /devices/activate",
  "POST /api/device/register",
  "POST /api/sync/register-device",
  "POST /api/sync/push",
  "POST /auth/recovery/send-otp",
  "POST /auth/recovery/verify-otp",
  "POST /auth/recovery/reset-password",
  "POST /settings/device-control/verify-exit-code",
];

test("no write route reaches the database without a permission check, beyond the listed exceptions", () => {
  const registrations = collectWriteRegistrations();
  assert.ok(
    registrations.length > 100,
    `only ${registrations.length} write registrations found; the scan broke rather than the file shrinking`,
  );
  const open = registrations
    .filter((route) => route.writes && !route.guarded)
    .map((route) => route.key)
    .sort();
  assert.deepEqual(
    open,
    [...UNGUARDED_BY_DESIGN].sort(),
    "a write route with no permission check that is not on the by-design list, or a listed one that has since gained a guard",
  );
  assert.equal(
    open.length,
    UNGUARDED_BY_DESIGN.length,
    "the count is pinned so a route added later in the old style cannot pass by being swapped for a removed one",
  );
});

test("customer_accounts exists and is seeded so no existing install is locked out", () => {
  assert.match(
    backendCode,
    /^\s*"customer_accounts",$/m,
    "customer_accounts must be in PERMISSION_KEYS — getPermissionUser returns null for a key it does not know, so the route would 403 for everyone but the Owner",
  );

  // The migration that decides what happens on the maintainer's Monday morning. Owner, Admin,
  // Cashier and Purchase Manager are the four roles `defaultRolePermissions` hardcodes the Accounts
  // module open for, so they reach the customer master form today regardless of their stored row and
  // have to keep reaching it. Seeding this Owner/Admin-only would have stopped a shop's cashier
  // adding a customer on the first restart after the upgrade, which is worse than the hole it
  // closes: the hole is a year old and the counter is not.
  const hardcodedRoles = backendCode.indexOf(
    `SET permissions = permissions || '{"customer_accounts":true}'::jsonb`,
  );
  assert.ok(hardcodedRoles > 0, "the roles the client hardcodes the Accounts module open for must be granted the key");
  assert.match(
    backendCode.slice(hardcodedRoles, hardcodedRoles + 260),
    /WHERE role_name IN \('Owner', 'Admin', 'Cashier', 'Purchase Manager'\)/,
    "all four hardcoded-default roles must be granted, not just the owners",
  );

  // Every other role, including any the shop has added itself, inherits the condition
  // `hasModuleAccess` actually applies to the Accounts module rather than a flat value, so the set of
  // people who can add a customer is unchanged by the upgrade.
  const inherit = backendCode.search(
    /SET permissions = permissions \|\| jsonb_build_object\('customer_accounts', to_jsonb\(\s*\n\s*COALESCE\(permissions -> 'customer_payments', 'false'::jsonb\) = 'true'::jsonb\s*\n\s*OR COALESCE\(permissions -> 'supplier_payments', 'false'::jsonb\) = 'true'::jsonb\s*\n\s*OR COALESCE\(permissions -> 'supplier_accounts', 'false'::jsonb\) = 'true'::jsonb\s*\n\s*\)\)\s*\n\s*WHERE NOT \(permissions \? 'customer_accounts'\);/,
  );
  assert.ok(inherit > 0, "roles outside the hardcoded defaults must inherit the Accounts module condition");
  assert.ok(
    hardcodedRoles < inherit,
    "the hardcoded-default grant must run first; the inherit skips any role that already has the key",
  );

  // Guarded on the key being absent, so a restart never overwrites a decision the maintainer has
  // since made in the role table.
  const guards = backendCode.match(/NOT \(permissions \? 'customer_accounts'\)/g) || [];
  assert.equal(guards.length, 2, "both customer_accounts statements must be idempotent across restarts");
});

test("A-4d enforces the existing whatsapp_send policy rather than widening it", () => {
  // The key was seeded true for Owner/Admin and false for the three staff roles when it was added,
  // and then read by nothing. Enforcement is what that seeding was for, so there is no new migration
  // here: re-granting it would overwrite the maintainer's own decision under cover of a security fix.
  assert.match(
    backendCode,
    /SET permissions = permissions \|\| '\{"whatsapp_send":false,"whatsapp_settings":false\}'::jsonb\s*\n\s*WHERE role_name IN \('Cashier', 'Purchase Manager', 'Inventory Manager'\)/,
    "the staff roles must keep the whatsapp_send value they were seeded",
  );
  const grants = backendCode.match(/"whatsapp_send":true/g) || [];
  assert.equal(grants.length, 1, "whatsapp_send must not be granted to any role beyond the original Owner/Admin seed");
});

test("the new key is visible in the role editor and the enforced controls are disabled", () => {
  // Enforcement alone would be worse than nothing in two specific ways, both of which A-4c had to
  // fix after the fact. A key with no label is enforced on the server and invisible in
  // Settings -> Role Permissions, so it can never be granted; and a button that now always 403s is
  // an action rendered as available that cannot succeed.
  assert.match(
    appCode,
    /\["customer_accounts", "Customer Accounts"\],/,
    "customer_accounts needs a row in permissionLabels or it cannot be granted from the shipped client",
  );
  assert.match(
    appCode,
    /const canWhatsappSend = \["Owner", "Admin"\]\.includes\(user\.role\) \|\| hasRolePermission\("whatsapp_send"\);/,
    "the client must derive the same authority the server now enforces",
  );
  const whatsappButtons = appCode.match(/className="whatsapp-button"[^\n]*/g) || [];
  assert.ok(whatsappButtons.length > 0, "the WhatsApp buttons moved; this assertion is stale");
  for (const button of whatsappButtons) {
    assert.match(
      button,
      /!canWhatsappSend/,
      "every WhatsApp button must be disabled without the permission the route now requires",
    );
  }
});

test("a permission key absent from a submitted role payload is stored as false", () => {
  // Not a defect — it is what makes the role editor authoritative — but it is why the new key needs
  // a row in `permissionLabels`. The shipped editor round-trips the stored object, so the seeded
  // value survives a save, and any client that posts a partial payload silently clears it.
  assert.match(
    backendCode,
    /const normalized = PERMISSION_KEYS\.reduce\(\(payload, key\) => \(\{ \.\.\.payload, \[key\]: Boolean\(permissions\[key\]\) \}\), \{\}\);/,
    "role permissions are normalized over every key; a key missing from the payload is written false",
  );
});

/** Every registration that reaches one of the guarded handlers. */
const MASTER_DATA_ROUTE_KEYS = [
  "POST /accounts",
  "PUT /accounts/:accountKey",
  "POST /suppliers",
  "PUT /suppliers/:id",
  "DELETE /suppliers/:id",
  "POST /customers",
  "PUT /customers/:id",
  "POST /api/whatsapp/send-document",
];

test("every master-data route requires a verified session", async () => {
  // The guards read `req.auth.userId`. On a route reachable without a session that is `undefined`,
  // and the guard would throw into the handler's catch and answer 500 — an internal error rendered
  // where a denial belongs. Allow-listing one of these later fails here with the reason attached.
  const coverage = await collectRouteAuthCoverage();
  const byKey = new Map(coverage.map((route) => [route.key, route]));

  const missing = MASTER_DATA_ROUTE_KEYS.filter((key) => !byKey.has(key));
  assert.deepEqual(missing, [], "these routes are no longer registered; the list is stale");

  const open = MASTER_DATA_ROUTE_KEYS
    .filter((key) => !byKey.get(key).authenticated)
    .map((key) => `${key} :: ${byKey.get(key).evidence}`);
  assert.deepEqual(open, [], "these routes write master data and can be reached without a verified session");
});

test("the auth layer never covered sentByUserId, which is why the route had to change", () => {
  // The boundary this stage rests on, in the same shape A-4c recorded for `created_by`.
  // `rejectDeviceSessionSubstitution` pins user_id, device_id, company_id and branch_id to the token
  // and nothing else, so a valid session for user 9 carrying `sentByUserId: 1` is accepted —
  // correctly, because `sentByUserId` is not an identity claim. No middleware was ever going to stop
  // a Cashier signing the Owner's name on an outbound ledger; only the handler could.
  const claims = { user_id: 9, device_id: "FZDEV-A4D", company_id: 1, branch_id: 1 };
  const stamping = submittedIdentityFrom({
    headers: {},
    body: { sentByUserId: 1, sent_by_user_id: 1 },
    query: {},
  });
  assert.equal(
    rejectDeviceSessionSubstitution(claims, stamping),
    null,
    "the request is accepted; only the handler's choice of actor decides whose name goes on the log row",
  );
});

// ---------------------------------------------------------------------------------------------
// The live supplier path
//
// The A-4d sweep found `/accounts` and guarded it — but the shipped Accounts screen posts supplier
// saves to `/api/v3/suppliers` in operationalV3.js, so the `/accounts` supplier branch is dead from
// the client. Guarding only that would have closed an API hole while leaving the route a Cashier
// actually uses to rewrite a supplier's opening_balance completely open. These pin the live path.
// ---------------------------------------------------------------------------------------------

test("the v3 supplier master writes require supplier_accounts", () => {
  const source = fs.readFileSync(require.resolve("./operationalV3.js"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  const guarded = code.match(/\{ write: true, permission: "supplier_accounts" \}/g) || [];
  assert.equal(guarded.length, 3, "POST, PUT and DELETE /api/v3/suppliers must each declare the key");

  // The bare form must not come back on a supplier route: it is the exact shape that left this open.
  const supplierBlock = code.slice(code.indexOf('use("post", "/api/v3/suppliers"'));
  assert.doesNotMatch(
    supplierBlock.slice(0, 1200),
    /\}, \{ write: true \}\);/,
    "a supplier master write with no permission is the defect A-4d exists to close",
  );
});

test("a declared permission with no authorizer refuses rather than falling through", () => {
  // A wiring mistake must not become a silent bypass on the routes that most need a check.
  const source = fs.readFileSync(require.resolve("./operationalV3.js"), "utf8");
  assert.match(source, /typeof authorizePermission !== "function"/);
  assert.match(source, /OPERATIONAL_AUTHORIZATION_NOT_CONFIGURED/);
  const refusal = source.slice(source.indexOf("OPERATIONAL_AUTHORIZATION_NOT_CONFIGURED"));
  assert.match(refusal.slice(0, 200), /message/, "the refusal must carry a message, not an empty 500");
});

test("server.js wires the authorizer to the verified session", () => {
  const backend = fs.readFileSync(require.resolve("./server.js"), "utf8");
  assert.match(
    backend,
    /authorizePermission: \(req, permissionKey\) =>\s*\n?\s*getPermissionUser\(req\?\.auth\?\.userId, permissionKey, \["Owner", "Admin"\]\)/,
    "the actor must come from req.auth, never from a request field",
  );
});
