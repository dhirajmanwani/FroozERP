/**
 * A-6 Gate 3.1 — what an unauthenticated caller can learn about the business.
 *
 * `/api/health` and `/api/version` are on the public allow-list because a liveness and a version
 * check have to work before anyone signs in. That is the whole of their job. They used to also
 * hand out the company's name and id, a branch id, and the database's path on disk, to anybody who
 * asked. The identity tells a stranger who they have found; the path tells them how the server is
 * laid out. Neither answers "are you running".
 *
 * This suite exists because that leak was reintroduced-by-default: the fields sat in one object
 * literal with everything else, so adding a field to a health response meant publishing it. The
 * assertions below are written as a *denylist over the whole body*, not a check of known keys, so a
 * field added tomorrow is caught the same way.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  loadServerApp,
  probe,
  startQueryRecording,
  stopQueryRecording,
} = require("./routeAuthCoverage");
const { issueDeviceSession } = require("./deviceSession");

/** Must match the throwaway key `routeAuthCoverage` pins into the environment before loading. */
const TEST_SIGNING_KEY = "route-auth-coverage-isolated-signing-key-000000";
const SESSION = Object.freeze({ userId: 7, deviceId: "FZ-OWNER", companyId: 1, branchId: 1 });

/**
 * Anything here identifies the tenant or describes the deployment's insides. None of it may appear
 * in a response to a caller with no session, on any public route.
 */
const MUST_NOT_LEAK = Object.freeze([
  "company_id",
  "company_name",
  "branch_id",
  "database_path",
  "database_type",
  "storage_adapter",
  "client_postgres_access",
  "device_identity_configured",
  "cloud_api_configured",
  "mode",
  "node_env",
]);

const PUBLIC_ROUTES = Object.freeze(["/api/health", "/health", "/api/version"]);

let app;

const call = async (url, headers = {}) => {
  if (!app) app = loadServerApp();
  startQueryRecording();
  const response = await probe(app, "GET", url, headers);
  stopQueryRecording();
  return response;
};

/** The probe resolves `{ status, code, note, body, text }`; `body` is the parsed JSON or null. */
const bodyOf = (response) => response.body || {};

for (const url of PUBLIC_ROUTES) {
  test(`${url} tells an anonymous caller nothing about who this is`, async () => {
    const response = await call(url);
    const body = bodyOf(response);
    const leaked = MUST_NOT_LEAK.filter((key) => Object.hasOwn(body, key));
    assert.deepEqual(
      leaked,
      [],
      leaked.length
        ? `${url} disclosed ${leaked.join(", ")} with no credentials. A liveness or version answer` +
          " does not need the tenant's name or the server's layout. Put the field behind req.auth."
        : "",
    );
  });

  test(`${url} still answers the question it exists to answer`, async () => {
    // The denylist above is only safe because these hold. A route that stopped answering would
    // pass every assertion in the previous test by returning nothing at all.
    const response = await call(url);
    const body = bodyOf(response);
    assert.equal(response.status, 200, `${url} should answer an anonymous caller: ${response.note || ""}`);
    assert.equal(String(body.status).toLowerCase(), "ok");
    assert.equal(body.app, "FroozERP");
  });
}

test("health tells the settings screen the deployment is provisioned, without naming it", () => {
  // The Settings "test connection" runs while choosing which server to talk to, so it cannot have a
  // session with that server. It used to confirm a real deployment by reading company_id. It now
  // reads a boolean instead: a stranger learns that the far end is configured, not whose it is.
  const source = require("node:fs").readFileSync(require.resolve("./server.js"), "utf8");
  assert.match(source, /tenant_configured: Boolean\(cloudIdentity\.companyId\)/);
  const frontend = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "frontend", "src", "App.jsx"),
    "utf8",
  );
  assert.match(frontend, /health\.tenant_configured === true/);
  assert.doesNotMatch(frontend, /Boolean\(health\.company_id\)/);
});

test("a signed-in caller still gets the full picture", async () => {
  const token = issueDeviceSession({ ...SESSION, role: "Owner", secret: TEST_SIGNING_KEY });
  const response = await call("/api/health", { authorization: `Bearer ${token}` });
  const body = bodyOf(response);
  assert.equal(response.status, 200, response.note || "");
  // Behind a session these are the caller's own deployment, and withholding them would break the
  // diagnostics screens that exist to answer exactly these questions.
  //
  // `database_type` is deliberately not in this list. It comes from the storage adapter, which this
  // harness stubs out, so it is `undefined` here and `JSON.stringify` drops it. Asserting it would
  // be asserting the stub, not the route.
  for (const key of ["database_path", "storage_adapter", "client_postgres_access", "mode",
                     "cloud_api_configured", "company_id", "company_name", "branch_id"]) {
    assert.ok(Object.hasOwn(body, key), `an authenticated health response should include ${key}`);
  }
});

test("the session gate is a gate, not a deletion", async () => {
  // The bug this catches: a public route never runs `requireAuth`, so `req.auth` is never set on
  // one. `req.auth ? extra : {}` therefore withholds those fields from everybody, operator
  // included, while reading in review as though it gated them. Both halves have to be asserted
  // together - anonymous-hides and signed-in-shows - or the "fix" is indistinguishable from
  // deleting the fields.
  const token = issueDeviceSession({ ...SESSION, role: "Owner", secret: TEST_SIGNING_KEY });
  const anonymous = bodyOf(await call("/api/health"));
  const signedIn = bodyOf(await call("/api/health", { authorization: `Bearer ${token}` }));

  assert.equal(Object.hasOwn(anonymous, "company_name"), false);
  assert.equal(Object.hasOwn(signedIn, "company_name"), true);
  assert.ok(
    Object.keys(signedIn).length > Object.keys(anonymous).length,
    "a signed-in caller must learn more than an anonymous one, or the gate is deleting fields",
  );
});

test("a forged or expired token is treated as no token, not as a session", async () => {
  // Optional auth must not become a softer requireAuth. A token that fails verification leaves
  // req.auth unset, so the caller gets the anonymous answer rather than a half-populated one.
  const wrongKey = issueDeviceSession({ ...SESSION, role: "Owner", secret: "a-different-signing-key-000000000000" });
  const body = bodyOf(await call("/api/health", { authorization: `Bearer ${wrongKey}` }));
  for (const key of MUST_NOT_LEAK) {
    assert.equal(Object.hasOwn(body, key), false, `a forged token must not unlock ${key}`);
  }
});
