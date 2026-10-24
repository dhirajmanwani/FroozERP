"use strict";

/**
 * `business_settings.logo_url`: the shop's own logo, and what PUT /settings/business does with it.
 *
 * The parser is pure and tested directly. The route is driven through
 * `routeAuthCoverage.loadServerApp()` like the other route suites -- the real Express app, a
 * stubbed database, no network.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseBusinessLogo } = require("./businessLogo");
const {
  loadServerApp,
  probe,
  setQueryResponder,
  clearQueryResponder,
  setConnectionResponder,
  clearConnectionResponder,
} = require("./routeAuthCoverage");
const { issueDeviceSession } = require("./deviceSession");

// A real 1x1 PNG.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// -------------------------------------------------------------------------------------------
// parseBusinessLogo
// -------------------------------------------------------------------------------------------

test("no logo is absent, null or blank", () => {
  for (const value of [undefined, null, "", "   "]) {
    assert.deepEqual(parseBusinessLogo(value), { ok: true, value: null }, JSON.stringify(value));
  }
});

test("a save that does not send the logo keeps the stored one; null or blank sent on purpose clears it", () => {
  assert.deepEqual(parseBusinessLogo(undefined, PNG), { ok: true, value: PNG });
  assert.deepEqual(parseBusinessLogo(null, PNG), { ok: true, value: null });
  assert.deepEqual(parseBusinessLogo("", PNG), { ok: true, value: null });
});

test("an uploaded picture is kept as sent", () => {
  assert.deepEqual(parseBusinessLogo(PNG), { ok: true, value: PNG });
});

test("a web address, a file path or a non-picture is refused, never stored", () => {
  for (const value of [
    "https://example.com/logo.png",
    "C:\\Users\\shop\\logo.png",
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    "data:image/png;base64,not-base64!",
    "data:image/png;base64,/9j/4AAQ", // JPEG bytes labelled PNG
    42,
    {},
  ]) {
    const result = parseBusinessLogo(value);
    assert.equal(result.ok, false, JSON.stringify(value));
    assert.equal(result.code, "LOGO_INVALID");
    assert.match(result.message, /logo/i);
  }
});

test("a picture over 200 KB is refused", () => {
  const big = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(201 * 1024)]).toString("base64")}`;
  const result = parseBusinessLogo(big);
  assert.equal(result.ok, false);
  assert.match(result.message, /200 KB/);
});

test("a value identical to the stored one is kept, so an old typed path cannot block saving", () => {
  assert.deepEqual(parseBusinessLogo("/logo.png", "/logo.png"), { ok: true, value: "/logo.png" });
  assert.equal(parseBusinessLogo("/other.png", "/logo.png").ok, false);
});

// -------------------------------------------------------------------------------------------
// Route
// -------------------------------------------------------------------------------------------

const app = loadServerApp();

/** Must match the throwaway key `routeAuthCoverage` pins into the environment before loading. */
const TEST_SIGNING_KEY = "route-auth-coverage-isolated-signing-key-000000";
const OWNER_ID = 7;
const COMPANY_ID = 1;
const DEVICE_ID = "FZDEV-BUSINESS-LOGO";

const token = issueDeviceSession({
  userId: OWNER_ID, deviceId: DEVICE_ID, companyId: COMPANY_ID, branchId: 1, role: "Owner", secret: TEST_SIGNING_KEY,
});

const normalise = (sql) => String(sql).replace(/\s+/g, " ").trim();
const rows = (list) => ({ rows: list, rowCount: list.length });

const call = async (body, { storedLogo = null } = {}) => {
  const statements = [];
  const respond = (rawSql, values = []) => {
    const sql = normalise(typeof rawSql === "object" && rawSql ? rawSql.text : rawSql);
    statements.push({ sql, values });
    if (/FROM authorized_devices d/i.test(sql)) {
      return rows([{
        device_id: DEVICE_ID, device_status: "APPROVED", company_id: COMPANY_ID, branch_id: 1,
        operational_location_id: 10, assignment_generation: 1, fixed_operational: true, intended_usage: "POS",
        device_permissions: {}, device_assignment_active: true, location_active: true, branch_active: true,
        role_id: 1, is_default: true, staff_permissions: {}, staff_assignment_active: true, role_name: "Owner",
      }]);
    }
    if (/SELECT session_revocation_version FROM users/i.test(sql)) return rows([{ session_revocation_version: 0 }]);
    if (/role_permission_settings/i.test(sql)) {
      return rows([{ id: OWNER_ID, full_name: "Rig Owner", username: "owner", branch_id: 1, role_name: "Owner", permissions: {} }]);
    }
    if (/^SELECT u\.id, u\.full_name, r\.role_name FROM users u JOIN roles r/.test(sql)) {
      return rows([{ id: OWNER_ID, full_name: "Rig Owner", role_name: "Owner" }]);
    }
    if (/^SELECT logo_url FROM business_settings/.test(sql)) return rows([{ logo_url: storedLogo }]);
    if (/^UPDATE business_settings/.test(sql)) return rows([{ id: 1, logo_url: values[6] }]);
    return rows([]);
  };
  setQueryResponder(respond);
  setConnectionResponder(() => ({ query: async (sql, values) => respond(sql, values), release: () => {} }));
  try {
    const response = await probe(app, "PUT", "/settings/business", {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    }, { business_name: "Frooz", ...body });
    return { response, statements };
  } finally {
    clearQueryResponder();
    clearConnectionResponder();
  }
};

const update = (statements) => statements.find(({ sql }) => /^UPDATE business_settings/.test(sql));

test("PUT stores an uploaded logo", async () => {
  const { response, statements } = await call({ logo_url: PNG });
  assert.equal(response.status, 200, response.text);
  assert.equal(update(statements).values[6], PNG);
});

test("PUT with no logo clears it back to the Frooz mark", async () => {
  const { response, statements } = await call({ logo_url: "" }, { storedLogo: PNG });
  assert.equal(response.status, 200, response.text);
  assert.equal(update(statements).values[6], null);
});

test("PUT refuses a web address and writes nothing", async () => {
  const { response, statements } = await call({ logo_url: "https://example.com/logo.png" });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, "LOGO_INVALID");
  assert.equal(update(statements), undefined);
});

test("PUT keeps an old typed path that is sent back unchanged", async () => {
  const { response, statements } = await call({ logo_url: "/old/logo.png" }, { storedLogo: "/old/logo.png" });
  assert.equal(response.status, 200, response.text);
  assert.equal(update(statements).values[6], "/old/logo.png");
});
