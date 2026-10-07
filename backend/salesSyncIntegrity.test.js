"use strict";

/**
 * Sales, sync push, stock-lot ids and sale rates: the fixes of the October 2026 audit.
 *
 * Behavioural where the code can be driven (a scripted client, or a route through
 * `routeAuthCoverage.loadServerApp()`); source-text where only a running Postgres could show it.
 * The savepoint and the retryable refusals are judged by a real Postgres in `saleReturns.test.js`,
 * which already has the rig.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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
const {
  buildSalePayload,
  processSyncOperation,
  resolveServerEntityId,
  ensureProductEntrySchemaOnce,
} = require("./server");

const SOURCE = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const TEST_SIGNING_KEY = "route-auth-coverage-isolated-signing-key-000000";
const normalise = (sql) => String(typeof sql === "object" && sql ? sql.text : sql || "").replace(/\s+/g, " ").trim();
const rows = (list) => ({ rows: list, rowCount: list.length });

/** The text of a top-level `const name = ...` up to the next top-level declaration. */
const bodyOf = (marker) => {
  const start = SOURCE.indexOf(marker);
  assert.ok(start >= 0, `${marker} must exist`);
  const next = SOURCE.slice(start + marker.length).search(/\n(?:const |let |function |app\.)/);
  return SOURCE.slice(start, next < 0 ? undefined : start + marker.length + next);
};

// ---------------------------------------------------------------------------------------------
// A desktop's product or lot id becomes the server's integer id
// ---------------------------------------------------------------------------------------------

const idClient = (globalIds) => {
  const statements = [];
  return {
    statements,
    query: async (sql, values) => {
      statements.push({ sql: normalise(sql), values });
      const match = /^SELECT id FROM (\w+) WHERE global_id = \$1 LIMIT 1$/.exec(normalise(sql));
      if (!match) throw new Error(`unexpected query: ${normalise(sql)}`);
      const id = globalIds[match[1]]?.[values[0]];
      return rows(id ? [{ id }] : []);
    },
  };
};

test("a lot id the desktop holds resolves to the server's id: integer, global id, alias", async () => {
  const client = idClient({ inventory_batches: { "offline-lot-7f3a": 31, "0b6c1e9e-1d2f-4a8e-9f00-3c1b2a4d5e6f": 32 } });
  assert.equal(await resolveServerEntityId(client, "inventory_batches", 42), 42);
  assert.equal(await resolveServerEntityId(client, "inventory_batches", "42"), 42);
  assert.equal(client.statements.length, 0, "an integer needs no lookup");
  assert.equal(await resolveServerEntityId(client, "inventory_batches", "offline-lot-7f3a"), 31);
  assert.equal(await resolveServerEntityId(client, "inventory_batches", "0b6c1e9e-1d2f-4a8e-9f00-3c1b2a4d5e6f"), 32);
  // The snapshot's synthesised form for a lot whose stored global id is a uuid.
  assert.equal(await resolveServerEntityId(client, "inventory_batches", "inventory-lot-16"), 16);
  assert.equal(await resolveServerEntityId(client, "inventory_batches", ""), null);
  assert.equal(await resolveServerEntityId(client, "inventory_batches", null), null);
});

test("a uuid that starts with digits is never read as that number", async () => {
  const client = idClient({ products: {} });
  assert.equal(await resolveServerEntityId(client, "products", "12ab34cd-0000-4000-8000-000000000000"), null);
  assert.equal(await resolveServerEntityId(client, "products", "12.5"), null);
  assert.equal(await resolveServerEntityId(client, "products", "product-12x"), null);
  assert.equal(await resolveServerEntityId(client, "products", "inventory-lot-12"), null, "a lot alias is not a product");
});

test("a stored global id wins over the alias it happens to look like", async () => {
  const client = idClient({ products: { "product-12": 77 } });
  assert.equal(await resolveServerEntityId(client, "products", "product-12"), 77);
  assert.equal(await resolveServerEntityId(client, "products", "product-13"), 13);
});

test("only products and lots can be resolved; the table name is never taken from a caller", async () => {
  await assert.rejects(resolveServerEntityId(idClient({}), "users", "1x"), /unsupported table/);
});

test("an offline bill from a lot the desktop knows by its global id reaches the lot, not a refusal", async () => {
  const statements = [];
  const client = {
    query: async (text, values) => {
      const sql = normalise(text);
      statements.push({ sql, values: values || [] });
      if (/^SELECT id FROM inventory_batches WHERE global_id = \$1/.test(sql)) {
        return rows(values[0] === "offline-lot-7f3a" ? [{ id: 16 }] : []);
      }
      if (/^SELECT id FROM products WHERE global_id = \$1/.test(sql)) return rows(values[0] === "product-apple" ? [{ id: 10 }] : []);
      if (/^SELECT id, product_id, remaining_qty, batch_status FROM inventory_batches/.test(sql)) {
        // Empty: stops the bill at the stock pre-check with a conflict, after the ids resolved.
        return rows([]);
      }
      return rows([]);
    },
  };
  const ack = await processSyncOperation(client, {
    operation_id: "op-offline-lot",
    entity_type: "pos_sale",
    entity_id: "invoice-offline-lot",
    operation_type: "UPSERT",
    payload: {
      invoice_global_id: "invoice-offline-lot",
      offline_invoice_ref: "OFF-1",
      items: [{ product_id: "product-apple", inventory_batch_id: "offline-lot-7f3a", quantity: 1, rate: 100 }],
    },
  }, { companyId: 1, branchId: 1, operationalLocationId: null, deviceId: "dev-1", assignmentGeneration: null, user: { id: 7 } });
  assert.notEqual(ack.message, "POS sale items require product, lot and quantity", "the lot was dropped as unreadable");
  const [lots] = statements.filter(({ sql }) => /^SELECT id, product_id, remaining_qty, batch_status/.test(sql));
  assert.deepEqual(lots.values[0], [16], "the server lot behind the desktop's id was asked for");
  // The conflict row is written after the operation is rolled back, so it survives the rollback.
  const order = statements.map(({ sql }) => sql);
  const rollbackAt = order.indexOf("ROLLBACK TO SAVEPOINT sync_operation");
  const conflictAt = order.findIndex((sql) => /^INSERT INTO sync_conflict_log/.test(sql));
  assert.equal(ack.status, "conflict");
  assert.ok(rollbackAt >= 0 && conflictAt > rollbackAt, "conflict row written after the rollback");
  assert.equal(Object.getOwnPropertySymbols(ack).length, 0, "the deferred write never reaches the ack");
});

test("the v3 lot routes and waste take the desktop's ids, never parseInt", () => {
  for (const marker of [
    "const updateInventoryLotHandler",
    "const addInventoryLotQuantityHandler",
    "const adjustInventoryLotHandler",
    "const deactivateInventoryLotHandler",
    "const reactivateInventoryLotHandler",
  ]) {
    const body = bodyOf(marker);
    assert.match(body, /const lotId = await resolveInventoryLotId\(client, req\.params\.lotId\)/, marker);
    assert.doesNotMatch(body, /parsePositiveInteger\(req\.params\.lotId\)/, marker);
  }
  assert.match(bodyOf("const createWasteEntryHandler"), /const productId = await resolveProductId\(client, req\.body\.product_id\)/);
  assert.match(bodyOf("const normalizeSyncSaleItems"), /await resolveInventoryLotId\(client, item\.inventory_batch_id \|\| item\.lot_id\)/);
});

test("GET /inventory returns each lot's global id, so the desktop files it under one id", () => {
  assert.match(bodyOf("const stockInventorySelectSql"), /\n\s*ib\.global_id,/);
});

// ---------------------------------------------------------------------------------------------
// Rates on a recorded bill: 0 is a rate, and a kept rate is not an override
// ---------------------------------------------------------------------------------------------

const rateClient = ({ productRate = "100.00" } = {}) => ({
  query: async (text, values) => {
    const sql = normalise(text);
    if (/FROM customers WHERE id = \$1/.test(sql)) return rows([{ id: 5, customer_name: "Walk-in", active: true }]);
    if (/FROM products WHERE id = ANY/.test(sql)) {
      return rows(values[0].map((id) => ({ id, product_name: `P${id}`, selling_rate: productRate, unit: "KG" })));
    }
    if (/^SELECT id, remaining_qty, COALESCE\(effective_cost_per_unit/.test(sql) || /FROM inventory_batches WHERE product_id = \$1/.test(sql)) {
      return rows([{ id: values[2] || 16, remaining_qty: "50", purchase_rate: "60", purchase_bill_status: "BILL_COMPLETED", temporary_sale_rate: "0", lot_name: "L", lot_size: null }]);
    }
    return rows([]);
  },
});

const recordedBill = (items, extra = {}) => buildSalePayload(rateClient(extra.client), {
  items,
  branchId: 1,
  createdBy: 7,
  customer: { account_id: 5 },
  invoiceDiscount: 0,
  payments: extra.payments,
  allowRateOverride: false,
  invoiceDiscountMode: "AS_BILLED",
  billDate: "2026-10-01",
  companyId: 1,
  ...extra.options,
});

const freeLine = { product_id: 10, inventory_batch_id: 16, quantity: 1, discount_amount: 0, selling_rate: 0 };
const paidLine = { product_id: 11, inventory_batch_id: 17, quantity: 1, discount_amount: 0, selling_rate: 100 };

test("a line billed at 0 stays 0 where the POS allowed it, and is not re-priced at the default rate", async () => {
  const result = await recordedBill([freeLine, paidLine], {
    payments: [{ mode: "CASH", amount: 100 }],
    options: { allowRateOverride: true, allowZeroRate: true },
  });
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.equal(result.invoiceItems[0].sellingRate, 0);
  assert.equal(result.invoiceItems[0].grossAmount, 0);
  assert.equal(result.totalAmount, 100);
});

test("a 0 the caller did not allow is refused by name, never silently billed at the default rate", async () => {
  const result = await recordedBill([freeLine, paidLine], {
    payments: [{ mode: "CASH", amount: 200 }],
    options: { allowRateOverride: true },
  });
  assert.equal(result.error?.status, 400);
  assert.match(result.error.message, /zero sale rate/i);
});

test("an edited line already billed at 0 may stay 0 for any editor", async () => {
  const result = await recordedBill([freeLine, paidLine], {
    payments: [{ mode: "CASH", amount: 100 }],
    options: { priorSaleItems: [{ id: 1, product_id: 10, selling_rate: "0.00", manual_rate_override: true }] },
  });
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.equal(result.invoiceItems[0].sellingRate, 0);
});

test("a blank rate is not a rate: the default applies, as before", async () => {
  const result = await recordedBill([{ ...paidLine, selling_rate: "" }], { payments: [{ mode: "CASH", amount: 100 }] });
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.equal(result.invoiceItems[0].sellingRate, 100);
  assert.equal(result.invoiceItems[0].manualRateOverride, false);
});

test("a Cashier's edit that keeps the billed rate is not refused because today's rate moved", async () => {
  // Billed at 90 yesterday; the product is 100 today. The Cashier only fixes the customer.
  const line = { ...paidLine, selling_rate: 90 };
  const prior = [{ id: 1, product_id: 11, selling_rate: "90.00", manual_rate_override: false }];
  const kept = await recordedBill([line], { payments: [{ mode: "CASH", amount: 90 }], options: { priorSaleItems: prior } });
  assert.equal(kept.error, undefined, JSON.stringify(kept.error));
  assert.equal(kept.invoiceItems[0].keptBilledRate, true);
  assert.equal(kept.invoiceItems[0].manualRateOverride, false, "the line's stored override flag is kept, not re-derived");

  // A rate the bill never carried is still an override, and still needs the permission.
  const changed = await recordedBill([{ ...paidLine, selling_rate: 85 }], { payments: [{ mode: "CASH", amount: 85 }], options: { priorSaleItems: prior } });
  assert.equal(changed.error?.status, 403);
});

test("both edit paths pass the stored lines, honour manual_pos_rate_override, and gate 0 on Owner/Admin", () => {
  for (const marker of ["const updateSaleHandler", "const processPosSaleEditOperation"]) {
    const body = bodyOf(marker);
    assert.match(body, /priorSaleItems: oldSnapshot\.items/, marker);
    assert.match(body, /allowRateOverride: \["Owner", "Admin"\]\.includes\(editor\.role_name\)\s*\|\| Boolean\(await getPermissionUser\(editor\.id, "manual_pos_rate_override"/, marker);
    assert.match(body, /allowZeroRate: \["Owner", "Admin"\]\.includes\(editor\.role_name\)/, marker);
  }
  assert.match(bodyOf("const processPosSaleFoundationOperation"), /allowZeroRate: true/);
  assert.match(bodyOf("const updateSaleHandler"), /if \(item\.manualRateOverride && !item\.keptBilledRate\)/);
});

// ---------------------------------------------------------------------------------------------
// Edits never record CREDIT as money received
// ---------------------------------------------------------------------------------------------

test("both edit paths leave CREDIT out of the payment rows, as a new bill does", () => {
  for (const marker of ["const updateSaleHandler", "const processPosSaleEditOperation"]) {
    const body = bodyOf(marker);
    assert.match(body, /for \(const payment of salePayload\.payments\.filter\(\(entry\) => entry\.mode !== "CREDIT"\)\)/, marker);
    assert.doesNotMatch(body, /for \(const payment of salePayload\.payments\) \{/, marker);
  }
});

// ---------------------------------------------------------------------------------------------
// Which bills a caller may see, edit or cancel
// ---------------------------------------------------------------------------------------------

test("edit and cancel find a bill by company and branch, not by this counter", () => {
  for (const marker of ["const updateSaleHandler", "const cancelSaleHandler"]) {
    const lock = /const saleLockResult = await client\.query\(\s*`([\s\S]*?)`/.exec(bodyOf(marker))?.[1] || "";
    assert.match(lock, /AND branch_id = \$2/, marker);
    assert.match(lock, /company_id IS NULL OR company_id = \$3/, marker);
    assert.doesNotMatch(lock, /operational_location_id/, `${marker}: another counter's bill is this shop's bill`);
  }
});

const tokenFor = () => issueDeviceSession({ userId: 7, deviceId: "FZDEV-SALES-SCOPE", companyId: 1, branchId: 3, role: "Owner", secret: TEST_SIGNING_KEY });

const call = async (method, url, answer = () => undefined) => {
  const statements = [];
  const respond = (sql, values) => {
    const text = normalise(sql);
    statements.push({ sql: text, values: values || [] });
    const scripted = answer(text, values || []);
    return scripted === undefined ? rows([]) : scripted;
  };
  setQueryResponder(respond);
  setConnectionResponder(() => ({ query: async (sql, values) => respond(sql, values), release: () => {} }));
  try {
    const response = await probe(app, method, url, { authorization: `Bearer ${tokenFor()}`, "content-type": "application/json" });
    return { response, statements };
  } finally {
    clearQueryResponder();
    clearConnectionResponder();
  }
};

test("GET /sales/:id finds a bill only in the caller's branch", async () => {
  const { response, statements } = await call("GET", "/sales/55");
  assert.equal(response.status, 404);
  const [sale] = statements.filter(({ sql }) => /FROM sales s LEFT JOIN branches b/.test(sql));
  assert.match(sale.sql, /WHERE s\.id = \$1 AND s\.branch_id = \$2/);
  assert.deepEqual(sale.values, [55, 3]);
  assert.equal(statements.filter(({ sql }) => /FROM sale_items si/.test(sql)).length, 0, "no lines read for a bill not found");
});

test("GET /sales/:id/audit reads only a bill of the caller's branch", async () => {
  const { response, statements } = await call("GET", "/sales/55/audit");
  assert.equal(response.status, 200);
  const [audit] = statements.filter(({ sql }) => /FROM sale_audit_trail sat/.test(sql));
  assert.match(audit.sql, /JOIN sales s ON s\.id = sat\.sale_id/);
  assert.match(audit.sql, /AND s\.branch_id = \$2/);
  assert.deepEqual(audit.values, [55, 3]);
});

// ---------------------------------------------------------------------------------------------
// Master data reaches every branch; product-schema DDL runs once
// ---------------------------------------------------------------------------------------------

test("Product Master and category changes are logged to every branch, anchored on the caller's", () => {
  const masterChanges = [...SOURCE.matchAll(/await (logSyncChange|logMasterDataSyncChange)\(client, \{\s*branchId: ([^\n]*)\n\s*entityType: (sellingRateChanged \? )?"(product|product_category|sale_rate)"/g)];
  const perBranchOnly = masterChanges.filter((match) => match[1] === "logSyncChange");
  assert.equal(perBranchOnly.length, 0, `master data logged to one branch only: ${perBranchOnly.map((m) => m[0].split("\n")[1]).join("; ")}`);
  for (const match of masterChanges.filter((m) => m[1] === "logMasterDataSyncChange")) {
    assert.doesNotMatch(match[2], /parsePositiveInteger\(branch_id\)|^1,/, "the anchor is never a branch the request names");
  }
  const helper = bodyOf("const logMasterDataSyncChange");
  assert.match(helper, /WHERE company_id = \(SELECT company_id FROM branches WHERE id = \$1\)/);
  assert.match(helper, /active IS DISTINCT FROM FALSE/);
});

test("product-schema DDL runs once per process for request paths; concurrent callers share it; a failure retries", async () => {
  let ddlRuns = 0;
  let fail = true;
  setQueryResponder((sql) => {
    if (/CREATE TABLE IF NOT EXISTS product_categories/.test(normalise(sql))) {
      ddlRuns += 1;
      if (fail) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
    }
    return rows([]);
  });
  try {
    await assert.rejects(ensureProductEntrySchemaOnce(), /deadlock/);
    fail = false;
    await Promise.all([ensureProductEntrySchemaOnce(), ensureProductEntrySchemaOnce()]);
    await ensureProductEntrySchemaOnce();
    assert.equal(ddlRuns, 2, "one failed run, then exactly one shared successful run");
  } finally {
    clearQueryResponder();
  }
  for (const marker of ['app.get("/products"', "const listProductCategoriesHandler"]) {
    const start = SOURCE.indexOf(marker);
    assert.match(SOURCE.slice(start, start + 200), /await ensureProductEntrySchemaOnce\(\)/, marker);
  }
  assert.equal((SOURCE.match(/await ensureProductEntrySchema\(/g) || []).length, 1, "only startup runs the DDL directly");
});

// ---------------------------------------------------------------------------------------------
// An edit keeps the bill in its own branch; a purchase's new rate reaches every branch
// ---------------------------------------------------------------------------------------------

test("both edit paths take the bill's branch from the locked row, never from the request", () => {
  for (const marker of ["const updateSaleHandler", "const processPosSaleEditOperation"]) {
    const body = bodyOf(marker);
    const build = /await buildSalePayload\(client, \{([\s\S]*?)\n\s*\}\);/.exec(body)?.[1] || "";
    assert.match(build, /\n\s*branchId: currentSale\.branch_id,/, marker);
    assert.doesNotMatch(body.replace(/\/\/[^\n]*/g, ""), /req\.body\.branch_id|invoice\.branch_id/, `${marker} reads a branch the caller wrote`);
  }
});

test("a purchase's temporary product rate is logged to every active branch of the company", () => {
  const body = bodyOf("const createPurchaseBillHandler");
  const rateChange = /await (logSyncChange|logMasterDataSyncChange)\(client, \{\s*branchId: ([^\n]*)\n\s*entityType: "sale_rate"/.exec(body);
  assert.ok(rateChange, "the purchase path publishes the product rate");
  assert.equal(rateChange[1], "logMasterDataSyncChange");
  assert.match(rateChange[2], /^context\?\.branch_id \|\| req\.auth\.branchId/, "anchored on the caller's branch first");
  const leftovers = [...SOURCE.matchAll(/await logSyncChange\(client, \{\s*branchId: [^\n]*\n\s*entityType: (sellingRateChanged \? )?"(product|product_category|sale_rate)"/g)];
  assert.deepEqual(leftovers.map((match) => match[0]), [], "no master-data change is logged to one branch only");
});
