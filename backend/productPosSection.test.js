"use strict";

/**
 * `products.pos_section`: the owner's choice of POS shelf, and what the product routes do with it.
 *
 * The parser is pure and tested directly. The routes are driven through
 * `routeAuthCoverage.loadServerApp()` like the other route suites -- the real Express app, a
 * stubbed database, no network -- so these prove what the handlers said to the database and what
 * they answered, not what a real PostgreSQL would have returned.
 *
 * The rule the update block exists for: PUT rewrites every product column, and a desktop build
 * older than the shelf picker does not send `pos_section`. Absent must keep the stored choice; only
 * an explicit null (or "") resets it to automatic.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { POS_SECTIONS, POS_SECTION_INVALID, parsePosSection } = require("./productPosSection");
const {
  loadServerApp,
  probe,
  setQueryResponder,
  clearQueryResponder,
  setConnectionResponder,
  clearConnectionResponder,
} = require("./routeAuthCoverage");
const { issueDeviceSession } = require("./deviceSession");

// -------------------------------------------------------------------------------------------
// parsePosSection
// -------------------------------------------------------------------------------------------

test("the three shelves are the whole contract", () => {
  assert.deepEqual([...POS_SECTIONS], ["retail", "bar", "moments"]);
});

test("absent, null and empty mean automatic", () => {
  for (const value of [undefined, null, "", "   "]) {
    assert.deepEqual(parsePosSection(value), { ok: true, value: null }, JSON.stringify(value));
  }
});

test("a shelf key is trimmed and lower-cased", () => {
  assert.deepEqual(parsePosSection("retail"), { ok: true, value: "retail" });
  assert.deepEqual(parsePosSection(" Bar "), { ok: true, value: "bar" });
  assert.deepEqual(parsePosSection("MOMENTS"), { ok: true, value: "moments" });
});

test("anything else is refused, never turned into automatic", () => {
  for (const value of ["auto", "automatic", "kitchen", "retail,bar", 0, 1, false, true, {}, ["bar"]]) {
    const result = parsePosSection(value);
    assert.equal(result.ok, false, JSON.stringify(value));
    assert.equal(result.code, POS_SECTION_INVALID);
    assert.match(result.message, /POS section/);
  }
});

// -------------------------------------------------------------------------------------------
// Routes
// -------------------------------------------------------------------------------------------

const app = loadServerApp();

/** Must match the throwaway key `routeAuthCoverage` pins into the environment before loading. */
const TEST_SIGNING_KEY = "route-auth-coverage-isolated-signing-key-000000";
const OWNER_ID = 7;
const COMPANY_ID = 1;
const PRODUCT_ID = 41;
const DEVICE_ID = "FZDEV-POS-SECTION";

const token = issueDeviceSession({
  userId: OWNER_ID, deviceId: DEVICE_ID, companyId: COMPANY_ID, branchId: 1, role: "Owner", secret: TEST_SIGNING_KEY,
});

const normalise = (sql) => String(sql).replace(/\s+/g, " ").trim();
const rows = (list) => ({ rows: list, rowCount: list.length });
const find = (statements, pattern) => statements.filter(({ sql }) => pattern.test(sql));
const writes = (statements) => statements.filter(({ sql }) => /^(INSERT|UPDATE|DELETE)\b/i.test(sql));

const CATEGORY = { id: 3, global_id: "category-3", category_name: "Fruit", active: true, company_id: COMPANY_ID };

const storedProduct = (overrides = {}) => ({
  id: PRODUCT_ID, global_id: `product-${PRODUCT_ID}`, product_name: "Apple", selling_rate: "120.00",
  unit: "KG", barcode: null, origin_type: "LOCAL", category: "Fruit", category_id: CATEGORY.id,
  minimum_stock: "0.000", active: true, remarks: null, company_id: COMPANY_ID, entity_version: 4,
  pos_section: null, ...overrides,
});

let operation = 0;

const call = async (method, url, body, { current = storedProduct() } = {}) => {
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
    if (/^SELECT \* FROM product_categories WHERE id = \$1/.test(sql)) return rows([CATEGORY]);
    if (/^SELECT \* FROM products WHERE id = \$1/.test(sql)) return rows(current ? [current] : []);
    if (/^INSERT INTO products/.test(sql)) {
      return rows([storedProduct({ id: 99, global_id: values[11], product_name: values[0], pos_section: values[13] })]);
    }
    if (/^UPDATE products SET product_name/.test(sql)) {
      return rows([{ ...current, product_name: values[0], pos_section: values[12], entity_version: current.entity_version + 1 }]);
    }
    return rows([]);
  };
  setQueryResponder(respond);
  setConnectionResponder(() => ({ query: async (sql, values) => respond(sql, values), release: () => {} }));
  operation += 1;
  try {
    const response = await probe(app, method, url, {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    }, { idempotency_key: `pos-section-test-${operation}`, ...body });
    return { response, statements };
  } finally {
    clearQueryResponder();
    clearConnectionResponder();
  }
};

const productBody = (extra = {}) => ({
  product_name: "Apple", selling_rate: 120, unit: "KG", origin_type: "LOCAL",
  category: "Fruit", category_id: CATEGORY.id, minimum_stock: 0, ...extra,
});

const columnValue = (statement, column) => {
  const columns = statement.sql.slice(statement.sql.indexOf("(") + 1, statement.sql.indexOf(") VALUES")).split(",").map((name) => name.trim());
  const placeholders = statement.sql.slice(statement.sql.indexOf("VALUES (") + 8, statement.sql.indexOf(") RETURNING")).split(",").map((name) => name.trim());
  const index = columns.indexOf(column);
  assert.ok(index >= 0, `${column} is not in the INSERT`);
  return statement.values[Number(placeholders[index].slice(1)) - 1];
};

/** The value the UPDATE binds to `pos_section`, read off the SET clause rather than a fixed index. */
const updatedPosSection = (statement) => {
  const match = statement.sql.match(/pos_section = \$(\d+)/);
  assert.ok(match, "the UPDATE does not set pos_section");
  return statement.values[Number(match[1]) - 1];
};

test("create stores the chosen shelf, normalised", async () => {
  const { response, statements } = await call("POST", "/api/v3/products", productBody({ pos_section: " Bar " }));
  assert.equal(response.status, 201, response.text);
  const [insert] = find(statements, /^INSERT INTO products/);
  assert.equal(columnValue(insert, "pos_section"), "bar");
  assert.equal(response.body.product.pos_section, "bar");
  // What every device pulls: the product's sync_change_log payload is the whole row.
  const [sync] = find(statements, /^INSERT INTO sync_change_log/i);
  assert.ok(sync, "the product change was not published to devices");
  const payload = sync.values.find((value) => typeof value === "string" && value.startsWith("{"));
  assert.equal(JSON.parse(payload).pos_section, "bar", "the device payload carries the shelf");
});

test("create without the field stores NULL (automatic)", async () => {
  const { response, statements } = await call("POST", "/api/v3/products", productBody());
  assert.equal(response.status, 201, response.text);
  assert.equal(columnValue(find(statements, /^INSERT INTO products/)[0], "pos_section"), null);
});

test("create refuses an unknown shelf with POS_SECTION_INVALID and writes nothing", async () => {
  const { response, statements } = await call("POST", "/api/v3/products", productBody({ pos_section: "kitchen" }));
  assert.equal(response.status, 400);
  assert.equal(response.body.code, POS_SECTION_INVALID);
  assert.match(response.body.message, /POS section/);
  assert.deepEqual(writes(statements), []);
});

test("update stores a newly chosen shelf", async () => {
  const { response, statements } = await call("PUT", `/api/v3/products/${PRODUCT_ID}`, productBody({ pos_section: "moments" }));
  assert.equal(response.status, 200, response.text);
  assert.equal(updatedPosSection(find(statements, /^UPDATE products SET product_name/)[0]), "moments");
});

test("update from an older build that omits the field keeps the stored shelf", async () => {
  const { response, statements } = await call("PUT", `/api/v3/products/${PRODUCT_ID}`, productBody(), {
    current: storedProduct({ pos_section: "bar" }),
  });
  assert.equal(response.status, 200, response.text);
  assert.equal(updatedPosSection(find(statements, /^UPDATE products SET product_name/)[0]), "bar");
});

test("update with an explicit null resets the shelf to automatic", async () => {
  const { response, statements } = await call("PUT", `/api/v3/products/${PRODUCT_ID}`, productBody({ pos_section: null }), {
    current: storedProduct({ pos_section: "bar" }),
  });
  assert.equal(response.status, 200, response.text);
  assert.equal(updatedPosSection(find(statements, /^UPDATE products SET product_name/)[0]), null);
});

test("update refuses an unknown shelf with POS_SECTION_INVALID and writes nothing", async () => {
  const { response, statements } = await call("PUT", `/api/v3/products/${PRODUCT_ID}`, productBody({ pos_section: 3 }), {
    current: storedProduct({ pos_section: "bar" }),
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, POS_SECTION_INVALID);
  assert.deepEqual(writes(statements), []);
});
