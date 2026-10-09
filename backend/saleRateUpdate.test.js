"use strict";

/**
 * The owner's morning rate update: `GET /sale-rates` and `POST /sale-rates/bulk`.
 *
 * Two halves. The rules in `saleRateUpdate.js` are driven directly. Then the two routes are driven
 * through `routeAuthCoverage.loadServerApp()` like the other route suites: the real Express app, a
 * scripted database, no network, no `app.listen`. That proves what the handlers said to the database
 * and what they answered, which is where every bug fixed on 30 Sep 2026 lived:
 *
 *   - a product-rate save bumped no `entity_version` and wrote no `sync_change_log` row, so desktop
 *     counters kept selling at the old product rate;
 *   - a lot was found by id and product only, so a hand-made request could re-price another
 *     branch's lot;
 *   - rates were compared and written to history unrounded;
 *   - a product with no cost was "suggested" its own current rate, and a 0% target became 25%.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  DEFAULT_DESIRED_MARGIN,
  effectiveLotRate,
  finiteOrNull,
  normalizeRateUpdate,
  productRateSyncPayload,
  resolveDesiredMargin,
  resolveRoundingRule,
  roundSuggestedRate,
  sameRate,
  suggestSellingRate,
} = require("./saleRateUpdate");

const {
  loadServerApp,
  probe,
  setQueryResponder,
  clearQueryResponder,
  setConnectionResponder,
  clearConnectionResponder,
} = require("./routeAuthCoverage");
const { issueDeviceSession } = require("./deviceSession");

const app = loadServerApp();
const SOURCE = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

test("the suggestion is cost plus the target margin on cost, rounded by the Settings rule", () => {
  assert.equal(suggestSellingRate(120, 25, "NEAREST_RUPEE"), 150);
  assert.equal(suggestSellingRate("45.00", 25, "NEAREST_RUPEE"), 56);
  assert.equal(suggestSellingRate(45, 25, "ROUND_UP_5"), 60);
  assert.equal(suggestSellingRate(45, 25, "ROUND_UP_10"), 60);
  assert.equal(suggestSellingRate(45, 25, "NO_ROUND"), 56.25);
  assert.equal(suggestSellingRate(45, 25, "SOMETHING_ELSE"), 56, "an unknown rule is the nearest rupee");
});

test("no purchase cost means no suggestion, never the current rate handed back as one", () => {
  for (const cost of [0, "0", "0.00", null, undefined, "", "abc", -5]) {
    assert.equal(suggestSellingRate(cost, 25, "NEAREST_RUPEE"), null, `cost ${String(cost)}`);
  }
});

test("rounding up never jumps a whole step on float noise", () => {
  assert.equal(suggestSellingRate(40, 25, "ROUND_UP_5"), 50);
  assert.equal(suggestSellingRate(8, 25, "ROUND_UP_10"), 10);
  assert.equal(roundSuggestedRate(50.0000000000001, "ROUND_UP_5"), 50);
  assert.equal(roundSuggestedRate(50.01, "ROUND_UP_5"), 55);
  assert.equal(roundSuggestedRate(null, "ROUND_UP_5"), null);
});

test("a 0% target is kept at every step; blank or invalid falls through to the setting, then 25", () => {
  assert.equal(resolveDesiredMargin("0", 30), 0);
  assert.equal(resolveDesiredMargin(undefined, "0.00"), 0, "a saved 0% is not turned into 25%");
  assert.equal(resolveDesiredMargin("", "30"), 30);
  assert.equal(resolveDesiredMargin("-4", "30"), 30);
  assert.equal(resolveDesiredMargin("abc", null), DEFAULT_DESIRED_MARGIN);
  assert.equal(resolveDesiredMargin("12.5", 30), 12.5);
  assert.equal(suggestSellingRate(120, 0, "NEAREST_RUPEE"), 120);
});

test("rounding rules are the four Settings offers, anything else is the nearest rupee", () => {
  assert.equal(resolveRoundingRule("round_up_5"), "ROUND_UP_5");
  assert.equal(resolveRoundingRule("NO_ROUND"), "NO_ROUND");
  assert.equal(resolveRoundingRule(undefined), "NEAREST_RUPEE");
  assert.equal(resolveRoundingRule("ROUND_DOWN"), "NEAREST_RUPEE");
});

test("a bulk entry is rounded to 2 dp and its ids are the server's own integers", () => {
  assert.deepEqual(normalizeRateUpdate({ product_id: 3, inventory_batch_id: null, new_selling_rate: "12.345" }),
    { productId: 3, inventoryBatchId: null, newRate: 12.35, reason: "" });
  assert.deepEqual(normalizeRateUpdate({ product_id: "7", inventory_batch_id: "11", new_selling_rate: 60, reason: "  Rain  " }),
    { productId: 7, inventoryBatchId: 11, newRate: 60, reason: "Rain" });
  assert.equal(normalizeRateUpdate({ product_id: 3, new_selling_rate: 50, reason: 42 }).reason, "", "a non-text reason is ignored, not a crash");
});

test("a bulk entry with a bad id or rate is refused, never guessed", () => {
  for (const update of [
    { product_id: -3, new_selling_rate: 10 }, // the old screen sent the row id `-product_id`
    { product_id: "abc", new_selling_rate: 10 },
    { product_id: 3.5, new_selling_rate: 10 },
    { product_id: 3, new_selling_rate: 0 },
    { product_id: 3, new_selling_rate: "" },
    { product_id: 3, new_selling_rate: -1 },
    { product_id: 3, inventory_batch_id: "lot-x", new_selling_rate: 10 }, // a lot named but unreadable
    { product_id: 3, inventory_batch_id: 0, new_selling_rate: 10 },
    null,
  ]) {
    assert.ok(normalizeRateUpdate(update).error, `should refuse ${JSON.stringify(update)}`);
  }
});

test("a lot's current rate is its own when set, else the product rate -- the rule POS uses", () => {
  assert.equal(effectiveLotRate("190.00", "180.00"), 190);
  assert.equal(effectiveLotRate("0.00", "180.00"), 180, "a lot at the product rate is not 'old rate 0'");
  assert.equal(effectiveLotRate(null, "180.00"), 180);
  assert.equal(effectiveLotRate(0, null), 0);
});

test("rates are compared as money", () => {
  assert.equal(sameRate("12.35", 12.35), true);
  assert.equal(sameRate(12.345, "12.35"), true);
  assert.equal(sameRate(12.34, 12.35), false);
  assert.equal(sameRate(null, 0), false);
});

test("the product change a counter pulls carries its rate as a number", () => {
  // node-postgres returns NUMERIC as text; the desktop reads `selling_rate` with `as_f64()`.
  const payload = productRateSyncPayload({ id: 3, global_id: "product-3", selling_rate: "160.00", minimum_stock: "2.500", product_name: "Mango" });
  assert.equal(payload.selling_rate, 160);
  assert.equal(payload.minimum_stock, 2.5);
  assert.equal(payload.global_id, "product-3");
  assert.equal(productRateSyncPayload({ selling_rate: null }).selling_rate, null, "unknown stays unknown");
  assert.equal(finiteOrNull("  "), null);
});

// ---------------------------------------------------------------------------------------------
// Routes, against a scripted database
// ---------------------------------------------------------------------------------------------

const TEST_SIGNING_KEY = "route-auth-coverage-isolated-signing-key-000000";
const SESSION_BRANCH_ID = 2;
const OWNER_ID = 7;

const tokenFor = ({ userId = OWNER_ID, branchId = SESSION_BRANCH_ID } = {}) => issueDeviceSession({
  userId,
  deviceId: "FZDEV-SALE-RATES",
  companyId: 1,
  branchId,
  role: "Owner",
  secret: TEST_SIGNING_KEY,
});

const normalise = (sql) => String(sql).replace(/\s+/g, " ").trim();

const MANAGER_SQL = /^SELECT u\.id, u\.full_name, r\.role_name FROM users u JOIN roles r/;

const call = async (method, url, { body, role = "Owner", answer = () => undefined } = {}) => {
  const statements = [];
  const respond = (sql, values) => {
    const text = normalise(sql);
    statements.push({ sql: text, values: values || [] });
    if (MANAGER_SQL.test(text)) {
      return role ? { rows: [{ id: OWNER_ID, full_name: "Rig Owner", role_name: role }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/role_permission_settings/i.test(text)) {
      return { rows: [{ id: OWNER_ID, full_name: "Rig Owner", username: "rig", branch_id: SESSION_BRANCH_ID, role_name: role, permissions: {} }], rowCount: 1 };
    }
    const scripted = answer(text, values || []);
    return scripted === undefined ? { rows: [], rowCount: 0 } : scripted;
  };
  setQueryResponder(respond);
  setConnectionResponder(() => ({
    query: async (sql, values) => respond(typeof sql === "object" && sql ? sql.text : sql, values),
    release: () => {},
  }));
  try {
    const response = await probe(app, method, url, { authorization: `Bearer ${tokenFor()}`, "content-type": "application/json" }, body);
    return { response, statements };
  } finally {
    clearQueryResponder();
    clearConnectionResponder();
  }
};

const find = (statements, pattern) => statements.filter(({ sql }) => pattern.test(sql));
const writes = (statements) => statements.filter(({ sql }) => /^(INSERT|UPDATE|DELETE)\b/i.test(sql));

const rows = (list) => ({ rows: list, rowCount: list.length });

test("GET /sale-rates: suggestions from cost at the asked margin, none without a cost, branch from the session", async () => {
  const { response, statements } = await call("GET", "/sale-rates?desired_margin=0", {
    answer: (sql) => {
      if (/FROM sale_rate_settings/.test(sql)) return rows([{ id: 1, desired_margin_percent: "25.00", rounding_rule: "NEAREST_RUPEE" }]);
      if (/AS latest_effective_cost/.test(sql)) {
        return rows([
          { id: 11, product_id: 1, inventory_batch_id: 11, selling_rate: "180.00", latest_effective_cost: "120.00" },
          { id: -3, product_id: 3, inventory_batch_id: null, selling_rate: "150.00", latest_effective_cost: "0" },
        ]);
      }
      return undefined;
    },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const [lot, product] = response.body;
  assert.equal(lot.suggested_selling_rate, 120, "a 0% target suggests the cost, not cost + 25%");
  assert.equal(product.suggested_selling_rate, null, "no cost, no suggestion");
  const [list] = find(statements, /AS latest_effective_cost/);
  // Branch for the stock, company for the catalogue -- both from the session (company 1).
  assert.deepEqual(list.values, [SESSION_BRANCH_ID, 1]);
  assert.match(list.sql, /AND \(p\.company_id IS NULL OR p\.company_id = \$2\)/, "another company's products are not listed");
});

test("GET /sale-rates is refused to a role that does not manage rates", async () => {
  const { response, statements } = await call("GET", "/sale-rates", { role: "Cashier" });
  assert.equal(response.status, 403);
  assert.equal(find(statements, /AS latest_effective_cost/).length, 0);
});

const productRow = (overrides = {}) => ({ id: 3, global_id: "product-rig-3", selling_rate: "150.00", entity_version: 5, product_name: "Rig Mango", ...overrides });

const productSave = ({ current = "150.00" } = {}) => (sql, values) => {
  if (/^SELECT id, selling_rate FROM products WHERE id = \$1 AND active = TRUE AND \(company_id IS NULL OR company_id = \$2\) FOR UPDATE$/.test(sql)) {
    // Found only for the session's company (1).
    return values[0] === 3 && values[1] === 1 ? rows([{ id: 3, selling_rate: current }]) : rows([]);
  }
  if (/^UPDATE products SET selling_rate = \$1/.test(sql)) {
    return rows([productRow({ selling_rate: values[0].toFixed(2), entity_version: 6 })]);
  }
  if (/^INSERT INTO sync_change_log/.test(sql)) return rows([{ change_id: "901", created_at: "2026-09-30T02:00:00Z" }]);
  return undefined;
};

test("POST /sale-rates/bulk: a product-rate save bumps the version and publishes to the owner's branch", async () => {
  const { response, statements } = await call("POST", "/sale-rates/bulk", {
    body: { updates: [{ product_id: 3, inventory_batch_id: null, new_selling_rate: 160 }], changed_by: 999 },
    answer: productSave(),
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.updated_count, 1);

  const [update] = find(statements, /^UPDATE products SET selling_rate/);
  assert.match(update.sql, /entity_version = entity_version \+ 1/);
  assert.deepEqual(update.values, [160, OWNER_ID, 3]);

  const [history] = find(statements, /^INSERT INTO sale_rate_history/);
  assert.deepEqual(history.values.slice(0, 4), [3, 150, 160, OWNER_ID], "changed_by comes from the session, never the body");

  const [change] = find(statements, /^INSERT INTO sync_change_log/);
  assert.ok(change, "a product-rate change must reach desktop counters");
  assert.equal(change.values[0], SESSION_BRANCH_ID);
  assert.equal(change.values[3], "sale_rate");
  assert.equal(change.values[4], "product-rig-3");
  assert.equal(change.values[6], 6, "the change carries the bumped version");
  assert.equal(JSON.parse(change.values[7]).selling_rate, 160, "the rate is a number the desktop can read");

  assert.ok(find(statements, /^COMMIT$/).length === 1);
});

test("POST /sale-rates/bulk: a product-rate change reaches every active branch of the company", async () => {
  // Sync pull reads the change log by branch. Logged to the owner's branch alone, the new rate
  // reached that branch's counters and no other branch's.
  const OTHER_BRANCH_ID = SESSION_BRANCH_ID + 5;
  const { response, statements } = await call("POST", "/sale-rates/bulk", {
    body: { updates: [{ product_id: 3, new_selling_rate: 160 }] },
    answer: (sql, values) => {
      if (/^SELECT id FROM branches WHERE company_id = \(SELECT company_id FROM branches WHERE id = \$1\)/.test(sql)) {
        assert.match(sql, /active IS DISTINCT FROM FALSE/);
        return values[0] === SESSION_BRANCH_ID ? rows([{ id: OTHER_BRANCH_ID }]) : rows([]);
      }
      return productSave()(sql, values);
    },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const changes = find(statements, /^INSERT INTO sync_change_log/);
  assert.deepEqual(changes.map((change) => change.values[0]), [SESSION_BRANCH_ID, OTHER_BRANCH_ID]);
  for (const change of changes) {
    assert.equal(change.values[3], "sale_rate");
    assert.equal(change.values[4], "product-rig-3");
    assert.equal(change.values[6], 6);
  }
});

test("POST /sale-rates/bulk: another company's product is not found", async () => {
  const { response, statements } = await call("POST", "/sale-rates/bulk", {
    body: { updates: [{ product_id: 4, new_selling_rate: 160 }] },
    answer: productSave(),
  });
  assert.equal(response.status, 404);
  const [select] = find(statements, /^SELECT id, selling_rate FROM products/);
  assert.deepEqual(select.values, [4, 1], "the session's company, never one the request names");
  assert.equal(find(statements, /^UPDATE products/).length, 0);
});

test("GET /sale-rate-history: only the caller's company's products", async () => {
  const { response, statements } = await call("GET", "/sale-rate-history");
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const [history] = find(statements, /FROM sale_rate_history h/);
  assert.match(history.sql, /WHERE p\.company_id IS NULL OR p\.company_id = \$1/);
  assert.deepEqual(history.values, [1]);
});

test("POST /sale-rates/bulk: an unchanged rate (as money) is skipped and not counted", async () => {
  const { response, statements } = await call("POST", "/sale-rates/bulk", {
    body: { updates: [{ product_id: 3, new_selling_rate: 150.004 }] },
    answer: productSave({ current: "150.00" }),
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.updated_count, 0);
  assert.equal(writes(statements).length, 0);
});

test("POST /sale-rates/bulk: rates are stored and recorded at 2 dp", async () => {
  const { statements } = await call("POST", "/sale-rates/bulk", {
    body: { updates: [{ product_id: 3, new_selling_rate: "12.345" }] },
    answer: productSave(),
  });
  assert.equal(find(statements, /^UPDATE products SET selling_rate/)[0].values[0], 12.35);
  assert.equal(find(statements, /^INSERT INTO sale_rate_history/)[0].values[2], 12.35);
});

const lotSave = ({ lot = { id: 11, product_id: 1, branch_id: SESSION_BRANCH_ID, temporary_sale_rate: "0.00", product_selling_rate: "180.00", lot_name: "Lot A", product_name: "Rig Apple" } } = {}) => (sql, values) => {
  if (/^SELECT ib\.\*, p\.product_name/.test(sql)) {
    const matches = lot && values[0] === lot.id && values[1] === lot.product_id && values[2] === lot.branch_id;
    return rows(matches ? [lot] : []);
  }
  if (/^UPDATE inventory_batches SET temporary_sale_rate/.test(sql)) return rows([{ ...lot, temporary_sale_rate: String(values[0]) }]);
  return undefined;
};

test("POST /sale-rates/bulk: a lot is found only in the session's branch", async () => {
  const { statements } = await call("POST", "/sale-rates/bulk", {
    body: { updates: [{ product_id: 1, inventory_batch_id: 11, new_selling_rate: 175 }] },
    answer: lotSave(),
  });
  const [select] = find(statements, /^SELECT ib\.\*, p\.product_name/);
  assert.match(select.sql, /ib\.branch_id = \$3/);
  assert.deepEqual(select.values, [11, 1, SESSION_BRANCH_ID]);
  const [update] = find(statements, /^UPDATE inventory_batches SET temporary_sale_rate/);
  assert.match(update.sql, /branch_id = \$3/);
  assert.deepEqual(update.values, [175, 11, SESSION_BRANCH_ID]);
});

test("POST /sale-rates/bulk: another branch's lot is refused and nothing is written", async () => {
  const { response, statements } = await call("POST", "/sale-rates/bulk", {
    body: { updates: [
      { product_id: 3, new_selling_rate: 160 },
      { product_id: 1, inventory_batch_id: 11, new_selling_rate: 175 },
    ] },
    answer: (sql, values) => productSave()(sql, values) ?? lotSave({ lot: { id: 11, product_id: 1, branch_id: 9 } })(sql, values),
  });
  assert.equal(response.status, 404);
  assert.equal(find(statements, /^ROLLBACK$/).length, 1, "the whole save is undone, not half of it");
  assert.equal(find(statements, /^COMMIT$/).length, 0);
  assert.equal(find(statements, /^UPDATE inventory_batches/).length, 0);
});

test("POST /sale-rates/bulk: a lot at the product rate records the product rate as its old rate", async () => {
  const { response, statements } = await call("POST", "/sale-rates/bulk", {
    body: { updates: [{ product_id: 1, inventory_batch_id: 11, new_selling_rate: 175 }] },
    answer: lotSave(),
  });
  assert.equal(response.body.updated_count, 1);
  const [history] = find(statements, /^INSERT INTO sale_rate_history/);
  assert.deepEqual(history.values.slice(0, 4), [1, 180, 175, OWNER_ID]);
  // A lot needs no log row of its own: the inventory_batches publish trigger (cloud migration 011)
  // publishes it, and a second copy would race it.
  assert.equal(find(statements, /^INSERT INTO sync_change_log/).length, 0);
});

test("POST /sale-rates/bulk: typing the price POS already charges is not a change", async () => {
  const { response, statements } = await call("POST", "/sale-rates/bulk", {
    body: { updates: [{ product_id: 1, inventory_batch_id: 11, new_selling_rate: 180 }] },
    answer: lotSave(),
  });
  assert.equal(response.body.updated_count, 0);
  assert.equal(writes(statements).length, 0);
});

test("POST /sale-rates/bulk: a bad entry refuses the whole save before anything is written", async () => {
  const { response, statements } = await call("POST", "/sale-rates/bulk", {
    body: { updates: [{ product_id: 3, new_selling_rate: 160 }, { product_id: -3, new_selling_rate: 160 }] },
    answer: productSave(),
  });
  assert.equal(response.status, 400);
  assert.equal(find(statements, /^COMMIT$/).length, 0);
  assert.equal(find(statements, /^ROLLBACK$/).length, 1);
});

test("POST /sale-rates/bulk is refused to a role that does not manage rates", async () => {
  const { response, statements } = await call("POST", "/sale-rates/bulk", {
    body: { updates: [{ product_id: 3, new_selling_rate: 160 }] },
    role: "Cashier",
    answer: productSave(),
  });
  assert.equal(response.status, 403);
  assert.equal(writes(statements).length, 0);
});

test("server.js takes the rules from saleRateUpdate.js and keeps no second copy", () => {
  assert.match(SOURCE, /require\("\.\/saleRateUpdate"\)/);
  assert.doesNotMatch(SOURCE, /const applySaleRateRounding\s*=/);
  assert.doesNotMatch(SOURCE, /const resolveDesiredMargin\s*=/);
  const bulk = SOURCE.slice(SOURCE.indexOf('app.post("/sale-rates/bulk"'), SOURCE.indexOf('app.get("/sale-rate-history"'));
  assert.doesNotMatch(bulk, /req\.body\.changed_by/, "identity comes from req.auth only");
});
