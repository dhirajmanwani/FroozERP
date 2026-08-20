"use strict";

/**
 * Auth-hardening A-4c: the routes that move money must decide who may move it.
 *
 * A-4 put `requireAuth` on every route and A-4b moved the *actor* of every permission check onto the
 * verified session. Thirteen handlers were left behind by both, because they had no permission check
 * to move the actor onto: they were merely authenticated. Any signed-in employee — a Cashier, on a
 * counter terminal — could record a supplier payment, edit an expense, cancel a customer payment or
 * write off stock as waste. Each of them also stamped the row with `req.body.created_by` (or
 * `edited_by` / `cancelled_by`) and fell back to `|| 1` when the field was absent, so the audit trail
 * recorded whoever the client named and defaulted to user 1 — the Owner in a single-owner shop.
 *
 * These tests pin both halves, and the enumeration is the point: the table below is the authority on
 * which key each route uses, so a route added later without a check, or wired to a key that grants
 * more than its name says, fails here rather than shipping.
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
 * Source with comments removed, line numbering intact.
 *
 * The guards added by this stage explain the vulnerable pattern they replace, and the startup
 * migration explains which fallback it exists to avoid. An assertion that reads comments fails on
 * its own documentation, so it has to look at code only. Block comments are blanked rather than
 * deleted because everything below addresses the file by line.
 */
const backendCode = backendSource
  .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const codeLines = backendCode.split("\n");

/** A line that ends a top-level route registration (`});`) or handler constant (`};`). */
const BODY_END = /^(\}\);?|\};)$/;

/** Anything that reaches the database with an effect: a write, or the transaction that wraps one. */
const DATABASE_WRITE = /INSERT INTO|UPDATE [a-z_]+\b|DELETE FROM|query\("BEGIN"\)/;

/**
 * The lines of one handler, from its registration to the line that closes it.
 *
 * Read from the source rather than from a hand-copied excerpt so the assertions cannot pass against
 * a stale copy of code that has since changed.
 */
const handlerBody = (registration) => {
  const start = codeLines.findIndex((line) => line.startsWith(registration));
  assert.notEqual(start, -1, `${registration} is no longer registered; this list is stale`);
  let end = start;
  while (end < codeLines.length - 1 && !BODY_END.test(codeLines[end])) end += 1;
  return { start, lines: codeLines.slice(start, end + 1) };
};

const firstIndex = (lines, pattern) => lines.findIndex((line) => pattern.test(line));

/**
 * Every route this stage guards, with the permission key it must use and why that key.
 *
 * `keys` is exhaustive and exact — a route naming a key not listed here fails, which is what stops
 * someone reaching for a broad key (`settings`, `reports`) to make a 403 go away. Where two keys are
 * listed the route serves two different money movements, or demands two authorities at once.
 */
const MONEY_ROUTES = [
  {
    registration: 'app.post("/accounts/payments"',
    label: "POST /accounts/payments",
    keys: ["customer_payments", "supplier_payments"],
    why: "one route, two movements: money in from a customer and money out to a supplier",
  },
  {
    registration: 'app.put("/accounts/payments/:paymentKey"',
    label: "PUT /accounts/payments/:paymentKey",
    keys: ["customer_payments", "supplier_payments"],
    why: "restating the amount of a payment already in the ledger is the same authority as recording it",
  },
  {
    registration: 'app.post("/accounts/payments/:paymentKey/cancel"',
    label: "POST /accounts/payments/:paymentKey/cancel",
    keys: ["customer_payments", "supplier_payments", "invoice_cancellation"],
    why: "voiding a recorded payment is stricter than recording one — it needs the void authority too",
  },
  {
    registration: 'app.post("/customer-payments"',
    label: "POST /customer-payments",
    keys: ["customer_payments"],
    why: "receives cash against a customer's outstanding invoices",
  },
  {
    registration: 'app.post("/contra-entries"',
    label: "POST /contra-entries",
    keys: ["contra_entries"],
    why: "moves money between cash in hand and the bank; no pre-existing key described that authority",
  },
  {
    registration: 'app.post("/expenses"',
    label: "POST /expenses",
    keys: ["expenses"],
    why: "spends the shop's money; `reports` was the closest existing key and grants far more than it says",
  },
  {
    registration: 'app.put("/expenses/:id"',
    label: "PUT /expenses/:id",
    keys: ["expenses"],
    why: "restates the amount of a recorded expense",
  },
  {
    registration: 'app.post("/expenses/:id/cancel"',
    label: "POST /expenses/:id/cancel",
    keys: ["expenses", "invoice_cancellation"],
    why: "an expense that one person can both enter and void is an untraceable withdrawal",
  },
  {
    registration: 'app.post("/supplier-payments"',
    label: "POST /supplier-payments",
    keys: ["supplier_payments"],
    why: "pays a supplier; a Cashier is deliberately denied this key in the seeded roles",
  },
  {
    registration: 'app.put("/supplier-payments/:id"',
    label: "PUT /supplier-payments/:id",
    keys: ["supplier_payments"],
    why: "restates the amount of a supplier payment",
  },
  {
    registration: 'app.post("/supplier-payments/:id/cancel"',
    label: "POST /supplier-payments/:id/cancel",
    keys: ["supplier_payments", "invoice_cancellation"],
    why: "voiding a supplier payment is the classic fraud path this stage exists to close",
  },
  {
    registration: "const createSaleReturnHandler",
    label: "POST /sale-returns and POST /api/v3/sale-returns",
    keys: ["billing"],
    why: "refunds money at the counter; `billing` is the authority the counter already holds",
  },
  {
    registration: "const createWasteEntryHandler",
    label: "POST /waste-entries and POST /api/v3/waste-entries",
    keys: ["waste_management"],
    why: "writes stock off at cost, which lands in the profit report",
  },
];

test("every money route checks a permission before it touches the database", () => {
  for (const { registration, label, keys, why } of MONEY_ROUTES) {
    const { lines } = handlerBody(registration);
    const guard = firstIndex(lines, /getPermissionUser\(/);
    const write = firstIndex(lines, DATABASE_WRITE);
    assert.notEqual(guard, -1, `${label} has no permission check at all — it ${why}`);
    assert.ok(
      write === -1 || guard < write,
      `${label} reaches a database write before its permission check`,
    );
  }
});

test("each money route uses exactly the permission key chosen for it", () => {
  for (const { registration, label, keys } of MONEY_ROUTES) {
    const { lines } = handlerBody(registration);
    const body = lines.join("\n");
    const named = [...body.matchAll(/getPermissionUser\([^,]+,\s*(?:"([a-z_]+)"|(\w+))/g)]
      .map((match) => match[1])
      .filter(Boolean);
    // A key held in a local (the two-sided payment routes pick theirs from the account type) is
    // matched from its assignment instead, so the table still sees every key the route can require.
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

test("the actor on a money route is the session, never a field the caller wrote", () => {
  for (const { registration, label } of MONEY_ROUTES) {
    const { lines } = handlerBody(registration);
    const body = lines.join("\n");
    assert.match(
      body,
      /req\.auth\.userId/,
      `${label} must take its actor from the verified session`,
    );
    assert.doesNotMatch(
      body,
      /req\.body\.(created_by|edited_by|cancelled_by|updated_by|changed_by)/,
      `${label} must not read an actor out of the body it is meant to attribute`,
    );
    // The `|| 1` half. An omitted field used to file the payment, expense or write-off under user 1,
    // which in a single-owner shop is the Owner: a false audit record produced by sending nothing.
    assert.doesNotMatch(
      body,
      /_by[^\n]*\|\|\s*1\b/,
      `${label} must not default its actor to user 1`,
    );
  }
});

test("no actor anywhere in the file falls back to user 1", () => {
  // Scoped to the file rather than to these routes, because the next handler written in the old
  // style will not be on the list above until someone adds it.
  assert.doesNotMatch(
    backendCode,
    /parsePositiveInteger\(\s*(req\.)?body\.\w+_by\s*\)\s*(\|\|\s*parsePositiveInteger\([^)]*\)\s*)*\|\|\s*1\b/,
    "an actor id defaulting to 1 attributes the row to the Owner when the client sends nothing",
  );
});

test("the two new permission keys exist and are seeded so no existing install is locked out", () => {
  for (const key of ["expenses", "contra_entries"]) {
    assert.match(
      backendCode,
      new RegExp(`^\\s*"${key}",$`, "m"),
      `${key} must be in PERMISSION_KEYS — getPermissionUser returns null for a key it does not know, so the route would 403 for everyone but the Owner`,
    );
  }

  // The migration that decides what happens on the maintainer's Monday morning. `expenses` copies
  // each role's stored `reports` value — the key the shipped client gates the Expenses screen on —
  // so every role that records expenses today still records them after the upgrade. Seeding it
  // Owner/Admin-only would have silently taken expense entry away from the Purchase and Inventory
  // Managers, which is a worse outcome than the hole being closed a release later.
  const ownerAdminSeed = backendCode.indexOf(`SET permissions = permissions || '{"expenses":true}'::jsonb`);
  const inheritReports = backendCode.search(
    /SET permissions = permissions \|\| jsonb_build_object\('expenses', COALESCE\(permissions -> 'reports', 'false'::jsonb\)\)\s*\n\s*WHERE NOT \(permissions \? 'expenses'\);/,
  );
  assert.ok(inheritReports > 0, "the expenses key must inherit each role's reports value where it is not already stored");
  // Owner and Admin are granted before the inherit runs, and the inherit skips any role that already
  // has the key. The client treats both as all-modules roles whatever the row says, so an Admin with
  // Reports unticked would otherwise see the Expenses screen and be refused by the server.
  assert.ok(ownerAdminSeed > 0, "Owner and Admin must be granted the expenses key outright");
  assert.ok(ownerAdminSeed < inheritReports, "the Owner/Admin grant must run before the inherit-from-reports statement");

  // Both keys are added by `permissions || ...` guarded on the key being absent, so a restart never
  // overwrites a decision the maintainer has since made in the role table.
  for (const key of ["expenses", "contra_entries"]) {
    const guards = backendCode.match(new RegExp(`NOT \\(permissions \\? '${key}'\\)`, "g")) || [];
    assert.ok(guards.length > 0, `the ${key} seed must be idempotent across restarts`);
  }
  assert.doesNotMatch(
    backendCode,
    /permissions \|\| '\{"contra_entries":true\}'::jsonb\s*\n\s*WHERE role_name NOT IN/,
    "contra entries must be granted to named roles, never to everyone the seed does not mention",
  );
});

test("a permission key absent from a submitted role payload is stored as false", () => {
  // Not a defect — it is what makes the role editor authoritative — but it is the reason the two new
  // keys need rows in `permissionLabels` in `frontend/src/App.jsx`. Until they have them the shipped
  // editor cannot show or change them; it round-trips the stored object, so the seeded values
  // survive a save, and any client that posts a partial payload silently clears them.
  assert.match(
    backendCode,
    /const normalized = PERMISSION_KEYS\.reduce\(\(payload, key\) => \(\{ \.\.\.payload, \[key\]: Boolean\(permissions\[key\]\) \}\), \{\}\);/,
    "role permissions are normalized over every key; a key missing from the payload is written false",
  );
});

/** Every registration that reaches one of the guarded handlers, including the protocol-v3 mounts. */
const MONEY_ROUTE_KEYS = [
  "POST /accounts/payments",
  "PUT /accounts/payments/:paymentKey",
  "POST /accounts/payments/:paymentKey/cancel",
  "POST /customer-payments",
  "POST /contra-entries",
  "POST /expenses",
  "PUT /expenses/:id",
  "POST /expenses/:id/cancel",
  "POST /supplier-payments",
  "PUT /supplier-payments/:id",
  "POST /supplier-payments/:id/cancel",
  "POST /sale-returns",
  "POST /api/v3/sale-returns",
  "POST /waste-entries",
  "POST /api/v3/waste-entries",
];

test("every money route requires a verified session", async () => {
  // The guards read `req.auth.userId`. On a route reachable without a session that is `undefined`,
  // and the guard would throw into the handler's catch and answer 500 — an internal error rendered
  // where a denial belongs. Allow-listing one of these later fails here with the reason attached.
  const coverage = await collectRouteAuthCoverage();
  const byKey = new Map(coverage.map((route) => [route.key, route]));

  const missing = MONEY_ROUTE_KEYS.filter((key) => !byKey.has(key));
  assert.deepEqual(missing, [], "these routes are no longer registered; the list is stale");

  const open = MONEY_ROUTE_KEYS
    .filter((key) => !byKey.get(key).authenticated)
    .map((key) => `${key} :: ${byKey.get(key).evidence}`);
  assert.deepEqual(open, [], "these routes move money and can be reached without a verified session");
});

test("the auth layer never covered created_by, which is why the routes had to change", () => {
  // The boundary the whole stage rests on. `rejectDeviceSessionSubstitution` pins user_id, device_id,
  // company_id and branch_id to the token and nothing else, so a valid session for user 9 carrying
  // `created_by: 1` is accepted — correctly, because `created_by` is not an identity claim. No
  // middleware was ever going to stop a Cashier signing the Owner's name on a payment; only the
  // handlers could. If someone later widens the check and deletes the source assertions above, this
  // records what was actually being relied on.
  const claims = { user_id: 9, device_id: "FZDEV-A4C", company_id: 1, branch_id: 1 };
  const stamping = submittedIdentityFrom({
    headers: {},
    body: { created_by: 1, edited_by: 1, cancelled_by: 1 },
    query: {},
  });
  assert.equal(
    rejectDeviceSessionSubstitution(claims, stamping),
    null,
    "the request is accepted; only the handler's choice of actor decides whose name goes on the row",
  );

  // And the contrast, so this is not read as "the check is broken": the fields it does cover are
  // covered, in every location they can arrive from.
  const impersonating = submittedIdentityFrom({
    headers: { "x-user-id": "9" },
    body: { user_id: 1 },
    query: {},
  });
  assert.equal(
    rejectDeviceSessionSubstitution(claims, impersonating)?.code,
    "DEVICE_SESSION_SUBSTITUTION_REJECTED",
    "an agreeing header must not buy a disagreeing body past the check",
  );
});
