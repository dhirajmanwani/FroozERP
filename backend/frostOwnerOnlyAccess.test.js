"use strict";

/**
 * FROST belongs to the Owner, and its writer routes take the actor from the verified session.
 *
 * ## The three bugs this pins
 *
 * **1. The role lists were decorative.** Every FROST route carried its own `fallbackRoles`, several
 * naming Cashier, and they read like restrictions. They restricted nothing. `getPermissionUser`
 * returns the user the moment the *stored* permission is `true` and never consults the list -- and
 * `server.js` seeded Cashier, Purchase Manager and Inventory Manager with
 * `ai_assistant_view: true`. So a route annotated `["Owner", "Admin"]` was open to a Cashier, and
 * the annotation was the reason nobody noticed.
 *
 * **2. `POST /api/ai/query/stream` had no per-intent check at all.** Its sibling `/api/ai/query`
 * re-checks `ai_financial_insights` before answering a money question. The streaming route went
 * straight from "may you open FROST" to handing over the whole fact bundle -- sales, gross profit,
 * expenses, collections. One copy of a security rule had drifted from the other, which is what
 * happens to two copies of a security rule.
 *
 * **3. Four writer routes took the actor from the request body.** `requireRateManager(req.body.updated_by
 * || req.body.user_id)`. The app-wide substitution check compares `user_id`, `device_id`,
 * `company_id` and `branch_id` -- `updated_by` is on none of those lists -- so a signed-in Cashier
 * who sent `{"updated_by": <owner id>}` and omitted `user_id` passed every check and wrote FROST's
 * settings, or approved its saved memories, recorded as the Owner. This is the exact A-4 hole that
 * `requireAiPermission`'s own comment describes as closed, surviving one layer below it.
 *
 * ## Why these are source assertions
 *
 * There is no database and no Express app here, so "did a Cashier get an answer" is not answerable.
 * What is answerable is whether the identity is read from the verified claim, whether both
 * answering routes run the same gate, and whether the seeding still opens the door -- and each of
 * those is the mistake that was actually made.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  FROST_DEFAULT_ROLES,
  FINANCIAL_INTENTS,
  INVENTORY_INTENTS,
} = require("./aiBusinessAssistantService");

const stripComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const SERVICE = stripComments(fs.readFileSync(path.join(__dirname, "aiBusinessAssistantService.js"), "utf8"));
const SERVER = stripComments(fs.readFileSync(path.join(__dirname, "server.js"), "utf8"));

test("FROST's default role list is the Owner alone", () => {
  assert.deepEqual(FROST_DEFAULT_ROLES, ["Owner"]);
});

test("no FROST route carries its own role list any more", () => {
  // A literal list here is how the lie started: it looks like a policy, and it is overridden by a
  // stored permission without anyone being told.
  const inlineLists = [...SERVICE.matchAll(/fallbackRoles: \[[^\]]*\]/g)].map(([match]) => match);
  assert.deepEqual(inlineLists, [], "these routes still declare a role list instead of FROST_DEFAULT_ROLES");
  assert.ok(
    SERVICE.includes("fallbackRoles: FROST_DEFAULT_ROLES"),
    "the routes must reference the single shared list",
  );
});

test("the writer routes take the actor from the verified session, never the request", () => {
  // `req.auth` is the only identity. Anything read out of the body or query here is the A-4 hole.
  const managerCalls = [...SERVICE.matchAll(/requireRateManager\(([^)]*)\)/g)].map(([, arg]) => arg.trim());
  assert.ok(managerCalls.length >= 4, `expected the FROST writer routes, found ${managerCalls.length}`);
  for (const arg of managerCalls) {
    assert.equal(arg, "req.auth.userId", `a FROST writer route resolves its actor from ${arg}`);
  }
  assert.doesNotMatch(SERVICE, /requireRateManager\(req\.(?:body|query)\./);
  assert.doesNotMatch(SERVICE, /req\.body\.updated_by \|\| req\.body\.user_id/);
});

test("both answering routes run the same per-intent gate", () => {
  // Two copies drifted once; there is now one function and both routes must call it.
  assert.match(SERVICE, /const enforceIntentPermission = async \(\{/, "the shared gate is missing");
  const gateCalls = [...SERVICE.matchAll(/enforceIntentPermission\(\{/g)];
  assert.equal(gateCalls.length, 2, "expected exactly one call from each answering route");

  for (const route of ['app.post("/api/ai/query"', 'app.post("/api/ai/query/stream"']) {
    const start = SERVICE.indexOf(route);
    assert.notEqual(start, -1, `${route} is missing`);
    const body = SERVICE.slice(start, start + 2000);
    assert.ok(body.includes("enforceIntentPermission"), `${route} does not run the per-intent gate`);
  }
});

test("the streaming route refuses before it becomes a stream", () => {
  // Once `Content-Type: text/event-stream` is set a 403 or 500 can no longer be sent, and the
  // refusal would reach the client as a stream that never explains itself.
  const start = SERVICE.indexOf('app.post("/api/ai/query/stream"');
  const body = SERVICE.slice(start, start + 2500);
  const gateAt = body.indexOf("enforceIntentPermission");
  const groundedAt = body.indexOf("assertGroundedAnswer");
  const headerAt = body.indexOf("text/event-stream");
  assert.ok(gateAt !== -1 && groundedAt !== -1 && headerAt !== -1, "the streaming route lost one of its steps");
  assert.ok(gateAt < headerAt, "the permission gate must run before the SSE headers");
  assert.ok(groundedAt < headerAt, "the grounding check must run before the SSE headers");
});

test("the financial and inventory intent lists are the ones the gate uses", () => {
  // If an intent is added to the classifier and to neither list, it answers with no second check.
  // Naming them here makes that omission visible rather than silent.
  assert.deepEqual(FINANCIAL_INTENTS, [
    "SALES_FINANCE",
    "CASH_DRAWER",
    "SUPPLIER_MARGIN",
    "PROFIT_RANKING",
    "LOSS_REVIEW",
    "SALE_RATE_REVIEW",
  ]);
  assert.deepEqual(INVENTORY_INTENTS, ["INVENTORY", "INVENTORY_EXPIRY", "PURCHASE_PLANNING"]);
});

test("FROST memory writes cannot reach another branch's row", () => {
  // The insert always scoped by branch; approve, patch and delete matched on `id` alone, so an id
  // from another branch was editable from here.
  const scopedWrites = [
    /UPDATE frost_memories[\s\S]{0,400}?WHERE id = \$1 AND branch_id = \$3/,
    /UPDATE frost_memories[\s\S]{0,900}?WHERE id = \$1 AND branch_id = \$9/,
    /DELETE FROM frost_memories WHERE id = \$1 AND branch_id = \$2/,
  ];
  for (const pattern of scopedWrites) {
    assert.match(SERVICE, pattern, "a frost_memories write is not scoped to the caller's branch");
  }
});

test("a FROST memory write that matches nothing refuses instead of returning an empty body", () => {
  // `res.json(undefined)` sends an empty response, and the panel would have read that as a save
  // that worked. An unmatched row is a 404 with a code.
  const notFound = [...SERVICE.matchAll(/FROST_MEMORY_NOT_FOUND/g)];
  assert.ok(notFound.length >= 2, "approve and patch must both refuse an unmatched row");
});

test("the seeding grants FROST to the Owner and to nobody else", () => {
  // The seeded `true` is what defeated every route's role list. Admin shared that line, and the
  // statement carries no "already set?" guard, so it re-applied on every start -- no tightening
  // could have survived a restart while Admin was named there.
  const grants = [...SERVER.matchAll(/'\{"ai_assistant_view":true[^']*'::jsonb\s*\n\s*WHERE ([^;]*);/g)]
    .map(([, where]) => where.trim());
  assert.equal(grants.length, 1, "FROST access should be granted in exactly one place");
  assert.equal(grants[0], "role_name = 'Owner'", "only the Owner may be seeded with FROST access");
  assert.match(SERVER, /"ai_assistant_view":false/);
});

test("existing installs are tightened exactly once, so a later grant is not undone", () => {
  // The bootstrap re-runs on every start. A blanket UPDATE would silently revoke a permission the
  // Owner had granted from the role-permissions screen, every time the server restarted.
  assert.match(SERVER, /"ai_owner_only_applied":true/);
  assert.match(SERVER, /AND NOT \(permissions \? 'ai_owner_only_applied'\)/);
  assert.match(SERVER, /WHERE role_name <> 'Owner'/, "every non-Owner role is tightened, not a named few");
});
