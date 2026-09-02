"use strict";

/**
 * Other charges on a bill -- crate charge, labour charge, delivery charge, and whatever the shop
 * invents next -- on the PostgreSQL side.
 *
 * The pricing rules are settled and pinned in `frontend/src/local/otherCharges.js` and its own
 * suite. This file exists because the server cannot import that module (it is ESM, in the frontend
 * tree) and because the server has two obligations the frontend does not:
 *
 *   1. **Recompute.** The client sends which charge, how much of it and how big it is. It does not
 *      send the price. A price accepted from the client is a discount granted by the client, and
 *      the client is a machine on a shop counter.
 *   2. **Never move the tax.** Charges are added after Mandi Tax and are absent from
 *      `taxable_amount`. Routing them through the taxable amount would raise the shop's tax on
 *      money it never collected tax on -- on every bill carrying a delivery, forever.
 *
 * The rule this file mostly exists to defend is the same one the frontend suite defends: **a
 * measurement past the last slab has no price, and must say so.** With slabs at 10 km and 15 km, a
 * 40 km delivery is not a 150-rupee delivery. Charging the top slab loses money on exactly the
 * trips that cost most, silently, on every bill. So the refusal is tested from three directions:
 * the rate resolver, the whole-request resolver, and a real `POST /sales` driven through the app.
 *
 * ## Why the sale tests drive the app
 *
 * "`taxable_amount` is unchanged by charges" is a claim about a number written to a row. A
 * source-text assertion would pass on a build where the charge total was folded into the taxable
 * amount two hundred lines further down. So the sale tests send a real signed session at
 * `POST /sales` through the harness in `routeAuthCoverage.js` and read the values the handler binds
 * into `INSERT INTO sales`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  loadServerApp,
  probe,
  setConnectionResponder,
  clearConnectionResponder,
  setQueryResponder,
  clearQueryResponder,
} = require("./routeAuthCoverage");
const { issueDeviceSession } = require("./deviceSession");

const app = loadServerApp();
const {
  CHARGE_REFUSALS,
  normaliseChargeSlabs,
  resolveChargeRateFromType,
  resolveSaleCharges,
} = require("./server");

const SOURCE = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

/** Must match the throwaway key `routeAuthCoverage` pins into the environment before loading. */
const TEST_SIGNING_KEY = "route-auth-coverage-isolated-signing-key-000000";

const COMPANY_ID = 1;
const BRANCH_ID = 1;

// The maintainer's own examples. Delivery: 10 km costs 100, 15 km costs 150. Crate: a 10 kg crate
// costs 40, a 20 kg crate costs 50. Labour is flat.
const CRATE_ID = 1;
const LABOUR_ID = 2;
const DELIVERY_ID = 3;

const chargeTypeRow = (overrides = {}) => ({
  id: CRATE_ID,
  charge_name: "Crate charge",
  charge_code: "CRATE",
  basis: "SLAB",
  measure_unit: "kg",
  flat_rate: null,
  active: true,
  ...overrides,
});

const SLAB_ROWS = [
  { charge_type_id: CRATE_ID, upto_value: "10.000", rate: "40.00", active: true },
  { charge_type_id: CRATE_ID, upto_value: "20.000", rate: "50.00", active: true },
  { charge_type_id: DELIVERY_ID, upto_value: "15.000", rate: "150.00", active: true },
  { charge_type_id: DELIVERY_ID, upto_value: "10.000", rate: "100.00", active: true },
];

const CHARGE_TYPE_ROWS = [
  chargeTypeRow(),
  chargeTypeRow({ id: LABOUR_ID, charge_name: "Labour charge", charge_code: "LABOUR", basis: "FLAT", measure_unit: null, flat_rate: "30.00" }),
  chargeTypeRow({ id: DELIVERY_ID, charge_name: "Delivery charge", charge_code: "DELIVERY", measure_unit: "km" }),
];

/** A client that answers only the two charge lookups, and records what it was asked. */
const chargeClient = ({ types = CHARGE_TYPE_ROWS, slabs = SLAB_ROWS } = {}) => ({
  statements: [],
  query: async function (text, values) {
    const sql = String(text).replace(/\s+/g, " ").trim();
    this.statements.push({ sql, values: values || [] });
    if (/FROM charge_types/i.test(sql)) {
      const ids = (values?.[0] || []).map(Number);
      return { rows: types.filter((row) => ids.includes(Number(row.id))) };
    }
    if (/FROM charge_rate_slabs/i.test(sql)) {
      const ids = (values?.[0] || []).map(Number);
      return { rows: slabs.filter((row) => ids.includes(Number(row.charge_type_id))) };
    }
    throw new Error(`unexpected statement: ${sql}`);
  },
});

// -------------------------------------------------------------------------------------------
// The rate, at one measurement
// -------------------------------------------------------------------------------------------

const DELIVERY_TYPE = {
  charge_name: "Delivery charge",
  basis: "SLAB",
  measure_unit: "km",
  slabs: [{ upto_value: 15, rate: 150 }, { upto_value: 10, rate: 100 }],
};

test("a slab rounds up, and a measurement landing on a slab uses that slab", () => {
  // The maintainer's ruling in his own numbers: 12 km is past what 100 was meant to cover. The
  // second half is the off-by-one in the other direction -- `<` instead of `<=` would charge 150
  // for a 10 km delivery and nobody would notice until a customer argued about it.
  assert.equal(resolveChargeRateFromType(DELIVERY_TYPE, 12).rate, 150);
  assert.equal(resolveChargeRateFromType(DELIVERY_TYPE, 10).rate, 100);
  assert.equal(resolveChargeRateFromType(DELIVERY_TYPE, 2).rate, 100, "below the smallest slab is priced at the smallest slab");
});

test("a measurement past the last slab is refused by name, never priced at the top slab", () => {
  // The headline case, and the reason this feature has a test file at all.
  const resolved = resolveChargeRateFromType(DELIVERY_TYPE, 40);
  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, CHARGE_REFUSALS.ABOVE_TOP_SLAB);
  assert.equal(resolved.rate, undefined, "it must not hand back a rate at all");
  assert.match(resolved.message, /15/, "the message says how far the rates go");
  assert.match(resolved.message, /40/, "and what was asked for");
  assert.match(resolved.message, /km/, "in the shop's own unit");
});

test("a rate of zero is a rate, and is not mistaken for a missing one", () => {
  // `||` would swallow a free delivery inside 5 km, which is a real thing a shop sets up.
  const free = resolveChargeRateFromType({ charge_name: "Labour", basis: "FLAT", flat_rate: 0 });
  assert.equal(free.ok, true);
  assert.equal(free.rate, 0);
  const freeSlab = resolveChargeRateFromType(
    { ...DELIVERY_TYPE, slabs: [{ upto_value: 5, rate: 0 }, { upto_value: 15, rate: 150 }] },
    3,
  );
  assert.equal(freeSlab.ok, true);
  assert.equal(freeSlab.rate, 0);
});

test("a flat charge with no rate, and a slab charge with no slabs, each say so", () => {
  assert.equal(resolveChargeRateFromType({ charge_name: "Labour", basis: "FLAT" }).code, CHARGE_REFUSALS.NO_RATE);
  assert.equal(resolveChargeRateFromType({ ...DELIVERY_TYPE, slabs: [] }, 12).code, CHARGE_REFUSALS.NO_SLABS);
  assert.equal(resolveChargeRateFromType(DELIVERY_TYPE, null).code, CHARGE_REFUSALS.MEASUREMENT_REQUIRED);
});

test("slabs are ordered smallest first however the database returned them", () => {
  // DELIVERY_TYPE deliberately lists 15 before 10. "The first slab that covers this" only works on
  // a sorted list, and a settings screen hands back whatever order it felt like.
  assert.deepEqual(normaliseChargeSlabs(DELIVERY_TYPE.slabs).map((slab) => slab.upto), [10, 15]);
  // A slab with no usable threshold or rate is dropped rather than sorted into nowhere.
  const cleaned = normaliseChargeSlabs([
    { upto_value: 10, rate: 40 },
    { upto_value: null, rate: 60 },
    { upto_value: 20, rate: null },
    { upto_value: -5, rate: 10 },
    { upto_value: 20, rate: 50, active: false },
    { upto_value: 30, rate: 70 },
  ]);
  assert.deepEqual(cleaned.map((slab) => slab.upto), [10, 30]);
});

// -------------------------------------------------------------------------------------------
// The whole request, priced against the stored charge types
// -------------------------------------------------------------------------------------------

test("no charges costs no database round trip", async () => {
  // Every existing sale test drives a scripted client that has never heard of a charge table. An
  // unconditional lookup here would break all of them, and would put two queries on every bill the
  // shop has ever written for a feature it is not using.
  const client = chargeClient();
  const resolved = await resolveSaleCharges(client, { requests: [], companyId: COMPANY_ID });
  assert.deepEqual(resolved.lines, []);
  assert.equal(resolved.otherChargesAmount, 0);
  assert.equal(client.statements.length, 0);
});

test("quantity and measurement are different numbers", async () => {
  // Four 10 kg crates is 4 x 40, not one 4 kg crate. Conflating them is the arithmetic mistake this
  // shape invites, and it under-charges by exactly the amount that matters.
  const resolved = await resolveSaleCharges(chargeClient(), {
    requests: [{ charge_type_id: CRATE_ID, measurement: 10, quantity: 4 }],
    companyId: COMPANY_ID,
  });
  assert.equal(resolved.lines.length, 1);
  assert.equal(resolved.lines[0].rate, 40, "the rate comes from the crate size");
  assert.equal(resolved.lines[0].quantity, 4, "the count is how many crates");
  assert.equal(resolved.lines[0].amount, 160);
  assert.equal(resolved.lines[0].slab_upto, 10);
  assert.equal(resolved.lines[0].manual, false);
});

test("the price comes from the stored charge type, not from the amount the client sent", async () => {
  // Rule 1 of the server's two obligations. A POS that can name its own price can hand out any
  // discount it likes, to anyone standing at the counter, with nothing in the bill saying so.
  const resolved = await resolveSaleCharges(chargeClient(), {
    requests: [{
      charge_type_id: CRATE_ID,
      measurement: 10,
      quantity: 2,
      // Everything a hostile or simply stale client might send to name its own number.
      rate: 1,
      amount: 2,
      charge_name: "Crate charge (free)",
      measure_unit: "sacks",
      slab_upto: 999,
    }],
    companyId: COMPANY_ID,
  });
  assert.equal(resolved.lines[0].rate, 40, "the stored slab rate, not the 1 the client asked for");
  assert.equal(resolved.lines[0].amount, 80, "and the amount is derived from it, not copied");
  assert.equal(resolved.lines[0].charge_name, "Crate charge", "the name is the stored one too");
  assert.equal(resolved.lines[0].measure_unit, "kg");
  assert.equal(resolved.lines[0].slab_upto, 10);
  assert.equal(resolved.otherChargesAmount, 80);
});

test("a line past the top slab refuses the whole request rather than being dropped", async () => {
  // The server has no screen on which to show a refusal beside three good lines: it either writes
  // the bill or it does not. Pricing the good lines and dropping the bad one would save a bill
  // quietly short by the delivery, which is the failure this feature exists to prevent.
  const resolved = await resolveSaleCharges(chargeClient(), {
    requests: [
      { charge_type_id: CRATE_ID, measurement: 10, quantity: 3 },
      { charge_type_id: DELIVERY_ID, measurement: 40 },
    ],
    companyId: COMPANY_ID,
  });
  assert.equal(resolved.lines, undefined, "no lines are returned at all");
  assert.equal(resolved.error.code, CHARGE_REFUSALS.ABOVE_TOP_SLAB);
  assert.equal(resolved.error.status, 400);
  assert.equal(resolved.error.charge_type_id, DELIVERY_ID);
  assert.match(resolved.error.message, /15/);
  assert.match(resolved.error.message, /40/);
});

test("a charge that has been turned off or removed is refused, not silently skipped", async () => {
  // Silently dropping it reduces the bill, which looks to everyone like the price simply changed.
  const turnedOff = await resolveSaleCharges(
    chargeClient({ types: [chargeTypeRow({ active: false })] }),
    { requests: [{ charge_type_id: CRATE_ID, measurement: 10 }], companyId: COMPANY_ID },
  );
  assert.equal(turnedOff.error.code, CHARGE_REFUSALS.CHARGE_INACTIVE);
  assert.match(turnedOff.error.message, /Crate charge/);

  const gone = await resolveSaleCharges(chargeClient(), {
    requests: [{ charge_type_id: 999 }],
    companyId: COMPANY_ID,
  });
  assert.equal(gone.error.code, CHARGE_REFUSALS.UNKNOWN_CHARGE);
});

test("charge types are looked up inside the caller's own company", async () => {
  // Without the predicate a counter could price its bill from another shop's charge table, which is
  // the same cross-tenant read A-7 spent a stage closing on the money routes.
  const client = chargeClient();
  await resolveSaleCharges(client, {
    requests: [{ charge_type_id: CRATE_ID, measurement: 10 }],
    companyId: 7,
  });
  const lookup = client.statements.find((entry) => /FROM charge_types/i.test(entry.sql));
  assert.match(lookup.sql, /company_id = \$2/);
  assert.deepEqual(lookup.values[1], 7);
});

test("a hand-entered amount needs the permission, and is stamped as manual", async () => {
  // This is how the shop prices the 40 km trip today rather than after a settings change -- and it
  // is the one place a number the client typed becomes the price, so it is gated on the same
  // permission as typing a sale rate the price list did not produce, and recorded so a bill can say
  // where its number came from.
  const refused = await resolveSaleCharges(chargeClient(), {
    requests: [{ charge_type_id: DELIVERY_ID, measurement: 40, manual_amount: 400 }],
    companyId: COMPANY_ID,
    allowManualAmount: false,
  });
  assert.equal(refused.error.status, 403);
  assert.equal(refused.error.code, CHARGE_REFUSALS.MANUAL_NOT_PERMITTED);

  const allowed = await resolveSaleCharges(chargeClient(), {
    requests: [{ charge_type_id: DELIVERY_ID, measurement: 40, manual_amount: 400 }],
    companyId: COMPANY_ID,
    allowManualAmount: true,
  });
  assert.equal(allowed.lines[0].amount, 400);
  assert.equal(allowed.lines[0].manual, true);
  assert.equal(allowed.lines[0].slab_upto, null, "a typed number came from no slab");
});

test("a hand-entered amount that cannot be read is refused, never fallen back from", async () => {
  // Falling through to the slabs would price the bill at a number the operator neither asked for
  // nor saw -- and for a 40 km trip there is no slab to fall back to anyway.
  const resolved = await resolveSaleCharges(chargeClient(), {
    requests: [{ charge_type_id: LABOUR_ID, manual_amount: "twenty" }],
    companyId: COMPANY_ID,
    allowManualAmount: true,
  });
  assert.equal(resolved.error.code, CHARGE_REFUSALS.NO_RATE);
});

test("any charge the shop invents works the same way, with its own unit", async () => {
  // Nothing in the server knows what a crate or a kilometre is. The maintainer adds charges
  // himself, names them and names the unit, so a hardcoded list of three would be exactly wrong.
  const cold = chargeTypeRow({ id: 77, charge_name: "Cold storage", measure_unit: "days" });
  const coldSlabs = [
    { charge_type_id: 77, upto_value: "3.000", rate: "25.00", active: true },
    { charge_type_id: 77, upto_value: "7.000", rate: "50.00", active: true },
  ];
  const resolved = await resolveSaleCharges(chargeClient({ types: [cold], slabs: coldSlabs }), {
    requests: [{ charge_type_id: 77, measurement: 5, quantity: 2 }],
    companyId: COMPANY_ID,
  });
  assert.equal(resolved.lines[0].rate, 50);
  assert.equal(resolved.lines[0].amount, 100);
  assert.equal(resolved.lines[0].measure_unit, "days");

  const past = await resolveSaleCharges(chargeClient({ types: [cold], slabs: coldSlabs }), {
    requests: [{ charge_type_id: 77, measurement: 30 }],
    companyId: COMPANY_ID,
  });
  assert.match(past.error.message, /days/, "the refusal speaks the shop's own unit back to it");
});

// -------------------------------------------------------------------------------------------
// A real bill
// -------------------------------------------------------------------------------------------

const PRODUCT_ID = 11;
const LOT_ID = 900;
const SALE_ID = 4242;

const token = () => issueDeviceSession({
  userId: 7,
  deviceId: "FZDEV-OTHER-CHARGES",
  companyId: COMPANY_ID,
  branchId: BRANCH_ID,
  role: "Owner",
  secret: TEST_SIGNING_KEY,
});

/**
 * A transaction client with just enough of a shop behind it to write one bill.
 *
 * Mandi Tax is switched on at 2% against a registered customer on purpose: with tax at zero the
 * central claim of this section -- that charges never move the taxable amount -- would be true by
 * accident and would stay true if charges were folded straight into it.
 */
const billingClient = ({ types = CHARGE_TYPE_ROWS, slabs = SLAB_ROWS } = {}) => {
  const inserts = [];
  const statements = [];
  return {
    inserts,
    statements,
    release: () => {},
    query: async (text, values) => {
      const sql = String(typeof text === "object" && text ? text.text : text || "")
        .replace(/\s+/g, " ")
        .trim();
      statements.push({ sql, values: values || [] });
      if (/^INSERT INTO/i.test(sql)) inserts.push({ sql, values: values || [] });

      if (/FROM customers WHERE id = \$1/i.test(sql)) {
        return { rows: [{ id: 5, customer_name: "Ravi Traders", mobile_number: "9000000000", system_account: false, active: true }] };
      }
      if (/FROM products WHERE id = ANY/i.test(sql)) {
        return { rows: [{ id: PRODUCT_ID, product_name: "Alphonso", selling_rate: "100.00", unit: "KG" }] };
      }
      if (/FROM inventory_batches/i.test(sql)) {
        return {
          rows: [{
            id: LOT_ID,
            remaining_qty: "50.000",
            purchase_rate: "60.00",
            purchase_bill_status: "BILL_COMPLETED",
            temporary_sale_rate: "0",
            lot_name: "LOT-1",
            lot_size: "10.000",
          }],
        };
      }
      if (/FROM sale_rate_settings/i.test(sql)) {
        // Bill-level slab discounts off, so no discount rule interferes with the arithmetic.
        return { rows: [{ bill_level_slab_discount_enabled: false }] };
      }
      if (/FROM payment_settings/i.test(sql)) {
        return {
          rows: [{
            enable_sales_mandi_tax: true,
            sales_mandi_tax_percent: "2",
            sales_mandi_tax_basis: "NET_AFTER_ALL_DISCOUNTS",
            sales_mandi_tax_customer_scope: "REGISTERED_CUSTOMERS",
            sales_mandi_tax_product_scope: "ALL_PRODUCTS",
          }],
        };
      }
      if (/FROM charge_types/i.test(sql)) {
        const ids = (values?.[0] || []).map(Number);
        return { rows: types.filter((row) => ids.includes(Number(row.id))) };
      }
      if (/FROM charge_rate_slabs/i.test(sql)) {
        const ids = (values?.[0] || []).map(Number);
        return { rows: slabs.filter((row) => ids.includes(Number(row.charge_type_id))) };
      }
      if (/^INSERT INTO sales/i.test(sql)) {
        return { rows: [{ id: SALE_ID, sale_date: new Date(), global_id: "sale-test", entity_version: 1 }] };
      }
      if (/^INSERT INTO sale_items/i.test(sql)) {
        return { rows: [{ id: 77 }] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
};

const LOCATION_ID = 10;

/**
 * The device assignment and the session-freshness row `v3WriteAdapter` needs before the handler
 * runs. Answered from the pool stub, which is where the scope service and the staleness check read.
 */
const scopeResponder = (sql) => {
  if (/FROM authorized_devices d/i.test(sql)) {
    return {
      rows: [{
        device_id: "FZDEV-OTHER-CHARGES",
        device_status: "APPROVED",
        company_id: COMPANY_ID,
        branch_id: BRANCH_ID,
        operational_location_id: LOCATION_ID,
        assignment_generation: 1,
        fixed_operational: true,
        intended_usage: "POS",
        device_permissions: {},
        device_assignment_active: true,
        location_active: true,
        branch_active: true,
        role_id: 1,
        is_default: true,
        staff_permissions: {},
        staff_assignment_active: true,
        role_name: "Owner",
      }],
      rowCount: 1,
    };
  }
  if (/SELECT session_revocation_version FROM users WHERE id = \$1 AND active IS DISTINCT FROM FALSE/i.test(sql)) {
    return { rows: [{ session_revocation_version: 0 }], rowCount: 1 };
  }
  return undefined;
};

let billNumber = 0;

/**
 * One 4 kg sale of a 100-rupee product, plus whatever charges the test names.
 *
 * Sent at `/api/v3/sales` and not `/sales`: the bare path is a retired legacy write that answers
 * 426 before any handler runs, so a test aimed at it would prove nothing about billing. This is the
 * route the shipped client actually posts to.
 */
const bill = async (charges, options = {}) => {
  const client = billingClient(options);
  billNumber += 1;
  setConnectionResponder(() => client);
  setQueryResponder(scopeResponder);
  try {
    const response = await probe(app, "POST", "/api/v3/sales", {
      authorization: `Bearer ${token()}`,
      "content-type": "application/json",
    }, {
      customer: { account_id: 5 },
      invoice_discount: 0,
      idempotency_key: `charge-test-${billNumber}`,
      items: [{ product_id: PRODUCT_ID, inventory_batch_id: LOT_ID, quantity: 4, discount_amount: 0 }],
      payments: [{ mode: "CASH", amount: options.paid }],
      other_charges: charges,
    });
    return { response, client };
  } finally {
    clearConnectionResponder();
    clearQueryResponder();
  }
};

/** The values bound into `INSERT INTO sales`, by the column names the statement lists. */
const insertedSale = (client) => {
  const insert = client.inserts.find((entry) => /^INSERT INTO sales/i.test(entry.sql));
  assert.ok(insert, "the bill was never written");
  const columns = insert.sql
    .slice(insert.sql.indexOf("(") + 1, insert.sql.indexOf(") VALUES"))
    .split(",")
    .map((name) => name.trim());
  assert.equal(columns.length, insert.values.length, "column list and value list must be the same length");
  return Object.fromEntries(columns.map((name, index) => [name, insert.values[index]]));
};

test("charges are added after tax and never touch the taxable amount", async () => {
  // Rule 2, on a real bill. 4 kg at 100 is 400 taxable, 2% is 8, so the fruit half is 408. Three
  // 10 kg crates at 40 is 120. If charges ever reached the taxable amount, the shop would owe mandi
  // tax on 520 -- money it never collected tax on -- on every bill carrying a crate.
  const { response, client } = await bill(
    [{ charge_type_id: CRATE_ID, measurement: 10, quantity: 3 }],
    { paid: 528 },
  );
  assert.equal(response.status, 201, `bill refused: ${response.text}`);
  const sale = insertedSale(client);
  assert.equal(Number(sale.taxable_amount), 400, "unchanged by charges");
  assert.equal(Number(sale.tax_amount), 8, "unchanged by charges");
  assert.equal(Number(sale.other_charges_amount), 120);
  assert.equal(Number(sale.total_amount), 528, "the charge lands after the tax, not inside it");
  // The cost of the fruit is 4 x 60. Profit stays a fact about the fruit: a crate charge is money
  // kept, but it is not margin on the sale, and folding it in would move the figure on every bill
  // that carries one -- silently, and in the flattering direction.
  assert.equal(Number(sale.profit), 168);
});

test("a bill with no charges is byte-for-byte the bill it was before", async () => {
  // The back-compatibility guarantee. Every bill the shop has ever written has no charges, and
  // must keep the totals it had -- including `other_charges_amount` reading 0 rather than null.
  const { response, client } = await bill(undefined, { paid: 408 });
  assert.equal(response.status, 201, `bill refused: ${response.text}`);
  const sale = insertedSale(client);
  assert.equal(Number(sale.taxable_amount), 400);
  assert.equal(Number(sale.tax_amount), 8);
  assert.equal(Number(sale.other_charges_amount), 0);
  assert.equal(Number(sale.total_amount), 408);
  assert.equal(
    client.statements.filter((entry) => /charge_types|charge_rate_slabs/i.test(entry.sql)).length,
    0,
    "a bill with no charges must not go looking for any",
  );
});

test("the amount a client sends for a charge is ignored, and the bill is priced from the slabs", async () => {
  // The whole point of recomputing. A POS sending `amount: 1` for three crates is either stale or
  // hostile; either way the customer pays 120 and the till agrees with the bill.
  const { response, client } = await bill(
    [{ charge_type_id: CRATE_ID, measurement: 10, quantity: 3, rate: 1, amount: 3 }],
    { paid: 528 },
  );
  assert.equal(response.status, 201, `bill refused: ${response.text}`);
  assert.equal(Number(insertedSale(client).other_charges_amount), 120);

  // Paying the price the client named is refused for exactly the same reason: the payment has to
  // match what the server priced, not what the client wished.
  const short = await bill(
    [{ charge_type_id: CRATE_ID, measurement: 10, quantity: 3, amount: 3 }],
    { paid: 411 },
  );
  assert.equal(short.response.status, 400);
  assert.match(short.response.body.message, /Payment amounts must match/);
});

test("a bill carrying a measurement past the top slab is refused, and nothing is written", async () => {
  // `Delivery: 150` for a distance nobody priced is the silent version of this. `Delivery: 0` is
  // worse -- it reads as "no delivery", the cashier hands the fruit over and the trip is free. So
  // the bill does not exist until somebody prices the trip.
  const { response, client } = await bill(
    [{ charge_type_id: DELIVERY_ID, measurement: 40 }],
    { paid: 408 },
  );
  assert.equal(response.status, 400);
  assert.equal(response.body.code, CHARGE_REFUSALS.ABOVE_TOP_SLAB);
  assert.match(response.body.message, /15/);
  assert.match(response.body.message, /40/);
  assert.deepEqual(
    client.inserts.map((entry) => entry.sql.slice(0, 40)),
    [],
    "a refused bill writes nothing at all",
  );
  assert.ok(
    client.statements.some((entry) => /^ROLLBACK$/i.test(entry.sql)),
    "and the transaction it had opened is rolled back",
  );
});

test("the charge line is written with the name and rate it was charged at", async () => {
  // The reason `sale_charges` carries a name at all rather than only a `charge_type_id`. A bill
  // reprinted next year has to show what was actually charged, not what Settings says by then --
  // the same reasoning that put `tax_config_snapshot` on `sales`.
  const { response, client } = await bill(
    [{ charge_type_id: CRATE_ID, measurement: 10, quantity: 3 }],
    { paid: 528 },
  );
  assert.equal(response.status, 201, `bill refused: ${response.text}`);
  const charge = client.inserts.find((entry) => /^INSERT INTO sale_charges/i.test(entry.sql));
  assert.ok(charge, "the charge line must be written to sale_charges");
  // sale_id, charge_type_id, charge_name, measure_unit, measurement, quantity, rate, amount,
  // manual, slab_upto
  assert.deepEqual(charge.values, [SALE_ID, CRATE_ID, "Crate charge", "kg", 10, 3, 40, 120, false, 10]);
});

test("the name on the bill survives the charge type being turned off afterwards", async () => {
  // The snapshot doing its job. `sale_charges.charge_name` is written at billing time and is never
  // read back through `charge_types`, so switching the charge off -- or deleting it, which only
  // clears the id -- cannot rewrite what a past bill says it charged.
  const { response, client } = await bill(
    [{ charge_type_id: CRATE_ID, measurement: 10, quantity: 3 }],
    { paid: 528 },
  );
  assert.equal(response.status, 201, `bill refused: ${response.text}`);
  const charge = client.inserts.find((entry) => /^INSERT INTO sale_charges/i.test(entry.sql));
  assert.equal(charge.values[2], "Crate charge");
  assert.equal(charge.values[6], 40, "and the rate it was charged at");

  // The charge type is now off. A new bill naming it is refused by name...
  const afterwards = await bill(
    [{ charge_type_id: CRATE_ID, measurement: 10, quantity: 3 }],
    { paid: 528, types: [chargeTypeRow({ active: false })] },
  );
  assert.equal(afterwards.response.status, 400);
  assert.equal(afterwards.response.body.code, CHARGE_REFUSALS.CHARGE_INACTIVE);

  // ...while nothing about the row already written depends on the charge type still being there:
  // it carries its own name, unit, rate and amount, and the foreign key clears rather than cascades.
  assert.match(
    SOURCE,
    /charge_type_id INTEGER REFERENCES charge_types\(id\) ON DELETE SET NULL/,
    "deleting a charge type must not delete the history of what it charged",
  );
});

test("editing a bill that carries charges is refused rather than quietly dropping them", async () => {
  // The sale-edit path rebuilds `total_amount` from the items alone and knows nothing about
  // charges. Letting it through would leave the bill's own total disagreeing with its own lines,
  // which is the summary-versus-detail failure CLAUDE.md records as reading like data loss. Both
  // edit paths -- the online handler and the offline-sync operation -- refuse by name instead.
  const guards = SOURCE.match(/This bill has other charges on it\./g) || [];
  assert.equal(guards.length, 2, "both the online and the offline edit path must refuse");
  assert.match(SOURCE, /code: "SALE_HAS_OTHER_CHARGES"/);
});

test("no charge total can reach the taxable amount by any route in the file", () => {
  // A blunt backstop for the one arithmetic mistake that would be invisible in every test above:
  // the taxable amount is computed inside `calculateSalesMandiTax`, which is handed gross and the
  // two discounts and must never be handed a charge.
  const taxCall = SOURCE.slice(SOURCE.indexOf("const calculateSalesMandiTax"), SOURCE.indexOf("const calculateSalesMandiTax") + 2000);
  assert.doesNotMatch(taxCall, /otherCharges|other_charges|chargeLines/i, "tax is on fruit, not on charges");
  for (const match of SOURCE.matchAll(/calculateSalesMandiTax\(\{[\s\S]{0,400}?\}\)/g)) {
    assert.doesNotMatch(match[0], /charge/i, "no charge may be passed into the tax calculation");
  }
});

test("a NULL rate is a missing rate, not a free one", async () => {
  // `Number(null)` is 0, and 0 is a legitimate rate -- a shop may deliver free inside 5 km. So a
  // plain `Number()` on a NULL column cannot tell "free" from "nobody set a price", and would hand
  // out the charge for nothing. This is "errors must never render as zero" with money in it.
  const noRate = resolveChargeRateFromType({ charge_name: "Labour charge", basis: "FLAT", flat_rate: null });
  assert.equal(noRate.ok, false);
  assert.equal(noRate.code, CHARGE_REFUSALS.NO_RATE);

  // Same at the slab level: a row with no rate is dropped rather than treated as a free slab, so a
  // 12 km trip is refused instead of being delivered for nothing.
  const dropped = normaliseChargeSlabs([{ upto_value: 10, rate: null }, { upto_value: 15, rate: 150 }]);
  assert.deepEqual(dropped.map((slab) => slab.upto), [15]);
});

// -------------------------------------------------------------------------------------------
// The settings routes
// -------------------------------------------------------------------------------------------

/**
 * Answers the rate-manager role lookup and the two charge reads, and nothing else.
 *
 * Installed on both the pool and the transaction client, because these routes are split between
 * the two: the ones that write a charge type and its slabs together open a transaction, and the
 * single-statement ones do not.
 */
const settingsResponder = (role) => (sql, values) => {
  // The statement spans lines in the source, so the gap has to be matched as whitespace and not as
  // one space -- a literal space silently matches nothing and the route answers 500.
  if (/FROM users u\s+JOIN roles r/i.test(sql)) {
    return role
      ? { rows: [{ id: 7, full_name: "Owner", role_name: role }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }
  if (/FROM charge_types/i.test(sql)) return { rows: CHARGE_TYPE_ROWS, rowCount: CHARGE_TYPE_ROWS.length };
  if (/FROM charge_rate_slabs/i.test(sql)) {
    const ids = (values?.[0] || []).map(Number);
    return { rows: SLAB_ROWS.filter((row) => ids.includes(Number(row.charge_type_id))) };
  }
  if (/^\s*INSERT INTO charge_types/i.test(sql)) return { rows: [chargeTypeRow({ id: 41 })], rowCount: 1 };
  if (/^\s*UPDATE charge_types/i.test(sql)) return { rows: [chargeTypeRow()], rowCount: 1 };
  return undefined;
};

const settingsClient = (role) => {
  const responder = settingsResponder(role);
  const inserts = [];
  const statements = [];
  return {
    inserts,
    statements,
    release: () => {},
    query: async (text, values) => {
      const sql = String(typeof text === "object" && text ? text.text : text || "");
      statements.push({ sql: sql.replace(/\s+/g, " ").trim(), values: values || [] });
      if (/^\s*INSERT INTO/i.test(sql)) inserts.push({ sql: sql.replace(/\s+/g, " ").trim(), values: values || [] });
      const scripted = responder(sql, values);
      return scripted === undefined ? { rows: [], rowCount: 0 } : scripted;
    },
  };
};

const settingsCall = async (method, url, body, { role = "Owner" } = {}) => {
  const client = settingsClient(role);
  setConnectionResponder(() => client);
  setQueryResponder(settingsResponder(role));
  try {
    const response = await probe(app, method, url, {
      authorization: `Bearer ${token()}`,
      "content-type": "application/json",
    }, body);
    return { response, client };
  } finally {
    clearConnectionResponder();
    clearQueryResponder();
  }
};

test("the charge list comes back with each charge's slabs attached", async () => {
  // Slabs live in their own table, and a settings screen that had to fetch them charge by charge
  // would show a half-configured price list while it did.
  const { response } = await settingsCall("GET", "/settings/charge-types");
  assert.equal(response.status, 200, response.text);
  const delivery = response.body.find((row) => row.id === DELIVERY_ID);
  const crate = response.body.find((row) => row.id === CRATE_ID);
  assert.ok(delivery && crate, "both charges must be listed");
  // Each charge gets its own slabs and only its own: cross-attaching them would price a crate by
  // the delivery table, which is a wrong number that looks entirely reasonable on the screen.
  assert.deepEqual(delivery.slabs.map((slab) => Number(slab.upto_value)).sort((a, b) => a - b), [10, 15]);
  assert.deepEqual(crate.slabs.map((slab) => Number(slab.upto_value)).sort((a, b) => a - b), [10, 20]);
  assert.deepEqual(response.body.find((row) => row.id === LABOUR_ID).slabs, [], "a flat charge has none");
});

test("a charge type cannot be created or changed by anyone but Owner or Admin", async () => {
  // A charge rate is a price. Whoever can rewrite it rewrites what every future bill collects, so
  // these sit behind the same guard as the mandi tax and rebate rules beside them.
  for (const [method, url] of [
    ["POST", "/settings/charge-types"],
    ["PUT", "/settings/charge-types/1"],
    ["POST", "/settings/charge-types/1/deactivate"],
    ["POST", "/settings/charge-types/1/slabs"],
    ["PUT", "/settings/charge-types/1/slabs/2"],
    ["POST", "/settings/charge-types/1/slabs/2/deactivate"],
  ]) {
    const { response, client } = await settingsCall(method, url, {
      charge_name: "Crate charge",
      basis: "FLAT",
      flat_rate: 40,
      upto_value: 10,
      rate: 40,
    }, { role: "Cashier" });
    assert.equal(response.status, 403, `${method} ${url} answered ${response.status}`);
    assert.deepEqual(
      client.inserts.map((entry) => entry.sql),
      [],
      `${method} ${url} must not write before its permission check`,
    );
  }
});

test("a flat charge with no rate is refused at the form, not at the counter", async () => {
  // Created, it would refuse itself on every bill instead -- with a queue at the till and nobody
  // able to say why.
  const { response } = await settingsCall("POST", "/settings/charge-types", {
    charge_name: "Labour charge",
    basis: "FLAT",
  });
  assert.equal(response.status, 400);
  assert.match(response.body.message, /Enter a rate/);

  // A rate of 0 is a rate, and must get through the same check.
  const free = await settingsCall("POST", "/settings/charge-types", {
    charge_name: "Labour charge",
    basis: "FLAT",
    flat_rate: 0,
  });
  assert.equal(free.response.status, 201, free.response.text);
});

test("two slabs cannot share a measurement", async () => {
  // "The first slab that covers this" would then depend on which row the database felt like
  // returning first, which is a price that changes by itself between one bill and the next.
  const { response } = await settingsCall("POST", "/settings/charge-types", {
    charge_name: "Delivery charge",
    basis: "SLAB",
    measure_unit: "km",
    slabs: [{ upto_value: 10, rate: 100 }, { upto_value: 10, rate: 150 }],
  });
  assert.equal(response.status, 400);
  assert.match(response.body.message, /same measurement/);
});

test("a basis the server does not recognise is refused, not quietly turned into a flat charge", async () => {
  // `chargeBasisOf` maps anything unrecognised to FLAT, which is right when reading a stored row
  // whose CHECK constraint has already vetted it and wrong at the form: a typo would create a
  // flat charge the shop never asked for, priced at whatever `flat_rate` happened to carry.
  const { response } = await settingsCall("POST", "/settings/charge-types", {
    charge_name: "Delivery charge",
    basis: "PER_KM",
    measure_unit: "km",
    flat_rate: 0,
  });
  assert.equal(response.status, 400);
  assert.match(response.body.message, /flat or measured/);
});
