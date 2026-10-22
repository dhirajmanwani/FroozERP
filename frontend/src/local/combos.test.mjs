import assert from "node:assert/strict";
import test from "node:test";
import {
  COMBO_EDIT_REFUSAL,
  COMBO_TAB_FOR_KIND,
  allocateComboPrice,
  buildComboPayload,
  cartItemCount,
  defaultComboMargin,
  comboAvailability,
  comboGroupTitle,
  comboGroupTotal,
  comboItemsValue,
  comboLineAmount,
  comboLineFields,
  comboProductsNotOnSale,
  combosForTab,
  comboDraftFrom,
  customComboPrice,
  customComboTag,
  expandFixedCombo,
  fifoLotOrder,
  findComboProduct,
  floorThousandths,
  groupComboLines,
  isFixedComboLine,
  newComboDraft,
  normaliseCombo,
  readCombos,
  resolveComboAvailability,
  repriceCustomCombo,
  saleHasCombos,
  suggestComboPrice,
  validateComboCart,
  validateComboDraft,
} from "./combos.js";

const paise = (value) => Math.round(value * 100);

// ---------------------------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------------------------

const assertExact = (lines, total) => {
  const allocated = allocateComboPrice(lines, total);
  assert.equal(allocated.ok, true, allocated.message);
  let sum = 0;
  allocated.lines.forEach((line, index) => {
    const qty = Math.round(lines[index].quantity * 1000);
    const amount = Math.floor((qty * paise(line.selling_rate) * 2 + 1000) / 2000);
    assert.equal(paise(line.amount), amount, "amount is qty × rate rounded to the paisa");
    assert.ok(paise(line.discount_amount) >= 0, "never a negative discount");
    assert.ok(paise(line.discount_amount) < Math.max(1, qty / 1000) + 1, "the residual is below a paisa a unit");
    assert.equal(paise(line.amount) - paise(line.discount_amount), paise(line.net));
    sum += paise(line.net);
  });
  assert.equal(sum, paise(total), "the lines add up to the combo price exactly");
  return allocated;
};

test("a combo's price is spread over its lines and adds up to the paisa", () => {
  assertExact([{ quantity: 0.5, rate: 120 }, { quantity: 0.25, rate: 80 }], 99);
  // Whole pieces: only multiples of 3 paise are reachable at qty 3, so the residual takes the rest.
  const allocated = assertExact([{ quantity: 3, rate: 10 }, { quantity: 2, rate: 15 }], 100);
  assert.deepEqual(allocated.lines.map((line) => line.net), [50, 50]);
  assert.equal(allocated.lines[0].selling_rate, 16.67);
  assert.equal(allocated.lines[0].discount_amount, 0.01);
});

test("the share is in proportion to value at the sale rate, the remainder on the last line", () => {
  const allocated = assertExact([{ quantity: 1, rate: 100 }, { quantity: 1, rate: 50 }, { quantity: 1, rate: 50 }], 100);
  assert.deepEqual(allocated.lines.map((line) => line.net), [50, 25, 25]);
  const odd = assertExact([{ quantity: 1, rate: 1 }, { quantity: 1, rate: 1 }, { quantity: 1, rate: 1 }], 1);
  assert.deepEqual(odd.lines.map((line) => line.net), [0.33, 0.33, 0.34]);
});

test("with no sale rates at all, quantity is the weight", () => {
  const allocated = assertExact([{ quantity: 1, rate: 0 }, { quantity: 3, rate: 0 }], 40);
  assert.deepEqual(allocated.lines.map((line) => line.net), [10, 30]);
});

test("random combos always add up exactly (property)", () => {
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let run = 0; run < 500; run += 1) {
    const count = 1 + Math.floor(random() * 5);
    const lines = Array.from({ length: count }, () => ({
      quantity: Math.max(0.001, Math.round(random() * 5000) / 1000),
      rate: Math.round(random() * 40000) / 100,
    }));
    assertExact(lines, Math.round(random() * 100000) / 100);
  }
});

test("allocation refuses what it cannot bill, by name", () => {
  assert.equal(allocateComboPrice([], 10).code, "COMBO_NO_LINES");
  assert.equal(allocateComboPrice([{ quantity: 0, rate: 1 }], 10).code, "COMBO_QUANTITY_INVALID");
  assert.equal(allocateComboPrice([{ quantity: 1, rate: 1 }], null).code, "COMBO_PRICE_INVALID");
});

// ---------------------------------------------------------------------------------------------
// The master
// ---------------------------------------------------------------------------------------------

test("a snapshot with no combos key is 'missing', not an empty list", () => {
  assert.deepEqual(readCombos({}), { status: "missing", combos: [] });
  assert.equal(readCombos({ combos: "x" }).status, "invalid");
  const ready = readCombos({ combos: [{ global_id: "combo-1", name: " Juice ", kind: "juice", combo_type: "fixed", price: "60.00", items: [{ product_global_id: "product-4", quantity: "0.5", sort_order: 1 }, { product_global_id: "product-9", quantity: "1", sort_order: 0 }] }] });
  assert.equal(ready.status, "ready");
  assert.equal(ready.combos[0].name, "Juice");
  assert.equal(ready.combos[0].kind, "JUICE");
  assert.equal(ready.combos[0].price, 60);
  assert.deepEqual(ready.combos[0].items.map((item) => item.product_global_id), ["product-9", "product-4"]);
  assert.equal(readCombos([{ id: 12, name: "A" }]).combos[0].global_id, "combo-12");
});

test("the form refuses what the server refuses, with the same codes", () => {
  const codes = (draft, options) => validateComboDraft(draft, options).errors.map((error) => error.code);
  assert.deepEqual(codes({ kind: "JUICE", combo_type: "FIXED", price: "50", items: [{ product_id: "4", quantity: "1" }] }), ["COMBO_NAME_REQUIRED"]);
  assert.ok(codes({ name: "A", kind: "SOUP", combo_type: "FIXED", price: "1", items: [{ product_id: "4", quantity: "1" }] }).includes("COMBO_KIND_INVALID"));
  assert.ok(codes({ name: "A", kind: "JUICE", combo_type: "X" }).includes("COMBO_TYPE_INVALID"));
  assert.ok(codes({ name: "A", kind: "JUICE", combo_type: "FIXED", price: "0", items: [{ product_id: "4", quantity: "1" }] }).includes("COMBO_PRICE_INVALID"));
  assert.ok(codes({ name: "A", kind: "JUICE", combo_type: "FIXED", price: "10.555", items: [{ product_id: "4", quantity: "1" }] }).includes("COMBO_PRICE_INVALID"));
  assert.ok(codes({ name: "A", kind: "JUICE", combo_type: "FIXED", price: "10", items: [] }).includes("COMBO_ITEMS_REQUIRED"));
  assert.ok(codes({ name: "A", kind: "JUICE", combo_type: "FIXED", price: "10", items: [{ product_id: "4", quantity: "0" }] }).includes("COMBO_ITEM_INVALID"));
  assert.ok(codes({ name: "A", kind: "JUICE", combo_type: "FIXED", price: "10", items: [{ product_id: "4", quantity: "1.0001" }] }).includes("COMBO_ITEM_INVALID"));
  assert.ok(codes({ name: "A", kind: "JUICE", combo_type: "FIXED", price: "10", items: [{ product_id: "4", quantity: "1" }, { product_id: "4", quantity: "2" }] }).includes("COMBO_ITEM_INVALID"));
  // "004" and 4 are different products: not a duplicate.
  assert.deepEqual(codes({ name: "A", kind: "JUICE", combo_type: "FIXED", price: "10", items: [{ product_id: "004", quantity: "1" }, { product_id: "4", quantity: "1" }] }), []);
  assert.ok(codes({ name: "A", kind: "GIFTING", combo_type: "CUSTOM", price: "10" }).includes("COMBO_PRICE_INVALID"));
  assert.ok(codes({ name: "A", kind: "GIFTING", combo_type: "CUSTOM", extra_charge: "-1" }).includes("COMBO_CHARGE_INVALID"));
  assert.ok(codes({ name: "A", kind: "GIFTING", combo_type: "CUSTOM", extra_charge: "1.005" }).includes("COMBO_CHARGE_INVALID"));
  assert.deepEqual(codes({ name: "A", kind: "GIFTING", combo_type: "CUSTOM", extra_charge: "30" }), []);
  assert.deepEqual(codes({ name: "A", kind: "GIFTING", combo_type: "CUSTOM", extra_charge: "" }), []);
  assert.ok(codes({ name: "A", kind: "JUICE", combo_type: "FIXED", price: "10", extra_charge: "5", items: [{ product_id: "4", quantity: "1" }] }).includes("COMBO_CHARGE_INVALID"));
});

test("the payload carries no identity and no price or items on a customer's-choice combo", () => {
  const fixed = buildComboPayload({ name: " Juice ", kind: "juice", combo_type: "FIXED", price: "60", extra_charge: "3", items: [{ product_id: "004", quantity: "0.5" }] });
  assert.deepEqual(fixed, {
    name: "Juice", kind: "JUICE", combo_type: "FIXED", price: 60, extra_charge: 0, margin_percent: null, description: "", active: true, sort_order: 0,
    items: [{ product_id: "004", quantity: 0.5, sort_order: 0 }],
  });
  const custom = buildComboPayload({ name: "Basket", kind: "GIFTING", combo_type: "CUSTOM", price: "60", extra_charge: "30", items: [{ product_id: "4", quantity: "1" }] });
  assert.equal(custom.price, null);
  assert.equal(custom.extra_charge, 30);
  assert.ok(!("charge_type_id" in custom));
  assert.deepEqual(custom.items, []);
  assert.ok(!("created_by" in fixed) && !("updated_by" in fixed));
});

test("items at today's rates are only summed when every item has a rate", () => {
  const products = [{ id: "product-1", product_name: "Orange", selling_rate: "80" }, { id: "product-2", product_name: "Mint", selling_rate: 0 }];
  assert.deepEqual(comboItemsValue([{ product_global_id: "product-1", quantity: 0.5 }], products), { known: true, value: 40 });
  assert.deepEqual(comboItemsValue([{ product_global_id: "product-1", quantity: 0.5 }, { product_global_id: "product-2", quantity: 1 }], products), { known: false, value: null });
});

test("a product is found by either of its ids, never by Number()", () => {
  const products = [{ id: "product-4", global_id: "product-4", product_name: "A" }, { id: "004", product_name: "B" }];
  assert.equal(findComboProduct(products, { product_global_id: "product-4", product_id: "4" }).product_name, "A");
  assert.equal(findComboProduct(products, { product_id: "004" }).product_name, "B");
  assert.equal(findComboProduct(products, { product_id: "4" }), null);
  assert.deepEqual(comboProductsNotOnSale({ items: [{ product_id: "4", product_name: "Kiwi" }] }, products), ["Kiwi"]);
});

// ---------------------------------------------------------------------------------------------
// The shelf
// ---------------------------------------------------------------------------------------------

const products = [
  { id: "product-1", product_name: "Orange", unit: "KG", selling_rate: 80 },
  { id: "product-2", product_name: "Pomegranate", unit: "KG", selling_rate: 200 },
  { id: "product-3", product_name: "Kiwi", unit: "PCS", selling_rate: 30, active: false },
];
const lots = [
  { id: "11", product_id: "product-1", lot_name: "OR-B", purchase_date: "2026-10-20", remaining_qty: 5, sale_rate: 90, unit: "KG" },
  { id: "10", product_id: "product-1", lot_name: "OR-A", purchase_date: "2026-10-19", remaining_qty: 0.4, sale_rate: 80, unit: "KG" },
  { id: "20", product_id: "product-2", lot_name: "PG", purchase_date: "2026-10-18", remaining_qty: 2, sale_rate: 200, unit: "KG" },
  { id: "30", product_id: "product-2", lot_name: "PG-BOX", purchase_date: "2026-10-01", remaining_qty: 9, sale_rate: 200, unit: "BOX" },
];
const juice = normaliseCombo({
  global_id: "combo-7", name: "Mixed Juice", kind: "JUICE", combo_type: "FIXED", price: 99,
  items: [{ product_global_id: "product-1", quantity: 0.5 }, { product_global_id: "product-2", quantity: 0.25 }],
});

test("the oldest lot goes first, and a component may be split across lots", () => {
  let next = 0;
  const result = expandFixedCombo({ combo: juice, comboQty: 2, products, lots, cart: [], comboLineKey: "K1", newLineId: () => `L${next += 1}` });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.lines.map((line) => [line.inventory_batch_id, line.quantity]), [["10", 0.4], ["11", 0.6], ["20", 0.5]]);
  const sum = result.lines.reduce((total, line) => total + paise(line.quantity * line.selling_rate) - paise(line.discount_amount), 0);
  assert.equal(sum, paise(198));
  for (const line of result.lines) {
    assert.equal(line.combo_line_key, "K1");
    assert.equal(line.combo_id, "combo-7");
    assert.equal(line.combo_type, "FIXED");
    assert.equal(line.combo_qty, 2);
    assert.equal(line.combo_price, 99);
    assert.equal(line.keep_price, true);
    assert.equal(line.lot_discount_id, null);
  }
  // A lot in another unit (BOX) never makes up a quantity written in KG.
  assert.ok(!result.lines.some((line) => line.inventory_batch_id === "30"));
});

test("what the cart already holds and what orders have promised is not free", () => {
  const cart = [{ product_id: "product-2", inventory_batch_id: "20", quantity: 1.8 }];
  const short = comboAvailability({ combo: juice, products, lots, cart });
  assert.deepEqual(short, { ok: false, code: "COMBO_NOT_ENOUGH", message: "Not enough Pomegranate" });
  const promised = comboAvailability({ combo: juice, products, lots, cart: [], reservedFor: (id) => (id === "product-1" ? 5.1 : 0) });
  assert.equal(promised.message, "Not enough Orange");
  assert.equal(comboAvailability({ combo: juice, products, lots, cart: [] }).ok, true);
});

test("a switched-off product makes the combo unavailable, by name", () => {
  const kiwi = normaliseCombo({ global_id: "combo-8", name: "Kiwi cup", kind: "THE_CUTTING", combo_type: "FIXED", price: 40, items: [{ product_global_id: "product-3", quantity: 2 }] });
  assert.deepEqual(comboAvailability({ combo: kiwi, products, lots }), { ok: false, code: "COMBO_PRODUCT_NOT_ON_SALE", message: "Kiwi is not on sale." });
  assert.equal(expandFixedCombo({ combo: juice, comboQty: 1.5, products, lots }).code, "COMBO_QTY_INVALID");
  assert.equal(expandFixedCombo({ combo: juice, comboQty: 0, products, lots }).code, "COMBO_QTY_INVALID");
});

test("another shop's lots are not on this counter's shelf", () => {
  const scope = { known: true, companyId: "", branchId: "2", operationalLocationId: "" };
  const own = lots.map((lot) => ({ ...lot, branch_id: "2" }));
  const foreign = lots.map((lot) => ({ ...lot, branch_id: "1" }));
  assert.equal(comboAvailability({ combo: juice, products, lots: own, scope }).ok, true);
  assert.equal(comboAvailability({ combo: juice, products, lots: foreign, scope }).message, "Not enough Orange");
  // A counter that does not know its shop sells nothing, combos included.
  assert.equal(comboAvailability({ combo: juice, products, lots: own, scope: { known: false } }).ok, false);
});

test("lots are ordered by date, then name, then id as text", () => {
  const sorted = [{ id: "10", lot_name: "A" }, { id: "9", lot_name: "A" }, { id: "1", lot_name: "B", purchase_date: "2026-01-01" }].sort(fifoLotOrder);
  assert.deepEqual(sorted.map((lot) => lot.id), ["1", "9", "10"]);
});

// ---------------------------------------------------------------------------------------------
// Lines, groups, payloads
// ---------------------------------------------------------------------------------------------

test("every payload line carries the same eight fields, combo or not", () => {
  const loose = comboLineFields({ product_id: "1" }, 0);
  assert.deepEqual(loose, { combo_line_key: null, combo_id: null, combo_name: null, combo_kind: null, combo_type: null, combo_qty: null, combo_price: null, line_index: 0 });
  const fixed = comboLineFields({ combo_line_key: "K", combo_id: "combo-7", combo_name: "Mixed Juice", combo_kind: "juice", combo_type: "fixed", combo_qty: "2", combo_price: "99" }, 3);
  assert.deepEqual(fixed, { combo_line_key: "K", combo_id: "combo-7", combo_name: "Mixed Juice", combo_kind: "JUICE", combo_type: "FIXED", combo_qty: 2, combo_price: 99, line_index: 3 });
  const custom = comboLineFields({ ...customComboTag({ global_id: "combo-9", name: "Basket", kind: "GIFTING" }, "C"), combo_price: 230, line_index: 5 });
  assert.equal(custom.combo_type, "CUSTOM");
  assert.equal(custom.combo_price, 230);
  assert.equal(custom.line_index, 5);
  assert.ok(!("combo_extra_charge" in custom), "cart-only fields never leave the cart");
  assert.equal(Object.keys(fixed).length, 8);
});

test("a combo's lines are gathered where its first line stands", () => {
  const lines = [
    { id: "a", combo_line_key: "K", combo_name: "Juice", combo_type: "FIXED", combo_qty: 2, combo_price: 50, quantity: 1, selling_rate: 60, discount_amount: 0 },
    { id: "b" },
    { id: "c", combo_line_key: "K", combo_name: "Juice", combo_type: "FIXED", combo_qty: 2, combo_price: 50, quantity: 1, selling_rate: 40, discount_amount: 0 },
  ];
  const groups = groupComboLines(lines);
  assert.deepEqual(groups.map((group) => group.kind), ["combo", "line"]);
  assert.deepEqual(groups[0].lines.map((line) => line.id), ["a", "c"]);
  assert.equal(comboGroupTitle(groups[0]), "Juice × 2");
  assert.equal(comboGroupTotal(groups[0]), 100);
  assert.deepEqual(validateComboCart(lines), []);
  assert.equal(validateComboCart([{ ...lines[0], selling_rate: 61 }, lines[2]]).length, 1);
  assert.equal(isFixedComboLine(lines[0]), true);
  assert.equal(isFixedComboLine(lines[1]), false);
});

test("a bill with any combo line cannot be edited", () => {
  assert.equal(saleHasCombos({ items: [{}, { combo_line_key: "K" }] }), true);
  assert.equal(saleHasCombos({ items: [{ combo_line_key: "" }] }), false);
  assert.match(COMBO_EDIT_REFUSAL, /Cancel the bill and bill it again/);
});

test("each kind is sold from its tab, and products never sit on the combos tab", () => {
  assert.deepEqual(COMBO_TAB_FOR_KIND, { JUICE: "bar", THE_CUTTING: "bar", GIFTING: "moments", COMBO_OFFER: "combos" });
  const combos = [
    normaliseCombo({ global_id: "c2", name: "B", kind: "JUICE", sort_order: 2 }),
    normaliseCombo({ global_id: "c1", name: "A", kind: "THE_CUTTING", sort_order: 2 }),
    normaliseCombo({ global_id: "c0", name: "Z", kind: "JUICE", sort_order: 1 }),
    normaliseCombo({ global_id: "c3", name: "Off", kind: "JUICE", active: false }),
  ];
  assert.deepEqual(combosForTab(combos, "bar").map((combo) => combo.global_id), ["c0", "c1", "c2"]);
  assert.deepEqual(combosForTab(combos, "retail"), []);
});

test("a customer's-choice combo is priced as its items at sale rates plus its extra charge, never typed", () => {
  const tag = customComboTag({ global_id: "combo-9", name: "Fruit Basket", kind: "GIFTING", extra_charge: 30 }, "C");
  assert.equal(tag.keep_price, true);
  assert.equal(tag.lot_discount_id, null);
  const cart = [
    { line_id: "x", product_id: "p0", quantity: 1, selling_rate: 50, discount_amount: 0 },
    { line_id: "a", ...tag, quantity: 1.5, combo_base_rate: 120, default_selling_rate: 120, selling_rate: 120, discount_amount: 0 },
    { line_id: "b", ...tag, quantity: 3, combo_base_rate: 10, default_selling_rate: 10, selling_rate: 10, discount_amount: 0 },
  ];
  const priced = repriceCustomCombo(cart, "C");
  assert.equal(priced[0], cart[0], "a loose line is untouched");
  assert.ok(priced.slice(1).every((line) => line.combo_price === 240 && line.combo_qty === 1), "180 + 30 + 30 = 240");
  const net = priced.slice(1).reduce((sum, line) => sum + Math.round(line.quantity * line.selling_rate * 100) - Math.round(line.discount_amount * 100), 0);
  assert.equal(net, 24000);
  assert.deepEqual(validateComboCart(priced), []);
  // A quantity being typed (blank) leaves the combo without a price, refused by name at checkout.
  const typing = repriceCustomCombo(priced.map((line) => (line.line_id === "b" ? { ...line, quantity: "" } : line)), "C");
  assert.equal(typing[1].combo_price, null);
  assert.match(validateComboCart(typing)[0], /Fruit Basket: enter a quantity above 0/);
  assert.equal(repriceCustomCombo(cart, "missing"), cart);
});

test("the suggested price is the items' cost today × the target margin, or nothing", () => {
  const items = [{ product_global_id: "product-1", product_id: "1", quantity: 0.5 }, { product_global_id: "product-2", product_id: "2", quantity: 0.25 }];
  const rates = [
    { product_id: 1, latest_effective_cost: "60.00" },
    { product_id: 1, latest_effective_cost: "64.00" },
    { product_id: 2, latest_effective_cost: "120" },
  ];
  // 0.5 × 64 + 0.25 × 120 = 62; × 1.25 = 77.5 → nearest rupee 78.
  assert.deepEqual(suggestComboPrice({ items, rates, targetMargin: 25, roundingRule: "NEAREST_RUPEE" }), { cost: 62, suggested: 78, margin: 25 });
  assert.deepEqual(suggestComboPrice({ items, rates: rates.slice(0, 2), targetMargin: 25 }), { cost: null, suggested: null, margin: 25 });
  assert.deepEqual(suggestComboPrice({ items: [], rates, targetMargin: 25 }), { cost: null, suggested: null, margin: 25 });
  // The combo's own margin wins over the Sale Rate desired margin: 62 × 1.4 = 86.8 → 87; ROUND_UP_10 → 90.
  assert.deepEqual(suggestComboPrice({ items, rates, marginPercent: 40, targetMargin: 25 }), { cost: 62, suggested: 87, margin: 40 });
  assert.equal(suggestComboPrice({ items, rates, marginPercent: "40", targetMargin: 25, roundingRule: "ROUND_UP_10" }).suggested, 90);
  // 0 is a real margin (sell at cost); blank or null falls back to the desired margin.
  assert.equal(suggestComboPrice({ items, rates, marginPercent: 0, targetMargin: 25 }).suggested, 62);
  assert.equal(suggestComboPrice({ items, rates, marginPercent: "", targetMargin: 25 }).margin, 25);
  assert.equal(suggestComboPrice({ items, rates, marginPercent: null, targetMargin: 25 }).margin, 25);
});

test("a new combo's margin starts by kind; a typed margin is checked and carried", () => {
  assert.equal(defaultComboMargin("GIFTING", 25), 40);
  assert.equal(defaultComboMargin("juice", 25), 30);
  assert.equal(defaultComboMargin("THE_CUTTING", 25), 30);
  assert.equal(defaultComboMargin("COMBO_OFFER", 22), 22);
  assert.equal(defaultComboMargin("COMBO_OFFER", 0), 0);
  const base = { name: "Box", kind: "GIFTING", combo_type: "CUSTOM", extra_charge: "0" };
  assert.equal(validateComboDraft({ ...base, margin_percent: "" }).ok, true);
  assert.equal(validateComboDraft({ ...base, margin_percent: "60" }).ok, true);
  assert.equal(validateComboDraft({ ...base, margin_percent: "0" }).ok, true);
  for (const bad of ["-1", "1000.01", "12.345", "abc"]) {
    assert.equal(validateComboDraft({ ...base, margin_percent: bad }).first?.code, "COMBO_MARGIN_INVALID", bad);
  }
  assert.equal(buildComboPayload({ ...base, margin_percent: "60" }).margin_percent, 60);
  assert.equal(buildComboPayload({ ...base, margin_percent: "" }).margin_percent, null);
  assert.equal(buildComboPayload({ ...base, margin_percent: 0 }).margin_percent, 0);
  assert.equal(normaliseCombo({ global_id: "c", margin_percent: "40.00" }).margin_percent, 40);
  assert.equal(normaliseCombo({ global_id: "c" }).margin_percent, null);
});

test("a customer's-choice combo with a margin is priced once, rounded, and still adds up", () => {
  assert.equal(customComboPrice({ itemsValue: 210, marginPercent: 0, extraCharge: 30 }), 240);
  assert.equal(customComboPrice({ itemsValue: 210, marginPercent: 10, extraCharge: 30 }), 261);
  assert.equal(customComboPrice({ itemsValue: 210, marginPercent: 10, extraCharge: 30, roundingRule: "ROUND_UP_10" }), 270);
  assert.equal(customComboPrice({ itemsValue: 99.99, marginPercent: 12.5, roundingRule: "NO_ROUND" }), 112.49);
  assert.equal(customComboPrice({ itemsValue: null }), null);
  const tag = customComboTag({ global_id: "combo-9", name: "Fruit Basket", kind: "GIFTING", extra_charge: 30, margin_percent: 10 }, "C", { roundingRule: "ROUND_UP_10" });
  assert.equal(tag.combo_margin_percent, 10);
  assert.equal(tag.combo_rounding_rule, "ROUND_UP_10");
  const priced = repriceCustomCombo([
    { line_id: "a", ...tag, quantity: 1.5, combo_base_rate: 120, default_selling_rate: 120, selling_rate: 120, discount_amount: 0 },
    { line_id: "b", ...tag, quantity: 3, combo_base_rate: 10, default_selling_rate: 10, selling_rate: 10, discount_amount: 0 },
  ], "C");
  // (180 + 30) × 1.1 + 30 = 261 → ROUND_UP_10 → 270.
  assert.ok(priced.every((line) => line.combo_price === 270));
  const net = priced.reduce((sum, line) => sum + Math.round(line.quantity * line.selling_rate * 100) - Math.round(line.discount_amount * 100), 0);
  assert.equal(net, 27000);
  assert.ok(priced.every((line) => line.discount_amount >= 0));
  assert.deepEqual(validateComboCart(priced), []);
  assert.deepEqual(Object.keys(comboLineFields(priced[0], 0)).sort(), ["combo_id", "combo_kind", "combo_line_key", "combo_name", "combo_price", "combo_qty", "combo_type", "line_index"]);
});

test("the form round-trips a combo, and a new one starts with its kind's margin", () => {
  const fresh = newComboDraft({ kind: "GIFTING", desiredMargin: 25 });
  assert.equal(fresh.margin_percent, "40");
  assert.equal(fresh.combo_type, "FIXED");
  assert.equal(newComboDraft({ desiredMargin: "22" }).margin_percent, "22");
  const draft = comboDraftFrom({
    id: 12, global_id: "combo-12", name: "Cutting cup", kind: "THE_CUTTING", combo_type: "FIXED", price: "60.00", extra_charge: "0", margin_percent: null,
    items: [{ product_id: 4, product_global_id: "product-4", product_name: "Kiwi", unit: "PCS", quantity: "2.000", sort_order: 0 }],
  });
  assert.equal(draft.ref, "combo-12");
  assert.equal(draft.price, "60");
  assert.equal(draft.margin_percent, "");
  assert.deepEqual(draft.items, [{ product_id: "4", product_name: "Kiwi", unit: "PCS", quantity: "2" }]);
  const payload = buildComboPayload(draft);
  assert.equal(payload.price, 60);
  assert.equal(payload.margin_percent, null);
  assert.deepEqual(payload.items, [{ product_id: "4", quantity: 2, sort_order: 0 }]);
  assert.equal(validateComboDraft(draft, { products: [{ id: 4, product_name: "Kiwi" }] }).ok, true);
});

test("a product the server marks as off sale makes the combo unavailable by name", () => {
  const combo = normaliseCombo({ global_id: "c", items: [{ product_id: 4, product_name: "Kiwi", product_active: false, quantity: 1 }] });
  assert.deepEqual(comboProductsNotOnSale(combo, [{ id: 4, product_name: "Kiwi", active: true }]), ["Kiwi"]);
  const live = normaliseCombo({ global_id: "c", items: [{ product_id: 4, product_name: "Kiwi", quantity: 1 }] });
  assert.deepEqual(comboProductsNotOnSale(live, [{ id: 4, product_name: "Kiwi", active: true }]), []);
});

test("the Combos screen says why it cannot reach the server instead of trying", () => {
  assert.equal(resolveComboAvailability({}), null);
  assert.match(resolveComboAvailability({ localOnly: true, offline: true }), /Local Only mode/);
  assert.match(resolveComboAvailability({ noCloud: true }), /not connected to a cloud server/);
  assert.match(resolveComboAvailability({ offline: true }), /offline/);
});

test("a combo line's amount is half up on the exact quantity × rate, as the server bills it", () => {
  // Each of these is an exact half paisa that the float product reads as just under it.
  assert.equal(0.7 * 140.85 < 98.595, true, "the float product is below the half");
  assert.equal(comboLineAmount(0.7, 140.85), 98.6);
  assert.equal(comboLineAmount(1.5, 30.45), 45.68);
  assert.equal(comboLineAmount(1.7, 39.25), 66.73);
  assert.equal(comboLineAmount(1.5, 416.03), 624.05);
  assert.equal(comboLineAmount("2", "10"), 20);
  // Every allocated line's amount is exactly what the allocation said it was.
  const allocated = allocateComboPrice([{ quantity: 0.8, rate: 40 }, { quantity: 3, rate: 90 }], 698);
  for (const line of allocated.lines) assert.equal(comboLineAmount(line.quantity, line.selling_rate), line.amount);
});

test("the desktop snapshot's combo id is not prefixed twice", () => {
  // read_combos in local_db.rs: `id` is already the global id, `cloud_id` the server's number.
  const read = readCombos({ combos: [{ id: "combo-12", cloud_id: "12", name: "Cutting cup", kind: "THE_CUTTING", combo_type: "FIXED", price: 60, active: true, sort_order: 0, items: [] }] });
  assert.equal(read.combos[0].global_id, "combo-12");
  assert.equal(normaliseCombo({ id: "12" }).global_id, "combo-12");
  assert.equal(normaliseCombo({ id: "COMBO-5" }).global_id, "COMBO-5");
  assert.equal(normaliseCombo({ id: "12", global_id: "combo-99" }).global_id, "combo-99");
  const tagged = customComboTag(read.combos[0], "K");
  assert.equal(tagged.combo_id, "combo-12");
  assert.equal(comboLineFields({ ...tagged, combo_price: 60 }, 0).combo_id, "combo-12");
});

test("a lot worn below its 3-dp balance is never asked for more than it holds", () => {
  assert.equal(floorThousandths(4.3 - 0.7), 3599);
  assert.equal(floorThousandths(3.6), 3600);
  assert.equal(floorThousandths(4.3), 4300);
  assert.equal(floorThousandths(0), 0);
  assert.equal(floorThousandths(null), 0);
  const worn = [
    { id: "a", product_id: "product-1", lot_name: "A", purchase_date: "2026-10-19", remaining_qty: 4.3 - 0.7, sale_rate: 80, unit: "KG" },
    { id: "b", product_id: "product-1", lot_name: "B", purchase_date: "2026-10-20", remaining_qty: 2, sale_rate: 80, unit: "KG" },
  ];
  const combo = normaliseCombo({ global_id: "combo-1", name: "Big orange", kind: "COMBO_OFFER", combo_type: "FIXED", price: 300, items: [{ product_global_id: "product-1", quantity: 4 }] });
  const result = expandFixedCombo({ combo, comboQty: 1, products, lots: worn, cart: [], comboLineKey: "K", newLineId: () => "L" });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.lines.map((line) => [line.inventory_batch_id, line.quantity]), [["a", 3.599], ["b", 0.401]]);
  assert.ok(result.lines[0].quantity <= worn[0].remaining_qty);
});

test("the cart badge counts each combo once and each loose line once", () => {
  const cart = [
    { line_id: "a", quantity: 2.5 },
    { line_id: "b", quantity: 1, combo_line_key: "K1", combo_type: "FIXED" },
    { line_id: "c", quantity: 0.5, combo_line_key: "K1", combo_type: "FIXED" },
    { line_id: "d", quantity: 3 },
    { line_id: "e", quantity: 1, combo_line_key: "K2", combo_type: "CUSTOM" },
  ];
  assert.equal(cartItemCount(cart), 4);
  assert.equal(cartItemCount([]), 0);
});
