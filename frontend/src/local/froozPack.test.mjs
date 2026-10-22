import assert from "node:assert/strict";
import test from "node:test";
import {
  packingEmptyPickerMessage,
  packingTypesWithoutSize,
  PACKING_LOW_STOCK_AT,
  PACKING_SIZE_LABELS,
  PACKING_SIZE_NAMES,
  backPackingDrill,
  buildPackingAdjustmentPayload,
  buildPackingPurchasePayload,
  buildSalePackingUsage,
  createPackingDrill,
  enterPackingDrill,
  findPackingSize,
  packingCostOf,
  packingDrillView,
  packingManageView,
  PACKING_MOVEMENT_LABELS,
  packingPathLabel,
  packingShortageNotifications,
  packingShortages,
  packingSizeLabel,
  packingStockState,
  readPackingCatalogue,
  resolvePackAvailability,
  validatePackingNode,
} from "./froozPack.js";

// The snapshot's shape: `id` is already the global id.
const snapshotPacking = () => ({
  status: "ready",
  types: [
    {
      id: "packing-type-2",
      name: "Bottle",
      active: 1,
      sort_order: 2,
      designs: [
        { id: "packing-design-5", name: "Round", active: 1, sort_order: 0, sizes: [
          { id: "packing-size-20", size_name: "CLASSIC", capacity: "300 ml", unit_cost: 8, active: 1, sort_order: 0, cloud_qty_on_hand: 50, pending_usage: 2, qty_on_hand: 48 },
        ] },
      ],
    },
    {
      id: "packing-type-1",
      name: "Gift Box",
      active: 1,
      sort_order: 1,
      designs: [
        { id: "packing-design-2", name: "Window Box", active: 1, sort_order: 0, sizes: [
          { id: "packing-size-4", size_name: "GRAND", capacity: "1 kg", unit_cost: 45, active: 1, sort_order: 0, qty_on_hand: 3 },
          { id: "packing-size-3", size_name: "PETITE", capacity: "", unit_cost: 20, active: 1, sort_order: 0, qty_on_hand: 0 },
          { id: "packing-size-6", size_name: "ROYAL", capacity: "2 kg", unit_cost: 0, active: 1, sort_order: 0, qty_on_hand: null },
          { id: "packing-size-7", size_name: "CLASSIC", capacity: "", unit_cost: 30, active: 0, sort_order: 0, qty_on_hand: 100 },
        ] },
        // Every size switched off: the design is hidden.
        { id: "packing-design-3", name: "Old Box", active: 1, sort_order: 1, sizes: [
          { id: "packing-size-8", size_name: "GRAND", unit_cost: 40, active: 0, qty_on_hand: 9 },
        ] },
        { id: "packing-design-4", name: "Switched Off", active: 0, sort_order: 2, sizes: [
          { id: "packing-size-10", size_name: "GRAND", unit_cost: 40, active: 1, qty_on_hand: 9 },
        ] },
      ],
    },
    // No active size anywhere under it: hidden.
    { id: "packing-type-3", name: "Bowl", active: 1, sort_order: 3, designs: [] },
    { id: "packing-type-4", name: "Retired", active: 0, sort_order: 0, designs: [
      { id: "packing-design-9", name: "Any", active: 1, sizes: [{ id: "packing-size-30", size_name: "GRAND", active: 1, qty_on_hand: 4 }] },
    ] },
  ],
});

// The API's shape: integer `id` plus `global_id`; NUMERIC as strings.
const apiPacking = () => ({
  types: [{
    id: 1, global_id: "packing-type-1", name: " Gift Box ", active: true, sort_order: 0,
    designs: [{
      id: 2, global_id: "packing-design-2", name: "Window Box", active: true, sort_order: 0,
      sizes: [{ id: 4, global_id: "packing-size-4", size_name: "grand", capacity: "1 kg", unit_cost: "45.00", active: true, sort_order: 0, qty_on_hand: "0.000" }],
    }],
  }],
});

const ready = () => readPackingCatalogue(snapshotPacking());

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

test("the four size names and their labels", () => {
  assert.deepEqual([...PACKING_SIZE_NAMES], ["PETITE", "CLASSIC", "GRAND", "ROYAL"]);
  assert.deepEqual({ ...PACKING_SIZE_LABELS }, { PETITE: "Petite", CLASSIC: "Classic", GRAND: "Grand", ROYAL: "Royal" });
  assert.ok(Object.isFrozen(PACKING_SIZE_NAMES));
  assert.ok(Object.isFrozen(PACKING_SIZE_LABELS));
});

test("a size reads as its label and capacity", () => {
  assert.equal(packingSizeLabel({ size_name: "GRAND", capacity: "1 kg" }), "Grand · 1 kg");
  assert.equal(packingSizeLabel({ size_name: "grand", capacity: "  " }), "Grand");
  assert.equal(packingSizeLabel({ size_name: "ROYAL" }), "Royal");
  assert.equal(packingSizeLabel({ size_name: "Jumbo", capacity: "5 kg" }), "Jumbo · 5 kg", "an unknown name is shown as given");
  assert.equal(packingSizeLabel({ capacity: "300 ml" }), "300 ml");
  assert.equal(packingSizeLabel(null), "");
});

test("a path reads type › design › size, leaving out what is not known", () => {
  assert.equal(packingPathLabel({ type_name: "Gift Box", design_name: "Window Box", size_name: "GRAND", capacity: "1 kg" }), "Gift Box › Window Box › Grand · 1 kg");
  assert.equal(packingPathLabel({ type_name: "Gift Box", design_name: "", size_name: "PETITE" }), "Gift Box › Petite");
  assert.equal(packingPathLabel({}), "");
  assert.equal(packingPathLabel(), "");
});

// ---------------------------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------------------------

test("the snapshot's packing is read, sorted, and keeps unknown counts unknown", () => {
  const catalogue = ready();
  assert.equal(catalogue.status, "ready");
  assert.equal(catalogue.message, "");
  assert.deepEqual(catalogue.types.map((type) => type.id), ["packing-type-4", "packing-type-1", "packing-type-2", "packing-type-3"]);
  const box = catalogue.types[1].designs[0];
  // Sort order ties broken by the size order Petite, Classic, Grand, Royal.
  assert.deepEqual(box.sizes.map((size) => size.size_name), ["PETITE", "CLASSIC", "GRAND", "ROYAL"]);
  const royal = box.sizes.find((size) => size.size_name === "ROYAL");
  assert.equal(royal.qty_on_hand, null, "an unknown count is null, never 0");
  const petite = box.sizes.find((size) => size.size_name === "PETITE");
  assert.equal(petite.qty_on_hand, 0, "a real 0 stays 0");
  const bottle = catalogue.types[2].designs[0].sizes[0];
  assert.equal(bottle.cloud_qty_on_hand, 50);
  assert.equal(bottle.pending_usage, 2);
  assert.equal(bottle.qty_on_hand, 48);
  assert.equal(catalogue.types[0].active, false);
});

test("the API body is read the same way, ids as global ids, numbers from strings", () => {
  const catalogue = readPackingCatalogue(apiPacking());
  assert.equal(catalogue.status, "ready");
  const [type] = catalogue.types;
  assert.equal(type.id, "packing-type-1");
  assert.equal(type.server_id, "1");
  assert.equal(type.name, "Gift Box");
  const size = type.designs[0].sizes[0];
  assert.equal(size.id, "packing-size-4");
  assert.equal(size.size_name, "GRAND");
  assert.equal(size.unit_cost, 45);
  assert.equal(size.qty_on_hand, 0);
});

test("missing is not an empty list, and anything unreadable is invalid with a message", () => {
  for (const source of [undefined, null, { status: "missing" }, { status: "MISSING", types: [] }, {}]) {
    const read = readPackingCatalogue(source);
    assert.equal(read.status, "missing", JSON.stringify(source));
    assert.deepEqual(read.types, []);
    assert.match(read.message, /has not reached this computer/);
  }
  for (const source of [
    { types: "nope" },
    { status: "ready", types: {} },
    { status: "ready" },
    { status: "broken", types: [] },
    "packing",
    42,
    { types: [{ id: "packing-type-1", name: "Box", designs: "x" }] },
    { types: [{ id: "packing-type-1", name: "Box", designs: [{ id: "d", name: "D", sizes: 7 }] }] },
  ]) {
    const read = readPackingCatalogue(source);
    assert.equal(read.status, "invalid", JSON.stringify(source));
    assert.deepEqual(read.types, []);
    assert.ok(read.message.length > 0, "an invalid list must say why");
  }
  // A ready list with nothing in it is a real "none".
  assert.deepEqual(readPackingCatalogue({ status: "ready", types: [] }), { status: "ready", types: [], message: "" });
  // A bare array is read as the types.
  assert.equal(readPackingCatalogue(apiPacking().types).status, "ready");
});

test("a size is found by either id, as text, never by number", () => {
  const catalogue = readPackingCatalogue(apiPacking());
  assert.equal(findPackingSize(catalogue, "packing-size-4").size.size_name, "GRAND");
  assert.equal(findPackingSize(catalogue, "4").size.id, "packing-size-4");
  assert.equal(findPackingSize(catalogue, 4).design.name, "Window Box");
  assert.equal(findPackingSize(catalogue, " packing-size-4 ").type.name, "Gift Box");
  assert.equal(findPackingSize(catalogue, "004"), null, "\"004\" is not 4");
  assert.equal(findPackingSize(catalogue, ""), null);
  assert.equal(findPackingSize(catalogue, null), null);
  assert.equal(findPackingSize(null, "packing-size-4"), null);
  // Inactive sizes are still found: a combo may name one.
  assert.equal(findPackingSize(ready(), "packing-size-7").size.active, false);
  // A raw types array works too.
  assert.equal(findPackingSize(ready().types, "packing-size-20").type.name, "Bottle");
});

// ---------------------------------------------------------------------------------------------
// The drill-down
// ---------------------------------------------------------------------------------------------

test("stock state: out at 0 or less, low at 5 or less, unknown when not known", () => {
  assert.equal(PACKING_LOW_STOCK_AT, 5);
  assert.equal(packingStockState(-2), "out");
  assert.equal(packingStockState(0), "out");
  assert.equal(packingStockState("0.000"), "out");
  assert.equal(packingStockState(0.5), "low");
  assert.equal(packingStockState(5), "low");
  assert.equal(packingStockState(5.001), "ok");
  assert.equal(packingStockState(null), "unknown");
  assert.equal(packingStockState(undefined), "unknown");
  assert.equal(packingStockState(""), "unknown");
  assert.equal(packingStockState("abc"), "unknown");
});

test("the picker starts at types and walks down to sizes and back", () => {
  const catalogue = ready();
  const start = createPackingDrill();
  assert.deepEqual(start, { level: "types", typeId: null, designId: null });
  const designs = enterPackingDrill(start, "packing-type-1", catalogue);
  assert.deepEqual(designs, { level: "designs", typeId: "packing-type-1", designId: null });
  const sizes = enterPackingDrill(designs, "packing-design-2", catalogue);
  assert.deepEqual(sizes, { level: "sizes", typeId: "packing-type-1", designId: "packing-design-2" });
  // Nowhere below sizes.
  assert.deepEqual(enterPackingDrill(sizes, "packing-size-4", catalogue), sizes);
  assert.deepEqual(backPackingDrill(sizes), designs);
  assert.deepEqual(backPackingDrill(designs), start);
  assert.deepEqual(backPackingDrill(start), start);
  assert.deepEqual(backPackingDrill(undefined), start);
});

test("entering an unknown id leaves the state unchanged", () => {
  const catalogue = ready();
  const start = createPackingDrill();
  assert.deepEqual(enterPackingDrill(start, "packing-type-99", catalogue), start);
  assert.deepEqual(enterPackingDrill(start, "", catalogue), start);
  assert.deepEqual(enterPackingDrill(start, null), start);
  // A hidden type (switched off, or no active sizes) is not a row, so it cannot be entered.
  assert.deepEqual(enterPackingDrill(start, "packing-type-4", catalogue), start);
  assert.deepEqual(enterPackingDrill(start, "packing-type-3", catalogue), start);
  const designs = enterPackingDrill(start, "packing-type-1", catalogue);
  // A design of another type, or a hidden one, is not a row here.
  assert.deepEqual(enterPackingDrill(designs, "packing-design-5", catalogue), designs);
  assert.deepEqual(enterPackingDrill(designs, "packing-design-3", catalogue), designs);
  assert.deepEqual(enterPackingDrill(designs, "packing-design-4", catalogue), designs);
  // Entered by the API's numeric id, the state holds the global id.
  const api = readPackingCatalogue(apiPacking());
  assert.deepEqual(enterPackingDrill(start, 1, api), { level: "designs", typeId: "packing-type-1", designId: null });
});

test("the types level shows only active types with an active size, with their state", () => {
  const view = packingDrillView(ready(), createPackingDrill());
  assert.equal(view.level, "types");
  assert.equal(view.title, "Choose packing");
  assert.deepEqual(view.crumbs, [{ level: "types", id: null, label: "Packing" }]);
  assert.deepEqual(view.rows.map((row) => row.label), ["Gift Box", "Bottle"]);
  const box = view.rows[0];
  assert.equal(box.leaf, false);
  assert.equal(box.qty_on_hand, null);
  assert.equal(box.sublabel, "1 design");
  // Petite is out and Grand is low: something under Gift Box needs buying.
  assert.equal(box.stockState, "low");
  assert.equal(view.rows[1].stockState, "ok");
  assert.equal(view.rows[1].sublabel, "1 design");
});

test("the designs level and the sizes level", () => {
  const catalogue = ready();
  const designsState = enterPackingDrill(createPackingDrill(), "packing-type-1", catalogue);
  const designs = packingDrillView(catalogue, designsState);
  assert.equal(designs.level, "designs");
  assert.equal(designs.title, "Gift Box");
  assert.deepEqual(designs.crumbs.map((crumb) => crumb.label), ["Packing", "Gift Box"]);
  assert.deepEqual(designs.rows.map((row) => [row.label, row.sublabel, row.leaf]), [["Window Box", "3 sizes", false]]);

  const sizes = packingDrillView(catalogue, enterPackingDrill(designsState, "packing-design-2", catalogue));
  assert.equal(sizes.level, "sizes");
  assert.equal(sizes.title, "Window Box");
  assert.deepEqual(sizes.crumbs.map((crumb) => crumb.level), ["types", "designs", "sizes"]);
  assert.deepEqual(sizes.rows.map((row) => [row.label, row.qty_on_hand, row.stockState, row.leaf]), [
    ["Petite", 0, "out", true],
    ["Grand · 1 kg", 3, "low", true],
    ["Royal · 2 kg", null, "unknown", true],
  ]);
  const grand = sizes.rows[1];
  assert.equal(grand.sublabel, "₹45.00 each");
  assert.equal(sizes.rows[2].sublabel, "Cost not set");
  assert.deepEqual(
    [grand.packing_size_id, grand.type_name, grand.design_name, grand.size_name, grand.capacity, grand.unit_cost],
    ["packing-size-4", "Gift Box", "Window Box", "GRAND", "1 kg", 45],
  );
});

test("a group whose sizes are all out reads out; an unknown count reads unknown, never out", () => {
  const catalogue = readPackingCatalogue({ types: [
    { id: "t1", name: "A", designs: [{ id: "d1", name: "D", sizes: [{ id: "s1", size_name: "GRAND", qty_on_hand: 0 }, { id: "s2", size_name: "ROYAL", qty_on_hand: -1 }] }] },
    { id: "t2", name: "B", designs: [{ id: "d2", name: "D", sizes: [{ id: "s3", size_name: "GRAND" }, { id: "s4", size_name: "ROYAL", qty_on_hand: 50 }] }] },
  ] });
  const view = packingDrillView(catalogue, createPackingDrill());
  assert.deepEqual(view.rows.map((row) => row.stockState), ["out", "unknown"]);
});

test("a picker left pointing at something no longer shown falls back a level", () => {
  const catalogue = ready();
  assert.equal(packingDrillView(catalogue, { level: "designs", typeId: "packing-type-99", designId: null }).level, "types");
  const stale = packingDrillView(catalogue, { level: "sizes", typeId: "packing-type-1", designId: "packing-design-3" });
  assert.equal(stale.level, "designs");
  assert.equal(stale.title, "Gift Box");
  assert.equal(packingDrillView(catalogue, { level: "nonsense" }).level, "types");
  assert.equal(packingDrillView(catalogue, null).level, "types");
});

test("the picker of a missing catalogue says so rather than showing nothing silently", () => {
  const view = packingDrillView(readPackingCatalogue(undefined), createPackingDrill());
  assert.equal(view.status, "missing");
  assert.match(view.message, /has not reached this computer/);
  assert.deepEqual(view.rows, []);
  assert.deepEqual(packingDrillView(null, null).rows, []);
});

// ---------------------------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------------------------

test("packing cost is Σ quantity × unit cost, the row's own cost first", () => {
  assert.deepEqual(packingCostOf([], null), { known: true, cost: 0 });
  assert.deepEqual(packingCostOf(undefined), { known: true, cost: 0 });
  assert.deepEqual(packingCostOf([{ packing_size_id: "x", quantity: 2, unit_cost: "3.50" }, { packing_size_id: "y", quantity: "1", unit_cost: 45 }]), { known: true, cost: 52 });
  // Rounded once, half up: 0.5 × 0.33 = 0.165 → 0.17. Unit costs are whole paise (0.335 is 0.34).
  assert.deepEqual(packingCostOf([{ packing_size_id: "x", quantity: 0.5, unit_cost: 0.33 }]), { known: true, cost: 0.17 });
  assert.deepEqual(packingCostOf([{ packing_size_id: "x", quantity: 3, unit_cost: 0.335 }]), { known: true, cost: 1.02 });
  const catalogue = ready();
  // The row's cost wins over the catalogue's.
  assert.deepEqual(packingCostOf([{ packing_size_id: "packing-size-4", quantity: 1, unit_cost: 40 }], catalogue), { known: true, cost: 40 });
  assert.deepEqual(packingCostOf([{ packing_size_id: "packing-size-4", quantity: 2 }], catalogue), { known: true, cost: 90 });
  // A `size_id` row (the snapshot's combo packing) is found too.
  assert.deepEqual(packingCostOf([{ size_id: "packing-size-20", quantity: 1 }], catalogue), { known: true, cost: 8 });
});

test("an unknown cost or quantity makes the whole cost unknown, never a part-sum", () => {
  const catalogue = ready();
  const unknown = { known: false, cost: null };
  assert.deepEqual(packingCostOf([{ packing_size_id: "packing-size-4", quantity: 1 }]), unknown, "no row cost and no catalogue");
  assert.deepEqual(packingCostOf([{ packing_size_id: "packing-size-6", quantity: 1 }], catalogue), unknown, "a cost of 0 is unset");
  assert.deepEqual(packingCostOf([{ packing_size_id: "packing-size-99", quantity: 1 }], catalogue), unknown, "not in the catalogue");
  assert.deepEqual(packingCostOf([{ packing_size_id: "packing-size-4", quantity: 0 }], catalogue), unknown);
  assert.deepEqual(packingCostOf([{ packing_size_id: "packing-size-4", quantity: "" }], catalogue), unknown);
  assert.deepEqual(packingCostOf([{ packing_size_id: "packing-size-4", quantity: 1 }, { packing_size_id: "packing-size-6", quantity: 1 }], catalogue), unknown);
});

// ---------------------------------------------------------------------------------------------
// The bill's packing usage
// ---------------------------------------------------------------------------------------------

const giftBasket = {
  id: "combo-7",
  global_id: "combo-7",
  name: "Gift Basket",
  combo_type: "FIXED",
  packing: [
    { packing_size_id: "packing-size-4", quantity: 1, type_name: "Gift Box", design_name: "Window Box", size_name: "GRAND", capacity: "1 kg", unit_cost: 45 },
    { packing_size_id: "packing-size-9", quantity: 0.5, type_name: "Ribbon", design_name: "Satin", size_name: "PETITE", capacity: "", unit_cost: "3.333" },
  ],
};
const juice = { id: "12", global_id: "combo-12", name: "Orange Juice", combo_type: "FIXED", packing: [] };

const fixedLines = (key, comboId, qty, count = 2) => Array.from({ length: count }, (_, index) => ({
  line_id: `${key}-${index}`,
  combo_line_key: key,
  combo_id: comboId,
  combo_name: "Gift Basket",
  combo_type: "FIXED",
  combo_qty: qty,
}));

test("a fixed combo's packing is counted once per combo, times how many were sold", () => {
  const built = buildSalePackingUsage({ lines: fixedLines("k1", "combo-7", 3, 3), combos: [juice, giftBasket], customPacking: {} });
  assert.equal(built.ok, true);
  assert.equal(built.message, "");
  assert.deepEqual(built.usage, [
    { combo_line_key: "k1", combo_id: "combo-7", source: "FIXED", packing_size_id: "packing-size-4", type_name: "Gift Box", design_name: "Window Box", size_name: "GRAND", capacity: "1 kg", quantity: 3, unit_cost: 45 },
    { combo_line_key: "k1", combo_id: "combo-7", source: "FIXED", packing_size_id: "packing-size-9", type_name: "Ribbon", design_name: "Satin", size_name: "PETITE", capacity: "", quantity: 1.5, unit_cost: 3.33 },
  ]);
});

test("a combo is matched by either of its ids; a combo with no packing has no rows", () => {
  const byServerId = buildSalePackingUsage({ lines: fixedLines("k1", "7", 1), combos: [{ ...giftBasket, id: "7" }] });
  assert.equal(byServerId.usage.length, 2);
  assert.deepEqual(buildSalePackingUsage({ lines: fixedLines("k2", "combo-12", 2), combos: [juice, giftBasket] }), { ok: true, usage: [], warnings: [], message: "" });
  // A combo whose packing was never told is the same: nothing to count.
  assert.deepEqual(buildSalePackingUsage({ lines: fixedLines("k2", "combo-12", 2), combos: [{ id: "combo-12", combo_type: "FIXED" }] }).usage, []);
  // "007" is not 7.
  const wrong = buildSalePackingUsage({ lines: fixedLines("k1", "007", 1), combos: [{ ...giftBasket, id: "7", global_id: "combo-7" }] });
  assert.deepEqual(wrong.usage, []);
  assert.equal(wrong.ok, true, "packing never stops a bill");
  assert.match(wrong.message, /not on this computer/);
});

test("a customer's-choice combo counts what the cashier picked, times its quantity", () => {
  const lines = [
    { combo_line_key: "c1", combo_id: "combo-30", combo_type: "CUSTOM", combo_qty: 1, combo_name: "Build a Box" },
    { combo_line_key: "c1", combo_id: "combo-30", combo_type: "CUSTOM", combo_qty: 1 },
    { combo_line_key: "c2", combo_id: "combo-30", combo_type: "CUSTOM", combo_qty: 2 },
    { combo_line_key: "c3", combo_id: "combo-30", combo_type: "CUSTOM", combo_qty: 1 },
    { product_id: "1", quantity: 1 }, // a loose line
  ];
  const customPacking = {
    c1: [
      { packing_size_id: "packing-size-4", quantity: 1, type_name: "Gift Box", design_name: "Window Box", size_name: "grand", capacity: "1 kg", unit_cost: 45 },
      { packing_size_id: "packing-size-4", quantity: "1", type_name: "Gift Box", design_name: "Window Box", size_name: "GRAND", capacity: "1 kg", unit_cost: 45 },
    ],
    c2: [{ packing_size_id: "packing-size-20", quantity: 1.0005, type_name: "Bottle", design_name: "Round", size_name: "CLASSIC", capacity: "300 ml" }],
  };
  const built = buildSalePackingUsage({ lines, combos: [], customPacking });
  assert.equal(built.ok, true);
  assert.deepEqual(built.usage.map((row) => [row.combo_line_key, row.source, row.packing_size_id, row.quantity, row.size_name, row.unit_cost]), [
    ["c1", "CUSTOM", "packing-size-4", 2, "GRAND", 45], // the same size twice is one row
    ["c2", "CUSTOM", "packing-size-20", 2.002, "CLASSIC", null], // 1.001 × 2, at 3 dp
  ]);
});

test("the same size in two combos stays two rows; unreadable rows are left out and named", () => {
  const lines = [...fixedLines("k1", "combo-7", 1), { combo_line_key: "c1", combo_id: "combo-30", combo_type: "CUSTOM", combo_qty: 1, combo_name: "Build a Box" }];
  const built = buildSalePackingUsage({
    lines,
    combos: [giftBasket],
    customPacking: { c1: [{ packing_size_id: "packing-size-4", quantity: 2 }, { packing_size_id: "", quantity: 1 }, { packing_size_id: "packing-size-9", quantity: 0 }] },
  });
  assert.equal(built.ok, true);
  assert.deepEqual(built.usage.map((row) => [row.combo_line_key, row.packing_size_id, row.quantity]), [
    ["k1", "packing-size-4", 1],
    ["k1", "packing-size-9", 0.5],
    ["c1", "packing-size-4", 2],
  ]);
  assert.equal(built.warnings.length, 2);
  assert.match(built.message, /Build a Box: a packing row could not be read/);
});

test("a combo whose quantity cannot be read is refused by name; nothing at all is empty", () => {
  const built = buildSalePackingUsage({ lines: fixedLines("k1", "combo-7", 0), combos: [giftBasket] });
  assert.equal(built.ok, false);
  assert.deepEqual(built.usage, []);
  assert.match(built.message, /Gift Basket/);
  assert.equal(buildSalePackingUsage({ lines: fixedLines("k1", "combo-7", 1.5), combos: [giftBasket] }).ok, false);
  assert.deepEqual(buildSalePackingUsage({}), { ok: true, usage: [], warnings: [], message: "" });
  assert.deepEqual(buildSalePackingUsage(), { ok: true, usage: [], warnings: [], message: "" });
});

// ---------------------------------------------------------------------------------------------
// Shortages: warnings only
// ---------------------------------------------------------------------------------------------

test("a bill that needs more than is on hand raises one warning per size, totalled across the bill", () => {
  const catalogue = ready();
  const usage = [
    { combo_line_key: "k1", packing_size_id: "packing-size-4", quantity: 2 },
    { combo_line_key: "c1", packing_size_id: "packing-size-4", quantity: 2 }, // 4 > 3 on hand
    { combo_line_key: "k1", packing_size_id: "packing-size-20", quantity: 48 }, // exactly what there is
    { combo_line_key: "k1", packing_size_id: "packing-size-3", quantity: 1 }, // 0 on hand
    { combo_line_key: "k1", packing_size_id: "packing-size-6", quantity: 1 }, // count unknown
    { combo_line_key: "k1", packing_size_id: "packing-size-99", quantity: 1 }, // not in the catalogue
  ];
  const shortages = packingShortages({ usage, catalogue });
  assert.deepEqual(shortages, [
    { key: "packing-short:packing-size-4", label: "Gift Box › Window Box › Grand · 1 kg", needed: 4, onHand: 3 },
    { key: "packing-short:packing-size-3", label: "Gift Box › Window Box › Petite", needed: 1, onHand: 0 },
  ]);
  assert.deepEqual(packingShortages({ usage: [], catalogue }), []);
  assert.deepEqual(packingShortages({ usage, catalogue: readPackingCatalogue(undefined) }), [], "an unknown catalogue claims nothing");
  assert.deepEqual(packingShortages(), []);
});

test("a shortage is matched to its size by the API's numeric id too", () => {
  const catalogue = readPackingCatalogue(apiPacking()); // packing-size-4 has 0 on hand
  assert.deepEqual(packingShortages({ usage: [{ packing_size_id: "4", quantity: 1 }, { packing_size_id: "packing-size-4", quantity: 1 }], catalogue }), [
    { key: "packing-short:packing-size-4", label: "Gift Box › Window Box › Grand · 1 kg", needed: 2, onHand: 0 },
  ]);
});

test("the bell row is a warning from Frooz Pack, keyed by size", () => {
  const rows = packingShortageNotifications([{ key: "packing-short:packing-size-4", label: "Gift Box › Window Box › Grand · 1 kg", needed: 4, onHand: 3 }]);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.severity, "warning");
  assert.equal(row.source, "Frooz Pack");
  assert.equal(row.dedupeKey, "packing-short:packing-size-4");
  assert.match(row.title, /Gift Box › Window Box › Grand · 1 kg/);
  assert.match(row.message, /4 needed, 3 on hand/);
  assert.match(row.message, /still goes through/);
  assert.deepEqual(packingShortageNotifications(null), []);
});

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

const purchaseDraft = () => ({
  supplier_name: " Packwell Traders ",
  purchase_date: "2026-10-22",
  payment_mode: "upi",
  reference_number: "INV-9",
  remarks: "",
  lines: [
    { size_id: "packing-size-4", quantity: "100", rate: "42.50" },
    { packing_size_id: "packing-size-9", quantity: "2.5", rate: "3.33" },
    { size_id: "", quantity: "", rate: "" }, // the form's spare row
  ],
});

test("a packing purchase payload is checked and built", () => {
  const built = buildPackingPurchasePayload(purchaseDraft());
  assert.equal(built.ok, true, built.message);
  assert.deepEqual(built.payload, {
    supplier_name: "Packwell Traders",
    payment_mode: "UPI",
    reference_number: "INV-9",
    remarks: "",
    purchase_date: "2026-10-22",
    lines: [
      { size_id: "packing-size-4", quantity: 100, rate: 42.5 },
      { size_id: "packing-size-9", quantity: 2.5, rate: 3.33 },
    ],
  });
  // 100 × 42.50 + 2.5 × 3.33 = 4250 + 8.325 → 8.33 = 4258.33
  assert.equal(built.total, 4258.33);
  // A blank date is left to the server (today).
  assert.equal(Object.hasOwn(buildPackingPurchasePayload({ ...purchaseDraft(), purchase_date: "" }).payload, "purchase_date"), false);
  // A rate of 0 is allowed (free samples).
  assert.equal(buildPackingPurchasePayload({ ...purchaseDraft(), lines: [{ size_id: "s", quantity: 1, rate: 0 }] }).ok, true);
});

test("a packing purchase payload names the first problem", () => {
  const refused = (patch) => {
    const built = buildPackingPurchasePayload({ ...purchaseDraft(), ...patch });
    assert.equal(built.ok, false);
    assert.equal(built.payload, null);
    return built.message;
  };
  assert.match(refused({ payment_mode: "CARD" }), /how it was paid/);
  assert.match(refused({ payment_mode: "" }), /how it was paid/);
  assert.match(refused({ purchase_date: "2026-02-30" }), /real date/);
  assert.match(refused({ purchase_date: "22/10/2026" }), /real date/);
  assert.match(refused({ supplier_name: "x".repeat(161) }), /160/);
  assert.match(refused({ reference_number: "x".repeat(81) }), /80/);
  assert.match(refused({ lines: [] }), /at least one/);
  assert.match(refused({ lines: [{ size_id: "", quantity: "", rate: "" }] }), /at least one/);
  assert.match(refused({ lines: [{ size_id: "", quantity: "1", rate: "1" }] }), /Line 1: choose a packing size/);
  assert.match(refused({ lines: [{ size_id: "s", quantity: "0", rate: "1" }] }), /Line 1: enter a quantity/);
  assert.match(refused({ lines: [{ size_id: "s", quantity: "1.0001", rate: "1" }] }), /Line 1: enter a quantity/);
  assert.match(refused({ lines: [{ size_id: "s", quantity: "1", rate: "-1" }] }), /Line 1: enter a rate/);
  assert.match(refused({ lines: [{ size_id: "s", quantity: "1", rate: "1.001" }] }), /Line 1: enter a rate/);
  assert.match(refused({ lines: [{ size_id: "s", quantity: "1", rate: "" }] }), /Line 1: enter a rate/);
  assert.match(refused({ lines: [{ size_id: "s", quantity: "1", rate: "1" }, { size_id: " s ", quantity: "2", rate: "1" }] }), /Line 2: this size is listed twice/);
  // "004" and "4" are different sizes.
  assert.equal(buildPackingPurchasePayload({ ...purchaseDraft(), lines: [{ size_id: "004", quantity: 1, rate: 1 }, { size_id: "4", quantity: 1, rate: 1 }] }).ok, true);
});

test("an adjustment is a signed, non-zero quantity with a reason", () => {
  assert.deepEqual(buildPackingAdjustmentPayload({ size_id: "packing-size-4", quantity: "-2.5", reason: " Damaged in rain " }), {
    ok: true, payload: { size_id: "packing-size-4", quantity: -2.5, reason: "Damaged in rain" }, message: "",
  });
  assert.equal(buildPackingAdjustmentPayload({ packing_size_id: "packing-size-4", quantity: "+3", reason: "Found a carton" }).payload.quantity, 3);
  assert.match(buildPackingAdjustmentPayload({ size_id: "", quantity: 1, reason: "x" }).message, /Choose the packing size/);
  assert.match(buildPackingAdjustmentPayload({ size_id: "s", quantity: 0, reason: "x" }).message, /not 0/);
  assert.match(buildPackingAdjustmentPayload({ size_id: "s", quantity: "", reason: "x" }).message, /not 0/);
  assert.match(buildPackingAdjustmentPayload({ size_id: "s", quantity: "1.0001", reason: "x" }).message, /3 decimals/);
  assert.match(buildPackingAdjustmentPayload({ size_id: "s", quantity: 1, reason: "  " }).message, /why/);
});

test("a type, design or size form is checked as the server checks it", () => {
  assert.deepEqual(validatePackingNode("type", { name: " Gift Box ", active: true, sort_order: "" }), {
    ok: true, payload: { name: "Gift Box", active: true, sort_order: 0 }, message: "",
  });
  assert.deepEqual(validatePackingNode("design", { type_id: "packing-type-1", name: "Window Box", active: false, sort_order: "2" }), {
    ok: true, payload: { type_id: "packing-type-1", name: "Window Box", active: false, sort_order: 2 }, message: "",
  });
  assert.deepEqual(validatePackingNode("size", { design_id: "packing-design-2", size_name: "grand", capacity: " 1 kg ", unit_cost: "45.50" }), {
    ok: true, payload: { design_id: "packing-design-2", size_name: "GRAND", capacity: "1 kg", active: true, sort_order: 0, unit_cost: 45.5 }, message: "",
  });
  // A blank cost is not sent (the server keeps its own; a purchase sets it).
  assert.equal(Object.hasOwn(validatePackingNode("size", { design_id: "d", size_name: "ROYAL", unit_cost: "" }).payload, "unit_cost"), false);
  assert.equal(validatePackingNode("size", { design_id: "d", size_name: "ROYAL", unit_cost: 0 }).payload.unit_cost, 0);

  const message = (kind, draft) => {
    const checked = validatePackingNode(kind, draft);
    assert.equal(checked.ok, false);
    assert.equal(checked.payload, null);
    return checked.message;
  };
  assert.match(message("box", { name: "x" }), /type, design or size/);
  assert.match(message("type", { name: "  " }), /name/);
  assert.match(message("type", { name: "x".repeat(81) }), /80/);
  assert.match(message("type", { name: "Box", sort_order: "1.5" }), /whole number/);
  assert.match(message("design", { name: "Window" }), /which packing type/);
  assert.match(message("size", { size_name: "GRAND" }), /which design/);
  assert.match(message("size", { design_id: "d", size_name: "JUMBO" }), /Petite, Classic, Grand or Royal/);
  assert.match(message("size", { design_id: "d", size_name: "GRAND", capacity: "x".repeat(41) }), /40/);
  assert.match(message("size", { design_id: "d", size_name: "GRAND", unit_cost: "-1" }), /₹0 or more/);
  assert.match(message("size", { design_id: "d", size_name: "GRAND", unit_cost: "1.234" }), /2 decimals/);
});

// ---------------------------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------------------------

test("Frooz Pack writes need the cloud: Local Only, no cloud and offline each say so", () => {
  assert.match(resolvePackAvailability({ connectivityMode: "LOCAL_ONLY", online: true, isTauri: true }), /Local Only/);
  // Local Only wins even when the machine is online and has a cloud set up.
  assert.match(resolvePackAvailability({ connectivityMode: "LOCAL_ONLY", online: true, isTauri: true, cloudConfigured: true }), /Local Only/);
  assert.match(resolvePackAvailability({ connectivityMode: "AUTO", online: false, isTauri: true }), /offline/);
  assert.match(resolvePackAvailability({ connectivityMode: "AUTO", online: false, isTauri: false }), /offline/);
  assert.match(resolvePackAvailability({ connectivityMode: "AUTO", online: true, isTauri: true, cloudConfigured: false }), /not connected to a cloud server/);
  assert.equal(resolvePackAvailability({ connectivityMode: "AUTO", online: true, isTauri: true }), null);
  assert.equal(resolvePackAvailability({ connectivityMode: "AUTO", online: true, isTauri: false, cloudConfigured: false }), null, "the browser build talks to its own server");
  assert.equal(resolvePackAvailability({ connectivityMode: "AUTO", online: true, isTauri: false }), null);
  assert.equal(resolvePackAvailability(), null);
});

test("the Frooz Pack screen shows everything the picker hides, marked, and falls back up a level", () => {
  const catalogue = readPackingCatalogue(snapshotPacking());
  const top = packingManageView(catalogue, createPackingDrill());
  assert.equal(top.level, "types");
  // Switched-off and empty types are listed (the picker hides both), in order.
  assert.deepEqual(top.rows.map((row) => row.label), ["Retired", "Gift Box", "Bottle", "Bowl"]);
  assert.equal(top.rows.find((row) => row.label === "Retired").active, false);
  const bowl = top.rows.find((row) => row.label === "Bowl");
  assert.equal(bowl.sublabel, "No designs yet");
  assert.equal(bowl.stockState, null, "nothing under it claims no stock state");
  assert.equal(bowl.node.id, "packing-type-3");

  // Entered without a catalogue, so an empty type can still be opened to add a design.
  const intoBowl = packingManageView(catalogue, enterPackingDrill(createPackingDrill(), "packing-type-3"));
  assert.equal(intoBowl.level, "designs");
  assert.equal(intoBowl.type.id, "packing-type-3");
  assert.deepEqual(intoBowl.rows, []);

  const designs = packingManageView(catalogue, enterPackingDrill(createPackingDrill(), "packing-type-1"));
  assert.deepEqual(designs.rows.map((row) => [row.label, row.active]), [["Window Box", true], ["Old Box", true], ["Switched Off", false]]);
  const sizes = packingManageView(catalogue, { level: "sizes", typeId: "packing-type-1", designId: "packing-design-2" });
  assert.equal(sizes.level, "sizes");
  assert.equal(sizes.design.id, "packing-design-2");
  assert.deepEqual(sizes.crumbs.map((crumb) => crumb.label), ["Packing", "Gift Box", "Window Box"]);
  const royal = sizes.rows.find((row) => row.label === "Royal · 2 kg");
  // An unknown count is unknown, and an unset (₹0) cost is "not set" -- never 0.
  assert.equal(royal.qty_on_hand, null);
  assert.equal(royal.stockState, "unknown");
  assert.equal(royal.sublabel, "Cost not set");
  assert.equal(sizes.rows.find((row) => row.label === "Classic").active, false);

  // A design that is no longer there falls back to its type; a type that is gone, to the top.
  assert.equal(packingManageView(catalogue, { level: "sizes", typeId: "packing-type-1", designId: "packing-design-99" }).level, "designs");
  assert.equal(packingManageView(catalogue, { level: "designs", typeId: "packing-type-99" }).level, "types");
  assert.equal(packingManageView(null, createPackingDrill()).rows.length, 0);
  assert.equal(PACKING_MOVEMENT_LABELS.ADJUST, "Count corrected");
});

test("an empty picker names the packing types that still need a design and a size", () => {
  assert.equal(packingEmptyPickerMessage({ status: "ready", types: [] }), "No packing set up yet. The Owner or an Admin adds it in Frooz Pack.");
  assert.equal(
    packingEmptyPickerMessage({ status: "ready", types: [
      { id: "packing-type-1", name: "Bottle", active: true, designs: [] },
      { id: "packing-type-2", name: "Box", active: true, designs: [{ id: "packing-design-1", name: "Window", active: true, sizes: [] }] },
      { id: "packing-type-3", name: "Old", active: false, designs: [] },
    ] }),
    "Bottle, Box have no size yet. In Frooz Pack, open each one with →, add a Design, then add a Size inside it."
  );
  assert.equal(
    packingEmptyPickerMessage([{ id: "packing-type-1", name: "Bottle", designs: [] }]),
    "Bottle has no size yet. In Frooz Pack, open it with →, add a Design, then add a Size inside it."
  );
});

test("types with no usable size are named, so a picker can say why they are missing", () => {
  assert.deepEqual(packingTypesWithoutSize({ types: [
    { id: "packing-type-1", name: "Bowl", designs: [{ id: "packing-design-1", name: "Round", sizes: [{ id: "packing-size-1", size_name: "CLASSIC" }] }] },
    { id: "packing-type-2", name: "Tray", designs: [] },
    { id: "packing-type-3", name: "Box", designs: [{ id: "packing-design-2", name: "Kraft", active: false, sizes: [{ id: "packing-size-2", size_name: "GRAND" }] }] },
    { id: "packing-type-4", name: "Off", active: false, designs: [] },
  ] }), ["Tray", "Box"]);
});
