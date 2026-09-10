"use strict";

/**
 * A row written without a company is invisible, and nothing says so.
 *
 * ## What it cost
 *
 * `company_id` was added to `products`, `product_categories`, `customers` and `suppliers` as a
 * nullable column by migration 009. Every reader scopes with `company_id = $1`, and in SQL
 * `NULL = 1` is NULL rather than false -- so a row with no company is not rejected, it is quietly
 * absent from every result. The reference bootstrap is one of those readers.
 *
 * That is how the shop's cloud came to hold 25 products, 13 suppliers and 70 inventory lots that
 * no device could ever be given: the rows were there, the sync succeeded, and the screens stayed
 * empty for two days while a healthy cloud reported success. `POST /accounts` -- the route the
 * Accounts screen actually uses -- was still writing new suppliers and customers that way, so a
 * one-off repair of the old rows would have been undone by the next supplier the shop added.
 *
 * ## The rule
 *
 * Every INSERT into a company-scoped table, in a route handler, must name `company_id`. Not "the
 * ones we remembered" -- all of them, because the cost of forgetting one is invisible until a
 * counter is empty and the fault is two weeks old by the time anyone looks.
 *
 * Statements inside `initializeDatabase()` are exempt: they run before any company exists, and
 * seed rows and legacy backfills there have no session to take a company from.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SERVER = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

/** Tables whose rows belong to one company, and whose readers scope by it. */
const COMPANY_SCOPED_TABLES = ["products", "product_categories", "customers", "suppliers"];

/** `server.js` with the startup bootstrap removed. */
const routeHandlers = () => {
  const start = SERVER.indexOf("const initializeDatabase = async");
  assert.notEqual(start, -1, "initializeDatabase() must still exist");
  const closing = /\r?\n\};\r?\n/g;
  closing.lastIndex = start;
  const end = closing.exec(SERVER);
  assert.ok(end, "the end of initializeDatabase() must still be findable");
  return SERVER.slice(0, start) + SERVER.slice(end.index);
};

const lineOf = (source, index) => source.slice(0, index).split("\n").length;

test("every INSERT into a company-scoped table names company_id", () => {
  const handlers = routeHandlers();
  const offenders = [];

  for (const table of COMPANY_SCOPED_TABLES) {
    for (const match of handlers.matchAll(new RegExp(`INSERT INTO ${table}\\s*\\(([^)]*)\\)`, "gi"))) {
      if (!/\bcompany_id\b/.test(match[1])) {
        offenders.push(`${table} at handler line ${lineOf(handlers, match.index)}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "these writes produce rows no device can ever be sent:\n  " + offenders.join("\n  "),
  );
});

test("the company comes from the verified token, never from the request body", () => {
  // The identity rule the auth track exists to hold. A company id taken from the body would let a
  // caller file a supplier under another shop while holding a perfectly valid session of their own.
  const handlers = routeHandlers();

  // The three places a company may legitimately come from, all of them derived from a verified
  // token: `req.auth` on an ordinary route, the resolved sync `context`, and the v3 operational
  // context. Anything else -- and `req.body` above all -- would let a caller file a supplier under
  // another shop while holding a perfectly valid session of their own.
  // Optional chaining and both spellings are allowed -- the file uses `req.auth.companyId`,
  // `req.auth?.companyId`, `context.companyId` and `context?.company_id` -- because the rule is
  // about where the value comes from, not how it is punctuated.
  const VERIFIED = /(req\.auth|context|v3OperationalContext)\??\.(companyId|company_id)/;
  let checked = 0;

  for (const match of handlers.matchAll(/const companyId = ([^;]+);/g)) {
    const expression = match[1].replace(/\s+/g, " ");
    const where = `companyId at handler line ${lineOf(handlers, match.index)}`;
    assert.match(expression, VERIFIED, `${where} must come from a verified identity: ${expression}`);
    assert.ok(
      !/req\.(body|query|headers)/.test(expression),
      `${where} must not read the request: ${expression}`,
    );
    checked += 1;
  }

  // Without this the rule passes on a file where every one of them was renamed away.
  assert.ok(checked >= 4, `expected the scoped routes to resolve a company, found ${checked}`);
});

test("a duplicate check is scoped the same way as the insert it guards", () => {
  // Otherwise the uniqueness rule and the insert disagree: the shop is refused a supplier name
  // because of a row in another company that it cannot see, or is allowed a duplicate of its own.
  const handlers = routeHandlers();
  const offenders = [];

  for (const table of ["customers", "suppliers"]) {
    for (const match of handlers.matchAll(new RegExp(`SELECT id\\s+FROM ${table}\\b([\\s\\S]{0,420}?)LIMIT 1`, "gi"))) {
      if (!/company_id/.test(match[1])) {
        offenders.push(`${table} duplicate check at handler line ${lineOf(handlers, match.index)}`);
      }
    }
  }

  assert.deepEqual(offenders, [], "unscoped duplicate checks:\n  " + offenders.join("\n  "));
});

test("the exemption is the bootstrap only, and it is really removed", () => {
  // Without this the first test passes on a slice that accidentally dropped the whole file, which
  // is the failure mode of every "search what is left" assertion.
  const handlers = routeHandlers();
  assert.ok(handlers.length > SERVER.length / 2, "the slice must still be most of server.js");
  assert.ok(!handlers.includes("const initializeDatabase = async"), "the bootstrap must be removed");
  assert.ok(handlers.includes('app.post("/accounts"'), "route handlers must still be present");
  assert.ok(
    handlers.match(/INSERT INTO suppliers\s*\(/gi).length >= 2,
    "the supplier writes this rule governs must still be in the slice",
  );
});
