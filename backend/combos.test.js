"use strict";

/**
 * Combos & Offers: the rules in `combos.js`, the master routes against a real Postgres (PGlite)
 * built from cloud migration 024 itself, and what a bill carrying a combo does on every sale path.
 *
 * The contract (scratchpad CONTRACT.md with Amendments 1 and 2), as pinned here:
 *   - a combo is FIXED (items + price) or CUSTOM (no items, no price; an `extra_charge` and a
 *     `margin_percent` the counter prices from). Both carry `margin_percent`.
 *   - every combo line, FIXED or CUSTOM, is priced by the offer: its share of combo_price x
 *     combo_qty as rate + a sub-paisa discount. So it is exempt from the rate-override permission,
 *     the 5% manual-discount rule and the duplicate product+lot rule, and the lines of one combo
 *     must add up to the price within a paisa.
 *   - a desktop bill is never refused for a combo: a mismatch or an unknown combo is recorded as
 *     billed and audited (COMBO_MISMATCH_ACCEPTED / COMBO_UNKNOWN_ACCEPTED). A bill with no combo
 *     costs no extra query at all.
 *   - browser checkout refuses combos (COMBO_COUNTER_ONLY). Edit and return refusals are pinned in
 *     saleReturns.test.js, against that suite's database rig.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const combos = require("./combos");
const {
  loadServerApp,
  probe,
  setQueryResponder,
  clearQueryResponder,
  setConnectionResponder,
  clearConnectionResponder,
} = require("./routeAuthCoverage");
const { issueDeviceSession } = require("./deviceSession");

const { CODES } = combos;

// ---------------------------------------------------------------------------------------------
// validateComboInput
// ---------------------------------------------------------------------------------------------

const fixedBody = (extra = {}) => ({
  name: " Fruit Bowl ",
  kind: "combo_offer",
  combo_type: "fixed",
  price: "199.004",
  items: [{ product_id: "product-41", quantity: "0.5" }, { product_id: 42, quantity: 2, sort_order: 5 }],
  ...extra,
});

const customBody = (extra = {}) => ({ name: "Gift Box", kind: "GIFTING", combo_type: "CUSTOM", ...extra });

test("validate: a fixed combo is normalised -- name trimmed, kind and type upper-cased, money to the paisa", () => {
  const result = combos.validateComboInput(fixedBody({ margin_percent: "35", description: "  Seasonal  " }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.value, {
    name: "Fruit Bowl",
    kind: "COMBO_OFFER",
    combo_type: "FIXED",
    price: 199,
    extra_charge: 0,
    margin_percent: 35,
    description: "Seasonal",
    active: true,
    sort_order: 0,
    items: [
      { product_ref: "product-41", quantity: 0.5, sort_order: 0 },
      { product_ref: "42", quantity: 2, sort_order: 5 },
    ],
  });
});

test("validate: a custom combo has no items and no price; extra charge and margin are its pricing", () => {
  const result = combos.validateComboInput(customBody({ extra_charge: "50", margin_percent: 60, active: false }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.price, null);
  assert.equal(result.value.extra_charge, 50);
  assert.equal(result.value.margin_percent, 60);
  assert.deepEqual(result.value.items, []);
  assert.equal(result.value.active, false);
  const bare = combos.validateComboInput(customBody());
  assert.equal(bare.value.extra_charge, 0, "blank extra charge is none");
  assert.equal(bare.value.margin_percent, null, "blank margin is unset, not 0");
});

test("validate: every refusal has its own code", () => {
  const cases = [
    [fixedBody({ name: "  " }), CODES.NAME_REQUIRED],
    [fixedBody({ name: "x".repeat(121) }), CODES.NAME_REQUIRED],
    [fixedBody({ kind: "BREAKFAST" }), CODES.KIND_INVALID],
    [fixedBody({ combo_type: "MIXED" }), CODES.TYPE_INVALID],
    [fixedBody({ price: null }), CODES.PRICE_INVALID],
    [fixedBody({ price: 0 }), CODES.PRICE_INVALID],
    [fixedBody({ price: -5 }), CODES.PRICE_INVALID],
    [fixedBody({ price: "abc" }), CODES.PRICE_INVALID],
    [fixedBody({ price: 0.004 }), CODES.PRICE_INVALID, "rounds to nothing"],
    [customBody({ price: 100 }), CODES.PRICE_INVALID],
    [fixedBody({ items: [] }), CODES.ITEMS_REQUIRED],
    [fixedBody({ items: "apple" }), CODES.ITEM_INVALID],
    [fixedBody({ items: [{ quantity: 1 }] }), CODES.ITEM_INVALID],
    [fixedBody({ items: [{ product_id: 41, quantity: 0 }] }), CODES.ITEM_INVALID],
    [fixedBody({ items: [{ product_id: 41, quantity: 0.0004 }] }), CODES.ITEM_INVALID],
    [fixedBody({ items: [{ product_id: 41, quantity: 1 }, { product_id: "41", quantity: 2 }] }), CODES.ITEM_INVALID],
    [customBody({ items: [{ product_id: 41, quantity: 1 }] }), CODES.ITEM_INVALID],
    [customBody({ extra_charge: -1 }), CODES.CHARGE_INVALID],
    [customBody({ extra_charge: "ten" }), CODES.CHARGE_INVALID],
    [fixedBody({ extra_charge: 20 }), CODES.CHARGE_INVALID],
    [fixedBody({ margin_percent: -1 }), CODES.MARGIN_INVALID],
    [fixedBody({ margin_percent: 1000.01 }), CODES.MARGIN_INVALID],
    [customBody({ margin_percent: "lots" }), CODES.MARGIN_INVALID],
  ];
  for (const [body, code, note] of cases) {
    const result = combos.validateComboInput(body);
    assert.equal(result.ok, false, `${JSON.stringify(body)} ${note || ""}`);
    assert.equal(result.code, code, `${JSON.stringify(body)} ${note || ""}`);
    assert.ok(result.message.length > 0);
  }
  assert.equal(combos.validateComboInput(fixedBody({ extra_charge: 0 })).ok, true, "0 extra charge is fine on FIXED");
  assert.equal(combos.validateComboInput(fixedBody({ margin_percent: 1000 })).ok, true, "1000% is the ceiling, inclusive");
});

test("validate: ids are opaque -- '004' and 4 are different products, so both may be in one combo", () => {
  const result = combos.validateComboInput(fixedBody({ items: [{ product_id: "004", quantity: 1 }, { product_id: 4, quantity: 1 }] }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.value.items.map((item) => item.product_ref), ["004", "4"]);
});

// ---------------------------------------------------------------------------------------------
// allocateFixedComboLines
// ---------------------------------------------------------------------------------------------

const roundCurrency = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const sumNet = (lines) => lines.reduce((sum, line) => Math.round(sum * 100 + line.net_amount * 100) / 100, 0);

test("allocate: shares by value, last line takes the rest, rate is ceiled, the paisa left over is the discount", () => {
  // Apple 0.7 kg at 100 (value 70), Kiwi 2 at 30 (value 60); the combo sells for 99.99.
  const result = combos.allocateFixedComboLines([{ quantity: 0.7, rate: 100 }, { quantity: 2, rate: 30 }], 99.99);
  assert.equal(result.ok, true);
  assert.equal(result.total, 99.99);
  const [apple, kiwi] = result.lines;
  assert.equal(apple.share, 53.84, "99.99 x 70/130 = 53.8407..., half up to the paisa");
  assert.equal(apple.selling_rate, 76.92, "53.84 / 0.7 = 76.914..., ceiled");
  assert.equal(apple.amount, 53.84, "0.7 x 76.92 = 53.844");
  assert.equal(apple.discount_amount, 0);
  assert.equal(kiwi.share, 46.15, "the rest");
  assert.equal(kiwi.selling_rate, 23.08);
  assert.equal(kiwi.amount, 46.16);
  assert.equal(kiwi.discount_amount, 0.01);
  assert.equal(kiwi.net_amount, 46.15);
  assert.equal(sumNet(result.lines), 99.99, "the nets add up to the price exactly");
  assert.equal(apple.quantity, 0.7, "the caller's line fields are kept");
});

test("allocate: the counter's own vectors (frontend/src/local/combos.test.mjs), number for number", () => {
  const nets = (lines, total) => combos.allocateFixedComboLines(lines, total).lines.map((line) => line.net_amount);
  const pieces = combos.allocateFixedComboLines([{ quantity: 3, rate: 10 }, { quantity: 2, rate: 15 }], 100);
  assert.deepEqual(pieces.lines.map((line) => line.net_amount), [50, 50]);
  assert.equal(pieces.lines[0].selling_rate, 16.67, "only multiples of 3 paise are reachable at qty 3");
  assert.equal(pieces.lines[0].discount_amount, 0.01);
  assert.deepEqual(nets([{ quantity: 1, rate: 100 }, { quantity: 1, rate: 50 }, { quantity: 1, rate: 50 }], 100), [50, 25, 25]);
  assert.deepEqual(nets([{ quantity: 1, rate: 1 }, { quantity: 1, rate: 1 }, { quantity: 1, rate: 1 }], 1), [0.33, 0.33, 0.34]);
  assert.deepEqual(nets([{ quantity: 1, rate: 0 }, { quantity: 3, rate: 0 }], 40), [10, 30]);
  const mixed = combos.allocateFixedComboLines([{ quantity: 0.5, rate: 120 }, { quantity: 0.25, rate: 80 }], 99);
  assert.equal(sumNet(mixed.lines), 99);
});

test("allocate: with no usable rates, quantity is the weight", () => {
  const result = combos.allocateFixedComboLines([{ quantity: 1, rate: 0 }, { quantity: 3, rate: null }], 100);
  assert.equal(result.ok, true);
  assert.deepEqual(result.lines.map((line) => line.share), [25, 75]);
});

test("allocate: refused rather than guessed", () => {
  assert.equal(combos.allocateFixedComboLines([], 100).code, CODES.ALLOCATION_INVALID);
  assert.equal(combos.allocateFixedComboLines([{ quantity: 1, rate: 10 }], null).code, CODES.ALLOCATION_INVALID);
  assert.equal(combos.allocateFixedComboLines([{ quantity: 1, rate: 10 }], -1).code, CODES.ALLOCATION_INVALID);
  assert.equal(combos.allocateFixedComboLines([{ quantity: 0, rate: 10 }], 10).code, CODES.ALLOCATION_INVALID);
  const zero = combos.allocateFixedComboLines([{ quantity: 1, rate: 10 }], 0);
  assert.equal(zero.ok, true, "a free combo is still a combo");
  assert.deepEqual(zero.lines.map((line) => line.net_amount), [0]);
});

test("allocate: on random baskets every net adds up and the server re-derives each line to the same paisa", () => {
  let seed = 20261021;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let round = 0; round < 3000; round += 1) {
    const lines = Array.from({ length: 1 + Math.floor(random() * 5) }, () => ({
      quantity: Math.max(1, Math.floor(random() * 5000)) / 1000,
      rate: Math.floor(random() * 50000) / 100,
    }));
    const total = Math.floor(random() * 100000) / 100;
    const result = combos.allocateFixedComboLines(lines, total);
    assert.equal(result.ok, true, JSON.stringify({ lines, total }));
    assert.equal(sumNet(result.lines), roundCurrency(total), JSON.stringify({ lines, total }));
    for (const line of result.lines) {
      // What buildSalePayload stores for a combo line: amount = comboLineAmount(qty, rate),
      // net = amount - discount. It must land on the share, or the bill is a paisa off its payments.
      const amount = combos.comboLineAmount(line.quantity, line.selling_rate);
      assert.equal(amount, line.amount, JSON.stringify(line));
      assert.equal(roundCurrency(amount - line.discount_amount), line.share, JSON.stringify(line));
      assert.ok(line.discount_amount >= 0, JSON.stringify(line));
    }
  }
});

test("comboLineAmount: an exact half paisa rounds up, where the float product would round down", () => {
  // 1.7 x 39.25 = 66.725 exactly, but 66.72499999... as a double.
  assert.equal(roundCurrency(1.7 * 39.25), 66.72, "the float trap this guards against");
  assert.equal(combos.comboLineAmount(1.7, 39.25), 66.73);
  assert.equal(combos.comboLineAmount("0.333", "3.00"), 1);
  assert.equal(combos.comboLineAmount(2, 27.27), 54.54);
});

test("allocate: the same numbers as the counter's allocateComboPrice (frontend/src/local/combos.js)", async (t) => {
  const frontendModule = path.join(__dirname, "..", "frontend", "src", "local", "combos.js");
  if (!fs.existsSync(frontendModule)) {
    t.skip("frontend/src/local/combos.js is not present");
    return;
  }
  const front = await import(require("node:url").pathToFileURL(frontendModule).href);
  if (typeof front.allocateComboPrice !== "function") {
    t.skip("the counter module has no allocateComboPrice");
    return;
  }
  let seed = 4242;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let round = 0; round < 3000; round += 1) {
    const lines = Array.from({ length: 1 + Math.floor(random() * 5) }, () => ({
      quantity: Math.max(1, Math.floor(random() * 5000)) / 1000,
      rate: random() < 0.1 ? 0 : Math.floor(random() * 50000) / 100,
    }));
    const total = Math.floor(random() * 100000) / 100;
    const server = combos.allocateFixedComboLines(lines, total);
    const counter = front.allocateComboPrice(lines, total);
    assert.equal(server.ok, counter.ok, JSON.stringify({ lines, total }));
    if (!server.ok) continue;
    assert.deepEqual(
      server.lines.map((line) => [line.selling_rate, line.amount, line.discount_amount, line.net_amount]),
      counter.lines.map((line) => [line.selling_rate, line.amount, line.discount_amount, line.net]),
      JSON.stringify({ lines, total }),
    );
  }
});

// ---------------------------------------------------------------------------------------------
// checkComboGroups
// ---------------------------------------------------------------------------------------------

const MASTER = {
  global_id: "combo-3", active: true, combo_type: "FIXED", price: "99.99", extra_charge: "0.00",
  items: [{ product_id: 11, quantity: 0.7 }, { product_id: 12, quantity: 2 }],
};
const masters = (...rows) => new Map(rows.map((row) => [row.global_id, row]));

const fixedTag = (overrides = {}) => ({
  comboLineKey: "k1", comboId: "combo-3", comboName: "Fruit Bowl", comboKind: "COMBO_OFFER",
  comboType: "FIXED", comboQty: 1, comboPrice: 99.99, ...overrides,
});
const comboItem = (productId, quantity, netAmount, tag = {}) => ({ combo: fixedTag(tag), productId, quantity, netAmount });
const goodBowl = (tag) => [comboItem(11, 0.7, 53.84, tag), comboItem(12, 2, 46.15, tag)];

test("group check: a bill that matches its combo has nothing to report; plain lines are not groups", () => {
  const result = combos.checkComboGroups([...goodBowl(), { combo: null, productId: 11, quantity: 1, netAmount: 100 }], masters(MASTER));
  assert.deepEqual(result, { groups: 1, findings: [] });
  // Two of the combo: price x 2, every item x 2.
  const double = combos.checkComboGroups(
    [comboItem(11, 1.4, 107.68, { comboQty: 2 }), comboItem(12, 4, 92.3, { comboQty: 2 })],
    masters(MASTER),
  );
  assert.deepEqual(double.findings, []);
});

test("group check: a total within a paisa passes, beyond it is reported", () => {
  assert.deepEqual(combos.checkComboGroups([comboItem(11, 0.7, 53.85), comboItem(12, 2, 46.15)], masters(MASTER)).findings, []);
  const [finding] = combos.checkComboGroups([comboItem(11, 0.7, 53.86), comboItem(12, 2, 46.15)], masters(MASTER)).findings;
  assert.equal(finding.code, CODES.MISMATCH_ACCEPTED);
  assert.deepEqual(finding.reasons, ["TOTAL_MISMATCH"]);
  assert.equal(finding.billed.total, 100.01);
  assert.equal(finding.billed.expected_total, 99.99);
});

test("group check: master changes are named, never refused", () => {
  const reasonsFor = (items, master) => combos.checkComboGroups(items, masters(master)).findings[0]?.reasons;
  assert.deepEqual(reasonsFor(goodBowl(), { ...MASTER, active: false }), ["COMBO_INACTIVE"]);
  assert.deepEqual(reasonsFor(goodBowl(), { ...MASTER, price: "120.00" }), ["PRICE_CHANGED"]);
  assert.deepEqual(reasonsFor(goodBowl(), { ...MASTER, items: [{ product_id: 11, quantity: 1 }, { product_id: 12, quantity: 2 }] }), ["ITEMS_CHANGED"]);
  assert.deepEqual(reasonsFor(goodBowl(), { ...MASTER, items: [{ product_id: 11, quantity: 0.7 }] }), ["ITEMS_CHANGED"]);
  assert.deepEqual(reasonsFor(goodBowl(), { ...MASTER, combo_type: "CUSTOM" }), ["TYPE_CHANGED"]);
  // Product ids compare as opaque text: "011" is not product 11.
  assert.deepEqual(reasonsFor(goodBowl(), { ...MASTER, items: [{ product_id: "011", quantity: 0.7 }, { product_id: 12, quantity: 2 }] }), ["ITEMS_CHANGED"]);
});

test("group check: an unknown combo is reported as unknown, with its own problems too", () => {
  const [finding] = combos.checkComboGroups(goodBowl({ comboId: "combo-404" }), masters(MASTER)).findings;
  assert.equal(finding.code, CODES.UNKNOWN_ACCEPTED);
  assert.deepEqual(finding.reasons, ["COMBO_UNKNOWN"]);
  assert.equal(finding.master, null);
  const [broken] = combos.checkComboGroups([comboItem(11, 0.7, 10, { comboId: "combo-404", comboPrice: null })], masters()).findings;
  assert.deepEqual(broken.reasons, ["COMBO_UNKNOWN", "PRICE_MISSING"]);
});

test("group check: lines of one combo must agree, carry a key, a whole quantity and a known type", () => {
  const disagree = combos.checkComboGroups([comboItem(11, 0.7, 53.84), comboItem(12, 2, 46.15, { comboPrice: 89.99 })], masters(MASTER));
  assert.ok(disagree.findings[0].reasons.includes("LINES_DISAGREE"));
  const noKey = combos.checkComboGroups(goodBowl({ comboLineKey: "" }), masters(MASTER));
  assert.ok(noKey.findings[0].reasons.includes("LINE_KEY_MISSING"));
  const fraction = combos.checkComboGroups(goodBowl({ comboQty: 1.5 }), masters(MASTER));
  assert.ok(fraction.findings[0].reasons.includes("QTY_INVALID"));
  const oddType = combos.checkComboGroups(goodBowl({ comboType: "BUNDLE" }), masters(MASTER));
  assert.ok(oddType.findings[0].reasons.includes("TYPE_INVALID"));
});

test("group check: a custom combo is held to its own price on the bill; the server does not re-price it", () => {
  const giftMaster = { global_id: "combo-4", active: true, combo_type: "CUSTOM", price: null, extra_charge: "50.00", margin_percent: "60.00", items: [] };
  const tag = { comboId: "combo-4", comboName: "Gift Box", comboKind: "GIFTING", comboType: "CUSTOM", comboQty: 1, comboPrice: 250, comboLineKey: "g1" };
  // Whatever the items were and whatever the margin says, the lines adding to combo_price is the check.
  const fine = combos.checkComboGroups([comboItem(11, 1, 150, tag), comboItem(12, 3, 100, tag)], masters(giftMaster));
  assert.deepEqual(fine.findings, []);
  const off = combos.checkComboGroups([comboItem(11, 1, 150, tag), comboItem(12, 3, 90, tag)], masters(giftMaster));
  assert.deepEqual(off.findings[0].reasons, ["TOTAL_MISMATCH"]);
  const twice = combos.checkComboGroups([comboItem(11, 2, 500, { ...tag, comboQty: 2 })], masters(giftMaster));
  assert.deepEqual(twice.findings[0].reasons, ["QTY_INVALID"], "a customised combo is made once");
});

test("sale-line fields: read leniently, written in one shape; line_index alone does not make a combo line", () => {
  assert.equal(combos.readSaleLineCombo({ product_id: 1, line_index: 3 }), null);
  assert.equal(combos.isComboLine({ line_index: 3 }), false);
  assert.equal(combos.isComboLine({ combo_line_key: "k" }), true);
  assert.equal(combos.anyComboLine([{}, { combo_type: "FIXED" }]), true);
  assert.equal(combos.anyComboLine(null), false);
  const tag = combos.readSaleLineCombo({
    combo_line_key: " k1 ", combo_id: "combo-3", combo_name: "Fruit Bowl", combo_kind: "combo_offer",
    combo_type: "fixed", combo_qty: "2", combo_price: "99.994",
  });
  assert.deepEqual(tag, {
    comboLineKey: "k1", comboId: "combo-3", comboName: "Fruit Bowl", comboKind: "COMBO_OFFER",
    comboType: "FIXED", comboQty: 2, comboPrice: 99.99,
  });
  assert.equal(combos.isComboPricedLine({ combo: tag }), true);
  assert.equal(combos.isComboPricedLine({ combo: { ...tag, comboType: "CUSTOM" } }), true, "CUSTOM lines are priced by the offer too");
  assert.equal(combos.isComboPricedLine({ combo: null }), false);
  assert.deepEqual(combos.comboFieldsOf({ combo: tag, lineIndex: 4 }), {
    combo_line_key: "k1", combo_id: "combo-3", combo_name: "Fruit Bowl", combo_kind: "COMBO_OFFER",
    combo_type: "FIXED", combo_qty: 2, combo_price: 99.99, line_index: 4,
  });
  assert.deepEqual(Object.values(combos.comboFieldsOf({ combo: null, lineIndex: null })), Array(8).fill(null));
  assert.deepEqual(combos.SALE_ITEM_COMBO_COLUMNS, [
    "combo_line_key", "combo_id", "combo_name", "combo_kind", "combo_type", "combo_qty", "combo_price", "line_index",
  ]);
  assert.equal(combos.readLineIndex("2"), 2);
  assert.equal(combos.readLineIndex(-1), null);
  assert.equal(combos.readLineIndex(1.5), null);
});

// ---------------------------------------------------------------------------------------------
// Schema: cloud migration 024 and the startup bootstrap
// ---------------------------------------------------------------------------------------------

const MIGRATION = fs.readFileSync(path.join(__dirname, "migrations", "cloud", "024_combos.sql"), "utf8");
const SERVER_SOURCE = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

test("schema: the combo master carries extra_charge and margin_percent, and no charge_type_id", () => {
  for (const source of [MIGRATION, SERVER_SOURCE]) {
    assert.match(source, /extra_charge NUMERIC\(14, 2\) NOT NULL DEFAULT 0,/);
    assert.match(source, /margin_percent NUMERIC\(6, 2\),/);
  }
  const comboTable = MIGRATION.slice(MIGRATION.indexOf("CREATE TABLE IF NOT EXISTS combos ("), MIGRATION.indexOf("CREATE UNIQUE INDEX"));
  assert.doesNotMatch(comboTable, /charge_type_id/);
  for (const column of combos.SALE_ITEM_COMBO_COLUMNS) {
    assert.match(MIGRATION, new RegExp(`ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS ${column} `));
    assert.match(SERVER_SOURCE, new RegExp(`ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS ${column} `));
  }
  assert.ok(require("../scripts/run-cloud-migrations").migrationFiles.includes("backend/migrations/cloud/024_combos.sql"));
});

// ---------------------------------------------------------------------------------------------
// Master routes, against PGlite holding migration 024
// ---------------------------------------------------------------------------------------------

const app = loadServerApp();

/** Must match the throwaway key `routeAuthCoverage` pins into the environment before loading. */
const TEST_SIGNING_KEY = "route-auth-coverage-isolated-signing-key-000000";
const OWNER_ID = 7;
const COMPANY_ID = 1;
const DEVICE_ID = "FZDEV-COMBOS";
const token = issueDeviceSession({
  userId: OWNER_ID, deviceId: DEVICE_ID, companyId: COMPANY_ID, branchId: 1, role: "Owner", secret: TEST_SIGNING_KEY,
});
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

const normalise = (sql) => String(typeof sql === "object" && sql ? sql.text : sql || "").replace(/\s+/g, " ").trim();
const rows = (list) => ({ rows: list, rowCount: list.length });
const find = (statements, pattern) => statements.filter(({ sql }) => pattern.test(sql));
const writes = (statements) => statements.filter(({ sql }) => /^(INSERT|UPDATE|DELETE)\b/i.test(sql));
const MANAGER_SQL = /^SELECT u\.id, u\.full_name, r\.role_name FROM users u JOIN roles r/;

const deviceScope = (sql, role = "Owner") => {
  if (/FROM authorized_devices d/i.test(sql)) {
    return rows([{
      device_id: DEVICE_ID, device_status: "APPROVED", company_id: COMPANY_ID, branch_id: 1,
      operational_location_id: 10, assignment_generation: 1, fixed_operational: true, intended_usage: "POS",
      device_permissions: {}, device_assignment_active: true, location_active: true, branch_active: true,
      role_id: 1, is_default: true, staff_permissions: {}, staff_assignment_active: true, role_name: role,
    }]);
  }
  if (/SELECT session_revocation_version FROM users/i.test(sql)) return rows([{ session_revocation_version: 0 }]);
  return undefined;
};

const MASTER_SCHEMA = `
  CREATE TABLE products (
    id INTEGER PRIMARY KEY, global_id VARCHAR(80), product_name TEXT, unit TEXT, active BOOLEAN DEFAULT TRUE,
    deleted_at TIMESTAMP, company_id INTEGER
  );
  CREATE TABLE sale_items (id SERIAL PRIMARY KEY, sale_id INTEGER);
  CREATE TABLE branches (id INTEGER PRIMARY KEY, company_id INTEGER, active BOOLEAN DEFAULT TRUE);
  CREATE TABLE sync_change_log (
    change_id BIGSERIAL PRIMARY KEY, company_id INTEGER, branch_id INTEGER, operational_location_id INTEGER,
    assignment_generation INTEGER, entity_type TEXT, entity_id TEXT, operation_type TEXT, entity_version INTEGER,
    payload JSONB, created_at TIMESTAMPTZ DEFAULT now()
  );
  INSERT INTO branches VALUES (1, 1, TRUE), (2, 1, TRUE), (3, 2, TRUE);
  INSERT INTO products VALUES
    (41, 'product-41', 'Apple', 'KG', TRUE, NULL, 1),
    (42, NULL, 'Kiwi', 'PCS', TRUE, NULL, 1),
    (43, 'product-43', 'Old Plum', 'KG', TRUE, '2026-01-01', 1),
    (44, 'product-44', 'Their Mango', 'KG', TRUE, NULL, 2),
    (45, 'product-45', 'Off-sale Fig', 'KG', FALSE, NULL, 1);
`;

const withMaster = async (run, { role = "Owner" } = {}) => {
  const { PGlite } = require("@electric-sql/pglite");
  const db = new PGlite();
  await db.exec(MASTER_SCHEMA);
  // The migration file itself, twice: the runner replays the whole list every time.
  await db.exec(MIGRATION);
  await db.exec(MIGRATION);
  const statements = [];
  const state = { role };
  const query = async (text, values) => {
    const sql = normalise(text);
    statements.push({ sql, values: values || [] });
    const scoped = deviceScope(sql, state.role);
    if (scoped) return scoped;
    if (MANAGER_SQL.test(sql)) return rows([{ id: OWNER_ID, full_name: "Rig", role_name: state.role }]);
    const result = await db.query(typeof text === "object" && text ? text.text : text, values || []);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  };
  setQueryResponder((sql, values) => query(sql, values));
  setConnectionResponder(() => ({ query, release: () => {} }));
  try {
    return await run({ db, statements, state });
  } finally {
    clearQueryResponder();
    clearConnectionResponder();
    await db.close();
  }
};

const post = (body) => probe(app, "POST", "/api/v3/combos", headers, body);
const put = (id, body) => probe(app, "PUT", `/api/v3/combos/${id}`, headers, body);
const list = () => probe(app, "GET", "/api/v3/combos", headers);

test("routes: the Owner creates a fixed combo; it is stored, read back whole and published to every branch", async () => {
  await withMaster(async ({ db }) => {
    const created = await post(fixedBody({ margin_percent: 35 }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const combo = created.body.combo;
    assert.equal(combo.global_id, `combo-${combo.id}`);
    assert.equal(combo.name, "Fruit Bowl");
    assert.equal(Number(combo.price), 199);
    assert.equal(Number(combo.extra_charge), 0);
    assert.equal(Number(combo.margin_percent), 35);
    assert.equal(combo.entity_version, 1);
    assert.deepEqual(combo.items.map((item) => [item.product_id, item.product_global_id, item.product_name, item.unit, Number(item.quantity)]), [
      [41, "product-41", "Apple", "KG", 0.5],
      [42, "product-42", "Kiwi", "PCS", 2],
    ]);
    assert.deepEqual(combo.unavailable_products, []);

    const changes = (await db.query("SELECT branch_id, entity_type, entity_id, entity_version, payload FROM sync_change_log ORDER BY branch_id")).rows;
    assert.deepEqual(changes.map((row) => [row.branch_id, row.entity_type, row.entity_id]), [
      [1, "combo", combo.global_id],
      [2, "combo", combo.global_id],
    ], "both branches of company 1, and not company 2's");
    assert.equal(changes[0].payload.items.length, 2, "the payload carries the items");
    assert.equal(changes[0].payload.items[1].product_global_id, "product-42");
    assert.equal(Number(changes[0].payload.margin_percent), 35);

    const listed = await list();
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.ok(Array.isArray(listed.body));
    assert.deepEqual(listed.body.map((row) => row.global_id), [combo.global_id]);
  });
});

test("routes: a custom combo stores its extra charge and margin and no items", async () => {
  await withMaster(async () => {
    const created = await post(customBody({ extra_charge: 50, margin_percent: 60 }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.combo.combo_type, "CUSTOM");
    assert.equal(created.body.combo.price, null);
    assert.equal(Number(created.body.combo.extra_charge), 50);
    assert.equal(Number(created.body.combo.margin_percent), 60);
    assert.deepEqual(created.body.combo.items, []);
  });
});

test("routes: an update replaces the items wholesale, bumps the version and republishes", async () => {
  await withMaster(async ({ db }) => {
    const created = (await post(fixedBody())).body.combo;
    const updated = await put(created.global_id, fixedBody({ price: 149, items: [{ product_id: 42, quantity: 3 }], margin_percent: null }));
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.combo.entity_version, 2);
    assert.equal(Number(updated.body.combo.price), 149);
    assert.equal(updated.body.combo.margin_percent, null, "an explicit null clears the margin");
    assert.deepEqual(updated.body.combo.items.map((item) => [item.product_id, Number(item.quantity)]), [[42, 3]]);
    assert.equal(Number((await db.query("SELECT COUNT(*) AS n FROM combo_items")).rows[0].n), 1, "old items are gone");
    const versions = (await db.query("SELECT entity_version FROM sync_change_log WHERE branch_id = 1 ORDER BY change_id")).rows;
    assert.deepEqual(versions.map((row) => row.entity_version), [1, 2]);

    const byId = await put(String(created.id), fixedBody({ active: false }));
    assert.equal(byId.status, 200, "the numeric id works too");
    assert.equal(byId.body.combo.active, false);
  });
});

test("routes: a product that is off sale is named on the combo, not refused", async () => {
  await withMaster(async () => {
    const created = await post(fixedBody({ items: [{ product_id: 41, quantity: 1 }, { product_id: "product-45", quantity: 1 }] }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(created.body.combo.unavailable_products, ["Off-sale Fig"]);
  });
});

test("routes: refusals answer with their code and write nothing", async () => {
  await withMaster(async ({ db, statements }) => {
    const cases = [
      [fixedBody({ price: 0 }), 400, CODES.PRICE_INVALID],
      [fixedBody({ items: [{ product_id: "product-999", quantity: 1 }] }), 400, CODES.ITEM_INVALID],
      [fixedBody({ items: [{ product_id: 43, quantity: 1 }] }), 400, CODES.ITEM_INVALID, "deleted product"],
      [fixedBody({ items: [{ product_id: 44, quantity: 1 }] }), 400, CODES.ITEM_INVALID, "another company's product"],
      [fixedBody({ items: [{ product_id: 41, quantity: 1 }, { product_id: "product-41", quantity: 1 }] }), 400, CODES.ITEM_INVALID, "one product by two names"],
      [customBody({ margin_percent: 5000 }), 400, CODES.MARGIN_INVALID],
      [customBody({ extra_charge: -2 }), 400, CODES.CHARGE_INVALID],
    ];
    for (const [body, status, code, note] of cases) {
      statements.length = 0;
      const response = await post(body);
      assert.equal(response.status, status, `${note || code}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.code, code, note || code);
      assert.deepEqual(writes(statements), [], note || code);
    }
    const missing = await put("combo-999", fixedBody());
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, CODES.NOT_FOUND);
    assert.equal(Number((await db.query("SELECT COUNT(*) AS n FROM combos")).rows[0].n), 0);
    assert.equal(Number((await db.query("SELECT COUNT(*) AS n FROM sync_change_log")).rows[0].n), 0);
  });
});

test("routes: two active combos cannot share a name; a switched-off one frees it", async () => {
  await withMaster(async () => {
    assert.equal((await post(fixedBody())).status, 201);
    const clash = await post(fixedBody({ name: "fruit bowl" }));
    assert.equal(clash.status, 409, JSON.stringify(clash.body));
    assert.equal(clash.body.code, CODES.NAME_TAKEN);
    const first = (await list()).body[0];
    assert.equal((await put(first.global_id, fixedBody({ active: false }))).status, 200);
    assert.equal((await post(fixedBody())).status, 201, "the name is free once the old one is off");
  });
});

test("routes: a Cashier may read combos but not write them", async () => {
  await withMaster(async ({ statements }) => {
    const response = await post(fixedBody());
    assert.equal(response.status, 403);
    assert.equal(response.body.code, CODES.PERMISSION_REQUIRED);
    assert.deepEqual(writes(statements), []);
    const updated = await put("combo-1", fixedBody());
    assert.equal(updated.status, 403);
    const listed = await list();
    assert.equal(listed.status, 200, "the counter sells from the list");
    // The permission check reads the session's user, never one named in the body.
    const manager = find(statements, MANAGER_SQL);
    assert.ok(manager.length > 0);
    for (const statement of manager) assert.deepEqual(statement.values, [OWNER_ID]);
  }, { role: "Cashier" });
});

test("routes: a server without the combo tables says so by name", async () => {
  setQueryResponder((sql) => {
    const scoped = deviceScope(normalise(sql));
    if (scoped) return scoped;
    if (/FROM combos c/.test(normalise(sql))) {
      const error = new Error('relation "combos" does not exist');
      error.code = "42P01";
      throw error;
    }
    return rows([]);
  });
  try {
    const response = await list();
    assert.equal(response.status, 500);
    assert.equal(response.body.code, "COMBO_STORAGE_MISSING");
  } finally {
    clearQueryResponder();
  }
});

test("routes: without a session there is nothing to read or write", async () => {
  const anonymous = { "content-type": "application/json" };
  assert.equal((await probe(app, "GET", "/api/v3/combos", anonymous)).status, 401);
  assert.equal((await probe(app, "POST", "/api/v3/combos", anonymous, fixedBody())).status, 401);
  assert.equal((await probe(app, "PUT", "/api/v3/combos/1", anonymous, fixedBody())).status, 401);
});

// ---------------------------------------------------------------------------------------------
// Desktop sync: a bill carrying a combo
// ---------------------------------------------------------------------------------------------

const { processSyncOperation } = require("./server");

const APPLE = { id: 11, product_name: "Apple", selling_rate: "100.00", unit: "KG" };
const KIWI = { id: 12, product_name: "Kiwi", selling_rate: "30.00", unit: "PCS" };
const LOT_OF = { 11: 900, 12: 901 };
const SYNC_MASTER = {
  id: 3, global_id: "combo-3", company_id: 1, name: "Fruit Bowl", kind: "COMBO_OFFER", combo_type: "FIXED",
  price: "99.99", extra_charge: "0.00", margin_percent: null, active: true,
  items: [{ product_id: 11, quantity: "0.700" }, { product_id: 12, quantity: "2.000" }],
};

const syncContext = {
  user: { id: OWNER_ID, full_name: "Counter" },
  device: { device_id: DEVICE_ID, status: "APPROVED" },
  branch: { id: 2, company_id: 1, active: true },
  companyId: 1,
  branchId: 2,
  deviceId: DEVICE_ID,
  operationalLocationId: null,
  assignmentGeneration: null,
};

/** A scripted database for one desktop bill. `role` is who the sync user is for permission checks. */
const syncClient = ({ masters: masterRows = [SYNC_MASTER], role = "Cashier" } = {}) => {
  const statements = [];
  let saleItemId = 500;
  const query = async (text, values = []) => {
    const sql = normalise(text);
    statements.push({ sql, values });
    if (/FROM customers WHERE id = \$1/i.test(sql)) return rows([{ id: 5, customer_name: "Walk-in", system_account: true, active: true }]);
    if (/FROM products WHERE id = ANY/i.test(sql)) return rows([APPLE, KIWI].filter((product) => values[0].includes(product.id)));
    if (/^SELECT id, product_id, remaining_qty, batch_status FROM inventory_batches/.test(sql)) {
      return rows(values[0].map((id) => ({ id, product_id: id === 900 ? 11 : 12, remaining_qty: "50.000", batch_status: "ACTIVE" })));
    }
    if (/^SELECT[\s\S]*FROM inventory_batches/i.test(sql)) {
      return rows([{ id: LOT_OF[values[0]], remaining_qty: "50.000", purchase_rate: "40.00", purchase_bill_status: "BILL_COMPLETED", temporary_sale_rate: "0", lot_name: "L", lot_size: null }]);
    }
    if (/FROM combos c/.test(sql)) return rows(masterRows.filter((row) => (values[2] || []).includes(row.global_id)));
    if (/^SELECT u\.id, u\.full_name, r\.role_name, COALESCE\(rps\.permissions/.test(sql)) {
      return rows([{ id: OWNER_ID, full_name: "Counter", role_name: role, permissions: {} }]);
    }
    if (/^INSERT INTO sales/.test(sql)) return rows([{ id: 5151, sale_date: new Date(), global_id: "invoice-combo-1", entity_version: 1 }]);
    if (/^INSERT INTO sale_items/.test(sql)) return rows([{ id: (saleItemId += 1) }]);
    if (/^INSERT INTO sync_pos_sale_staging/.test(sql)) return rows([{ entity_version: 1, updated_at: new Date() }]);
    if (/^INSERT INTO sync_change_log/.test(sql)) return rows([{ change_id: 1, created_at: new Date() }]);
    return rows([]);
  };
  return { statements, query, release: () => {} };
};

/** The fields a counter sends for one line of a combo instance. */
const comboLine = (productId, allocated, tag = {}) => ({
  product_id: productId,
  inventory_batch_id: LOT_OF[productId],
  quantity: allocated.quantity,
  selling_rate: allocated.selling_rate,
  rate: allocated.selling_rate,
  discount_amount: allocated.discount_amount,
  combo_line_key: "k1",
  combo_id: "combo-3",
  combo_name: "Fruit Bowl",
  combo_kind: "COMBO_OFFER",
  combo_type: "FIXED",
  combo_qty: 1,
  combo_price: 99.99,
  ...tag,
});

const bowlLines = (tag = {}, { total = 99.99, scale = 1 } = {}) => {
  const allocation = combos.allocateFixedComboLines([{ quantity: 0.7 * scale, rate: 100 }, { quantity: 2 * scale, rate: 30 }], total);
  assert.equal(allocation.ok, true);
  return [comboLine(11, allocation.lines[0], tag), comboLine(12, allocation.lines[1], tag)];
};

const syncBill = async (items, { payments, client = syncClient(), operationId = "combo-op-1" } = {}) => {
  const total = Math.round(items.reduce((sum, item) => sum + combos.comboLineAmount(item.quantity, item.selling_rate) * 100 - Number(item.discount_amount || 0) * 100, 0)) / 100;
  const ack = await processSyncOperation(client, {
    operation_id: operationId,
    entity_type: "pos_sale",
    entity_id: "invoice-combo-1",
    operation_type: "UPSERT",
    payload: {
      operation_id: operationId,
      invoice_global_id: "invoice-combo-1",
      offline_invoice_ref: "OFF-20261021-0001",
      customer: { account_id: 5 },
      bill_date: "2026-10-21",
      bill_datetime: "2026-10-21T10:00",
      bill_discount_total: 0,
      items: items.map((item, index) => ({ line_index: index, ...item })),
      payments: payments || [{ mode: "CASH", amount: total }],
    },
  }, syncContext);
  return { ack, statements: client.statements, total };
};

const saleItemRows = (statements) => find(statements, /^INSERT INTO sale_items/).map((statement) => {
  const sql = statement.sql;
  const columns = sql.slice(sql.indexOf("(") + 1, sql.indexOf(") VALUES")).split(",").map((name) => name.trim());
  return Object.fromEntries(columns.map((name, index) => [name, statement.values[index]]));
});
const auditRows = (statements) => find(statements, /^INSERT INTO sale_audit_trail/);

test("sync: a fixed combo bill is accepted with its lines priced as billed and the combo fields stored", async () => {
  const { ack, statements, total } = await syncBill(bowlLines());
  assert.equal(ack.status, "accepted", ack.message);
  assert.equal(total, 99.99);
  const stored = saleItemRows(statements);
  assert.equal(stored.length, 2);
  assert.deepEqual(stored.map((row) => [row.product_id, row.selling_rate, row.amount, row.discount_amount, row.net_amount]), [
    [11, 76.92, 53.84, 0, 53.84],
    [12, 23.08, 46.16, 0.01, 46.15],
  ]);
  for (const [index, row] of stored.entries()) {
    assert.equal(row.manual_rate_override, false, "an offer's rate is not a cashier's override");
    assert.equal(row.combo_line_key, "k1");
    assert.equal(row.combo_id, "combo-3");
    assert.equal(row.combo_name, "Fruit Bowl");
    assert.equal(row.combo_kind, "COMBO_OFFER");
    assert.equal(row.combo_type, "FIXED");
    assert.equal(row.combo_qty, 1);
    assert.equal(row.combo_price, 99.99);
    assert.equal(row.line_index, index);
  }
  assert.equal(find(statements, /FROM combos c/).length, 1, "one read of the masters for the whole bill");
  assert.deepEqual(auditRows(statements), [], "a matching combo leaves no trace, and its rate is not a discount");
});

test("sync: a plain bill costs no combo query and stores null combo fields", async () => {
  const plain = [{ product_id: 11, inventory_batch_id: 900, quantity: 1, selling_rate: 100, rate: 100, discount_amount: 0 }];
  const { ack, statements } = await syncBill(plain);
  assert.equal(ack.status, "accepted", ack.message);
  assert.deepEqual(find(statements, /combos/), [], "no extra statement for a bill without a combo");
  const [row] = saleItemRows(statements);
  for (const column of combos.COMBO_LINE_FIELDS) assert.equal(row[column], null, column);
  assert.equal(row.line_index, 0, "cart order is kept on every line");
});

test("sync: the same product and lot twice is fine when the lines belong to combos", async () => {
  const lines = [...bowlLines(), ...bowlLines({ combo_line_key: "k2" })];
  const { ack, statements } = await syncBill(lines);
  assert.equal(ack.status, "accepted", ack.message);
  assert.equal(saleItemRows(statements).length, 4);
  assert.deepEqual(auditRows(statements), []);
});

test("sync: a combo billed below its items' list rates needs no override permission and is not a discount", async () => {
  // A Cashier without the rate-override permission sells the bowl at half its fruit value.
  const lines = bowlLines({ combo_price: 64 }, { total: 64 });
  const client = syncClient({ masters: [{ ...SYNC_MASTER, price: "64.00" }] });
  const { ack, statements } = await syncBill(lines, { client });
  assert.equal(ack.status, "accepted", ack.message);
  assert.deepEqual(auditRows(statements), [], "no DISCOUNT_UNAPPROVED for an offer's price");
  for (const row of saleItemRows(statements)) assert.equal(row.manual_rate_override, false);
});

test("sync: a combo that no longer matches its master is accepted as billed and audited", async () => {
  // The counter was offline when the owner re-priced the bowl to 120: it sold at 99.99.
  const client = syncClient({ masters: [{ ...SYNC_MASTER, price: "120.00" }] });
  const { ack, statements } = await syncBill(bowlLines(), { client });
  assert.equal(ack.status, "accepted", ack.message);
  assert.equal(saleItemRows(statements).length, 2, "kept as the customer was billed");
  const [audit] = auditRows(statements);
  assert.ok(audit, "an audit row was written");
  assert.deepEqual(audit.values.slice(0, 2), [5151, CODES.MISMATCH_ACCEPTED]);
  assert.match(audit.sql, /'combo'/);
  const master = JSON.parse(audit.values[2]);
  const billed = JSON.parse(audit.values[3]);
  assert.equal(master.price, "120.00");
  assert.deepEqual(billed.reasons, ["PRICE_CHANGED"]);
  assert.equal(billed.combo_line_key, "k1");
  assert.equal(billed.total, 99.99);
  assert.match(audit.values[4], /did not match its master \(PRICE_CHANGED\); accepted as billed/);
  assert.equal(audit.values[5], OWNER_ID, "the sync user, from the session context");
});

test("sync: lines that do not add up to the combo's price are accepted and audited, not refused", async () => {
  const lines = bowlLines();
  lines[1] = { ...lines[1], selling_rate: 25, rate: 25, discount_amount: 0 };
  const { ack, statements } = await syncBill(lines);
  assert.equal(ack.status, "accepted", ack.message);
  const [audit] = auditRows(statements);
  assert.deepEqual(JSON.parse(audit.values[3]).reasons, ["TOTAL_MISMATCH"]);
});

test("sync: a combo the server has never heard of is accepted and audited as unknown", async () => {
  const { ack, statements } = await syncBill(bowlLines({ combo_id: "combo-404" }));
  assert.equal(ack.status, "accepted", ack.message);
  const [audit] = auditRows(statements);
  assert.equal(audit.values[1], CODES.UNKNOWN_ACCEPTED);
  assert.equal(audit.values[2], "null", "no master to show");
  assert.match(audit.values[4], /is not in this shop's combos; accepted as billed/);
});

test("sync: a custom combo is priced by its offer too, and checked against its own price", async () => {
  const giftMaster = { id: 4, global_id: "combo-4", company_id: 1, name: "Gift Box", kind: "GIFTING", combo_type: "CUSTOM", price: null, extra_charge: "50.00", margin_percent: "60.00", active: true, items: [] };
  // Apple 1 kg (100) + Kiwi 3 (90) at 60% + 50 extra = 354, as the counter worked it out.
  const allocation = combos.allocateFixedComboLines([{ quantity: 1, rate: 100 }, { quantity: 3, rate: 30 }], 354);
  const tag = { combo_line_key: "g1", combo_id: "combo-4", combo_name: "Gift Box", combo_kind: "GIFTING", combo_type: "CUSTOM", combo_qty: 1, combo_price: 354 };
  const lines = [comboLine(11, allocation.lines[0], tag), comboLine(12, allocation.lines[1], tag)];
  const { ack, statements, total } = await syncBill(lines, { client: syncClient({ masters: [giftMaster] }) });
  assert.equal(ack.status, "accepted", ack.message);
  assert.equal(total, 354);
  const stored = saleItemRows(statements);
  assert.ok(stored.every((row) => row.manual_rate_override === false && row.combo_type === "CUSTOM" && row.combo_price === 354));
  assert.deepEqual(auditRows(statements), []);
});

test("sync: payments a paisa off the total are compared in whole paise, never refused for float noise", async () => {
  // 98.59 - 98.58 is 0.010000000000005116 as doubles, which used to read as "more than a paisa" and
  // reject a desktop bill for good (VALIDATION_ERROR). One paisa of tolerance is the rule.
  assert.ok(Math.abs(98.59 - 98.58) > 0.01, "the float trap this guards against");
  const line = [{ product_id: 11, inventory_batch_id: 900, quantity: 1, selling_rate: 100, rate: 100, discount_amount: 1.41 }];
  const onePaisa = await syncBill(line, { payments: [{ mode: "CASH", amount: 98.58 }] });
  assert.equal(onePaisa.total, 98.59);
  assert.equal(onePaisa.ack.status, "accepted", onePaisa.ack.message);
  const twoPaise = await syncBill(line, { payments: [{ mode: "CASH", amount: 98.57 }] });
  assert.equal(twoPaise.ack.status, "rejected", "beyond a paisa is still refused");
  assert.match(twoPaise.ack.message, /Payment amounts must match the invoice total/);
});

test("both payment checks (recorded bill and browser checkout) compare whole paise", () => {
  const exact = "Math.abs(Math.round(paidAmount * 100) - Math.round(totalAmount * 100)) > 1";
  assert.equal(SERVER_SOURCE.split(exact).length - 1, 2, "the recorded-bill and browser checks");
  assert.doesNotMatch(SERVER_SOURCE, /Math\.abs\(paidAmount - totalAmount\)/);
});

test("batch cost recalculation shares the bill discount over loose lines only, as the bill booked it", async () => {
  const { recalculateSalesForBatch } = require("./server");
  const { PGlite } = require("@electric-sql/pglite");
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE sales (
        id INTEGER PRIMARY KEY, invoice_discount_amount NUMERIC(14,2), total_amount NUMERIC(14,2),
        total_cost NUMERIC(14,2), profit NUMERIC(14,2), profit_status TEXT
      );
      CREATE TABLE inventory_batches (id INTEGER PRIMARY KEY, purchase_bill_status TEXT);
      CREATE TABLE sale_items (
        id INTEGER PRIMARY KEY, sale_id INTEGER, amount NUMERIC(14,2), net_amount NUMERIC(14,2),
        cost_amount NUMERIC(14,2), cost_status TEXT, profit NUMERIC(14,2),
        combo_line_key VARCHAR(80), combo_id VARCHAR(80), combo_type VARCHAR(10)
      );
      CREATE TABLE sale_batch_allocations (id SERIAL PRIMARY KEY, sale_item_id INTEGER, inventory_batch_id INTEGER, cost_amount NUMERIC(14,2));
      INSERT INTO inventory_batches VALUES (900, 'BILL_COMPLETED');
      -- Bill 1: combo 300 + 200, apples 1000, 50 slab discount on the apples.
      INSERT INTO sales VALUES (1, 50, 1450, 0, 0, 'PROVISIONAL');
      INSERT INTO sale_items VALUES
        (1, 1, 300, 300, 0, 'PROVISIONAL', 0, 'k1', 'combo-3', 'FIXED'),
        (2, 1, 200, 200, 0, 'PROVISIONAL', 0, 'k1', 'combo-3', 'FIXED'),
        (3, 1, 1000, 1000, 0, 'PROVISIONAL', 0, NULL, NULL, NULL);
      -- Bill 2: a combo only, no loose line. Its lines must still be costed.
      INSERT INTO sales VALUES (2, 0, 500, 0, 0, 'PROVISIONAL');
      INSERT INTO sale_items VALUES (4, 2, 500, 500, 0, 'PROVISIONAL', 0, 'k9', 'combo-3', 'FIXED');
      INSERT INTO sale_batch_allocations (sale_item_id, inventory_batch_id, cost_amount)
        VALUES (1, 900, 100), (2, 900, 50), (3, 900, 600), (4, 900, 150);
    `);
    await recalculateSalesForBatch({ query: (sql, values) => db.query(sql, values) }, 900);
    const profits = (await db.query("SELECT id, profit, cost_status FROM sale_items ORDER BY id")).rows
      .map((row) => [row.id, Number(row.profit), row.cost_status]);
    assert.deepEqual(profits, [
      [1, 200, "FINAL"],
      [2, 150, "FINAL"],
      [3, 350, "FINAL"],
      [4, 350, "FINAL"],
    ], "apples: 1000 - 50 - 600; combo lines: net - cost, no discount share");
    const sale = (await db.query("SELECT profit FROM sales WHERE id = 1")).rows[0];
    assert.equal(Number(sale.profit), 700, "the lines add up to the bill: 200 + 150 + 350");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------------------------
// Browser checkout
// ---------------------------------------------------------------------------------------------

test("checkout: a browser bill with a combo is refused with COMBO_COUNTER_ONLY before anything is written", async () => {
  const statements = [];
  const respond = (text, values = []) => {
    const sql = normalise(text);
    statements.push({ sql, values });
    const scoped = deviceScope(sql);
    if (scoped) return scoped;
    if (/^SELECT u\.id, u\.full_name, u\.username, u\.branch_id, r\.role_name, COALESCE\(rps\.permissions/.test(sql)) {
      return rows([{ id: OWNER_ID, full_name: "Rig", username: "rig", branch_id: 1, role_name: "Owner", permissions: {} }]);
    }
    return rows([]);
  };
  setQueryResponder(respond);
  setConnectionResponder(() => ({ query: async (sql, values) => respond(sql, values), release: () => {} }));
  try {
    for (const tag of [{ combo_line_key: "k1" }, { combo_type: "CUSTOM" }, { combo_id: "combo-3" }]) {
      statements.length = 0;
      const response = await probe(app, "POST", "/api/v3/sales", headers, {
        idempotency_key: `combo-checkout-${Object.keys(tag)[0]}`,
        customer: { account_id: 5 },
        invoice_discount: 0,
        items: [{ product_id: 11, inventory_batch_id: 900, quantity: 1, selling_rate: 100, ...tag }],
        payments: [{ mode: "CASH", amount: 100 }],
      });
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.equal(response.body.code, CODES.COUNTER_ONLY);
      assert.equal(response.body.message, combos.MESSAGES.COUNTER_ONLY);
      assert.deepEqual(writes(statements).filter(({ sql }) => /sales|sale_items|inventory_batches/.test(sql)), []);
    }
    // The browser sends `line_index` on every line, and nothing else of a combo: that is a plain bill.
    const plain = await probe(app, "POST", "/api/v3/sales", headers, {
      idempotency_key: "combo-checkout-line-index-only",
      customer: { account_id: 5 },
      invoice_discount: 0,
      items: [{ product_id: 11, inventory_batch_id: 900, quantity: 1, selling_rate: 100, line_index: 0 }],
      payments: [{ mode: "CASH", amount: 100 }],
    });
    assert.notEqual(plain.body?.code, CODES.COUNTER_ONLY, JSON.stringify(plain.body));
  } finally {
    clearQueryResponder();
    clearConnectionResponder();
  }
});
