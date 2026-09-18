"use strict";

/**
 * A-7 — a branch reads its own staff list and nobody else's.
 *
 * ## What is being tested, and why it is tested this way
 *
 * The routes are driven for real and their SQL is executed, against an in-memory SQLite holding two
 * shops' staff. That is deliberate. A source assertion — "the handler mentions `branch_id`" — would
 * have passed on a query that mentions the branch in a `LEFT JOIN` and filters by nothing, and this
 * repository has already shipped a branch predicate that Postgres refused to run. The question
 * worth answering is the one the shopkeeper asks: *when the Admin of the Market Yard shop opens the
 * staff screen, whose names are on it?* So these tests read the rows out of the HTTP response.
 *
 * SQLite is close enough to run this SQL unchanged — plain `SELECT`s with two `LEFT JOIN`s — and,
 * unlike Postgres, it needs nothing installed. `$1` is rewritten to `?` on the way in, which also
 * means a statement whose values do not line up with its placeholders fails here rather than in
 * production.
 *
 * Both reads are covered because there are two of them and only one is obvious. `GET /users` is the
 * documented API and carries the recovery fields; `GET /settings` is what the app actually calls to
 * paint the screen. Scoping the first alone would have left the leak exactly where Dhiraj saw it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");

const {
  resolveUserDirectoryScope,
  buildUserDirectoryQuery,
  buildSettingsUserListQuery,
} = require("./userDirectoryScope");
const {
  loadServerApp,
  probe,
  setQueryResponder,
  clearQueryResponder,
} = require("./routeAuthCoverage");
const { issueDeviceSession } = require("./deviceSession");

/** Must match the throwaway key `routeAuthCoverage` pins into the environment before loading. */
const TEST_SIGNING_KEY = "route-auth-coverage-isolated-signing-key-000000";

/* ------------------------------------------------------------------ the scope decision itself */

test("the Owner sees every branch", () => {
  assert.deepEqual(
    resolveUserDirectoryScope({ roleName: "Owner", branchId: 1 }),
    { everyBranch: true, branchId: null },
  );
});

test("anyone else is held to the branch their session was issued for", () => {
  assert.deepEqual(
    resolveUserDirectoryScope({ roleName: "Admin", branchId: 2 }),
    { everyBranch: false, branchId: 2 },
  );
});

test("a session with no branch is refused rather than widened", () => {
  // The failure that matters. Falling back to "show everything" is the bug; falling back to a
  // guessed branch shows one shop's staff to someone we could not place. Both are worse than
  // saying so, and an empty list would read as a shop with no staff in it.
  for (const branchId of [undefined, null, 0, -1, "", "all", Number.NaN]) {
    assert.throws(
      () => resolveUserDirectoryScope({ roleName: "Admin", branchId }),
      (error) => error.code === "USER_DIRECTORY_BRANCH_REQUIRED",
      `branch ${String(branchId)} must not resolve to a scope`,
    );
  }
});

test("the role spelling does not decide the answer", () => {
  // `normalizeRoleName` elsewhere in the backend upper-cases and collapses whitespace; a role that
  // arrives as "owner" from one query and "Owner" from another must not change who sees what.
  for (const roleName of ["owner", "OWNER", " Owner "]) {
    assert.equal(resolveUserDirectoryScope({ roleName, branchId: 2 }).everyBranch, true);
  }
  for (const roleName of ["Admin", "Cashier", "Purchase Manager", "", null]) {
    assert.equal(resolveUserDirectoryScope({ roleName, branchId: 2 }).everyBranch, false);
  }
});

test("both lists are built from the same filter", () => {
  // Summary and detail sharing filter semantics, applied to two reads of one table. If these ever
  // differ, the settings screen and the API disagree about who works here.
  const scope = resolveUserDirectoryScope({ roleName: "Admin", branchId: 3 });
  const directory = buildUserDirectoryQuery(scope);
  const settings = buildSettingsUserListQuery(scope);
  assert.match(directory.text, /WHERE u\.branch_id = \$1/);
  assert.match(settings.text, /WHERE u\.branch_id = \$1/);
  assert.deepEqual(directory.values, [3]);
  assert.deepEqual(settings.values, [3]);
});

test("every placeholder a query names is bound", () => {
  // The arity check `queryArity.test.js` cannot make here, because these statements are built in a
  // function rather than written as literals at the call site.
  for (const build of [buildUserDirectoryQuery, buildSettingsUserListQuery]) {
    for (const scope of [{ everyBranch: true, branchId: null }, { everyBranch: false, branchId: 9 }]) {
      const { text, values } = build(scope);
      const placeholders = new Set([...text.matchAll(/\$(\d+)/g)].map(([, n]) => Number(n)));
      assert.equal(placeholders.size, values.length, `${text} binds ${values.length} values`);
      for (const position of placeholders) {
        assert.ok(position >= 1 && position <= values.length, `no value for $${position}`);
      }
    }
  }
});

/* ------------------------------------------------------------- the routes, over real fixtures */

/**
 * Two shops, five people. Rahul is the Admin of the Market Yard shop and is the caller these tests
 * care about: under the old code he could read Asha's and Dhiraj's recovery email.
 */
const BRANCHES = [
  { id: 1, branch_name: "Main Shop", company_id: 1 },
  { id: 2, branch_name: "Market Yard", company_id: 1 },
];
const ROLES = [
  { id: 1, role_name: "Owner" },
  { id: 2, role_name: "Admin" },
  { id: 3, role_name: "Cashier" },
];
const USERS = [
  { id: 1, full_name: "Dhiraj", username: "dhiraj", role_id: 1, branch_id: 1, recovery_email: "dhiraj@example.com", recovery_mobile: "9000000001" },
  { id: 2, full_name: "Asha", username: "asha", role_id: 2, branch_id: 1, recovery_email: "asha@example.com", recovery_mobile: "9000000002" },
  { id: 3, full_name: "Rahul", username: "rahul", role_id: 2, branch_id: 2, recovery_email: "rahul@example.com", recovery_mobile: "9000000003" },
  { id: 4, full_name: "Meena", username: "meena", role_id: 3, branch_id: 2, recovery_email: "meena@example.com", recovery_mobile: "9000000004" },
  { id: 5, full_name: "Vikas", username: "vikas", role_id: 3, branch_id: 1, recovery_email: "vikas@example.com", recovery_mobile: "9000000005" },
];

/** Every column the two statements select, so the fixture answers them the way Postgres would. */
const USER_COLUMNS = [
  "id", "full_name", "username", "mobile_number", "email", "active", "joining_date", "notes",
  "last_login_at", "created_at", "updated_at", "verified_email", "verified_mobile",
  "recovery_enabled", "recovery_email", "recovery_email_verified", "recovery_email_verified_at",
  "recovery_mobile", "recovery_mobile_verified", "recovery_mobile_verified_at",
  "pending_recovery_email", "pending_recovery_mobile", "staff_self_recovery_enabled",
  "force_password_change", "session_revocation_version", "locked_until", "role_id", "branch_id",
  "company_id",
];

const fixtureDatabase = () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE users (${USER_COLUMNS.join(", ")})`);
  db.exec("CREATE TABLE roles (id, role_name)");
  db.exec("CREATE TABLE branches (id, branch_name, company_id)");
  for (const role of ROLES) db.prepare("INSERT INTO roles (id, role_name) VALUES (?, ?)").run(role.id, role.role_name);
  for (const branch of BRANCHES) {
    db.prepare("INSERT INTO branches (id, branch_name, company_id) VALUES (?, ?, ?)")
      .run(branch.id, branch.branch_name, branch.company_id);
  }
  for (const user of USERS) {
    const row = {
      ...Object.fromEntries(USER_COLUMNS.map((column) => [column, null])),
      ...user,
      active: 1,
      // As in production: nothing has ever written it, which is why the scope cannot use it.
      company_id: null,
    };
    db.prepare(`INSERT INTO users (${USER_COLUMNS.join(", ")}) VALUES (${USER_COLUMNS.map(() => "?").join(", ")})`)
      .run(...USER_COLUMNS.map((column) => row[column]));
  }
  return db;
};

/**
 * Run a Postgres statement against the fixture.
 *
 * `$1` becomes `?` in order of appearance, so a statement that names a placeholder it was not given
 * a value for throws here — the same class of failure Postgres reports as "there is no parameter".
 */
const runFixtureQuery = (db, sql, values = []) => {
  const order = [];
  const translated = sql.replace(/\$(\d+)/g, (_match, position) => {
    order.push(Number(position));
    return "?";
  });
  const bound = order.map((position) => {
    if (position > values.length) throw new Error(`there is no parameter $${position}`);
    return values[position - 1];
  });
  return { rows: db.prepare(translated).all(...bound) };
};

const isUserListQuery = (sql) => /FROM users u/.test(sql) && /LEFT JOIN roles r ON r\.id = u\.role_id/.test(sql);
const isManagerLookup = (sql) => /FROM users u/.test(sql)
  && /WHERE u\.id = \$1 AND u\.active = TRUE/.test(sql);

let app;

/**
 * Sign in as one of the fixture users and read a route.
 *
 * `role` is what the *token* claims, which is not always what the database says — that difference
 * is itself under test. The manager lookup is answered from the fixture, so the role that decides
 * the scope is the stored one.
 */
const readAs = async (route, { userId, branchId, role }) => {
  if (!app) app = loadServerApp();
  const db = fixtureDatabase();
  const token = issueDeviceSession({
    userId,
    deviceId: "FZDEV-USER-DIRECTORY",
    companyId: 1,
    branchId,
    role,
    secret: TEST_SIGNING_KEY,
  });
  const statements = [];
  setQueryResponder((sql, values) => {
    statements.push({ sql, values });
    if (isManagerLookup(sql)) return runFixtureQuery(db, sql, values);
    if (isUserListQuery(sql)) return runFixtureQuery(db, sql, values);
    // Everything else in the settings bundle answers emptily; none of it is what is being asked.
    return { rows: [], rowCount: 0 };
  });
  try {
    const response = await probe(app, "GET", route, { authorization: `Bearer ${token}` });
    return { response, statements };
  } finally {
    clearQueryResponder();
    db.close();
  }
};

const namesIn = (rows) => (rows || []).map((row) => row.full_name).sort();

test("the Admin of one shop sees only that shop's staff", async () => {
  const { response } = await readAs("/users", { userId: 3, branchId: 2, role: "Admin" });
  assert.equal(response.status, 200);
  assert.deepEqual(namesIn(response.body), ["Meena", "Rahul"]);
});

test("and cannot read the other shop's recovery details at all", async () => {
  // The fields that matter: an account is taken back with these. Asserted against the whole
  // serialised body rather than field by field, so a future column carrying the same value —
  // `pending_recovery_email`, say — cannot slip through a per-field check.
  const { response } = await readAs("/users", { userId: 3, branchId: 2, role: "Admin" });
  const body = JSON.stringify(response.body);
  for (const leaked of ["dhiraj@example.com", "asha@example.com", "vikas@example.com", "9000000001"]) {
    assert.ok(!body.includes(leaked), `${leaked} belongs to another branch and must not be in the response`);
  }
  assert.ok(body.includes("rahul@example.com"), "their own branch's details are still returned");
});

test("the Owner still sees everybody", async () => {
  const { response } = await readAs("/users", { userId: 1, branchId: 1, role: "Owner" });
  assert.equal(response.status, 200);
  assert.deepEqual(namesIn(response.body), ["Asha", "Dhiraj", "Meena", "Rahul", "Vikas"]);
});

test("a token that claims Owner does not widen the list", async () => {
  // Rahul is an Admin in the database and an Owner in this token. A scope decided from
  // `req.auth.normalizedRole` would hand him every branch; the role has to be the stored one, the
  // same rule the rest of the backend follows for authorisation.
  const { response } = await readAs("/users", { userId: 3, branchId: 2, role: "Owner" });
  assert.equal(response.status, 200);
  assert.deepEqual(namesIn(response.body), ["Meena", "Rahul"]);
});

test("a token claiming another branch reads that claim, not a request field", async () => {
  // The branch is pinned into the session and verified on every request, so this is the honest
  // statement of what the scope follows: change the session's branch and the list changes with it.
  const { response } = await readAs("/users", { userId: 3, branchId: 1, role: "Admin" });
  assert.deepEqual(namesIn(response.body), ["Asha", "Dhiraj", "Vikas"]);
});

test("the settings screen's own list is scoped the same way", async () => {
  // The one the app actually renders. Under the old code this was a second, separate
  // `SELECT ... FROM users` with no predicate, and fixing only `GET /users` would have changed
  // nothing on screen.
  const { response } = await readAs("/settings", { userId: 3, branchId: 2, role: "Admin" });
  assert.equal(response.status, 200);
  assert.deepEqual(namesIn(response.body.users), ["Meena", "Rahul"]);
});

test("the Owner's settings bundle still carries every branch's staff", async () => {
  const { response } = await readAs("/settings", { userId: 1, branchId: 1, role: "Owner" });
  assert.deepEqual(namesIn(response.body.users), ["Asha", "Dhiraj", "Meena", "Rahul", "Vikas"]);
});

test("the staff list is read with a branch predicate, not filtered afterwards", async () => {
  // Filtering in JavaScript after reading every row would satisfy every assertion above and still
  // send the whole users table across the wire on its way there. The predicate has to be in the
  // statement, and it has to carry the session's branch as its value.
  const { statements } = await readAs("/users", { userId: 3, branchId: 2, role: "Admin" });
  const listQueries = statements.filter(({ sql }) => isUserListQuery(sql) && !isManagerLookup(sql));
  assert.equal(listQueries.length, 1, "one staff-list read per request");
  assert.match(listQueries[0].sql, /WHERE u\.branch_id = \$1/);
  assert.deepEqual(listQueries[0].values, [2]);
});
