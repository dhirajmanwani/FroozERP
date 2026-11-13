import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPackingToTransferLine,
  buildPackingTransferPayload,
  changePackingTransferFrom,
  createPackingTransferDraft,
  createPackingTransferLine,
  packingCatalogueAtShop,
  packingMovementText,
  packingOnHandAt,
  packingShopPlace,
  packingTransferDestinations,
  packingTransferDoneText,
  packingTransferLineView,
  packingTransferOffered,
  packingTransferSummary,
  readPackingShops,
} from "./froozPack.js";
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
  PACKING_QUICK_START_TYPES,
  advancePackingPurchaseLine,
  applyPackingToPurchaseLine,
  buildPackingSetupPayload,
  createPackingPurchaseLine,
  createPackingSetupDraft,
  packingLeafSublabel,
  packingPurchaseDraftTotal,
  packingPurchaseLineAmount,
  packingQuickStartOffered,
  packingSetupChoices,
  packingSetupPickRow,
  packingDeletable,
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
  // Petite is out and Grand is low: some sizes under Gift Box are out (not "running low").
  assert.equal(box.stockState, "some-out");
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
  // Count and last rate on every leaf; an unknown count or an unset (₹0) cost is said, never 0.
  assert.equal(grand.sublabel, "On hand 3 · ₹45.00 each");
  assert.equal(sizes.rows[0].sublabel, "On hand 0 · ₹20.00 each");
  assert.equal(sizes.rows[2].sublabel, "Count not known · No cost yet");
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

test("the bell row is a warning from PEP Pack, keyed by size", () => {
  const rows = packingShortageNotifications([{ key: "packing-short:packing-size-4", label: "Gift Box › Window Box › Grand · 1 kg", needed: 4, onHand: 3 }]);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.severity, "warning");
  assert.equal(row.source, "PEP Pack");
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

test("PEP Pack writes need the cloud: Local Only, no cloud and offline each say so", () => {
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

test("the PEP Pack screen shows everything the picker hides, marked, and falls back up a level", () => {
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
  assert.equal(royal.sublabel, "No cost yet");
  assert.equal(sizes.rows.find((row) => row.label === "Classic").active, false);

  // A design that is no longer there falls back to its type; a type that is gone, to the top.
  assert.equal(packingManageView(catalogue, { level: "sizes", typeId: "packing-type-1", designId: "packing-design-99" }).level, "designs");
  assert.equal(packingManageView(catalogue, { level: "designs", typeId: "packing-type-99" }).level, "types");
  assert.equal(packingManageView(null, createPackingDrill()).rows.length, 0);
  assert.equal(PACKING_MOVEMENT_LABELS.ADJUST, "Count corrected");
});

test("an empty picker names the packing types that still need a design and a size", () => {
  assert.equal(packingEmptyPickerMessage({ status: "ready", types: [] }), "No packing set up yet. The Owner or an Admin adds it in PEP Pack.");
  assert.equal(
    packingEmptyPickerMessage({ status: "ready", types: [
      { id: "packing-type-1", name: "Bottle", active: true, designs: [] },
      { id: "packing-type-2", name: "Box", active: true, designs: [{ id: "packing-design-1", name: "Window", active: true, sizes: [] }] },
      { id: "packing-type-3", name: "Old", active: false, designs: [] },
    ] }),
    "Bottle, Box have no size yet. In PEP Pack, press New packing, choose each one, name a design and tick its sizes."
  );
  assert.equal(
    packingEmptyPickerMessage([{ id: "packing-type-1", name: "Bottle", designs: [] }]),
    "Bottle has no size yet. In PEP Pack, press New packing, choose it, name a design and tick its sizes."
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

// ---------------------------------------------------------------------------------------------
// New packing in one go, Quick start, the purchase table and the picker's count and rate
// ---------------------------------------------------------------------------------------------

const tick = (draft, ticks) => ({
  ...draft,
  sizes: draft.sizes.map((row) => (ticks[row.size_name] ? { ...row, checked: true, ...ticks[row.size_name] } : row)),
});

test("New packing: the form starts where the owner is, and offers only switched-on types and designs", () => {
  const catalogue = ready();
  const blank = createPackingSetupDraft();
  assert.deepEqual([blank.type_id, blank.design_id, blank.sizes.map((row) => row.size_name)], ["", "", ["PETITE", "CLASSIC", "GRAND", "ROYAL"]]);
  assert.ok(blank.sizes.every((row) => row.checked === false));
  assert.equal(createPackingSetupDraft({ designId: "packing-design-2" }).design_id, "", "a design means nothing without its type");
  const here = createPackingSetupDraft({ typeId: "packing-type-1", designId: "packing-design-2" });
  const choices = packingSetupChoices(catalogue, here);
  // Bowl has no design yet but is offered: this is where it gets one. Retired is switched off.
  assert.deepEqual(choices.types.map((row) => row.label), ["Gift Box", "Bottle", "Bowl"]);
  assert.deepEqual(choices.designs.map((row) => row.label), ["Window Box", "Old Box"]);
  assert.deepEqual(choices.existingSizes, ["Petite", "Grand · 1 kg", "Royal · 2 kg"], "switched-off sizes are free to make again");
  assert.deepEqual(packingSetupChoices(catalogue, createPackingSetupDraft()).designs, []);
});

test("New packing: one payload for a new type, design and sizes; typed names that exist are taken as those", () => {
  const catalogue = ready();
  const fresh = buildPackingSetupPayload(tick({ ...createPackingSetupDraft(), type_name: "  Tray ", design_name: "Kraft  Round" }, {
    GRAND: { capacity: " 1  kg ", unit_cost: "12.50" }, PETITE: {},
  }), catalogue);
  assert.equal(fresh.ok, true, fresh.message);
  assert.deepEqual(fresh.payload, {
    type: { name: "Tray" },
    design: { name: "Kraft Round" },
    sizes: [{ size_name: "PETITE", capacity: "" }, { size_name: "GRAND", capacity: "1 kg", unit_cost: 12.5 }],
  });
  assert.equal(fresh.summary, "Tray › Kraft Round: Petite, Grand · 1 kg");

  // "gift box" typed as new is the Gift Box already there; "window box" likewise its design.
  const typed = buildPackingSetupPayload(tick({ ...createPackingSetupDraft(), type_name: "gift box", design_name: "WINDOW BOX" }, { CLASSIC: {} }), catalogue);
  assert.equal(typed.ok, true, typed.message);
  assert.deepEqual(typed.payload, { type: { id: "packing-type-1" }, design: { id: "packing-design-2" }, sizes: [{ size_name: "CLASSIC", capacity: "" }] });

  // A type alone.
  assert.deepEqual(buildPackingSetupPayload({ ...createPackingSetupDraft(), type_name: "Tray" }, catalogue).payload, { type: { name: "Tray" }, sizes: [] });
});

test("New packing: each confusion is refused in words before anything is sent", () => {
  const catalogue = ready();
  const at = createPackingSetupDraft({ typeId: "packing-type-1", designId: "packing-design-2" });
  const cases = [
    [createPackingSetupDraft(), /Choose a packing type/],
    [{ ...createPackingSetupDraft(), type_name: "x".repeat(81) }, /80 letters/],
    [{ ...createPackingSetupDraft({ typeId: "packing-type-99" }) }, /no longer in the list/],
    [{ ...createPackingSetupDraft({ typeId: "packing-type-4" }) }, /no longer in the list/],
    [createPackingSetupDraft({ typeId: "packing-type-1", designId: "packing-design-4" }), /no longer under Gift Box/],
    [tick({ ...createPackingSetupDraft(), type_name: "Tray" }, { GRAND: {} }), /Choose the design these sizes belong to/],
    [{ ...createPackingSetupDraft(), type_name: "Tray", design_name: "Kraft" }, /Tick at least one size/],
    [createPackingSetupDraft({ typeId: "packing-type-1" }), /Gift Box is already there/],
    [tick(at, { GRAND: { capacity: "1 KG" } }), /Window Box already has Grand · 1 KG/],
    [tick(at, { ROYAL: { unit_cost: "-1" } }), /Royal: the unit cost/],
    [tick(at, { ROYAL: { unit_cost: "1.234" } }), /at most 2 decimals/],
    [tick(at, { ROYAL: { capacity: "x".repeat(41) } }), /Royal: keep the capacity/],
  ];
  for (const [draft, message] of cases) {
    const result = buildPackingSetupPayload(draft, catalogue);
    assert.equal(result.ok, false, JSON.stringify(draft));
    assert.match(result.message, message);
  }
  // Grand with another capacity, or a size that is switched off, is new.
  assert.equal(buildPackingSetupPayload(tick(at, { GRAND: { capacity: "2 kg" }, CLASSIC: {} }), catalogue).ok, true);
});

test("New packing from a purchase line: the first size made is what the line takes", () => {
  const body = {
    success: true,
    type: { id: 1, global_id: "packing-type-1", name: "Gift Box" },
    design: { id: 2, global_id: "packing-design-2", name: "Window Box" },
    sizes: [
      { id: 7, global_id: "packing-size-7", size_name: "GRAND", capacity: "1 kg", unit_cost: 12, qty_on_hand: 0 },
      { id: 8, global_id: "packing-size-8", size_name: "PETITE", capacity: null, unit_cost: 0, qty_on_hand: 0 },
    ],
  };
  const row = packingSetupPickRow(body);
  assert.deepEqual(row, {
    packing_size_id: "packing-size-7", type_name: "Gift Box", design_name: "Window Box", size_name: "GRAND", capacity: "1 kg", unit_cost: 12, qty_on_hand: 0,
  });
  assert.equal(packingSetupPickRow({ ...body, sizes: [body.sizes[1]] }).unit_cost, null, "an unset cost is unknown, not ₹0");
  assert.equal(packingSetupPickRow({ ...body, sizes: [] }), null, "a type alone gives the line nothing");
  assert.equal(packingSetupPickRow(null), null);
  const lines = applyPackingToPurchaseLine([createPackingPurchaseLine("a"), createPackingPurchaseLine("b")], "b", row);
  assert.deepEqual(lines[1], { key: "b", size_id: "packing-size-7", label: "Gift Box › Window Box › Grand · 1 kg", quantity: "", rate: "12" });
  assert.deepEqual(lines[0], createPackingPurchaseLine("a"));
});

test("Quick start: offered only when the list loaded with no type at all", () => {
  assert.deepEqual(PACKING_QUICK_START_TYPES, ["Gift Box", "Basket", "Bottle", "Bowl"]);
  assert.equal(packingQuickStartOffered(readPackingCatalogue({ types: [] })), true);
  assert.equal(packingQuickStartOffered(ready()), false);
  assert.equal(packingQuickStartOffered(readPackingCatalogue({ types: [{ id: "t", name: "Old", active: false, designs: [] }] })), false, "a switched-off type is still a type");
  assert.equal(packingQuickStartOffered(readPackingCatalogue(null)), false, "not loaded is not empty");
  assert.equal(packingQuickStartOffered(readPackingCatalogue({ status: "weird" })), false);
});

test("purchase table: rate starts at the last cost, amounts and the total are worked as the server does", () => {
  const picked = applyPackingToPurchaseLine([{ ...createPackingPurchaseLine("a"), rate: "9" }], "a", { packing_size_id: "packing-size-4", type_name: "Gift Box", design_name: "Window Box", size_name: "GRAND", capacity: "1 kg", unit_cost: 45 });
  assert.equal(picked[0].rate, "9", "a rate already typed is the bill's own");
  const unset = applyPackingToPurchaseLine([createPackingPurchaseLine("a")], "a", { packing_size_id: "s", size_name: "GRAND", unit_cost: 0 });
  assert.equal(unset[0].rate, "", "no last cost: left blank, never 0");
  assert.equal(packingPurchaseLineAmount({ quantity: "20", rate: "3.255" }), 65.2, "the rate is a paisa amount first, as the server rounds it");
  assert.equal(packingPurchaseLineAmount({ quantity: "0.5", rate: "0.05" }), 0.03, "half-up to the paisa");
  assert.equal(packingPurchaseLineAmount({ quantity: "", rate: "3" }), null);
  assert.equal(packingPurchaseLineAmount({ quantity: "2", rate: "" }), null);
  assert.equal(packingPurchaseLineAmount({ quantity: "-1", rate: "3" }), null);
  assert.equal(packingPurchaseDraftTotal([{ quantity: "50", rate: "12.5" }, { quantity: "20", rate: "3.25" }, { quantity: "", rate: "" }]), 690);
  // The table's total and the payload's total agree.
  const draft = { payment_mode: "CASH", lines: [
    { key: "a", size_id: "packing-size-4", quantity: "3.333", rate: "1.15" },
    { key: "b", size_id: "packing-size-3", quantity: "0.333", rate: "7.77" },
  ] };
  assert.equal(packingPurchaseDraftTotal(draft.lines), 6.42, "3.83 + 2.59");
  assert.equal(packingPurchaseDraftTotal(draft.lines), buildPackingPurchasePayload(draft).total);
});

test("purchase table: Enter walks Packing → Qty → Rate → next line, adding one at the end, and a blank last line is not sent", () => {
  let seq = 0;
  const makeLine = () => createPackingPurchaseLine(`n${(seq += 1)}`);
  const lines = [createPackingPurchaseLine("a"), createPackingPurchaseLine("b")];
  assert.deepEqual(advancePackingPurchaseLine(lines, "a", "pick", makeLine).focus, { key: "a", field: "quantity" });
  assert.deepEqual(advancePackingPurchaseLine(lines, "a", "quantity", makeLine).focus, { key: "a", field: "rate" });
  const next = advancePackingPurchaseLine(lines, "a", "rate", makeLine);
  assert.deepEqual(next.focus, { key: "b", field: "pick" });
  assert.equal(next.lines, lines, "no line added in the middle");
  const added = advancePackingPurchaseLine(lines, "b", "rate", makeLine);
  assert.deepEqual(added.lines.map((line) => line.key), ["a", "b", "n1"]);
  assert.deepEqual(added.focus, { key: "n1", field: "pick" });
  assert.deepEqual(advancePackingPurchaseLine(lines, "zz", "rate", makeLine), { lines, focus: null });

  const filled = [
    { ...createPackingPurchaseLine("a"), size_id: "packing-size-4", quantity: "10", rate: "45" },
    createPackingPurchaseLine("n1"),
  ];
  const built = buildPackingPurchasePayload({ payment_mode: "CASH", lines: filled });
  assert.equal(built.ok, true, built.message);
  assert.deepEqual(built.payload.lines, [{ size_id: "packing-size-4", quantity: 10, rate: 45 }], "the spare blank line is dropped");
  // Only a wholly blank line is spare: a line with just a rate is still a line to finish.
  assert.match(buildPackingPurchasePayload({ payment_mode: "CASH", lines: [filled[0], { ...createPackingPurchaseLine("x"), rate: "5" }] }).message, /Line 2: choose a packing size/);
});

test("every picker's size row says the count and the last rate, and says when either is not known", () => {
  assert.equal(packingLeafSublabel({ qty_on_hand: 12, unit_cost: 4.5 }), "On hand 12 · ₹4.50 each");
  assert.equal(packingLeafSublabel({ qty_on_hand: -2, unit_cost: 0 }), "On hand -2 · No cost yet");
  assert.equal(packingLeafSublabel({ qty_on_hand: null, unit_cost: null }), "Count not known · No cost yet");
  assert.equal(packingLeafSublabel({ qty_on_hand: 1234.5, unit_cost: 10 }), "On hand 1,234.5 · ₹10.00 each");
  assert.equal(packingLeafSublabel({ qty_on_hand: 3, unit_cost: 1500 }), "On hand 3 · ₹1,500.00 each", "en-IN grouping");
  // The API's NUMERIC strings read as numbers.
  const api = readPackingCatalogue(apiPacking());
  const view = packingDrillView(api, { level: "sizes", typeId: "packing-type-1", designId: "packing-design-2" });
  assert.equal(view.rows[0].sublabel, "On hand 0 · ₹45.00 each");
});

test("delete: only what the owner's list says is unused; unknown (the counter's snapshot) is never unused", () => {
  const read = readPackingCatalogue({
    types: [
      { id: 1, global_id: "packing-type-1", name: "Bottle", in_use: false, designs: [
        { id: 2, global_id: "packing-design-2", name: "Round", in_use: false, sizes: [{ id: 3, global_id: "packing-size-3", size_name: "GRAND", in_use: false }] },
      ] },
      { id: 4, global_id: "packing-type-4", name: "Gift Box", in_use: true, designs: [
        { id: 5, global_id: "packing-design-5", name: "Window", in_use: true, sizes: [{ id: 6, global_id: "packing-size-6", size_name: "ROYAL", in_use: true }] },
      ] },
    ],
  });
  assert.equal(read.status, "ready");
  const [bottle, giftBox] = [read.types.find((type) => type.name === "Bottle"), read.types.find((type) => type.name === "Gift Box")];
  assert.deepEqual([packingDeletable(bottle), packingDeletable(bottle.designs[0]), packingDeletable(bottle.designs[0].sizes[0])], [true, true, true]);
  assert.deepEqual([packingDeletable(giftBox), packingDeletable(giftBox.designs[0]), packingDeletable(giftBox.designs[0].sizes[0])], [false, false, false]);

  const snapshot = readPackingCatalogue({ status: "ready", types: [{ id: "packing-type-1", name: "Bottle", designs: [] }] });
  assert.equal(snapshot.types[0].in_use, null);
  assert.equal(packingDeletable(snapshot.types[0]), false, "no answer about use is not 'unused'");
  for (const odd of [undefined, null, {}, { in_use: "false" }, { in_use: 0 }]) assert.equal(packingDeletable(odd), false);
});

// --- Fixes from the back-office audit ---------------------------------------------------------

import {
  checkPackingNodeForm,
  newPackingPurchaseClientRef,
  packingNodeRef,
  packingSetupStart,
  startPackingNodeForm,
} from "./froozPack.js";
import { readFileSync as readAppSource } from "node:fs";

const packApp = readAppSource(new URL("../App.jsx", import.meta.url), "utf8");
// The whole module, up to the component after it (a fixed length ran out as the module grew).
const packModule = packApp.slice(packApp.indexOf("function FroozPackModule("), packApp.indexOf("function PackingStockPanel("));

const twoDesigns = () => ({
  type: { id: "packing-type-1", global_id: "packing-type-1", name: "Gift Box" },
  windowBox: { id: "packing-design-3", global_id: "packing-design-3", name: "Window Box" },
  round: { id: "packing-design-4", global_id: "packing-design-4", name: "Round" },
});

test("a size form opened under one design saves under it, even after browsing to another (BO-2)", () => {
  const { type, windowBox, round } = twoDesigns();
  const opened = { level: "sizes", type, design: windowBox, crumbs: [{ label: "Packing" }, { label: "Gift Box" }, { label: "Window Box" }] };
  const size = { id: "packing-size-9", global_id: "packing-size-9", size_name: "GRAND", capacity: "1 kg", unit_cost: 40, sort_order: 2, active: true, in_use: true };
  const form = startPackingNodeForm("size", size, opened);
  assert.deepEqual(form.parent, { design_id: "packing-design-3" });
  assert.equal(form.where, "Gift Box › Window Box");
  assert.equal(form.ref, "packing-size-9");
  assert.equal(form.inUse, true);
  assert.deepEqual(form.draft, { sort_order: "2", active: true, size_name: "GRAND", capacity: "1 kg", unit_cost: "40" });
  // The owner now browses into Round; the form still holds Window Box.
  void round;
  const check = checkPackingNodeForm(form);
  assert.equal(check.ok, true, check.message);
  assert.equal(check.payload.design_id, "packing-design-3");

  const design = startPackingNodeForm("design", { id: "packing-design-3", name: "Window Box", sort_order: 0 }, { level: "designs", type, crumbs: [{ label: "Packing" }, { label: "Gift Box" }] });
  assert.deepEqual(design.parent, { type_id: "packing-type-1" });
  assert.equal(checkPackingNodeForm(design).payload.type_id, "packing-type-1");
  const top = startPackingNodeForm("type", null, { level: "types", crumbs: [{ label: "Packing" }] });
  assert.deepEqual(top.parent, {});
  assert.equal(top.where, "");
  assert.equal(packingNodeRef({ id: 12, global_id: "packing-size-12" }), "packing-size-12");
  assert.equal(packingNodeRef({ id: "004" }), "004");
});

test("PEP Pack saves a node against the parent it opened in, and holds the list still while a form is open", () => {
  const saveNode = packModule.slice(packModule.indexOf("const saveNode = async"), packModule.indexOf("const startRemoval"));
  assert.ok(saveNode.length > 0);
  assert.doesNotMatch(saveNode, /view\.(design|type)/, "the parent used to be read from the drill-down at Save time");
  assert.match(saveNode, /checkPackingNodeForm\(nodeForm\)/);
  assert.match(packModule, /setNodeForm\(startPackingNodeForm\(kind, node, view\)\)/);
  assert.match(packModule, /<PackDrillHeader\s+crumbs=\{view\.crumbs\}\s+disabled=\{busy\}/);
  assert.match(packModule, /disabled=\{row\.leaf \|\| busy\}/);
  assert.match(packModule, /const goBack = \(\) => \{\s+if \(busy\) return;/);
  assert.match(packModule, /if \(!row \|\| row\.leaf \|\| busy\) return;/);
  assert.match(packModule, /Correct the count: \$\{adjust\.path\}/);
});

test("purchase errors name the line by its place in the table, blank spare lines included (BO-15)", () => {
  const draft = { payment_mode: "CASH", lines: [
    { size_id: "packing-size-4", quantity: "1", rate: "1" },
    { size_id: "", quantity: "", rate: "" },
    { size_id: "packing-size-9", quantity: "", rate: "2" },
  ] };
  assert.match(buildPackingPurchasePayload(draft).message, /^Line 3: enter a quantity/);
});

test("a packing purchase sends its form's client_ref, the same on every retry (BE-4)", () => {
  const ref = newPackingPurchaseClientRef({ randomUUID: () => "0f8e3c1a-1111-4222-8333-444455556666" });
  assert.equal(ref, "pack-purchase:0f8e3c1a-1111-4222-8333-444455556666");
  assert.match(ref, /^[A-Za-z0-9._:-]{1,80}$/, "the server's CLIENT_REF_PATTERN");
  const fallback = newPackingPurchaseClientRef({ randomUUID: null, now: () => 1_700_000_000_000, random: () => 0.5 });
  assert.match(fallback, /^pack-purchase:[a-z0-9]+-[a-z0-9]+$/);
  assert.notEqual(newPackingPurchaseClientRef(), newPackingPurchaseClientRef(), "a new form gets a new key");

  const draft = { payment_mode: "CASH", client_ref: ref, lines: [{ size_id: "packing-size-4", quantity: "2", rate: "5" }] };
  assert.equal(buildPackingPurchasePayload(draft).payload.client_ref, ref);
  assert.equal(buildPackingPurchasePayload(draft).payload.client_ref, buildPackingPurchasePayload(draft).payload.client_ref);
  assert.equal(Object.hasOwn(buildPackingPurchasePayload({ ...draft, client_ref: "" }).payload, "client_ref"), false);
  assert.equal(buildPackingPurchasePayload({ ...draft, client_ref: "bad ref!" }).ok, false);

  const startPurchase = packModule.slice(packModule.indexOf("const startPurchase = () =>"), packModule.indexOf("const updatePurchase ="));
  assert.match(startPurchase, /client_ref: newPackingPurchaseClientRef\(\)/, "made once, when the form opens");
  const savePurchase = packModule.slice(packModule.indexOf("const savePurchase = async"), packModule.indexOf("const startAdjust"));
  assert.doesNotMatch(savePurchase, /newPackingPurchaseClientRef/, "a retry must not make a new key");
});

test("New packing inside a switched-off type or design starts where the form can follow, and says why (BO-17)", () => {
  const catalogue = readPackingCatalogue({ types: [
    { id: 1, global_id: "packing-type-1", name: "Gift Box", active: true, designs: [
      { id: 3, global_id: "packing-design-3", name: "Window Box", active: false, sizes: [] },
      { id: 4, global_id: "packing-design-4", name: "Round", active: true, sizes: [] },
    ] },
    { id: 2, global_id: "packing-type-2", name: "Basket", active: false, designs: [] },
  ] });
  const offType = packingSetupStart(catalogue, { typeId: "packing-type-2" });
  assert.equal(offType.draft.type_id, "");
  assert.equal(offType.note, "Basket is switched off. Switch it on (Edit) to add packing under it.");
  const offDesign = packingSetupStart(catalogue, { typeId: "packing-type-1", designId: "packing-design-3" });
  assert.equal(offDesign.draft.type_id, "packing-type-1");
  assert.equal(offDesign.draft.design_id, "");
  assert.match(offDesign.note, /^Window Box is switched off/);
  const on = packingSetupStart(catalogue, { typeId: "packing-type-1", designId: "packing-design-4" });
  assert.equal(on.draft.design_id, "packing-design-4");
  assert.equal(on.note, "");
  assert.equal(packingSetupStart(catalogue).note, "");
});

import {
  PACKING_STATE_WORDS,
  formatPackingUnitCost,
  packingAddHereLabel,
  packingCountAfter,
  packingHasPickableSize,
  packingManageStockState,
} from "./froozPack.js";

test("a packing cost reads one way everywhere: ₹ with en-IN grouping and 'each', or No cost yet", () => {
  assert.equal(formatPackingUnitCost(1500), "₹1,500.00 each");
  assert.equal(formatPackingUnitCost("45.5"), "₹45.50 each");
  assert.equal(formatPackingUnitCost(0), "No cost yet", "an unset cost is stored as 0");
  assert.equal(formatPackingUnitCost(null), "No cost yet");
  assert.equal(formatPackingUnitCost("abc"), "No cost yet");
});

test("a correction shows the count it leaves, worked in thousandths; unknown stays unknown", () => {
  assert.equal(packingCountAfter(12, "-3"), 9);
  assert.equal(packingCountAfter(12, "+10"), 22);
  assert.equal(packingCountAfter(0.1, "0.2"), 0.3);
  assert.equal(packingCountAfter(2, "-5"), -3, "the server decides; the preview does not clamp");
  assert.equal(packingCountAfter(null, "3"), null, "a count not known is not 0");
  assert.equal(packingCountAfter(5, ""), null);
  assert.equal(packingCountAfter(5, "-"), null);
});

test("a size never bought reads 'Not bought yet' on the PEP Pack list, not out; unknown use is never new", () => {
  assert.equal(packingManageStockState({ qty_on_hand: 0, in_use: false }), "new");
  assert.equal(packingManageStockState({ qty_on_hand: 0, in_use: true }), "out");
  assert.equal(packingManageStockState({ qty_on_hand: 0, in_use: null }), "out");
  assert.equal(packingManageStockState({ qty_on_hand: 3, in_use: false }), "low");
  assert.equal(packingManageStockState({ qty_on_hand: null, in_use: false }), "unknown");
  assert.equal(PACKING_STATE_WORDS.new, "Not bought yet");
  assert.equal(PACKING_STATE_WORDS["some-out"], "Some sizes out");

  const catalogue = readPackingCatalogue({ types: [
    { id: 1, global_id: "packing-type-1", name: "Gift Box", in_use: false, designs: [
      { id: 2, global_id: "packing-design-2", name: "Window Box", in_use: false, sizes: [
        { id: 3, global_id: "packing-size-3", size_name: "GRAND", qty_on_hand: 0, in_use: false },
        { id: 4, global_id: "packing-size-4", size_name: "ROYAL", qty_on_hand: 0, in_use: false },
      ] },
    ] },
    { id: 5, global_id: "packing-type-5", name: "Basket", in_use: true, designs: [
      { id: 6, global_id: "packing-design-6", name: "Round", in_use: true, sizes: [
        { id: 7, global_id: "packing-size-7", size_name: "GRAND", qty_on_hand: 0, in_use: true },
        { id: 8, global_id: "packing-size-8", size_name: "ROYAL", qty_on_hand: 0, in_use: false },
        { id: 9, global_id: "packing-size-9", size_name: "PETITE", qty_on_hand: 40, in_use: true },
      ] },
    ] },
  ] });
  const top = packingManageView(catalogue, createPackingDrill());
  assert.deepEqual(top.rows.map((row) => [row.label, row.stockState]), [["Gift Box", "new"], ["Basket", "some-out"]]);
  const sizes = packingManageView(catalogue, { level: "sizes", typeId: "packing-type-1", designId: "packing-design-2" });
  assert.deepEqual(sizes.rows.map((row) => row.stockState), ["new", "new"]);
  // The picker is unchanged: a counter's snapshot does not know what was used.
  const picker = packingDrillView(catalogue, createPackingDrill());
  assert.equal(picker.rows.find((row) => row.label === "Gift Box").stockState, "out");
});

test("the in-list add button says what it adds where the owner is", () => {
  assert.equal(packingAddHereLabel({ level: "types" }), "New packing");
  assert.equal(packingAddHereLabel({ level: "designs", type: { name: "Gift Box" } }), "Add a design to Gift Box");
  assert.equal(packingAddHereLabel({ level: "sizes", type: { name: "Gift Box" }, design: { name: "Window Box" } }), "Add sizes to Window Box");
  assert.equal(packingAddHereLabel(null), "New packing");
});

test("a picker with its own New packing button points at it; Packing purchase waits for a size", () => {
  const unfinished = { status: "ready", types: [{ id: "packing-type-1", name: "Bottle", active: true, designs: [] }] };
  assert.equal(
    packingEmptyPickerMessage(unfinished, { canCreate: true }),
    "Bottle has no size yet. Press New packing above, choose it, name a design and tick its sizes."
  );
  assert.equal(packingEmptyPickerMessage({ status: "ready", types: [] }, { canCreate: true }), "No packing set up yet. Press New packing above to make a type, a design and its sizes.");
  assert.match(packingEmptyPickerMessage(unfinished), /^Bottle has no size yet\. In PEP Pack, press New packing/);
  assert.equal(packingHasPickableSize(readPackingCatalogue(unfinished)), false);
  assert.equal(packingHasPickableSize(readPackingCatalogue({ types: [] })), false);
  assert.equal(packingHasPickableSize(readPackingCatalogue({ types: [
    { id: 1, name: "Bottle", designs: [{ id: 2, name: "Round", sizes: [{ id: 3, size_name: "GRAND" }] }] },
  ] })), true);
});

// ---------------------------------------------------------------------------------------------
// Sending packing to another shop
// ---------------------------------------------------------------------------------------------

const SHOPS_BODY = {
  this_branch_id: 1,
  shops: [
    { id: 1, name: "Main Branch", counts: { "packing-size-1": 50, "packing-size-2": 0.5 } },
    { id: 2, name: "Ratanada", counts: { "packing-size-1": 3, "packing-size-2": 0 } },
  ],
};
const GRAND_ROW = { packing_size_id: "packing-size-1", type_name: "Gift Box", design_name: "Window Box", size_name: "GRAND", capacity: "" };
const PETITE_ROW = { packing_size_id: "packing-size-2", type_name: "Gift Box", design_name: "Window Box", size_name: "PETITE", capacity: "1 kg" };

test("transfer: the shops list is read as a named state; the Send button shows only with more than one shop", () => {
  const two = readPackingShops(SHOPS_BODY);
  assert.equal(two.status, "ready");
  assert.equal(two.thisShopId, "1");
  assert.deepEqual(two.shops.map((shop) => [shop.id, shop.name]), [["1", "Main Branch"], ["2", "Ratanada"]]);
  assert.equal(packingTransferOffered(two), true);

  const one = readPackingShops({ this_branch_id: 1, shops: [SHOPS_BODY.shops[0]] });
  assert.equal(one.status, "ready");
  assert.equal(packingTransferOffered(one), false, "one shop: no Send button at all");
  assert.equal(packingTransferOffered(readPackingShops({ shops: [] })), false);

  for (const broken of [null, undefined, "shops", { shops: "x" }, {}]) {
    const read = readPackingShops(broken);
    assert.equal(read.status, "invalid", JSON.stringify(broken));
    assert.ok(read.message.length > 0, "an unreadable list says so");
    assert.equal(packingTransferOffered(read), false);
  }
  assert.equal(packingTransferOffered(null), false, "still loading: not offered");
  assert.equal(packingTransferOffered({ status: "invalid", shops: SHOPS_BODY.shops }), false);
  assert.equal(readPackingShops({ shops: [{ id: 7 }] }).shops[0].name, "Shop 7");
  assert.equal(readPackingShops({ shops: [{ name: "No id" }, null] }).shops.length, 0);
});

test("transfer: counts are found by opaque id; unknown is null, never 0; ids are not coerced", () => {
  const shops = readPackingShops({
    this_branch_id: "004",
    shops: [{ id: "004", name: "Old Town", counts: { "packing-size-1": 7 } }, { id: 4, name: "Four", counts: { "packing-size-1": 9 } }],
  });
  assert.equal(packingOnHandAt(shops, "004", "packing-size-1"), 7);
  assert.equal(packingOnHandAt(shops, 4, "packing-size-1"), 9, "\"004\" and 4 are different shops");
  assert.equal(packingOnHandAt(shops, "004", "packing-size-9"), null, "a size not in the list is not known");
  assert.equal(packingOnHandAt(shops, "99", "packing-size-1"), null);
  const ready = readPackingShops(SHOPS_BODY);
  assert.equal(packingOnHandAt(ready, "2", "packing-size-2"), 0, "a known zero stays zero");
  assert.equal(packingShopPlace(ready, "1"), "here");
  assert.equal(packingShopPlace(ready, "2"), "at Ratanada");
  assert.deepEqual(packingTransferDestinations(ready, "1").map((shop) => shop.name), ["Ratanada"]);

  const catalogue = readPackingCatalogue({ types: [{ id: 1, global_id: "packing-type-1", name: "Gift Box", designs: [{ id: 1, global_id: "packing-design-1", name: "Window Box", sizes: [
    { id: 1, global_id: "packing-size-1", size_name: "GRAND", qty_on_hand: 50 },
    { id: 3, global_id: "packing-size-3", size_name: "ROYAL", qty_on_hand: 4 },
  ] }] }] });
  const atRatanada = packingCatalogueAtShop(catalogue, ready, "2");
  assert.deepEqual(atRatanada.types[0].designs[0].sizes.map((size) => size.qty_on_hand), [3, null], "the picker shows the From shop's counts");
  assert.equal(catalogue.types[0].designs[0].sizes[0].qty_on_hand, 50, "the screen's own catalogue is not changed");
});

test("transfer: a new send starts from this computer's shop, to the only other one; changing From never leaves From = To", () => {
  const ready = readPackingShops(SHOPS_BODY);
  const draft = createPackingTransferDraft(ready, () => createPackingTransferLine("t-1"));
  assert.deepEqual(draft, { from_branch_id: "1", to_branch_id: "2", lines: [{ key: "t-1", size_id: "", label: "", quantity: "" }], note: "" });
  assert.deepEqual(changePackingTransferFrom(draft, ready, "2"), { ...draft, from_branch_id: "2", to_branch_id: "1" }, "two shops: swapped");

  const three = readPackingShops({ ...SHOPS_BODY, shops: [...SHOPS_BODY.shops, { id: 3, name: "Sardarpura", counts: {} }] });
  const open = createPackingTransferDraft(three, () => createPackingTransferLine("t-1"));
  assert.equal(open.from_branch_id, "1");
  assert.equal(open.to_branch_id, "", "three shops: the owner chooses where");
  assert.equal(changePackingTransferFrom({ ...open, to_branch_id: "3" }, three, "2").to_branch_id, "3", "a different To stays");
  assert.equal(changePackingTransferFrom({ ...open, to_branch_id: "2" }, three, "2").to_branch_id, "", "a To that became From is cleared");
  const elsewhere = readPackingShops({ ...SHOPS_BODY, this_branch_id: 9 });
  assert.equal(createPackingTransferDraft(elsewhere).from_branch_id, "1", "this shop not listed: the first shop");
});

test("transfer: each line shows what is on hand and what is left after sending, in thousandths", () => {
  const ready = readPackingShops(SHOPS_BODY);
  const [line] = applyPackingToTransferLine([createPackingTransferLine("t-1")], "t-1", GRAND_ROW);
  assert.deepEqual(line, { key: "t-1", size_id: "packing-size-1", label: "Gift Box › Window Box › Grand", quantity: "" });
  assert.deepEqual(packingTransferLineView(line, ready, "1"), { onHand: 50, onHandText: "On hand here 50", after: null, afterText: "", short: false });
  assert.deepEqual(packingTransferLineView({ ...line, quantity: "10" }, ready, "1"), { onHand: 50, onHandText: "On hand here 50", after: 40, afterText: "40 left here", short: false });
  assert.equal(packingTransferLineView({ ...line, quantity: "50" }, ready, "1").afterText, "0 left here");
  assert.deepEqual(packingTransferLineView({ ...line, quantity: "51" }, ready, "1"), { onHand: 50, onHandText: "On hand here 50", after: -1, afterText: "Only 50 here", short: true });
  assert.equal(packingTransferLineView({ ...line, quantity: "1" }, ready, "2").afterText, "2 left at Ratanada");
  assert.equal(packingTransferLineView({ ...line, quantity: "1" }, ready, "2").onHandText, "On hand at Ratanada 3");
  const petite = { key: "t-2", size_id: "packing-size-2", label: "x", quantity: "0.2" };
  assert.equal(packingTransferLineView(petite, ready, "1").after, 0.3, "0.5 - 0.2 is 0.3, not 0.30000000000000004");
  assert.deepEqual(packingTransferLineView({ ...petite, quantity: "1" }, ready, "2"), { onHand: 0, onHandText: "On hand at Ratanada 0", after: -1, afterText: "None at Ratanada", short: true });
  assert.equal(packingTransferLineView({ ...line, quantity: "1.0001" }, ready, "1").afterText, "", "nothing claimed for an unreadable quantity");
  assert.equal(packingTransferLineView({ ...line, size_id: "packing-size-9", quantity: "1" }, ready, "1").onHandText, "Count here not known");
  assert.equal(packingTransferLineView({ ...line, size_id: "packing-size-9", quantity: "1" }, ready, "1").afterText, "", "an unknown count is not 0");
  assert.equal(packingTransferLineView(createPackingTransferLine("t-3"), ready, "1").onHandText, "");
});

test("transfer: the payload checks shops, lines, duplicates, quantities and what is on hand; the summary names it all", () => {
  const ready = readPackingShops(SHOPS_BODY);
  const grand = { key: "a", size_id: "packing-size-1", label: "Gift Box › Window Box › Grand", quantity: "10" };
  const draft = { from_branch_id: "1", to_branch_id: "2", note: "  for  Diwali ", lines: [grand, createPackingTransferLine("blank")] };
  const built = buildPackingTransferPayload(draft, ready);
  assert.equal(built.ok, true, built.message);
  assert.deepEqual(built.payload, { from_branch_id: "1", to_branch_id: "2", lines: [{ size_id: "packing-size-1", quantity: 10 }], note: "for Diwali" });
  assert.equal(built.summary, "Sending 10 Gift Box › Window Box › Grand to Ratanada");
  assert.equal(buildPackingTransferPayload({ ...draft, note: "" }, ready).payload.note, undefined, "no note, no key");

  const two = { ...draft, lines: [grand, { key: "b", size_id: "packing-size-2", label: "Gift Box › Window Box › Petite · 1 kg", quantity: "0.5" }] };
  assert.equal(packingTransferSummary(two, ready), "Sending 10 Gift Box › Window Box › Grand and 0.5 Gift Box › Window Box › Petite · 1 kg to Ratanada");
  assert.equal(packingTransferSummary({ ...draft, to_branch_id: "" }, ready), "", "no To yet: no summary");
  assert.equal(packingTransferSummary({ ...draft, lines: [createPackingTransferLine("x")] }, ready), "");

  const refusals = [
    [{ ...draft, from_branch_id: "" }, "Choose the shop the packing goes from."],
    [{ ...draft, to_branch_id: "" }, "Choose the shop to send the packing to."],
    [{ ...draft, to_branch_id: "9" }, "Choose the shop to send the packing to."],
    [{ ...draft, to_branch_id: "1" }, "Choose a different shop to send to. Packing cannot be sent to the shop it is already in."],
    [{ ...draft, lines: [createPackingTransferLine("x")] }, "Add the packing to send."],
    [{ ...draft, lines: [{ ...grand, size_id: "" }] }, "Line 1: choose the packing to send."],
    [{ ...draft, lines: [grand, { ...grand, key: "c", quantity: "1" }] }, "Line 2: this packing is listed twice. Put the whole quantity on one line."],
    [{ ...draft, lines: [{ ...grand, quantity: "0" }] }, "Line 1: enter how many to send, above 0, with at most 3 decimals."],
    [{ ...draft, lines: [{ ...grand, quantity: "-1" }] }, "Line 1: enter how many to send, above 0, with at most 3 decimals."],
    [{ ...draft, lines: [{ ...grand, quantity: "1.0005" }] }, "Line 1: enter how many to send, above 0, with at most 3 decimals."],
    [{ ...draft, lines: [{ ...grand, quantity: "" }] }, "Line 1: enter how many to send, above 0, with at most 3 decimals."],
    [{ ...draft, lines: [{ ...grand, quantity: "51" }] }, "Line 1: Main Branch has only 50 of Gift Box › Window Box › Grand. Send 50 or fewer."],
    [{ ...draft, from_branch_id: "2", to_branch_id: "1", lines: [{ ...grand, size_id: "packing-size-2", quantity: "1" }] }, "Line 1: Ratanada has none of Gift Box › Window Box › Grand to send."],
    [{ ...draft, note: "x".repeat(301) }, "Keep the note to 300 letters or fewer."],
  ];
  for (const [bad, message] of refusals) {
    const result = buildPackingTransferPayload(bad, ready);
    assert.equal(result.ok, false, message);
    assert.equal(result.message, message);
  }
  // A count not known here is left to the server, which checks under a lock.
  assert.equal(buildPackingTransferPayload({ ...draft, lines: [{ ...grand, size_id: "packing-size-9" }] }, ready).ok, true);
});

test("transfer: the success notice says what went where and that the other shop's counters get it at their next sync", () => {
  const body = { success: true, transfer: { from: { id: 1, name: "Main Branch" }, to: { id: 2, name: "Ratanada" }, lines: [
    { size_id: "packing-size-1", type_name: "Gift Box", design_name: "Window Box", size_name: "GRAND", capacity: null, quantity: 10 },
  ] } };
  assert.equal(packingTransferDoneText(body), "Sent 10 Gift Box › Window Box › Grand to Ratanada. Ratanada's counters get the new count at their next sync.");
  assert.equal(
    packingTransferDoneText({}, { summary: "Sending 3 Basket › Round › Petite to Ratanada", toName: "Ratanada" }),
    "Sent 3 Basket › Round › Petite to Ratanada. Ratanada's counters get the new count at their next sync.",
    "an answer that cannot be read still names what the form held",
  );
  assert.equal(packingTransferDoneText(null), "Sent to the other shop. The other shop's counters get the new count at their next sync.");
});

test("movements: a send reads 'Sent to …' at one shop and 'Received from …' at the other; other rows keep their labels", () => {
  assert.equal(PACKING_MOVEMENT_LABELS.TRANSFER_OUT, "Sent to another shop");
  assert.equal(PACKING_MOVEMENT_LABELS.TRANSFER_IN, "Received from another shop");
  assert.deepEqual(packingMovementText({ movement_type: "TRANSFER_OUT", reason: "Sent to Ratanada · For Diwali · rush" }), { what: "Sent to Ratanada", note: "For Diwali · rush" });
  assert.deepEqual(packingMovementText({ movement_type: "transfer_in", reason: "Received from Main Branch" }), { what: "Received from Main Branch", note: "" });
  assert.deepEqual(packingMovementText({ movement_type: "TRANSFER_IN", reason: "" }), { what: "Received from another shop", note: "" });
  assert.deepEqual(packingMovementText({ movement_type: "TRANSFER_OUT", reason: "odd" }), { what: "Sent to another shop", note: "odd" });
  assert.deepEqual(packingMovementText({ movement_type: "PURCHASE", reason: "Bought from Box Co" }), { what: "Bought", note: "Bought from Box Co" });
  assert.deepEqual(packingMovementText({ movement_type: "SALE", sale_id: 12, invoice_no: "INV-7" }), { what: "Sold with a combo", note: "Bill INV-7" });
  assert.deepEqual(packingMovementText({ movement_type: "SALE", sale_id: 12 }), { what: "Sold with a combo", note: "Bill 12" });
  assert.deepEqual(packingMovementText({ movement_type: "PURCHASE", purchase_id: 4 }), { what: "Bought", note: "Purchase 4" });
  assert.deepEqual(packingMovementText({ movement_type: "NEW_KIND" }), { what: "NEW_KIND", note: "" });
});

test("PEP Pack wires Send to another shop: hidden with one shop, same Local Only guard, form in view, server's words on failure", () => {
  // Only when the shops are known and there is more than one.
  assert.match(packModule, /\{packingTransferOffered\(shops\) && \(\s+<button[^>]*onClick=\{startTransfer\}><Icon name="truck" size=\{16\} \/>Send to another shop<\/button>/);
  // The shops are read in loadPacking, which never runs while unavailableReason is set (Local Only,
  // offline, no cloud): the same path as every other read and write here.
  const load = packModule.slice(packModule.indexOf("const loadPacking = async"), packModule.indexOf("useEffect(() => {\n    if (unavailableReason) return;"));
  assert.match(load, /canManage \? axios\.get\(`\$\{API_URL\}\/api\/v3\/packing\/shops`\) : Promise\.resolve\(null\)/);
  assert.match(packModule, /useEffect\(\(\) => \{\s+if \(unavailableReason\) return;\s+loadPacking\(\);/);
  assert.match(packModule, /actions=\{canManage && !unavailableReason && !failed/);
  const save = packModule.slice(packModule.indexOf("const saveTransfer = async"), packModule.indexOf("const showQuickStart"));
  assert.match(save, /if \(!transfer \|\| transfer\.saving \|\| disabled\) return;/, "disabled covers unavailableReason");
  assert.match(save, /buildPackingTransferPayload\(transfer\.draft, shops\)/);
  assert.match(save, /axios\.post\(`\$\{API_URL\}\/api\/v3\/packing\/transfers`, check\.payload\)/);
  assert.match(save, /getErrorMessage\(error, /, "the server's own message, never a zero");
  assert.match(save, /packingTransferDoneText\(response\?\.data/);
  assert.match(save, /revealPackForm\("pack-notice"\)/);
  assert.doesNotMatch(save, /user_id|x-user-id|created_by/, "no identity in the body");
  assert.match(packModule, /const startTransfer = \(\) => \{[\s\S]*?revealPackForm\("pack-transfer-form"\);/);
  assert.match(packModule, /id="pack-transfer-form"[\s\S]*?<select autoFocus/);
  assert.match(packModule, /<td data-label="What">\{said\.what \|\| MISSING_VALUE\}<\/td>/);
});
